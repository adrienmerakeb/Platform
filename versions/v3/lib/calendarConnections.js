// lib/calendarConnections.js
// DB helpers for calendar_connections + Google Calendar booking sync

import { getDB } from '../config/db.js';
import { getGoogleOAuth2Client, google } from '../config/googleCalendar.js';

let db;
function ensureDB() {
  if (!db) db = getDB();
  return db;
}

/**
 * Create or update a calendar connection for a host.
 *
 * @param {object} params
 * @param {number} params.hostId
 * @param {string} params.provider - 'google', 'ms', etc.
 * @param {string} [params.externalId] - provider account id
 * @param {string} [params.email] - calendar account email
 * @param {object} [params.token] - OAuth token object from provider
 */
export async function upsertCalendarConnection({
  hostId,
  provider,
  externalId,
  email,
  token
}) {
  const db = ensureDB();
  const prov = String(provider || '').toLowerCase();

  const existing = await db.get(
    `SELECT id FROM calendar_connections
     WHERE host_id = ? AND provider = ?`,
    [hostId, prov]
  );

  const tokenType = token?.token_type || null;
  const scope = Array.isArray(token?.scope)
    ? token.scope.join(' ')
    : token?.scope || null;
  const expiryDate = token?.expiry_date ? Number(token.expiry_date) : null;

  if (existing) {
    await db.run(
      `UPDATE calendar_connections
         SET external_id = ?,
             email = ?,
             access_token = ?,
             refresh_token = ?,
             token_type = ?,
             scope = ?,
             expiry_date = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        externalId || null,
        email || null,
        token?.access_token || null,
        token?.refresh_token || null,
        tokenType,
        scope,
        expiryDate,
        existing.id
      ]
    );
    return existing.id;
  }

  const result = await db.run(
    `INSERT INTO calendar_connections
       (host_id, provider, external_id, email,
        access_token, refresh_token, token_type, scope, expiry_date)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      hostId,
      prov,
      externalId || null,
      email || null,
      token?.access_token || null,
      token?.refresh_token || null,
      tokenType,
      scope,
      expiryDate
    ]
  );
  return result.lastID;
}

/**
 * Retrieve a host's calendar connection for the given provider.
 *
 * @param {number} hostId
 * @param {string} [provider='google']
 */
export async function getHostCalendarConnection(hostId, provider = 'google') {
  const db = ensureDB();
  const prov = String(provider || '').toLowerCase();
  return db.get(
    `SELECT * FROM calendar_connections
     WHERE host_id = ? AND provider = ?`,
    [hostId, prov]
  );
}

/**
 * Push a booking as a Google Calendar event, if:
 *  - Google OAuth is configured
 *  - queue.calendar_sync_google is truthy
 *  - host has a calendar connection
 *
 * This is intended to be called as a *non-blocking* fire-and-forget helper
 * from the booking creation route.
 *
 * @param {object} queue - row from intime_queues
 * @param {object} booking - row from intime_bookings
 */
export async function pushBookingToGoogleCalendar(queue, booking) {
  try {
    const oauth2Client = getGoogleOAuth2Client();
    if (!oauth2Client) return;
    if (!queue.calendar_sync_google) return;

    const conn = await getHostCalendarConnection(queue.host_id, 'google');
    if (!conn) return;

    oauth2Client.setCredentials({
      access_token: conn.access_token,
      refresh_token: conn.refresh_token,
      expiry_date: conn.expiry_date,
      token_type: conn.token_type
    });

    const calendar = google.calendar({
      version: 'v3',
      auth: oauth2Client
    });

    // We need full slot info to build event times
    if (!booking.slot_date || !booking.slot_start || !booking.slot_end) {
      return;
    }

    const startIso = new Date(
      `${booking.slot_date}T${booking.slot_start}`
    ).toISOString();
    const endIso = new Date(
      `${booking.slot_date}T${booking.slot_end}`
    ).toISOString();

    const summary = `${queue.name || 'Queue'} – booking ${booking.code9}`;
    const description = `Visitor: ${booking.visitor_name || ''} ${
      booking.visitor_email || ''
    }\nParty size: ${booking.party_size || 1}`;

    await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description,
        start: { dateTime: startIso },
        end: { dateTime: endIso }
      }
    });
  } catch (e) {
    console.error('[In-Time] pushBookingToGoogleCalendar error:', e);
  }
}
