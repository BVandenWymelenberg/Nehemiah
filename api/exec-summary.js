import { get } from '@vercel/blob';
import crypto from 'node:crypto';

const BLOB_PATH = 'nehemiah/ranked-properties.json';
const MAX_DOC_CHARS = 60000;        // cap extracted document text fed to the model
const MAX_COMP_PDFS = 3;            // how many comp PDFs to attach as native base64 documents
const MAX_PDF_BYTES = 6 * 1024 * 1024;   // per-file cap for base64 PDF attachments (~6MB)
const MAX_PDF_TOTAL = 14 * 1024 * 1024;  // total base64 PDF budget across the request
const MODEL = process.env.EXEC_SUMMARY_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = Number(process.env.EXEC_SUMMARY_MAX_TOKENS) || 1000;

// Filenames that mark a document as comparable-sales material.
const COMP_RE = /(comp\b|comps\b|comparable|comparables|\bcma\b|sales?\s*comp|sold\s*comp|price[-_ ]?per[-_ ]?acre)/i;

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

function isPdf(file) {
  const name = (file.name || '').toLowerCase();
  const ct = (file.contentType || '').toLowerCase();
  return ct === 'application/pdf' || name.endsWith('.pdf');
}

// True when a file looks like an uploaded comparable-sales document.
function isCompFile(file) {
  return COMP_RE.test(file.name || '') || COMP_RE.test(file.pathname || '');
}

// Extract plain text from an uploaded file. Images/video/unknown types return ''.
async function extractText(file, bufOverride) {
  const name = (file.name || '').toLowerCase();
  const ct = (file.contentType || '').toLowerCase();
  try {
    const buf = bufOverride || (await blobBuffer(file.pathname));
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

    const files = p.files || [];
    const compFiles = files.filter(isCompFile);
    const useUploadedComps = compFiles.length > 0;

    // Pull text from every extractable uploaded document, up to the char budget.
    // Comp documents go first so they survive the truncation window.
    let docText = '';
    const orderedFiles = [...compFiles, ...files.filter((f) => !isCompFile(f))];
    const pdfBlocks = [];       // native base64 PDF document blocks for uploaded comps
    let pdfBudget = MAX_PDF_TOTAL;

    for (const f of orderedFiles) {
      let buf = null;
      // Attach uploaded comp PDFs as native documents so the model reads tables/figures directly.
      if (useUploadedComps && isCompFile(f) && isPdf(f) && pdfBlocks.length < MAX_COMP_PDFS) {
        buf = await blobBuffer(f.pathname);
        if (buf && buf.length <= MAX_PDF_BYTES && buf.length <= pdfBudget) {
          pdfBudget -= buf.length;
          pdfBlocks.push({
            type: 'document',
            title: (f.name || 'Comparable sales').slice(0, 120),
            source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
          });
        }
      }
      if (docText.length >= MAX_DOC_CHARS) continue;
      const t = await extractText(f, buf);
      if (t && t.trim()) {
        const tag = isCompFile(f) ? ' [COMPARABLE SALES DOCUMENT]' : '';
        docText += `\n\n===== ${f.name || 'document'}${tag} =====\n${t.trim()}`;
      }
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
      `Listing: ${p.listingUrl || '-'}`,
      `Nehemiah score: ${p.percent}%`,
    ].join('\n');

    const compsProvenance = useUploadedComps
      ? `COMPS SOURCE: UPLOADED DOCUMENTS. The user's own comparable-sales documents are attached and/or extracted below (marked [COMPARABLE SALES DOCUMENT]). Draw every comp from those documents ONLY — do not use outside or web data. Begin section 4 with the exact italic line: *Comps from uploaded documents.* Apply the acreage filter strictly and cite the specific comps by name.`
      : `COMPS SOURCE: WEB SEARCH. No comparable-sales documents were uploaded. Use the web_search tool to find qualifying large-parcel (roughly 25 to 30+ acre) resort, ranch, estate, or land sales that CLOSED within the last 24 months, prioritizing the same market and comparable asset types. Begin section 4 with the exact italic line: *Comps pulled from web, last 24 months.* For every comp, note the source and the sale date. Apply the acreage filter strictly.`;

    const prompt =
`You are a senior acquisitions analyst at Nehemiah, a resort-property investment firm. Produce a deep, institutional-grade ACQUISITION BRIEF for the property below, written in clean GitHub-flavored Markdown. This is a dense one-page brief — be specific, quantitative, and economical with words.

Use these exact section headings, in this order:

## 1. Property Snapshot
Asset type, key stats, current status, and the headline investment thesis.

## 2. Town / Location Deep Dive
Population, economic drivers, seasonality, access, proximity to demand generators, and any land-use or regulatory context that matters.

## 3. Market Analysis
Lodging/hospitality demand, ADR and occupancy benchmarks for the submarket, wedding/events market sizing if relevant, competitive supply, and growth or risk trends.

## 4. Comparable Sales (last 24 months, 25+ acres only)
${compsProvenance}
Render this section as a Markdown table with exactly these columns:
| Property | Location | Date | Acreage | Price | $/Acre | $/Key | Relevance |
Always populate the Acreage column so the size filter is visible at a glance. Use "—" where a value is genuinely unknown. Add a one-line relevance note per comp.

## 5. Valuation Read
What the comps imply for this asset, the key value drivers, and where the upside and the risk sit.

## 6. Bottom Line
A direct 3 to 5 sentence take on the opportunity.

STRICT COMPARABLE-SALES FILTER (applies to every comp in section 4):
Only include sales that are LARGE land, resort, ranch, or home/estate deals on parcels of ROUGHLY 25 TO 30+ ACRES. Exclude standard residential lots, small-acreage homes, and condo or keyed-hotel sales that sit on small parcels. If a candidate is under ~25 acres, exclude it even if the asset type is similar. Only sales closed within the last 24 months qualify. The comparison set is large-parcel resort, ranch, estate, and land deals only.

RULES:
- Cite concrete figures wherever available. Do NOT invent facts that are not present in the material or the search results; if something is unknown, say so briefly.
- Do not use the words "I" or "we".
- Return only the Markdown brief — no preamble, no closing remarks.

PROPERTY FIELDS:
${fields}

CRITERIA SCORES:
${crit}

OWNER NOTES:
${(p.notes || '(none)').slice(0, 8000)}

EXTRACTED DOCUMENT TEXT (may be truncated):
${docText || '(no extractable text from uploaded documents)'}`;

    const content = [...pdfBlocks, { type: 'text', text: prompt }];
    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content }],
    };
    // Only enable web search when the user has NOT supplied their own comps.
    if (!useUploadedComps) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    }

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => '');
      console.error('Anthropic error', aiRes.status, errText.slice(0, 500));
      return res.status(200).json({ summary: null, reason: 'ai_error', status: aiRes.status });
    }
    const out = await aiRes.json();

    // Process ALL content blocks — filter to text, don't assume ordering or a single block.
    const blocks = Array.isArray(out.content) ? out.content : [];
    const summary = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim();

    // Surface web-search sources (title + url) so the client can show provenance.
    const sources = [];
    for (const b of blocks) {
      if (b && b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) {
          if (r && r.type === 'web_search_result' && r.url) {
            sources.push({ title: r.title || r.url, url: r.url });
          }
        }
      }
    }

    return res.status(200).json({
      summary,
      compsSource: useUploadedComps ? 'uploaded' : 'web',
      compFiles: compFiles.map((f) => f.name || 'document'),
      sources: sources.slice(0, 12),
      model: out.model,
      usage: out.usage,
    });
  } catch (err) {
    console.error('exec-summary error', err);
    return res.status(200).json({ summary: null, reason: 'exception' });
  }
}
