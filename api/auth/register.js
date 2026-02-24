const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const registerAttempts = new Map();

function checkRateLimit(ip) {
    const now = Date.now();
    const entry = registerAttempts.get(ip);
    if (!entry || now - entry.firstAttempt > RATE_LIMIT_WINDOW) {
        registerAttempts.set(ip, { count: 1, firstAttempt: now });
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
            return res.status(429).json({ error: 'Too many registration attempts. Please wait 15 minutes.' });
        }
        const { username, password } = req.body || {};

        if (!username || !password) {
            return res.status(400).json({ error: 'All fields required' });
        }

        const user = username.trim().toLowerCase();

        if (user.length < 3) {
            return res.status(400).json({ error: 'Username must be at least 3 characters.' });
        }
        if (!/^[a-z0-9_]+$/.test(user)) {
            return res.status(400).json({ error: 'Username: only letters, numbers and underscore.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const db = await connectToDatabase();
        const users = db.collection('users');

        const existing = await users.findOne({ username: user });
        if (existing) {
            return res.status(409).json({ error: 'Username already taken.' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(32).toString('hex');

        await users.insertOne({
            username: user,
            passwordHash,
            token,
            created: new Date(),
            lastLogin: new Date(),
            paid: false,
            testsCreated: 0,
        });

        // Create empty user data document
        await db.collection('userdata').insertOne({
            username: user,
            testHistory: [],
            questionStatus: {},
            notes: {},
            usedQuestions: [],
            performance: {},
            lastSync: new Date(),
        });

        return res.status(201).json({
            ok: true,
            username: user,
            token,
            paid: false,
            testsCreated: 0,
        });

    } catch (err) {
        console.error('Register error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};
