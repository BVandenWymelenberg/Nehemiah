import { get } from '@vercel/blob';
import { Readable } from 'node:stream';

const BLOB_PATH = 'nehemiah/parcels-yavapai.json';

// Haversine distance in miles
function haversineMi(lat1, lng1, lat2, lng2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await get(BLOB_PATH, { access: 'private' });
    if (!result || result.statusCode === 404) {
      return res.status(200).json({
        parcels: [],
        totalParcels: 0,
        syncedAt: null,
        message: 'No parcel data synced yet. Run /api/gis-sync to populate.'
      });
    }

    // Read the blob
    const chunks = [];
    const stream = Readable.fromWeb(result.stream);
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString());

    // Extract query params for filtering
    const {
      lat, lng, radius,
      minAcres, maxAcres,
      zoning, // comma-separated zoning categories
      sort, // distance, acreage-desc, acreage-asc, etc.
      page, pageSize
    } = req.query;

    let parcels = data.parcels || [];

    // Calculate distance if lat/lng provided
    const centerLat = parseFloat(lat);
    const centerLng = parseFloat(lng);
    if (!isNaN(centerLat) && !isNaN(centerLng)) {
      parcels = parcels.map(p => ({
        ...p,
        distance: p.lat && p.lng
          ? Math.round(haversineMi(centerLat, centerLng, p.lat, p.lng) * 100) / 100
          : null
      }));

      // Filter by radius
      const maxRadius = parseFloat(radius);
      if (!isNaN(maxRadius)) {
        parcels = parcels.filter(p => p.distance !== null && p.distance <= maxRadius);
      }
    }

    // Filter by acreage
    const min = parseFloat(minAcres);
    const max = parseFloat(maxAcres);
    if (!isNaN(min)) parcels = parcels.filter(p => p.acreage >= min);
    if (!isNaN(max)) parcels = parcels.filter(p => p.acreage <= max);

    // Filter by zoning categories
    if (zoning) {
      const categories = zoning.split(',').map(z => z.trim().toLowerCase());
      parcels = parcels.filter(p => categories.includes(p.zoningCategory));
    }

    // Sort
    const sortBy = sort || 'distance';
    parcels.sort((a, b) => {
      switch (sortBy) {
        case 'distance': return (a.distance || 9999) - (b.distance || 9999);
        case 'acreage-desc': return (b.acreage || 0) - (a.acreage || 0);
        case 'acreage-asc': return (a.acreage || 0) - (b.acreage || 0);
        default: return (a.distance || 9999) - (b.distance || 9999);
      }
    });

    // Pagination
    const pg = parseInt(page) || 1;
    const ps = Math.min(parseInt(pageSize) || 50, 200);
    const total = parcels.length;
    const totalPages = Math.ceil(total / ps);
    const start = (pg - 1) * ps;
    const pageParcels = parcels.slice(start, start + ps);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    return res.status(200).json({
      parcels: pageParcels,
      totalParcels: total,
      page: pg,
      pageSize: ps,
      totalPages,
      syncedAt: data.syncedAt,
      county: data.county
    });
  } catch (err) {
    console.error('Parcels API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
