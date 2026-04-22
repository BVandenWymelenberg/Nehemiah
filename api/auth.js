import crypto from 'node:crypto';

function makeToken(secret) {
  const today = new Date().toISOString().split('T')[0];
  return crypto.createHmac('sha256', secret).update(today).digest('hex');
}

export default function handler(req, res) {
  const expected = process.env.NEHEMIAH_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: 'NEHEMIAH_PASSWORD not configured' });
  }

  // GET — verify an existing session token
  if (req.method === 'GET') {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ valid: false });
    const token = auth.slice(7);
    const valid = token === makeToken(expected);
    return res.status(valid ? 200 : 401).json({ valid });
  }

  // POST — exchange password for token
  if (req.method === 'POST') {
    const { password } = req.body || {};
    if (!password || password !== expected) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    return res.status(200).json({ token: makeToken(expected) });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

// Shared helper for other API routes to verify the token
export function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  const expected = process.env.NEHEMIAH_PASSWORD;
  if (!expected) return false;
  return token === makeToken(expected);
}
