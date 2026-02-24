const { connectToDatabase } = require('../db');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { username, secret } = req.body || {};
        if (secret !== 'reset_usmle_2026') {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (!username) return res.status(400).json({ error: 'Missing username' });

        const db = await connectToDatabase();
        const result = await db.collection('users').updateOne(
            { username },
            {
                $set: { paid: false, testsCreated: 0 },
                $unset: { stripeSessionId: '', stripePaymentIntent: '', stripeCustomerId: '', paymentDate: '' }
            }
        );

        return res.status(200).json({ ok: true, modified: result.modifiedCount });
    } catch (err) {
        console.error('Reset error:', err);
        return res.status(500).json({ error: err.message });
    }
};
