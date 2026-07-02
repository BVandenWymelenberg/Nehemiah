import { get } from '@vercel/blob';
import crypto from 'node:crypto';

const BLOB_PATH = 'nehemiah/ranked-properties.json';
const MAX_DOC_CHARS = 60000;   // cap extracted document text fed to the model
const MODEL = process.env.EXEC_SUMMARY_MODEL || 'claude-sonnet-4-6';

// Daily HMAC token — same scheme as the rest of the Nehemiah API.
function validToken(token) {
  const secret = process.env.NEHEMIAH_PASSWORD;
  if (!secret || !token) return false;
  const today = new Date().toISOString().split('T')[0];
  const expected = crypto.createHmac('sha256', secret).update(today).digest('hex');
  return token === expected;
}

async function blobBuffer(pathname) {
  const r = await get(pathname, { access: 'private' });
  if (!r || r.statusCode !== 200) return null;
  return Buffer.from(await new Response(r.stream).arrayBuffer());
}

// Extract plain text from an uploaded file. Images/video/unknown types return ''.
async function extractText(file) {
  const name = (file.name || '').toLowerCase();
  const ct = (file.contentType || '').toLowerCase();
  try {
    const buf = await blobBuffer(file.pathname);
    if (!buf) return '';
    if (ct === 'application/pdf' || name.endsWith('.pdf')) {
      const { extractText: pdfExtract, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await pdfExtract(pdf, { mergePages: true });
      return text || '';
    }
    if (/wordprocessing|msword/.test(ct) || name.endsWith('.docx')) {
      const mammoth = await import('mammoth');
      const out = await (mammoth.default || mammoth).extractRawText({ buffer: buf });
      return out.value || '';
    }
    if (/sheet|excel|csv/.test(ct) || /\.(xlsx?|csv)$/.test(name)) {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer' });
      return wb.SheetNames.map((s) => XLSX.utils.sheet_to_csv(wb.Sheets[s])).join('\n\n');
    }
    if (ct.startsWith('text/') || /\.(txt|md)$/.test(name)) {
      return buf.toString('utf8');
    }
    return '';
  } catch (e) {
    console.warn('extractText failed for', file && file.name, e && e.message);
    return '';
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }

  const token = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : '';
  if (!validToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Graceful, non-error signal so the client falls back to its data-driven summary.
  if (!apiKey) return res.status(200).json({ summary: null, reason: 'no_key' });

  try {
    const id = req.body && req.body.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const rp = await blobBuffer(BLOB_PATH);
    if (!rp) return res.status(200).json({ summary: null, reason: 'no_data' });
    const data = JSON.parse(rp.toString('utf8'));
    const p = (data.ranked || data)[id];
    if (!p) return res.status(404).json({ error: 'Property not found' });

    // Pull text from every extractable uploaded document, up to the char budget.
    let docText = '';
    for (const f of (p.files || [])) {
      if (docText.length >= MAX_DOC_CHARS) break;
      const t = await extractText(f);
      if (t && t.trim()) docText += `\n\n===== ${f.name || 'document'} =====\n${t.trim()}`;
    }
    docText = docText.slice(0, MAX_DOC_CHARS);

    const crit = (p.criteria || [])
      .map((c) => `${c.label}: ${((p.scores || {})[c.id]) ?? '-'}/10 (weight ${c.weight})`)
      .join('; ');
    const fields = [
      `Name: ${p.name || ''}`,
      `Location: ${[p.townName, p.townState].filter(Boolean).join(', ')}`,
      `Asking price: ${p.askingPrice || '-'}`,
      `Acreage: ${p.acreage || '-'}`,
      `Rooms/keys: ${p.rooms || '-'}`,
      `Deal stage: ${p.status || '-'}`,
      `Nehemiah score: ${p.percent}%`,
    ].join('\n');

    const prompt =
`You are an investment analyst at Nehemiah, a resort-property acquisition firm. Write a concise, professional EXECUTIVE SUMMARY of the property below — 3 to 4 short paragraphs of plain text, no headings, no markdown, no bullet points. Synthesize the owner's notes and the uploaded diligence documents. Lead with what the asset is and its standout strength; cover the key entitlement/operational facts and the financial picture; end with the bottom-line assessment and a clear recommendation. Cite concrete figures from the documents where available. Do NOT invent facts that are not present in the material. Do not use the words "I" or "we".

PROPERTY FIELDS:
${fields}

CRITERIA SCORES:
${crit}

OWNER NOTES:
${(p.notes || '(none)').slice(0, 8000)}

EXTRACTED DOCUMENT TEXT (may be truncated):
${docText || '(no extractable text from uploaded documents)'}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => '');
      console.error('Anthropic error', aiRes.status, errText.slice(0, 500));
      return res.status(200).json({ summary: null, reason: 'ai_error', status: aiRes.status });
    }
    const out = await aiRes.json();
    const summary = (out.content && out.content[0] && out.content[0].text)
      ? out.content[0].text.trim() : '';
    return res.status(200).json({ summary, model: out.model, usage: out.usage });
  } catch (err) {
    console.error('exec-summary error', err);
    return res.status(200).json({ summary: null, reason: 'exception' });
  }
}
