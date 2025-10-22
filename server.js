// Backend for isaconcertticket.com
// - Free tickets, max 2 seats per email (across all purchases)
// - Collects first, last, phone, affiliation
// - Requires @uark.edu OR @uada.edu if affiliation is student/staff
// - Auto-reseeds seats if seats.json is empty/invalid
// - Sends email via SMTP (if configured) or writes a file to emails/ as fallback
// - Login now also emails a verification code
// - Purchase accepts guest names and returns orderId for the PDF

const http = require('http');
const fs = require('fs');
const path = require('path');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}

const DATA_DIR   = process.env.DATA_DIR || __dirname;
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SEATS_FILE = path.join(DATA_DIR, 'seats.json');
const EMAILS_DIR = path.join(DATA_DIR, 'emails');

if (!fs.existsSync(EMAILS_DIR)) fs.mkdirSync(EMAILS_DIR, { recursive: true });

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

async function sendEmail(to, subject, text){
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
      await transporter.sendMail({ from: SMTP_USER, to, subject, text: body });
      return;
    }catch(e){ console.error('SMTP send failed:', e && e.message ? e.message : e); }
  }
  // fallback to file
  const safeSubject = subject.replace(/[^\w.-]+/g,'_').slice(0,80);
  const safeTo = (to||'unknown').replace(/[^\w@.-]+/g,'_');
  const fname = path.join(EMAILS_DIR, `${Date.now()}_${safeSubject}_${safeTo}.txt`);
  fs.writeFileSync(fname, body);
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

  // Login (now sends a code; user must exist)
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

  // Purchase (seats + guest names)
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
    user.purchases.push({ seats: seatIds, guests: Array.isArray(guests)?guests:[], orderId, timestamp: Date.now() });
    writeJSON(USERS_FILE, users);

    const guestLines = (Array.isArray(guests)?guests:[]).map((g,i)=>`${i+1}. ${g.name} — ${g.seat}`).join('\n') || '(No guest names provided)';
    await sendEmail(email, 'Your Seat Reservation', `Thanks! Your seats are: ${seatIds.join(', ')}\nGuests:\n${guestLines}\nAll tickets are free.\nOrder ID: ${orderId}\nShow: Nov 22, 2025 7:00 PM`);
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