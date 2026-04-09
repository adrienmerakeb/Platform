// routes/intimeHost.js
// In-Time API — Postgres canonical tables ONLY
// Tables: public.queues / public.bookings / public.holds / public.device_identities / public.queue_day_capacity
//
// Includes:
// - Host: create/list queues
// - Public: read queue + queue QR
// - Public: create bookings (idempotent, device identity ensured, optional QR)
// - Host: list bookings for a queue/day-range (with expires_at_local)
// - Host: get single booking by booking_id (ownership enforced)
// - Public: create holds (idempotent via Idempotency-Key, device identity ensured, TTL)
// - Host: list holds for a queue/day (ownership enforced; marks expired HELD as EXPIRED)
// - Public/Host: release hold (safe repeated release)
// - Host: availability for a day (uses queue_day_capacity + SUM(party_size) from bookings + active holds)

import express from 'express';
import QRCode from 'qrcode';
import crypto from 'crypto';

import { getDb } from '../config/db.js';
const db = getDb();
import { authRequired, hostRequired, getHostId } from '../middleware/auth.js';

const router = express.Router();

// Boot marker: proves this file is loaded
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
  if (!s) return null;
  if (s.length > 128) return null;
  return s;
}

function isYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

/* -------------------------------------------------------------------------- */
/* Option A: Luhn mod N for base36 strings (N=36)                              */
/* - alias = CHAR(8), checksum = CHAR(1)                                      */
/* -------------------------------------------------------------------------- */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const N = 36;

function base36CharToVal(ch) {
  const c = String(ch || '').toUpperCase();
  const i = ALPHABET.indexOf(c);
  return i < 0 ? null : i;
}

function valToBase36Char(v) {
  return ALPHABET[v % N];
}

function luhnModNChecksumChar(payload, n = 36) {
  const s = String(payload || '').toUpperCase();
  let sum = 0;
  let doubleIt = true; // checksum appended at end => start doubling from rightmost payload char

  for (let i = s.length - 1; i >= 0; i--) {
    const v = base36CharToVal(s[i]);
    if (v === null) throw new Error('Invalid base36 char in alias');

    let add = v;
    if (doubleIt) {
      add = v * 2;
      if (add >= n) add = add - (n - 1);
    }
    sum += add;
    doubleIt = !doubleIt;
  }

  const mod = sum % n;
  const checkVal = (n - mod) % n;
  return valToBase36Char(checkVal);
}

function randomBase36(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % N];
  return out;
}

/* -------------------------------------------------------------------------- */
/* Canonical queue helper (ownership check)                                   */
/* -------------------------------------------------------------------------- */
async function getCanonicalQueueForHost(queueId, hostId) {
  const q = await db.get(
    `
    SELECT queue_id, host_id, timezone, is_active
    FROM public.queues
    WHERE queue_id = $1
    `,
    [Number(queueId)]
  );
  if (!q) return null;
  if (hostId && q.host_id && Number(q.host_id) !== Number(hostId)) return 'NOT_OWNER';
  return q;
}

/* -------------------------------------------------------------------------- */
/* Queue creation helpers                                                     */
/* -------------------------------------------------------------------------- */
function normalizeFormula(formula) {
  const v = String(formula || '').toUpperCase();
  if (v === 'LIVE_ONLY')     return 'LIVE_ONLY';
  if (v === 'ADVANCE_ONLY')  return 'ADVANCE_ONLY';
  if (v === 'MIXED')         return 'MIXED';
  return null;
}

function mapIdentityPolicy({ anon_booking_allowed, requires_login, requires_whitelist }) {
  if (requires_whitelist) return 'LISTED';
  if (requires_login)     return 'REGISTERED';
  return 'ANONYMOUS';
}

/* -------------------------------------------------------------------------- */
/* POST /api/intime/queues (host)                                             */
/* -------------------------------------------------------------------------- */
router.post('/intime/queues', authRequired, hostRequired, async (req, res) => {
  const hostId = getHostId(req);

  try {
    const {
      // Core identity
      name,
      venue_name,
      internal_label,
      // Location — page_1.html sends lat/lng (not gps_lat/gps_lng)
      lat,
      lng,
      timezone,
      home_region,
      // Queue behaviour — page_1.html sends formula directly ('LIVE_ONLY' etc.)
      formula,
      archetype,
      admission_mode,
      access_publics,
      // Lifecycle
      status = 'active',
    } = req.body || {};

    if (!name) return res.status(400).json({ ok: false, error: 'MISSING_NAME' });

    const booking_formula = normalizeFormula(formula);
    if (!booking_formula) return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_MODE' });

    // identity_policy: page_1.html doesn't send these flags yet — default ANONYMOUS
    const identity_policy = mapIdentityPolicy({
      requires_whitelist: false,
      requires_login:     false,
    });

    const is_active = String(status).toLowerCase() === 'active';

    const locationGeo = {
      lat: lat != null ? Number(lat) : null,
      lng: lng != null ? Number(lng) : null,
    };

    const out = await db.tx(async (t) => {
      const q = await t.get(
        `
        INSERT INTO public.queues
          (host_id, name, venue_name, internal_label,
           location_geo, timezone, home_region,
           archetype, booking_formula, admission_mode,
           capacity_model, identity_policy,
           publics_json,
           no_scan_mode_enabled, is_active,
           created_at, updated_at)
        VALUES
          ($1, $2, $3, $4,
           $5::jsonb, $6, $7,
           $8, $9, $10,
           'WAVES', $11,
           $12::jsonb,
           false, $13,
           now(), now())
        RETURNING queue_id
        `,
        [
          Number(hostId),                             // $1
          String(name),                               // $2
          venue_name   || null,                       // $3
          internal_label || null,                     // $4
          JSON.stringify(locationGeo),                // $5
          timezone     || 'UTC',                      // $6
          home_region  || 'EU',                       // $7
          archetype    || 'C',                        // $8
          booking_formula,                            // $9
          admission_mode || null,                     // $10
          identity_policy,                            // $11
          JSON.stringify(access_publics || []),       // $12
          is_active,                                  // $13
        ]
      );

      const queueId = Number(q.queue_id);
      const qrPayload = `intime:queue:${queueId}`;
      return { queueId, qrPayload };
    });

    return res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[INTIME] create queue error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues (host)                                              */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const rows = await db.all(
      `
      SELECT
        queue_id AS id,
        host_id,
        name,
        venue_name,
        internal_label,
        location_text,
        location_geo,
        timezone,
        home_region,
        archetype,
        capacity_model,
        booking_formula,
        identity_policy,
        admission_mode,
        publics_json,
        show_desk_id,
        cal_sync,
        cal_provider,
        language,
        currency,
        theme,
        is_active,
        created_at,
        updated_at
      FROM public.queues
      WHERE host_id = $1
      ORDER BY created_at DESC
      `,
      [Number(hostId)]
    );

    return res.json({ ok: true, queues: rows });
  } catch (err) {
    console.error('[INTIME] list queues error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});


/* -------------------------------------------------------------------------- */
/* PATCH /api/intime/queues/:id/status  (host) — toggle active/inactive       */
/* -------------------------------------------------------------------------- */
router.patch('/intime/queues/:id/status', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId  = getHostId(req);
    const queueId = Number(req.params.id);
    if (!Number.isFinite(queueId)) return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_ID' });

    const { is_active } = req.body || {};
    if (is_active === undefined || is_active === null) {
      return res.status(400).json({ ok: false, error: 'MISSING_IS_ACTIVE' });
    }

    const updated = await db.get(
      `UPDATE public.queues
          SET is_active = $1, updated_at = now()
        WHERE queue_id = $2 AND host_id = $3
        RETURNING queue_id AS id, is_active`,
      [!!is_active, queueId, Number(hostId)]
    );

    if (!updated) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    return res.json({ ok: true, id: updated.id, is_active: updated.is_active });
  } catch (err) {
    console.error('[INTIME] status update error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE /api/intime/queues/:id  (host)                                      */
/* -------------------------------------------------------------------------- */
router.delete('/intime/queues/:id', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId  = getHostId(req);
    const queueId = Number(req.params.id);
    if (!Number.isFinite(queueId)) return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_ID' });

    // Verify ownership before deletion
    const owned = await db.get(
      'SELECT queue_id FROM public.queues WHERE queue_id = $1 AND host_id = $2',
      [queueId, Number(hostId)]
    );
    if (!owned) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });

    await db.run('DELETE FROM public.queues WHERE queue_id = $1', [queueId]);
    return res.json({ ok: true, deleted: queueId });
  } catch (err) {
    console.error('[INTIME] delete queue error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* STUB: PATCH /api/intime/queues/:id/allowlist  (host)                       */
/* -------------------------------------------------------------------------- */
router.patch('/intime/queues/:id/allowlist', authRequired, hostRequired, async (_req, res) => {
  // TODO: persist allowed_visitors to public.queue_allowed_visitors
  return res.status(501).json({ ok: false, error: 'NOT_IMPLEMENTED', detail: 'Allowlist route not yet wired.' });
});
router.get('/intime/queues/:id/allowlist', authRequired, hostRequired, async (_req, res) => {
  return res.status(501).json({ ok: false, error: 'NOT_IMPLEMENTED', detail: 'Allowlist route not yet wired.' });
});

/* -------------------------------------------------------------------------- */
/* STUB: PATCH /api/intime/queues/:id/calendar-sync  (host)                   */
/* -------------------------------------------------------------------------- */
router.patch('/intime/queues/:id/calendar-sync', authRequired, hostRequired, async (_req, res) => {
  return res.status(501).json({ ok: false, error: 'NOT_IMPLEMENTED', detail: 'Calendar-sync route not yet wired.' });
});
router.get('/intime/queues/:id/calendar-sync', authRequired, hostRequired, async (_req, res) => {
  return res.status(501).json({ ok: false, error: 'NOT_IMPLEMENTED', detail: 'Calendar-sync route not yet wired.' });
});

/* -------------------------------------------------------------------------- */
/* STUB: GET /api/intime/queues/:id/calendar-view  (host)                     */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/calendar-view', authRequired, hostRequired, async (_req, res) => {
  return res.json({ ok: true, events: [], locks: [], queue_events: [], calendar_events: [] });
});

/* -------------------------------------------------------------------------- */
/* STUB: PATCH /api/intime/queues/:id/locks  (host)                           */
/* -------------------------------------------------------------------------- */
router.patch('/intime/queues/:id/locks', authRequired, hostRequired, async (_req, res) => {
  return res.status(501).json({ ok: false, error: 'NOT_IMPLEMENTED', detail: 'Locks route not yet wired.' });
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:id (public)                                        */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(String(id))) return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_ID' });

    const row = await db.get(
      `
      SELECT
        queue_id AS id,
        host_id,
        name,
        location_text,
        location_geo,
        timezone,
        home_region,
        capacity_model,
        booking_formula,
        identity_policy,
        is_active,
        created_at,
        updated_at
      FROM public.queues
      WHERE queue_id = $1
      `,
      [Number(id)]
    );

    if (!row) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    return res.json({ ok: true, queue: row });
  } catch (err) {
    console.error('[INTIME] get queue error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:id/qr (PNG)                                        */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/qr', async (req, res) => {
  try {
    const { id } = req.params;
    const q = await db.get('SELECT queue_id FROM public.queues WHERE queue_id = $1', [Number(id)]);
    if (!q) return res.status(404).send('Queue not found');

    const payload = `intime:queue:${Number(id)}`;
    const pngBuffer = await QRCode.toBuffer(payload, {
      errorCorrectionLevel: 'M',
      type: 'png',
      margin: 2,
      width: 512
    });

    res.setHeader('Content-Type', 'image/png');
    return res.send(pngBuffer);
  } catch (err) {
    console.error('[INTIME] queue QR error:', err);
    return res.status(500).send('Error generating QR');
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/intime/holds (public)                                            */
/* - Requires Idempotency-Key header                                          */
/* - Ensures device_identities FK exists                                      */
/* - Idempotent via holds(idempotency_key) UNIQUE                             */
/* - expires_at: now() + 15 min TTL (v1)                                      */
/* -------------------------------------------------------------------------- */
router.post('/intime/holds', async (req, res) => {
  try {
    const idem = String(req.get('Idempotency-Key') || '').trim();
    if (!idem) return res.status(400).json({ ok: false, error: 'MISSING_IDEMPOTENCY_KEY' });

    const {
      queue_id,
      device_id,
      valid_use_day,
      party_size = 1,
      source = null,
      reason = null
    } = req.body || {};

    if (!queue_id) return res.status(400).json({ ok: false, error: 'MISSING_QUEUE_ID' });

    const deviceId = normalizeDeviceId(device_id);
    if (!deviceId) return res.status(400).json({ ok: false, error: 'MISSING_DEVICE_ID' });

    if (!isYmd(valid_use_day)) {
      return res.status(400).json({ ok: false, error: 'INVALID_VALID_USE_DAY' });
    }

    let ps = Number(party_size);
    if (!Number.isFinite(ps) || ps < 1) ps = 1;
    if (ps > 5) return res.status(400).json({ ok: false, error: 'PARTY_SIZE_MAX_5' });

    const queue = await db.get('SELECT queue_id FROM public.queues WHERE queue_id = $1', [Number(queue_id)]);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });

    const hold = await db.tx(async (t) => {
      // Ensure device exists (FK requirement)
      await t.run(
        `
        INSERT INTO public.device_identities(device_id, first_seen_at, last_seen_at)
        VALUES ($1, now(), now())
        ON CONFLICT (device_id) DO UPDATE SET last_seen_at = now()
        `,
        [deviceId]
      );

      // Insert hold (15 min TTL). Idempotent by idempotency_key.
      const ins = await t.get(
        `
        INSERT INTO public.holds
          (queue_id, device_id, status, valid_use_day, expires_at, party_size, source, reason, idempotency_key, created_at, updated_at)
        VALUES
          ($1, $2, 'HELD', $3::date, now() + interval '15 minutes', $4, $5, $6, $7, now(), now())
        ON CONFLICT (idempotency_key) DO UPDATE
          SET updated_at = public.holds.updated_at
        RETURNING hold_id
        `,
        [Number(queue.queue_id), deviceId, String(valid_use_day), ps, source, reason, idem]
      );

      // Defensive: mark as expired if already past.
      await t.run(
        `
        UPDATE public.holds
           SET status = 'EXPIRED', updated_at = now()
         WHERE hold_id = $1
           AND status = 'HELD'
           AND expires_at <= now()
        `,
        [Number(ins.hold_id)]
      );

      return await t.get(
        `
        SELECT
          h.hold_id,
          h.queue_id,
          h.device_id,
          h.status,
          to_char(h.valid_use_day, 'YYYY-MM-DD') AS valid_use_day,
          h.expires_at,
          h.party_size,
          h.source,
          h.reason,
          h.idempotency_key,
          h.created_at,
          h.updated_at
        FROM public.holds h
        WHERE h.hold_id = $1
        `,
        [Number(ins.hold_id)]
      );
    });

    return res.json({ ok: true, hold });
  } catch (err) {
    console.error('[INTIME] create hold error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/intime/holds/:hold_id/release (public)                           */
/* - Safe to call multiple times                                              */
/* -------------------------------------------------------------------------- */
router.post('/intime/holds/:hold_id/release', async (req, res) => {
  try {
    const holdId = Number(req.params.hold_id);
    if (!Number.isFinite(holdId)) return res.status(400).json({ ok: false, error: 'INVALID_HOLD_ID' });

    const row = await db.get(
      `
      UPDATE public.holds
         SET status = CASE WHEN status = 'HELD' THEN 'RELEASED' ELSE status END,
             updated_at = now()
       WHERE hold_id = $1
       RETURNING
         hold_id,
         queue_id,
         device_id,
         status,
         to_char(valid_use_day, 'YYYY-MM-DD') AS valid_use_day,
         expires_at,
         party_size,
         source,
         reason,
         idempotency_key,
         created_at,
         updated_at
      `,
      [holdId]
    );

    if (!row) return res.status(404).json({ ok: false, error: 'HOLD_NOT_FOUND' });
    return res.json({ ok: true, hold: row });
  } catch (err) {
    console.error('[INTIME] release hold error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:id/holds?day=YYYY-MM-DD (host)                     */
/* - Ownership checked                                                        */
/* - Marks expired HELD holds as EXPIRED before returning                      */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/holds', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const queueId = Number(req.params.id);

    if (!Number.isFinite(queueId)) {
      return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_ID' });
    }

    const owned = await getCanonicalQueueForHost(queueId, hostId);
    if (!owned) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (owned === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });

    const { day } = req.query || {};
    if (!isYmd(day)) return res.status(400).json({ ok: false, error: 'INVALID_DAY' });

    // Mark expired holds (only those still HELD)
    await db.run(
      `
      UPDATE public.holds
         SET status = 'EXPIRED', updated_at = now()
       WHERE queue_id = $1
         AND valid_use_day = $2::date
         AND status = 'HELD'
         AND expires_at <= now()
      `,
      [queueId, String(day)]
    );

    const rows = await db.all(
      `
      SELECT
        h.hold_id,
        h.queue_id,
        h.device_id,
        h.status,
        to_char(h.valid_use_day, 'YYYY-MM-DD') AS valid_use_day,
        h.expires_at,
        h.party_size,
        h.source,
        h.reason,
        h.idempotency_key,
        h.created_at,
        h.updated_at
      FROM public.holds h
      WHERE h.queue_id = $1
        AND h.valid_use_day = $2::date
      ORDER BY h.created_at DESC
      `,
      [queueId, String(day)]
    );

    return res.json({ ok: true, queue_id: queueId, day: String(day), count: rows.length, holds: rows });
  } catch (err) {
    console.error('[INTIME] list holds error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/intime/bookings (public)                                         */
/* - Ensures device_identities FK exists                                      */
/* - Idempotent via bookings(idempotency_key) unique index                    */
/* - expires_at: end-of-day in queue timezone (local midnight after day)      */
/* - Optional include_qr to avoid huge base64 blobs                            */
/* -------------------------------------------------------------------------- */
router.post('/intime/bookings', async (req, res) => {
  try {
    const { queue_id, device_id, source, party_size, slot_date, slots, include_qr = true } = req.body || {};

    if (!queue_id) return res.status(400).json({ ok: false, error: 'MISSING_QUEUE_ID' });

    const deviceId = normalizeDeviceId(device_id);
    if (!deviceId) return res.status(400).json({ ok: false, error: 'MISSING_DEVICE_ID' });

    const queue = await db.get('SELECT queue_id, timezone FROM public.queues WHERE queue_id = $1', [Number(queue_id)]);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });

    // Normalize slots list
    let slotsList = [];
    if (Array.isArray(slots) && slots.length) slotsList = slots;
    else slotsList = [{ slot_date, party_size }];

    slotsList = slotsList
      .map((s) => ({
        slot_date: s?.slot_date || null,
        party_size: s?.party_size != null ? Number(s.party_size) : (party_size != null ? Number(party_size) : 1)
      }))
      .filter((s) => !!s.slot_date);

    if (!slotsList.length) return res.status(400).json({ ok: false, error: 'MISSING_SLOTS' });

    for (const s of slotsList) {
      if (!isYmd(s.slot_date)) {
        return res.status(400).json({ ok: false, error: 'INVALID_SLOT_DATE', slot_date: s.slot_date });
      }
      if (!Number.isFinite(s.party_size) || s.party_size < 1) s.party_size = 1;
      if (s.party_size > 5) return res.status(400).json({ ok: false, error: 'PARTY_SIZE_MAX_5' });
    }

    const created = await db.tx(async (t) => {
      // Ensure device exists (FK requirement)
      await t.run(
        `
        INSERT INTO public.device_identities(device_id, first_seen_at, last_seen_at)
        VALUES ($1, now(), now())
        ON CONFLICT (device_id) DO UPDATE SET last_seen_at = now()
        `,
        [deviceId]
      );

      const inserted = [];

      for (let i = 0; i < slotsList.length; i++) {
        const s = slotsList[i];
        const idemKey = `intime_post:${deviceId}:${queue.queue_id}:${s.slot_date}:${i}`;

        let row = null;

        for (let attempt = 0; attempt < 20; attempt++) {
          const alias = randomBase36(8);
          const checksum = luhnModNChecksumChar(alias, 36);
          const tokenId = crypto.randomUUID();

          row = await t
            .get(
              `
              INSERT INTO public.bookings
                (queue_id, user_id, device_id, status,
                 created_at, updated_at,
                 token_id, human_ref_alias, human_ref_checksum,
                 valid_use_day, expires_at,
                 party_size, source, idempotency_key)
              VALUES
                ($1, NULL, $2, 'BOOKED',
                 now(), now(),
                 $3::uuid, $4::char(8), $5::char(1),
                 $6::date,
                 ( ( ($6::date + 1)::timestamp AT TIME ZONE $7 ) ),
                 $8, $9, $10)
              ON CONFLICT (idempotency_key) DO UPDATE
                SET updated_at = public.bookings.updated_at
              RETURNING
                booking_id,
                token_id,
                human_ref_alias,
                human_ref_checksum,
                expires_at,
                party_size
              `,
              [
                Number(queue.queue_id),
                deviceId,
                tokenId,
                alias,
                checksum,
                s.slot_date,
                String(queue.timezone || 'UTC'),
                s.party_size,
                source || null,
                idemKey
              ]
            )
            .catch((e) => {
              const msg = String(e?.message || e);
              if (msg.includes('bookings_human_ref_alias_key') || msg.includes('bookings_token_id_key')) return null;
              throw e;
            });

          if (row) break;
        }

        if (!row) throw new Error('FAILED_TO_GENERATE_UNIQUE_HUMAN_REF');

        // IMPORTANT: return valid_use_day deterministically as YYYY-MM-DD (avoid pg Date parsing quirks)
        inserted.push({
          booking_id: Number(row.booking_id),
          token_id: row.token_id,
          human_ref: `${row.human_ref_alias}${row.human_ref_checksum}`,
          valid_use_day: String(s.slot_date),
          expires_at: row.expires_at,
          party_size: Number(row.party_size)
        });
      }

      return inserted;
    });

    let qr = null;
    if (include_qr) {
      qr = [];
      for (const b of created) {
        const payload = `intime:booking:${b.token_id}`;
        const pngBuffer = await QRCode.toBuffer(payload, {
          errorCorrectionLevel: 'M',
          type: 'png',
          margin: 2,
          width: 384
        });
        qr.push({
          booking_id: b.booking_id,
          payload,
          image_base64: `data:image/png;base64,${pngBuffer.toString('base64')}`
        });
      }
    }

    return res.json({
      ok: true,
      queue_id: Number(queue.queue_id),
      device_id: deviceId,
      bookings: created,
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

    if (!Number.isFinite(queueId)) {
      return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_ID' });
    }

    const owned = await getCanonicalQueueForHost(queueId, hostId);
    if (!owned) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (owned === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });

    const { day, from, to, status } = req.query || {};

    const isDay = day && isYmd(day);
    const isFrom = from && isYmd(from);
    const isTo = to && isYmd(to);

    let dateFrom = null;
    let dateTo = null;

    if (isDay) {
      dateFrom = String(day);
      dateTo = String(day);
    } else if (isFrom && isTo) {
      dateFrom = String(from);
      dateTo = String(to);
    } else {
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dateFrom = `${yyyy}-${mm}-${dd}`;
      dateTo = dateFrom;
    }

    const statusFilter = status ? String(status).toUpperCase() : null;

    const params = [queueId, dateFrom, dateTo];
    let whereStatus = '';
    if (statusFilter) {
      params.push(statusFilter);
      whereStatus = ` AND UPPER(b.status) = $${params.length}`;
    }

    const rows = await db.all(
      `
      SELECT
        b.booking_id,
        b.queue_id,
        b.device_id,
        b.user_id,
        b.status,
        b.idempotency_key,
        b.token_id,
        (b.human_ref_alias || b.human_ref_checksum) AS human_ref,
        to_char(b.valid_use_day, 'YYYY-MM-DD') AS valid_use_day,
        b.expires_at,
        to_char(b.expires_at AT TIME ZONE q.timezone, 'YYYY-MM-DD HH24:MI:SS') AS expires_at_local,
        b.party_size,
        b.source,
        b.created_at,
        b.updated_at
      FROM public.bookings b
      JOIN public.queues q ON q.queue_id = b.queue_id
      WHERE b.queue_id = $1
        AND b.valid_use_day BETWEEN $2::date AND $3::date
        ${whereStatus}
      ORDER BY b.valid_use_day DESC, b.created_at DESC
      `,
      params
    );

    return res.json({
      ok: true,
      queue_id: queueId,
      from: dateFrom,
      to: dateTo,
      count: rows.length,
      bookings: rows
    });
  } catch (err) {
    console.error('[INTIME] list bookings error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/bookings/:id (host)                                        */
/* -------------------------------------------------------------------------- */
router.get('/intime/bookings/:id', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const bookingId = Number(req.params.id);

    if (!Number.isFinite(bookingId)) {
      return res.status(400).json({ ok: false, error: 'INVALID_BOOKING_ID' });
    }

    const row = await db.get(
      `
      SELECT
        b.booking_id,
        b.queue_id,
        b.device_id,
        b.user_id,
        b.status,
        b.idempotency_key,
        b.token_id,
        (b.human_ref_alias || b.human_ref_checksum) AS human_ref,
        to_char(b.valid_use_day, 'YYYY-MM-DD') AS valid_use_day,
        b.expires_at,
        to_char(b.expires_at AT TIME ZONE q.timezone, 'YYYY-MM-DD HH24:MI:SS') AS expires_at_local,
        b.party_size,
        b.source,
        b.created_at,
        b.updated_at
      FROM public.bookings b
      JOIN public.queues q ON q.queue_id = b.queue_id
      WHERE b.booking_id = $1
        AND q.host_id = $2
      `,
      [bookingId, Number(hostId)]
    );

    if (!row) return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });

    return res.json({ ok: true, booking: row });
  } catch (err) {
    console.error('[INTIME] get booking error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:id/availability?day=YYYY-MM-DD (host)              */
/* - Ownership checked                                                        */
/* - Uses public.queue_day_capacity + bookings + active holds                  */
/* - Counts are SUM(party_size) (not row counts)                              */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/availability', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const queueId = Number(req.params.id);

    if (!Number.isFinite(queueId)) {
      return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_ID' });
    }

    const owned = await getCanonicalQueueForHost(queueId, hostId);
    if (!owned) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (owned === 'NOT_OWNER') return res.status(403).json({ ok: false, error: 'NOT_OWNER' });

    const { day } = req.query || {};
    if (!isYmd(day)) return res.status(400).json({ ok: false, error: 'INVALID_DAY' });

    // Mark expired holds for that day (so counts are clean)
    await db.run(
      `
      UPDATE public.holds
         SET status = 'EXPIRED', updated_at = now()
       WHERE queue_id = $1
         AND valid_use_day = $2::date
         AND status = 'HELD'
         AND expires_at <= now()
      `,
      [queueId, String(day)]
    );

    const cap = await db.get(
      `
      SELECT capacity_total
      FROM public.queue_day_capacity
      WHERE queue_id = $1 AND day = $2::date
      `,
      [queueId, String(day)]
    );

    if (!cap) {
      return res.status(404).json({ ok: false, error: 'CAPACITY_NOT_SET_FOR_DAY' });
    }

    const booked = await db.get(
      `
      SELECT COALESCE(SUM(party_size), 0) AS booked_count
      FROM public.bookings
      WHERE queue_id = $1
        AND valid_use_day = $2::date
        AND UPPER(status) = 'BOOKED'
      `,
      [queueId, String(day)]
    );

    const held = await db.get(
      `
      SELECT COALESCE(SUM(party_size), 0) AS held_count
      FROM public.holds
      WHERE queue_id = $1
        AND valid_use_day = $2::date
        AND UPPER(status) = 'HELD'
        AND expires_at > now()
      `,
      [queueId, String(day)]
    );

    const capacity_total = Number(cap.capacity_total);
    const booked_count = Number(booked?.booked_count || 0);
    const held_count = Number(held?.held_count || 0);
    const remaining = Math.max(capacity_total - booked_count - held_count, 0);

    return res.json({
      ok: true,
      queue_id: queueId,
      day: String(day),
      capacity_total,
      booked_count,
      held_count,
      remaining
    });
  } catch (err) {
    console.error('[INTIME] availability error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

export default router;
