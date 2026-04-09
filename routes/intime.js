// routes/intime.js
// In-Time (Queues & Bookings) API extracted from server.js

import QRCode from 'qrcode';

/**
 * Registers all In-Time routes on the provided Express app.
 *
 * Dependencies:
 *  - app:          Express app instance
 *  - db:           SQLite db (from `open(...)`)
 *  - authRequired: middleware that ensures a valid JWT token in cookie
 *  - hostRequired: middleware that ensures req.user.role === 'host'
 *  - getHostId:    helper to get host id from req.user
 *  - baseUrl:      base URL (e.g. OAUTH_BASE_URL / public URL)
 */
export function registerIntimeRoutes({
  app,
  db,
  authRequired,
  hostRequired,
  getHostId,
  baseUrl
}) {
  // ---------------------------------------------------------------------------
  // Helpers (same logic as in your original server.js)
  // ---------------------------------------------------------------------------

  function toBoolInt(v) {
    return v ? 1 : 0;
  }

  function randomSlug(prefix = 'q') {
    const body = Math.random().toString(36).slice(2, 8);
    return `${prefix}${body}`;
  }

  // Generate AAA-BBB-CCC from letters + digits
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

  async function generateUniqueCode9() {
    while (true) {
      const code = generateCode9();
      const existing = await db.get(
        'SELECT id FROM intime_bookings WHERE code9 = ?',
        code
      );
      if (!existing) return code;
    }
  }

  // Create the booking URL encoded into queue QR.
  // For now we encode the visitor booking page:
  //   /pages/visitor/VirtualQueueSpotBooking.html?queueId=...&venueId=...
  function buildQueueQrPayload(queue) {
    const basePath = '/pages/visitor/VirtualQueueSpotBooking.html';
    const base = baseUrl || 'http://localhost:3000';
    const url = new URL(basePath, base);
    url.searchParams.set('queueId', String(queue.id));
    url.searchParams.set('venueId', String(queue.id));
    if (queue.name) url.searchParams.set('name', queue.name);
    if (queue.location) url.searchParams.set('addr', queue.location);
    if (queue.gps_lat != null && queue.gps_lng != null) {
      url.searchParams.set('gps', `${queue.gps_lat},${queue.gps_lng}`);
    }
    return url.toString();
  }

  // ---------------------------------------------------------------------------
  // In-Time (Queues & Bookings) API
  // ---------------------------------------------------------------------------

  // ---- Create a new queue (host) ----
  app.post('/api/intime/queues', authRequired, hostRequired, async (req, res) => {
    try {
      const hostId = getHostId(req);

      const {
        name,
        location,
        gps_lat,
        gps_lng,

        queue_mode, // 'live' | 'advance' | 'mixed'

        anon_booking_allowed,
        requires_login,
        requires_whitelist,

        wave_capacity,
        time_per_slot_minutes,
        show_estimate,

        mixed_patterns,
        operating_days,
        off_duty_periods,

        calendar_sync_google,
        calendar_sync_ms,
        calendar_sync_other,

        valid_from,
        valid_to,
        status = 'active'
      } = req.body;

      if (!name) {
        return res.status(400).json({ ok: false, error: 'MISSING_NAME' });
      }

      if (!queue_mode || !['live', 'advance', 'mixed'].includes(queue_mode)) {
        return res.status(400).json({ ok: false, error: 'Invalid queue_mode' });
      }

      const slug = randomSlug('q');

      const mixedPatternsJson =
        mixed_patterns && mixed_patterns.length
          ? JSON.stringify(mixed_patterns)
          : null;
      const operatingDaysJson =
        operating_days && operating_days.length
          ? JSON.stringify(operating_days)
          : null;
      const offDutyJson =
        off_duty_periods && off_duty_periods.length
          ? JSON.stringify(off_duty_periods)
          : null;

      const result = await db.run(
        `
        INSERT INTO intime_queues (
          host_id,
          name,
          location,
          gps_lat,
          gps_lng,
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
          calendar_sync_google,
          calendar_sync_ms,
          calendar_sync_other,
          slug,
          qr_payload,
          status,
          valid_from,
          valid_to
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `,
        [
          hostId,
          name || null,
          location || null,
          gps_lat != null ? Number(gps_lat) : null,
          gps_lng != null ? Number(gps_lng) : null,
          queue_mode,
          toBoolInt(anon_booking_allowed),
          toBoolInt(requires_login),
          toBoolInt(requires_whitelist),
          wave_capacity != null ? Number(wave_capacity) : null,
          time_per_slot_minutes != null ? Number(time_per_slot_minutes) : null,
          toBoolInt(show_estimate),
          mixedPatternsJson,
          operatingDaysJson,
          offDutyJson,
          toBoolInt(calendar_sync_google),
          toBoolInt(calendar_sync_ms),
          toBoolInt(calendar_sync_other),
          slug,
          null,
          status || 'active',
          valid_from || null,
          valid_to || null
        ]
      );

      const queueId = result.lastID;
      const queue = await db.get(
        'SELECT * FROM intime_queues WHERE id = ?',
        queueId
      );

      const qrPayload = buildQueueQrPayload(queue);
      await db.run(
        'UPDATE intime_queues SET qr_payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        qrPayload,
        queueId
      );

      return res.json({
        ok: true,
        queueId,
        slug,
        qrPayload
      });
    } catch (err) {
      console.error('Error creating queue:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  // ---- List queues for current host ----
  app.get('/api/intime/queues', authRequired, hostRequired, async (req, res) => {
    try {
      const hostId = getHostId(req);
      const rows = await db.all(
        'SELECT * FROM intime_queues WHERE host_id = ? ORDER BY created_at DESC',
        hostId
      );
      return res.json({ ok: true, queues: rows });
    } catch (err) {
      console.error('Error listing queues:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  // ---- Get queue details by id or slug (public) ----
  app.get('/api/intime/queues/:idOrSlug', async (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const isNumeric = /^\d+$/.test(idOrSlug);
      const row = isNumeric
        ? await db.get(
            'SELECT * FROM intime_queues WHERE id = ?',
            Number(idOrSlug)
          )
        : await db.get('SELECT * FROM intime_queues WHERE slug = ?', idOrSlug);

      if (!row) {
        return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
      }

      return res.json({ ok: true, queue: row });
    } catch (err) {
      console.error('Error loading queue:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  // ---- QR image for a queue (PNG) ----
  app.get('/api/intime/queues/:id/qr', async (req, res) => {
    try {
      const { id } = req.params;
      const queue = await db.get(
        'SELECT * FROM intime_queues WHERE id = ?',
        Number(id)
      );
      if (!queue) {
        return res.status(404).send('Queue not found');
      }
      const payload = queue.qr_payload || buildQueueQrPayload(queue);
      const pngBuffer = await QRCode.toBuffer(payload, {
        errorCorrectionLevel: 'M',
        type: 'png',
        margin: 2,
        width: 512
      });
      res.setHeader('Content-Type', 'image/png');
      return res.send(pngBuffer);
    } catch (err) {
      console.error('Error generating QR:', err);
      return res.status(500).send('Error generating QR');
    }
  });

  // ---- Create booking (visitor "use" side) ----
  app.post('/api/intime/bookings', async (req, res) => {
    try {
      const {
        queue_id,
        slot_date,
        slot_start,
        slot_end,
        party_size,
        source,
        visitor_email = null,
        visitor_name = null
      } = req.body;

      if (!queue_id) {
        return res.status(400).json({ ok: false, error: 'MISSING_QUEUE_ID' });
      }
      const queue = await db.get(
        'SELECT * FROM intime_queues WHERE id = ?',
        Number(queue_id)
      );
      if (!queue) {
        return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
      }

      const code9 = await generateUniqueCode9();
      const size = party_size ? Number(party_size) : 1;

      const result = await db.run(
        `
        INSERT INTO intime_bookings (
          queue_id,
          visitor_id,
          visitor_email,
          visitor_name,
          code9,
          status,
          slot_date,
          slot_start,
          slot_end,
          party_size,
          source
        ) VALUES (?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?)
      `,
        [
          queue.id,
          null,
          visitor_email,
          visitor_name,
          code9,
          slot_date || null,
          slot_start || null,
          slot_end || null,
          size,
          source || null
        ]
      );

      const bookingId = result.lastID;

      const bookingPayload = `booking:${bookingId}`;

      const pngBuffer = await QRCode.toBuffer(bookingPayload, {
        errorCorrectionLevel: 'M',
        type: 'png',
        margin: 2,
        width: 512
      });
      const base64Png = pngBuffer.toString('base64');

      return res.json({
        ok: true,
        booking: {
          id: bookingId,
          queue_id: queue.id,
          code9,
          slot_date,
          slot_start,
          slot_end,
          party_size: size,
          source: source || null
        },
        qr: {
          payload: bookingPayload,
          image_base64: `data:image/png;base64,${base64Png}`
        }
      });
    } catch (err) {
      console.error('Error creating booking:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  // ---- Redeem booking (host “manage” side, Scan & Redeem page) ----
  app.post('/api/intime/bookings/:id/redeem', authRequired, async (req, res) => {
    try {
      const { id } = req.params;
      const hostId = getHostId(req);
      const { redeem_location } = req.body || {};

      const booking = await db.get(
        'SELECT b.*, q.host_id FROM intime_bookings b JOIN intime_queues q ON b.queue_id = q.id WHERE b.id = ?',
        Number(id)
      );
      if (!booking) {
        return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });
      }

      if (hostId && booking.host_id && booking.host_id !== hostId) {
        return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
      }

      if (booking.status === 'redeemed') {
        return res.json({ ok: true, alreadyRedeemed: true });
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
        [hostId, redeem_location || null, booking.id]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error redeeming booking:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  // ---- Cancel booking (visitor “use” side) ----
  app.post('/api/intime/bookings/:id/cancel', async (req, res) => {
    try {
      const { id } = req.params;
      const booking = await db.get(
        'SELECT * FROM intime_bookings WHERE id = ?',
        Number(id)
      );
      if (!booking) {
        return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });
      }
      if (booking.status !== 'booked') {
        return res
          .status(400)
          .json({ ok: false, error: 'BOOKING_NOT_ACTIVE' });
      }

      await db.run(
        `
        UPDATE intime_bookings
           SET status = 'cancelled'
         WHERE id = ?
      `,
        booking.id
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error cancelling booking:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  });
}
