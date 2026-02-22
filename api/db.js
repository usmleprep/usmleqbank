const { MongoClient } = require('mongodb');

let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
    if (cachedDb) return cachedDb;

    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI not set');

    const client = new MongoClient(uri);
    await client.connect();
    cachedClient = client;
    cachedDb = client.db('usmleqbank');
    return cachedDb;
}

module.exports = { connectToDatabase };
