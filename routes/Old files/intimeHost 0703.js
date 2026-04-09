// routes/intimeHost.js — MERGED (old intime_queues schema + new holds/device/capacity system)

import express from 'express';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { google } from 'googleapis';

import { getDb } from '../config/db.js';
import { authRequired, hostRequired, getHostId } from '../middleware/auth.js';
import { toBoolInt, randomSlug, generateUniqueCode9, buildQueueQrPayload } from '../lib/intimeHelpers.js';
import { getGoogleOAuth2Client } from '../config/googleCalendar.js';
import { getHostCalendarConnection } from '../lib/calendarConnections.js';

const router = express.Router();
const db = getDb();

console.log('[BOOT] intimeHostRoutes loaded from routes/intimeHost.js');

/* -------------------------------------------------------------------------- */
/* Debug logger                                                               */
/* -------------------------------------------------------------------------- */
router.use('/intime', (req, _res, next) => {
  console.log('[INTIME API]', req.method, req.originalUrl || req.url, 'CT:', req.headers['content-type']);
  next();
});

/* -------------------------------------------------------------------------- */
/* Utils                                                                      */
/* -------------------------------------------------------------------------- */
function normalizeDeviceId(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 128) return null;
  return s;
}

function isYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

/* -------------------------------------------------------------------------- */
/* Luhn mod-N checksum (base36, N=36)                                         */
/* -------------------------------------------------------------------------- */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const N = 36;

function base36CharToVal(ch) {
  const i = ALPHABET.indexOf(String(ch || '').toUpperCase());
  return i < 0 ? null : i;
}

function valToBase36Char(v) {
  return ALPHABET[v % N];
}

function luhnModNChecksumChar(payload, n = 36) {
  const s = String(payload || '').toUpperCase();
  let sum = 0;
  let doubleIt = true;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = base36CharToVal(s[i]);
    if (v === null) throw new Error('Invalid base36 char in alias');
    let add = doubleIt ? (v * 2 >= n ? v * 2 - (n - 1) : v * 2) : v;
    sum += add;
    doubleIt = !doubleIt;
  }
  return valToBase36Char((n - (sum % n)) % n);
}

function randomBase36(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % N];
  return out;
}

/* -------------------------------------------------------------------------- */
/* Calendar range helper                                                      */
/* -------------------------------------------------------------------------- */
function computeRangeUTC(view = 'week', dateStr) {
  const ref = dateStr ? new Date(`${dateStr}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(ref.getTime())) return computeRangeUTC(view, new Date().toISOString().slice(0, 10));
  const v = String(view || 'week').toLowerCase();
  if (v === 'day') {
    const s = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
    return { start: s, end: new Date(s.getTime() + 86400000) };
  }
  if (v === 'month') {
    return {
      start: new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1)),
      end:   new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1))
    };
  }
  // week: Mon → Mon
  const day = ref.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate() + offset));
  return { start, end: new Date(start.getTime() + 7 * 86400000) };
}

/* -------------------------------------------------------------------------- */
/* Queue ownership helper                                                     */
/* -------------------------------------------------------------------------- */
async function getQueueForHost(queueId, hostId) {
  const q = await db.get('SELECT * FROM intime_queues WHERE id = ?', [Number(queueId)]);
  if (!q) return null;
  if (hostId && q.host_id && Number(q.host_id) !== Number(hostId)) return 'NOT_OWNER';
  return q;
}

/* -------------------------------------------------------------------------- */
/* Internal calendar helper                                                   */
/* -------------------------------------------------------------------------- */
async function createInternalCalendarForQueue({ queueId, hostId, timezone = 'UTC' }) {
  const result = await db.run(
    `INSERT INTO queue_calendars (queue_id, host_id, timezone, status) VALUES (?, ?, ?, 'active')`,
    [Number(queueId), Number(hostId), timezone || 'UTC']
  );
  return result.lastID;
}

/* ========================================================================== */
/* QUEUE ROUTES                                                                */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* POST /api/intime/queues — create queue (host)                              */
/* -------------------------------------------------------------------------- */
router.post('/intime/queues', authRequired, hostRequired, async (req, res) => {
  const hostId = getHostId(req);
  try {
    const {
      name, location, gps_lat, gps_lng,
      queue_mode,
      anon_booking_allowed, requires_login, requires_whitelist,
      wave_capacity, time_per_slot_minutes, show_estimate,
      mixed_patterns, operating_days, off_duty_periods,
      calendar_sync_google, calendar_sync_ms, calendar_sync_other,
      valid_from, valid_to, status = 'active',
      allowed_visitors_emails, timezone
    } = req.body || {};

    if (!name) return res.status(400).json({ ok: false, error: 'MISSING_NAME' });
    if (!queue_mode || !['live', 'advance', 'mixed'].includes(queue_mode))
      return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_MODE' });

    const slug = randomSlug('q');

    const result = await db.run(
      `INSERT INTO intime_queues (
        host_id, name, location, gps_lat, gps_lng,
        queue_mode, anon_booking_allowed, requires_login, requires_whitelist,
        wave_capacity, time_per_slot_minutes, show_estimate,
        mixed_patterns, operating_days, off_duty_periods,
        calendar_sync_google, calendar_sync_ms, calendar_sync_other,
        internal_calendar_id, slug, qr_payload, status,
        valid_from, valid_to, allowed_visitors_emails
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hostId, name || null, location || null,
        gps_lat != null ? Number(gps_lat) : null,
        gps_lng != null ? Number(gps_lng) : null,
        queue_mode,
        toBoolInt(anon_booking_allowed), toBoolInt(requires_login), toBoolInt(requires_whitelist),
        wave_capacity != null ? Number(wave_capacity) : null,
        time_per_slot_minutes != null ? Number(time_per_slot_minutes) : null,
        toBoolInt(show_estimate),
        mixed_patterns?.length ? JSON.stringify(mixed_patterns) : null,
        operating_days?.length ? JSON.stringify(operating_days) : null,
        off_duty_periods?.length ? JSON.stringify(off_duty_periods) : null,
        toBoolInt(calendar_sync_google), toBoolInt(calendar_sync_ms), toBoolInt(calendar_sync_other),
        null, slug, null, status || 'active',
        valid_from || null, valid_to || null,
        Array.isArray(allowed_visitors_emails) && allowed_visitors_emails.length
          ? JSON.stringify(allowed_visitors_emails) : null
      ]
    );

    const queueId = result.lastID;
    const internalCalendarId = await createInternalCalendarForQueue({ queueId, hostId, timezone });

    await db.run(
      `UPDATE intime_queues SET internal_calendar_id = ?, updated_at = NOW() WHERE id = ?`,
      [internalCalendarId, queueId]
    );

    const queueRow = await db.get('SELECT * FROM intime_queues WHERE id = ?', [queueId]);
    const qrPayload = buildQueueQrPayload(queueRow);

    await db.run(
      `UPDATE intime_queues SET qr_payload = ?, updated_at = NOW() WHERE id = ?`,
      [qrPayload, queueId]
    );

    return res.json({ ok: true, queueId, slug, qrPayload, internalCalendarId });
  } catch (err) {
    console.error('[INTIME] create queue error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues — list host's queues                                */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const rows = await db.all(
      'SELECT * FROM intime_queues WHERE host_id = ? ORDER BY created_at DESC',
      [hostId]
    );
    return res.json({ ok: true, queues: rows });
  } catch (err) {
    console.error('[INTIME] list queues error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:idOrSlug — public queue detail                     */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:idOrSlug', async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isNumeric = /^\d+$/.test(idOrSlug);
    const row = isNumeric
      ? await db.get('SELECT * FROM intime_queues WHERE id = ?', [Number(idOrSlug)])
      : await db.get('SELECT * FROM intime_queues WHERE slug = ?', [idOrSlug]);
    if (!row) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    return res.json({ ok: true, queue: row });
  } catch (err) {
    console.error('[INTIME] get queue error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:id/qr — QR PNG (public)                           */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/qr', async (req, res) => {
  try {
    const queue = await db.get('SELECT * FROM intime_queues WHERE id = ?', [Number(req.params.id)]);
    if (!queue) return res.status(404).send('Queue not found');
    const payload = queue.qr_payload || buildQueueQrPayload(queue);
    const pngBuffer = await QRCode.toBuffer(payload, { errorCorrectionLevel: 'M', type: 'png', margin: 2, width: 512 });
    res.setHeader('Content-Type', 'image/png');
    return res.send(pngBuffer);
  } catch (err) {
    console.error('[INTIME] QR error:', err);
    return res.status(500).send('Error generating QR');
  }
});

/* -------------------------------------------------------------------------- */
/* PATCH /api/intime/queues/:id/status — activate / deactivate                */
/* -------------------------------------------------------------------------- */
router.patch('/intime/queues/:id/status', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const { id } = req.params;
    const body = req.body || {};
    let raw = body.is_active ?? body.active ?? body.status;

    let isActiveFlag;
    if (typeof raw === 'boolean') isActiveFlag = raw;
    else if (typeof raw === 'number') isActiveFlag = raw === 1;
    else { const v = String(raw || '').trim().toLowerCase(); isActiveFlag = ['active','a','1','true','yes'].includes(v); }

    const queue = await getQueueForHost(id, hostId);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });

    await db.run(
      `UPDATE intime_queues SET status = ?, updated_at = NOW() WHERE id = ?`,
      [isActiveFlag ? 'active' : 'inactive', Number(id)]
    );
    const updated = await db.get('SELECT * FROM intime_queues WHERE id = ?', [Number(id)]);
    return res.json({ ok: true, queue: updated });
  } catch (err) {
    console.error('[INTIME] update status error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE /api/intime/queues/:id                                              */
/* -------------------------------------------------------------------------- */
router.delete('/intime/queues/:id', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const queue = await getQueueForHost(req.params.id, hostId);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
    await db.run('DELETE FROM intime_queues WHERE id = ?', [Number(req.params.id)]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[INTIME] delete queue error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /PATCH /api/intime/queues/:id/allowlist                                */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/allowlist', authRequired, hostRequired, async (req, res) => {
  try {
    const queue = await getQueueForHost(req.params.id, getHostId(req));
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
    let emails = [];
    try { const p = JSON.parse(queue.allowed_visitors_emails); if (Array.isArray(p)) emails = p; } catch {}
    return res.json({ ok: true, emails });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

router.patch('/intime/queues/:id/allowlist', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const queue = await getQueueForHost(req.params.id, hostId);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
    const normalized = Array.isArray(req.body?.emails)
      ? req.body.emails.map(e => (e || '').trim().toLowerCase()).filter(Boolean)
      : [];
    await db.run(
      `UPDATE intime_queues SET allowed_visitors_emails = ?, updated_at = NOW() WHERE id = ?`,
      [normalized.length ? JSON.stringify(normalized) : null, Number(req.params.id)]
    );
    return res.json({ ok: true, emails: normalized });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /PATCH /api/intime/queues/:id/calendar-sync                           */
/* -------------------------------------------------------------------------- */
async function handleCalendarSync(req, res) {
  try {
    const hostId = getHostId(req);
    const queue = await getQueueForHost(req.params.id, hostId);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
    const body = req.body || {};

    const bulkKeys = ['calendar_sync_google','calendar_sync_ms','calendar_sync_other'];
    if (bulkKeys.some(k => Object.prototype.hasOwnProperty.call(body, k))) {
      const sets = []; const params = [];
      for (const k of bulkKeys) {
        if (typeof body[k] === 'boolean') { sets.push(`${k} = ?`); params.push(body[k] ? 1 : 0); }
      }
      if (!sets.length) return res.status(400).json({ ok: false, error: 'NO_FLAGS_PROVIDED' });
      params.push(Number(req.params.id));
      await db.run(`UPDATE intime_queues SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
      return res.json({ ok: true, queue: await db.get('SELECT * FROM intime_queues WHERE id = ?', [Number(req.params.id)]) });
    }

    const prov = String(body.provider || '').toLowerCase();
    const col =
      ['google','g','gcal'].includes(prov) ? 'calendar_sync_google' :
      ['microsoft','ms','outlook'].includes(prov) ? 'calendar_sync_ms' :
      ['other','ics','manual'].includes(prov) ? 'calendar_sync_other' : null;
    if (!col) return res.status(400).json({ ok: false, error: 'INVALID_PROVIDER' });
    if (typeof body.connected !== 'boolean') return res.status(400).json({ ok: false, error: 'INVALID_CONNECTED_FLAG' });

    await db.run(`UPDATE intime_queues SET ${col} = ?, updated_at = NOW() WHERE id = ?`, [body.connected ? 1 : 0, Number(req.params.id)]);
    return res.json({ ok: true, queue: await db.get('SELECT * FROM intime_queues WHERE id = ?', [Number(req.params.id)]) });
  } catch (err) {
    console.error('[INTIME] calendar-sync error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
}

router.post('/intime/queues/:id/calendar-sync', authRequired, hostRequired, handleCalendarSync);
router.patch('/intime/queues/:id/calendar-sync', authRequired, hostRequired, handleCalendarSync);

/* -------------------------------------------------------------------------- */
/* POST /api/intime/queues/:id/calendar-blocks/sync — import busy blocks      */
/* -------------------------------------------------------------------------- */
router.post('/intime/queues/:id/calendar-blocks/sync', authRequired, hostRequired, async (req, res) => {
  const hostId = getHostId(req);
  const { provider = 'google', view = 'week', date } = req.body || {};
  try {
    const queue = await getQueueForHost(req.params.id, hostId);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
    if (!queue.internal_calendar_id) return res.status(400).json({ ok: false, error: 'NO_INTERNAL_CALENDAR' });
    if (String(provider).toLowerCase() !== 'google') return res.status(400).json({ ok: false, error: 'PROVIDER_NOT_SUPPORTED_YET' });

    const oauth2Client = getGoogleOAuth2Client();
    if (!oauth2Client) return res.status(503).json({ ok: false, error: 'GOOGLE_OAUTH_NOT_CONFIGURED' });
    const conn = await getHostCalendarConnection(hostId, 'google');
    if (!conn) return res.status(400).json({ ok: false, error: 'NO_GOOGLE_CONNECTION' });

    oauth2Client.setCredentials({ access_token: conn.access_token, refresh_token: conn.refresh_token, expiry_date: conn.expiry_date, token_type: conn.token_type });
    const { start, end } = computeRangeUTC(view, date);
    const gcal = google.calendar({ version: 'v3', auth: oauth2Client });
    const fb = await gcal.freebusy.query({ requestBody: { timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone: 'UTC', items: [{ id: 'primary' }] } });
    const busy = (fb?.data?.calendars?.primary?.busy || []).filter(b => b?.start && b?.end);

    await db.run(`DELETE FROM queue_calendar_blocks WHERE calendar_id = ? AND source_provider = 'google'`, [Number(queue.internal_calendar_id)]);
    let inserted = 0;
    for (const b of busy) {
      const r = await db.run(
        `INSERT INTO queue_calendar_blocks (calendar_id, start_utc, end_utc, source_provider, source_ref) VALUES (?, ?, ?, 'google', ?) ON CONFLICT DO NOTHING`,
        [Number(queue.internal_calendar_id), String(b.start), String(b.end), `${b.start}|${b.end}`]
      );
      if (r?.changes) inserted++;
    }

    return res.json({ ok: true, queueId: Number(req.params.id), blocksInserted: inserted, blocksTotal: busy.length });
  } catch (err) {
    console.error('[INTIME] calendar-blocks sync error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:id/calendar-view — bookings calendar (host)        */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/calendar-view', authRequired, hostRequired, async (req, res) => {
  try {
    const queue = await getQueueForHost(req.params.id, getHostId(req));
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
    const bookings = await db.all(
      `SELECT id, queue_id, slot_date, slot_start, slot_end, party_size, status, source, created_at, redeemed_at
       FROM intime_bookings WHERE queue_id = ? ORDER BY slot_date ASC, slot_start ASC`,
      [Number(req.params.id)]
    );
    return res.json({ ok: true, queue: { id: queue.id, name: queue.name, location: queue.location, queue_mode: queue.queue_mode }, bookings });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:id/availability?day=YYYY-MM-DD (host)              */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/availability', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const queueId = Number(req.params.id);
    const queue = await getQueueForHost(queueId, hostId);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
    const { day } = req.query;
    if (!isYmd(day)) return res.status(400).json({ ok: false, error: 'INVALID_DAY' });

    // Expire stale holds
    await db.run(
      `UPDATE holds SET status = 'EXPIRED', updated_at = NOW() WHERE queue_id = ? AND valid_use_day = ?::date AND status = 'HELD' AND expires_at <= NOW()`,
      [queueId, day]
    );

    const cap = await db.get(`SELECT capacity_total FROM queue_day_capacity WHERE queue_id = ? AND day = ?::date`, [queueId, day]);
    if (!cap) return res.status(404).json({ ok: false, error: 'CAPACITY_NOT_SET_FOR_DAY' });

    const booked = await db.get(
      `SELECT COALESCE(SUM(party_size),0) AS booked_count FROM intime_bookings WHERE queue_id = ? AND slot_date = ? AND UPPER(status) = 'BOOKED'`,
      [queueId, day]
    );
    const held = await db.get(
      `SELECT COALESCE(SUM(party_size),0) AS held_count FROM holds WHERE queue_id = ? AND valid_use_day = ?::date AND UPPER(status) = 'HELD' AND expires_at > NOW()`,
      [queueId, day]
    );

    const capacity_total = Number(cap.capacity_total);
    const booked_count = Number(booked?.booked_count || 0);
    const held_count = Number(held?.held_count || 0);
    return res.json({ ok: true, queue_id: queueId, day, capacity_total, booked_count, held_count, remaining: Math.max(capacity_total - booked_count - held_count, 0) });
  } catch (err) {
    console.error('[INTIME] availability error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* ========================================================================== */
/* HOLDS ROUTES                                                                */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* POST /api/intime/holds — create hold (public, requires Idempotency-Key)    */
/* -------------------------------------------------------------------------- */
router.post('/intime/holds', async (req, res) => {
  try {
    const idem = String(req.get('Idempotency-Key') || '').trim();
    if (!idem) return res.status(400).json({ ok: false, error: 'MISSING_IDEMPOTENCY_KEY' });

    const { queue_id, device_id, valid_use_day, party_size = 1, source = null, reason = null } = req.body || {};
    if (!queue_id) return res.status(400).json({ ok: false, error: 'MISSING_QUEUE_ID' });

    const deviceId = normalizeDeviceId(device_id);
    if (!deviceId) return res.status(400).json({ ok: false, error: 'MISSING_DEVICE_ID' });
    if (!isYmd(valid_use_day)) return res.status(400).json({ ok: false, error: 'INVALID_VALID_USE_DAY' });

    let ps = Number(party_size);
    if (!Number.isFinite(ps) || ps < 1) ps = 1;
    if (ps > 5) return res.status(400).json({ ok: false, error: 'PARTY_SIZE_MAX_5' });

    const queue = await db.get('SELECT id FROM intime_queues WHERE id = ?', [Number(queue_id)]);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });

    const hold = await db.tx(async (t) => {
      await t.run(
        `INSERT INTO device_identities(device_id, first_seen_at, last_seen_at) VALUES (?, NOW(), NOW()) ON CONFLICT (device_id) DO UPDATE SET last_seen_at = NOW()`,
        [deviceId]
      );

      const ins = await t.get(
        `INSERT INTO holds (queue_id, device_id, status, valid_use_day, expires_at, party_size, source, reason, idempotency_key)
         VALUES (?, ?, 'HELD', ?::date, NOW() + INTERVAL '15 minutes', ?, ?, ?, ?)
         ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = holds.updated_at
         RETURNING hold_id`,
        [Number(queue.id), deviceId, String(valid_use_day), ps, source, reason, idem]
      );

      await t.run(
        `UPDATE holds SET status = 'EXPIRED', updated_at = NOW() WHERE hold_id = ? AND status = 'HELD' AND expires_at <= NOW()`,
        [Number(ins.hold_id)]
      );

      return await t.get(`SELECT *, to_char(valid_use_day, 'YYYY-MM-DD') AS valid_use_day FROM holds WHERE hold_id = ?`, [Number(ins.hold_id)]);
    });

    return res.json({ ok: true, hold });
  } catch (err) {
    console.error('[INTIME] create hold error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/intime/holds/:hold_id/release                                    */
/* -------------------------------------------------------------------------- */
router.post('/intime/holds/:hold_id/release', async (req, res) => {
  try {
    const holdId = Number(req.params.hold_id);
    if (!Number.isFinite(holdId)) return res.status(400).json({ ok: false, error: 'INVALID_HOLD_ID' });
    const row = await db.get(
      `UPDATE holds SET status = CASE WHEN status = 'HELD' THEN 'RELEASED' ELSE status END, updated_at = NOW()
       WHERE hold_id = ? RETURNING hold_id, queue_id, device_id, status, to_char(valid_use_day,'YYYY-MM-DD') AS valid_use_day, expires_at, party_size`,
      [holdId]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'HOLD_NOT_FOUND' });
    return res.json({ ok: true, hold: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:id/holds?day=YYYY-MM-DD (host)                     */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/holds', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const queueId = Number(req.params.id);
    const queue = await getQueueForHost(queueId, hostId);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
    const { day } = req.query;
    if (!isYmd(day)) return res.status(400).json({ ok: false, error: 'INVALID_DAY' });

    await db.run(
      `UPDATE holds SET status = 'EXPIRED', updated_at = NOW() WHERE queue_id = ? AND valid_use_day = ?::date AND status = 'HELD' AND expires_at <= NOW()`,
      [queueId, day]
    );

    const rows = await db.all(
      `SELECT hold_id, queue_id, device_id, status, to_char(valid_use_day,'YYYY-MM-DD') AS valid_use_day, expires_at, party_size, source, reason, created_at
       FROM holds WHERE queue_id = ? AND valid_use_day = ?::date ORDER BY created_at DESC`,
      [queueId, day]
    );

    return res.json({ ok: true, queue_id: queueId, day, count: rows.length, holds: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* ========================================================================== */
/* BOOKING ROUTES                                                              */
/* ========================================================================== */

/* -------------------------------------------------------------------------- */
/* POST /api/intime/bookings — create booking (visitor)                       */
/* -------------------------------------------------------------------------- */
router.post('/intime/bookings', async (req, res) => {
  try {
    const {
      queue_id, device_id, source, party_size,
      slot_date, slot_start, slot_end,
      visitor_email = null, visitor_name = null,
      include_qr = true
    } = req.body || {};

    if (!queue_id) return res.status(400).json({ ok: false, error: 'MISSING_QUEUE_ID' });

    const queue = await db.get('SELECT * FROM intime_queues WHERE id = ?', [Number(queue_id)]);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });

    const deviceId = normalizeDeviceId(device_id);
    const size = party_size ? Number(party_size) : 1;

    const code9 = await generateUniqueCode9();
    const bookingToken = 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

    // Generate Luhn human ref
    let humanRefAlias = null, humanRefChecksum = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const alias = randomBase36(8);
      const checksum = luhnModNChecksumChar(alias, 36);
      const existing = await db.get('SELECT id FROM intime_bookings WHERE human_ref_alias = ?', [alias]);
      if (!existing) { humanRefAlias = alias; humanRefChecksum = checksum; break; }
    }
    if (!humanRefAlias) return res.status(500).json({ ok: false, error: 'FAILED_TO_GENERATE_HUMAN_REF' });

    // Ensure device identity
    if (deviceId) {
      await db.run(
        `INSERT INTO device_identities(device_id, first_seen_at, last_seen_at) VALUES (?, NOW(), NOW()) ON CONFLICT (device_id) DO UPDATE SET last_seen_at = NOW()`,
        [deviceId]
      );
    }

    const result = await db.run(
      `INSERT INTO intime_bookings (
        queue_id, visitor_id, visitor_email, visitor_name,
        device_id, code9, short_code, booking_token,
        human_ref_alias, human_ref_checksum,
        status, slot_date, slot_start, slot_end, party_size, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?)`,
      [
        queue.id, null, visitor_email, visitor_name,
        deviceId || null, code9, code9, bookingToken,
        humanRefAlias, humanRefChecksum,
        slot_date || null, slot_start || null, slot_end || null, size, source || null
      ]
    );

    const bookingId = result.lastID;
    const humanRef = `${humanRefAlias}${humanRefChecksum}`;
    const qrPayload = `intime:booking:${bookingToken}`;

    let qr = null;
    if (include_qr) {
      const pngBuffer = await QRCode.toBuffer(qrPayload, { errorCorrectionLevel: 'M', type: 'png', margin: 2, width: 384 });
      qr = { payload: qrPayload, image_base64: `data:image/png;base64,${pngBuffer.toString('base64')}` };
    }

    return res.json({
      ok: true,
      booking: { id: bookingId, queue_id: queue.id, code9, human_ref: humanRef, booking_token: bookingToken, slot_date, slot_start, slot_end, party_size: size, source: source || null },
      qr
    });
  } catch (err) {
    console.error('[INTIME] create booking error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:id/bookings (host)                                 */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/bookings', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const queueId = Number(req.params.id);
    const queue = await getQueueForHost(queueId, hostId);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (queue === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });

    const { day, from, to, status } = req.query || {};
    let dateFrom, dateTo;
    if (day && isYmd(day)) { dateFrom = dateTo = day; }
    else if (from && to && isYmd(from) && isYmd(to)) { dateFrom = from; dateTo = to; }
    else {
      const d = new Date();
      dateFrom = dateTo = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    const params = [queueId, dateFrom, dateTo];
    let whereStatus = '';
    if (status) { params.push(String(status).toUpperCase()); whereStatus = ` AND UPPER(b.status) = $${params.length}`; }

    const rows = await db.all(
      `SELECT b.id AS booking_id, b.queue_id, b.device_id, b.visitor_email, b.visitor_name,
              b.status, b.booking_token, b.code9,
              (b.human_ref_alias || b.human_ref_checksum) AS human_ref,
              b.slot_date AS valid_use_day, b.slot_start, b.slot_end,
              b.party_size, b.source, b.created_at, b.redeemed_at
       FROM intime_bookings b
       WHERE b.queue_id = $1 AND b.slot_date BETWEEN $2 AND $3 ${whereStatus}
       ORDER BY b.slot_date DESC, b.created_at DESC`,
      params
    );

    return res.json({ ok: true, queue_id: queueId, from: dateFrom, to: dateTo, count: rows.length, bookings: rows });
  } catch (err) {
    console.error('[INTIME] list bookings error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/bookings/:id (host)                                        */
/* -------------------------------------------------------------------------- */
router.get('/intime/bookings/:id', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const row = await db.get(
      `SELECT b.*, (b.human_ref_alias || b.human_ref_checksum) AS human_ref
       FROM intime_bookings b
       JOIN intime_queues q ON q.id = b.queue_id
       WHERE b.id = ? AND q.host_id = ?`,
      [Number(req.params.id), Number(hostId)]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });
    return res.json({ ok: true, booking: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/intime/bookings/:id/redeem (host)                                */
/* -------------------------------------------------------------------------- */
router.post('/intime/bookings/:id/redeem', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const { redeem_location } = req.body || {};
    const booking = await db.get(
      `SELECT b.*, q.host_id FROM intime_bookings b JOIN intime_queues q ON b.queue_id = q.id WHERE b.id = ?`,
      [Number(req.params.id)]
    );
    if (!booking) return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });
    if (hostId && booking.host_id && Number(booking.host_id) !== Number(hostId))
      return res.status(403).json({ ok: false, error: 'NOT_OWNER' });
    if (booking.status === 'redeemed') return res.json({ ok: true, alreadyRedeemed: true });

    await db.run(
      `UPDATE intime_bookings SET status = 'redeemed', redeemed_at = NOW(), redeem_host_id = ?, redeem_location = ?, updated_at = NOW() WHERE id = ?`,
      [hostId, redeem_location || null, booking.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[INTIME] redeem error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/intime/bookings/:id/cancel (visitor)                             */
/* -------------------------------------------------------------------------- */
router.post('/intime/bookings/:id/cancel', async (req, res) => {
  try {
    const booking = await db.get('SELECT * FROM intime_bookings WHERE id = ?', [Number(req.params.id)]);
    if (!booking) return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });
    if (booking.status !== 'booked') return res.status(400).json({ ok: false, error: 'BOOKING_NOT_ACTIVE' });
    await db.run(`UPDATE intime_bookings SET status = 'cancelled', updated_at = NOW() WHERE id = ?`, [booking.id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

export default router;
