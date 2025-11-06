// script.js — Firebase phone auth + robust API + full seat UI

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

// Generic fetch with fallback to same-origin if:
//  - network error, OR
//  - 5xx from the API domain (502/503/504/521/522)
async function apiFetch(path, opts = {}) {
  const url1 = `${API_URLS.primary}${path}`;
  try {
    const r1 = await fetch(url1, opts);
    if ([502,503,504,521,522].includes(r1.status) && API_URLS.primary !== API_URLS.fallback) {
      const url2 = `${API_URLS.fallback}${path}`;
      try { return await fetch(url2, opts); } catch { /* fall through */ }
    }
    return r1;
  } catch (e) {
    const url2 = `${API_URLS.fallback}${path}`;
    if (API_URLS.primary !== API_URLS.fallback) return fetch(url2, opts);
    throw e;
  }
}

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// --- Helpers ---
async function getIdToken() {
  const user = auth.currentUser;
  if (!user) return null;
  return await user.getIdToken(true);
}

// phone input mask → (xxx) xxx-xxxx
function formatPhoneMask(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(0, 10);
  const a = d.slice(0, 3);
  const b = d.slice(3, 6);
  const c = d.slice(6, 10);
  if (d.length > 6) return `(${a}) ${b}-${c}`;
  if (d.length > 3) return `(${a}) ${b}`;
  if (d.length > 0) return `(${a}`;
  return '';
}

// reCAPTCHA
let recaptchaVerifier = null;
function setupRecaptcha(containerId = 'recaptcha-container') {
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
    let j = {};
    try { j = await res.json(); } catch {}
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
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`
    },
    body: JSON.stringify({ seats, guests, email, affiliation })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'Purchase failed');
  return j;
}

/* ------------------------- Seat rendering + UI ------------------------- */

const state = {
  seats: [],
  selected: new Set(),   // up to 2
};

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function setHidden(el, hide) { hide ? el.classList.add('hidden') : el.classList.remove('hidden'); }

function updateAvailableCounter() {
  const available = state.seats.filter(s => s.status === 'available').length;
  const ctn = $('#available-count');
  if (ctn) {
    ctn.querySelector('span').textContent = String(available);
    setHidden(ctn, false);
  }
}

function renderSeatMap() {
  const map = $('#seat-map');
  if (!map) return;

  map.innerHTML = '';
  state.seats.forEach(seat => {
    const div = document.createElement('div');
    div.className = 'seat' + (seat.status !== 'available' ? ' sold' : '') + (state.selected.has(seat.id) ? ' selected' : '');
    div.textContent = seat.id;
    div.dataset.id = seat.id;

    if (seat.status === 'available') {
      div.addEventListener('click', () => {
        if (state.selected.has(seat.id)) {
          state.selected.delete(seat.id);
        } else {
          if (state.selected.size >= 2) return; // limit
          state.selected.add(seat.id);
        }
        renderSeatMap();
        updateSummary();
      });
    }
    map.appendChild(div);
  });

  updateAvailableCounter();
}

function updateSummary() {
  const list = $('#selected-seats');
  const btn  = $('#checkout-btn');
  if (!list || !btn) return;

  list.innerHTML = '';
  [...state.selected].forEach(id => {
    const li = document.createElement('li');
    li.textContent = id;
    list.appendChild(li);
  });

  btn.disabled = state.selected.size === 0;
}

async function loadSeats() {
  const res = await apiFetch('/seats');
  const j = await res.json();
  state.seats = Array.isArray(j.seats) ? j.seats : [];
  renderSeatMap();
  setHidden($('#seat-area'), false);
  setHidden($('#summary'), false);
}

function showSignedInHeader() {
  const info = $('#user-info');
  const phoneSpan = $('#user-phone');
  const headerMsg = $('#auth-header-message');
  const u = auth.currentUser;
  if (u && phoneSpan) phoneSpan.textContent = u.phoneNumber || '';
  setHidden(info, !u);
  if (u) headerMsg.textContent = 'Select up to 2 free seats.';
}

function signOutFlow() {
  auth.signOut().catch(()=>{});
  // reset UI
  state.selected.clear();
  updateSummary();
  setHidden($('#seat-area'), true);
  setHidden($('#summary'), true);
  setHidden($('#auth-container'), false);
}

// Guest modal orchestration
function openGuestModal() {
  const modal = $('#guest-modal');
  const namesBox = $('#guest-names');
  const emailInput = $('#receipt-email');

  // build inputs for each selected seat
  namesBox.innerHTML = '';
  [...state.selected].forEach((id, idx) => {
    const wrap = document.createElement('div');
    wrap.style.marginTop = '8px';
    wrap.innerHTML = `
      <label>Guest ${idx+1} (for seat ${id})</label>
      <input type="text" class="guest-name" data-seat="${id}" placeholder="First Last" required />
    `;
    namesBox.appendChild(wrap);
  });

  emailInput.value = '';
  setHidden(modal, false);
}

function closeGuestModal() { setHidden($('#guest-modal'), true); }
function openConfirmModal(seatIds) {
  $('#summary-seats').textContent = `Seats: ${seatIds.join(', ')}`;
  setHidden($('#checkout-modal'), false);
}
function closeConfirmModal() { setHidden($('#checkout-modal'), true); }

/* --------------------------- Wire up the DOM --------------------------- */

window.addEventListener('DOMContentLoaded', () => {
  setupRecaptcha('recaptcha-container');

  // Auth elements
  const phoneInput   = $('#phone-input');
  const sendBtn      = $('#login-phone-btn');
  const authMsg      = $('#auth-message');

  const codeInput    = $('#code-input');
  const verifyBtn    = $('#verify-phone-btn');
  const verifyMsg    = $('#verification-message');

  const signInSection    = $('#sign-in-section');
  const verificationSection = $('#verification-section');

  // Mask while typing
  if (phoneInput) {
    phoneInput.setAttribute('maxlength', '14'); // "(xxx) xxx-xxxx"
    phoneInput.addEventListener('input', () => {
      const caretAtEnd = phoneInput.selectionStart === phoneInput.value.length;
      phoneInput.value = formatPhoneMask(phoneInput.value);
      if (caretAtEnd) phoneInput.selectionStart = phoneInput.selectionEnd = phoneInput.value.length;
    });
    phoneInput.addEventListener('paste', () => setTimeout(() => {
      phoneInput.value = formatPhoneMask(phoneInput.value);
    }, 0));
  }

  // Send Code
  sendBtn?.addEventListener('click', async () => {
    authMsg.textContent = '';
    sendBtn.disabled = true;
    try {
      await sendCode(phoneInput.value);
      verificationSection.classList.remove('hidden');
      codeInput?.focus();
      authMsg.textContent = 'Code sent. Please check your SMS.';
      authMsg.style.color = '#065f46';
    } catch (e) {
      authMsg.textContent = e.message || 'Failed to send code.';
      authMsg.style.color = '#b91c1c';
    } finally {
      sendBtn.disabled = false;
    }
  });

  // Verify Code
  verifyBtn?.addEventListener('click', async () => {
    verifyMsg.textContent = '';
    verifyBtn.disabled = true;
    try {
      await verifyCode(codeInput.value);
      verifyMsg.textContent = 'Phone verified! You can now reserve seats.';
      verifyMsg.style.color = '#065f46';
      signInSection.classList.add('hidden');

      // Reveal main UI
      setHidden($('#auth-container'), true);
      await loadSeats();
      showSignedInHeader();
    } catch (e) {
      verifyMsg.textContent =
        (e.message && /TypeError: Failed to fetch/i.test(String(e))) ?
          'Network error contacting the server. If your API is on a different domain, confirm the meta api-base URL or proxy /api on the same domain.' :
          (e.message || 'Verification failed.');
      verifyMsg.style.color = '#b91c1c';
      console.error('verify error:', e);
    } finally {
      verifyBtn.disabled = false;
    }
  });

  // If already signed in (page refresh after verify), show seats automatically
  auth.onAuthStateChanged(async (u) => {
    if (u) {
      setHidden($('#auth-container'), true);
      showSignedInHeader();
      await loadSeats();
    }
  });

  // Summary actions
  $('#checkout-btn')?.addEventListener('click', () => {
    if (state.selected.size === 0) return;
    openGuestModal();
  });
  $('#guest-cancel-btn')?.addEventListener('click', closeGuestModal);

  $('#guest-next-btn')?.addEventListener('click', () => {
    const email = $('#receipt-email').value.trim();
    const affiliation = (document.querySelector('input[name="affil"]:checked')?.value || 'none').toLowerCase();

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) return alert('Please enter a valid receipt email.');

    if (['student','staff'].includes(affiliation) && !/@(uark|uada)\.edu$/i.test(email)) {
      return alert('Students/Staff must use @uark.edu or @uada.edu for the receipt email.');
    }

    const names = $all('.guest-name').map(inp => ({ name: inp.value.trim(), seat: inp.dataset.seat }));
    if (names.some(g => !g.name)) return alert('Please enter all guest names.');

    closeGuestModal();
    openConfirmModal([...state.selected]);

    // stash for confirm
    window.__pendingOrder = { email, affiliation, guests: names };
  });

  $('#cancel-btn')?.addEventListener('click', () => {
    closeConfirmModal();
    window.__pendingOrder = null;
  });

  $('#confirm-btn')?.addEventListener('click', async () => {
    const pending = window.__pendingOrder;
    if (!pending) return;

    try {
      const result = await purchaseSeats({
        seats: [...state.selected],
        guests: pending.guests,
        email: pending.email,
        affiliation: pending.affiliation
      });

      alert(`Reservation confirmed! Order: ${result.orderId}\nA PDF receipt was sent to ${pending.email}.`);
      closeConfirmModal();
      state.selected.clear();
      updateSummary();
      await loadSeats(); // refresh sold seats
    } catch (e) {
      alert(e.message || 'Reservation failed.');
    }
  });

  // Sign out button (header)
  $('#signout-btn')?.addEventListener('click', signOutFlow);
});