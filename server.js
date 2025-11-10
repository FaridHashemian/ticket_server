// server.js — ISA Ticket Server (Node + Postgres + SendGrid)
// HTML template → PDF via Puppeteer (fills reservationTime, reservationNumber, name1/seat1, name2/seat2, qrUrl)
// Includes: real "Reserved At" timestamp and auto-injected logo under QR.

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');

// ---------- Config ----------
const ALLOWED_PHONE = process.env.ALLOWED_PHONE || '+16504185241';
const PUBLIC_BASE   = process.env.PUBLIC_BASE || 'https://isaconcertticket.com';
const SHOW_TIME     = process.env.SHOW_TIME   || 'November 22, 2025, 7:00 PM – 8:30 PM';

const TEMPLATE_DIR     = process.env.TEMPLATE_DIR     || path.join(__dirname);
const RECEIPT_TEMPLATE = process.env.RECEIPT_TEMPLATE || path.join(TEMPLATE_DIR, 'receipt.html');

// allow absolute asset overrides via .env
const BG_PATH   = process.env.BG_PATH   || path.join(TEMPLATE_DIR, 'background.jpg');
const LOGO_PATH = process.env.LOGO_PATH || path.join(TEMPLATE_DIR, 'logo.png');

// ---------- Firebase ----------
const saPath = process.env.FIREBASE_SA_PATH || path.join(__dirname, 'firebase-service-account.json');
let serviceAccount = null;
if (fs.existsSync(saPath)) { try { serviceAccount = require(saPath); } catch {} }
if (serviceAccount && !admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else if (!serviceAccount) {
  console.warn('⚠️ FIREBASE SERVICE ACCOUNT not found — /api/verify_phone will fail.');
}

// ---------- PostgreSQL ----------
const pool = new Pool(); // uses PG* env vars

// ---------- Email ----------
function buildTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    requireTLS: true,
    auth: { user: process.env.SMTP_USER || 'apikey', pass: process.env.SMTP_PASS || '' }
  });
}
async function trySendEmail({ to, subject, text, attachments }) {
  try {
    const transporter = buildTransport();
    await transporter.verify();
    const from = {
      name: process.env.FROM_NAME || 'ISA Concert Tickets',
      address: process.env.FROM_EMAIL || 'no-reply@isaconcertticket.com'
    };
    const info = await transporter.sendMail({ from, to, replyTo: from.address, subject, text, attachments });
    console.log(`✅ Email accepted by SMTP: ${info && info.messageId}`);
    return { ok: true };
  } catch (e) {
    console.warn('⚠️ Email not sent:', e && e.message || e);
    return { ok: false, error: e && e.message || String(e) };
  }
}

// ---------- Helpers ----------
function makeOrderId() {
  const core = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
  return ('R' + core).slice(0, 10);
}
function parseBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
async function getAuthedPhone(req) {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (!token) return null;
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.phone_number || null;
  } catch { return null; }
}
function formatReservedAt(d) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

// ---------- HTML → PDF ----------
function htmlEscape(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function injectBaseHref(html, dirAbsPath) {
  const base = `<base href="file://${dirAbsPath.replace(/\\/g, '/')}/">`;
  if (/<base\s/i.test(html)) return html;
  return html.replace(/<head([^>]*)>/i, (m, g1) => `<head${g1}>${base}`);
}
// Inline background.jpg and logo.png regardless of where they live; if no logo tag, inject one under QR.
// Replace your current inlineAssets(html) with this:
function inlineAssets(html) {
  // Snapshot of the original template BEFORE we mutate it,
  // so we can reliably detect if a logo already exists.
  const original = html;

  // --- Detect an existing logo in the template ---
  const hasExplicitLogoSrc = /src=["'](?:\.\/)?logo\.png(?:\?[^"']*)?["']/i.test(original);
  const hasLogoPlaceholder = /\{\{\s*logoUrl\s*\}\}/.test(original);
  const hasLogoMarkerId    = /id=["']receipt-logo["']/i.test(original);
  const hasLogoMarkerClass = /\bclass=["'][^"']*\blogo\b[^"']*["']/i.test(original);

  // If the template already has any form of logo, we won't auto-inject another.
  const templateHasLogo = hasExplicitLogoSrc || hasLogoPlaceholder || hasLogoMarkerId || hasLogoMarkerClass;

  // --- Inline the background image, if present ---
  if (fs.existsSync(BG_PATH)) {
    try {
      const b64  = fs.readFileSync(BG_PATH).toString('base64');
      const mime = /\.jpe?g$/i.test(BG_PATH) ? 'image/jpeg'
                 : /\.png$/i.test(BG_PATH)   ? 'image/png'
                 : 'application/octet-stream';
      const dataUrl = `url("data:${mime};base64,${b64}")`;

      // Replace typical references to background.jpg in CSS
      html = html
        .replace(/url\(["']?background\.jpg["']?\)/gi, dataUrl)
        .replace(/url\(["']?\.\/background\.jpg["']?\)/gi, dataUrl);
    } catch {}
  }

  // --- Inline the logo file (but don't decide injection yet) ---
  let logoDataUrl = null;
  if (fs.existsSync(LOGO_PATH)) {
    try {
      const b64  = fs.readFileSync(LOGO_PATH).toString('base64');
      const mime = /\.svg$/i.test(LOGO_PATH)  ? 'image/svg+xml'
                 : /\.jpe?g$/i.test(LOGO_PATH)? 'image/jpeg'
                 : 'image/png';
      logoDataUrl = `data:${mime};base64,${b64}`;

      // Replace src="logo.png", src="./logo.png", or src="logo.png?cache=..."
      html = html
        .replace(/src=["'](?:\.\/)?logo\.png(?:\?[^"']*)?["']/gi, `src="${logoDataUrl}"`)
        .replace(/\{\{\s*logoUrl\s*\}\}/g, logoDataUrl); // if you use the placeholder
    } catch {}
  }

  // --- Auto-inject a logo ONLY if the template didn't already have one ---
  if (logoDataUrl && !templateHasLogo) {
    const injected =
      `<div style="position:absolute;right:36px;bottom:22px;">
         <img src="${logoDataUrl}" alt="logo" style="width:110px;height:auto;opacity:.95;display:block;">
       </div>`;
    html = html.replace(/<\/body>\s*<\/html>\s*$/i, `${injected}</body></html>`);
  }

  return html;
}
function fillReceiptTemplate({ reservationTime, reservationNumber, name1, seat1, name2, seat2, qrUrl }) {
  if (!fs.existsSync(RECEIPT_TEMPLATE)) {
    throw new Error('Receipt template not found at ' + RECEIPT_TEMPLATE);
  }
  let html = fs.readFileSync(RECEIPT_TEMPLATE, 'utf8');
  html = injectBaseHref(html, path.dirname(RECEIPT_TEMPLATE));
  html = inlineAssets(html);

  const reps = {
    '{{reservationTime}}': htmlEscape(reservationTime),
    '{{ reservationTime }}': htmlEscape(reservationTime),
    '{{reservationNumber}}': htmlEscape(reservationNumber),
    '{{ reservationNumber }}': htmlEscape(reservationNumber),
    '{{name1}}': htmlEscape(name1 || ''),
    '{{seat1}}': htmlEscape(seat1 || ''), '{{ seat1 }}': htmlEscape(seat1 || ''),
    '{{name2}}': htmlEscape(name2 || ''),
    '{{seat2}}': htmlEscape(seat2 || ''), '{{ seat2 }}': htmlEscape(seat2 || ''),
    '{{qrUrl}}': qrUrl, '{{ qrUrl }}': qrUrl
  };
  for (const [k,v] of Object.entries(reps)) html = html.split(k).join(v);
  return html;
}
async function htmlToPdfBuffer(html) {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--allow-file-access-from-files'
      ]
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: ['domcontentloaded','networkidle0'] });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
    });
  } finally {
    try { await browser?.close(); } catch {}
  }
}
async function buildReceiptPdf(order) {
  const seats = Array.isArray(order.seats) ? order.seats : [];
  const g = Array.isArray(order.guests) ? order.guests : [];
  const guest1 = g[0] || {};
  const guest2 = g[1] || {};

  const name1 = guest1.name || order.email || '';
  const seat1 = guest1.seat || seats[0] || '';
  const name2 = guest2.name || '';
  const seat2 = guest2.seat || '';

  const qrUrlStr  = `${PUBLIC_BASE}/validate.html?orderId=${order.orderId}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrlStr, { margin: 1, width: 300 });

  const html = fillReceiptTemplate({
    reservationTime: order.reservedAt || SHOW_TIME, // << actual reservation time preferred
    reservationNumber: order.orderId,
    name1, seat1, name2, seat2,
    qrUrl: qrDataUrl
  });
  return await htmlToPdfBuffer(html);
}

// ---------- API ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/health') return sendJSON(res, 200, { ok: true });

    if (req.url === '/api/seats' && req.method === 'GET') {
      const { rows } = await pool.query(
        "SELECT seat_id, status FROM seats " +
        "ORDER BY UPPER(REGEXP_REPLACE(seat_id,'[^A-Za-z]+.*$',''))," +
        " (REGEXP_REPLACE(seat_id,'[^0-9]','','g'))::int"
      );
      return sendJSON(res, 200, { seats: rows.map(r => ({ id: r.seat_id, status: r.status })) });
    }

    if (req.url.startsWith('/api/validate') && req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      const orderId = u.searchParams.get('orderId') || '';
      if (!orderId) return sendJSON(res, 400, { ok: false, error: 'Missing orderId' });

      const r = await pool.query(
        "SELECT p.order_id, p.email, ps.seat_id, ps.guest_name " +
        "FROM purchases p LEFT JOIN purchase_seats ps ON ps.order_id = p.order_id " +
        "WHERE p.order_id = $1",
        [orderId]
      );
      if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'Not found' });

      const seats = [...new Set(r.rows.map(x => x.seat_id).filter(Boolean))];
      const guests = r.rows.filter(x => x.guest_name && x.seat_id)
                           .map(x => ({ name: x.guest_name, seat: x.seat_id }));
      return sendJSON(res, 200, { ok: true, orderId, seats, guests });
    }

    if (req.url === '/api/verify_phone' && req.method === 'POST') {
      const body   = await parseBody(req);
      const decoded = await admin.auth().verifyIdToken(body.idToken);
      const phone   = decoded.phone_number;
      const digits  = String(phone || '').replace(/\D/g, '').slice(-10);
      await pool.query(
        'INSERT INTO users (phone, verified) VALUES ($1, true) ' +
        'ON CONFLICT (phone) DO UPDATE SET verified = true',
        [digits]
      );
      return sendJSON(res, 200, { ok: true });
    }

    if (req.url === '/api/purchase' && req.method === 'POST') {
      const phone = await getAuthedPhone(req);
      if (!phone) return sendJSON(res, 401, { error: 'Unauthorized' });

      const body = await parseBody(req);
      const seats = Array.isArray(body.seats) ? body.seats.map(String) : [];
      const guests = Array.isArray(body.guests) ? body.guests : [];
      const email = String(body.email || '').trim();
      let affiliation = String(body.affiliation || 'none').toLowerCase();
      if (!['none','student','staff'].includes(affiliation)) affiliation = 'none';

      if (!email) return sendJSON(res, 400, { error: 'Missing email' });
      if (!seats.length) return sendJSON(res, 400, { error: 'No seats selected' });

      const isOrganizer = phone === ALLOWED_PHONE;
      if (!isOrganizer && seats.length > 2) return sendJSON(res, 403, { error: 'You may reserve up to 2 seats online.' });

      const orderId     = makeOrderId();
      const phoneDigits = String(phone).replace(/\D/g, '').slice(-10);

      const guestBySeat = new Map((guests || []).map(g => [String(g.seat), String(g.name || '').trim()]));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO purchases (order_id, phone, email, affiliation) VALUES ($1,$2,$3,$4)',
          [orderId, phoneDigits, email, affiliation]);
        for (const sId of seats) {
          await client.query('UPDATE seats SET status = $1 WHERE seat_id = $2', ['sold', sId]);
          const gname = guestBySeat.get(sId) || 'Guest';
          await client.query('INSERT INTO purchase_seats (order_id, seat_id, guest_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [orderId, sId, gname]);
        }
        await client.query('COMMIT');
      } catch (txErr) {
        try { await client.query('ROLLBACK'); } catch {}
        throw txErr;
      } finally {
        client.release();
      }

      // Build and email receipt
      const reservedAtStr = formatReservedAt(new Date());
      let email_sent = false;
      try {
        const pdfBuffer = await buildReceiptPdf({
          orderId, seats, guests: guests.map(g => ({ name: g.name, seat: g.seat })), email,
          reservedAt: reservedAtStr
        });
        const result = await trySendEmail({
          to: email,
          subject: 'Your Concert Ticket Receipt',
          text: `Reservation confirmed.\nOrder ID: ${orderId}\nTime: ${SHOW_TIME}`,
          attachments: [{ filename: 'receipt.pdf', content: pdfBuffer, contentType: 'application/pdf' }]
        });
        email_sent = !!result.ok;
      } catch (e) {
        console.warn('⚠️ Could not build/attach HTML PDF:', e.message);
      }
      return sendJSON(res, 200, { ok: true, orderId, email_sent });
    }

    if (req.url.startsWith('/api/resend_receipt') && req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      const orderId  = u.searchParams.get('orderId') || '';
      const override = (u.searchParams.get('email') || '').trim();
      if (!orderId) return sendJSON(res, 400, { ok: false, error: 'Missing orderId' });

      const r = await pool.query(
        "SELECT p.order_id, p.email, p.created_at, " +
        "       array_agg(ps.seat_id ORDER BY ps.seat_id) AS seats, " +
        "       array_agg(ps.guest_name ORDER BY ps.seat_id) AS gnames " +
        "FROM purchases p LEFT JOIN purchase_seats ps ON ps.order_id = p.order_id " +
        "WHERE p.order_id = $1 GROUP BY p.order_id, p.email, p.created_at",
        [orderId]
      );
      if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'Order not found' });

      const email  = override || r.rows[0].email;
      const seats  = r.rows[0].seats || [];
      const gnames = r.rows[0].gnames || [];
      const guests = seats.map((s, i) => ({ name: gnames[i] || 'Guest', seat: s }));
      const reservedAtStr = formatReservedAt(new Date(r.rows[0].created_at || Date.now()));

      try {
        const pdfBuffer = await buildReceiptPdf({ orderId, seats, guests, email, reservedAt: reservedAtStr });
        const result = await trySendEmail({
          to: email,
          subject: 'Your Concert Ticket Receipt (Resent)',
          text: `Order ID: ${orderId}\nTime: ${SHOW_TIME}`,
          attachments: [{ filename: 'receipt.pdf', content: pdfBuffer, contentType: 'application/pdf' }]
        });
        return sendJSON(res, 200, { ok: true, email_sent: !!result.ok });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    if (req.url === '/' || req.url.endsWith('.html') || req.url.endsWith('.css') || req.url.endsWith('.js')) {
      const fp = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
      const ext = path.extname(fp);
      if (!fs.existsSync(fp)) return sendJSON(res, 404, { error: 'File not found' });
      const data = fs.readFileSync(fp);
      const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'application/javascript';
      res.writeHead(200, { 'Content-Type': type });
      return res.end(data);
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () =>
  console.log('✅ Server running on port ' + PORT)
);