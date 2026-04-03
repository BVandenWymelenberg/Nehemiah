import { put, get } from '@vercel/blob';
import { Readable } from 'node:stream';

// Coconino County endpoints
const COCONINO_ZONING = 'https://webmaps.coconino.az.gov/arcgis/rest/services/Coconino_County_Zoning/MapServer/0/query';
const COCONINO_PARCELS = 'https://webmaps.coconino.az.gov/arcgis/rest/services/ParcelOwnerInfo/FeatureServer/0/query';
// Fallback: AZ Water Resources has parcel data (more reliable)
const AZ_WATER_PARCELS = 'https://azwatermaps.azwater.gov/arcgis/rest/services/General/Parcels/MapServer/2/query';

const BLOB_PATH = 'nehemiah/parcels-coconino.json';
const STATUS_BLOB = 'nehemiah/coconino-sync-status.json';

function verifySync(req) {
  const token = req.query?.token || req.headers['x-sync-token'];
  return token === process.env.GIS_SYNC_TOKEN;
}

// Fetch with generous timeout for slow Coconino server
async function fetchWithTimeout(url, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Nehemiah-GIS-Sync/1.0' },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// Try to get zoning data from Coconino (may time out)
async function fetchCocoZoning() {
  // Commercial/resort zoning codes for Coconino County
  const zoningWhere = [
    "ZONING LIKE 'C%'",   // Commercial
    "ZONING LIKE 'SC%'",  // Special Commercial
    "ZONING LIKE 'RR%'",  // Resort Residential
    "ZONING LIKE 'PAD%'", // Planned Area Dev
    "ZONING LIKE 'PUD%'", // Planned Unit Dev
    "ZONING LIKE 'M%'",   // Industrial
    "ZONING LIKE 'GC%'",  // General Commercial
    "ZONING LIKE 'HC%'",  // Highway Commercial
    "ZONING LIKE 'NC%'",  // Neighborhood Commercial
    "ZONING LIKE 'RC%'",  // Resort Commercial
    "ZONING LIKE 'TC%'",  // Tourist Commercial
  ].join(' OR ');

  const params = new URLSearchParams({
    where: zoningWhere,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '2000',
    f: 'json'
  });

  const url = `${COCONINO_ZONING}?${params}`;
  console.log('Attempting Coconino zoning query...');
  return await fetchWithTimeout(url, 120000);
}

// Fallback: Get large parcels from AZ Water Resources (reliable but no zoning)
async function fetchAzWaterParcels(offset = 0) {
  const params = new URLSearchParams({
    where: 'ACRES_US >= 5',
    outFields: 'APN,OWNER_NAME,SITE_ADDRESS,SITE_CITY,SITE_ZIP,ACRES_US',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '2000',
    resultOffset: String(offset),
    f: 'json'
  });

  const url = `${AZ_WATER_PARCELS}?${params}`;
  return await fetchWithTimeout(url, 60000);
}

async function loadSyncStatus() {
  try {
    const result = await get(STATUS_BLOB, { access: 'private' });
    if (result && result.statusCode === 200) {
      const chunks = [];
      const stream = Readable.fromWeb(result.stream);
      for await (const chunk of stream) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString());
    }
  } catch (e) {}
  return { attempts: 0, lastAttempt: null, status: 'never-run', zoningAvailable: false };
}

async function saveSyncStatus(status) {
  await put(STATUS_BLOB, JSON.stringify(status), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST to trigger sync' });
  }

  if (!verifySync(req)) {
    return res.status(401).json({ error: 'Invalid or missing sync token' });
  }

  const syncStatus = await loadSyncStatus();
  syncStatus.attempts++;
  syncStatus.lastAttempt = new Date().toISOString();

  try {
    // Step 1: Try to fetch zoning data from Coconino's server
    console.log(`Coconino sync attempt #${syncStatus.attempts}`);
    let zoningData;

    try {
      zoningData = await fetchCocoZoning();
      console.log(`Coconino zoning query returned ${(zoningData.features || []).length} features`);
      syncStatus.zoningAvailable = true;
    } catch (err) {
      console.warn(`Coconino zoning server unavailable: ${err.message}`);
      syncStatus.status = 'zoning-unavailable';
      syncStatus.lastError = err.message;
      await saveSyncStatus(syncStatus);

      return res.status(200).json({
        ok: false,
        status: 'zoning-unavailable',
        message: `Coconino County GIS server timed out (attempt #${syncStatus.attempts}). Will retry later.`,
        attempts: syncStatus.attempts,
        lastAttempt: syncStatus.lastAttempt
      });
    }

    // Step 2: We got zoning data! Process it.
    const features = zoningData.features || [];
    const parcels = [];

    for (const feat of features) {
      const a = feat.attributes;
      const geo = feat.geometry;

      let lat = null, lng = null;
      if (geo && geo.rings && geo.rings.length > 0) {
        const ring = geo.rings[0];
        let sumLat = 0, sumLng = 0;
        ring.forEach(pt => { sumLng += pt[0]; sumLat += pt[1]; });
        lng = sumLng / ring.length;
        lat = sumLat / ring.length;
      }

      // Categorize zoning
      const z = (a.ZONING || '').toUpperCase();
      let zoningCategory = 'commercial';
      if (/^(RC|TC|RR|RESORT)/.test(z)) zoningCategory = 'resort';
      else if (/^(PAD|PUD)/.test(z)) zoningCategory = 'planned-development';
      else if (/^M/.test(z)) zoningCategory = 'industrial';
      else if (/^(SC|GC|HC|NC|C)/.test(z)) zoningCategory = 'commercial';

      parcels.push({
        parcelId: a.APN || a.PARCEL_ID || a.OBJECTID,
        parcelLabel: a.APN || a.PARLABEL || '',
        accountNo: a.ACCOUNTNO || null,
        owner: a.OWNER_NAME || a.OWNER || 'Unknown',
        ownerSecondary: null,
        mailingAddress: a.ADDRESS || a.MAIL_ADDRESS || null,
        mailingCity: a.CITY || a.MAIL_CITY || null,
        mailingState: 'AZ',
        mailingZip: a.ZIP || a.MAIL_ZIP || null,
        situsAddress: a.SITE_ADDRESS || a.SITUS_ADDRESS || null,
        acreage: a.ACRES || a.ACRES_US || a.ACREAGE || null,
        zoning: a.ZONING || 'Unknown',
        zoningCategory,
        subdivision: a.SUBDIVISION || null,
        taxAreaCode: null,
        marketArea: null,
        marketSubArea: null,
        lastUpdated: null,
        shapeArea: null,
        lat,
        lng,
        county: 'Coconino County',
        state: 'AZ',
        gisPortalUrl: `https://gismaps.coconino.az.gov/parcelviewer/?apn=${a.APN || ''}`,
        lastSalePrice: null,
        lastSaleDate: null,
        saleYear: null,
        timeAdjustedPrice: null
      });
    }

    // Filter to >= 5 acres
    const filtered = parcels.filter(p => p.acreage && p.acreage >= 5);

    // Deduplicate
    const seen = new Set();
    const unique = [];
    filtered.forEach(p => {
      const key = p.parcelId || p.parcelLabel || `${p.owner}-${p.acreage}`;
      if (!seen.has(key)) { seen.add(key); unique.push(p); }
    });

    const payload = {
      county: 'Coconino County, AZ',
      syncedAt: new Date().toISOString(),
      totalParcels: unique.length,
      parcels: unique
    };

    await put(BLOB_PATH, JSON.stringify(payload), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    syncStatus.status = 'success';
    syncStatus.lastSuccess = new Date().toISOString();
    syncStatus.parcelCount = unique.length;
    await saveSyncStatus(syncStatus);

    return res.status(200).json({
      ok: true,
      totalParcels: unique.length,
      syncedAt: payload.syncedAt,
      attempts: syncStatus.attempts
    });

  } catch (err) {
    console.error('Coconino sync error:', err);
    syncStatus.status = 'error';
    syncStatus.lastError = err.message;
    await saveSyncStatus(syncStatus);
    return res.status(500).json({ error: err.message });
  }
}
