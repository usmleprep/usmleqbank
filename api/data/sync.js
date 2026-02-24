const { connectToDatabase } = require('../db');

// Verify token helper (72h expiry)
const TOKEN_MAX_AGE_MS = 72 * 60 * 60 * 1000;
async function verifyToken(db, authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    if (!token) return null;
    const user = await db.collection('users').findOne({ token });
    if (!user) return null;
    if (user.tokenCreatedAt && (Date.now() - new Date(user.tokenCreatedAt).getTime() > TOKEN_MAX_AGE_MS)) return null;
    return user.username;
}

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', 'https://usmleqbank.vercel.app');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const db = await connectToDatabase();
        const username = await verifyToken(db, req.headers.authorization);
        if (!username) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const col = db.collection('userdata');

        // ===== GET — Load user data =====
        if (req.method === 'GET') {
            const data = await col.findOne({ username });
            if (!data) {
                return res.status(200).json({
                    testHistory: [],
                    questionStatus: {},
                    notes: {},
                    usedQuestions: [],
                    performance: {},
                });
            }
            return res.status(200).json({
                testHistory: data.testHistory || [],
                questionStatus: data.questionStatus || {},
                notes: data.notes || {},
                usedQuestions: data.usedQuestions || [],
                performance: data.performance || {},
                lastSync: data.lastSync,
            });
        }

        // ===== POST — Save user data =====
        if (req.method === 'POST') {
            // Payload size validation (max 5MB)
            const rawBody = JSON.stringify(req.body || {});
            if (rawBody.length > 5 * 1024 * 1024) {
                return res.status(413).json({ error: 'Payload too large' });
            }

            const { testHistory, questionStatus, notes, usedQuestions, performance } = req.body || {};

            // Type validation
            if (testHistory !== undefined && !Array.isArray(testHistory)) return res.status(400).json({ error: 'Invalid testHistory' });
            if (questionStatus !== undefined && (typeof questionStatus !== 'object' || Array.isArray(questionStatus))) return res.status(400).json({ error: 'Invalid questionStatus' });
            if (notes !== undefined && (typeof notes !== 'object' || Array.isArray(notes))) return res.status(400).json({ error: 'Invalid notes' });
            if (usedQuestions !== undefined && !Array.isArray(usedQuestions)) return res.status(400).json({ error: 'Invalid usedQuestions' });
            if (performance !== undefined && (typeof performance !== 'object' || Array.isArray(performance))) return res.status(400).json({ error: 'Invalid performance' });

            const update = { lastSync: new Date() };
            if (testHistory !== undefined) update.testHistory = testHistory;
            if (questionStatus !== undefined) update.questionStatus = questionStatus;
            if (notes !== undefined) update.notes = notes;
            if (usedQuestions !== undefined) update.usedQuestions = usedQuestions;
            if (performance !== undefined) update.performance = performance;

            await col.updateOne(
                { username },
                { $set: update },
                { upsert: true }
            );

            return res.status(200).json({ ok: true, lastSync: update.lastSync });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (err) {
        console.error('Data sync error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};
