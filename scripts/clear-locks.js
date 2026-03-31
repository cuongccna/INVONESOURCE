// Utility: clear stale sync locks & unblock companies
const Redis = require('ioredis');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    // 1. Find and delete all sync locks
    const botKeys = await redis.keys('bot:sync:lock:*');
    const syncKeys = await redis.keys('sync:lock:*');
    console.log('Bot locks:', botKeys);
    console.log('Sync locks:', syncKeys);
    const allKeys = [...botKeys, ...syncKeys];
    if (allKeys.length > 0) {
      const del = await redis.del(...allKeys);
      console.log(`Deleted ${del} lock(s)`);
    } else {
      console.log('No stale locks found');
    }

    // 2. Unblock all companies
    const res = await pool.query(
      `UPDATE gdt_bot_configs SET blocked_until = NULL, consecutive_failures = 0 WHERE blocked_until IS NOT NULL RETURNING company_id`
    );
    if (res.rows.length > 0) {
      console.log(`Unblocked ${res.rows.length} companies:`, res.rows.map(r => r.company_id));
    } else {
      console.log('No blocked companies');
    }
  } catch (err) {
    console.error(err);
  } finally {
    redis.disconnect();
    await pool.end();
  }
})();
