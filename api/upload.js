import crypto from 'node:crypto';

function validLoginToken(token) {
  const secret = process.env.NEHEMIAH_PASSWORD;
  if (!secret || !token) return false;
  const today = new Date().toISOString().split('T')[0];
  const expected = crypto.createHmac('sha256', secret).update(today).digest('hex');
  return token === expected;
}

// Mints a Vercel Blob client-upload token in the exact format the official
// generateClientTokenFromReadWriteToken() produces — but using only
// node:crypto. We do NOT import '@vercel/blob/client' server-side: its CJS
// build does require('undici'), which Vercel's function bundler doesn't
// include, so importing it crashes the function at load. The browser SDK
// (loaded from a CDN) takes this token and uploads the file DIRECTLY to Blob,
// bypassing the ~4.5MB serverless request-body limit.
function mintBlobClientToken(pathname) {
  const rw = process.env.BLOB_READ_WRITE_TOKEN;
  if (!rw) throw new Error('BLOB_READ_WRITE_TOKEN not configured');
  const storeId = rw.split('_')[3];
  if (!storeId) throw new Error('Invalid BLOB_READ_WRITE_TOKEN');
  const payload = Buffer.from(JSON.stringify({
    pathname,
    addRandomSuffix: true,
    maximumSizeInBytes: 1024 * 1024 * 1024, // 1 GB ceiling
    validUntil: Date.now() + 60 * 60 * 1000, // token valid for 1 hour
  })).toString('base64');
  const securedKey = crypto.createHmac('sha256', rw).update(payload).digest('hex');
  return `vercel_blob_client_${storeId}_${Buffer.from(`${securedKey}.${payload}`).toString('base64')}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (body.type !== 'blob.generate-client-token') {
      return res.status(400).json({ error: 'Unsupported event type' });
    }
    const { pathname, clientPayload } = body.payload || {};
    if (!validLoginToken(clientPayload)) return res.status(401).json({ error: 'Unauthorized' });
    if (!pathname) return res.status(400).json({ error: 'Missing pathname' });
    return res.status(200).json({ type: body.type, clientToken: mintBlobClientToken(pathname) });
  } catch (err) {
    console.error('Upload token error:', err);
    return res.status(400).json({ error: err.message || 'Failed to mint upload token' });
  }
}
