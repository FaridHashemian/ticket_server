// server.js — ISA Ticket Server (Node + Postgres + SendGrid) with ACID purchases,
// resilient email, and always-attach PDF (PPTX->PDF with PDFKit fallback)

require('dotenv').config();

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
const ALLOWED_PHONE = process.env.ALLOWED_PHONE || '+16504185241';
const PUBLIC_BASE   = process.env.PUBLIC_BASE || 'https://isaconcertticket.com';
const SHOW_TIME     = process.env.SHOW_TIME   || 'November 22, 2025, 7:00 PM – 8:30 PM';
const PPTX_TEMPLATE = process.env.PPTX_TEMPLATE; // e.g., /srv/ticket_server/templates/marjan.pptx

// ---------- Firebase ----------
const saPath = process.env.FIREBASE_SA_PATH || path.join(__dirname, 'firebase-service-account.json');
let serviceAccount = null;
if (fs.existsSync(saPath)) { try { serviceAccount = require(saPath); } catch {} }
if (serviceAccount && !admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else if (!serviceAccount) {
  console.warn('⚠️ FIREBASE SERVICE ACCOUNT not found at', saPath, '— /api/verify_phone will fail.');
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
    return decoded.phone_number || null; // E.164
  } catch { return null; }
}

// ---------- PPTX → PDF (primary path) ----------
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

async function tryPptxPipeline(order) {
  if (!PPTX_TEMPLATE || !fs.existsSync(PPTX_TEMPLATE)) {
    throw new Error('PPTX template not found. Set PPTX_TEMPLATE in .env');
  }
  let createReport;
  try { ({ default: createReport } = require('pptx-templates')); }
  catch { throw new Error('pptx-templates is not installed. Run: npm i pptx-templates tmp'); }

  const url = `${PUBLIC_BASE}/validate.html?orderId=${order.orderId}`;
  const qrPng = await QRCode.toBuffer(url, { margin: 1, width: 600 });

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

// ---------- PDFKit fallback (always available once installed) ----------
async function buildPdfkitReceipt(order) {
  let PDFDocument;
  try { PDFDocument = require('pdfkit'); }
  catch { throw new Error('pdfkit is not installed. Run: npm i pdfkit'); }

  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const chunks = [];
  doc.on('data', d => chunks.push(d));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // Header
  doc.fontSize(20).text('ISA Concert Ticket Receipt', { align: 'center' }).moveDown(0.5);
  doc.fontSize(12).text(SHOW_TIME, { align: 'center' }).moveDown(1);

  // Order block
  doc.fontSize(14).text(`Order ID: ${order.orderId}`);
  doc.moveDown(0.25);
  doc.fontSize(12).text(`Seats: ${order.seats.join(', ')}`);
  doc.moveDown(0.25);
  doc.text(`Email: ${order.email}`);
  doc.moveDown(0.5);

  // QR code
  const url = `${PUBLIC_BASE}/validate.html?orderId=${order.orderId}`;
  const qrPng = await QRCode.toBuffer(url, { margin: 1, width: 220 });
  doc.image(qrPng, { fit: [220, 220], align: 'left' }).moveDown(1);

  // Note
  doc.fontSize(10).fillColor('#555').text(
    'Please arrive 15 minutes early. Bring this receipt or the QR code for validation.',
    { align: 'left' }
  );

  doc.end();
  return await done;
}

// Build a receipt PDF buffer using PPTX if possible, otherwise PDFKit
async function buildReceiptPdf(order) {
  try {
    return await tryPptxPipeline(order);
  } catch (e) {
    console.warn('⚠️ PPTX pipeline unavailable:', e.message);
    return await buildPdfkitReceipt(order);
  }
}

// ---------- API ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/health') return sendJSON(res, 200, { ok: true });

    // Seats list for UI
    if (req.url === '/api/seats' && req.method === 'GET') {
      const { rows } = await pool.query(
        "SELECT seat_id, status FROM seats " +
        "ORDER BY UPPER(REGEXP_REPLACE(seat_id,'[^A-Za-z]+.*$',''))," +
        " (REGEXP_REPLACE(seat_id,'[^0-9]','','g'))::int"
      );
      return sendJSON(res, 200, { seats: rows.map(r => ({ id: r.seat_id, status: r.status })) });
    }

    // Validate page (by order id)
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

    // Phone verify webhook — stores 10-digit phone in users
    if (req.url === '/api/verify_phone' && req.method === 'POST') {
      const body   = await parseBody(req);
      const decoded = await admin.auth().verifyIdToken(body.idToken);
      const phone   = decoded.phone_number; // E.164
      const digits  = String(phone || '').replace(/\D/g, '').slice(-10); // varchar(10)
      await pool.query(
        'INSERT INTO users (phone, verified) VALUES ($1, true) ' +
        'ON CONFLICT (phone) DO UPDATE SET verified = true',
        [digits]
      );
      return sendJSON(res, 200, { ok: true });
    }

    // Purchase (ACID + resilient email)
    if (req.url === '/api/purchase' && req.method === 'POST') {
      const phone = await getAuthedPhone(req); // E.164 like +16504185241
      if (!phone) return sendJSON(res, 401, { error: 'Unauthorized' });

      const body = await parseBody(req);
      const seats = Array.isArray(body.seats) ? body.seats.map(String) : [];
      const guests = Array.isArray(body.guests) ? body.guests : [];
      const email = String(body.email || '').trim();
      let affiliation = String(body.affiliation || 'none').toLowerCase();
      if (!['none', 'student', 'staff'].includes(affiliation)) affiliation = 'none';

      if (!email) return sendJSON(res, 400, { error: 'Missing email' });
      if (!seats.length) return sendJSON(res, 400, { error: 'No seats selected' });

      const isOrganizer = phone === ALLOWED_PHONE;
      if (!isOrganizer && seats.length > 2) {
        return sendJSON(res, 403, { error: 'You may reserve up to 2 seats online.' });
      }

      const orderId    = makeOrderId();
      const phoneDigits = String(phone).replace(/\D/g, '').slice(-10);

      // Prepare guest map (NOT NULL guest_name)
      const guestBySeat = new Map((guests || []).map(g => [String(g.seat), String(g.name || '').trim()]));

      // --------- TRANSACTION ----------
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          'INSERT INTO purchases (order_id, phone, email, affiliation) VALUES ($1,$2,$3,$4)',
          [orderId, phoneDigits, email, affiliation]
        );

        for (const sId of seats) {
          await client.query('UPDATE seats SET status = $1 WHERE seat_id = $2', ['sold', sId]);
          const gname = guestBySeat.get(sId) || 'Guest';
          await client.query(
            'INSERT INTO purchase_seats (order_id, seat_id, guest_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [orderId, sId, gname]
          );
        }

        await client.query('COMMIT');
      } catch (txErr) {
        try { await client.query('ROLLBACK'); } catch {}
        throw txErr;
      } finally {
        client.release();
      }
      // --------- END TRANSACTION ----------

      // Build receipt (Buffer) and send email AFTER COMMIT
      let email_sent = false;
      try {
        const pdfBuffer = await buildReceiptPdf({ orderId, seats, guests, email, affiliation });
        const result = await trySendEmail({
          to: email,
          subject: 'Your Concert Ticket Receipt',
          text: `Reservation confirmed.\nOrder ID: ${orderId}\nSeats: ${seats.join(', ')}\nTime: ${SHOW_TIME}`,
          attachments: [
            { filename: 'receipt.pdf', content: pdfBuffer, contentType: 'application/pdf' } // ← attach from memory
          ]
        });
        email_sent = !!result.ok;
      } catch (e) {
        console.warn('⚠️ Could not build or attach PDF:', e.message);
        // we still consider the purchase successful
      }

      return sendJSON(res, 200, { ok: true, orderId, email_sent });
    }

    // Resend receipt (ops helper)
    if (req.url.startsWith('/api/resend_receipt') && req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      const orderId = u.searchParams.get('orderId') || '';
      if (!orderId) return sendJSON(res, 400, { ok: false, error: 'Missing orderId' });

      const r = await pool.query(
        "SELECT p.order_id, p.email, array_agg(ps.seat_id ORDER BY ps.seat_id) AS seats " +
        "FROM purchases p LEFT JOIN purchase_seats ps ON ps.order_id = p.order_id " +
        "WHERE p.order_id = $1 GROUP BY p.order_id, p.email",
        [orderId]
      );
      if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'Order not found' });

      const email = r.rows[0].email;
      const seats = r.rows[0].seats || [];

      try {
        const pdfBuffer = await buildReceiptPdf({ orderId, seats, guests: [], email, affiliation: 'none' });
        const result = await trySendEmail({
          to: email,
          subject: 'Your Concert Ticket Receipt (Resent)',
          text: `Order ID: ${orderId}\nSeats: ${seats.join(', ')}\nTime: ${SHOW_TIME}`,
          attachments: [{ filename: 'receipt.pdf', content: pdfBuffer, contentType: 'application/pdf' }]
        });
        return sendJSON(res, 200, { ok: true, email_sent: !!result.ok, error: result.error || null });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // Static files
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