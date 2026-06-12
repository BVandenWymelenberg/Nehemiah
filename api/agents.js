import { put, get } from '@vercel/blob';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';

const BLOB_PATH = 'nehemiah/agents.json';
const EMPTY = { agents: {}, assignments: {} };

function tokenValid(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const secret = process.env.NEHEMIAH_PASSWORD;
  if (!secret || !token) return false;
  const today = new Date().toISOString().split('T')[0];
  const expected = crypto.createHmac('sha256', secret).update(today).digest('hex');
  return token === expected;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!tokenValid(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') {
    try {
      const result = await get(BLOB_PATH, { access: 'private' });
      if (!result || result.statusCode !== 200) return res.status(200).json(EMPTY);
      res.setHeader('Content-Type', 'application/json');
      Readable.fromWeb(result.stream).pipe(res);
    } catch (err) {
      return res.status(200).json(EMPTY);
    }
  } else if (req.method === 'PUT') {
    try {
      const body = JSON.stringify(req.body);
      await put(BLOB_PATH, body, {
        access: 'private', contentType: 'application/json',
        addRandomSuffix: false, allowOverwrite: true,
      });
      // Keep one durable backup per day so an accidental overwrite is recoverable.
      try {
        const day = new Date().toISOString().split('T')[0];
        await put(`nehemiah/backups/agents-${day}.json`, body, {
          access: 'private', contentType: 'application/json',
          addRandomSuffix: false, allowOverwrite: true,
        });
      } catch (e) { console.warn('agents backup failed', e); }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Agents save error:', err);
      return res.status(500).json({ error: 'Failed to save agents' });
    }
  } else {
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }
}
