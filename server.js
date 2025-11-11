// server.js — ISA Ticket Server (Node + Postgres + Mailgun SMTP)
// HTML template → PDF via Puppeteer (fills reservationTime, reservationNumber, name1/seat1, name2/seat2, qrUrl)
// Includes: real "Reserved At" timestamp, single-logo injection, and HTML announcement email.

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

// ---------- Email (Mailgun-ready) ----------
function buildTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mailgun.org',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true', // false for STARTTLS (587)
    requireTLS: true,
    auth: {
      user: process.env.SMTP_USER || 'receipt@isaconcertticket.com',
      pass: process.env.SMTP_PASS || ''
    },
    tls: {
      ciphers: 'SSLv3',
      rejectUnauthorized: false
    }
  });
}

async function trySendEmail({ to, subject, text, html, attachments }) {
  try {
    const transporter = buildTransport();
    await transporter.verify();
    const from = {
      name: process.env.FROM_NAME || 'ISA Concert Tickets',
      address: process.env.FROM_EMAIL || 'receipt@isaconcertticket.com'
    };
    const info = await transporter.sendMail({
      from,
      to,
      replyTo: from.address,
      subject,
      text,
      html,
      attachments
    });
    console.log(`✅ Mail accepted by SMTP: ${info && info.messageId}`);
    return { ok: true };
  } catch (e) {
    console.warn('⚠️ Email not sent:', e.message || e);
    return { ok: false, error: e.message || String(e) };
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
function toE164US(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(-10);
  return d ? `+1${d}` : null;
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

// Build the announcement HTML + plain text for emails
function buildEmailBodies({ orderId, seats = [], reservedAt }) {
  const seatLine = seats.length ? seats.join(', ') : '—';
  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.55;background:#f5f7fb;padding:24px;color:#111;">
    <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 6px 18px rgba(16,24,40,.08);padding:28px 28px;">
      <h1 style="margin:0 0 16px;font-size:40px;line-height:1.1;color:#111;">
        You Reserved Your Seat For Marjan Farsad Concert!
      </h1>
        <div style="margin:18px 0 12px;padding:12px 14px;background:#f1f4ff;border:1px solid #dfe6ff;border-radius:10px;">
        <div><strong>Reservation #:</strong> ${orderId}</div>
        <div><strong>Reserved At:</strong> ${reservedAt}</div>
        <div><strong>Seats:</strong> ${seatLine}</div>
        <div><strong>Concert Time:</strong> ${SHOW_TIME}</div>
      </div>

      <p style="margin:0 0 16px;">Thank you for reserving your seat for the upcoming concert.</p>

      <p style="margin:0 0 12px;">
        Welcome to the Marjan Farsad Concert hosted by the Iranian Students Association at the University of Arkansas!
        We’re delighted to have you join us for an evening of music and art. Please arrive at least
        <strong>15 minutes early</strong> to ensure a smooth seating experience.
      </p>

      <h3 style="margin:20px 0 8px;">Parking Information:</h3>
      <p style="margin:0 0 12px;">Union Parking is available in accordance with the University’s parking rules and regulations.</p>

      <p style="margin:18px 0 4px;">
        See you on <strong>November 22, 7 pm @ Union Theater</strong>!
      </p>

      <p style="margin:10px 0 0;color:#555;">
        Your PDF receipt with QR code is attached to this email. Please bring it (printed or on your phone) for check-in.
      </p>
      <p  style="margin:18px 0 4px;">
        If you have any questions, or you want to modify your reservation, feel free to contact the following email <b>isa@uark.edu</b>.
      </p>
    </div>
  </div>`.trim();

  const text = [
    'You Reserved Your Seat For Marjan Farsad Concert!',
    '',
    `Reservation #: ${orderId}`,
    `Reserved At: ${reservedAt}`,
    `Seats: ${seatLine}`,
    `Concert Time: ${SHOW_TIME}`,
    '',
    'Thank you for reserving your seat for the upcoming concert.',
    '',
    'Welcome to the Marjan Farsad Concert hosted by the Iranian Students Association at the University of Arkansas!',
    'Please arrive at least 15 minutes early to ensure a smooth seating experience.',
    '',
    'Parking Information:',
    'Union Parking is available in accordance with the University’s parking rules and regulations.',
    '',
    'See you on November 22, 7 pm @ Union Theater!',
    '',
    'Your PDF receipt with QR code is attached.',
    '',
    'If you have any questions, or you want to modify your reservation, feel free to contact the following email isa@uark.edu.'
  ].join('\n');

  return { html, text };
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

// single-logo safe inliner
function inlineAssets(html) {
  const original = html;

  const hasExplicitLogoSrc = /src=["'](?:\.\/)?logo\.png(?:\?[^"']*)?["']/i.test(original);
  const hasLogoPlaceholder = /\{\{\s*logoUrl\s*\}\}/.test(original);
  const hasLogoMarkerId    = /id=["']receipt-logo["']/i.test(original);
  const hasLogoMarkerClass = /\bclass=["'][^"']*\blogo\b[^"']*["']/i.test(original);
  const templateHasLogo = hasExplicitLogoSrc || hasLogoPlaceholder || hasLogoMarkerId || hasLogoMarkerClass;

  if (fs.existsSync(BG_PATH)) {
    try {
      const b64  = fs.readFileSync(BG_PATH).toString('base64');
      const mime = /\.jpe?g$/i.test(BG_PATH) ? 'image/jpeg'
                 : /\.png$/i.test(BG_PATH)   ? 'image/png'
                 : 'application/octet-stream';
      const dataUrl = `url("data:${mime};base64,${b64}")`;
      html = html
        .replace(/url\(["']?background\.jpg["']?\)/gi, dataUrl)
        .replace(/url\(["']?\.\/background\.jpg["']?\)/gi, dataUrl);
    } catch {}
  }

  let logoDataUrl = null;
  if (fs.existsSync(LOGO_PATH)) {
    try {
      const b64  = fs.readFileSync(LOGO_PATH).toString('base64');
      const mime = /\.svg$/i.test(LOGO_PATH)  ? 'image/svg+xml'
                 : /\.jpe?g$/i.test(LOGO_PATH)? 'image/jpeg'
                 : 'image/png';
      logoDataUrl = `data:${mime};base64,${b64}`;
      html = html
        .replace(/src=["'](?:\.\/)?logo\.png(?:\?[^"']*)?["']/gi, `src="${logoDataUrl}"`)
        .replace(/\{\{\s*logoUrl\s*\}\}/g, logoDataUrl);
    } catch {}
  }

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
    reservationTime: order.reservedAt || SHOW_TIME,
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
          `SELECT seat_id, status
     FROM seats
   ORDER BY seat_row ASC, seat_number DESC`
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


      // normalize both sides so the comparison is rock solid
      const envAllowed = toE164US(process.env.ALLOWED_PHONE || '+16504185241');
      const phoneE164  = toE164US(phone);
      const isOrganizer = (phoneE164 && envAllowed) ? (phoneE164 === envAllowed) : false;
      const body = await parseBody(req);
      const seats = Array.isArray(body.seats) ? body.seats.map(String) : [];
      const guests = Array.isArray(body.guests) ? body.guests : [];
      const email = String(body.email || '').trim();
      let affiliation = String(body.affiliation || 'none').toLowerCase();
      if (!['none','student','staff'].includes(affiliation)) affiliation = 'none';

      if (!email) return sendJSON(res, 400, { error: 'Missing email' });
      if (!seats.length) return sendJSON(res, 400, { error: 'No seats selected' });

      if (!isOrganizer && seats.length > 2) return sendJSON(res, 403, { error: 'You may reserve up to 2 seats online.' });

      const orderId     = makeOrderId();
      const phoneDigits = String(phoneE164 || '').replace(/\D/g, '').slice(-10);

      // cumulative count of seats already reserved by this phone
      const { rows: priorRows } = await pool.query(
        `SELECT COALESCE(COUNT(*),0)::int AS cnt
          FROM purchase_seats ps
          JOIN purchases p ON p.order_id = ps.order_id
          WHERE p.phone = $1`,
        [phoneDigits]
      );
      const already = priorRows?.[0]?.cnt || 0;

      // enforce global cap for non-organizer
      if (!isOrganizer && (already + seats.length > 2)) {
        return sendJSON(res, 403, {
          error: `You already have ${already} seat(s). You may reserve up to 2 seats in total.`
        });
      }

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

        const bodies = buildEmailBodies({ orderId, seats, reservedAt: reservedAtStr });
        const result = await trySendEmail({
          to: email,
          subject: 'Your Concert Reservation & Ticket Receipt',
          text: bodies.text,
          html: bodies.html,
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

      // Try query WITH created_at; if the column doesn't exist, fall back without it
      let r;
      try {
        r = await pool.query(
          "SELECT p.order_id, p.email, p.created_at, " +
          "       array_agg(ps.seat_id ORDER BY ps.seat_id) AS seats, " +
          "       array_agg(ps.guest_name ORDER BY ps.seat_id) AS gnames " +
          "FROM purchases p LEFT JOIN purchase_seats ps ON ps.order_id = p.order_id " +
          "WHERE p.order_id = $1 GROUP BY p.order_id, p.email, p.created_at",
          [orderId]
        );
      } catch (e) {
        // fallback if created_at column doesn't exist
        r = await pool.query(
          "SELECT p.order_id, p.email, " +
          "       array_agg(ps.seat_id ORDER BY ps.seat_id) AS seats, " +
          "       array_agg(ps.guest_name ORDER BY ps.seat_id) AS gnames " +
          "FROM purchases p LEFT JOIN purchase_seats ps ON ps.order_id = p.order_id " +
          "WHERE p.order_id = $1 GROUP BY p.order_id, p.email",
          [orderId]
        );
      }
      if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'Order not found' });

      const email  = override || r.rows[0].email;
      const seats  = r.rows[0].seats || [];
      const gnames = r.rows[0].gnames || [];
      const guests = seats.map((s, i) => ({ name: gnames[i] || 'Guest', seat: s }));
      const reservedAtStr = formatReservedAt(new Date(r.rows[0].created_at || Date.now()));

      try {
        const pdfBuffer = await buildReceiptPdf({ orderId, seats, guests, email, reservedAt: reservedAtStr });
        const bodies = buildEmailBodies({ orderId, seats, reservedAt: reservedAtStr });
        const result = await trySendEmail({
          to: email,
          subject: 'Your Concert Reservation & Ticket Receipt (Resent)',
          text: bodies.text,
          html: bodies.html,
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