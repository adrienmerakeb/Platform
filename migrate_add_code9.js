// migrate_add_code9.js
// One-off migration to add `code9` column to intime_bookings WITHOUT UNIQUE constraint.

import { getDb } from './config/db.js';

async function run() {
  try {
    const db = getDb();

    console.log('Checking intime_bookings columns...');
    const cols = await db.all('PRAGMA table_info(intime_bookings)');
    console.log('Current columns:', cols.map(c => c.name));

    const hasCode9 = cols.some(
      (c) => String(c.name).toLowerCase() === 'code9'
    );

    if (hasCode9) {
      console.log('✅ Column `code9` already exists. Nothing to do.');
      return;
    }

    console.log('Adding column `code9` (TEXT) to intime_bookings...');
    // IMPORTANT: no UNIQUE here — SQLite doesn't allow UNIQUE in ADD COLUMN
    await db.exec('ALTER TABLE intime_bookings ADD COLUMN code9 TEXT;');

    const colsAfter = await db.all('PRAGMA table_info(intime_bookings)');
    console.log('Columns after migration:', colsAfter.map(c => c.name));

    console.log('✅ Migration complete: `code9` column added as TEXT.');
  } catch (err) {
    console.error('❌ Migration error:', err);
  } finally {
    setTimeout(() => process.exit(0), 200);
  }
}

run();
