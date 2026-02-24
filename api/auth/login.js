const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10; // max attempts per window
const loginAttempts = new Map(); // IP -> { count, firstAttempt }

function checkRateLimit(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || now - entry.firstAttempt > RATE_LIMIT_WINDOW) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
        return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
}

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', 'https://usmleqbank.vercel.app');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        // Rate limiting
        const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
        if (!checkRateLimit(ip)) {
            return res.status(429).json({ error: 'Too many login attempts. Please wait 15 minutes.' });
        }

        const { username, password } = req.body || {};

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const user = username.trim().toLowerCase();

        const db = await connectToDatabase();
        const users = db.collection('users');

        const existing = await users.findOne({ username: user });
        if (!existing) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const valid = await bcrypt.compare(password, existing.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        // Generate new session token with expiry
        const token = crypto.randomBytes(32).toString('hex');
        const tokenCreatedAt = new Date();
        await users.updateOne(
            { username: user },
            { $set: { token, tokenCreatedAt, lastLogin: new Date() } }
        );

        return res.status(200).json({
            ok: true,
            username: user,
            token,
            paid: !!existing.paid,
            testsCreated: existing.testsCreated || 0,
        });

    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};
