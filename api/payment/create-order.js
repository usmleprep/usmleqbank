const { connectToDatabase } = require('../db');

// PayPal REST API helper
async function getPayPalAccessToken() {
    const clientId = (process.env.PAYPAL_CLIENT_ID || '').trim();
    const secret = (process.env.PAYPAL_SECRET || '').trim();
    const base = (process.env.PAYPAL_API_BASE || 'https://api-m.paypal.com').trim();

    const res = await fetch(`${base}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
    });

    const data = await res.json();
    if (!data.access_token) throw new Error('Failed to get PayPal access token');
    return data.access_token;
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
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

        const origin = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || 'https://usmleqbank.vercel.app';
        const base = (process.env.PAYPAL_API_BASE || 'https://api-m.paypal.com').trim();
        const accessToken = await getPayPalAccessToken();

        // Create PayPal order
        const orderRes = await fetch(`${base}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: {
                        currency_code: 'USD',
                        value: '20.00',
                    },
                    description: 'USMLE Step 1 QBank — Lifetime Access',
                    custom_id: user.username,
                }],
                application_context: {
                    brand_name: 'USMLE QBank',
                    landing_page: 'NO_PREFERENCE',
                    user_action: 'PAY_NOW',
                    return_url: `${origin}?payment=capture`,
                    cancel_url: `${origin}?payment=cancelled`,
                },
            }),
        });

        const order = await orderRes.json();

        if (order.id) {
            // Store order ID linked to user for later capture verification
            await db.collection('users').updateOne(
                { username: user.username },
                { $set: { pendingPayPalOrderId: order.id } }
            );

            // Find the approval link
            const approveLink = order.links?.find(l => l.rel === 'approve');
            if (approveLink) {
                return res.status(200).json({ ok: true, url: approveLink.href, orderId: order.id });
            }
        }

        console.error('PayPal order creation failed:', order);
        return res.status(500).json({ error: 'Failed to create PayPal order' });

    } catch (err) {
        console.error('PayPal create-order error:', err);
        return res.status(500).json({ error: 'Could not create payment order' });
    }
};
