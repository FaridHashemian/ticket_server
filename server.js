// Backend for isaconcertticket.com
// - Free tickets, max 2 seats per email (across all purchases)
// - Collects first, last, phone, affiliation
// - Requires @uark.edu OR @uada.edu if affiliation is student/staff
// - Auto-reseeds seats if seats.json is empty/invalid
// - Sends email via SMTP (if configured) or writes a file to emails/ as fallback
// - Login also emails a verification code
// - Purchase accepts guest names, creates a server-side PDF receipt with QR+logo,
//   saves it under receipts/, and ATTACHES it to the confirmation email.

const http = require('http');
const fs = require('fs');
const path = require('path');

let nodemailer = null;
let PDFDocument = null;
let QRCode = null;
try { nodemailer = require('nodemailer'); } catch {}
try { PDFDocument = require('pdfkit'); } catch {}
try { QRCode = require('qrcode'); } catch {}

const DATA_DIR     = process.env.DATA_DIR || __dirname;
const USERS_FILE   = path.join(DATA_DIR, 'users.json');
const SEATS_FILE   = path.join(DATA_DIR, 'seats.json');
const EMAILS_DIR   = path.join(DATA_DIR, 'emails');
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
const LOGO_PATH    = path.join(DATA_DIR, 'logo.png'); // make sure this file exists

if (!fs.existsSync(EMAILS_DIR))   fs.mkdirSync(EMAILS_DIR,   { recursive: true });
if (!fs.existsSync(RECEIPTS_DIR)) fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

// ---------- helpers ----------
function readJSON(file, fallback){ try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJSON(file, obj){ fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

// 250 seats: 10 rows (A–J) × 25 seats (1–25)
function generateInitialSeats(){
  const seats = []; const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for(let i=0;i<10;i++){ const row = alphabet[i]; for(let j=1;j<=25;j++){ seats.push({ id:`${row}${j}`, row, number:j, status:'available' }); } }
  return seats;
}
// Robust loader: if seats invalid or empty -> reseed
function loadSeats(){
  let seats = readJSON(SEATS_FILE, []);
  if (!Array.isArray(seats) || seats.length === 0) { seats = generateInitialSeats(); writeJSON(SEATS_FILE, seats); }
  return seats;
}
// one-time seed if files missing
if (!fs.existsSync(SEATS_FILE)) writeJSON(SEATS_FILE, generateInitialSeats());
if (!fs.existsSync(USERS_FILE)) writeJSON(USERS_FILE, []);

// send JSON / CORS
function sendJSON(res, code, obj){
  res.writeHead(code, {
    'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type'
  });
  res.end(JSON.stringify(obj));
}
function sendApiNotFound(res){ sendJSON(res, 404, { error: 'Not found' }); }

function serveStatic(req, res){
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
              : 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type});
    res.end(data);
  });
}
function sendPlainNotFound(res){ res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('Not found'); }

function parseBody(req){
  return new Promise((resolve)=>{
    let data=''; req.on('data', chunk=> data+=chunk);
    req.on('end', ()=>{ try{ resolve(JSON.parse(data||'{}')); } catch{ resolve({}); } });
  });
}

// ---------- email (with optional attachments) ----------
async function sendEmail(to, subject, text, attachments = []){
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  const body = text + `\n\n(If you did not request this, ignore.)`;

  if(nodemailer && SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS){
    try{
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST, port: Number(SMTP_PORT),
        secure: String(SMTP_SECURE||'false') === 'true',
        auth: { user: SMTP_USER, pass: SMTP_PASS }
      });
      await transporter.verify().catch(()=>{});
      await transporter.sendMail({
        from: SMTP_USER, to, subject, text: body,
        attachments
      });
      return;
    }catch(e){ console.error('SMTP send failed:', e && e.message ? e.message : e); }
  }

  // fallback: write the “email” and list attachments
  const safeSubject = subject.replace(/[^\w.-]+/g,'_').slice(0,80);
  const safeTo = (to||'unknown').replace(/[^\w@.-]+/g,'_');
  const fname = path.join(EMAILS_DIR, `${Date.now()}_${safeSubject}_${safeTo}.txt`);
  const attachLines = attachments.map(a=>`ATTACHMENT: ${a.filename} (${a.path||a.cid||'inline'})`).join('\n');
  fs.writeFileSync(fname, body + (attachLines?`\n\n${attachLines}\n`:''));
}

// ---------- PDF receipt generation ----------
async function createReceiptPDF({ orderId, email, seats, guests, showTime, reservationTime }){
  // If pdfkit or qrcode not installed, write a simple text receipt instead
  if (!PDFDocument || !QRCode) {
    const fallback = path.join(RECEIPTS_DIR, `ticket_receipt_${orderId}.txt`);
    const guestLines = (Array.isArray(guests)?guests:[]).map((g,i)=>`${i+1}. ${g.name} — ${g.seat}`).join('\n') || '(No guest names provided)';
    const txt = [
      'Ticket Receipt',
      `Order ID: ${orderId}`,
      `Email: ${email}`,
      `Show Time: ${showTime}`,
      `Reserved At: ${new Date(reservationTime).toLocaleString()}`,
      `Seats: ${seats.join(', ')}`,
      `Guests:\n${guestLines}`,
      'All tickets are free.'
    ].join('\n');
    fs.writeFileSync(fallback, txt);
    return { filePath: fallback, mime: 'text/plain', filename: path.basename(fallback) };
  }

  const filePath = path.join(RECEIPTS_DIR, `ticket_receipt_${orderId}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Header with logo
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, 50, 50, { width: 80 }); } catch {}
  }
  doc.fontSize(20).text('Free Ticket Reservation Receipt', 150, 60);
  doc.fontSize(11)
     .text(`Order ID: ${orderId}`, 150, 90)
     .text(`Email: ${email}`, 150, 106)
     .text(`Show Time: ${showTime}`, 150, 122)
     .text(`Reserved At: ${new Date(reservationTime).toLocaleString()}`, 150, 138);

  // Seats & Guests
  doc.moveTo(50, 160).lineTo(545, 160).strokeColor('#aaaaaa').stroke();
  doc.fontSize(13).fillColor('#000').text('Seats & Guests:', 50, 170);
  doc.fontSize(11).fillColor('#000');
  let y = 190;
  const guestList = Array.isArray(guests)?guests:[];
  if (guestList.length){
    guestList.forEach((g,i)=>{ doc.text(`${i+1}. ${g.name} — Seat ${g.seat}`, 60, y); y += 16; });
  } else {
    doc.text(`Seats: ${seats.join(', ')}`, 60, y); y += 16;
  }

  // QR code with order payload
  try{
    const payload = JSON.stringify({ orderId, email, seats, ts: Date.now() });
    const qrBuffer = await QRCode.toBuffer(payload, { type: 'png', margin: 1, scale: 6 });
    doc.image(qrBuffer, 450, 60, { fit: [100,100] });
  }catch(e){ /* ignore QR errors */ }

  // Footer
  doc.fontSize(10).fillColor('#444').text('All tickets are free. Please arrive 15 minutes early.', 50, 780);

  doc.end();
  await new Promise((resolve,reject)=>{ stream.on('finish', resolve); stream.on('error', reject); });

  return { filePath, mime: 'application/pdf', filename: path.basename(filePath) };
}

// ---------- API ----------
async function handleAPI(req, res){
  if(req.method === 'OPTIONS'){ return sendJSON(res, 204, { ok:true }); }
  if(req.method === 'GET' && req.url === '/api/health'){ return sendJSON(res, 200, { ok:true }); }
  if(req.method === 'GET' && req.url === '/api/seats'){ return sendJSON(res, 200, { seats: loadSeats() }); }

  // Register
  if(req.method === 'POST' && req.url === '/api/register'){
    const { email, first, last, phone, affiliation } = await parseBody(req);
    if(!email || !first || !last || !phone || !affiliation) return sendJSON(res, 400, { error: 'All fields are required.' });
    const aff = String(affiliation||'').toLowerCase();
    if(['student','staff'].includes(aff) && !/@(uark|uada)\.edu$/i.test(email)) return sendJSON(res, 400, { error: 'Students/Staff must use @uark.edu or @uada.edu.' });

    const users = readJSON(USERS_FILE, []);
    if(users.find(u=>u.email===email)) return sendJSON(res, 400, { error: 'This email is already registered.' });

    const code = String(Math.floor(100000 + Math.random()*900000));
    users.push({ email, first, last, phone, affiliation: aff, code, verified:false, purchases:[] });
    writeJSON(USERS_FILE, users);
    await sendEmail(email, 'Your Verification Code', `Your verification code is: ${code}`);
    return sendJSON(res, 200, { ok:true, message:'Verification code sent' });
  }

  // Verify
  if(req.method === 'POST' && req.url === '/api/verify'){
    const { email, code } = await parseBody(req);
    if(!email || !code) return sendJSON(res, 400, { error:'Email and code required' });
    const users = readJSON(USERS_FILE, []);
    const user = users.find(u=>u.email===email);
    if(!user) return sendJSON(res, 400, { error:'User not found' });
    if(user.code !== code) return sendJSON(res, 400, { error:'Incorrect code' });
    user.verified = true; user.code = null; writeJSON(USERS_FILE, users);
    return sendJSON(res, 200, { ok:true, email });
  }

  // Login (sends a code; user must exist)
  if(req.method === 'POST' && req.url === '/api/login'){
    const { email } = await parseBody(req);
    if(!email) return sendJSON(res, 400, { error:'Email required' });
    const users = readJSON(USERS_FILE, []);
    const user = users.find(u=>u.email===email);
    if(!user) return sendJSON(res, 404, { error:'User not found. Please register.' });

    const code = String(Math.floor(100000 + Math.random()*900000));
    user.code = code; writeJSON(USERS_FILE, users);
    await sendEmail(email, 'Your Sign-In Code', `Your verification code is: ${code}`);
    return sendJSON(res, 200, { ok:true, message:'Verification code sent' });
  }

  // Purchase (seats + guest names) -> generate server-side PDF and attach to email
  if(req.method === 'POST' && req.url === '/api/purchase'){
    const { email, seats: seatIds, guests } = await parseBody(req);
    if(!email || !Array.isArray(seatIds) || seatIds.length===0) return sendJSON(res, 400, { error:'Email and seats required' });

    const users = readJSON(USERS_FILE, []);
    const user = users.find(u=>u.email===email && u.verified);
    if(!user) return sendJSON(res, 403, { error:'User not verified or not found' });

    // Enforce max 2 seats across all purchases
    const already = Array.isArray(user.purchases) ? user.purchases.reduce((sum,p)=> sum + (Array.isArray(p.seats)?p.seats.length:0), 0) : 0;
    if (already + seatIds.length > 2) return sendJSON(res, 400, { error:`Seat limit exceeded. You already reserved ${already} seat(s). Max total is 2.` });

    // Check availability
    const seats = loadSeats();
    const unavailable = [];
    seatIds.forEach(id=>{ const s=seats.find(se=>se.id===id); if(!s || s.status!=='available') unavailable.push(id); });
    if(unavailable.length>0) return sendJSON(res, 409, { error:`Seats unavailable: ${unavailable.join(', ')}` });

    // Reserve
    seatIds.forEach(id=>{ const s=seats.find(se=>se.id===id); if(s) s.status='sold'; });
    writeJSON(SEATS_FILE, seats);

    if(!Array.isArray(user.purchases)) user.purchases = [];
    const orderId = `R${Date.now()}${Math.floor(Math.random()*1000)}`;
    const purchase = { seats: seatIds, guests: Array.isArray(guests)?guests:[], orderId, timestamp: Date.now() };
    user.purchases.push(purchase);
    writeJSON(USERS_FILE, users);

    // Build server-side PDF
    const showTime = 'November 22, 2025, 7:00 PM';
    const { filePath, mime, filename } = await createReceiptPDF({
      orderId,
      email,
      seats: seatIds,
      guests: purchase.guests,
      showTime,
      reservationTime: purchase.timestamp
    });

    // Email with PDF attachment
    const guestLines = (purchase.guests||[]).map((g,i)=>`${i+1}. ${g.name} — ${g.seat}`).join('\n') || '(No guest names provided)';
    const text =
`Thanks! Your seats are: ${seatIds.join(', ')}
Guests:
${guestLines}
All tickets are free.
Order ID: ${orderId}
Show: ${showTime}`;

    await sendEmail(email, 'Your Seat Reservation (PDF Attached)', text, [
      { filename, path: filePath, contentType: mime }
    ]);

    return sendJSON(res, 200, { ok:true, orderId });
  }

  return sendApiNotFound(res);
}

function requestHandler(req, res){
  if(req.url.startsWith('/api/')){ handleAPI(req, res).catch(err => { console.error(err); sendJSON(res, 500, { error:'Internal server error' }); }); }
  else { serveStatic(req, res); }
}

const PORT = process.env.PORT || 3000;
http.createServer(requestHandler).listen(PORT, ()=>{ console.log(`Server listening on port ${PORT}`); });