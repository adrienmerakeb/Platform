// add_code9_manual.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DB_FILE    = path.join(__dirname, 'auth.db');

async function run() {
  const db = await open({ filename: DB_FILE, driver: sqlite3.Database });

  try {
    const cols = await db.all('PRAGMA table_info(intime_bookings)');
    const names = cols.map(c => c.name);
    console.log('Current intime_bookings columns:', names);

    if (names.includes('code9')) {
      console.log('✅ Column `code9` already exists, nothing to do.');
      return;
    }

    console.log('➕ Adding column `code9` (TEXT, not UNIQUE)…');
    await db.exec('ALTER TABLE intime_bookings ADD COLUMN code9 TEXT;');
    console.log('✅ Column `code9` added successfully.');
  } catch (err) {
    console.error('❌ Error during manual migration:', err);
  } finally {
    await db.close();
  }
}

run();
