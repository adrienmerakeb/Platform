// check_code9.js
import { getDb } from './config/db.js';

const db = getDb();

const run = async () => {
  const cols = await db.all('PRAGMA table_info(intime_bookings)');
  console.log('intime_bookings columns:', cols.map(c => c.name));
  process.exit(0);
};

run().catch(err => {
  console.error('Error checking schema:', err);
  process.exit(1);
});
