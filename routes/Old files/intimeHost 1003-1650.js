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

import db from '../config/db.pg.js';
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
function mapQueueModeToBookingFormula(queue_mode) {
  const v = String(queue_mode || '').toLowerCase();
  // Legacy short-form values
  if (v === 'live')         return 'LIVE_ONLY';
  if (v === 'advance')      return 'ADVANCE_ONLY';
  if (v === 'mixed')        return 'MIXED';
  // Wizard internal formula values (passed directly)
  if (v === 'live_only')    return 'LIVE_ONLY';
  if (v === 'advance_only') return 'ADVANCE_ONLY';
  return null;
}

function mapIdentityPolicy({ anon_booking_allowed, requires_login, requires_whitelist }) {
  if (requires_whitelist) return 'LISTED';
  if (requires_login) return 'REGISTERED';
  if (anon_booking_allowed) return 'ANONYMOUS';
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
      // Location — accept both legacy (gps_lat/gps_lng) and wizard (lat/lng) shapes
      location,
      gps_lat,  gps_lng,   // legacy
      lat,      lng,       // wizard
      // Queue mode — accept both 'live'/'advance'/'mixed' and wizard's 'LIVE_ONLY' etc.
      queue_mode,
      formula,             // wizard sends this; queue_mode takes precedence if both present
      // Archetype (wizard)
      archetype,
      // Access — accept both legacy 3-booleans and wizard's access_publics array
      anon_booking_allowed,
      requires_login,
      requires_whitelist,
      access_publics,      // wizard sends array e.g. ['anonymous','registered']
      // Admission
      admission_mode,      // wizard: 'scan' | 'no_scan'
      // Misc
      status = 'active',
      timezone,
      home_region,
    } = req.body || {};

    if (!name) return res.status(400).json({ ok: false, error: 'MISSING_NAME' });

    // Resolve queue_mode: prefer explicit queue_mode, fall back to wizard's formula field
    const resolved_mode = queue_mode || formula;
    const booking_formula = mapQueueModeToBookingFormula(resolved_mode);
    if (!booking_formula) return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_MODE' });

    // Resolve identity_policy: prefer explicit booleans, fall back to access_publics array
    let identity_policy;
    if (access_publics && Array.isArray(access_publics)) {
      if (access_publics.includes('listed'))     identity_policy = 'LISTED';
      else if (access_publics.includes('registered')) identity_policy = 'REGISTERED';
      else                                        identity_policy = 'ANONYMOUS';
    } else {
      identity_policy = mapIdentityPolicy({
        anon_booking_allowed: !!anon_booking_allowed,
        requires_login: !!requires_login,
        requires_whitelist: !!requires_whitelist
      });
    }

    // Resolve GPS coords (wizard uses lat/lng, legacy uses gps_lat/gps_lng)
    const resolved_lat = gps_lat != null ? Number(gps_lat) : (lat != null ? Number(lat) : null);
    const resolved_lng = gps_lng != null ? Number(gps_lng) : (lng != null ? Number(lng) : null);

    // Resolve location text (wizard sends venue_name + address separately)
    const location_text = location || [venue_name, internal_label].filter(Boolean).join(' — ') || null;

    // Derive capacity_model from archetype (wizard) or default WAVES
    const ARCH_TO_CAP = { A: 'PARALLEL', B: 'SEQUENTIAL', C: 'WAVES', D: 'FLOW' };
    const capacity_model = (archetype && ARCH_TO_CAP[archetype]) || 'WAVES';

    // Derive no_scan_mode from wizard's admission_mode
    const no_scan_mode_enabled = admission_mode === 'no_scan';

    // Resolve home_region (wizard sends it; fall back to 'GLOBAL')
    const resolved_home_region = home_region || 'GLOBAL';

    const is_active = String(status).toLowerCase() === 'active';

    const locationGeo = {
      text: location_text,
      lat: resolved_lat,
      lng: resolved_lng
    };

    const out = await db.tx(async (t) => {
      const q = await t.get(
        `
        INSERT INTO public.queues
          (host_id, name, location_text, location_geo, timezone, home_region,
           capacity_model, booking_formula, identity_policy,
           no_scan_mode_enabled, created_at, updated_at, is_active)
        VALUES
          ($1, $2, $3, $4::jsonb, $5, $6,
           $7, $8, $9,
           $10, now(), now(), $11)
        RETURNING queue_id
        `,
        [
          Number(hostId),
          String(name),
          location_text,
          JSON.stringify(locationGeo),
          timezone || 'UTC',
          resolved_home_region,
          capacity_model,
          booking_formula,
          identity_policy,
          no_scan_mode_enabled,
          is_active
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

/* ========================================================================== */
/* HOST OPERATOR MANAGEMENT                                                   */
/* ========================================================================== */

import { hashPassword as _hashPwd } from '../middleware/auth.js';

/* -------------------------------------------------------------------------- */
/* GET /api/host/operators                                                    */
/* -------------------------------------------------------------------------- */
router.get('/host/operators', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const rows = await db.all(
      `SELECT op.id, op.display_name, op.email, op.is_active,
              op.created_at,
              COALESCE(
                json_agg(
                  json_build_object(
                    'queue_id',         oqa.queue_id,
                    'queue_name',       q.name,
                    'can_call_next',    oqa.can_call_next,
                    'can_scan_validate',oqa.can_scan_validate,
                    'can_mark_noshow',  oqa.can_mark_noshow,
                    'can_view_bookings',oqa.can_view_bookings,
                    'can_send_messages',oqa.can_send_messages,
                    'can_release_batch',oqa.can_release_batch
                  ) ORDER BY oqa.queue_id NULLS FIRST
                ) FILTER (WHERE oqa.id IS NOT NULL),
                '[]'
              ) AS access
       FROM public.host_operators op
       LEFT JOIN public.operator_queue_access oqa ON oqa.operator_id = op.id
       LEFT JOIN public.queues q ON q.queue_id = oqa.queue_id
       WHERE op.host_id = $1
       GROUP BY op.id
       ORDER BY op.created_at ASC`,
      [Number(hostId)]
    );
    return res.json({ ok: true, operators: rows });
  } catch (err) {
    console.error('[HOST OPERATORS GET]', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/host/operators                                                   */
/* -------------------------------------------------------------------------- */
// Body: { display_name, email, password, queue_scope: 'all'|[queueId,…], permissions? }
router.post('/host/operators', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);

    // Enforce max 5 operators per host
    const { count } = await db.get(
      `SELECT COUNT(*) AS count FROM public.host_operators WHERE host_id = $1`,
      [Number(hostId)]
    );
    if (Number(count) >= 5) {
      return res.status(400).json({ ok: false, error: 'MAX_OPERATORS_REACHED',
        message: 'A host can have at most 5 operator accounts.' });
    }

    const {
      display_name, email, password,
      queue_scope = 'all',  // 'all' | [queueId, …]
      permissions = {},
    } = req.body || {};

    if (!display_name || !email || !password) {
      return res.status(400).json({ ok: false, error: 'MISSING_FIELDS' });
    }

    const password_hash = await _hashPwd(password);

    const op = await db.get(
      `INSERT INTO public.host_operators (host_id, display_name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [Number(hostId), display_name.trim(), email.trim().toLowerCase(), password_hash]
    );
    const operatorId = op.id;

    // Default permission flags
    const perm = {
      can_call_next:       permissions.can_call_next       ?? true,
      can_scan_validate:   permissions.can_scan_validate   ?? true,
      can_mark_noshow:     permissions.can_mark_noshow     ?? true,
      can_view_bookings:   permissions.can_view_bookings   ?? true,
      can_send_messages:   permissions.can_send_messages   ?? true,
      can_release_batch:   permissions.can_release_batch   ?? true,
    };

    if (queue_scope === 'all') {
      // Single row with queue_id = NULL = all queues
      await db.run(
        `INSERT INTO public.operator_queue_access
           (operator_id, queue_id,
            can_call_next, can_scan_validate, can_mark_noshow,
            can_view_bookings, can_send_messages, can_release_batch)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)`,
        [operatorId, perm.can_call_next, perm.can_scan_validate, perm.can_mark_noshow,
         perm.can_view_bookings, perm.can_send_messages, perm.can_release_batch]
      );
    } else if (Array.isArray(queue_scope) && queue_scope.length) {
      for (const qid of queue_scope) {
        await db.run(
          `INSERT INTO public.operator_queue_access
             (operator_id, queue_id,
              can_call_next, can_scan_validate, can_mark_noshow,
              can_view_bookings, can_send_messages, can_release_batch)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (operator_id, queue_id) DO NOTHING`,
          [operatorId, Number(qid), perm.can_call_next, perm.can_scan_validate,
           perm.can_mark_noshow, perm.can_view_bookings, perm.can_send_messages,
           perm.can_release_batch]
        );
      }
    }

    return res.json({ ok: true, operator_id: operatorId });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'EMAIL_IN_USE',
        message: 'An operator with this email already exists.' });
    }
    console.error('[HOST OPERATORS POST]', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* PUT /api/host/operators/:id                                                */
/* -------------------------------------------------------------------------- */
// Body: { display_name?, email?, password?, is_active? }
router.put('/host/operators/:id', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const opId = Number(req.params.id);

    // Verify ownership
    const op = await db.get(
      `SELECT id FROM public.host_operators WHERE id = $1 AND host_id = $2`,
      [opId, Number(hostId)]
    );
    if (!op) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const { display_name, email, password, is_active } = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;

    if (display_name !== undefined) { sets.push(`display_name = $${i++}`); vals.push(display_name.trim()); }
    if (email !== undefined)        { sets.push(`email = $${i++}`);         vals.push(email.trim().toLowerCase()); }
    if (password !== undefined)     { sets.push(`password_hash = $${i++}`); vals.push(await _hashPwd(password)); }
    if (is_active !== undefined)    { sets.push(`is_active = $${i++}`);     vals.push(!!is_active); }

    if (!sets.length) return res.status(400).json({ ok: false, error: 'NOTHING_TO_UPDATE' });

    sets.push(`updated_at = now()`);
    vals.push(opId);

    await db.run(
      `UPDATE public.host_operators SET ${sets.join(', ')} WHERE id = $${i}`,
      vals
    );

    return res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'EMAIL_IN_USE' });
    }
    console.error('[HOST OPERATORS PUT]', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE /api/host/operators/:id                                             */
/* -------------------------------------------------------------------------- */
router.delete('/host/operators/:id', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const opId = Number(req.params.id);

    const upd = await db.run(
      `DELETE FROM public.host_operators WHERE id = $1 AND host_id = $2`,
      [opId, Number(hostId)]
    );
    if (upd.changes === 0) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[HOST OPERATORS DELETE]', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* PUT /api/host/operators/:id/access                                        */
/* -------------------------------------------------------------------------- */
// Replaces queue access + permission flags for an operator.
// Body: { queue_scope: 'all'|[queueId,…], permissions?: { … } }
router.put('/host/operators/:id/access', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId = getHostId(req);
    const opId = Number(req.params.id);

    const op = await db.get(
      `SELECT id FROM public.host_operators WHERE id = $1 AND host_id = $2`,
      [opId, Number(hostId)]
    );
    if (!op) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const { queue_scope = 'all', permissions = {} } = req.body || {};
    const perm = {
      can_call_next:       permissions.can_call_next       ?? true,
      can_scan_validate:   permissions.can_scan_validate   ?? true,
      can_mark_noshow:     permissions.can_mark_noshow     ?? true,
      can_view_bookings:   permissions.can_view_bookings   ?? true,
      can_send_messages:   permissions.can_send_messages   ?? true,
      can_release_batch:   permissions.can_release_batch   ?? true,
    };

    // Wipe existing access rows for this operator first
    await db.run(
      `DELETE FROM public.operator_queue_access WHERE operator_id = $1`,
      [opId]
    );

    if (queue_scope === 'all') {
      await db.run(
        `INSERT INTO public.operator_queue_access
           (operator_id, queue_id,
            can_call_next, can_scan_validate, can_mark_noshow,
            can_view_bookings, can_send_messages, can_release_batch)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)`,
        [opId, perm.can_call_next, perm.can_scan_validate, perm.can_mark_noshow,
         perm.can_view_bookings, perm.can_send_messages, perm.can_release_batch]
      );
    } else if (Array.isArray(queue_scope)) {
      for (const qid of queue_scope) {
        await db.run(
          `INSERT INTO public.operator_queue_access
             (operator_id, queue_id,
              can_call_next, can_scan_validate, can_mark_noshow,
              can_view_bookings, can_send_messages, can_release_batch)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [opId, Number(qid), perm.can_call_next, perm.can_scan_validate,
           perm.can_mark_noshow, perm.can_view_bookings, perm.can_send_messages,
           perm.can_release_batch]
        );
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[HOST OPERATORS ACCESS PUT]', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

export default router;
