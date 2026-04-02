import { put } from '@vercel/blob';

// ArcGIS REST API endpoint for Yavapai County Parcels
const ARCGIS_BASE = 'https://gis.yavapaiaz.gov/arcgis/rest/services/Parcels/FeatureServer/0/query';

// Fields we want from the parcel data
const OUT_FIELDS = [
  'OBJECTID', 'PARCEL_ID', 'PARLABEL', 'ACCOUNTNO',
  'NAME', 'SECONDARY', 'ADDRESS', 'CITY', 'STATE', 'ZIP',
  'SITUS_ADD_DOR', 'ACRE_DEED', 'ZONING', 'SUBNAME',
  'TAX_AREA_CODE', 'MARKETAREA', 'MARKETSUBAREA',
  'LASTUPDATED', 'Shape__Area'
].join(',');

// Our filter: Commercial (C*), Resort Special (RS*), Industrial (M*),
// Multi-zoning (MULTI) >= 5 acres, and PAD/PUD >= 25 acres
const QUERIES = [
  {
    label: 'Commercial + Resort + Industrial + Multi (≥5 ac)',
    where: "ACRE_DEED >= 5 AND (ZONING LIKE 'C%' OR ZONING LIKE 'RS%' OR ZONING LIKE 'M%' OR ZONING = 'MULTI')"
  },
  {
    label: 'PAD/PUD (≥25 ac)',
    where: "ACRE_DEED >= 25 AND (ZONING LIKE 'PAD%' OR ZONING LIKE 'PUD%')"
  }
];

const BLOB_PATH = 'nehemiah/parcels-yavapai.json';
const MAX_RECORDS = 2000;

// Simple auth via query param or header to prevent unauthorized syncs
function verifySync(req) {
  const token = req.query?.token || req.headers['x-sync-token'];
  return token === process.env.GIS_SYNC_TOKEN;
}

async function fetchParcels(whereClause, offset = 0) {
  const params = new URLSearchParams({
    where: whereClause,
    outFields: OUT_FIELDS,
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: String(MAX_RECORDS),
    resultOffset: String(offset),
    f: 'json'
  });

  const url = `${ARCGIS_BASE}?${params}`;
  console.log(`Fetching: offset=${offset}, where=${whereClause.substring(0, 60)}...`);

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Nehemiah-GIS-Sync/1.0' }
  });

  if (!response.ok) {
    throw new Error(`ArcGIS returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`ArcGIS error: ${JSON.stringify(data.error)}`);
  }

  return data;
}

function normalizeFeature(feature) {
  const a = feature.attributes;
  const geo = feature.geometry;

  // Calculate centroid from geometry rings if available
  let lat = null, lng = null;
  if (geo && geo.rings && geo.rings.length > 0) {
    const ring = geo.rings[0];
    let sumLat = 0, sumLng = 0;
    ring.forEach(pt => { sumLng += pt[0]; sumLat += pt[1]; });
    lng = sumLng / ring.length;
    lat = sumLat / ring.length;
  }

  // Categorize zoning
  let zoningCategory = 'other';
  const z = (a.ZONING || '').toUpperCase();
  if (z.startsWith('C1') || z.startsWith('C2') || z.startsWith('C3') || z === 'C') zoningCategory = 'commercial';
  else if (z.startsWith('RS')) zoningCategory = 'resort';
  else if (z.startsWith('M1') || z.startsWith('M2') || z === 'M') zoningCategory = 'industrial';
  else if (z === 'MULTI') zoningCategory = 'mixed-use';
  else if (z.startsWith('PAD') || z.startsWith('PUD')) zoningCategory = 'planned-development';

  return {
    parcelId: a.PARCEL_ID,
    parcelLabel: a.PARLABEL,
    accountNo: a.ACCOUNTNO,
    owner: a.NAME,
    ownerSecondary: a.SECONDARY,
    mailingAddress: a.ADDRESS,
    mailingCity: a.CITY,
    mailingState: a.STATE,
    mailingZip: a.ZIP,
    situsAddress: a.SITUS_ADD_DOR,
    acreage: a.ACRE_DEED ? Math.round(a.ACRE_DEED * 100) / 100 : null,
    zoning: a.ZONING,
    zoningCategory,
    subdivision: a.SUBNAME,
    taxAreaCode: a.TAX_AREA_CODE,
    marketArea: a.MARKETAREA,
    marketSubArea: a.MARKETSUBAREA,
    lastUpdated: a.LASTUPDATED,
    shapeArea: a.Shape__Area,
    lat,
    lng,
    county: 'Yavapai County',
    state: 'AZ',
    gisPortalUrl: `https://gis.yavapaiaz.gov/v4/map.aspx?search=${a.PARCEL_ID || ''}`
  };
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST to trigger sync' });
  }

  // Verify token
  if (!verifySync(req)) {
    return res.status(401).json({ error: 'Invalid or missing sync token' });
  }

  try {
    const allParcels = [];
    const stats = {};

    for (const query of QUERIES) {
      let offset = 0;
      let hasMore = true;
      let queryCount = 0;

      while (hasMore) {
        const data = await fetchParcels(query.where, offset);
        const features = data.features || [];
        queryCount += features.length;

        features.forEach(f => {
          allParcels.push(normalizeFeature(f));
        });

        hasMore = data.exceededTransferLimit === true;
        offset += MAX_RECORDS;

        // Safety valve: max 10 pages per query
        if (offset > MAX_RECORDS * 10) {
          console.warn('Hit safety limit of 10 pages');
          hasMore = false;
        }

        // Be polite: wait 500ms between pages
        if (hasMore) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      stats[query.label] = queryCount;
      console.log(`${query.label}: ${queryCount} parcels`);
    }

    // Deduplicate by parcelId
    const seen = new Set();
    const uniqueParcels = [];
    allParcels.forEach(p => {
      const key = p.parcelId || p.parcelLabel || `${p.owner}-${p.acreage}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueParcels.push(p);
      }
    });

    // Build the blob payload
    const payload = {
      county: 'Yavapai County, AZ',
      syncedAt: new Date().toISOString(),
      totalParcels: uniqueParcels.length,
      stats,
      parcels: uniqueParcels
    };

    // Store in Vercel Blob
    await put(BLOB_PATH, JSON.stringify(payload), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return res.status(200).json({
      ok: true,
      totalParcels: uniqueParcels.length,
      stats,
      syncedAt: payload.syncedAt
    });
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
