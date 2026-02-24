const { connectToDatabase } = require('../db');

const ADMIN_USERNAME = 'ricardo';
const TOKEN_MAX_AGE_MS = 72 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://usmleqbank.vercel.app');
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
        const admin = await db.collection('users').findOne({ token });
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        // Token expiry
        if (admin.tokenCreatedAt && (Date.now() - new Date(admin.tokenCreatedAt).getTime() > TOKEN_MAX_AGE_MS)) {
            return res.status(401).json({ error: 'Session expired' });
        }

        // Only admin can access
        if (admin.username !== ADMIN_USERNAME) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // Fetch all users (exclude sensitive fields)
        const users = await db.collection('users').find({}, {
            projection: {
                _id: 0,
                username: 1,
                paid: 1,
                testsCreated: 1,
                createdAt: 1,
                tokenCreatedAt: 1,
                paymentDate: 1,
                stripeCustomerId: 1,
            }
        }).toArray();

        // Fetch userdata for last sync times
        const userdata = await db.collection('userdata').find({}, {
            projection: {
                _id: 0,
                username: 1,
                lastSync: 1,
                testHistory: 1,
            }
        }).toArray();

        const userdataMap = {};
        for (const ud of userdata) {
            userdataMap[ud.username] = {
                lastSync: ud.lastSync || null,
                totalTests: (ud.testHistory || []).length,
                totalQuestions: (ud.testHistory || []).reduce((sum, t) => sum + (t.totalQuestions || t.questions?.length || 0), 0),
            };
        }

        // Merge and build response
        const result = users.map(u => {
            const ud = userdataMap[u.username] || {};
            const lastActivity = u.tokenCreatedAt || u.createdAt || null;
            const now = Date.now();
            const isOnline = lastActivity && (now - new Date(lastActivity).getTime() < TOKEN_MAX_AGE_MS);

            return {
                username: u.username,
                paid: !!u.paid,
                testsCreated: u.testsCreated || 0,
                registeredAt: u.createdAt || null,
                lastLogin: u.tokenCreatedAt || null,
                lastSync: ud.lastSync || null,
                totalTests: ud.totalTests || 0,
                totalQuestions: ud.totalQuestions || 0,
                paymentDate: u.paymentDate || null,
                isActive: !!isOnline,
            };
        });

        // Sort: active first, then by last login descending
        result.sort((a, b) => {
            if (a.isActive !== b.isActive) return b.isActive - a.isActive;
            const aTime = a.lastLogin ? new Date(a.lastLogin).getTime() : 0;
            const bTime = b.lastLogin ? new Date(b.lastLogin).getTime() : 0;
            return bTime - aTime;
        });

        return res.status(200).json({
            ok: true,
            totalUsers: result.length,
            paidUsers: result.filter(u => u.paid).length,
            activeUsers: result.filter(u => u.isActive).length,
            users: result,
        });

    } catch (err) {
        console.error('Admin users error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};
