// ISA Ticket Server — ACID purchases + SendGrid + PPTX->PDF receipts (Docxtemplater)
// 3-column table template: static ID (1,2) | Guest Name | Seat
// All white text formatting handled inside the PPTX.

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const { spawn } = require('child_process');
const tmp = require('tmp');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

// ---------- Config ----------
const ALLOWED_PHONE = process.env.ALLOWED_PHONE || '+16504185241';
const PUBLIC_BASE   = process.env.PUBLIC_BASE || 'https://isaconcertticket.com';
const SHOW_TIME     = process.env.SHOW_TIME   || 'November 22, 2025, 7:00 PM – 8:30 PM';
const PPTX_TEMPLATE = process.env.PPTX_TEMPLATE || path.join(__dirname, 'templates', 'marjan.pptx');

// ---------- Firebase ----------
const saPath = process.env.FIREBASE_SA_PATH || path.join(__dirname, 'firebase-service-account.json');
let serviceAccount = null;
if (fs.existsSync(saPath)) { try { serviceAccount = require(saPath); } catch {} }
if (serviceAccount && !admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else if (!serviceAccount) {
  console.warn('⚠️ FIREBASE SERVICE ACCOUNT not found — phone verification will fail.');
}

// ---------- PostgreSQL ----------
const pool = new Pool();

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
    console.log(`✅ Email accepted: ${info && info.messageId}`);
    return { ok: true };
  } catch (e) {
    console.warn('⚠️ Email send failed:', e.message);
    return { ok: false, error: e.message };
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

// ---------- PPTX->PDF ----------
function renderPptxFromTemplate(bindings) {
  const content = fs.readFileSync(PPTX_TEMPLATE);
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.setData(bindings);
  doc.render();
  return doc.getZip().generate({ type: 'nodebuffer' });
}
async function convertPptxToPdfBuffer(pptxBuffer) {
  const tmpPptx = tmp.fileSync({ postfix: '.pptx' }).name;
  fs.writeFileSync(tmpPptx, pptxBuffer);
  return new Promise((resolve, reject) => {
    const outdir = tmp.dirSync({ unsafeCleanup: true }).name;
    const soffice = spawn('soffice', [
      '--headless','--nologo','--convert-to','pdf','--outdir',outdir,tmpPptx
    ]);
    let stderr = '';
    soffice.stderr.on('data', d => (stderr += d.toString()));
    soffice.on('close', code => {
      if (code !== 0) return reject(new Error(`LibreOffice failed: ${stderr}`));
      const pdfPath = path.join(outdir, path.basename(tmpPptx, '.pptx') + '.pdf');
      resolve(fs.readFileSync(pdfPath));
    });
  });
}
async function buildReceiptPdfFromTemplate(order) {
  const qrUrl = `${PUBLIC_BASE}/validate.html?orderId=${order.orderId}`;
  const guests = (order.guests && order.guests.length)
    ? order.guests.map(g => ({ name: g.name || 'Guest', seat: g.seat || '' }))
    : [{ name: order.email, seat: order.seats?.[0] || '' }];

  const bindings = {
    reservationNumber: order.orderId,
    reservationTime: SHOW_TIME,
    qrUrl,
    guests
  };
  const filledPptxBuf = renderPptxFromTemplate(bindings);
  return await convertPptxToPdfBuffer(filledPptxBuf);
}

// ---------- API ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/health') return sendJSON(res, 200, { ok: true });

    // Seats
    if (req.url === '/api/seats' && req.method === 'GET') {
      const { rows } = await pool.query(
        "SELECT seat_id, status FROM seats ORDER BY UPPER(REGEXP_REPLACE(seat_id,'[^A-Za-z]+.*$','')), (REGEXP_REPLACE(seat_id,'[^0-9]','','g'))::int"
      );
      return sendJSON(res, 200, { seats: rows.map(r => ({ id: r.seat_id, status: r.status })) });
    }

    // Validate
    if (req.url.startsWith('/api/validate') && req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      const orderId = u.searchParams.get('orderId');
      const r = await pool.query(
        "SELECT ps.seat_id, ps.guest_name FROM purchase_seats ps WHERE ps.order_id=$1",[orderId]
      );
      const guests = r.rows.map(x => ({ name: x.guest_name, seat: x.seat_id }));
      return sendJSON(res, 200, { ok: true, orderId, guests });
    }

    // Purchase
    if (req.url === '/api/purchase' && req.method === 'POST') {
      const phone = await getAuthedPhone(req);
      if (!phone) return sendJSON(res, 401, { error: 'Unauthorized' });

      const body = await parseBody(req);
      const seats = Array.isArray(body.seats) ? body.seats.map(String) : [];
      const guests = Array.isArray(body.guests) ? body.guests : [];
      const email = String(body.email || '').trim();

      if (!email || !seats.length)
        return sendJSON(res, 400, { error: 'Missing email or seats' });

      const orderId = makeOrderId();
      const phoneDigits = String(phone).replace(/\D/g, '').slice(-10);
      const guestBySeat = new Map((guests || []).map(g => [String(g.seat), String(g.name || '').trim()]));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO purchases (order_id, phone, email) VALUES ($1,$2,$3)', [orderId, phoneDigits, email]
        );
        for (const sId of seats) {
          await client.query('UPDATE seats SET status=$1 WHERE seat_id=$2',['sold',sId]);
          const gname = guestBySeat.get(sId) || 'Guest';
          await client.query(
            'INSERT INTO purchase_seats (order_id, seat_id, guest_name) VALUES ($1,$2,$3)', [orderId,sId,gname]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK'); throw e;
      } finally { client.release(); }

      // Build receipt + send email
      let email_sent = false;
      try {
        const pdfBuffer = await buildReceiptPdfFromTemplate({ orderId, seats, guests, email });
        const result = await trySendEmail({
          to: email,
          subject: 'Your Concert Ticket Receipt',
          text: `Order ${orderId} confirmed for ${SHOW_TIME}`,
          attachments: [{ filename: 'receipt.pdf', content: pdfBuffer, contentType: 'application/pdf' }]
        });
        email_sent = result.ok;
      } catch (e) { console.warn('⚠️ PDF/email error:', e.message); }

      return sendJSON(res, 200, { ok: true, orderId, email_sent });
    }

    // Static files
    if (req.url === '/' || /\.(html|css|js)$/.test(req.url)) {
      const fp = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
      if (!fs.existsSync(fp)) return sendJSON(res, 404, { error: 'File not found' });
      const ext = path.extname(fp);
      const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'application/javascript';
      res.writeHead(200, { 'Content-Type': type });
      return res.end(fs.readFileSync(fp));
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