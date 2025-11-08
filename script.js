// script.js — Organizer-only booking (unlimited); others see phone notice
// Organizer phone (E.164): +1 650-418-5241
const ALLOWED_PHONE = "+16504185241";

// --- Firebase Web config (your project) ---
const firebaseConfig = {
  apiKey:        "AIzaSyC8_5PgpJKAj8RslYPC8U3roGvSTGKvapQ",
  authDomain:    "ticketwebsite-4d214.firebaseapp.com",
  projectId:     "ticketwebsite-4d214",
  appId:         "1:703462470857:web:912508f3e73b2eef95c918",
  messagingSenderId: "703462470857"
};

// Resolve API base with failover: meta → same-origin
function resolveApiBase() {
  const meta = document.querySelector('meta[name="api-base"]')?.content || '';
  const cleanMeta = meta && /^https?:\/\//i.test(meta) ? meta.replace(/\/+$/,'') : '';
  const sameOrigin = window.location.origin.replace(/\/+$/,'');
  return { primary: cleanMeta ? cleanMeta + '/api' : sameOrigin + '/api', fallback: sameOrigin + '/api' };
}
const API_URLS = resolveApiBase();

async function apiFetch(path, opts = {}) {
  const url1 = `${API_URLS.primary}${path}`;
  try {
    const r1 = await fetch(url1, opts);
    if ([502,503,504,521,522].includes(r1.status) && API_URLS.primary !== API_URLS.fallback) {
      const url2 = `${API_URLS.fallback}${path}`;
      try { return await fetch(url2, opts); } catch {}
    }
    return r1;
  } catch {
    const url2 = `${API_URLS.fallback}${path}`;
    if (API_URLS.primary !== API_URLS.fallback) return fetch(url2, opts);
    throw new Error('Network error');
  }
}

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// --- Helpers ---
async function getIdToken() {
  const user = auth.currentUser;
  return user ? user.getIdToken(true) : null;
}

// phone input mask → (xxx) xxx-xxxx
function formatPhoneMask(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(0, 10);
  const a = d.slice(0, 3), b = d.slice(3, 6), c = d.slice(6, 10);
  if (d.length > 6) return `(${a}) ${b}-${c}`;
  if (d.length > 3) return `(${a}) ${b}`;
  if (d.length > 0) return `(${a}`;
  return '';
}

// reCAPTCHA
let recaptchaVerifier = null;
function setupRecaptcha(containerId = 'recaptcha-container') {
  try { recaptchaVerifier?.clear(); } catch {}
  recaptchaVerifier = new firebase.auth.RecaptchaVerifier(containerId, { size: 'invisible' });
  recaptchaVerifier.render();
}

// Send SMS via Firebase
async function sendCode(phoneRaw) {
  const digits = String(phoneRaw || '').replace(/\D/g, '').slice(0, 10);
  if (digits.length !== 10) throw new Error('Please enter a valid 10-digit US number.');
  const full = `+1${digits}`;
  const confirmation = await auth.signInWithPhoneNumber(full, recaptchaVerifier);
  window._confirmationResult = confirmation;
  return true;
}

// Verify the 6-digit code
async function verifyCode(codeRaw) {
  const conf = window._confirmationResult;
  if (!conf) throw new Error('No code request pending. Tap “Send Code” again.');
  const code = String(codeRaw || '').trim();
  if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit code.');

  // Confirm with Firebase (client-side)
  await conf.confirm(code);

  // Notify server so it marks phone "verified"
  const idToken = await getIdToken();
  const res = await apiFetch('/verify_phone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });

  if (!res.ok) {
    let j = {}; try { j = await res.json(); } catch {}
    const statusInfo = res.status ? ` (${res.status})` : '';
    throw new Error(j.error || `Server verify failed${statusInfo}`);
  }
  return true;
}

// Purchase seats
async function purchaseSeats({ seats, guests, email, affiliation }) {
  const idToken = await getIdToken();
  if (!idToken) throw new Error('Please verify your phone first.');

  const res = await apiFetch('/purchase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
    body: JSON.stringify({ seats, guests, email, affiliation })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'Purchase failed');
  return j;
}

/* ------------------------- Seat rendering + UI ------------------------- */

// Convert 'A1' -> 'A01', keep original id for API
function formatSeatLabel(id){
  if(!id) return '';
  const m = String(id).match(/^([A-Za-z]+)(\d+)$/);
  if(!m) return String(id);
  const row = m[1].toUpperCase();
  const num = String(parseInt(m[2],10)).padStart(2,'0');
  return row + num;
}

// Sort seats by row letter(s) then numeric index
function seatCompare(a,b){
  const ra = String(a.id).match(/^([A-Za-z]+)(\d+)$/) || [];
  const rb = String(b.id).match(/^([A-Za-z]+)(\d+)$/) || [];
  const raRow = (ra[1]||'').toUpperCase();
  const rbRow = (rb[1]||'').toUpperCase();
  if (raRow < rbRow) return -1;
  if (raRow > rbRow) return 1;
  const na = parseInt(ra[2]||'0',10);
  const nb = parseInt(rb[2]||'0',10);
  return na - nb;
}


const state = { seats: [], selected: new Set(), organizer: false };
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const setHidden = (el, hide) => (hide ? el.classList.add('hidden') : el.classList.remove('hidden'));

function updateAvailableCounter() {
  const available = state.seats.filter(s => s.status === 'available').length;
  const ctn = $('#available-count');
  if (ctn) { ctn.querySelector('span').textContent = String(available); setHidden(ctn, false); }
}

function renderSeatMap() {
  const map = $('#seat-map'); if (!map) return;
  map.innerHTML = '';
  state.seats.forEach(seat => {
    const div = document.createElement('div');
    const disabled = !state.organizer || seat.status !== 'available';
    div.className = 'seat' + (seat.status !== 'available' ? ' sold' : '') + (state.selected.has(seat.id) ? ' selected' : '');
    div.textContent = formatSeatLabel(seat.id); div.dataset.id = seat.id;

    if (!disabled) {
      div.addEventListener('click', () => {
        if (state.selected.has(seat.id)) state.selected.delete(seat.id);
        else { state.selected.add(seat.id); } // unlimited for organizer
        renderSeatMap(); updateSummary();
      });
    }
    map.appendChild(div);
  });
  updateAvailableCounter();
}

function updateSummary() {
  const list = $('#selected-seats'); const btn = $('#checkout-btn');
  if (!list || !btn) return;
  list.innerHTML = '';
  [...state.selected].forEach(id => { const li = document.createElement('li'); li.textContent = formatSeatLabel(id); list.appendChild(li); });
  btn.disabled = !state.organizer || state.selected.size === 0;
}

async function loadSeats() {
  const res = await apiFetch('/seats');
  const j = await res.json();
  state.seats = Array.isArray(j.seats) ? j.seats.sort(seatCompare) : [];
  renderSeatMap();
  setHidden($('#seat-area'), false);
  setHidden($('#summary'), false);
}

function showSignedInHeader() {
  const info = $('#user-info');
  const phoneSpan = $('#user-phone');
  const u = auth.currentUser;
  if (u && phoneSpan) phoneSpan.textContent = u.phoneNumber || '';
  setHidden(info, !u);
}

// Clean sign-out + reset
function signOutFlow() {
  auth.signOut().catch(()=>{});
  window._confirmationResult = null;
  try { recaptchaVerifier?.clear(); } catch {}
  setupRecaptcha('recaptcha-container');

  // reset UI
  state.selected.clear(); updateSummary();
  const phoneInput = $('#phone-input'), codeInput = $('#code-input');
  if (phoneInput) phoneInput.value = '';
  if (codeInput)   codeInput.value   = '';
  $('#auth-message').textContent = '';
  $('#verification-message').textContent = '';

  const signInSection = $('#sign-in-section');
  const verificationSection = $('#verification-section');
  verificationSection.classList.add('hidden');
  signInSection.classList.remove('hidden');

  setHidden($('#seat-area'), true);
  setHidden($('#summary'), true);
  setHidden($('#auth-container'), false);
  setHidden($('#notice-container'), true);
}

// Guest modal handlers
function openGuestModal() {
  const namesBox = $('#guest-names'); const emailInput = $('#receipt-email');
  namesBox.innerHTML = '';
  [...state.selected].forEach((id, idx) => {
    const wrap = document.createElement('div'); wrap.style.marginTop = '8px';
    wrap.innerHTML = `<label>Guest ${idx+1} (for seat ${id})</label>
      <input type="text" class="guest-name" data-seat="${id}" placeholder="First Last" required />`;
    namesBox.appendChild(wrap);
  });
  emailInput.value = '';
  setHidden($('#guest-modal'), false);
}
const closeGuestModal = () => setHidden($('#guest-modal'), true);
function openConfirmModal(seatIds){ $('#summary-seats').textContent = `Seats: ${seatIds.map(formatSeatLabel).join(', ')}`; setHidden($('#checkout-modal'), false); }
const closeConfirmModal = () => setHidden($('#checkout-modal'), true);

/* --------------------------- Wire up the DOM --------------------------- */
window.addEventListener('DOMContentLoaded', () => {
  setupRecaptcha('recaptcha-container');

  const phoneInput = $('#phone-input'); const sendBtn = $('#login-phone-btn'); const authMsg = $('#auth-message');
  const codeInput  = $('#code-input');  const verifyBtn = $('#verify-phone-btn'); const verifyMsg = $('#verification-message');

  // Mask while typing
  if (phoneInput) {
    phoneInput.setAttribute('maxlength', '14');
    const mask = () => {
      const atEnd = phoneInput.selectionStart === phoneInput.value.length;
      phoneInput.value = formatPhoneMask(phoneInput.value);
      if (atEnd) phoneInput.selectionStart = phoneInput.selectionEnd = phoneInput.value.length;
    };
    phoneInput.addEventListener('input', mask);
    phoneInput.addEventListener('paste', () => setTimeout(mask, 0));
  }

  // Send Code
  sendBtn?.addEventListener('click', async () => {
    authMsg.textContent = ''; sendBtn.disabled = true;
    try {
      await sendCode(phoneInput.value);
      document.getElementById('verification-section').classList.remove('hidden'); 
      codeInput?.focus();
      authMsg.textContent = 'Code sent. Please check your SMS.'; authMsg.style.color = '#065f46';
    } catch (e) {
      authMsg.textContent = e.message || 'Failed to send code.'; authMsg.style.color = '#b91c1c';
    } finally { sendBtn.disabled = false; }
  });

  // Verify Code
  verifyBtn?.addEventListener('click', async () => {
    verifyMsg.textContent = ''; verifyBtn.disabled = true;
    try {
      await verifyCode(codeInput.value);

      // Determine if organizer
      const u = auth.currentUser;
      state.organizer = !!(u && u.phoneNumber === ALLOWED_PHONE);

      showSignedInHeader();
      if (!state.organizer) {
        setHidden(document.getElementById('notice-container'), false);
        setHidden(document.getElementById('auth-container'), false);
        document.getElementById('auth-message').textContent = '';
        document.getElementById('verification-message').textContent = '';
        setHidden(document.getElementById('seat-area'), true);
        setHidden(document.getElementById('summary'), true);
        verifyMsg.textContent = 'To reserve seats, please call (650) 418-5241.'; 
        verifyMsg.style.color = '#065f46';
        return;
      }

      // Organizer can proceed
      verifyMsg.textContent = 'Organizer verified! You can now reserve unlimited seats.'; verifyMsg.style.color = '#065f46';
      document.getElementById('sign-in-section').classList.add('hidden');
      setHidden(document.getElementById('auth-container'), true);
      await loadSeats();
    } catch (e) {
      const msg = String(e && e.message || e || '');
      verifyMsg.textContent = /code-expired/i.test(msg)
        ? 'The SMS code expired. Please re-send the code and try again.'
        : (/Failed to fetch/i.test(msg)
            ? 'Network error contacting the server. If your API is on a different domain, confirm the meta api-base URL or proxy /api on the same domain.'
            : (msg || 'Verification failed.'));
      verifyMsg.style.color = '#b91c1c';
    } finally { verifyBtn.disabled = false; }
  });

  // Already signed in? Evaluate role and UI
  auth.onAuthStateChanged(async (u) => {
    if (u) {
      state.organizer = u.phoneNumber === ALLOWED_PHONE;
      if (state.organizer) { setHidden($('#auth-container'), true); await loadSeats(); }
      else {
        setHidden($('#notice-container'), false);
        setHidden($('#auth-container'), false);
        setHidden($('#seat-area'), true);
        setHidden($('#summary'), true);
      }
      showSignedInHeader();
    }
  });

  // Summary actions
  $('#checkout-btn')?.addEventListener('click', () => { if (state.selected.size) openGuestModal(); });
  $('#guest-cancel-btn')?.addEventListener('click', closeGuestModal);

  $('#guest-next-btn')?.addEventListener('click', () => {
    const email = $('#receipt-email').value.trim();
    const affiliation = (document.querySelector('input[name="affil"]:checked')?.value || 'none').toLowerCase();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) return alert('Please enter a valid receipt email.');
    if (['student','staff'].includes(affiliation) && !/@(uark|uada)\.edu$/i.test(email))
      return alert('Students/Staff must use @uark.edu or @uada.edu for the receipt email.');
    const names = $$('.guest-name').map(inp => ({ name: inp.value.trim(), seat: inp.dataset.seat }));
    if (names.some(g => !g.name)) return alert('Please enter all guest names.');
    closeGuestModal(); openConfirmModal([...state.selected]); window.__pendingOrder = { email, affiliation, guests: names };
  });

  $('#cancel-btn')?.addEventListener('click', () => { closeConfirmModal(); window.__pendingOrder = null; });

  $('#confirm-btn')?.addEventListener('click', async () => {
    const p = window.__pendingOrder; if (!p) return;
    try {
      const r = await purchaseSeats({ seats: [...state.selected], guests: p.guests, email: p.email, affiliation: p.affiliation });
      alert(`Reservation confirmed! Order: ${r.orderId}\nA PDF receipt was sent to ${p.email}.`);
      closeConfirmModal(); state.selected.clear(); updateSummary(); await loadSeats();
    } catch (e) { alert(e.message || 'Reservation failed.'); }
  });

  // Header sign-out
  $('#signout-btn')?.addEventListener('click', signOutFlow);
});
