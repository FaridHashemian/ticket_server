/* Frontend with splash, strong validation, free tickets, max 2 seats
   Adds stage bar, guest names, and PDF receipt w/ QR & logo. */
let currentEmail = null;
let seats = [];
let selectedSeatIds = [];
let seatRefreshInterval = null;
let pendingGuestNames = [];

function getApiBase(){
  const meta = document.querySelector('meta[name="api-base"]');
  if(meta && meta.content) return meta.content.replace(/\/+$/,'') + '/api';
  return window.location.origin.replace(/\/+$/,'') + '/api';
}
const API_BASE = getApiBase();

/* Splash: hide after 2s once page fully loaded */
window.addEventListener('load', ()=>{
  setTimeout(()=>{ const s=document.getElementById('splash'); if(s) s.style.display='none'; }, 2000);
});

/* Helpers */
async function jsonFetch(url, options={}){
  const res = await fetch(url, options);
  const ctype = (res.headers.get('content-type')||'').toLowerCase();
  const text = await res.text();
  if(!ctype.includes('application/json')){
    const short = text.slice(0,200).replace(/\s+/g,' ').trim();
    throw new Error(`Expected JSON but got '${ctype || 'unknown'}'. Response starts with: ${short}`);
  }
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error(`Invalid JSON response: ${e.message}`);
  }
  if(!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const $ = sel => document.querySelector(sel);

function init(){
  $('#register-btn').addEventListener('click', registerUser);
  $('#login-btn').addEventListener('click', loginUser);
  $('#verify-btn').addEventListener('click', verifyUser);
  $('#signout-btn').addEventListener('click', signOut);
  $('#checkout-btn').addEventListener('click', openGuestModal);

  // guest modal
  $('#guest-next-btn').addEventListener('click', openCheckoutModal);
  $('#guest-cancel-btn').addEventListener('click', closeGuestModal);

  // confirm modal
  $('#confirm-btn').addEventListener('click', confirmPurchase);
  $('#cancel-btn').addEventListener('click', ()=>{
    $('#checkout-modal').classList.add('hidden');
    $('#checkout-modal').setAttribute('aria-hidden','true');
  });
}
document.addEventListener('DOMContentLoaded', init);

function readAffil(){
  const el = document.querySelector('input[name="affil"]:checked');
  return el ? el.value : 'none';
}

/* Auth */
async function registerUser(){
  const email = $('#email-input').value.trim().toLowerCase();
  const first = $('#first-name').value.trim();
  const last  = $('#last-name').value.trim();
  const phone = $('#phone-number').value.trim();
  const affiliation = readAffil();
  const msg = $('#auth-message');
  msg.textContent = "";

  if(!email || !first || !last || !phone || !affiliation){
    msg.textContent = "Please fill all required fields."; return;
  }
  if(['student','staff'].includes(affiliation) && !/@(uark|uada)\.edu$/i.test(email)){
    msg.textContent = "Students/Staff must register with @uark.edu or @uada.edu."; return;
  }

  try{
    const data = await jsonFetch(`${API_BASE}/register`, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ email, first, last, phone, affiliation })
    });
    $('#verification-info').textContent = data.message || "A verification code has been sent to your email.";
    showVerificationSection();
  }catch(err){ msg.textContent = err.message; }
}

async function verifyUser(){
  const email = $('#email-input').value.trim().toLowerCase();
  const code  = $('#code-input').value.trim();
  const msg   = $('#verification-message');
  msg.textContent = "";
  if(!email){ msg.textContent = "Missing email."; return; }
  if(!code){  msg.textContent = "Enter the verification code."; return; }
  try{
    const data = await jsonFetch(`${API_BASE}/verify`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ email, code })
    });
    loginSuccess(data.email);
  }catch(err){ msg.textContent = err.message; }
}

async function loginUser(){
  const email = $('#email-input').value.trim().toLowerCase();
  const msg = $('#auth-message');
  msg.textContent = "";
  if(!email){ msg.textContent = "Please enter a valid email."; return; }
  try{
    // login now emails a verification code too
    const data = await jsonFetch(`${API_BASE}/login`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ email })
    });
    $('#verification-info').textContent = data.message || "A verification code has been sent to your email.";
    showVerificationSection();
  }catch(err){ msg.textContent = err.message; }
}

function loginSuccess(email){
  currentEmail = email;
  $('#auth-container').classList.add('hidden');
  $('#verification-section').classList.add('hidden');
  $('#sign-in-section').classList.add('hidden');

  $('#seat-area').classList.remove('hidden');
  $('#summary').classList.remove('hidden');
  $('#available-count').classList.remove('hidden');
  $('#user-info').classList.remove('hidden');

  $('#user-email').textContent = email;
  $('#auth-header-message').textContent = 'Select up to 2 seats below.';

  selectedSeatIds = [];
  updateSelectedSummary();
  fetchSeats();
  if(seatRefreshInterval) clearInterval(seatRefreshInterval);
  seatRefreshInterval = setInterval(fetchSeats, 5000);
}

function signOut(){
  currentEmail = null;
  if(seatRefreshInterval){ clearInterval(seatRefreshInterval); seatRefreshInterval = null; }
  $('#seat-area').classList.add('hidden');
  $('#summary').classList.add('hidden');
  $('#available-count').classList.add('hidden');
  $('#user-info').classList.add('hidden');
  $('#auth-container').classList.remove('hidden');
  $('#sign-in-section').classList.remove('hidden');
  $('#verification-section').classList.add('hidden');
  $('#auth-header-message').textContent = 'Register or log in to reserve your free seats (max 2).';
  $('#email-input').value = $('#code-input').value = $('#first-name').value = $('#last-name').value = $('#phone-number').value = '';
  selectedSeatIds = []; updateSelectedSummary();
}
function showVerificationSection(){
  $('#sign-in-section').classList.add('hidden');
  $('#verification-section').classList.remove('hidden');
}

/* Seats */
async function fetchSeats(){
  try{
    const data = await jsonFetch(`${API_BASE}/seats`);
    seats = data.seats || [];
    renderSeatMap(); updateAvailableCount();
  }catch(err){ console.error(err); }
}

function renderSeatMap(){
  const seatMapEl = $('#seat-map'); seatMapEl.innerHTML = '';
  seats.forEach(seat => {
    const seatEl = document.createElement('div');
    seatEl.classList.add('seat'); seatEl.dataset.seatId = seat.id; seatEl.textContent = seat.id;
    if (seat.status === 'sold') seatEl.classList.add('sold');
    else seatEl.classList.add('available');
    if (['A','B'].includes(seat.row)) seatEl.classList.add('vip');
    if (selectedSeatIds.includes(seat.id)) seatEl.classList.add('selected');
    seatEl.addEventListener('click', () => {
      if (seat.status === 'sold') return;
      if (!selectedSeatIds.includes(seat.id) && selectedSeatIds.length >= 2) { alert('You can select at most 2 seats.'); return; }
      toggleSeatSelection(seat.id);
    });
    seatMapEl.appendChild(seatEl);
  });
}

function toggleSeatSelection(seatId){
  const seat = seats.find(s => s.id === seatId);
  if(!seat || seat.status === 'sold') return;
  const idx = selectedSeatIds.indexOf(seatId);
  if(idx>=0) selectedSeatIds.splice(idx,1); else selectedSeatIds.push(seatId);
  renderSeatMap(); updateSelectedSummary();
}
function updateSelectedSummary(){
  const ul = $('#selected-seats'); ul.innerHTML='';
  selectedSeatIds.forEach(id => { const li=document.createElement('li'); li.textContent=id; ul.appendChild(li); });
  $('#checkout-btn').disabled = selectedSeatIds.length===0;
}
function updateAvailableCount(){
  const el = document.querySelector('#available-count span');
  const cnt = seats.filter(s=>s.status==='available').length; el.textContent = cnt;
}

/* Guest names step */
function openGuestModal(){
  if (selectedSeatIds.length===0) return;
  pendingGuestNames = [];
  const wrap = $('#guest-names'); wrap.innerHTML='';
  selectedSeatIds.forEach((id, idx)=>{
    const label = document.createElement('label');
    label.textContent = `Guest ${idx+1} for seat ${id} ${idx===0?'(required)':''}`;
    const input = document.createElement('input');
    input.type='text'; input.placeholder=`Full name for ${id}`; input.required = true;
    input.dataset.seatId = id;
    label.appendChild(input); wrap.appendChild(label);
  });
  $('#guest-modal').classList.remove('hidden'); $('#guest-modal').setAttribute('aria-hidden','false');
}
function closeGuestModal(){
  $('#guest-modal').classList.add('hidden'); $('#guest-modal').setAttribute('aria-hidden','true');
}
function openCheckoutModal(){
  // validate guest names
  const inputs = Array.from($('#guest-names').querySelectorAll('input'));
  const names = [];
  for(const i of inputs){
    const v = i.value.trim(); if(!v){ alert('Please enter all guest names.'); return; }
    names.push({ seat: i.dataset.seatId, name: v });
  }
  pendingGuestNames = names;
  closeGuestModal();
  $('#summary-seats').textContent = `Seats: ${selectedSeatIds.join(', ')}`;
  $('#checkout-modal').classList.remove('hidden'); $('#checkout-modal').setAttribute('aria-hidden','false');
}

/* Confirm & PDF */
async function confirmPurchase(){
  if(!currentEmail || selectedSeatIds.length===0) return;
  const modal = $('#checkout-modal');
  try{
    const payload = { email: currentEmail, seats: selectedSeatIds, guests: pendingGuestNames };
    const data = await jsonFetch(`${API_BASE}/purchase`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    // Generate PDF receipt client-side
    await createReceiptPDF({
      orderId: data.orderId,
      email: currentEmail,
      seats: selectedSeatIds,
      guests: pendingGuestNames,
      showTime: 'November 22, 2025, 7:00 PM',
      reservationTime: new Date().toLocaleString()
    });
    selectedSeatIds = []; pendingGuestNames = [];
    await fetchSeats(); updateSelectedSummary();
    alert('Reservation successful! Your PDF receipt has been downloaded.');
  }catch(err){ alert(err.message); }
  finally{ modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); }
}

/* PDF creator with jsPDF + qrcode-generator */
async function createReceiptPDF({orderId,email,seats,guests,showTime,reservationTime}){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  const pageW = doc.internal.pageSize.getWidth();

  // Logo (load as dataURL)
  const logoData = await fetch('/logo.png').then(r=>r.blob()).then(b=>new Promise(res=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(b); }));
  doc.addImage(logoData, 'PNG', 40, 40, 80, 80);

  doc.setFontSize(20); doc.text('Free Ticket Reservation Receipt', 140, 70);
  doc.setFontSize(11);
  doc.text(`Order ID: ${orderId}`, 140, 90);
  doc.text(`Email: ${email}`, 140, 106);
  doc.text(`Show Time: ${showTime}`, 140, 122);
  doc.text(`Reserved At: ${reservationTime}`, 140, 138);

  // Seats + Guests
  doc.setFontSize(13); doc.text('Seats & Guests:', 40, 160);
  doc.setFontSize(11);
  let y = 180;
  guests.forEach((g,i)=>{ doc.text(`${i+1}. ${g.name} — Seat ${g.seat}`, 50, y); y += 16; });
  if (guests.length === 0) { doc.text(`Seats: ${seats.join(', ')}`, 50, y); y+=16; }

  // QR code (encode order payload)
  const qr = qrcode(0, 'M');
  qr.addData(JSON.stringify({ orderId, email, seats, ts: Date.now() }));
  qr.make();
  const qrSize = 140;
  const qrImgTag = qr.createImgTag(6); // returns <img ...>
  const qrDataUrl = qrImgTag.match(/src="([^"]+)"/)[1];
  doc.addImage(qrDataUrl, 'PNG', pageW-qrSize-40, 60, qrSize, qrSize);

  // Footer
  doc.setFontSize(10);
  doc.text('All tickets are free. Please arrive 15 minutes early.', 40, 780);

  doc.save(`ticket_receipt_${orderId}.pdf`);
}