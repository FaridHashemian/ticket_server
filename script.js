// Phone-only auth (Twilio on server), single-color seats,
// guest modal collects receipt email + affiliation, server emails PDF.

let currentPhone = null;
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

const $ = sel => document.querySelector(sel);

/* Input mask for phone: (xxx) xxx-xxxx */
document.addEventListener('input', (e)=>{
  if(e.target && e.target.id === 'phone-input'){
    const digits = e.target.value.replace(/\D/g,'').slice(0,10);
    let out = digits;
    if(digits.length > 6) out = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
    else if(digits.length > 3) out = `(${digits.slice(0,3)}) ${digits.slice(3)}`;
    else if(digits.length > 0) out = `(${digits}`;
    e.target.value = out;
  }
});

function init(){
  $('#login-phone-btn').addEventListener('click', sendPhoneCode);
  $('#verify-phone-btn').addEventListener('click', verifyPhone);
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

/* Auth (phone only) */
function phoneDigits(){ return ($('#phone-input').value || '').replace(/\D/g,''); }

async function sendPhoneCode(){
  const phoneRaw = phoneDigits();
  const msg = $('#auth-message');
  msg.textContent = "";
  if (phoneRaw.length !== 10){ msg.textContent = "Enter a valid 10-digit US number."; return; }

  try{
    const data = await jsonFetch(`${API_BASE}/login_phone`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ phone: phoneRaw })
    });
    $('#verification-info').textContent = data.message || "A 6-digit code was sent to your phone.";
    $('#sign-in-section').classList.add('hidden');
    $('#verification-section').classList.remove('hidden');
  }catch(err){ msg.textContent = err.message; }
}

async function verifyPhone(){
  const phoneRaw = phoneDigits();
  const code = $('#code-input').value.trim();
  const msg = $('#verification-message');
  msg.textContent = "";
  if (phoneRaw.length !== 10){ msg.textContent = "Invalid phone number."; return; }
  if (!/^\d{6}$/.test(code)){ msg.textContent = "Enter the 6-digit code."; return; }

  try{
    await jsonFetch(`${API_BASE}/verify_phone`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ phone: phoneRaw, code })
    });
    loginSuccess(phoneRaw);
  }catch(err){ msg.textContent = err.message; }
}

function loginSuccess(phoneRaw){
  currentPhone = phoneRaw;
  $('#auth-container').classList.add('hidden');
  $('#verification-section').classList.add('hidden');
  $('#sign-in-section').classList.add('hidden');

  $('#seat-area').classList.remove('hidden');
  $('#summary').classList.remove('hidden');
  $('#available-count').classList.remove('hidden');
  $('#user-info').classList.remove('hidden');

  const pretty = `(${phoneRaw.slice(0,3)}) ${phoneRaw.slice(3,6)}-${phoneRaw.slice(6)}`;
  $('#user-phone').textContent = pretty;
  $('#auth-header-message').textContent = 'Select up to 2 seats below.';

  selectedSeatIds = [];
  updateSelectedSummary();
  fetchSeats();
  if(seatRefreshInterval) clearInterval(seatRefreshInterval);
  seatRefreshInterval = setInterval(fetchSeats, 5000);
}

function signOut(){
  currentPhone = null;
  if(seatRefreshInterval){ clearInterval(seatRefreshInterval); seatRefreshInterval = null; }
  $('#seat-area').classList.add('hidden');
  $('#summary').classList.add('hidden');
  $('#available-count').classList.add('hidden');
  $('#user-info').classList.add('hidden');
  $('#auth-container').classList.remove('hidden');
  $('#sign-in-section').classList.remove('hidden');
  $('#verification-section').classList.add('hidden');
  $('#auth-header-message').textContent = 'Sign in with your phone to reserve up to 2 free seats.';
  $('#phone-input').value = $('#code-input').value = '';
  selectedSeatIds = []; updateSelectedSummary();
}

/* Fetch & render seats */
async function jsonFetch(url, options={}){
  const res = await fetch(url, options);
  const ctype = (res.headers.get('content-type')||'').toLowerCase();
  const text = await res.text();
  if(!ctype.includes('application/json')){
    const short = text.slice(0,200).replace(/\s+/g,' ').trim();
    throw new Error(`Expected JSON but got '${ctype || 'unknown'}'. Response starts with: ${short}`);
  }
  let data; try{ data = JSON.parse(text); } catch (e){ throw new Error(`Invalid JSON response: ${e.message}`); }
  if(!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

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

/* Guest details step */
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

  $('#guest-modal').classList.remove('hidden');
  $('#guest-modal').setAttribute('aria-hidden','false');
}
function closeGuestModal(){
  $('#guest-modal').classList.add('hidden');
  $('#guest-modal').setAttribute('aria-hidden','true');
}

function readAffil(){
  const el = document.querySelector('input[name="affil"]:checked');
  return el ? el.value : 'none';
}

function openCheckoutModal(){
  const receiptEmail = $('#receipt-email').value.trim().toLowerCase();
  const affiliation  = readAffil();

  // Validate receipt email
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receiptEmail);
  if(!emailOk){ alert('Please enter a valid receipt email.'); return; }
  if(['student','staff'].includes(affiliation) && !/@(uark|uada)\.edu$/i.test(receiptEmail)){
    alert('Students/Staff must use @uark.edu or @uada.edu for the receipt email.');
    return;
  }

  // Validate names
  const inputs = Array.from($('#guest-names').querySelectorAll('input'));
  const names = [];
  for(const i of inputs){
    const v = i.value.trim(); if(!v){ alert('Please enter all guest names.'); return; }
    names.push({ seat: i.dataset.seatId, name: v });
  }
  pendingGuestNames = names;

  // Store for confirm
  $('#checkout-modal').dataset.receiptEmail = receiptEmail;
  $('#checkout-modal').dataset.affiliation  = affiliation;

  closeGuestModal();
  $('#summary-seats').textContent = `Seats: ${selectedSeatIds.join(', ')}`;
  $('#checkout-modal').classList.remove('hidden');
  $('#checkout-modal').setAttribute('aria-hidden','false');
}

/* Confirm (server emails PDF) */
async function confirmPurchase(){
  if(!currentPhone || selectedSeatIds.length===0) return;
  const modal = $('#checkout-modal');

  const receiptEmail = modal.dataset.receiptEmail || '';
  const affiliation  = modal.dataset.affiliation  || 'none';

  try{
    const payload = {
      phone: currentPhone,
      email: receiptEmail,
      affiliation,
      seats: selectedSeatIds,
      guests: pendingGuestNames
    };
    await jsonFetch(`${API_BASE}/purchase`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });

    selectedSeatIds = []; pendingGuestNames = [];
    await fetchSeats(); updateSelectedSummary();
    alert('Reservation successful! Your PDF receipt will arrive by email.');
  }catch(err){ alert(err.message); }
  finally{ modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); }
}