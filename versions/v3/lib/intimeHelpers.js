// lib/intimeHelpers.js
// Shared helpers for In-Time queues & bookings

import { getDB } from '../config/db.js';

const OAUTH_BASE_URL =
  process.env.OAUTH_BASE_URL || 'http://localhost:3000';

// -----------------------------------------------------------------------------
// Simple helpers
// -----------------------------------------------------------------------------

/**
 * Convert truthy/falsy values into 1/0 integers for SQLite.
 */
export function toBoolInt(v) {
  return v ? 1 : 0;
}

/**
 * Short random slug: e.g. qabc123
 */
export function randomSlug(prefix = 'q') {
  const body = Math.random().toString(36).slice(2, 8);
  return `${prefix}${body}`;
}

// -----------------------------------------------------------------------------
// Booking codes (AAA-BBB-CCC)
// -----------------------------------------------------------------------------

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateCodeBlock() {
  let s = '';
  for (let i = 0; i < 3; i++) {
    s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return s;
}

/**
 * Generate a 9-char code with dashes: AAA-BBB-CCC
 */
export function generateCode9() {
  return `${generateCodeBlock()}-${generateCodeBlock()}-${generateCodeBlock()}`;
}

/**
 * Generate a unique code9 not yet present in `intime_bookings.code9`.
 */
export async function generateUniqueCode9() {
  const db = getDB();
  while (true) {
    const code = generateCode9();
    const existing = await db.get(
      'SELECT id FROM intime_bookings WHERE code9 = ?',
      code
    );
    if (!existing) return code;
  }
}

// -----------------------------------------------------------------------------
// QR payload builder for queues
// -----------------------------------------------------------------------------

/**
 * Build the URL encoded into the queue QR code.
 * This is the URL of the visitor booking page, with queue info as query params.
 *
 * @param {object} queue
 * @param {number} queue.id
 * @param {string} [queue.name]
 * @param {string} [queue.location]
 * @param {number|null} [queue.gps_lat]
 * @param {number|null} [queue.gps_lng]
 * @returns {string} Full URL
 */
export function buildQueueQrPayload(queue) {
  const basePath = '/pages/visitor/VirtualQueueSpotBooking.html';
  const url = new URL(basePath, OAUTH_BASE_URL);

  url.searchParams.set('queueId', String(queue.id));
  // Keeping venueId same as queueId, as in original code
  url.searchParams.set('venueId', String(queue.id));

  if (queue.name) url.searchParams.set('name', queue.name);
  if (queue.location) url.searchParams.set('addr', queue.location);

  if (queue.gps_lat != null && queue.gps_lng != null) {
    url.searchParams.set('gps', `${queue.gps_lat},${queue.gps_lng}`);
  }

  return url.toString();
}
