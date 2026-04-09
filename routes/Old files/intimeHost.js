// routes/intimeHost.js
// In-Time (Queues & Bookings) API — host "manage" + visitor "use" side

import express from 'express';
import QRCode from 'qrcode';
import { google } from 'googleapis';

import { getDb } from '../config/db.js';
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

import { getGoogleOAuth2Client } from '../config/googleCalendar.js';
import { getHostCalendarConnection } from '../lib/calendarConnections.js';

const router = express.Router();
const db = getDb();

/* --------------------------------------------------------------------------
 * Small helper: fetch queue + check host
 * ------------------------------------------------------------------------ */
async function getQueueForHost(queueId, hostId) {
  const q = await db.get(
    'SELECT * FROM intime_queues WHERE id = ?',
    Number(queueId)
  );
  if (!q) return null;
  if (hostId && q.host_id && q.host_id !== hostId) {
    return 'NOT_OWNER';
  }
  return q;
}

/* --------------------------------------------------------------------------
 * Create internal calendar (1 per queue) and return calendar_id
 * ------------------------------------------------------------------------ */
async function createInternalCalendarForQueue({ queueId, hostId, timezone = 'UTC' }) {
  const result = await db.run(
    `
    INSERT INTO queue_calendars (queue_id, host_id, timezone, status)
    VALUES (?, ?, ?, 'active')
    `,
    [Number(queueId), Number(hostId), timezone || 'UTC']
  );
  return result.lastID;
}

/* --------------------------------------------------------------------------
 * NEW: compute time range (UTC) for availability imports
 * view: 'day'|'week'|'month'
 * date: 'YYYY-MM-DD' (reference date)
 * ------------------------------------------------------------------------ */
function computeRangeUTC(view = 'week', dateStr) {
  const ref = dateStr ? new Date(`${dateStr}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(ref.getTime())) {
    // fallback: now
    return computeRangeUTC(view, new Date().toISOString().slice(0, 10));
  }

  const v = String(view || 'week').toLowerCase();

  if (v === 'day') {
    const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 0, 0, 0));
    const end = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate() + 1, 0, 0, 0));
    return { start, end };
  }

  if (v === 'month') {
    const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1, 0, 0, 0));
    const end = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1, 0, 0, 0));
    return { start, end };
  }

  // default: week (Monday → Monday)
  const day = ref.getUTCDay(); // 0 Sun ... 6 Sat
  const mondayOffset = (day === 0 ? -6 : 1 - day);
  const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate() + mondayOffset, 0, 0, 0));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 7, 0, 0, 0));
  return { start, end };
}

/* --------------------------------------------------------------------------
 * SAFETY: make sure intime_bookings has code9 column at runtime
 * ------------------------------------------------------------------------ */
let code9Checked = false;
async function ensureCode9Column() {
  if (code9Checked) return;
  try {
    const cols = await db.all('PRAGMA table_info(intime_bookings)');
    const hasCode9 = cols.some((c) => String(c.name).toLowerCase() === 'code9');
    if (!hasCode9) {
      await db.exec('ALTER TABLE intime_bookings ADD COLUMN code9 TEXT UNIQUE');
      console.log('[MIGRATION-RUNTIME] intime_bookings.code9 added');
    }
  } catch (err) {
    console.error('[MIGRATION-RUNTIME] ensureCode9Column error:', err.message || err);
  } finally {
    code9Checked = true;
  }
}

/* --------------------------------------------------------------------------
 * Debug logger for these routes
 * ------------------------------------------------------------------------ */
router.use('/intime/queues', (req, _res, next) => {
  console.log('[INTIME QUEUES]', req.method, req.originalUrl || req.url);
  next();
});

/* --------------------------------------------------------------------------
 * Create a new queue (host)
 * POST /api/intime/queues
 * ------------------------------------------------------------------------ */
router.post('/intime/queues', authRequired, hostRequired, async (req, res) => {
  const hostId = getHostId(req);

  try {
    const {
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

      valid_from,
      valid_to,
      status = 'active',

      allowed_visitors_emails,

      timezone
    } = req.body || {};

    if (!name) {
      return res.status(400).json({ ok: false, error: 'MISSING_NAME' });
    }

    if (!queue_mode || !['live', 'advance', 'mixed'].includes(queue_mode)) {
      return res.status(400).json({ ok: false, error: 'Invalid queue_mode' });
    }

    const slug = randomSlug('q');

    const mixedPatternsJson =
      mixed_patterns && mixed_patterns.length ? JSON.stringify(mixed_patterns) : null;
    const operatingDaysJson =
      operating_days && operating_days.length ? JSON.stringify(operating_days) : null;
    const offDutyJson =
      off_duty_periods && off_duty_periods.length ? JSON.stringify(off_duty_periods) : null;

    const allowListJson =
      Array.isArray(allowed_visitors_emails) && allowed_visitors_emails.length
        ? JSON.stringify(allowed_visitors_emails)
        : null;

    await db.exec('BEGIN');

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
        internal_calendar_id,
        slug,
        qr_payload,
        status,
        valid_from,
        valid_to,
        allowed_visitors_emails
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
        null,
        slug,
        null,
        status || 'active',
        valid_from || null,
        valid_to || null,
        allowListJson
      ]
    );

    const queueId = result.lastID;

    const internalCalendarId = await createInternalCalendarForQueue({
      queueId,
      hostId,
      timezone: timezone || 'UTC'
    });

    await db.run(
      `
      UPDATE intime_queues
         SET internal_calendar_id = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
      `,
      [internalCalendarId, queueId]
    );

    const queueRow = await db.get('SELECT * FROM intime_queues WHERE id = ?', queueId);
    const qrPayload = buildQueueQrPayload(queueRow);

    await db.run(
      `
      UPDATE intime_queues
         SET qr_payload = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
      `,
      [qrPayload, queueId]
    );

    await db.exec('COMMIT');

    return res.json({
      ok: true,
      queueId,
      slug,
      qrPayload,
      internalCalendarId
    });
  } catch (err) {
    try { await db.exec('ROLLBACK'); } catch {}
    console.error('Error creating queue:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* --------------------------------------------------------------------------
 * NEW: Sync busy blocks from provider into internal calendar blocks
 * POST /api/intime/queues/:id/calendar-blocks/sync
 * Body: { provider:'google', view:'week'|'day'|'month', date:'YYYY-MM-DD' }
 * ------------------------------------------------------------------------ */
router.post(
  '/intime/queues/:id/calendar-blocks/sync',
  authRequired,
  hostRequired,
  async (req, res) => {
    const hostId = getHostId(req);
    const { id } = req.params;
    const { provider = 'google', view = 'week', date } = req.body || {};

    try {
      const queue = await getQueueForHost(id, hostId);
      if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
      if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });

      if (!queue.internal_calendar_id) {
        return res.status(400).json({ ok: false, error: 'NO_INTERNAL_CALENDAR' });
      }

      const prov = String(provider).toLowerCase();
      if (prov !== 'google') {
        return res.status(400).json({ ok: false, error: 'PROVIDER_NOT_SUPPORTED_YET' });
      }

      // Must have host-level Google connection
      const oauth2Client = getGoogleOAuth2Client();
      if (!oauth2Client) {
        return res.status(503).json({ ok: false, error: 'GOOGLE_OAUTH_NOT_CONFIGURED' });
      }

      const conn = await getHostCalendarConnection(hostId, 'google');
      if (!conn) {
        return res.status(400).json({ ok: false, error: 'NO_GOOGLE_CONNECTION' });
      }

      oauth2Client.setCredentials({
        access_token: conn.access_token,
        refresh_token: conn.refresh_token,
        expiry_date: conn.expiry_date,
        token_type: conn.token_type
      });

      const { start, end } = computeRangeUTC(view, date);
      const timeMin = start.toISOString();
      const timeMax = end.toISOString();

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      // FreeBusy (busy blocks only)
      const fb = await calendar.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          timeZone: 'UTC',
          items: [{ id: 'primary' }]
        }
      });

      const busy = fb?.data?.calendars?.primary?.busy || [];
      const busySlots = busy
        .filter(b => b?.start && b?.end)
        .map(b => ({ start_utc: String(b.start), end_utc: String(b.end) }));

      await db.exec('BEGIN');

      // Replace snapshot for this provider
      await db.run(
        `DELETE FROM queue_calendar_blocks WHERE calendar_id = ? AND source_provider = ?`,
        [Number(queue.internal_calendar_id), 'google']
      );

      let inserted = 0;
      for (const slot of busySlots) {
        const sourceRef = `${slot.start_utc}|${slot.end_utc}`; // stable dedupe key for FreeBusy
        const r = await db.run(
          `
          INSERT OR IGNORE INTO queue_calendar_blocks
            (calendar_id, start_utc, end_utc, source_provider, source_ref)
          VALUES (?, ?, ?, ?, ?)
          `,
          [Number(queue.internal_calendar_id), slot.start_utc, slot.end_utc, 'google', sourceRef]
        );
        if (r?.changes) inserted += r.changes;
      }

      await db.exec('COMMIT');

      return res.json({
        ok: true,
        queueId: Number(id),
        internalCalendarId: Number(queue.internal_calendar_id),
        provider: 'google',
        view,
        startUtc: timeMin,
        endUtc: timeMax,
        blocksInserted: inserted,
        blocksTotal: busySlots.length
      });
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch {}
      console.error('[INTIME] calendar-blocks sync error:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  }
);

/* --------------------------------------------------------------------------
 * List queues for current host
 * GET /api/intime/queues
 * ------------------------------------------------------------------------ */
router.get('/intime/queues', authRequired, hostRequired, async (req, res) => {
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


/* --------------------------------------------------------------------------
 * Get queue details by id or slug (public)
 * GET /api/intime/queues/:idOrSlug
 * ------------------------------------------------------------------------ */
router.get('/intime/queues/:idOrSlug', async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isNumeric = /^\d+$/.test(idOrSlug);

    const row = isNumeric
      ? await db.get('SELECT * FROM intime_queues WHERE id = ?', [
          Number(idOrSlug)
        ])
      : await db.get('SELECT * FROM intime_queues WHERE slug = ?', [
          idOrSlug
        ]);

    if (!row) {
      return res
        .status(404)
        .json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    }

    return res.json({ ok: true, queue: row });
  } catch (err) {
    console.error('Error loading queue:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* --------------------------------------------------------------------------
 * QR image for a queue (PNG)
 * GET /api/intime/queues/:id/qr
 * ------------------------------------------------------------------------ */
router.get('/intime/queues/:id/qr', async (req, res) => {
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

/* --------------------------------------------------------------------------
 * Update queue status (active / inactive)
 * PATCH /api/intime/queues/:id/status
 * ------------------------------------------------------------------------ */
router.patch(
  '/intime/queues/:id/status',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      const hostId = getHostId(req);
      const { id } = req.params;
      const body = req.body || {};

      let raw = undefined;
      if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
        raw = body.is_active;
      } else if (Object.prototype.hasOwnProperty.call(body, 'active')) {
        raw = body.active;
      } else if (Object.prototype.hasOwnProperty.call(body, 'status')) {
        raw = body.status;
      }

      let isActiveFlag;
      if (typeof raw === 'boolean') {
        isActiveFlag = raw;
      } else if (typeof raw === 'number') {
        isActiveFlag = raw === 1;
      } else if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase();
        isActiveFlag = v === 'active' || v === 'a' || v === '1' || v === 'true' || v === 'yes';
      } else {
        isActiveFlag = false;
      }

      const queue = await getQueueForHost(id, hostId);
      if (!queue) {
        return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
      }
      if (queue === 'NOT_OWNER') {
        return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
      }

      const newStatus = isActiveFlag ? 'active' : 'inactive';

      await db.run(
        `
        UPDATE intime_queues
           SET status = ?,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `,
        [newStatus, Number(id)]
      );

      const updated = await db.get(
        'SELECT * FROM intime_queues WHERE id = ?',
        Number(id)
      );

      return res.json({ ok: true, queue: updated });
    } catch (err) {
      console.error('Error updating queue status:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  }
);

/* --------------------------------------------------------------------------
 * Delete a queue
 * DELETE /api/intime/queues/:id
 * ------------------------------------------------------------------------ */
router.delete(
  '/intime/queues/:id',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      const hostId = getHostId(req);
      const { id } = req.params;

      const queue = await getQueueForHost(id, hostId);
      if (!queue) {
        return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
      }
      if (queue === 'NOT_OWNER') {
        return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
      }

      await db.run('DELETE FROM intime_queues WHERE id = ?', Number(id));

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error deleting queue:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  }
);

/* --------------------------------------------------------------------------
 * Allowed visitors list (whitelist emails)
 * GET/PATCH /api/intime/queues/:id/allowlist
 * ------------------------------------------------------------------------ */
router.get(
  '/intime/queues/:id/allowlist',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      const hostId = getHostId(req);
      const { id } = req.params;

      const queue = await getQueueForHost(id, hostId);
      if (!queue) {
        return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
      }
      if (queue === 'NOT_OWNER') {
        return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
      }

      let emails = [];
      if (queue.allowed_visitors_emails) {
        try {
          const parsed = JSON.parse(queue.allowed_visitors_emails);
          if (Array.isArray(parsed)) emails = parsed;
        } catch {}
      }

      return res.json({ ok: true, emails });
    } catch (err) {
      console.error('Error loading allow-list:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  }
);

router.patch(
  '/intime/queues/:id/allowlist',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      const hostId = getHostId(req);
      const { id } = req.params;
      const { emails } = req.body || {};

      const queue = await getQueueForHost(id, hostId);
      if (!queue) {
        return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
      }
      if (queue === 'NOT_OWNER') {
        return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
      }

      const normalized = Array.isArray(emails)
        ? emails.map((e) => (e || '').trim().toLowerCase()).filter((e) => !!e)
        : [];

      const json = normalized.length ? JSON.stringify(normalized) : null;

      await db.run(
        `
        UPDATE intime_queues
           SET allowed_visitors_emails = ?,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `,
        [json, Number(id)]
      );

      const updated = await db.get('SELECT * FROM intime_queues WHERE id = ?', Number(id));
      return res.json({ ok: true, emails: normalized, queue: updated });
    } catch (err) {
      console.error('Error updating allow-list:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  }
);

/* --------------------------------------------------------------------------
 * Calendar sync flags per queue (unchanged)
 * ------------------------------------------------------------------------ */
async function handleCalendarSync(req, res) {
  try {
    const hostId = getHostId(req);
    const { id } = req.params;
    const body = req.body || {};

    console.log('[INTIME] calendar-sync payload:', body);

    const queue = await getQueueForHost(id, hostId);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });

    const hasBulkKeys = [
      'calendar_sync_google',
      'calendar_sync_ms',
      'calendar_sync_other'
    ].some((k) => Object.prototype.hasOwnProperty.call(body, k));

    if (hasBulkKeys) {
      const sets = [];
      const params = [];

      if (typeof body.calendar_sync_google === 'boolean') {
        sets.push('calendar_sync_google = ?');
        params.push(body.calendar_sync_google ? 1 : 0);
      }
      if (typeof body.calendar_sync_ms === 'boolean') {
        sets.push('calendar_sync_ms = ?');
        params.push(body.calendar_sync_ms ? 1 : 0);
      }
      if (typeof body.calendar_sync_other === 'boolean') {
        sets.push('calendar_sync_other = ?');
        params.push(body.calendar_sync_other ? 1 : 0);
      }

      if (!sets.length) {
        return res.status(400).json({ ok: false, error: 'NO_FLAGS_PROVIDED' });
      }

      const sql = `
        UPDATE intime_queues
           SET ${sets.join(', ')},
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `;
      params.push(Number(id));

      await db.run(sql, params);
      const updated = await db.get('SELECT * FROM intime_queues WHERE id = ?', Number(id));
      return res.json({ ok: true, queue: updated });
    }

    let rawProvider = (body.provider || '').toString().toLowerCase();
    const connected = body.connected;

    let provider = null;
    if (['google','g','gcal','google_calendar','googlecalendar'].includes(rawProvider)) provider = 'google';
    else if (['microsoft','ms','ms365','m365','outlook','office365','microsoft365'].includes(rawProvider)) provider = 'microsoft';
    else if (['other','ics','generic','manual'].includes(rawProvider)) provider = 'other';

    if (!provider) return res.status(400).json({ ok: false, error: 'INVALID_PROVIDER' });
    if (typeof connected !== 'boolean') return res.status(400).json({ ok: false, error: 'INVALID_CONNECTED_FLAG' });

    const col =
      provider === 'google' ? 'calendar_sync_google'
      : provider === 'microsoft' ? 'calendar_sync_ms'
      : 'calendar_sync_other';

    await db.run(
      `
      UPDATE intime_queues
         SET ${col} = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `,
      [connected ? 1 : 0, Number(id)]
    );

    const updated = await db.get('SELECT * FROM intime_queues WHERE id = ?', Number(id));
    return res.json({ ok: true, queue: updated });
  } catch (err) {
    console.error('Error updating calendar sync:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
}

router.post('/intime/queues/:id/calendar-sync', authRequired, hostRequired, handleCalendarSync);
router.patch('/intime/queues/:id/calendar-sync', authRequired, hostRequired, handleCalendarSync);

/* --------------------------------------------------------------------------
 * Calendar view for a queue (bookings only, unchanged)
 * ------------------------------------------------------------------------ */
router.get(
  '/intime/queues/:id/calendar-view',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      const hostId = getHostId(req);
      const { id } = req.params;

      const queue = await getQueueForHost(id, hostId);
      if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
      if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });

      const bookings = await db.all(
        `
        SELECT
          id,
          queue_id,
          slot_date,
          slot_start,
          slot_end,
          party_size,
          status,
          source,
          created_at,
          redeemed_at
        FROM intime_bookings
        WHERE queue_id = ?
        ORDER BY
          slot_date ASC,
          slot_start ASC,
          created_at ASC
      `,
        Number(id)
      );

      return res.json({
        ok: true,
        queue: {
          id: queue.id,
          name: queue.name,
          location: queue.location,
          queue_mode: queue.queue_mode
        },
        bookings
      });
    } catch (err) {
      console.error('Error loading queue calendar:', err);
      return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
    }
  }
);

/* --------------------------------------------------------------------------
 * Create booking (visitor "use" side)
 * ------------------------------------------------------------------------ */
router.post('/intime/bookings', async (req, res) => {
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
    } = req.body || {};

    if (!queue_id) {
      return res.status(400).json({ ok: false, error: 'MISSING_QUEUE_ID' });
    }

    const queue = await db.get('SELECT * FROM intime_queues WHERE id = ?', Number(queue_id));
    if (!queue) {
      return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    }

    const code9 = await generateUniqueCode9();
    const shortCode = code9;
    const bookingToken =
      'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

    const size = party_size ? Number(party_size) : 1;

    const result = await db.run(
      `
      INSERT INTO intime_bookings (
        queue_id,
        visitor_id,
        visitor_email,
        visitor_name,
        code9,
        short_code,
        booking_token,
        status,
        slot_date,
        slot_start,
        slot_end,
        party_size,
        source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?)
    `,
      [
        queue.id,
        null,
        visitor_email,
        visitor_name,
        code9,
        shortCode,
        bookingToken,
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
        short_code: shortCode,
        booking_token: bookingToken,
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

/* --------------------------------------------------------------------------
 * Redeem booking (host “manage” side)
 * ------------------------------------------------------------------------ */
router.post('/intime/bookings/:id/redeem', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const hostId = getHostId(req);
    const { redeem_location } = req.body || {};

    const booking = await db.get(
      `SELECT b.*, q.host_id
         FROM intime_bookings b
         JOIN intime_queues q ON b.queue_id = q.id
        WHERE b.id = ?`,
      [Number(id)]
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

/* --------------------------------------------------------------------------
 * Cancel booking (visitor “use” side)
 * ------------------------------------------------------------------------ */
router.post('/intime/bookings/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;

    const booking = await db.get('SELECT * FROM intime_bookings WHERE id = ?', Number(id));
    if (!booking) {
      return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });
    }

    if (booking.status !== 'booked') {
      return res.status(400).json({ ok: false, error: 'BOOKING_NOT_ACTIVE' });
    }

    await db.run(`UPDATE intime_bookings SET status = 'cancelled' WHERE id = ?`, [booking.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error cancelling booking:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

export default router;
