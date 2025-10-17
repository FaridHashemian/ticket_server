// Backend for isaconcertticket.com — Fly.io bundle
// Uses DATA_DIR=/data (volume) for users.json, seats.json, emails/
// Exposes /api/* JSON endpoints and static file serving for '/' if needed.

const http = require('http');
const fs = require('fs');
const path = require('path');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}

const DATA_DIR = process.env.DATA_DIR || __dirname;
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SEATS_FILE = path.join(DATA_DIR, 'seats.json');
const EMAILS_DIR = path.join(DATA_DIR, 'emails');

if (!fs.existsSync(EMAILS_DIR)) fs.mkdirSync(EMAILS_DIR, { recursive: true });

function readJSON(file, fallback){
  try{ return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch{ return fallback; }
}
function writeJSON(file, obj){
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function generateInitialSeats(){
  const vipRows = ['A','B'];
  const seats = [];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for(let i=0;i<10;i++){
    const row = alphabet[i];
    for(let j=1;j<=25;j++){
      const id = `${row}${j}`;
      const price = vipRows.includes(row) ? 100 : 50;
      seats.push({id, row, number:j, price, status:'available'});
    }
  }
  return seats;
}

// Seed stores if missing
if (!fs.existsSync(SEATS_FILE)) writeJSON(SEATS_FILE, generateInitialSeats());
if (!fs.existsSync(USERS_FILE)) writeJSON(USERS_FILE, []);

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
              : 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type});
    res.end(data);
  });
}
function sendPlainNotFound(res){
  res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('Not found');
}

function parseBody(req){
  return new Promise((resolve)=>{
    let data='';
    req.on('data', chunk=> data+=chunk);
    req.on('end', ()=>{
      try{ resolve(JSON.parse(data||'{}')); } catch{ resolve({}); }
    });
  });
}

async function sendEmail(to, subject, text){
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  const body = text + `\n\n(If you did not request this, ignore.)`;
  if(nodemailer && SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS){
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: Number(SMTP_PORT),
      secure: String(SMTP_SECURE||'false') === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    await transporter.sendMail({ from: SMTP_USER, to, subject, text: body });
  } else {
    const fname = path.join(EMAILS_DIR, `${Date.now()}_${subject.replace(/\s+/g,'_')}_${to}.txt`);
    fs.writeFileSync(fname, body);
  }
}

async function handleAPI(req, res){
  if(req.method === 'OPTIONS'){
    return sendJSON(res, 204, { ok:true });
  }
  if(req.method === 'GET' && req.url === '/api/health'){
    return sendJSON(res, 200, { ok:true });
  }
  if(req.method === 'GET' && req.url === '/api/seats'){
    const seats = readJSON(SEATS_FILE, []);
    return sendJSON(res, 200, { seats });
  }
  if(req.method === 'POST' && req.url === '/api/register'){
    const { email } = await parseBody(req);
    if(!email) return sendJSON(res, 400, { error:'Email required' });
    const users = readJSON(USERS_FILE, []);
    let user = users.find(u=>u.email===email);
    const code = String(Math.floor(100000 + Math.random()*900000));
    if(user){ user.code = code; }
    else { user = { email, code, verified:false, purchases:[] }; users.push(user); }
    writeJSON(USERS_FILE, users);
    await sendEmail(email, 'Your Verification Code', `Your verification code is: ${code}`);
    return sendJSON(res, 200, { ok:true, message:'Verification code sent' });
  }
  if(req.method === 'POST' && req.url === '/api/verify'){
    const { email, code } = await parseBody(req);
    if(!email || !code) return sendJSON(res, 400, { error:'Email and code required' });
    const users = readJSON(USERS_FILE, []);
    const user = users.find(u=>u.email===email);
    if(!user) return sendJSON(res, 400, { error:'User not found' });
    if(user.code !== code) return sendJSON(res, 400, { error:'Incorrect code' });
    user.verified = true; user.code = null;
    writeJSON(USERS_FILE, users);
    return sendJSON(res, 200, { ok:true, email });
  }
  if(req.method === 'POST' && req.url === '/api/login'){
    const { email } = await parseBody(req);
    if(!email) return sendJSON(res, 400, { error:'Email required' });
    const users = readJSON(USERS_FILE, []);
    const user = users.find(u=>u.email===email);
    if(!user) return sendJSON(res, 404, { error:'User not found. Please register.' });
    if(!user.verified) return sendJSON(res, 403, { error:'User not verified. Check your email for the code.' });
    return sendJSON(res, 200, { ok:true, email:user.email });
  }
  if(req.method === 'POST' && req.url === '/api/purchase'){
    const { email, seats: seatIds } = await parseBody(req);
    if(!email || !Array.isArray(seatIds) || seatIds.length===0) return sendJSON(res, 400, { error:'Email and seats required' });
    const users = readJSON(USERS_FILE, []);
    const user = users.find(u=>u.email===email && u.verified);
    if(!user) return sendJSON(res, 403, { error:'User not verified or not found' });
    const seats = readJSON(SEATS_FILE, []);
    const unavailable = [];
    seatIds.forEach(id=>{
      const s = seats.find(se=>se.id===id);
      if(!s || s.status!=='available') unavailable.push(id);
    });
    if(unavailable.length>0) return sendJSON(res, 409, { error:`Seats unavailable: ${unavailable.join(', ')}` });
    seatIds.forEach(id=>{
      const s = seats.find(se=>se.id===id);
      if(s) s.status='sold';
    });
    writeJSON(SEATS_FILE, seats);
    if(!Array.isArray(user.purchases)) user.purchases = [];
    user.purchases.push({ seats: seatIds, timestamp: Date.now() });
    writeJSON(USERS_FILE, users);
    const total = seatIds.reduce((sum,id)=>{
      const s = seats.find(se=>se.id===id);
      return sum + (s ? s.price : 0);
    },0);
    await sendEmail(email, 'Your Concert Ticket Receipt', `Thanks for your purchase.\nSeats: ${seatIds.join(', ')}\nTotal: $${total}`);
    return sendJSON(res, 200, { ok:true });
  }
  return sendApiNotFound(res);
}

function requestHandler(req, res){
  if(req.url.startsWith('/api/')){
    handleAPI(req, res).catch(err => {
      console.error(err);
      sendJSON(res, 500, { error:'Internal server error' });
    });
  } else {
    serveStatic(req, res);
  }
}

const PORT = process.env.PORT || 8080; // Fly sets PORT
http.createServer(requestHandler).listen(PORT, ()=>{
  console.log(`Server listening on port ${PORT}`);
});
