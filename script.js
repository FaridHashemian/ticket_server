// script.js — Firebase phone auth + robust API calls with fallback

// --- Firebase Web config (use your project values) ---
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

// Generic fetch with fallback to same-origin if first attempt fails at network layer
async function apiFetch(path, opts = {}) {
  const url1 = `${API_URLS.primary}${path}`;
  try {
    const r1 = await fetch(url1, opts);
    return r1;
  } catch (e) {
    // Network failure (DNS/SSL/CORS preflight blocked by infra) → try fallback
    const url2 = `${API_URLS.fallback}${path}`;
    try { return await fetch(url2, opts); }
    catch (e2) { throw e2; }
  }
}

// Initialize Firebase (compat)
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

  // Confirm with Firebase (this part is client-side and should succeed if code is correct)
  await conf.confirm(code);

  // Now notify server so it marks phone "verified"
  const idToken = await getIdToken();
  const res = await apiFetch('/verify_phone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!res.ok) {
    let j = {};
    try { j = await res.json(); } catch {}
    throw new Error(j.error || `Server verify failed (${res.status})`);
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

// ----- Wire up to your current DOM -----
window.addEventListener('DOMContentLoaded', () => {
  setupRecaptcha('recaptcha-container');

  // Elements (match your index.html IDs)
  const phoneInput   = document.querySelector('#phone-input');
  const sendBtn      = document.querySelector('#login-phone-btn');
  const authMsg      = document.querySelector('#auth-message');

  const codeInput    = document.querySelector('#code-input');
  const verifyBtn    = document.querySelector('#verify-phone-btn');
  const verifyMsg    = document.querySelector('#verification-message');

  const signInSection    = document.querySelector('#sign-in-section');
  const verificationSection = document.querySelector('#verification-section');

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
    } catch (e) {
      // Show helpful network hint if fetch failed entirely
      verifyMsg.textContent =
        (e.message && /TypeError: Failed to fetch/i.test(String(e))) ? 
          'Network error contacting the server. If your API is on a different domain, confirm the meta api-base URL or proxy /api on the same domain.' :
          (e.message || 'Verification failed.');
      verifyMsg.style.color = '#b91c1c';
    } finally {
      verifyBtn.disabled = false;
    }
  });

  // You already have seat selection + checkout wiring elsewhere
});

// Example helpers (keep if you use them)
function collectSelectedSeatIds() {
  return Array.from(document.querySelectorAll('.seat.selected')).map(el => el.dataset.id);
}
function collectGuestNamesWithSeats() {
  return Array.from(document.querySelectorAll('.guest-row')).map(row => ({
    name: row.querySelector('.guest-name').value.trim(),
    seat: row.querySelector('.guest-seat').textContent.trim()
  }));
}
