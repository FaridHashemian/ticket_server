/* Frontend w/ 2s splash, strong validation, free tickets, max 2 seats */
let currentEmail = null;
let seats = [];
let selectedSeatIds = [];
let seatRefreshInterval = null;

function getApiBase(){
  const meta = document.querySelector('meta[name="api-base"]');
  if(meta && meta.content) return meta.content.replace(/\/+$/,'') + '/api';
  return window.location.origin.replace(/\/+$/,'') + '/api';
}
const API_BASE = getApiBase();

/* Splash: hide after 2s once page fully loaded */
window.addEventListener('load', ()=>{
  setTimeout(()=>{
    const s = document.getElementById('splash');
    if(s){ s.style.display='none'; }
  }, 2000);
});

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
  if(!res.ok){
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function init(){
  document.getElementById('register-btn').addEventListener('click', registerUser);
  document.getElementById('login-btn').addEventListener('click', loginUser);
  document.getElementById('verify-btn').addEventListener('click', verifyUser);
  document.getElementById('signout-btn').addEventListener('click', signOut);
  document.getElementById('checkout-btn').addEventListener('click', openCheckoutModal);
  attachModalHandlers();
}
document.addEventListener('DOMContentLoaded', init);

function readAffil(){
  const el = document.querySelector('input[name="affil"]:checked');
  return el ? el.value : 'none';
}

async function registerUser(){
  const email = document.getElementById('email-input').value.trim().toLowerCase();
  const first = document.getElementById('first-name').value.trim();
  const last  = document.getElementById('last-name').value.trim();
  const phone = document.getElementById('phone-number').value.trim();
  const affiliation = readAffil();
  const msg = document.getElementById('auth-message');
  msg.textContent = "";

  if(!email || !first || !last || !phone || !affiliation){
    msg.textContent = "Please fill all required fields.";
    return;
  }
  if(['student','staff'].includes(affiliation) && !/@uark\.edu$/i.test(email)){
    msg.textContent = "UofA students/staff must register with a @uark.edu email.";
    return;
  }

  try{
    const data = await jsonFetch(`${API_BASE}/register`, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ email, first, last, phone, affiliation })
    });
    document.getElementById('verification-info').textContent = data.message || "A verification code has been sent to your email.";
    showVerificationSection();
  }catch(err){
    msg.textContent = err.message;
  }
}

async function verifyUser(){
  const email = document.getElementById('email-input').value.trim().toLowerCase();
  const code = document.getElementById('code-input').value.trim();
  const msg = document.getElementById('verification-message');
  msg.textContent = "";
  if(!email){ msg.textContent = "Missing email."; return; }
  if(!code){ msg.textContent = "Enter the verification code."; return; }
  try{
    const data = await jsonFetch(`${API_BASE}/verify`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ email, code })
    });
    loginSuccess(data.email);
  }catch(err){
    msg.textContent = err.message;
  }
}

async function loginUser(){
  const email = document.getElementById('email-input').value.trim().toLowerCase();
  const msg = document.getElementById('auth-message');
  msg.textContent = "";
  if(!email){ msg.textContent = "Please enter a valid email."; return; }
  try{
    const data = await jsonFetch(`${API_BASE}/login`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ email })
    });
    loginSuccess(data.email);
  }catch(err){
    msg.textContent = err.message;
  }
}

function loginSuccess(email){
  currentEmail = email;
  document.getElementById('auth-container').classList.add('hidden');
  document.getElementById('verification-section').classList.add('hidden');
  document.getElementById('sign-in-section').classList.add('hidden');

  document.getElementById('seat-map').classList.remove('hidden');
  document.getElementById('summary').classList.remove('hidden');
  document.getElementById('available-count').classList.remove('hidden');
  document.getElementById('user-info').classList.remove('hidden');

  document.getElementById('user-email').textContent = email;
  document.getElementById('auth-header-message').textContent = 'Select up to 2 seats below.';

  selectedSeatIds = [];
  updateSelectedSummary();
  fetchSeats();
  if(seatRefreshInterval) clearInterval(seatRefreshInterval);
  seatRefreshInterval = setInterval(fetchSeats, 5000);
}

function signOut(){
  currentEmail = null;
  if(seatRefreshInterval){ clearInterval(seatRefreshInterval); seatRefreshInterval = null; }
  document.getElementById('seat-map').classList.add('hidden');
  document.getElementById('summary').classList.add('hidden');
  document.getElementById('available-count').classList.add('hidden');
  document.getElementById('user-info').classList.add('hidden');
  document.getElementById('auth-container').classList.remove('hidden');
  document.getElementById('sign-in-section').classList.remove('hidden');
  document.getElementById('verification-section').classList.add('hidden');
  document.getElementById('auth-header-message').textContent = 'Register or log in to reserve your free seats (max 2).';
  document.getElementById('email-input').value = '';
  document.getElementById('code-input').value = '';
  document.getElementById('first-name').value = '';
  document.getElementById('last-name').value  = '';
  document.getElementById('phone-number').value = '';
  selectedSeatIds = [];
  updateSelectedSummary();
}

function showVerificationSection(){
  document.getElementById('sign-in-section').classList.add('hidden');
  document.getElementById('verification-section').classList.remove('hidden');
}

async function fetchSeats(){
  try{
    const data = await jsonFetch(`${API_BASE}/seats`);
    seats = data.seats || [];
    renderSeatMap();
    updateAvailableCount();
  }catch(err){
    console.error(err);
  }
}

function renderSeatMap(){
  const seatMapEl = document.getElementById('seat-map');
  seatMapEl.innerHTML = '';

  seats.forEach(seat => {
    const seatEl = document.createElement('div');
    seatEl.classList.add('seat');
    seatEl.dataset.seatId = seat.id;
    seatEl.textContent = seat.id;

    if (seat.status === 'sold') seatEl.classList.add('sold');
    else seatEl.classList.add('available');
    if (['A','B'].includes(seat.row)) seatEl.classList.add('vip');
    if (selectedSeatIds.includes(seat.id)) seatEl.classList.add('selected');

    seatEl.addEventListener('click', () => {
      if (seat.status === 'sold') return;
      if (!selectedSeatIds.includes(seat.id) && selectedSeatIds.length >= 2) {
        alert('You can select at most 2 seats.');
        return;
      }
      toggleSeatSelection(seat.id);
    });

    seatMapEl.appendChild(seatEl);
  });
}

function toggleSeatSelection(seatId){
  const seat = seats.find(s => s.id === seatId);
  if(!seat || seat.status === 'sold') return;
  const idx = selectedSeatIds.indexOf(seatId);
  if(idx>=0) selectedSeatIds.splice(idx,1);
  else selectedSeatIds.push(seatId);
  renderSeatMap();
  updateSelectedSummary();
}

function updateSelectedSummary(){
  const ul = document.getElementById('selected-seats');
  ul.innerHTML='';
  selectedSeatIds.forEach(id => {
    const li = document.createElement('li');
    li.textContent = id;
    ul.appendChild(li);
  });
  document.getElementById('checkout-btn').disabled = selectedSeatIds.length===0;
}

function updateAvailableCount(){
  const el = document.querySelector('#available-count span');
  const cnt = seats.filter(s=>s.status==='available').length;
  el.textContent = cnt;
}

function openCheckoutModal(){
  const summarySeats = document.getElementById('summary-seats');
  summarySeats.textContent = `Seats: ${selectedSeatIds.join(', ')}`;
  const modal = document.getElementById('checkout-modal');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden','false');
}

async function confirmPurchase(){
  if(!currentEmail || selectedSeatIds.length===0) return;
  const modal = document.getElementById('checkout-modal');
  try{
    await jsonFetch(`${API_BASE}/purchase`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ email: currentEmail, seats: selectedSeatIds })
    });
    selectedSeatIds = [];
    await fetchSeats();
    updateSelectedSummary();
    alert('Reservation successful! A confirmation email has been sent.');
  }catch(err){
    alert(err.message);
  }finally{
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden','true');
  }
}

function attachModalHandlers(){
  const modal = document.getElementById('checkout-modal');
  document.getElementById('confirm-btn').addEventListener('click', confirmPurchase);
  document.getElementById('cancel-btn').addEventListener('click', ()=>{
    modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true');
  });
}