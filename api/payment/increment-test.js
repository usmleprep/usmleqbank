const { connectToDatabase } = require('../db');

async function verifyToken(db, authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    if (!token) return null;
    const user = await db.collection('users').findOne({ token });
    return user || null;
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const db = await connectToDatabase();
        const user = await verifyToken(db, req.headers.authorization);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Increment testsCreated counter
        const result = await db.collection('users').findOneAndUpdate(
            { username: user.username },
            { $inc: { testsCreated: 1 } },
            { returnDocument: 'after' }
        );

        const updated = result.value || result;
        return res.status(200).json({
            ok: true,
            testsCreated: updated.testsCreated || 1,
            paid: !!updated.paid,
        });
    } catch (err) {
        console.error('Increment test error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};
