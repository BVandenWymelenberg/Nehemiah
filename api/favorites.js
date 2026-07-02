import { put, get } from '@vercel/blob';
import { Readable } from 'node:stream';

// Serves both /api/favorites and /api/resort-favorites (the latter is rewritten
// to /api/favorites?kind=resort) so the app stays under Vercel's function cap.
export default async function handler(req, res) {
  const BLOB_PATH = req.query && req.query.kind === 'resort'
    ? 'nehemiah/resort-favorites.json'
    : 'nehemiah/favorites.json';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    try {
      const result = await get(BLOB_PATH, { access: 'private' });
      if (!result || result.statusCode !== 200) {
        return res.status(200).json({ favorites: {} });
      }
      res.setHeader('Content-Type', 'application/json');
      Readable.fromWeb(result.stream).pipe(res);
    } catch (err) {
      return res.status(200).json({ favorites: {} });
    }
  } else if (req.method === 'PUT') {
    try {
      await put(BLOB_PATH, JSON.stringify(req.body), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Favorites save error:', err);
      return res.status(500).json({ error: 'Failed to save favorites' });
    }
  } else {
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }
}
