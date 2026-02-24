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
            return res.status(400).json({ error: 'Username and password required' });
        }

        const user = username.trim().toLowerCase();

        const db = await connectToDatabase();
        const users = db.collection('users');

        const existing = await users.findOne({ username: user });
        if (!existing) {
            return res.status(401).json({ error: 'User not found. Create an account first.' });
        }

        const valid = await bcrypt.compare(password, existing.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: 'Incorrect password.' });
        }

        // Generate new session token
        const token = crypto.randomBytes(32).toString('hex');
        await users.updateOne(
            { username: user },
            { $set: { token, lastLogin: new Date() } }
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
