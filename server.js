// server.js — Seats + phone auth, SendGrid SMTP, PDF receipt from PPTX (LibreOffice), and diagnostics

require('dotenv').config(); // ← load .env when running outside systemd

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const admin = require('firebase-admin');
const { spawn } = require('child_process');
const tmp = require('tmp');

// ---------- Config ----------
const ALLOWED_PHONE = process.env.ALLOWED_PHONE || '+16504185241'; // Organizer (unlimited)
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://isaconcertticket.com';
const SHOW_TIME = process.env.SHOW_TIME || 'November 22, 2025, 7:00 PM – 8:30 PM';
const LOGO_PATH = process.env.LOGO_PATH || path.join(__dirname, 'assets', 'logo.png'); // optional (for legacy PDF)
const PPTX_TEMPLATE = process.env.PPTX_TEMPLATE; // optional but recommended

// ---------- Firebase ----------
const serviceAccountPath =
  process.env.FIREBASE_SA_PATH || path.join(__dirname, 'firebase-service-account.json');
let serviceAccount = null;
if (fs.existsSync(serviceAccountPath)) {
  try { serviceAccount = require(serviceAccountPath); } catch {}
}
if (serviceAccount && !admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else if (!serviceAccount) {
  console.warn('⚠️ FIREBASE SERVICE ACCOUNT not found at', serviceAccountPath,
               '— phone verification webhook (/api/verify_phone) will fail.');
}

// ---------- PostgreSQL ----------
const pool = new Pool(); // Uses PG* env vars from .env

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

async function sendEmail(to, subject, text, attachments = []) {
  const transporter = buildTransport();
  await transporter.verify();
  const from = {
    name: process.env.FROM_NAME || 'ISA Concert Tickets',
    address: process.env.FROM_EMAIL || 'no-reply@isaconcertticket.com'
  };
  const info = await transporter.sendMail({ from, to, replyTo: from.address, subject, text, attachments });
  console.log(`✅ Email accepted by SMTP: ${info && info.messageId}`);
}

// ---------- Utilities ----------
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

// ---------- PPTX → PDF helpers ----------
async function convertPptxToPdfBuffer(pptxPath) {
  return new Promise((resolve, reject) => {
    const outdir = tmp.dirSync({ unsafeCleanup: true }).name;
    const soffice = spawn('soffice', [
      '--headless','--nologo','--nolockcheck','--nodefault','--nofirststartwizard',
      '--convert-to','pdf','--outdir', outdir, pptxPath
    ]);
    let stderr = '';
    soffice.stderr.on('data', d => { stderr += d.toString(); });
    soffice.on('close', (code) => {
      if (code !== 0) return reject(new Error(`LibreOffice failed (code ${code}): ${stderr || 'no stderr'}`));
      const pdfPath = path.join(outdir, path.basename(pptxPath, path.extname(pptxPath)) + '.pdf');
      try { resolve(fs.readFileSync(pdfPath)); } catch (e) { reject(e); }
    });
  });
}

async function createReceiptPDFfromPPTX(order) {
  if (!PPTX_TEMPLATE || !fs.existsSync(PPTX_TEMPLATE)) {
    throw new Error('PPTX template not found. Set PPTX_TEMPLATE in .env');
  }

  // lazy import pptx-templates so the server can still run if it is missing
  let createReport;
  try {
    ({ default: createReport } = require('pptx-templates'));
  } catch {
    throw new Error('pptx-templates is not installed. Run: npm i pptx-templates tmp');
  }

  const url = `${PUBLIC_BASE}/validate.html?orderId=${order.orderId}`;
  const qrPng = await require('qrcode').toBuffer(url, { margin: 1, width: 600 });

  const data = {
    reservationNumber: order.orderId,
    reservationTime: SHOW_TIME,
    guestName: (order.guests && order.guests.length) ? order.guests[0].name : order.email,
    seatLabel: (order.seats && order.seats.length === 1) ? order.seats[0] : '',
    seatList: (order.seats || []).join(', '),
    qr: { data: qrPng, extension: '.png' }
  };

  const templateBuffer = fs.readFileSync(PPTX_TEMPLATE);
  const filledPptx = await createReport({ template: templateBuffer, data });
  const tmpPptx = tmp.fileSync({ postfix: '.pptx' }).name;
  fs.writeFileSync(tmpPptx, Buffer.from(filledPptx));
  return await convertPptxToPdfBuffer(tmpPptx);
}

// ---------- API ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/health') return sendJSON(res, 200, { ok: true });

    if (req.url === '/api/seats' && req.method === 'GET') {
      // ✅ Postgres seat sort: row letters, then numeric index
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
        "SELECT p.order_id, p.email, s.seat_id, g.guest_name " +
        "FROM purchases p " +
        "LEFT JOIN purchase_seats s ON s.order_id = p.order_id " +
        "LEFT JOIN purchase_guests g ON g.order_id = p.order_id AND g.seat_id = s.seat_id " +
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
      const body = await parseBody(req);
      const decoded = await admin.auth().verifyIdToken(body.idToken);
      const phone = decoded.phone_number;
      const digits = String(phone || '').replace(/\D/g, '').slice(-10);
      await pool.query(
        'INSERT INTO users (phone, verified) VALUES ($1, true) ON CONFLICT (phone) DO UPDATE SET verified=true',
        [digits]
      );
      return sendJSON(res, 200, { ok: true });
    }

    if (req.url === '/api/purchase' && req.method === 'POST') {
      const phone = await getAuthedPhone(req);
      if (!phone) return sendJSON(res, 401, { error: 'Unauthorized' });

      const body = await parseBody(req);
      const seats = Array.isArray(body.seats) ? body.seats : [];
      const guests = Array.isArray(body.guests) ? body.guests : [];
      const email = String(body.email || '').trim();
      let affiliation = String(body.affiliation || 'none').toLowerCase();
      if (!['none', 'student', 'staff'].includes(affiliation)) affiliation = 'none';

      if (!email) return sendJSON(res, 400, { error: 'Missing email' });
      if (!seats.length) return sendJSON(res, 400, { error: 'No seats selected' });

      const isOrganizer = phone === ALLOWED_PHONE;
      if (!isOrganizer && seats.length > 2) {
        return sendJSON(res, 403, { error: 'You can reserve up to 2 seats online.' });
      }

      const orderId = makeOrderId();
      const phoneDigits = String(phone || '').replace(/\D/g, '').slice(-10);
      // basic writes (adjust to your real schema as needed)
      await pool.query(
      'INSERT INTO purchases (order_id, phone, email, affiliation) VALUES ($1,$2,$3,$4)',
      [orderId, phoneDigits, email, affiliation]
      );

      for (const sId of seats) {
        await pool.query('UPDATE seats SET status=$1 WHERE seat_id=$2', ['sold', sId]);
        await pool.query(
        'INSERT INTO purchase_seats (order_id, seat_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [orderId, sId]
        );
      }

      for (const g of guests) {
        await pool.query(
        'INSERT INTO purchase_guests (order_id, seat_id, guest_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [orderId, g.seat, g.name]
        );
      }

      // Try to build PDF; if tooling missing, still send a plain email
      let attachments = [];
      try {
        const pdfBuffer = await createReceiptPDFfromPPTX({ orderId, seats, guests, email, affiliation });
        const outDir = path.join(__dirname, 'receipts'); fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `receipt_${orderId}.pdf`); fs.writeFileSync(outPath, pdfBuffer);
        attachments.push({ filename: 'receipt.pdf', path: outPath });
      } catch (e) {
        console.warn('⚠️ Receipt PDF not attached:', e.message);
      }

      await sendEmail(email, 'Your Concert Ticket Receipt',
        `Reservation confirmed.\nOrder ID: ${orderId}\nSeats: ${seats.join(', ')}\nTime: ${SHOW_TIME}`, attachments);

      return sendJSON(res, 200, { ok: true, orderId });
    }

    // Test mail endpoint (GET /api/test_mail?to=you@example.com)
    if (req.url.startsWith('/api/test_mail') && req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      const to = u.searchParams.get('to');
      try {
        await sendEmail(to || (process.env.TEST_TO || ''), 'SMTP test', 'This is a test email from ISA Concert server.');
        return sendJSON(res, 200, { ok: true, to: to || process.env.TEST_TO || null });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // Serve static
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

server.listen(process.env.PORT || 3000, () =>
  console.log('✅ Server running on port ' + (process.env.PORT || 3000))
);