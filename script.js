// script.js — Firebase Phone Auth on the client; call server with ID token

// TODO: replace with your Firebase web config from console
const firebaseConfig = {
  apiKey:        "AIzaSyC8_5PgpJKAj8RslYPC8U3roGvSTGKvapQ",
  authDomain:    "ticketwebsite-4d214.firebaseapp.com",
  projectId:     "ticketwebsite-4d214",
  appId:         "1:703462470857:web:912508f3e73b2eef95c918",
  messagingSenderId: "703462470857"
};

// API base
const API_BASE = (document.querySelector('meta[name="api-base"]')?.content || window.location.origin) + '/api';

// Load Firebase (modular) via global scripts in index.html
// We expect global "firebase" object (v9 compat style) for simplicity here.
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// Keep token handy
async function getIdToken(){
  const user = auth.currentUser;
  if(!user) return null;
  return await user.getIdToken(/* forceRefresh */ true);
}

// reCAPTCHA
let recaptchaVerifier = null;
function setupRecaptcha(containerId='recaptcha-container'){
  recaptchaVerifier = new firebase.auth.RecaptchaVerifier(containerId, { size: 'invisible' });
  recaptchaVerifier.render();
}

// Send SMS
async function sendCode(phoneRaw){
  const digits = String(phoneRaw||'').replace(/\D/g,'').slice(-10);
  if (digits.length !== 10) throw new Error('Invalid phone number');
  const full = `+1${digits}`;
  const confirmation = await auth.signInWithPhoneNumber(full, recaptchaVerifier);
  // store confirmation for later verification
  window._confirmationResult = confirmation;
  return true;
}

// Verify code
async function verifyCode(code){
  const conf = window._confirmationResult;
  if(!conf) throw new Error('No pending confirmation');
  await conf.confirm(String(code||'').trim());
  const idToken = await getIdToken();
  // Tell server "this phone is verified" (optional; useful to keep users.json in sync)
  const res = await fetch(`${API_BASE}/verify_phone`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ idToken })
  });
  if(!res.ok){ const j=await res.json().catch(()=>({})); throw new Error(j.error||'verify_phone failed'); }
  return true;
}

// Purchase seats
async function purchaseSeats({ seats, guests, email, affiliation }){
  const idToken = await getIdToken();
  if(!idToken) throw new Error('Please login via phone first');
  const res = await fetch(`${API_BASE}/purchase`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${idToken}` },
    body: JSON.stringify({ seats, guests, email, affiliation })
  });
  const j = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(j.error||'Purchase failed');
  return j;
}

// ------- Hook to your UI -------
// Example wiring (adapt to your actual elements)
window.addEventListener('DOMContentLoaded', ()=>{
  setupRecaptcha('recaptcha-container');

  const phoneInput  = document.querySelector('#phone');
  const sendBtn     = document.querySelector('#send-code');
  const codeInput   = document.querySelector('#code');
  const verifyBtn   = document.querySelector('#verify-code');

  sendBtn?.addEventListener('click', async ()=>{
    try{
      await sendCode(phoneInput.value);
      alert('Code sent. Please check your SMS.');
    }catch(e){ alert(e.message||e); }
  });

  verifyBtn?.addEventListener('click', async ()=>{
    try{
      await verifyCode(codeInput.value);
      alert('Phone verified! You can now reserve seats.');
    }catch(e){ alert(e.message||e); }
  });

  // When user clicks "Reserve":
  const reserveBtn = document.querySelector('#reserve');
  reserveBtn?.addEventListener('click', async ()=>{
    try{
      // gather seats, guests, email, affiliation from your form
      const seats = collectSelectedSeatIds();    // implement in your UI
      const guests = collectGuestNamesWithSeats(); // implement in your UI
      const email = document.querySelector('#receiptEmail').value.trim();
      const affiliation = document.querySelector('input[name="aff"]:checked')?.value || 'none';

      const out = await purchaseSeats({ seats, guests, email, affiliation });
      alert(`Reservation complete! Order ${out.orderId}. Check your email for the PDF.`);
    }catch(e){ alert(e.message||e); }
  });
});

// Dummy helpers to illustrate; replace with your actual app logic
function collectSelectedSeatIds(){ return Array.from(document.querySelectorAll('.seat.selected')).map(el=>el.dataset.id); }
function collectGuestNamesWithSeats(){
  // produce [{name:'Alice', seat:'A1'}, ...] based on your modal / input UX
  return Array.from(document.querySelectorAll('.guest-row')).map(row=>{
    return { name: row.querySelector('.guest-name').value.trim(), seat: row.querySelector('.guest-seat').textContent.trim() };
  });
}