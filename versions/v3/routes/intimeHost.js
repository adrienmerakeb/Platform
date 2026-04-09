// routes/intimeHost.js
// In-Time queues + allow-list + bookings (host + public)

import express from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { google } from 'googleapis';

import { getDB } from '../config/db.js';
import {
  authRequired,
  hostRequired,
  getHostId
} from '../middleware/auth.js';
import {
  toBoolInt,
  randomSlug,
  generateUniqueCode9,
  buildQueueQrPayload
} from '../lib/intimeHelpers.js';
import { googleOAuth2Client } from '../config/googleCalendar.js';
import { getHostCalendarConnection } from '../lib/calendarConnections.js';

const router = express.Router();

let db;
function ensureDB() {
  if (!db) db = getDB();
  return db;
}

// -----------------------------------------------------------------------------
// Helper: push booking to Google Calendar (if enabled)
// -----------------------------------------------------------------------------
async function pushBookingToGoogleCalendar(queue, booking) {
  try {
    if (!googleOAuth2Client) return;
    if (!queue.calendar_sync_google) return;

    const conn = await getHostCalendarConnection(queue.host_id, 'google');
    if (!conn) return;

    googleOAuth2Client.setCredentials({
      access_token: conn.access_token,
      refresh_token: conn.refresh_token,
      expiry_date: conn.expiry_date,
      token_type: conn.token_type
    });

    const calendar = google.calendar({
      version: 'v3',
      auth: googleOAuth2Client
    });

    // Need full slot information
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

// -----------------------------------------------------------------------------
// IN-TIME QUEUES – HOST SIDE
// -----------------------------------------------------------------------------

// List queues for logged-in host
// GET /api/host/intime/queues
router.get(
  '/host/intime/queues',
  authRequired,
  hostRequired,
  async (req, res) => {
    const db = ensureDB();
    try {
      const hostId = getHostId(req);
      const rows = await db.all(
        `
        SELECT
          id, host_id, name, location, gps_lat, gps_lng,
          queue_mode,
          anon_booking_allowed,
          requires_login,
          requires_whitelist,
          wave_capacity,
          time_per_slot_minutes,
          show_estimate,
          mixed_patterns,
          operating_days,
          off_duty_periods,
          slug,
          qr_payload,
          status,
          valid_from,
          valid_to,
          calendar_sync_google,
          calendar_sync_ms,
          calendar_sync_other,
          calendar_connection_id,
          created_at,
          updated_at
        FROM intime_queues
        WHERE host_id = ?
        ORDER BY created_at DESC
      `,
        [hostId]
      );
      res.json({ ok: true, queues: rows });
    } catch (e) {
      console.error('[In-Time] list queues error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Create or update queue
// POST /api/host/intime/queues
router.post(
  '/host/intime/queues',
  authRequired,
  hostRequired,
  async (req, res) => {
    const db = ensureDB();
    try {
      const hostId = getHostId(req);
      const {
        id,
        name,
        location,
        gps_lat,
        gps_lng,
        queue_mode = 'advance',
        anon_booking_allowed = 0,
        requires_login = 0,
        requires_whitelist = 0,
        wave_capacity = null,
        time_per_slot_minutes = 15,
        show_estimate = 1,
        mixed_patterns = null,
        operating_days = null,
        off_duty_periods = null,
        status = 'active',
        valid_from = null,
        valid_to = null,
        calendar_sync_google = 0,
        calendar_sync_ms = 0,
        calendar_sync_other = 0
      } = req.body || {};

      if (!name) {
        return res.status(400).json({ error: 'Missing queue name' });
      }

      const payloadBase = {
        host_id: hostId,
        name,
        location: location || null,
        gps_lat: gps_lat != null ? Number(gps_lat) : null,
        gps_lng: gps_lng != null ? Number(gps_lng) : null,
        queue_mode: queue_mode || 'advance',
        anon_booking_allowed: toBoolInt(anon_booking_allowed),
        requires_login: toBoolInt(requires_login),
        requires_whitelist: toBoolInt(requires_whitelist),
        wave_capacity:
          wave_capacity != null ? Number(wave_capacity) : null,
        time_per_slot_minutes:
          time_per_slot_minutes != null
            ? Number(time_per_slot_minutes)
            : 15,
        show_estimate: toBoolInt(show_estimate),
        mixed_patterns:
          mixed_patterns != null ? JSON.stringify(mixed_patterns) : null,
        operating_days:
          operating_days != null ? JSON.stringify(operating_days) : null,
        off_duty_periods:
          off_duty_periods != null
            ? JSON.stringify(off_duty_periods)
            : null,
        status: status || 'active',
        valid_from: valid_from || null,
        valid_to: valid_to || null,
        calendar_sync_google: toBoolInt(calendar_sync_google),
        calendar_sync_ms: toBoolInt(calendar_sync_ms),
        calendar_sync_other: toBoolInt(calendar_sync_other)
      };

      if (!id) {
        // CREATE
        const slug = randomSlug('q');
        const qr_payload = buildQueueQrPayload({
          id: 0,
          name,
          location,
          gps_lat: payloadBase.gps_lat,
          gps_lng: payloadBase.gps_lng
        });

        const result = await db.run(
          `
          INSERT INTO intime_queues
            (host_id, name, location, gps_lat, gps_lng,
             queue_mode,
             anon_booking_allowed, requires_login, requires_whitelist,
             wave_capacity, time_per_slot_minutes, show_estimate,
             mixed_patterns, operating_days, off_duty_periods,
             slug, qr_payload, status, valid_from, valid_to,
             calendar_sync_google, calendar_sync_ms, calendar_sync_other)
          VALUES (?,?,?,?,?,
                  ?,?,?,?,
                  ?,?,?,?,
                  ?,?,
                  ?,?,?,?,
                  ?,?,?)
        `,
          [
            payloadBase.host_id,
            payloadBase.name,
            payloadBase.location,
            payloadBase.gps_lat,
            payloadBase.gps_lng,
            payloadBase.queue_mode,
            payloadBase.anon_booking_allowed,
            payloadBase.requires_login,
            payloadBase.requires_whitelist,
            payloadBase.wave_capacity,
            payloadBase.time_per_slot_minutes,
            payloadBase.show_estimate,
            payloadBase.mixed_patterns,
            payloadBase.operating_days,
            payloadBase.off_duty_periods,
            slug,
            qr_payload,
            payloadBase.status,
            payloadBase.valid_from,
            payloadBase.valid_to,
            payloadBase.calendar_sync_google,
            payloadBase.calendar_sync_ms,
            payloadBase.calendar_sync_other
          ]
        );

        const created = await db.get(
          'SELECT * FROM intime_queues WHERE id = ?',
          [result.lastID]
        );

        // Generate QR as dataURL
        const qrDataUrl = await QRCode.toDataURL(created.qr_payload);
        return res.json({
          ok: true,
          queue: created,
          qrDataUrl
        });
      } else {
        // UPDATE
        const existing = await db.get(
          'SELECT * FROM intime_queues WHERE id = ? AND host_id = ?',
          [id, hostId]
        );
        if (!existing) {
          return res.status(404).json({ error: 'Queue not found' });
        }

        const newSlug = existing.slug || randomSlug('q');
        const newPayload = buildQueueQrPayload({
          id: existing.id,
          name,
          location,
          gps_lat: payloadBase.gps_lat,
          gps_lng: payloadBase.gps_lng
        });

        await db.run(
          `
          UPDATE intime_queues SET
            name = ?, location = ?, gps_lat = ?, gps_lng = ?,
            queue_mode = ?,
            anon_booking_allowed = ?, requires_login = ?, requires_whitelist = ?,
            wave_capacity = ?, time_per_slot_minutes = ?, show_estimate = ?,
            mixed_patterns = ?, operating_days = ?, off_duty_periods = ?,
            slug = ?, qr_payload = ?,
            status = ?, valid_from = ?, valid_to = ?,
            calendar_sync_google = ?, calendar_sync_ms = ?, calendar_sync_other = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND host_id = ?
        `,
          [
            payloadBase.name,
            payloadBase.location,
            payloadBase.gps_lat,
            payloadBase.gps_lng,
            payloadBase.queue_mode,
            payloadBase.anon_booking_allowed,
            payloadBase.requires_login,
            payloadBase.requires_whitelist,
            payloadBase.wave_capacity,
            payloadBase.time_per_slot_minutes,
            payloadBase.show_estimate,
            payloadBase.mixed_patterns,
            payloadBase.operating_days,
            payloadBase.off_duty_periods,
            newSlug,
            newPayload,
            payloadBase.status,
            payloadBase.valid_from,
            payloadBase.valid_to,
            payloadBase.calendar_sync_google,
            payloadBase.calendar_sync_ms,
            payloadBase.calendar_sync_other,
            id,
            hostId
          ]
        );

        const updated = await db.get(
          'SELECT * FROM intime_queues WHERE id = ?',
          [id]
        );
        const qrDataUrl = await QRCode.toDataURL(updated.qr_payload);

        return res.json({
          ok: true,
          queue: updated,
          qrDataUrl
        });
      }
    } catch (e) {
      console.error('[In-Time] create/update queue error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Fetch QR code (PNG data URL) for a queue
// GET /api/host/intime/queues/:id/qr
router.get(
  '/host/intime/queues/:id/qr',
  authRequired,
  hostRequired,
  async (req, res) => {
    const db = ensureDB();
    try {
      const hostId = getHostId(req);
      const id = Number(req.params.id);
      const queue = await db.get(
        'SELECT * FROM intime_queues WHERE id = ? AND host_id = ?',
        [id, hostId]
      );
      if (!queue) {
        return res.status(404).json({ error: 'Queue not found' });
      }
      const qrDataUrl = await QRCode.toDataURL(
        queue.qr_payload || buildQueueQrPayload(queue)
      );
      res.json({ ok: true, qrDataUrl });
    } catch (e) {
      console.error('[In-Time] QR error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Delete queue
// DELETE /api/host/intime/queues/:id
router.delete(
  '/host/intime/queues/:id',
  authRequired,
  hostRequired,
  async (req, res) => {
    const db = ensureDB();
    try {
      const hostId = getHostId(req);
      const id = Number(req.params.id);
      const result = await db.run(
        'DELETE FROM intime_queues WHERE id = ? AND host_id = ?',
        [id, hostId]
      );
      if (!result.changes) {
        return res.status(404).json({ error: 'Queue not found' });
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[In-Time] delete queue error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// -----------------------------------------------------------------------------
// IN-TIME QUEUE ALLOW-LIST (Only from my list)
// -----------------------------------------------------------------------------

// GET /api/host/intime/queues/:id/allow-list
router.get(
  '/host/intime/queues/:id/allow-list',
  authRequired,
  hostRequired,
  async (req, res) => {
    const db = ensureDB();
    try {
      const hostId = getHostId(req);
      const id = Number(req.params.id);
      const queue = await db.get(
        'SELECT id FROM intime_queues WHERE id = ? AND host_id = ?',
        [id, hostId]
      );
      if (!queue) {
        return res.status(404).json({ error: 'Queue not found' });
      }
      const rows = await db.all(
        'SELECT id, email FROM intime_queue_allowed_visitors WHERE queue_id = ? ORDER BY email ASC',
        [id]
      );
      res.json({ ok: true, items: rows });
    } catch (e) {
      console.error('[In-Time] allow-list get error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/host/intime/queues/:id/allow-list
router.post(
  '/host/intime/queues/:id/allow-list',
  authRequired,
  hostRequired,
  async (req, res) => {
    const db = ensureDB();
    try {
      const hostId = getHostId(req);
      const id = Number(req.params.id);
      const { email } = req.body || {};
      if (!email) {
        return res.status(400).json({ error: 'Missing email' });
      }

      const queue = await db.get(
        'SELECT id FROM intime_queues WHERE id = ? AND host_id = ?',
        [id, hostId]
      );
      if (!queue) {
        return res.status(404).json({ error: 'Queue not found' });
      }

      await db.run(
        `INSERT INTO intime_queue_allowed_visitors (queue_id, email)
         VALUES (?, ?)
         ON CONFLICT(queue_id, email) DO NOTHING`,
        [id, email.trim().toLowerCase()]
      );

      const rows = await db.all(
        'SELECT id, email FROM intime_queue_allowed_visitors WHERE queue_id = ? ORDER BY email ASC',
        [id]
      );
      res.json({ ok: true, items: rows });
    } catch (e) {
      console.error('[In-Time] allow-list add error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /api/host/intime/queues/:id/allow-list
router.delete(
  '/host/intime/queues/:id/allow-list',
  authRequired,
  hostRequired,
  async (req, res) => {
    const db = ensureDB();
    try {
      const hostId = getHostId(req);
      const id = Number(req.params.id);
      const { email } = req.body || {};
      if (!email) {
        return res.status(400).json({ error: 'Missing email' });
      }

      const queue = await db.get(
        'SELECT id FROM intime_queues WHERE id = ? AND host_id = ?',
        [id, hostId]
      );
      if (!queue) {
        return res.status(404).json({ error: 'Queue not found' });
      }

      await db.run(
        'DELETE FROM intime_queue_allowed_visitors WHERE queue_id = ? AND email = ?',
        [id, email.trim().toLowerCase()]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('[In-Time] allow-list delete error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// -----------------------------------------------------------------------------
// IN-TIME BOOKINGS – VISITOR + HOST
// -----------------------------------------------------------------------------

// Public queue info (for booking page)
// GET /api/intime/queues/:id
router.get('/intime/queues/:id', async (req, res) => {
  const db = ensureDB();
  try {
    const id = Number(req.params.id);
    const q = await db.get(
      `
      SELECT
        id, host_id, name, location, gps_lat, gps_lng,
        queue_mode,
        anon_booking_allowed,
        requires_login,
        requires_whitelist,
        wave_capacity,
        time_per_slot_minutes,
        show_estimate,
        mixed_patterns,
        operating_days,
        off_duty_periods,
        slug,
        status,
        valid_from,
        valid_to,
        created_at,
        updated_at
      FROM intime_queues
      WHERE id = ? AND status = 'active'
    `,
      [id]
    );
    if (!q) return res.status(404).json({ error: 'Queue not found' });

    let operating_days = null;
    let off_duty_periods = null;
    let mixed_patterns = null;

    try {
      operating_days = q.operating_days ? JSON.parse(q.operating_days) : null;
    } catch {
      operating_days = null;
    }
    try {
      off_duty_periods = q.off_duty_periods
        ? JSON.parse(q.off_duty_periods)
        : null;
    } catch {
      off_duty_periods = null;
    }
    try {
      mixed_patterns = q.mixed_patterns ? JSON.parse(q.mixed_patterns) : null;
    } catch {
      mixed_patterns = null;
    }

    res.json({
      ok: true,
      queue: {
        ...q,
        operating_days,
        off_duty_periods,
        mixed_patterns
      }
    });
  } catch (e) {
    console.error('[In-Time] public queue error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Visitor booking creation
// POST /api/intime/queues/:id/book
router.post('/intime/queues/:id/book', async (req, res) => {
  const db = ensureDB();
  try {
    const queueId = Number(req.params.id);
    const queue = await db.get(
      'SELECT * FROM intime_queues WHERE id = ? AND status = "active"',
      [queueId]
    );
    if (!queue) {
      return res.status(404).json({ error: 'Queue not found' });
    }

    const {
      slot_date,
      slot_start,
      slot_end,
      party_size = 1,
      visitor_email = null,
      visitor_name = null,
      source = 'web'
    } = req.body || {};

    if (!slot_date || !slot_start || !slot_end) {
      return res
        .status(400)
        .json({ error: 'Missing slot_date / slot_start / slot_end' });
    }

    // Basic whitelist check if enabled
    if (queue.requires_whitelist) {
      const email = (visitor_email || '').trim().toLowerCase();
      if (!email) {
        return res.status(400).json({
          error:
            'This queue only accepts whitelisted visitors; email is required.'
        });
      }
      const allowed = await db.get(
        'SELECT id FROM intime_queue_allowed_visitors WHERE queue_id = ? AND email = ?',
        [queueId, email]
      );
      if (!allowed) {
        return res.status(403).json({
          error:
            'This queue only accepts visitors from an allow-list for this time.'
        });
      }
    }

    // If login required, we could enforce JWT here – currently soft.

    const code9 = await generateUniqueCode9();
    const short_code = code9.replace(/-/g, '').slice(0, 6).toUpperCase();
    const booking_token =
      crypto.randomBytes(12).toString('hex').toUpperCase();

    const slotTime = new Date(`${slot_date}T${slot_start}`);
    const visitorId = null; // optional future: map from JWT if logged

    const result = await db.run(
      `
      INSERT INTO intime_bookings
        (queue_id, visitor_id, visitor_email, visitor_name,
         code9, short_code, booking_token,
         status,
         slot_date, slot_start, slot_end, slot_time,
         party_size, source)
      VALUES (?,?,?,?,?,
              ?,?,?,
              ?,?,?,?,
              ?,?)
    `,
      [
        queueId,
        visitorId,
        visitor_email || null,
        visitor_name || null,
        code9,
        short_code,
        booking_token,
        'booked',
        slot_date,
        slot_start,
        slot_end,
        slotTime.toISOString(),
        Number(party_size || 1),
        source || 'web'
      ]
    );

    const booking = await db.get(
      'SELECT * FROM intime_bookings WHERE id = ?',
      [result.lastID]
    );

    // Try to sync to calendar (non-blocking)
    pushBookingToGoogleCalendar(queue, booking).catch((e) => {
      console.error('[In-Time] calendar sync background error:', e);
    });

    res.json({
      ok: true,
      booking: {
        id: booking.id,
        code9: booking.code9,
        short_code: booking.short_code,
        booking_token: booking.booking_token,
        slot_date: booking.slot_date,
        slot_start: booking.slot_start,
        slot_end: booking.slot_end,
        party_size: booking.party_size
      }
    });
  } catch (e) {
    console.error('[In-Time] create booking error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Host – list bookings across queues
// GET /api/host/intime/bookings
router.get(
  '/host/intime/bookings',
  authRequired,
  hostRequired,
  async (req, res) => {
    const db = ensureDB();
    try {
      const hostId = getHostId(req);
      const rows = await db.all(
        `
        SELECT
          b.id,
          b.queue_id,
          q.name AS queue_name,
          b.visitor_email,
          b.visitor_name,
          b.code9,
          b.short_code,
          b.status,
          b.slot_date,
          b.slot_start,
          b.slot_end,
          b.party_size,
          b.created_at,
          b.redeemed_at
        FROM intime_bookings b
        JOIN intime_queues q ON q.id = b.queue_id
        WHERE q.host_id = ?
        ORDER BY b.created_at DESC
      `,
        [hostId]
      );
      res.json({ ok: true, bookings: rows });
    } catch (e) {
      console.error('[In-Time] host list bookings error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Host – redeem a booking (scan QR / code)
// POST /api/host/intime/bookings/:id/redeem
router.post(
  '/host/intime/bookings/:id/redeem',
  authRequired,
  hostRequired,
  async (req, res) => {
    const db = ensureDB();
    try {
      const hostId = getHostId(req);
      const id = Number(req.params.id);
      const loc = req.body?.location || null;

      const booking = await db.get(
        `
        SELECT b.*, q.host_id, q.name AS queue_name
        FROM intime_bookings b
        JOIN intime_queues q ON q.id = b.queue_id
        WHERE b.id = ?
      `,
        [id]
      );
      if (!booking || booking.host_id !== hostId) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      if (booking.status === 'redeemed') {
        return res.status(400).json({ error: 'Already redeemed' });
      }

      await db.run(
        `
        UPDATE intime_bookings
        SET status = 'redeemed',
            redeemed_at = CURRENT_TIMESTAMP,
            redeem_host_id = ?,
            redeem_location = ?
        WHERE id = ?
      `,
        [hostId, loc, id]
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('[In-Time] redeem booking error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Host – find booking by code (short or full)
// GET /api/host/intime/bookings/find/:code
router.get(
  '/host/intime/bookings/find/:code',
  authRequired,
  hostRequired,
  async (req, res) => {
    const db = ensureDB();
    try {
      const hostId = getHostId(req);
      const rawCode = String(req.params.code || '').toUpperCase();
      if (!rawCode) {
        return res.status(400).json({ error: 'Missing code' });
      }

      const booking = await db.get(
        `
        SELECT
          b.*,
          q.host_id,
          q.name AS queue_name
        FROM intime_bookings b
        JOIN intime_queues q ON q.id = b.queue_id
        WHERE (UPPER(b.code9) = ? OR UPPER(b.short_code) = ?)
      `,
        [rawCode, rawCode]
      );
      if (!booking || booking.host_id !== hostId) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      res.json({
        ok: true,
        booking: {
          id: booking.id,
          queue_id: booking.queue_id,
          queue_name: booking.queue_name,
          status: booking.status,
          code9: booking.code9,
          short_code: booking.short_code,
          slot_date: booking.slot_date,
          slot_start: booking.slot_start,
          slot_end: booking.slot_end,
          party_size: booking.party_size,
          visitor_email: booking.visitor_email,
          visitor_name: booking.visitor_name,
          created_at: booking.created_at,
          redeemed_at: booking.redeemed_at
        }
      });
    } catch (e) {
      console.error('[In-Time] find booking error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

export default router;
