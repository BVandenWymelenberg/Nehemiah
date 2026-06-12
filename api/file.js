import { get, del } from '@vercel/blob';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';

function validToken(token) {
  const secret = process.env.NEHEMIAH_PASSWORD;
  if (!secret || !token) return false;
  const today = new Date().toISOString().split('T')[0];
  const expected = crypto.createHmac('sha256', secret).update(today).digest('hex');
  return token === expected;
}

// Streams a private property file through the (token-gated) server so the
// blob is never publicly reachable. ?download=1 forces a save dialog,
// otherwise it renders inline (PDF/image preview). DELETE removes the blob.
export default async function handler(req, res) {
  const headerToken = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : '';

  if (req.method === 'DELETE') {
    const token = headerToken || req.query.token;
    if (!validToken(token)) return res.status(401).json({ error: 'Unauthorized' });
    const pathname = req.query.pathname || (req.body && req.body.pathname);
    if (!pathname) return res.status(400).json({ error: 'Missing pathname' });
    try {
      await del(pathname);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('File delete error:', err);
      return res.status(500).json({ error: 'Failed to delete file' });
    }
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pathname, token, download, name, ct } = req.query;
  if (!validToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  if (!pathname) return res.status(400).json({ error: 'Missing pathname' });

  try {
    const result = await get(pathname, { access: 'private' });
    if (!result || result.statusCode !== 200) return res.status(404).json({ error: 'Not found' });
    if (ct) res.setHeader('Content-Type', ct);
    else if (result.contentType) res.setHeader('Content-Type', result.contentType);
    const disposition = download ? 'attachment' : 'inline';
    const fname = (name || 'file').replace(/"/g, '');
    res.setHeader('Content-Disposition', `${disposition}; filename="${fname}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    Readable.fromWeb(result.stream).pipe(res);
  } catch (err) {
    console.error('File fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch file' });
  }
}
