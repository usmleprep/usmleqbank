const { connectToDatabase } = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
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
        if (password.length < 4) {
            return res.status(400).json({ error: 'Password must be at least 4 characters.' });
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
