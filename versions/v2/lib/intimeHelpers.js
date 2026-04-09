// lib/intimeHelpers.js
const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'http://localhost:3000';

export function toBoolInt(v) {
  return v ? 1 : 0;
}

export function randomSlug(prefix = 'q') {
  const body = Math.random().toString(36).slice(2, 8);
  return `${prefix}${body}`;
}

// AAA-BBB-CCC from letters + digits
function generateCode9() {
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

export async function generateUniqueCode9(db) {
  while (true) {
    const code = generateCode9();
    const existing = await db.get(
      'SELECT id FROM intime_bookings WHERE code9 = ?',
      code
    );
    if (!existing) return code;
  }
}

// URL that goes into queue QR
export function buildQueueQrPayload(queue) {
  const basePath = '/pages/visitor/VirtualQueueSpotBooking.html';
  const url = new URL(basePath, OAUTH_BASE_URL);
  url.searchParams.set('queueId', String(queue.id));
  url.searchParams.set('venueId', String(queue.id));
  if (queue.name) url.searchParams.set('name', queue.name);
  if (queue.location) url.searchParams.set('addr', queue.location);
  if (queue.gps_lat != null && queue.gps_lng != null) {
    url.searchParams.set('gps', `${queue.gps_lat},${queue.gps_lng}`);
  }
  return url.toString();
}
