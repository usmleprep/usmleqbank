const { connectToDatabase } = require('../db');
const Stripe = require('stripe');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const stripe = new Stripe((process.env.STRIPE_SECRET_KEY || '').trim());

        // Verify user token
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const token = authHeader.slice(7);
        const db = await connectToDatabase();
        const user = await db.collection('users').findOne({ token });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });

        // Check if already paid
        if (user.paid) {
            return res.status(400).json({ error: 'You already have full access!' });
        }

        // Get or create Stripe customer
        let customerId = user.stripeCustomerId;
        if (!customerId) {
            const customer = await stripe.customers.create({
                metadata: { username: user.username },
            });
            customerId = customer.id;
            await db.collection('users').updateOne(
                { username: user.username },
                { $set: { stripeCustomerId: customerId } }
            );
        }

        // Create Checkout Session
        const origin = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || 'https://usmleqbank.vercel.app';

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'USMLE Step 1 QBank — Lifetime Access',
                        description: 'Full access to 3,600+ USMLE Step 1 practice questions',
                    },
                    unit_amount: 2000, // $20.00
                },
                quantity: 1,
            }],
            success_url: `${origin}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}?payment=cancelled`,
            metadata: { username: user.username },
        });

        return res.status(200).json({ ok: true, url: session.url });

    } catch (err) {
        console.error('Checkout error:', err);
        return res.status(500).json({ error: 'Could not create checkout session' });
    }
};
