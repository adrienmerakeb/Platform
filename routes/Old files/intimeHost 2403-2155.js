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
// - Host: delete queue

import express from 'express';
import QRCode from 'qrcode';
import crypto from 'crypto';

import { getDb } from '../config/db.js';
import { authRequired, hostRequired, getHostId } from '../middleware/auth.js';

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
/* Option A: Luhn mod N for base36 strings (N=36)                             */
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
  let doubleIt = true;

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
/* GET  /api/intime/host/prefs  (host)                                        */
/* Returns the full prefs bag for the authenticated host.                     */
/* -------------------------------------------------------------------------- */
router.get('/intime/host/prefs', authRequired, hostRequired, async (req, res) => {
  const hostId = getHostId(req);
  try {
    const row = await db.get(
      `SELECT prefs FROM public.host_ui_prefs WHERE host_id = $1`,
      [Number(hostId)]
    );
    return res.json({ ok: true, prefs: row?.prefs ?? {} });
  } catch (err) {
    console.error('[INTIME] GET host/prefs error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* PATCH /api/intime/host/prefs  (host)                                       */
/* Body: { namespace: string, prefs: object }                                 */
/* Merges body.prefs into the stored bag under the given namespace key.       */
/* Example: { namespace: "scan_page", prefs: { accent: "#7c3aed", ... } }     */
/* -------------------------------------------------------------------------- */
router.patch('/intime/host/prefs', authRequired, hostRequired, async (req, res) => {
  const hostId = getHostId(req);
  const { namespace, prefs } = req.body || {};

  if (!namespace || typeof namespace !== 'string' || namespace.length > 64) {
    return res.status(400).json({ ok: false, error: 'INVALID_NAMESPACE' });
  }
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return res.status(400).json({ ok: false, error: 'INVALID_PREFS' });
  }

  try {
    /* Upsert: insert row if missing, otherwise merge namespace key only */
    await db.run(
      `
      INSERT INTO public.host_ui_prefs (host_id, prefs, updated_at)
        VALUES ($1, jsonb_build_object($2::text, $3::jsonb), now())
      ON CONFLICT (host_id) DO UPDATE
        SET prefs      = public.host_ui_prefs.prefs || jsonb_build_object($2::text, $3::jsonb),
            updated_at = now()
      `,
      [Number(hostId), namespace, JSON.stringify(prefs)]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[INTIME] PATCH host/prefs error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/intime/queues (host)                                             */
/* -------------------------------------------------------------------------- */
router.post('/intime/queues', authRequired, hostRequired, async (req, res) => {
  const hostId = getHostId(req);

  try {
    const body = req.body || {};

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
    const payment_mode     = body.payment_mode     || null;
    const qStatus          = body.status           || 'active';
    const draft_step       = body._draft_step      || null;

    const lat = body.lat != null ? Number(body.lat) : null;
    const lng = body.lng != null ? Number(body.lng) : null;
    const location_text = body.location || body.address || null;
    const locationGeo   = { text: location_text, lat, lng };

    let booking_formula = body.formula || body.booking_formula || null;
    if (!booking_formula && body.queue_mode) {
      booking_formula = mapQueueModeToBookingFormula(body.queue_mode);
    }
    if (!booking_formula) booking_formula = 'LIVE_ONLY';

    let identity_policy = 'ANONYMOUS';
    if (Array.isArray(body.access_publics)) {
      if (body.access_publics.includes('listed')) identity_policy = 'LISTED';
      else if (!body.access_publics.includes('anonymous')) identity_policy = 'REGISTERED';
    } else if (body.anon_booking_allowed === false || body.requires_login) {
      identity_policy = body.requires_whitelist ? 'LISTED' : 'REGISTERED';
    }

    const is_active = qStatus === 'active';

    const publics_json       = body.access_publics    ? JSON.stringify(body.access_publics) : null;
    const channels_json      = body.channels          ? JSON.stringify(body.channels) : null;
    const extra_fields_json  = body.extra_fields      ? JSON.stringify(body.extra_fields) : null;

    /* New JSON columns */
    const schedule_json      = body.schedule          ? JSON.stringify(body.schedule) : null;
    const slots_json         = body.slots             ? JSON.stringify(body.slots) : null;
    const calling_json       = body.calling           ? JSON.stringify(body.calling) : null;
    const early_json         = body.early             ? JSON.stringify(body.early) : null;
    const operators_json     = body.operators          ? JSON.stringify(body.operators) : null;
    const resellers_json     = body.resellers          ? JSON.stringify(body.resellers) : null;
    const wave_schedule_json = body.wave_schedule      ? JSON.stringify(body.wave_schedule) : null;
    const flow_schedule_json = body.flow_schedule      ? JSON.stringify(body.flow_schedule) : null;
    const release_schedule_json = body.release_schedule ? JSON.stringify(body.release_schedule) : null;

    /* Scalar new fields */
    const wave_duration      = body.wave_duration     != null ? Number(body.wave_duration) : null;
    const wave_capacity      = body.wave_capacity     != null ? Number(body.wave_capacity) : null;
    const wave_cap_mode      = body.wave_cap_mode     || null;
    const wave_var_scope     = body.wave_var_scope    || null;
    const flow_capacity      = body.flow_capacity     != null ? Number(body.flow_capacity) : null;
    const flow_cap_mode      = body.flow_cap_mode     || null;
    const release_mode       = body.release_mode      || null;
    const release_count      = body.release_count     != null ? Number(body.release_count) : null;
    const release_interval   = body.release_interval  != null ? Number(body.release_interval) : null;
    const fixed_release_scope= body.fixed_release_scope || null;
    const noscan_win         = body.noscan_win        != null ? Number(body.noscan_win) : 10;
    const scan_fallback      = !!body.scan_fallback;
    const use_host_wall      = body.use_host_wall     !== undefined ? !!body.use_host_wall : true;
    const wallpaper_data     = body.wallpaper_data    || null;
    const access_req         = !!body.access_req;
    const bulk_invite        = body.bulk_invite       !== undefined ? !!body.bulk_invite : true;
    const show_operator_name = body.show_operator_name !== undefined ? !!body.show_operator_name : true;
    const manual_refresh     = body.manual_refresh    !== undefined ? !!body.manual_refresh : true;
    const conf_review        = body.conf_review       !== undefined ? !!body.conf_review : true;
    const bulk_res           = body.bulk_res          !== undefined ? !!body.bulk_res : true;
    const notify_imp         = body.notify_imp        !== undefined ? !!body.notify_imp : true;

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
        payment_gate, payment_mode, channels_json, publics_json, extra_fields_json,
        schedule_json, slots_json, calling_json, early_json,
        operators_json, resellers_json,
        wave_duration, wave_capacity, wave_cap_mode, wave_var_scope, wave_schedule_json,
        flow_capacity, flow_cap_mode, release_mode, release_count, release_interval,
        fixed_release_scope, release_schedule_json, flow_schedule_json,
        noscan_win, scan_fallback, use_host_wall, wallpaper_data,
        access_req, bulk_invite, show_operator_name,
        manual_refresh, conf_review, bulk_res, notify_imp,
        no_scan_mode_enabled, status, draft_step,
        is_active, created_at, updated_at
      ) VALUES (
        $1,  $2,  $3,  $4,
        $5,  $6::jsonb, $7, $8,
        $9,  $10, 'WAVES', $11,
        $12, $13, $14, $15,
        $16, $17, $18,
        $19, $20, $21, $22,
        $23, $24, $25, $26, $27,
        $28, $29, $30, $31,
        $32, $33,
        $34, $35, $36, $37, $38,
        $39, $40, $41, $42, $43,
        $44, $45, $46,
        $47, $48, $49, $50,
        $51, $52, $53,
        $54, $55, $56, $57,
        false, $58, $59,
        $60, now(), now()
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
        payment_gate, payment_mode, channels_json, publics_json, extra_fields_json,
        schedule_json, slots_json, calling_json, early_json,
        operators_json, resellers_json,
        wave_duration, wave_capacity, wave_cap_mode, wave_var_scope, wave_schedule_json,
        flow_capacity, flow_cap_mode, release_mode, release_count, release_interval,
        fixed_release_scope, release_schedule_json, flow_schedule_json,
        noscan_win, scan_fallback, use_host_wall, wallpaper_data,
        access_req, bulk_invite, show_operator_name,
        manual_refresh, conf_review, bulk_res, notify_imp,
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
        cal_provider,
        show_eet,
        show_ete,
        show_desk_id,
        sender_email,
        channels_json,
        publics_json,
        extra_fields_json,
        payment_gate,
        payment_mode,
        theme,
        sync_horizon,
        schedule_json,
        slots_json,
        wave_duration,
        wave_capacity,
        flow_capacity,
        release_mode,
        release_count,
        release_interval,
        calling_json,
        early_json,
        use_host_wall,
        noscan_win,
        scan_fallback,
        operators_json,
        resellers_json,
        wave_cap_mode,
        wave_var_scope,
        wave_schedule_json,
        flow_cap_mode,
        flow_schedule_json,
        fixed_release_scope,
        release_schedule_json,
        access_req,
        bulk_invite,
        show_operator_name,
        manual_refresh,
        conf_review,
        bulk_res,
        notify_imp,
        wallpaper_data,
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
        payment_gate,
        payment_mode,
        schedule_json,
        slots_json,
        wave_duration,
        wave_capacity,
        flow_capacity,
        release_mode,
        release_count,
        release_interval,
        calling_json,
        early_json,
        use_host_wall,
        noscan_win,
        scan_fallback,
        operators_json,
        resellers_json,
        wave_cap_mode,
        wave_var_scope,
        wave_schedule_json,
        flow_cap_mode,
        flow_schedule_json,
        fixed_release_scope,
        release_schedule_json,
        access_req,
        bulk_invite,
        show_operator_name,
        manual_refresh,
        conf_review,
        bulk_res,
        notify_imp,
        wallpaper_data,
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
/* PATCH /api/intime/queues/:id (host) — update editable fields               */
/* -------------------------------------------------------------------------- */
router.patch('/intime/queues/:id', authRequired, hostRequired, async (req, res) => {
  try {
    const hostId  = getHostId(req);
    const { id }  = req.params;
    if (!/^\d+$/.test(String(id))) return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_ID' });

    const existing = await db.get(
      'SELECT queue_id, host_id FROM public.queues WHERE queue_id = $1',
      [Number(id)]
    );
    if (!existing)                                   return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    if (Number(existing.host_id) !== Number(hostId)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    const body = req.body || {};

    const sets = [];
    const vals = [];
    let p = 1;

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
    maybeSet('cal_sync',        body.cal_sync         !== undefined ? !!body.cal_sync     : undefined);
    maybeSet('cal_provider',    body.cal_provider);
    maybeSet('sync_horizon',    body.sync_horizon     != null ? Number(body.sync_horizon) : undefined);
    maybeSet('show_eet',        body.show_eet         !== undefined ? !!body.show_eet     : undefined);
    maybeSet('show_ete',        body.show_ete         !== undefined ? !!body.show_ete     : undefined);
    maybeSet('show_desk_id',    body.show_desk_id     !== undefined ? !!body.show_desk_id : undefined);
    maybeSet('payment_gate',    body.payment_gate     !== undefined ? !!body.payment_gate : undefined);

    if (body.formula !== undefined) {
      maybeSet('booking_formula', body.formula);
    }

    if (Array.isArray(body.access_publics)) {
      let ip = 'ANONYMOUS';
      if (body.access_publics.includes('listed'))            ip = 'LISTED';
      else if (!body.access_publics.includes('anonymous'))   ip = 'REGISTERED';
      maybeSet('identity_policy', ip);
      maybeSet('publics_json', JSON.stringify(body.access_publics));
    }

    if (body.lat != null || body.lng != null) {
      const lat = body.lat != null ? Number(body.lat) : null;
      const lng = body.lng != null ? Number(body.lng) : null;
      const txt = body.address || body.location_text || null;
      maybeSet('location_text', txt);
      maybeSet('location_geo',  JSON.stringify({ text: txt, lat, lng }));
    }

    if (body.extra_fields !== undefined)
      maybeSet('extra_fields_json', JSON.stringify(body.extra_fields));
    if (body.channels !== undefined)
      maybeSet('channels_json', JSON.stringify(body.channels));

    /* ── NEW: schedule, capacity, calling, early, operators, etc. ── */
    if (body.schedule !== undefined)
      maybeSet('schedule_json', JSON.stringify(body.schedule));
    if (body.slots !== undefined)
      maybeSet('slots_json', JSON.stringify(body.slots));

    maybeSet('wave_duration',    body.wave_duration    != null ? Number(body.wave_duration)    : undefined);
    maybeSet('wave_capacity',    body.wave_capacity    != null ? Number(body.wave_capacity)    : undefined);
    maybeSet('flow_capacity',    body.flow_capacity    != null ? Number(body.flow_capacity)    : undefined);
    maybeSet('release_mode',     body.release_mode);
    maybeSet('release_count',    body.release_count    != null ? Number(body.release_count)    : undefined);
    maybeSet('release_interval', body.release_interval != null ? Number(body.release_interval) : undefined);

    if (body.calling !== undefined)
      maybeSet('calling_json', JSON.stringify(body.calling));
    if (body.early !== undefined)
      maybeSet('early_json', JSON.stringify(body.early));

    maybeSet('use_host_wall',  body.use_host_wall  !== undefined ? !!body.use_host_wall  : undefined);
    maybeSet('noscan_win',     body.noscan_win      != null ? Number(body.noscan_win)     : undefined);
    maybeSet('scan_fallback',  body.scan_fallback   !== undefined ? !!body.scan_fallback  : undefined);
    maybeSet('payment_mode',   body.payment_mode);

    if (body.operators !== undefined)
      maybeSet('operators_json', JSON.stringify(body.operators));
    if (body.resellers !== undefined)
      maybeSet('resellers_json', JSON.stringify(body.resellers));

    /* ── Wave/flow advanced fields ── */
    maybeSet('wave_cap_mode',      body.wave_cap_mode);
    maybeSet('wave_var_scope',     body.wave_var_scope);
    if (body.wave_schedule !== undefined)
      maybeSet('wave_schedule_json', JSON.stringify(body.wave_schedule));
    maybeSet('flow_cap_mode',      body.flow_cap_mode);
    if (body.flow_schedule !== undefined)
      maybeSet('flow_schedule_json', JSON.stringify(body.flow_schedule));
    maybeSet('fixed_release_scope', body.fixed_release_scope);
    if (body.release_schedule !== undefined)
      maybeSet('release_schedule_json', JSON.stringify(body.release_schedule));

    /* ── Access extras ── */
    maybeSet('access_req',         body.access_req    !== undefined ? !!body.access_req   : undefined);
    maybeSet('bulk_invite',        body.bulk_invite   !== undefined ? !!body.bulk_invite  : undefined);

    /* ── Display / calendar extras ── */
    maybeSet('show_operator_name', body.show_operator_name !== undefined ? !!body.show_operator_name : undefined);
    maybeSet('manual_refresh',     body.manual_refresh !== undefined ? !!body.manual_refresh : undefined);
    maybeSet('conf_review',        body.conf_review    !== undefined ? !!body.conf_review   : undefined);
    maybeSet('bulk_res',           body.bulk_res       !== undefined ? !!body.bulk_res      : undefined);
    maybeSet('notify_imp',         body.notify_imp     !== undefined ? !!body.notify_imp    : undefined);
    maybeSet('wallpaper_data',     body.wallpaper_data);

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
/* DELETE /api/intime/queues/:id (host)                                       */
/* - Ownership enforced                                                       */
/* - Removes dependent records first                                          */
/* -------------------------------------------------------------------------- */
router.delete('/intime/queues/:id', authRequired, hostRequired, async (req, res) => {
  let inTx = false;

  try {
    const hostId = getHostId(req);
    const { id } = req.params;

    if (!/^\d+$/.test(String(id))) {
      return res.status(400).json({ ok: false, error: 'INVALID_QUEUE_ID' });
    }

    const queueId = Number(id);

    const existing = await db.get(
      `
      SELECT queue_id, host_id, name
      FROM public.queues
      WHERE queue_id = $1
      `,
      [queueId]
    );

    if (!existing) {
      return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });
    }

    if (Number(existing.host_id) !== Number(hostId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }

    await db.run('BEGIN');
    inTx = true;

    await db.run(
      `DELETE FROM public.bookings WHERE queue_id = $1`,
      [queueId]
    );

    await db.run(
      `DELETE FROM public.holds WHERE queue_id = $1`,
      [queueId]
    );

    await db.run(
      `DELETE FROM public.queue_day_capacity WHERE queue_id = $1`,
      [queueId]
    );

    const deleted = await db.get(
      `
      DELETE FROM public.queues
      WHERE queue_id = $1 AND host_id = $2
      RETURNING queue_id, name
      `,
      [queueId, Number(hostId)]
    );

    if (!deleted) {
      throw new Error('DELETE_FAILED');
    }

    await db.run('COMMIT');
    inTx = false;

    return res.json({
      ok: true,
      deleted: {
        id: Number(deleted.queue_id),
        name: deleted.name || null
      }
    });
  } catch (err) {
    if (inTx) {
      try { await db.run('ROLLBACK'); } catch {}
    }
    console.error('[INTIME] delete queue error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
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
      await db.run(
        `
        INSERT INTO public.device_identities(device_id, first_seen_at, last_seen_at)
        VALUES ($1, now(), now())
        ON CONFLICT (device_id) DO UPDATE SET last_seen_at = now()
        `,
        [deviceId]
      );

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
/* -------------------------------------------------------------------------- */
router.post('/intime/bookings', async (req, res) => {
  try {
    const { queue_id, device_id, source, party_size, slot_date, slots, include_qr = true } = req.body || {};

    if (!queue_id) return res.status(400).json({ ok: false, error: 'MISSING_QUEUE_ID' });

    const deviceId = normalizeDeviceId(device_id);
    if (!deviceId) return res.status(400).json({ ok: false, error: 'MISSING_DEVICE_ID' });

    const queue = await db.get('SELECT queue_id, timezone FROM public.queues WHERE queue_id = $1', [Number(queue_id)]);
    if (!queue) return res.status(404).json({ ok: false, error: 'QUEUE_NOT_FOUND' });

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
      await db.run(
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

/* ══════════════════════════════════════════════════════════════
   VISITOR ALLOWLIST
════════════════════════════════════════════════════════════════ */

/* GET /api/intime/queues/:id/visitors */
router.get('/intime/queues/:id/visitors', authRequired, hostRequired, async (req, res) => {
  const hostId = getHostId(req);
  const queueId = Number(req.params.id);
  if (!Number.isFinite(queueId)) return res.status(400).json({ ok:false, error:'INVALID_QUEUE_ID' });
  const owned = await getCanonicalQueueForHost(queueId, hostId);
  if (!owned)              return res.status(404).json({ ok:false, error:'QUEUE_NOT_FOUND' });
  if (owned==='NOT_OWNER') return res.status(403).json({ ok:false, error:'FORBIDDEN' });
  try {
    const rows = await db.all(
      `SELECT id, email, note, created_at FROM public.queue_visitors
       WHERE queue_id=$1 ORDER BY created_at DESC`, [queueId]);
    return res.json({ ok:true, visitors: rows });
  } catch(err) {
    console.error('[INTIME] visitors GET error:', err);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

/* POST /api/intime/queues/:id/visitors
   Body: { emails: string[] , note?: string } */
router.post('/intime/queues/:id/visitors', authRequired, hostRequired, async (req, res) => {
  const hostId  = getHostId(req);
  const queueId = Number(req.params.id);
  if (!Number.isFinite(queueId)) return res.status(400).json({ ok:false, error:'INVALID_QUEUE_ID' });
  const owned = await getCanonicalQueueForHost(queueId, hostId);
  if (!owned)              return res.status(404).json({ ok:false, error:'QUEUE_NOT_FOUND' });
  if (owned==='NOT_OWNER') return res.status(403).json({ ok:false, error:'FORBIDDEN' });

  const emails = (req.body.emails || [])
    .map(e => String(e).trim().toLowerCase())
    .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (!emails.length) return res.status(400).json({ ok:false, error:'NO_VALID_EMAILS' });
  const note = req.body.note || null;

  try {
    let added=0, skipped=0;
    for (const email of emails) {
      try {
        await db.run(
          `INSERT INTO public.queue_visitors (queue_id, email, added_by, note)
           VALUES ($1,$2,$3,$4) ON CONFLICT (queue_id, email) DO NOTHING`,
          [queueId, email, hostId, note]);
        added++;
      } catch(_) { skipped++; }
    }
    return res.json({ ok:true, added, skipped });
  } catch(err) {
    console.error('[INTIME] visitors POST error:', err);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

/* DELETE /api/intime/queues/:id/visitors
   Body: { email: string } */
router.delete('/intime/queues/:id/visitors', authRequired, hostRequired, async (req, res) => {
  const hostId  = getHostId(req);
  const queueId = Number(req.params.id);
  if (!Number.isFinite(queueId)) return res.status(400).json({ ok:false, error:'INVALID_QUEUE_ID' });
  const owned = await getCanonicalQueueForHost(queueId, hostId);
  if (!owned)              return res.status(404).json({ ok:false, error:'QUEUE_NOT_FOUND' });
  if (owned==='NOT_OWNER') return res.status(403).json({ ok:false, error:'FORBIDDEN' });
  const email = String(req.body.email||'').trim().toLowerCase();
  if (!email) return res.status(400).json({ ok:false, error:'NO_EMAIL' });
  try {
    await db.run(
      `DELETE FROM public.queue_visitors WHERE queue_id=$1 AND email=$2`,
      [queueId, email]);
    return res.json({ ok:true });
  } catch(err) {
    console.error('[INTIME] visitor DELETE error:', err);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

/* ══════════════════════════════════════════════════════════════
   ACCESS REQUESTS
════════════════════════════════════════════════════════════════ */

/* GET /api/intime/queues/:id/access-requests?status=pending */
router.get('/intime/queues/:id/access-requests', authRequired, hostRequired, async (req, res) => {
  const hostId  = getHostId(req);
  const queueId = Number(req.params.id);
  if (!Number.isFinite(queueId)) return res.status(400).json({ ok:false, error:'INVALID_QUEUE_ID' });
  const owned = await getCanonicalQueueForHost(queueId, hostId);
  if (!owned)              return res.status(404).json({ ok:false, error:'QUEUE_NOT_FOUND' });
  if (owned==='NOT_OWNER') return res.status(403).json({ ok:false, error:'FORBIDDEN' });
  const statusFilter = req.query.status || null;
  try {
    const rows = await db.all(
      `SELECT id, email, display_name, message, status, host_note, created_at, decided_at
       FROM public.queue_access_requests
       WHERE queue_id=$1 ${statusFilter ? 'AND status=$2' : ''}
       ORDER BY created_at DESC`,
      statusFilter ? [queueId, statusFilter] : [queueId]);
    return res.json({ ok:true, requests: rows });
  } catch(err) {
    console.error('[INTIME] access-requests GET error:', err);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

/* PATCH /api/intime/access-requests/:reqId
   Body: { decision: 'approved'|'denied', host_note?: string } */
router.patch('/intime/access-requests/:reqId', authRequired, hostRequired, async (req, res) => {
  const hostId = getHostId(req);
  const reqId  = Number(req.params.reqId);
  if (!Number.isFinite(reqId)) return res.status(400).json({ ok:false, error:'INVALID_ID' });
  const { decision, host_note } = req.body || {};
  if (!['approved','denied'].includes(decision))
    return res.status(400).json({ ok:false, error:'INVALID_DECISION' });
  try {
    const row = await db.get(
      `SELECT ar.id, ar.queue_id, ar.email, q.host_id
       FROM public.queue_access_requests ar
       JOIN public.queues q ON q.queue_id=ar.queue_id
       WHERE ar.id=$1`, [reqId]);
    if (!row)                              return res.status(404).json({ ok:false, error:'NOT_FOUND' });
    if (Number(row.host_id)!==Number(hostId)) return res.status(403).json({ ok:false, error:'FORBIDDEN' });

    await db.run(
      `UPDATE public.queue_access_requests
         SET status=$1, host_note=$2, decided_at=now(), decided_by=$3, updated_at=now()
       WHERE id=$4`,
      [decision, host_note||null, hostId, reqId]);

    /* If approved, auto-add to visitors allowlist */
    if (decision==='approved') {
      await db.run(
        `INSERT INTO public.queue_visitors (queue_id, email, added_by, note)
         VALUES ($1,$2,$3,'Approved from access request')
         ON CONFLICT (queue_id, email) DO NOTHING`,
        [row.queue_id, row.email, hostId]);
    }

    return res.json({ ok:true });
  } catch(err) {
    console.error('[INTIME] access-request PATCH error:', err);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

/* POST /api/intime/queues/:id/access-requests (PUBLIC — visitor submits request)
   Body: { email, display_name?, message? } */
router.post('/intime/queues/:id/access-requests', async (req, res) => {
  const queueId = Number(req.params.id);
  if (!Number.isFinite(queueId)) return res.status(400).json({ ok:false, error:'INVALID_QUEUE_ID' });
  const { email, display_name, message } = req.body || {};
  const clean = String(email||'').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean))
    return res.status(400).json({ ok:false, error:'INVALID_EMAIL' });
  try {
    /* Check queue exists and has access_req enabled */
    const q = await db.get(
      `SELECT queue_id, access_req FROM public.queues WHERE queue_id=$1 AND is_active=true`,
      [queueId]);
    if (!q)           return res.status(404).json({ ok:false, error:'QUEUE_NOT_FOUND' });
    if (!q.access_req) return res.status(403).json({ ok:false, error:'REQUESTS_DISABLED' });

    await db.run(
      `INSERT INTO public.queue_access_requests (queue_id, email, display_name, message)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (queue_id, email) DO UPDATE
         SET message=EXCLUDED.message, updated_at=now()
         WHERE public.queue_access_requests.status='pending'`,
      [queueId, clean, display_name||null, message||null]);
    return res.json({ ok:true });
  } catch(err) {
    console.error('[INTIME] access-request POST error:', err);
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});


export default router;