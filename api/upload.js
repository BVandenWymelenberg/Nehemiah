import { put } from '@vercel/blob';
import crypto from 'node:crypto';

// Vercel auto-parses JSON bodies; for binary uploads we read the raw stream.
export const config = { api: { bodyParser: false } };

function validToken(token) {
  const secret = process.env.NEHEMIAH_PASSWORD;
  if (!secret || !token) return false;
  const today = new Date().toISOString().split('T')[0];
  const expected = crypto.createHmac('sha256', secret).update(today).digest('hex');
  return token === expected;
}

// Receives a file as the raw request body and stores it privately in Vercel
// Blob. Auth via the Nehemiah login token (?token=). Reliable path that avoids
// the @vercel/blob/client subpath (which fails to load in the serverless
// runtime). Note: subject to Vercel's ~4.5MB request-body limit.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const headerToken = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : '';
  const token = headerToken || req.query.token;
  if (!validToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const pathname = req.query.pathname;
  if (!pathname) return res.status(400).json({ error: 'Missing pathname' });
  const contentType = req.query.ct || req.headers['content-type'] || 'application/octet-stream';

  try {
    let buffer;
    if (Buffer.isBuffer(req.body)) buffer = req.body;
    else if (typeof req.body === 'string' && req.body.length) buffer = Buffer.from(req.body);
    else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      buffer = Buffer.concat(chunks);
    }
    if (!buffer || !buffer.length) return res.status(400).json({ error: 'Empty file' });

    const result = await put(pathname, buffer, {
      access: 'private',
      contentType,
      addRandomSuffix: true,
      allowOverwrite: false,
    });
    return res.status(200).json({ pathname: result.pathname, url: result.url });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
}
