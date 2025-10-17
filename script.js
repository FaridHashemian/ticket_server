/*
 * JavaScript for the concert ticketing website with user authentication and server integration.
 * Users must register or log in with their email, verify via code, then select seats and purchase.
 * Seat data is loaded from the server; purchases update server state and generate receipt emails (simulated).
 */

let currentEmail = null;       // currently logged-in user email
let seats = [];                 // array of seat objects loaded from localStorage
let selectedSeatIds = [];       // array of seat IDs currently selected by the user

/**
 * Initialize the application on DOM load. Sets up event listeners for authentication,
 * seat selection, checkout, and modal actions.
 */
function init() {
    // Auth buttons
    const registerBtn = document.getElementById('register-btn');
    const loginBtn = document.getElementById('login-btn');
    const verifyBtn = document.getElementById('verify-btn');
    const signoutBtn = document.getElementById('signout-btn');

    registerBtn.addEventListener('click', registerUser);
    loginBtn.addEventListener('click', loginUser);
    verifyBtn.addEventListener('click', verifyUser);
    signoutBtn.addEventListener('click', signOut);

    // Checkout button
    const checkoutBtn = document.getElementById('checkout-btn');
    checkoutBtn.addEventListener('click', openCheckoutModal);

    // Attach modal handlers
    attachModalHandlers();
}

/**
 * Register a new user with an email address. Sends a POST request to the server's /register endpoint.
 * If successful, prompts the user to enter the verification code sent to their email.
 */
async function registerUser() {
    const emailInput = document.getElementById('email-input');
    const email = emailInput.value.trim().toLowerCase();
    const authMessage = document.getElementById('auth-message');
    authMessage.textContent = '';
    if (!email) {
        authMessage.textContent = 'Please enter a valid email address.';
        return;
    }
    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await response.json();
        if (response.ok) {
            currentEmail = email;
            showVerificationSection();
            const verificationInfo = document.getElementById('verification-info');
            // Inform the user to check their email without revealing the code
            verificationInfo.textContent = `${data.message}. Please check your email for the verification code.`;
        } else {
            authMessage.textContent = data.error || 'Registration failed.';
        }
    } catch (err) {
        authMessage.textContent = 'An error occurred during registration.';
        console.error(err);
    }
}

/**
 * Verify a user's email with the provided code. Sends a POST request to /verify.
 * On success, logs the user in.
 */
async function verifyUser() {
    const codeInput = document.getElementById('code-input');
    const code = codeInput.value.trim();
    const verificationMessage = document.getElementById('verification-message');
    verificationMessage.textContent = '';
    if (!currentEmail) {
        verificationMessage.textContent = 'No registration session found. Please register again.';
        return;
    }
    if (!code) {
        verificationMessage.textContent = 'Please enter the verification code.';
        return;
    }
    try {
        const response = await fetch('/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentEmail, code })
        });
        const data = await response.json();
        if (response.ok) {
            loginSuccess(currentEmail);
        } else {
            verificationMessage.textContent = data.error || 'Verification failed.';
        }
    } catch (err) {
        verificationMessage.textContent = 'An error occurred during verification.';
        console.error(err);
    }
}

/**
 * Log in a user with an existing verified email. Sends a POST request to /login.
 */
async function loginUser() {
    const emailInput = document.getElementById('email-input');
    const email = emailInput.value.trim().toLowerCase();
    const authMessage = document.getElementById('auth-message');
    authMessage.textContent = '';
    if (!email) {
        authMessage.textContent = 'Please enter a valid email address.';
        return;
    }
    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await response.json();
        if (response.ok) {
            currentEmail = email;
            loginSuccess(email);
        } else {
            authMessage.textContent = data.error || 'Login failed.';
        }
    } catch (err) {
        authMessage.textContent = 'An error occurred during login.';
        console.error(err);
    }
}

/**
 * Called when a user successfully logs in (either via verification or direct login).
 * Shows the seat map and summary, hides auth forms, and loads seat data from server.
 * @param {string} email
 */
function loginSuccess(email) {
    currentEmail = email;
    // Hide authentication sections
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('verification-section').classList.add('hidden');
    document.getElementById('sign-in-section').classList.add('hidden');
    // Show seat map, summary, available count, user info
    document.getElementById('seat-map').classList.remove('hidden');
    document.getElementById('summary').classList.remove('hidden');
    document.getElementById('available-count').classList.remove('hidden');
    document.getElementById('user-info').classList.remove('hidden');
    document.getElementById('user-email').textContent = email;
    document.getElementById('auth-header-message').textContent = 'Select your seats below.';
    // Reset selections
    selectedSeatIds = [];
    updateSelectedSummary();
    // Fetch seat data from server
    fetchSeats();
    // Optionally refresh seats periodically to reflect new purchases
    if (typeof window.seatRefreshInterval === 'number') {
        clearInterval(window.seatRefreshInterval);
    }
    window.seatRefreshInterval = setInterval(fetchSeats, 15000);
}

/**
 * Sign out the current user and reset the interface back to the authentication forms.
 */
function signOut() {
    currentEmail = null;
    // Hide seat map and summary
    document.getElementById('seat-map').classList.add('hidden');
    document.getElementById('summary').classList.add('hidden');
    document.getElementById('available-count').classList.add('hidden');
    document.getElementById('user-info').classList.add('hidden');
    // Show sign in form
    document.getElementById('auth-container').classList.remove('hidden');
    document.getElementById('sign-in-section').classList.remove('hidden');
    document.getElementById('verification-section').classList.add('hidden');
    document.getElementById('auth-header-message').textContent = 'Register or log in to start booking your seats.';
    // Clear inputs and messages
    document.getElementById('email-input').value = '';
    document.getElementById('code-input').value = '';
    document.getElementById('auth-message').textContent = '';
    document.getElementById('verification-message').textContent = '';
    // Reset seat selections
    selectedSeatIds = [];
    updateSelectedSummary();

    // Clear any periodic seat refresh
    if (typeof window.seatRefreshInterval === 'number') {
        clearInterval(window.seatRefreshInterval);
        window.seatRefreshInterval = null;
    }
}

/**
 * Show the verification section and hide the sign-in section.
 */
function showVerificationSection() {
    document.getElementById('sign-in-section').classList.add('hidden');
    document.getElementById('verification-section').classList.remove('hidden');
}

/**
 * Fetch seat data from the server and render the seat map.
 */
async function fetchSeats() {
    try {
        const response = await fetch('/seats');
        const data = await response.json();
        if (response.ok && Array.isArray(data)) {
            seats = data;
            renderSeatMap();
            updateAvailableCount();
        } else {
            console.error('Failed to fetch seats:', data);
        }
    } catch (err) {
        console.error('Error fetching seats:', err);
    }
}

/**
 * Load seats from localStorage. If no seats are stored yet, generate initial seating and store.
 */
function loadSeatsFromStorage() {
    const data = localStorage.getItem('ct_seats');
    if (data) {
        try {
            seats = JSON.parse(data);
        } catch {
            seats = generateInitialSeats();
            saveSeatsToStorage(seats);
        }
    } else {
        seats = generateInitialSeats();
        saveSeatsToStorage(seats);
    }
    renderSeatMap();
    updateAvailableCount();
}

/**
 * Save the current seats array to localStorage.
 * @param {Array} seatArray
 */
function saveSeatsToStorage(seatArray) {
    localStorage.setItem('ct_seats', JSON.stringify(seatArray));
}

/**
 * Generate the initial 250 seats with pricing. VIP rows are A and B with higher price.
 * @returns {Array}
 */
function generateInitialSeats() {
    const vipRows = ['A', 'B'];
    const vipPrice = 100;
    const regPrice = 50;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const newSeats = [];
    for (let i = 0; i < 10; i++) {
        const rowLabel = alphabet[i];
        for (let j = 1; j <= 25; j++) {
            const id = `${rowLabel}${j}`;
            const price = vipRows.includes(rowLabel) ? vipPrice : regPrice;
            newSeats.push({ id, row: rowLabel, number: j, price, status: 'available' });
        }
    }
    return newSeats;
}

/**
 * Load users from localStorage. Returns an array of user objects.
 * @returns {Array}
 */
function loadUsers() {
    const data = localStorage.getItem('ct_users');
    if (data) {
        try {
            return JSON.parse(data);
        } catch {
            return [];
        }
    }
    return [];
}

/**
 * Save users array to localStorage.
 * @param {Array} users
 */
function saveUsers(users) {
    localStorage.setItem('ct_users', JSON.stringify(users));
}

/**
 * Render the seat map based on the seats array. Creates clickable seat elements
 * that toggle selection for available seats.
 */
function renderSeatMap() {
    const seatMapEl = document.getElementById('seat-map');
    seatMapEl.innerHTML = '';
    seats.forEach(seat => {
        const seatEl = document.createElement('div');
        seatEl.classList.add('seat');
        seatEl.dataset.seatId = seat.id;
        seatEl.textContent = seat.id;
        // Apply classes based on seat status and VIP
        if (seat.status === 'sold') {
            seatEl.classList.add('sold');
        } else {
            seatEl.classList.add('available');
        }
        if (['A', 'B'].includes(seat.row)) {
            seatEl.classList.add('vip');
        }
        // If seat is selected by the user, highlight it
        if (selectedSeatIds.includes(seat.id)) {
            seatEl.classList.add('selected');
        }
        seatEl.addEventListener('click', () => toggleSeatSelection(seat.id));
        seatMapEl.appendChild(seatEl);
    });
}

/**
 * Toggle the selection state of a seat when clicked. Only works for available seats.
 * @param {string} seatId
 */
function toggleSeatSelection(seatId) {
    const seat = seats.find(s => s.id === seatId);
    if (!seat || seat.status === 'sold') {
        return;
    }
    const index = selectedSeatIds.indexOf(seatId);
    if (index >= 0) {
        // Deselect seat
        selectedSeatIds.splice(index, 1);
    } else {
        // Select seat
        selectedSeatIds.push(seatId);
    }
    renderSeatMap();
    updateSelectedSummary();
}

/**
 * Update the selected seats list and total price display.
 */
function updateSelectedSummary() {
    const selectedListEl = document.getElementById('selected-seats');
    const totalPriceEl = document.getElementById('total-price');
    selectedListEl.innerHTML = '';
    let total = 0;
    selectedSeatIds.forEach(id => {
        const seat = seats.find(s => s.id === id);
        if (seat) {
            const li = document.createElement('li');
            li.textContent = `${seat.id} — $${seat.price}`;
            selectedListEl.appendChild(li);
            total += seat.price;
        }
    });
    totalPriceEl.textContent = `Total price: $${total}`;
    const checkoutBtn = document.getElementById('checkout-btn');
    checkoutBtn.disabled = selectedSeatIds.length === 0;
}

/**
 * Update the display of available seats count.
 */
function updateAvailableCount() {
    const availableCountEl = document.getElementById('available-count').querySelector('span');
    const availableCount = seats.filter(s => s.status === 'available').length;
    availableCountEl.textContent = availableCount;
}

/**
 * Open the checkout modal and display a summary of the selected seats.
 */
function openCheckoutModal() {
    // Populate summary inside modal
    const summarySeats = document.getElementById('summary-seats');
    const summaryPrice = document.getElementById('summary-price');
    summarySeats.textContent = `Seats: ${selectedSeatIds.join(', ')}`;
    const total = selectedSeatIds.reduce((sum, id) => {
        const seat = seats.find(s => s.id === id);
        return sum + (seat ? seat.price : 0);
    }, 0);
    summaryPrice.textContent = `Total: $${total}`;
    const modal = document.getElementById('checkout-modal');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
}

/**
 * Confirm the purchase: send selected seats to the server, handle the response, and refresh seat data.
 */
async function confirmPurchase() {
    const modal = document.getElementById('checkout-modal');
    if (!currentEmail || selectedSeatIds.length === 0) {
        return;
    }
    try {
        const response = await fetch('/purchase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentEmail, seats: selectedSeatIds })
        });
        const data = await response.json();
        if (response.ok) {
            // Successful purchase; refresh seat data and clear selection
            selectedSeatIds = [];
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
            updateSelectedSummary();
            await fetchSeats();
            alert(data.message + ' A receipt has been sent to your email.');
        } else {
            // Purchase failed (e.g., seats unavailable)
            alert(data.error || 'Purchase failed.');
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
            // Refresh seats to reflect current state
            await fetchSeats();
            updateSelectedSummary();
        }
    } catch (err) {
        console.error('Error during purchase:', err);
        alert('An error occurred during purchase.');
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
}

/**
 * Attach handlers for the checkout modal confirm and cancel buttons.
 */
function attachModalHandlers() {
    const modal = document.getElementById('checkout-modal');
    const confirmBtn = document.getElementById('confirm-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    confirmBtn.addEventListener('click', confirmPurchase);
    cancelBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);