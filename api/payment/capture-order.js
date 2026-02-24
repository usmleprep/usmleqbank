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
        const { orderId } = req.body || {};
        if (!orderId) {
            return res.status(400).json({ error: 'Missing orderId' });
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

        // Check if already paid
        if (user.paid) {
            return res.status(200).json({ ok: true, paid: true, message: 'Already paid' });
        }

        // Verify the order ID matches what we stored
        if (user.pendingPayPalOrderId && user.pendingPayPalOrderId !== orderId) {
            return res.status(400).json({ error: 'Order ID mismatch' });
        }

        const base = (process.env.PAYPAL_API_BASE || 'https://api-m.paypal.com').trim();
        const accessToken = await getPayPalAccessToken();

        // Capture the order
        const captureRes = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });

        const captureData = await captureRes.json();

        if (captureData.status === 'COMPLETED') {
            // Payment successful — mark user as paid
            const captureId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.id;

            await db.collection('users').updateOne(
                { username: user.username },
                {
                    $set: {
                        paid: true,
                        paymentDate: new Date(),
                        paypalOrderId: orderId,
                        paypalCaptureId: captureId || null,
                    },
                    $unset: { pendingPayPalOrderId: '' },
                }
            );

            console.log(`✅ PayPal payment confirmed for user: ${user.username}`);
            return res.status(200).json({ ok: true, paid: true });
        }

        // If already captured (e.g. duplicate call)
        if (captureData.status === 'ALREADY_CAPTURED' || captureData.name === 'UNPROCESSABLE_ENTITY') {
            // Check if the order was already completed
            const checkRes = await fetch(`${base}/v2/checkout/orders/${orderId}`, {
                headers: { 'Authorization': `Bearer ${accessToken}` },
            });
            const checkData = await checkRes.json();

            if (checkData.status === 'COMPLETED') {
                await db.collection('users').updateOne(
                    { username: user.username },
                    {
                        $set: { paid: true, paymentDate: new Date(), paypalOrderId: orderId },
                        $unset: { pendingPayPalOrderId: '' },
                    }
                );
                return res.status(200).json({ ok: true, paid: true });
            }
        }

        console.error('PayPal capture failed:', captureData);
        return res.status(400).json({
            error: 'Payment was not completed. Please try again.',
            details: captureData.message || captureData.status,
        });

    } catch (err) {
        console.error('PayPal capture-order error:', err);
        return res.status(500).json({ error: 'Could not process payment' });
    }
};
