// server.js — Postgres-backed API + Firebase phone verify + PDF/QR receipt + validate

const http = require('http');
const fs   = require('fs');
const path = require('path');

const { Pool } = require('pg');
let nodemailer = null, PDFDocument = null, QRCode = null;
try { nodemailer  = require('nodemailer'); } catch {}
try { PDFDocument = require('pdfkit'); }     catch {}
try { QRCode      = require('qrcode'); }     catch {}

// ---------- Firebase Admin ----------
const admin = require('firebase-admin');
(function initFirebase(){
  try {
    const saPath = process.env.FIREBASE_SA_PATH || path.join(__dirname, 'firebase-service-account.json');
    const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('Firebase Admin initialized');
  } catch (e) {
    console.error('Firebase Admin init failed:', e?.message || e);
  }
})();

// ---------- Postgres ----------
const useDb = String(process.env.USE_DB || '').toLowerCase() === 'postgres';
if (!useDb) {
  console.error('USE_DB is not set to "postgres". Set it in .env.');
  process.exit(1);
}
const pool = new Pool(); // Reads PG* env vars

// ---------- Paths & constants ----------
const DATA_DIR     = process.env.DATA_DIR || __dirname;
const EMAILS_DIR   = path.join(DATA_DIR, 'emails');
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
const LOGO_PATH    = path.join(DATA_DIR, 'logo.png');

const PUBLIC_BASE  = (process.env.PUBLIC_BASE || 'https://isaconcertticket.com').replace(/\/+$/,'');
const SHOW_TIME    = 'November 22, 2025, 7:00 PM – 8:30 PM';

if (!fs.existsSync(EMAILS_DIR))   fs.mkdirSync(EMAILS_DIR,   { recursive: true });
if (!fs.existsSync(RECEIPTS_DIR)) fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

// ---------- HTTP helpers ----------
function sendJSON(res, code, obj){
  res.writeHead(code, {
    'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type,Authorization'
  });
  res.end(JSON.stringify(obj));
}
function sendApiNotFound(res){ sendJSON(res, 404, { error:'Not found' }); }
function sendPlainNotFound(res){ res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('Not found'); }

function serveStatic(req,res){
  const url = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, url.split('?')[0]);
  if (!filePath.startsWith(__dirname)) return sendPlainNotFound(res);
  fs.readFile(filePath, (err, data)=>{
    if(err){ return sendPlainNotFound(res); }
    const ext = path.extname(filePath).toLowerCase();
    const type = ext==='.html'?'text/html; charset=utf-8'
              : ext==='.css' ?'text/css; charset=utf-8'
              : ext==='.js'  ?'application/javascript; charset=utf-8'
              : ext==='.png' ?'image/png'
              : ext==='.gif' ?'image/gif'
              : 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type}); res.end(data);
  });
}

function parseBody(req){
  return new Promise((resolve)=>{ let data=''; req.on('data', c=> data+=c); req.on('end', ()=>{ try{ resolve(JSON.parse(data||'{}')); }catch{ resolve({}); } }); });
}

async function verifyIdTokenFromRequest(req){
  const authz = req.headers['authorization'] || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : null;
  if (!token) return null;
  try { return await admin.auth().verifyIdToken(token); }
  catch(e){ console.error('verifyIdToken error:', e?.message || e); return null; }
}

// ---------- Email ----------
async function sendEmail(to, subject, text, attachments = []){
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  const body = text + `\n\n(If you did not request this, ignore.)`;

  if(nodemailer && SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS){
    try{
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST, port: Number(SMTP_PORT),
        secure: String(SMTP_SECURE||'false')==='true',
        auth: { user: SMTP_USER, pass: SMTP_PASS }
      });
      await transporter.verify().catch(()=>{});
      await transporter.sendMail({ from: SMTP_USER, to, subject, text: body, attachments });
      return;
    }catch(e){ console.error('SMTP send failed:', e?.message || e); }
  }
  // Fallback: write to /emails dir
  const safeSubject = subject.replace(/[^\w.-]+/g,'_').slice(0,80);
  const safeTo = (to||'unknown').replace(/[^\w@.-]+/g,'_');
  const fname = path.join(EMAILS_DIR, `${Date.now()}_${safeSubject}_${safeTo}.txt`);
  const attachLines = attachments.map(a=>`ATTACHMENT: ${a.filename} (${a.path||a.cid||'inline'})`).join('\n');
  fs.writeFileSync(fname, body + (attachLines?`\n\n${attachLines}\n`:''));
}

// ---------- PDF (with QR → /validate.html?orderId=...) ----------
async function createReceiptPDF({ orderId, email, seats, guests, reservationTime }){
  if (!PDFDocument || !QRCode) {
    const fallback = path.join(RECEIPTS_DIR, `ticket_receipt_${orderId}.txt`);
    const guestLines = (guests||[]).map((g,i)=>`${i+1}. ${g.name} — ${g.seat}`).join('\n') || '(No guest names provided)';
    const txt = [
      'Ticket Receipt',
      `Order ID: ${orderId}`,
      `Email: ${email}`,
      `Show Time: ${SHOW_TIME}`,
      `Reserved At: ${new Date(reservationTime).toLocaleString()}`,
      `Seats: ${seats.join(', ')}`,
      `Guests:\n${guestLines}`,
      'All tickets are free.',
      'Please arrive 15 minutes early.'
    ].join('\n');
    fs.writeFileSync(fallback, txt);
    return { filePath: fallback, mime:'text/plain', filename: path.basename(fallback) };
  }

  const filePath = path.join(RECEIPTS_DIR, `ticket_receipt_${orderId}.pdf`);
  const doc = new (require('pdfkit'))({ size:'A4', margin:50 });
  const stream = fs.createWriteStream(filePath); doc.pipe(stream);

  if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, 50, 50, { width: 80 }); } catch {} }
  doc.fontSize(20).text('Free Ticket Reservation Receipt', 150, 60);
  doc.fontSize(11)
     .text(`Reservation #: ${orderId}`, 150, 90)
     .text(`Email: ${email}`, 150, 106)
     .text(`Show Time: ${SHOW_TIME}`, 150, 122)
     .text(`Reserved At: ${new Date(reservationTime).toLocaleString()}`, 150, 138);

  doc.moveTo(50, 160).lineTo(545, 160).strokeColor('#aaaaaa').stroke();
  doc.fontSize(13).fillColor('#000').text('Seats & Guests:', 50, 170);
  let y = 190;
  const guestList = Array.isArray(guests)?guests:[];
  if (guestList.length){ guestList.forEach((g,i)=>{ doc.text(`${i+1}. ${g.name} — Seat ${g.seat}`, 60, y); y+=16; }); }
  else { doc.text(`Seats: ${seats.join(', ')}`, 60, y); y+=16; }

  const validateURL = `${PUBLIC_BASE}/validate.html?orderId=${encodeURIComponent(orderId)}`;
  try{
    const qrBuffer = await QRCode.toBuffer(validateURL, { type:'png', margin:1, scale:6 });
    doc.image(qrBuffer, 450, 60, { fit:[100,100] });
    doc.fontSize(9).fillColor('#444').text('Scan to validate', 450, 165);
    doc.fillColor('#1f2937').text(validateURL, 50, y + 8, { link: validateURL, underline: true });
  }catch{}

  doc.fontSize(10).fillColor('#444').text('All tickets are free. Please arrive 15 minutes early.', 50, 780);
  doc.end();
  await new Promise((resolve,reject)=>{ stream.on('finish', resolve); stream.on('error', reject); });

  return { filePath, mime:'application/pdf', filename: path.basename(filePath) };
}

// ---------- DB helpers ----------
async function dbGetSeats() {
  const { rows } = await pool.query(
    'SELECT seat_id AS id, seat_row AS row, seat_number AS number, status FROM seats ORDER BY seat_row, seat_number'
  );
  return rows;
}

async function dbVerifyPhone(phone10) {
  await pool.query(
    'INSERT INTO users(phone,verified) VALUES($1,TRUE) ON CONFLICT (phone) DO UPDATE SET verified=EXCLUDED.verified',
    [phone10]
  );
}

async function dbSeatCountForUser(phone10) {
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(x.cnt),0)::int AS total
    FROM (
      SELECT COUNT(*) AS cnt
      FROM purchases p
      JOIN purchase_seats ps USING(order_id)
      WHERE p.phone = $1
    ) x
  `,[phone10]);
  return rows[0].total;
}

async function dbReserveSeats({ phone10, email, affiliation, seatIds, guests }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Seat availability
    const { rows: bad } = await client.query(
      'SELECT seat_id FROM seats WHERE seat_id = ANY($1) AND status <> $2',
      [seatIds, 'available']
    );
    if (bad.length) throw new Error(`Seats unavailable: ${bad.map(r=>r.seat_id).join(', ')}`);

    // Insert purchase
    const orderId = `R${Date.now()}${Math.floor(Math.random()*1000)}`;
    await client.query(
      'INSERT INTO purchases(order_id, phone, email, affiliation) VALUES($1,$2,$3,$4)',
      [orderId, phone10, email, affiliation]
    );

    for (const s of seatIds) {
      const g = (guests || []).find(x => x.seat === s)?.name || '';
      await client.query('INSERT INTO purchase_seats(order_id, seat_id, guest_name) VALUES($1,$2,$3)', [orderId, s, g]);
      await client.query('UPDATE seats SET status = $2 WHERE seat_id = $1', [s, 'sold']);
    }

    await client.query('COMMIT');
    return orderId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------- API ----------
async function handleAPI(req, res){
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  const pathN = (pathname || '/').replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') return sendJSON(res, 204, { ok: true });

  if (req.method === 'GET' && pathN === '/api/health') {
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathN === '/api/seats') {
    const seats = await dbGetSeats();
    return sendJSON(res, 200, { seats });
  }

  if (req.method === 'POST' && pathN === '/api/login_phone') {
    // Kept for client compatibility (Firebase sends SMS on the client)
    return sendJSON(res, 200, { ok:true, provider:'firebase' });
  }

  if (req.method === 'POST' && pathN === '/api/verify_phone') {
    const body = await parseBody(req);
    const idToken = body.idToken || null;
    if (!idToken) return sendJSON(res, 400, { error:'idToken required' });

    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      const phone10 = String(decoded.phone_number || '').replace(/\D/g,'').slice(-10);
      if (phone10.length !== 10) return sendJSON(res, 400, { error:'No phone in token' });
      await dbVerifyPhone(phone10);
      return sendJSON(res, 200, { ok:true, phone: phone10 });
    } catch (e) {
      console.error('verify_phone error:', e?.message || e);
      return sendJSON(res, 401, { error:'Invalid token' });
    }
  }

  if (req.method === 'POST' && pathN === '/api/purchase') {
    const decoded = await verifyIdTokenFromRequest(req);
    if (!decoded) return sendJSON(res, 401, { error:'Unauthorized' });

    const phone10 = String(decoded.phone_number || '').replace(/\D/g,'').slice(-10);
    if (phone10.length !== 10) return sendJSON(res, 400, { error:'No phone in token' });

    const { email, affiliation, seats: seatIds, guests } = await parseBody(req);
    if(!Array.isArray(seatIds) || seatIds.length===0) return sendJSON(res, 400, { error:'Seats required' });

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email||''));
    if(!emailOk) return sendJSON(res, 400, { error:'Valid receipt email required' });
    const aff = String(affiliation||'none').toLowerCase();
    if(['student','staff'].includes(aff) && !/@(uark|uada)\.edu$/i.test(String(email||''))) {
      return sendJSON(res, 400, { error:'Students/Staff must use @uark.edu or @uada.edu' });
    }

    const already = await dbSeatCountForUser(phone10);
    if (already + seatIds.length > 2) return sendJSON(res, 400, { error:`Seat limit exceeded. You already reserved ${already} seat(s). Max is 2.` });

    let orderId;
    try {
      orderId = await dbReserveSeats({ phone10, email, affiliation: aff, seatIds, guests });
    } catch (e) {
      return sendJSON(res, 409, { error: e.message || 'Seats unavailable' });
    }

    // Email receipt (PDF with QR to /validate.html?orderId=...)
    const { filePath, mime, filename } = await createReceiptPDF({
      orderId, email, seats: seatIds, guests: guests || [], reservationTime: Date.now()
    });

    const guestLines = (guests||[]).map((g,i)=>`${i+1}. ${g.name} — ${g.seat}`).join('\n') || '(No guest names provided)';
    const text = `Thanks! Your seats: ${seatIds.join(', ')}
Guests:
${guestLines}
All tickets are free.
Reservation #: ${orderId}
Show: ${SHOW_TIME}
Please arrive 15 minutes early.`;

    await sendEmail(email, 'Your Seat Reservation (PDF Attached)', text, [{ filename, path: filePath, contentType: mime }]);
    return sendJSON(res, 200, { ok:true, orderId });
  }

  // Validate reservation (QR target)
  if (req.method === 'GET' && pathN === '/api/validate') {
    const orderId = (searchParams.get('orderId') || '').trim();
    if (!orderId) return sendJSON(res, 400, { ok:false, error:'orderId required' });

    const { rows } = await pool.query(`
      SELECT p.order_id, p.phone, p.email, p.affiliation, p.reserved_at,
             array_agg(ps.seat_id ORDER BY ps.seat_id)    AS seats,
             array_agg(ps.guest_name ORDER BY ps.seat_id) AS guests
      FROM purchases p
      LEFT JOIN purchase_seats ps USING(order_id)
      WHERE p.order_id = $1
      GROUP BY p.order_id, p.phone, p.email, p.affiliation, p.reserved_at
    `,[orderId]);

    if (!rows.length) return sendJSON(res, 404, { ok:false, error:'Reservation not found' });
    const row = rows[0];
    return sendJSON(res, 200, {
      ok:true,
      orderId: row.order_id,
      seats: row.seats,
      guests: (row.guests || []).map((name, i) => ({ name, seat: row.seats[i] })),
      phone: row.phone,
      timestamp: row.reserved_at
    });
  }

  return sendApiNotFound(res);
}

const server = http.createServer((req,res)=>{
  if(req.url.startsWith('/api/')) handleAPI(req,res).catch(err=>{ console.error(err); sendJSON(res, 500, { error:'Internal server error' }); });
  else serveStatic(req,res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log(`Server listening on ${PORT}`) );