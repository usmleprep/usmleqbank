const { connectToDatabase } = require('../db');
const Stripe = require('stripe');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { sessionId } = req.body || {};
        if (!sessionId) {
            return res.status(400).json({ error: 'Missing sessionId' });
        }

        // Verify user token
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const token = authHeader.slice(7);
        const db = await connectToDatabase();
        const user = await db.collection('users').findOne({ token });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });

        if (user.paid) {
            return res.status(200).json({ ok: true, paid: true });
        }

        // Verify the Stripe session
        const stripe = new Stripe((process.env.STRIPE_SECRET_KEY || '').trim());
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid' && session.metadata?.username === user.username) {
            await db.collection('users').updateOne(
                { username: user.username },
                {
                    $set: {
                        paid: true,
                        paymentDate: new Date(),
                        stripeSessionId: session.id,
                        stripePaymentIntent: session.payment_intent,
                    }
                }
            );
            console.log(`✅ Payment confirmed for user: ${user.username}`);
            return res.status(200).json({ ok: true, paid: true });
        }

        return res.status(400).json({ error: 'Payment not completed', status: session.payment_status });

    } catch (err) {
        console.error('Verify payment error:', err);
        return res.status(500).json({ error: 'Could not verify payment' });
    }
};
