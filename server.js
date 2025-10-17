// Simple Node.js server for the concert ticketing application.
// This server handles user registration with email verification, user login,
// seat management for 250 seats, and purchase processing. It also simulates
// sending emails by writing messages to the `emails` directory.

const http = require('http');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');
const SEATS_FILE = path.join(__dirname, 'seats.json');
const EMAILS_DIR = path.join(__dirname, 'emails');

// Ensure the emails directory exists
if (!fs.existsSync(EMAILS_DIR)) {
    fs.mkdirSync(EMAILS_DIR);
}

/**
 * Read the users JSON file. If it doesn't exist, return an empty array.
 * @returns {Array}
 */
function readUsers() {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
}

/**
 * Save the users array to disk.
 * @param {Array} users
 */
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

/**
 * Read the seats JSON file. If it doesn't exist, generate the initial seats and save.
 * @returns {Array}
 */
function readSeats() {
    try {
        const data = fs.readFileSync(SEATS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        // Generate 250 seats: rows A-J (10 rows) and columns 1-25
        const seats = [];
        const VIP_ROWS = ['A', 'B'];
        const VIP_PRICE = 100;
        const REG_PRICE = 50;
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        for (let i = 0; i < 10; i++) {
            const rowLabel = alphabet[i];
            for (let j = 1; j <= 25; j++) {
                const id = `${rowLabel}${j}`;
                const isVip = VIP_ROWS.includes(rowLabel);
                seats.push({
                    id,
                    row: rowLabel,
                    number: j,
                    price: isVip ? VIP_PRICE : REG_PRICE,
                    status: 'available'
                });
            }
        }
        fs.writeFileSync(SEATS_FILE, JSON.stringify(seats, null, 2));
        return seats;
    }
}

/**
 * Save the seats array to disk.
 * @param {Array} seats
 */
function saveSeats(seats) {
    fs.writeFileSync(SEATS_FILE, JSON.stringify(seats, null, 2));
}

/**
 * Simulate sending an email by writing the contents to a file.
 * The filename includes the email address and timestamp.
 * @param {string} email
 * @param {string} subject
 * @param {string} message
 */
function sendEmail(email, subject, message) {
    const safeName = email.replace(/[^a-zA-Z0-9@.]/g, '_');
    const filename = `${safeName}-${Date.now()}.txt`;
    const fullPath = path.join(EMAILS_DIR, filename);
    const content = `To: ${email}\nSubject: ${subject}\n\n${message}`;
    fs.writeFileSync(fullPath, content);
}

/**
 * Handle incoming requests.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function requestHandler(req, res) {
    // Enable CORS for all requests (helpful during development)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    if (req.method === 'GET' && req.url === '/seats') {
        const seats = readSeats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(seats));
        return;
    }
    if (req.method === 'POST' && ['register', 'verify', 'login', 'purchase'].some(ep => req.url.startsWith(`/${ep}`))) {
        // Collect request body
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            let payload;
            try {
                payload = JSON.parse(body);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
                return;
            }
            const users = readUsers();
            const seats = readSeats();
            if (req.url === '/register') {
                const email = (payload.email || '').trim().toLowerCase();
                if (!email) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Email is required' }));
                    return;
                }
                let user = users.find(u => u.email === email);
                if (user) {
                    if (user.verified) {
                        // Already registered and verified; let them log in directly
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message: 'Already registered' }));
                        return;
                    } else {
                        // Re-register; generate new code and send
                        const code = Math.floor(100000 + Math.random() * 900000).toString();
                        user.code = code;
                        saveUsers(users);
                        sendEmail(email, 'Verification Code', `Your verification code is: ${code}`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        // Do not include the code in the response; instruct user to check email
                        res.end(JSON.stringify({ message: 'Verification code resent' }));
                        return;
                    }
                } else {
                    const code = Math.floor(100000 + Math.random() * 900000).toString();
                    user = { email, code, verified: false, purchases: [] };
                    users.push(user);
                    saveUsers(users);
                    sendEmail(email, 'Verification Code', `Your verification code is: ${code}`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    // Do not include the code in the response; instruct user to check email
                    res.end(JSON.stringify({ message: 'Registration successful' }));
                    return;
                }
            }
            if (req.url === '/verify') {
                const { email, code } = payload;
                const emailLower = (email || '').trim().toLowerCase();
                const user = users.find(u => u.email === emailLower);
                if (!user) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'User not found' }));
                    return;
                }
                if (user.verified) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'Already verified' }));
                    return;
                }
                if (user.code === code) {
                    user.verified = true;
                    user.code = null;
                    saveUsers(users);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'Verification successful' }));
                    return;
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Incorrect verification code' }));
                    return;
                }
            }
            if (req.url === '/login') {
                const email = (payload.email || '').trim().toLowerCase();
                const user = users.find(u => u.email === email);
                if (!user) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'User not found. Please register first.' }));
                    return;
                }
                if (!user.verified) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'User not verified. Please check your email and verify.' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Login successful' }));
                return;
            }
            if (req.url === '/purchase') {
                const { email, seats: seatIds } = payload;
                const emailLower = (email || '').trim().toLowerCase();
                const user = users.find(u => u.email === emailLower);
                if (!user || !user.verified) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'User not found or not verified' }));
                    return;
                }
                if (!Array.isArray(seatIds) || seatIds.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'No seats selected' }));
                    return;
                }
                // Check availability and mark as sold
                const unavailable = [];
                seatIds.forEach(id => {
                    const seat = seats.find(s => s.id === id);
                    if (!seat || seat.status !== 'available') {
                        unavailable.push(id);
                    }
                });
                if (unavailable.length > 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Seats unavailable: ${unavailable.join(', ')}` }));
                    return;
                }
                // All seats available; mark them as sold
                seatIds.forEach(id => {
                    const seat = seats.find(s => s.id === id);
                    seat.status = 'sold';
                });
                saveSeats(seats);
                // Record purchase
                const purchaseRecord = { seats: seatIds, timestamp: Date.now() };
                if (!Array.isArray(user.purchases)) user.purchases = [];
                user.purchases.push(purchaseRecord);
                saveUsers(users);
                // Compose email message
                const total = seatIds.reduce((sum, id) => {
                    const seat = seats.find(s => s.id === id);
                    return sum + (seat ? seat.price : 0);
                }, 0);
                const message = `Thank you for your purchase.\n\nYou have purchased seats: ${seatIds.join(', ')}.\nTotal price: $${total}.\nEnjoy the concert!`;
                sendEmail(emailLower, 'Your Concert Ticket Receipt', message);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Purchase successful' }));
                return;
            }
        });
        return;
    }
    // Serve static files from ticket_website directory
    if (req.method === 'GET') {
        // Normalize the URL to prevent directory traversal attacks
        let filePath = req.url;
        if (filePath === '/') {
            filePath = '/index.html';
        }
        const resolvedPath = path.join(__dirname, filePath);
        // Prevent access outside of the ticket_website directory
        if (!resolvedPath.startsWith(__dirname)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        fs.readFile(resolvedPath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            const ext = path.extname(resolvedPath).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html',
                '.css': 'text/css',
                '.js': 'application/javascript',
                '.json': 'application/json',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.txt': 'text/plain'
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
        return;
    }
    // If none of the above, return 404
    res.writeHead(404);
    res.end('Not found');
}

// Start the HTTP server
const PORT = process.env.PORT || 3000;
const server = http.createServer(requestHandler);
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});