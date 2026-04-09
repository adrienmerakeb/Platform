// lib/intimeHelpers.js
// Helpers for In-Time queues & bookings

import { getDb } from '../config/db.js';
import dotenv from 'dotenv';

dotenv.config();

// Base URL (kept for future use if you want URL-type QR payloads)
const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'http://localhost:3000';

/**
 * Convert a truthy/falsy value to SQLite-friendly INTEGER(0/1)
 */
export function toBoolInt(v) {
  return v ? 1 : 0;
}

/**
 * Generate a short random slug, e.g. "qabc123"
 */
export function randomSlug(prefix = 'q') {
  const body = Math.random().toString(36).slice(2, 8);
  return `${prefix}${body}`;
}

/**
 * Generate a raw 9-char code in the shape AAA-BBB-CCC
 * using A–Z and 0–9.
 */
export function generateCode9() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  function block() {
    let s = '';
    for (let i = 0; i < 3; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }

  return `${block()}-${block()}-${block()}`;
}

/**
 * Ensure uniqueness of the 9-char code by checking intime_bookings.code9
 * Loop is fine for small scale.
 */
export async function generateUniqueCode9(maxTries = 50) {
  const db = getDb();

  for (let i = 0; i < maxTries; i++) {
    const code = generateCode9();
    const existing = await db.get(
      'SELECT id FROM intime_bookings WHERE code9 = ?',
      code
    );
    if (!existing) return code;
  }

  throw new Error('Unable to generate unique code9 after many attempts');
}

/**
 * Build the booking payload encoded into a queue QR.
 *
 * This returns a JSON string, for example:
 * {
 *   "kind": "intime-queue",
 *   "queue_id": 1,
 *   "name": "My queue",
 *   "location": "Somewhere",
 *   "gps_lat": 50.0,
 *   "gps_lng": 14.0,
 *   "gps": "50.0,14.0"
 * }
 *
 * Your visitor scan page parses this JSON and extracts queue_id, name, location, gps…
 *
 * @param {Object} queue - row from intime_queues
 */
export function buildQueueQrPayload(queue) {
  if (!queue) {
    return JSON.stringify({ kind: 'intime-queue', error: 'missing_queue' });
  }

  // Basic GPS string, if available
  let gps = undefined;
  if (queue.gps_lat != null && queue.gps_lng != null) {
    gps = `${queue.gps_lat},${queue.gps_lng}`;
  }

  const payload = {
    kind: 'intime-queue',
    queue_id: queue.id,              // <— visitor scan cares about this
    name: queue.name || null,
    location: queue.location || null,
    gps_lat: queue.gps_lat ?? null,
    gps_lng: queue.gps_lng ?? null,
    gps: gps || null
    // You can add more metadata later if needed:
    // mode: queue.queue_mode,
    // capacity: queue.wave_capacity,
    // time_per_slot_minutes: queue.time_per_slot_minutes
  };

  return JSON.stringify(payload);
}

export default {
  toBoolInt,
  randomSlug,
  generateCode9,
  generateUniqueCode9,
  buildQueueQrPayload
};
