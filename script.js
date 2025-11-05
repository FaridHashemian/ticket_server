// script.js — fixes IDs, adds (xxx) xxx-xxxx mask, wires Send/Verify with Firebase

// --- Firebase Web config (use the same one you created) ---
const firebaseConfig = {
  apiKey:        "AIzaSyC8_5PgpJKAj8RslYPC8U3roGvSTGKvapQ",
  authDomain:    "ticketwebsite-4d214.firebaseapp.com",
  projectId:     "ticketwebsite-4d214",
  appId:         "1:703462470857:web:912508f3e73b2eef95c918",
  messagingSenderId: "703462470857"
};

// API base for your backend
const API_BASE = (document.querySelector('meta[name="api-base"]')?.content || window.location.origin) + '/api';

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
  await conf.confirm(code);

  // (Optional) Notify your server so users.json stays in sync
  const idToken = await getIdToken();
  const res = await fetch(`${API_BASE}/verify_phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || 'Verification failed on server.');
  }
  return true;
}

// Purchase seats (unchanged)
async function purchaseSeats({ seats, guests, email, affiliation }) {
  const idToken = await getIdToken();
  if (!idToken) throw new Error('Please verify your phone first.');

  const res = await fetch(`${API_BASE}/purchase`, {
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
      // keep caret at end for simplicity
      if (caretAtEnd) phoneInput.selectionStart = phoneInput.selectionEnd = phoneInput.value.length;
    });
    // On paste, delay-apply mask
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
      // move focus to code box
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
      // Optionally hide the sign-in section now:
      signInSection.classList.add('hidden');
    } catch (e) {
      verifyMsg.textContent = e.message || 'Verification failed.';
      verifyMsg.style.color = '#b91c1c';
    } finally {
      verifyBtn.disabled = false;
    }
  });

  // Example: you will already have seat selection + checkout wiring elsewhere
  // Ensure your “Continue / Reserve” button calls purchaseSeats(...)
});

// Example helpers your existing UI may already have:
function collectSelectedSeatIds() {
  return Array.from(document.querySelectorAll('.seat.selected')).map(el => el.dataset.id);
}
function collectGuestNamesWithSeats() {
  return Array.from(document.querySelectorAll('.guest-row')).map(row => ({
    name: row.querySelector('.guest-name').value.trim(),
    seat: row.querySelector('.guest-seat').textContent.trim()
  }));
}