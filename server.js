// server.js — Seats + phone auth, SendGrid SMTP, PDF receipt from PPTX (LibreOffice), and diagnostics

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const admin = require('firebase-admin');

// PPTX → PDF pipeline
const { default: createReport } = require('pptx-templates');
const { spawn } = require('child_process');
const tmp = require('tmp');

// ---------- Config ----------
const ALLOWED_PHONE = process.env.ALLOWED_PHONE || '+16504185241'; // Organizer (unlimited)
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://isaconcertticket.com';
const SHOW_TIME = process.env.SHOW_TIME || 'November 22, 2025, 7:00 PM – 8:30 PM';
const LOGO_PATH = process.env.LOGO_PATH || path.join(__dirname, 'assets', 'logo.png'); // optional (for legacy PDF)

// ---------- Firebase ----------
const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
const serviceAccount = fs.existsSync(serviceAccountPath) ? require(serviceAccountPath) : null;
if (serviceAccount && !admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else if (!serviceAccount) {
  console.warn('⚠️ firebase-service-account.json not found; phone verification will fail.');
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
    auth: {
      user: process.env.SMTP_USER || 'apikey',
      pass: process.env.SMTP_PASS || ''
    }
  });
}

async function sendEmail(to, subject, text, attachments = []) {
  const transporter = buildTransport();
  try {
    await transporter.verify();
  } catch (e) {
    console.error('❌ SMTP verify failed:', e && e.message || e);
    throw new Error('SMTP verify failed: ' + (e && e.message || e));
  }
  const from = {
    name: process.env.FROM_NAME || 'ISA Concert Tickets',
    address: process.env.FROM_EMAIL || 'no-reply@isaconcertticket.com'
  };
  try {
    const info = await transporter.sendMail({
      from,
      to,
      replyTo: from.address,
      subject,
      text,
      attachments
    });
    console.log(`✅ Email accepted by SMTP: ${info && info.messageId}`);
  } catch (e) {
    console.error('❌ SMTP send failed:', e && e.message || e);
    throw new Error('SMTP send failed: ' + (e && e.message || e));
  }
}

// ---------- Utilities ----------
function makeOrderId() {
  // Max 10 chars to fit varchar(10).
  // Format: R + base36 timestamp chunk + random chunk (capped at 9 after 'R')
  const core = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
  return ('R' + core).slice(0, 10);
}

function phoneKey10(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  return digits || null;
}

function parseBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
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
  } catch {
    return null;
  }
}

// ---------- PPTX → PDF helpers ----------
async function convertPptxToPdfBuffer(pptxPath) {
  return new Promise((resolve, reject) => {
    const outdir = tmp.dirSync({ unsafeCleanup: true }).name;
    const soffice = spawn('soffice', [
      '--headless',
      '--nologo',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      '--convert-to', 'pdf',
      '--outdir', outdir,
      pptxPath
    ]);

    let stderr = '';
    soffice.stderr.on('data', (d) => { stderr += d.toString(); });

    soffice.on('close', (code) => {
      if (code !== 0) return reject(new Error(`LibreOffice failed (code ${code}): ${stderr || 'no stderr'}`));
      const pdfPath = path.join(outdir, path.basename(pptxPath, path.extname(pptxPath)) + '.pdf');
      try {
        const buf = fs.readFileSync(pdfPath);
        resolve(buf);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function createReceiptPDFfromPPTX(order) {
  const templatePath = process.env.PPTX_TEMPLATE;
  if (!templatePath || !fs.existsSync(templatePath)) {
    throw new Error('PPTX template not found. Set PPTX_TEMPLATE in .env');
  }

  const url = `${PUBLIC_BASE}/validate.html?orderId=${order.orderId}`;
  const qrPng = await QRCode.toBuffer(url, { margin: 1, width: 600 });

  const data = {
    reservationNumber: order.orderId,
    reservationTime: SHOW_TIME,
    guestName: (order.guests && order.guests.length) ? order.guests[0].name : order.email,
    seatLabel: (order.seats && order.seats.length === 1) ? order.seats[0] : '',
    seatList: (order.seats || []).join(', '),
    qr: { data: qrPng, extension: '.png' } // replaces {{qr}} with image
  };

  const templateBuffer = fs.readFileSync(templatePath);
  const filledPptx = await createReport({ template: templateBuffer, data });

  const tmpPptx = tmp.fileSync({ postfix: '.pptx' }).name;
  fs.writeFileSync(tmpPptx, Buffer.from(filledPptx));

  const pdfBuffer = await convertPptxToPdfBuffer(tmpPptx);

  const outPath = path.join(__dirname, `receipts/receipt_${order.orderId}.pdf`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, pdfBuffer);

  return outPath;
}

// ---------- API ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/health') return sendJSON(res, 200, { ok: true });

    if (req.url === '/api/seats' && req.method === 'GET') {
      // Sort row (letters) then number
      const { rows } = await pool.query(
        "SELECT * FROM seats " +
        "ORDER BY UPPER(REGEXP_REPLACE(seat_id,'[^A-Za-z]+.*$',''))," +
        " (REGEXP_REPLACE(seat_id,'\\D','','g'))::int"
      );
      const seats = rows.map(r => ({ id: r.seat_id, status: r.status }));
      return sendJSON(res, 200, { seats });
    }

    // Validate reservation by orderId (used by validate.html)
    if (req.url.startsWith('/api/validate') && req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      const orderId = u.searchParams.get('orderId') || '';
      if (!orderId) return sendJSON(res, 400, { ok: false, error: 'Missing orderId' });
      const { rows } = await pool.query('SELECT order_id, email, affiliation FROM purchases WHERE order_id=$1', [orderId]);
      if (!rows.length) return sendJSON(res, 404, { ok: false, error: 'Not found' });
      return sendJSON(res, 200, { ok: true, orderId, seats: [], guests: [] });
    }

    if (req.url === '/api/verify_phone' && req.method === 'POST') {
      const body = await parseBody(req);
      const decoded = await admin.auth().verifyIdToken(body.idToken);
      const phone = decoded.phone_number;
      const pk = phoneKey10(phone);
      await pool.query(
        'INSERT INTO users (phone, verified) VALUES ($1, true) ON CONFLICT (phone) DO UPDATE SET verified=true',
        [pk]
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
        return sendJSON(res, 403, { error: 'You can reserve up to 2 seats online. For more, please call (650) 418-5241.' });
      }

      const orderId = makeOrderId(); // ≤ 10 chars
      const pk = phoneKey10(phone);

      await pool.query('INSERT INTO purchases (order_id, phone, email, affiliation) VALUES ($1,$2,$3,$4)',
        [orderId, pk, email, affiliation]
      );
      for (const sId of seats) {
        await pool.query('UPDATE seats SET status=$1 WHERE seat_id=$2', ['sold', sId]);
      }

      const pdfPath = await createReceiptPDFfromPPTX({ orderId, seats, guests, email, affiliation });
      await sendEmail(email, 'Your Concert Ticket Receipt', `Reservation confirmed.\nOrder ID: ${orderId}`, [
        { filename: 'receipt.pdf', path: pdfPath }
      ]);
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
      const type =
        ext === '.html' ? 'text/html' :
        ext === '.css'  ? 'text/css'  :
        'application/javascript';
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