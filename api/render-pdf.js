import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import crypto from 'node:crypto';

export const config = { maxDuration: 60 };

// Daily HMAC token — same scheme as the rest of the Nehemiah API.
function validToken(token) {
  const secret = process.env.NEHEMIAH_PASSWORD;
  if (!secret || !token) return false;
  const today = new Date().toISOString().split('T')[0];
  const expected = crypto.createHmac('sha256', secret).update(today).digest('hex');
  return token === expected;
}

// Renders caller-supplied HTML to a real Letter-size PDF using headless Chrome,
// so pagination/@page never depends on the user's browser print dialog.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }

  const token = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : '';
  if (!validToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const html = req.body && req.body.html;
  const name = (req.body && req.body.name) || 'Executive Summary';
  if (!html || typeof html !== 'string') return res.status(400).json({ error: 'Missing html' });

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1100, height: 1400, deviceScaleFactor: 1 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (e) { /* fonts optional */ }
    const pdf = await page.pdf({
      preferCSSPageSize: true,   // honor the document's @page { size: Letter } + margins
      printBackground: true,     // navy cover, colored bars, etc.
      timeout: 45000,
    });
    await browser.close();
    browser = null;

    const safe = String(name).replace(/[^\w .,&()\-]+/g, '').trim().slice(0, 120) || 'Executive Summary';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safe} — Executive Summary.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(pdf));
  } catch (err) {
    console.error('render-pdf error', err);
    if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
    return res.status(500).json({ error: 'PDF render failed', detail: String(err && err.message || err).slice(0, 300) });
  }
}
