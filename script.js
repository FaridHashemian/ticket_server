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
function registerUser() {
    const emailInput = document.getElementById('email-input');
    const email = emailInput.value.trim().toLowerCase();
    const authMessage = document.getElementById('auth-message');
    authMessage.textContent = '';
    if (!email) {
        authMessage.textContent = 'Please enter a valid email address.';
        return;
    }
    // Load existing users from localStorage
    const users = loadUsers();
    let user = users.find(u => u.email === email);
    if (user && user.verified) {
        authMessage.textContent = 'This email is already registered and verified. Please log in.';
        return;
    }
    // Generate a 6‑digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    if (user) {
        user.code = code;
    } else {
        user = { email, code, verified: false, purchases: [] };
        users.push(user);
    }
    saveUsers(users);
    currentEmail = email;
    showVerificationSection();
    const verificationInfo = document.getElementById('verification-info');
    verificationInfo.textContent = `A verification code has been sent to your email. (For demo purposes, your code is ${code}).`;
}

/**
 * Verify a user's email with the provided code. Sends a POST request to /verify.
 * On success, logs the user in.
 */
function verifyUser() {
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
    const users = loadUsers();
    const user = users.find(u => u.email === currentEmail);
    if (!user) {
        verificationMessage.textContent = 'User not found. Please register again.';
        return;
    }
    if (user.verified) {
        // Already verified
        loginSuccess(currentEmail);
        return;
    }
    if (user.code === code) {
        user.verified = true;
        user.code = null;
        saveUsers(users);
        loginSuccess(currentEmail);
    } else {
        verificationMessage.textContent = 'Incorrect verification code.';
    }
}

/**
 * Log in a user with an existing verified email. Sends a POST request to /login.
 */
function loginUser() {
    const emailInput = document.getElementById('email-input');
    const email = emailInput.value.trim().toLowerCase();
    const authMessage = document.getElementById('auth-message');
    authMessage.textContent = '';
    if (!email) {
        authMessage.textContent = 'Please enter a valid email address.';
        return;
    }
    const users = loadUsers();
    const user = users.find(u => u.email === email);
    if (!user) {
        authMessage.textContent = 'User not found. Please register first.';
        return;
    }
    if (!user.verified) {
        authMessage.textContent = 'User not verified. Please check your email and verify.';
        return;
    }
    // Login successful
    currentEmail = email;
    loginSuccess(email);
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
    // Load seats from localStorage
    loadSeatsFromStorage();
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
function fetchSeats() {
    // This function is unused in localStorage version but kept for compatibility
    loadSeatsFromStorage();
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
function confirmPurchase() {
    if (!currentEmail || selectedSeatIds.length === 0) {
        return;
    }
    // Load seats and users from storage
    const seatsData = seats; // already loaded in memory
    const users = loadUsers();
    const user = users.find(u => u.email === currentEmail);
    if (!user || !user.verified) {
        alert('User not found or not verified.');
        return;
    }
    // Check if any selected seats are already sold
    const unavailable = [];
    selectedSeatIds.forEach(id => {
        const seat = seatsData.find(s => s.id === id);
        if (!seat || seat.status !== 'available') {
            unavailable.push(id);
        }
    });
    const modal = document.getElementById('checkout-modal');
    if (unavailable.length > 0) {
        alert(`Seats unavailable: ${unavailable.join(', ')}`);
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        return;
    }
    // Mark seats as sold
    selectedSeatIds.forEach(id => {
        const seat = seatsData.find(s => s.id === id);
        if (seat) seat.status = 'sold';
    });
    saveSeatsToStorage(seatsData);
    // Record purchase for user
    if (!Array.isArray(user.purchases)) user.purchases = [];
    user.purchases.push({ seats: selectedSeatIds.slice(), timestamp: Date.now() });
    saveUsers(users);
    // Clear selections and refresh UI
    selectedSeatIds = [];
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    renderSeatMap();
    updateAvailableCount();
    updateSelectedSummary();
    alert('Purchase successful! A receipt has been sent to your email.');
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