import { handleUpload } from '@vercel/blob/client';
import crypto from 'node:crypto';

function validToken(token) {
  const secret = process.env.NEHEMIAH_PASSWORD;
  if (!secret || !token) return false;
  const today = new Date().toISOString().split('T')[0];
  const expected = crypto.createHmac('sha256', secret).update(today).digest('hex');
  return token === expected;
}

// Mints a short-lived client token so the browser can upload large files
// (PDFs, spreadsheets, photo sets) DIRECTLY to Vercel Blob, bypassing the
// ~4.5MB serverless request-body limit. Uploads are authorized by the
// Nehemiah login token (clientPayload) and stored privately. No onUpload-
// Completed callback — the browser records metadata itself.
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
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const json = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!validToken(clientPayload)) throw new Error('Unauthorized upload');
        return {
          addRandomSuffix: true,
          maximumSizeInBytes: 1024 * 1024 * 1024, // 1 GB ceiling
        };
      },
    });
    return res.status(200).json(json);
  } catch (err) {
    console.error('Upload token error:', err);
    return res.status(400).json({ error: err.message || 'Upload failed' });
  }
}
