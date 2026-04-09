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
import jwt from 'jsonwebtoken';

import { getDb } from '../config/db.js';
import { authRequired, hostRequired, getHostId, JWT_SECRET } from '../middleware/auth.js';

const db = getDb();

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
  if (v === 'live') return 'LIVE_ONLY';
  if (v === 'advance') return 'ADVANCE_ONLY';
  if (v === 'mixed') return 'MIXED';
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
    const body = req.body || {};

    /* ── accept both legacy fields and new wizard fields ── */
    const name             = body.name;
    const venue_name       = body.venue_name       || null;
    const internal_label   = body.internal_label   || null;
    const timezone         = body.timezone         || 'UTC';
    const home_region      = body.home_region      || 'EU';
    const archetype        = body.archetype        || 'C';
    const language         = body.language         || 'en';
    const currency         = body.currency         || 'EUR';
    const theme            = body.theme            || null;
    const admission_mode   = body.admission_mode   || null;
    const sender_email     = body.sender_email     || null;
    const cal_sync         = !!body.cal_sync;
    const cal_provider     = body.cal_provider     || null;
    const sync_horizon     = body.sync_horizon     != null ? Number(body.sync_horizon) : 90;
    const show_eet         = body.show_eet         !== undefined ? !!body.show_eet : true;
    const show_ete         = body.show_ete         !== undefined ? !!body.show_ete : false;
    const show_desk_id     = !!body.show_desk_id;
    const payment_gate     = !!body.payment_gate;
    const qStatus          = body.status           || 'active';
    const draft_step       = body._draft_step      || null;

    /* location */
    const lat = body.lat != null ? Number(body.lat) : null;
    const lng = body.lng != null ? Number(body.lng) : null;
    const location_text = body.location || body.address || null;
    const locationGeo   = { text: location_text, lat, lng };

    /* booking formula — accept direct or legacy queue_mode */
    let booking_formula = body.formula || body.booking_formula || null;
    if (!booking_formula && body.queue_mode) {
      booking_formula = mapQueueModeToBookingFormula(body.queue_mode);
    }
    if (!booking_formula) booking_formula = 'LIVE_ONLY';

    /* identity policy */
    let identity_policy = 'ANONYMOUS';
    if (Array.isArray(body.access_publics)) {
      if (body.access_publics.includes('listed')) identity_policy = 'LISTED';
      else if (!body.access_publics.includes('anonymous')) identity_policy = 'REGISTERED';
    } else if (body.anon_booking_allowed === false || body.requires_login) {
      identity_policy = body.requires_whitelist ? 'LISTED' : 'REGISTERED';
    }

    const is_active = qStatus === 'active';

    /* JSON blobs */
    const publics_json       = body.access_publics   ? JSON.stringify(body.access_publics)  : null;
    const channels_json      = body.channels         ? JSON.stringify(body.channels)         : null;
    const extra_fields_json  = body.extra_fields      ? JSON.stringify(body.extra_fields)     : null;

    if (!name) return res.status(400).json({ ok: false, error: 'MISSING_NAME' });

    const q = await db.get(
      `
      INSERT INTO public.queues (
        host_id, name, internal_label, venue_name,
        location_text, location_geo, timezone, home_region,
        archetype, booking_formula, capacity_model, identity_policy,
        admission_mode, language, currency, theme,
        cal_sync, cal_provider, sync_horizon,
        show_eet, show_ete, show_desk_id, sender_email,
        payment_gate, channels_json, publics_json, extra_fields_json,
        no_scan_mode_enabled, status, draft_step,
        is_active, created_at, updated_at
      ) VALUES (
        $1,  $2,  $3,  $4,
        $5,  $6::jsonb, $7, $8,
        $9,  $10, 'WAVES', $11,
        $12, $13, $14, $15,
        $16, $17, $18,
        $19, $20, $21, $22,
        $23, $24, $25, $26,
        false, $27, $28,
        $29, now(), now()
      )
      RETURNING queue_id
      `,
      [
        Number(hostId), name, internal_label, venue_name,
        location_text, JSON.stringify(locationGeo), timezone, home_region,
        archetype, booking_formula, identity_policy,
        admission_mode, language, currency, theme,
        cal_sync, cal_provider, sync_horizon,
        show_eet, show_ete, show_desk_id, sender_email,
        payment_gate, channels_json, publics_json, extra_fields_json,
        qStatus, draft_step,
        is_active
      ]
    );

    const queueId   = Number(q.queue_id);
    const qrPayload = `intime:queue:${queueId}`;

    return res.json({ ok: true, queueId, qrPayload });
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
        queue_id          AS id,
        host_id,
        name,
        internal_label,
        venue_name,
        location_text,
        location_geo,
        timezone,
        home_region,
        archetype,
        booking_formula,
        capacity_model,
        identity_policy,
        admission_mode,
        language,
        currency,
        cal_sync,
        show_desk_id,
        is_active,
        status,
        draft_step,
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
        queue_id          AS id,
        host_id,
        name,
        internal_label,
        venue_name,
        location_text,
        location_geo,
        timezone,
        home_region,
        archetype,
        booking_formula,
        capacity_model,
        identity_policy,
        admission_mode,
        language,
        currency,
        theme,
        cal_sync,
        cal_provider,
        sync_horizon,
        show_eet,
        show_ete,
        show_desk_id,
        sender_email,
        channels_json,
        publics_json,
        extra_fields_json,
        wave_config_json,
        schedule_json,
        slots_json,
        calling_json,
        early_spot_json,
        payment_gate,
        is_active,
        status,
        draft_step,
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
/* PATCH /api/intime/queues/:id (host) — update editable fields              */
/* -------------------------------------------------------------------------- */
router.patch('/intime/queues/:id', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId  = getHostId(req);
    const { id }  = req.params;
    if (!/^\d+$/.test(String(id))) return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_ID' });

    /* Verify ownership */
    const existing = await db.get(
      'SELECT queue_id, host_id FROM public.queues WHERE queue_id = $1',
      [Number(id)]
    );
    if (!existing)                                    return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (Number(existing.host_id) !== Number(hostId))  return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    const body = req.body || {};

    /* Build SET clauses for provided fields only */
    const sets = [];
    const vals = [];
    let   p    = 1;

    function maybeSet(col, val) {
      if (val === undefined) return;
      sets.push(`${col} = $${p++}`);
      vals.push(val);
    }

    maybeSet('name',            body.name            !== undefined ? String(body.name) : undefined);
    maybeSet('internal_label',  body.internal_label);
    maybeSet('venue_name',      body.venue_name);
    maybeSet('language',        body.language);
    maybeSet('currency',        body.currency);
    maybeSet('theme',           body.theme);
    maybeSet('admission_mode',  body.admission_mode);
    maybeSet('sender_email',    body.sender_email);
    maybeSet('cal_sync',        body.cal_sync         !== undefined ? !!body.cal_sync         : undefined);
    maybeSet('cal_provider',    body.cal_provider);
    maybeSet('sync_horizon',    body.sync_horizon     != null ? Number(body.sync_horizon)     : undefined);
    maybeSet('show_eet',        body.show_eet         !== undefined ? !!body.show_eet         : undefined);
    maybeSet('show_ete',        body.show_ete         !== undefined ? !!body.show_ete         : undefined);
    maybeSet('show_desk_id',    body.show_desk_id     !== undefined ? !!body.show_desk_id     : undefined);
    maybeSet('payment_gate',    body.payment_gate     !== undefined ? !!body.payment_gate     : undefined);

    /* booking formula */
    if (body.formula !== undefined) {
      maybeSet('booking_formula', body.formula);
    }

    /* identity policy derived from access_publics */
    if (Array.isArray(body.access_publics)) {
      let ip = 'ANONYMOUS';
      if (body.access_publics.includes('listed'))         ip = 'LISTED';
      else if (!body.access_publics.includes('anonymous')) ip = 'REGISTERED';
      maybeSet('identity_policy', ip);
      maybeSet('publics_json', JSON.stringify(body.access_publics));
    }

    /* location */
    if (body.lat != null || body.lng != null) {
      const lat = body.lat != null ? Number(body.lat) : null;
      const lng = body.lng != null ? Number(body.lng) : null;
      const txt = body.address || body.location_text || null;
      maybeSet('location_text', txt);
      maybeSet('location_geo',  JSON.stringify({ text: txt, lat, lng }));
    }

    /* JSON blobs */
    if (body.extra_fields !== undefined)
      maybeSet('extra_fields_json', JSON.stringify(body.extra_fields));
    if (body.channels !== undefined)
      maybeSet('channels_json', JSON.stringify(body.channels));

    /* status / draft_step */
    if (body.status !== undefined) {
      maybeSet('status',    body.status);
      maybeSet('is_active', body.status === 'active');
    }
    if (body.draft_step !== undefined)
      maybeSet('draft_step', body.draft_step);

    if (sets.length === 0)
      return res.status(400).json({ ok: false, error: 'NOTHING_TO_UPDATE' });

    sets.push(`updated_at = now()`);
    vals.push(Number(id));

    await db.run(
      `UPDATE public.queues SET ${sets.join(', ')} WHERE queue_id = $${p}`,
      vals
    );

    return res.json({ ok: true, id: Number(id) });
  } catch (err) {
    console.error('[INTIME] patch queue error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/queues/:id/qr (PNG)                                        */
/* -------------------------------------------------------------------------- */
router.get('/intime/queues/:id/qr', async (req, res) => {
  try {
    const { id } = req.params;
    const q = await db.get(
      'SELECT queue_id, name, venue_name, location_text, location_geo FROM public.queues WHERE queue_id = $1',
      [Number(id)]
    );
    if (!q) return res.status(404).send('Queue not found');

    /* JSON payload — parseable by both visitor scanner and host scanner */
    const geo = q.location_geo || {};
    const payload = JSON.stringify({
      kind:      'intime-queue',
      queue_id:  Number(q.queue_id),
      name:      q.name || '',
      location:  q.location_text || geo.text || '',
      gps_lat:   geo.lat  ?? null,
      gps_lng:   geo.lng  ?? null,
    });
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

    const hold = await (async () => {
      // Ensure device exists (FK requirement)
      await db.run(
        `
        INSERT INTO public.device_identities(device_id, first_seen_at, last_seen_at)
        VALUES ($1, now(), now())
        ON CONFLICT (device_id) DO UPDATE SET last_seen_at = now()
        RETURNING device_id
        `,
        [deviceId]
      );

      // Insert hold (15 min TTL). Idempotent by idempotency_key.
      const ins = await db.get(
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
      await db.run(
        `
        UPDATE public.holds
           SET status = 'EXPIRED', updated_at = now()
         WHERE hold_id = $1
           AND status = 'HELD'
           AND expires_at <= now()
        `,
        [Number(ins.hold_id)]
      );

      return await db.get(
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
    })();

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

    const created = await (async () => {
      // Ensure device exists (FK requirement)
      await db.run(
        `
        INSERT INTO public.device_identities(device_id, first_seen_at, last_seen_at)
        VALUES ($1, now(), now())
        ON CONFLICT (device_id) DO UPDATE SET last_seen_at = now()
        RETURNING device_id
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

          row = await db
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
    })();

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
/* -------------------------------------------------------------------------- */
/* GET /api/intime/bookings/mine (visitor)                                    */
/* Query: ?device_id=<id>&status=BOOKED|REDEEMED|CANCELLED|all               */
/* -------------------------------------------------------------------------- */
router.get('/intime/bookings/mine', async (req, res) => {
  try {
    const { device_id, status } = req.query || {};

    /* Visitor bookings are keyed by device_id (anonymous).
       JWT may be present from a host login cookie — we ignore it here
       because visitor accounts are not yet implemented and bookings
       are created with device_id only (user_id is null).              */
    const deviceId = normalizeDeviceId(device_id);
    if (!deviceId) return res.status(400).json({ ok: false, error: 'MISSING_DEVICE_ID' });

    const statusFilter = status && status !== 'all' ? String(status).toUpperCase() : null;

    let sql, sqlParams;
    if (statusFilter) {
      sql = `
        SELECT b.booking_id, b.queue_id, b.token_id,
          (b.human_ref_alias || b.human_ref_checksum) AS human_ref,
          UPPER(b.status) AS status,
          to_char(b.valid_use_day, 'YYYY-MM-DD') AS valid_use_day,
          b.party_size, b.source, b.created_at,
          q.name AS queue_name, q.venue_name, q.location_text,
          q.archetype, q.booking_formula, q.timezone
        FROM public.bookings b
        JOIN public.queues q ON q.queue_id = b.queue_id
        WHERE b.device_id = $1 AND UPPER(b.status) = $2
        ORDER BY b.valid_use_day ASC, b.created_at DESC
        LIMIT 200`;
      sqlParams = [deviceId, statusFilter];
    } else {
      sql = `
        SELECT b.booking_id, b.queue_id, b.token_id,
          (b.human_ref_alias || b.human_ref_checksum) AS human_ref,
          UPPER(b.status) AS status,
          to_char(b.valid_use_day, 'YYYY-MM-DD') AS valid_use_day,
          b.party_size, b.source, b.created_at,
          q.name AS queue_name, q.venue_name, q.location_text,
          q.archetype, q.booking_formula, q.timezone
        FROM public.bookings b
        JOIN public.queues q ON q.queue_id = b.queue_id
        WHERE b.device_id = $1
        ORDER BY b.valid_use_day ASC, b.created_at DESC
        LIMIT 200`;
      sqlParams = [deviceId];
    }

    const rows = await db.all(sql, sqlParams);

    const bookings = rows.map(b => ({
      ...b,
      short_code: b.human_ref
        ? (b.human_ref.length >= 9
            ? b.human_ref.slice(0,3)+'-'+b.human_ref.slice(3,6)+'-'+b.human_ref.slice(6)
            : b.human_ref)
        : null,
    }));

    return res.json({ ok: true, bookings, count: bookings.length });
  } catch (err) {
    console.error('[INTIME] mine error:', err.message, err.stack);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

router.post('/intime/bookings/:id/cancel', async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    if (!Number.isFinite(bookingId)) return res.status(400).json({ ok: false, error: 'INVALID_BOOKING_ID' });

    const { device_id } = req.body || {};

    let userId   = null;
    let deviceId = null;

    if (req.cookies?.token) {
      try {
        const decoded = jwt.verify(req.cookies.token, JWT_SECRET);
        if (decoded?.id && decoded?.role === 'visitor') userId = Number(decoded.id);
      } catch { /* anonymous */ }
    }

    if (!userId) {
      deviceId = normalizeDeviceId(device_id);
      if (!deviceId) return res.status(400).json({ ok: false, error: 'MISSING_DEVICE_ID' });
    }

    const booking = await db.get(
      'SELECT booking_id, device_id, user_id, status FROM public.bookings WHERE booking_id = $1',
      [bookingId]
    );

    if (!booking) return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });

    const owns = userId
      ? Number(booking.user_id) === userId
      : String(booking.device_id) === String(deviceId);

    if (!owns) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    const bStatus = String(booking.status || '').toUpperCase();
    if (bStatus === 'REDEEMED')  return res.status(409).json({ ok: false, error: 'ALREADY_REDEEMED' });
    if (bStatus === 'CANCELLED') return res.json({ ok: true, already: true });

    await db.run(
      `UPDATE public.bookings SET status = 'CANCELLED', updated_at = now() WHERE booking_id = $1`,
      [bookingId]
    );

    return res.json({ ok: true, booking_id: bookingId, status: 'CANCELLED' });
  } catch (err) {
    console.error('[INTIME] cancel error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

/* GET /api/intime/bookings/by-token/:token (host scan)                       */
/* - token = the raw token_id UUID encoded in the booking QR                 */
/* - No auth required (operator device might not be logged in as host user)  */
/* - Returns full booking + queue_name so the scanner UI can display it      */
/* -------------------------------------------------------------------------- */
router.get('/intime/bookings/by-token/:token', async (req, res) => {
  try {
    const raw = String(req.params.token || '').trim();
    if (!raw) return res.status(400).json({ ok: false, error: 'MISSING_TOKEN' });

    /* Accept both bare UUID and "intime:booking:<uuid>" prefix */
    const token = raw.replace(/^intime:booking:/i, '');

    const row = await db.get(
      `
      SELECT
        b.booking_id,
        b.queue_id,
        b.token_id,
        (SUBSTRING(b.human_ref_alias,1,3) || '-' ||
         SUBSTRING(b.human_ref_alias,4,3) || '-' ||
         SUBSTRING(b.human_ref_alias,7,2) || b.human_ref_checksum)  AS short_code,
        (b.human_ref_alias || b.human_ref_checksum)                  AS human_ref,
        b.status,
        UPPER(b.status)                              AS status_upper,
        to_char(b.valid_use_day, 'YYYY-MM-DD')       AS valid_use_day,
        b.expires_at,
        b.party_size,
        b.source,
        b.redeemed_at,
        b.created_at,
        q.name                                       AS queue_name,
        q.venue_name,
        q.archetype,
        q.host_id
      FROM public.bookings b
      JOIN public.queues   q ON q.queue_id = b.queue_id
      WHERE b.token_id = $1::uuid
      `,
      [token]
    );

    if (!row) return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });

    /* Normalise status to uppercase for the UI */
    row.status = String(row.status || '').toUpperCase();
    delete row.status_upper;

    return res.json({ ok: true, booking: row });
  } catch (err) {
    console.error('[INTIME] by-token error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/intime/bookings/redeem (host scan)                               */
/* Body: { booking_token, count? }                                            */
/* - booking_token: raw token_id UUID (or intime:booking:<uuid>)             */
/* - count: omit or 0 = redeem all; 1 = redeem 1 of party                   */
/* -------------------------------------------------------------------------- */
router.post('/intime/bookings/redeem', async (req, res) => {
  try {
    const { booking_token, count } = req.body || {};
    if (!booking_token) return res.status(400).json({ ok: false, error: 'MISSING_TOKEN' });

    const token = String(booking_token).trim().replace(/^intime:booking:/i, '');

    const booking = await db.get(
      `SELECT booking_id, queue_id, status, party_size, redeemed_at FROM public.bookings WHERE token_id = $1::uuid`,
      [token]
    );

    if (!booking) return res.status(404).json({ ok: false, error: 'BOOKING_NOT_FOUND' });

    const status = String(booking.status || '').toUpperCase();

    if (status === 'REDEEMED') {
      return res.json({ ok: true, already: true, status: 'REDEEMED', booking_id: Number(booking.booking_id) });
    }
    if (status === 'CANCELLED') {
      return res.status(409).json({ ok: false, error: 'BOOKING_CANCELLED' });
    }
    if (status === 'EXPIRED') {
      return res.status(409).json({ ok: false, error: 'BOOKING_EXPIRED' });
    }

    /* Mark as redeemed */
    await db.run(
      `
      UPDATE public.bookings
         SET status       = 'REDEEMED',
             redeemed_at  = now(),
             updated_at   = now()
       WHERE booking_id   = $1
         AND UPPER(status) = 'BOOKED'
      `,
      [Number(booking.booking_id)]
    );

    return res.json({
      ok: true,
      already: false,
      status: 'REDEEMED',
      booking_id: Number(booking.booking_id),
      redeemed_count: count ? Number(count) : Number(booking.party_size)
    });
  } catch (err) {
    console.error('[INTIME] redeem error:', err);
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
