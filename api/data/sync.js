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

        // ===== POST — Save user data (with server-side merge) =====
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

            // Load existing server data for merge
            const existing = await col.findOne({ username }) || {};
            const update = { lastSync: new Date() };

            // Merge testHistory: union by test id (never lose tests)
            if (testHistory !== undefined) {
                const serverTests = existing.testHistory || [];
                const merged = [...serverTests];
                const serverIds = new Set(serverTests.map(t => t.id));
                for (const t of testHistory) {
                    if (!serverIds.has(t.id)) {
                        merged.push(t);
                    } else {
                        // Update existing test if client version is completed and server isn't
                        const idx = merged.findIndex(st => st.id === t.id);
                        if (idx >= 0 && t.completed && !merged[idx].completed) {
                            merged[idx] = t;
                        } else if (idx >= 0 && t.completed && merged[idx].completed) {
                            // Both completed — keep the one with more answers
                            const clientAnswers = t.answers ? Object.keys(t.answers).length : 0;
                            const serverAnswers = merged[idx].answers ? Object.keys(merged[idx].answers).length : 0;
                            if (clientAnswers > serverAnswers) merged[idx] = t;
                        }
                    }
                }
                update.testHistory = merged;
            }

            // Merge questionStatus: keep answered=true entries, prefer more complete data
            if (questionStatus !== undefined) {
                const serverQS = existing.questionStatus || {};
                const mergedQS = { ...serverQS };
                for (const qid of Object.keys(questionStatus)) {
                    if (!mergedQS[qid]) {
                        mergedQS[qid] = questionStatus[qid];
                    } else if (questionStatus[qid].answered && !mergedQS[qid].answered) {
                        mergedQS[qid] = questionStatus[qid];
                    }
                }
                update.questionStatus = mergedQS;
            }

            // Merge notes: never delete notes
            if (notes !== undefined) {
                const serverNotes = existing.notes || {};
                update.notes = { ...serverNotes, ...notes };
            }

            // Merge usedQuestions: union
            if (usedQuestions !== undefined) {
                const serverUsed = existing.usedQuestions || [];
                update.usedQuestions = [...new Set([...serverUsed, ...usedQuestions])];
            }

            // Merge performance: keep both, client wins for same key
            if (performance !== undefined) {
                const serverPerf = existing.performance || {};
                update.performance = { ...serverPerf, ...performance };
            }

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
