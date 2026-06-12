import { handleUpload } from '@vercel/blob/client';
import crypto from 'node:crypto';

function validToken(token) {
  const secret = process.env.NEHEMIAH_PASSWORD;
  if (!secret || !token) return false;
  const today = new Date().toISOString().split('T')[0];
  const expected = crypto.createHmac('sha256', secret).update(today).digest('hex');
  return token === expected;
}

// Issues short-lived client tokens so the browser can upload large files
// (PDFs, spreadsheets, photo sets) directly to Vercel Blob, bypassing the
// ~4.5MB serverless request-body limit. Uploads are authorized by the
// Nehemiah login token, passed as clientPayload, and stored privately.
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
    const jsonResponse = await handleUpload({
      request: req,
      body: req.body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!validToken(clientPayload)) {
          throw new Error('Unauthorized upload');
        }
        return {
          addRandomSuffix: true,
          maximumSizeInBytes: 100 * 1024 * 1024, // 100 MB ceiling
        };
      },
      onUploadCompleted: async () => { /* metadata is recorded client-side */ },
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(400).json({ error: err.message || 'Upload failed' });
  }
}
