// server.js — Firebase Phone Auth verify + seats + PDF + reservation validation

const http = require('http');
const fs   = require('fs');
const path = require('path');

let nodemailer = null;
let PDFDocument = null;
let QRCode = null;
try { nodemailer  = require('nodemailer'); } catch {}
try { PDFDocument = require('pdfkit'); }     catch {}
try { QRCode      = require('qrcode'); }     catch {}

// ---------- Firebase Admin ----------
const admin = require('firebase-admin');
(function initFirebase(){
  try {
    const saPath = process.env.FIREBASE_SA_PATH || path.join(__dirname, 'firebase-service-account.json');
    const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log('Firebase Admin initialized');
    }
  } catch (e) {
    console.error('Firebase Admin init failed:', e?.message || e);
  }
})();

// ---------- Paths & constants ----------
const DATA_DIR     = process.env.DATA_DIR || __dirname;
const USERS_FILE   = path.join(DATA_DIR, 'users.json');
const SEATS_FILE   = path.join(DATA_DIR, 'seats.json');
const EMAILS_DIR   = path.join(DATA_DIR, 'emails');
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
const LOGO_PATH    = path.join(DATA_DIR, 'logo.png');

const PUBLIC_BASE  = (process.env.PUBLIC_BASE_URL || 'https://isaconcertticket.com').replace(/\/+$/,'');
const SHOW_TIME    = 'November 22, 2025, 7:00 PM – 8:30 PM';

if (!fs.existsSync(EMAILS_DIR))   fs.mkdirSync(EMAILS_DIR,   { recursive: true });
if (!fs.existsSync(RECEIPTS_DIR)) fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

function readJSON(file, fallback){ try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJSON(file, obj){ fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

// ---------- Seats seed ----------
function generateInitialSeats() {
  const seats = []; const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i=0;i<10;i++){ const row = alphabet[i]; for (let j=1;j<=25;j++){ seats.push({ id:`${row}${j}`, row, number:j, status:'available' }); } }
  return seats;
}
function loadSeats(){
  let seats = readJSON(SEATS_FILE, []);
  if (!Array.isArray(seats) || seats.length===0) { seats = generateInitialSeats(); writeJSON(SEATS_FILE, seats); }
  return seats;
}
if (!fs.existsSync(SEATS_FILE)) writeJSON(SEATS_FILE, generateInitialSeats());
if (!fs.existsSync(USERS_FILE)) writeJSON(USERS_FILE, []);

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
  const safeSubject = subject.replace(/[^\w.-]+/g,'_').slice(0,80);
  const safeTo = (to||'unknown').replace(/[^\w@.-]+/g,'_');
  const fname = path.join(EMAILS_DIR, `${Date.now()}_${safeSubject}_${safeTo}.txt`);
  const attachLines = attachments.map(a=>`ATTACHMENT: ${a.filename} (${a.path||a.cid||'inline'})`).join('\n');
  fs.writeFileSync(fname, body + (attachLines?`\n\n${attachLines}\n`:''));
}

// ---------- PDF (with QR that opens /validate.html?orderId=...) ----------
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

  // QR that opens the public validation page
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

// ---------- Auth helper ----------
async function verifyIdTokenFromRequest(req){
  const authz = req.headers['authorization'] || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : null;
  if (!token) return null;
  try { return await admin.auth().verifyIdToken(token); }
  catch(e){ console.error('verifyIdToken error:', e?.message || e); return null; }
}

// ---------- API ----------
async function handleAPI(req, res){
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  const pathN = (pathname || '/').replace(/\/+$/, '') || '/';
  console.log(new Date().toISOString(), req.method, pathN);

  if (req.method === 'OPTIONS') return sendJSON(res, 204, { ok: true });

  if (req.method === 'GET' && pathN === '/api/health') {
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathN === '/api/seats') {
    const raw = loadSeats();
    const seats = raw.map(({ id, row, number, status }) => ({ id, row, number, status }));
    return sendJSON(res, 200, { seats });
  }

  if (req.method === 'POST' && pathN === '/api/login_phone') {
    return sendJSON(res, 200, { ok:true, provider:'firebase', message:'Use client Firebase to send/verify code' });
  }

  if (req.method === 'POST' && pathN === '/api/verify_phone') {
    const body = await parseBody(req);
    const idToken = body.idToken || null;
    if (!idToken) return sendJSON(res, 400, { error:'idToken required' });

    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      const phone = (decoded.phone_number || '').replace(/\D/g,'').slice(-10);
      if (phone.length !== 10) return sendJSON(res, 400, { error:'No phone in token' });

      const users = readJSON(USERS_FILE, []);
      let user = users.find(u=>u.phone===phone);
      if(!user){ user = { phone, verified:true, purchases:[] }; users.push(user); }
      else { user.verified = true; }
      writeJSON(USERS_FILE, users);

      console.log('verify_phone OK for', phone);
      return sendJSON(res, 200, { ok:true, phone });
    } catch (e) {
      console.error('verify_phone error:', e?.message || e);
      return sendJSON(res, 401, { error:'Invalid token' });
    }
  }

  if (req.method === 'POST' && pathN === '/api/purchase') {
    const decoded = await verifyIdTokenFromRequest(req);
    if (!decoded) return sendJSON(res, 401, { error:'Unauthorized' });

    const phone = (decoded.phone_number || '').replace(/\D/g,'').slice(-10);
    if (phone.length !== 10) return sendJSON(res, 400, { error:'No phone in token' });

    const { email, affiliation, seats: seatIds, guests } = await parseBody(req);
    if(!Array.isArray(seatIds) || seatIds.length===0) return sendJSON(res, 400, { error:'Seats required' });

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email||''));
    if(!emailOk) return sendJSON(res, 400, { error:'Valid receipt email required' });
    const aff = String(affiliation||'none').toLowerCase();
    if(['student','staff'].includes(aff) && !/@(uark|uada)\.edu$/i.test(String(email||''))) {
      return sendJSON(res, 400, { error:'Students/Staff must use @uark.edu or @uada.edu' });
    }

    const users = readJSON(USERS_FILE, []);
    const user = users.find(u=>u.phone===phone && u.verified);
    if(!user) return sendJSON(res, 403, { error:'Phone not verified' });

    const seats = loadSeats();
    const already = Array.isArray(user.purchases) ? user.purchases.reduce((n,p)=> n + (Array.isArray(p.seats)?p.seats.length:0), 0) : 0;
    if (already + seatIds.length > 2) return sendJSON(res, 400, { error:`Seat limit exceeded. You already reserved ${already} seat(s). Max is 2.` });

    const bad = []; seatIds.forEach(id=>{ const s=seats.find(se=>se.id===id); if(!s || s.status!=='available') bad.push(id); });
    if (bad.length) return sendJSON(res, 409, { error:`Seats unavailable: ${bad.join(', ')}` });

    seatIds.forEach(id=>{ const s=seats.find(se=>se.id===id); if(s) s.status='sold'; });
    writeJSON(SEATS_FILE, seats);

    const orderId = `R${Date.now()}${Math.floor(Math.random()*1000)}`;
    const purchase = { seats: seatIds, guests: Array.isArray(guests)?guests:[], orderId, timestamp: Date.now(), email, affiliation: aff };
    if(!Array.isArray(user.purchases)) user.purchases=[];
    user.purchases.push(purchase); writeJSON(USERS_FILE, users);

    const { filePath, mime, filename } = await createReceiptPDF({
      orderId, email, seats: seatIds, guests: purchase.guests, reservationTime: purchase.timestamp
    });

    const guestLines = (purchase.guests||[]).map((g,i)=>`${i+1}. ${g.name} — ${g.seat}`).join('\n') || '(No guest names provided)';
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

  // NEW: validate reservation by orderId (for QR link)
  if (req.method === 'GET' && pathN === '/api/validate') {
    const orderId = (searchParams.get('orderId') || '').trim();
    if (!orderId) return sendJSON(res, 400, { ok:false, error:'orderId required' });

    const users = readJSON(USERS_FILE, []);
    for (const u of users) {
      const p = (u.purchases||[]).find(x => x.orderId === orderId);
      if (p) {
        return sendJSON(res, 200, {
          ok:true,
          orderId,
          seats: p.seats,
          guests: p.guests,
          phone: u.phone,
          timestamp: p.timestamp
        });
      }
    }
    return sendJSON(res, 404, { ok:false, error:'Reservation not found' });
  }

  return sendApiNotFound(res);
}

function requestHandler(req,res){
  if(req.url.startsWith('/api/')) handleAPI(req,res).catch(err=>{ console.error(err); sendJSON(res, 500, { error:'Internal server error' }); });
  else serveStatic(req,res);
}

const PORT = process.env.PORT || 3000;
http.createServer(requestHandler).listen(PORT, ()=> console.log(`Server listening on port ${PORT}`) );