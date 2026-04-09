// routes/intimeHost.js
import { db } from '../config/db.js';
import { authRequired, hostRequired, getHostId } from '../middleware/auth.js';
import { toBoolInt, randomSlug, buildQueueQrPayload } from '../lib/intimeHelpers.js';
import QRCode from 'qrcode';

export function registerInTimeHostRoutes(app) {
  // List queues for logged-in host
  app.get(
    '/api/host/intime/queues',
    authRequired,
    hostRequired,
    async (req, res) => {
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
  app.post(
    '/api/host/intime/queues',
    authRequired,
    hostRequired,
    async (req, res) => {
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
            mixed_patterns != null
              ? JSON.stringify(mixed_patterns)
              : null,
          operating_days:
            operating_days != null
              ? JSON.stringify(operating_days)
              : null,
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

  // Fetch QR
  app.get(
    '/api/host/intime/queues/:id/qr',
    authRequired,
    hostRequired,
    async (req, res) => {
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
  app.delete(
    '/api/host/intime/queues/:id',
    authRequired,
    hostRequired,
    async (req, res) => {
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

  // Allow-list
  app.get(
    '/api/host/intime/queues/:id/allow-list',
    authRequired,
    hostRequired,
    async (req, res) => {
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

  // You can also move your POST/DELETE allow-list endpoints here if you have them later in server.js
}
