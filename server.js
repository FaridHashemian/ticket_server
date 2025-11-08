// server.js — Final integrated version for ISA Concert Ticket system
// Includes SendGrid SMTP sender + Firebase phone auth + PDF receipt with QR

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const admin = require('firebase-admin');

// ---------- Firebase ----------
const serviceAccount = require(path.join(__dirname, 'firebase-service-account.json'));
if (!admin.apps.length)
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ---------- PostgreSQL ----------
const pool = new Pool(); // Uses PG env vars

// ---------- Constants ----------
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');
const PUBLIC_BASE = 'https://isaconcertticket.com';
const SHOW_TIME = 'November 22, 2025, 7:00 PM – 8:30 PM';

// ---------- Email ----------
async function sendEmail(to, subject, text, attachments = []) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    requireTLS: true,
    auth: {
      user: process.env.SMTP_USER || 'apikey',
      pass: process.env.SMTP_PASS
    }
  });

  const from = {
    name: process.env.FROM_NAME || 'ISA Concert Tickets',
    address: process.env.FROM_EMAIL || 'no-reply@isaconcertticket.com'
  };

  await transporter.sendMail({ from, to, subject, text, attachments });
  console.log(`✅ Email sent to ${to}`);
}

// ---------- PDF Receipt ----------
async function createReceiptPDF(order) {
  const filePath = path.join(__dirname, `receipts/receipt_${order.orderId}.pdf`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, 50, 50, { width: 80 });

  doc.fontSize(22).text('Concert Ticket Receipt', 150, 50);
  doc.fontSize(11).text(`Order #: ${order.orderId}`);
  doc.text(`Email: ${order.email}`);
  doc.text(`Show Time: ${SHOW_TIME}`);
  doc.text(`Seats: ${order.seats.join(', ')}`);
  doc.text(`Guests: ${(order.guests || []).map(g => `${g.name} (${g.seat})`).join(', ')}`);
  doc.moveDown();
  doc.text('Please arrive 15 minutes early.');

  const url = `${PUBLIC_BASE}/validate.html?orderId=${order.orderId}`;
  const qr = await QRCode.toBuffer(url);
  doc.image(qr, 400, 50, { width: 100 });
  doc.fontSize(9).text(url, 50, 700, { link: url, underline: true });
  doc.end();

  await new Promise(r => stream.on('finish', r));
  return filePath;
}

// ---------- Utilities ----------
function parseBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- API ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/health') return sendJSON(res, 200, { ok: true });

    if (req.url === '/api/seats' && req.method === 'GET') {
      const { rows } = await pool.query('SELECT * FROM seats ORDER BY seat_id');
      return sendJSON(res, 200, { seats: rows });
    }

    if (req.url === '/api/verify_phone' && req.method === 'POST') {
      const body = await parseBody(req);
      const decoded = await admin.auth().verifyIdToken(body.idToken);
      const phone = decoded.phone_number;
      await pool.query('INSERT INTO users (phone, verified) VALUES ($1, true) ON CONFLICT DO NOTHING', [phone]);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.url === '/api/purchase' && req.method === 'POST') {
      const body = await parseBody(req);
      const decoded = await admin.auth().verifyIdToken(req.headers.authorization?.split(' ')[1]);
      const phone = decoded.phone_number;

      const orderId = 'R' + Date.now();
      const seats = body.seats || [];
      const guests = body.guests || [];
      const email = body.email;
      await pool.query('INSERT INTO purchases (order_id, phone, email) VALUES ($1,$2,$3)', [orderId, phone, email]);
      for (const s of seats)
        await pool.query('UPDATE seats SET status=$1 WHERE seat_id=$2', ['sold', s]);

      const pdfPath = await createReceiptPDF({ orderId, seats, guests, email });
      await sendEmail(email, 'Your Concert Ticket Receipt', `Reservation confirmed.\nOrder ID: ${orderId}`, [
        { filename: 'receipt.pdf', path: pdfPath }
      ]);
      return sendJSON(res, 200, { ok: true, orderId });
    }

    // Serve static
    if (req.url === '/' || req.url.endsWith('.html') || req.url.endsWith('.css') || req.url.endsWith('.js')) {
      const fp = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
      const data = fs.readFileSync(fp);
      const ext = path.extname(fp);
      const type =
        ext === '.html'
          ? 'text/html'
          : ext === '.css'
          ? 'text/css'
          : 'application/javascript';
      res.writeHead(200, { 'Content-Type': type });
      return res.end(data);
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(process.env.PORT || 3000, () => console.log('✅ Server running on port 3000'));