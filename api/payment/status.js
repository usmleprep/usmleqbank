const { connectToDatabase } = require('../db');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const token = authHeader.slice(7);
        const db = await connectToDatabase();
        const user = await db.collection('users').findOne({ token });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });

        return res.status(200).json({
            ok: true,
            paid: !!user.paid,
            testsCreated: user.testsCreated || 0,
            freeTestsLimit: 2,
            paymentDate: user.paymentDate || null,
        });

    } catch (err) {
        console.error('Payment status error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};
