// routes/intimeVisitor.js
// In-Time API — Visitor & Scanner routes ONLY
//
// Includes:
// - Visitor: list own bookings by device_id
// - Visitor: generate booking QR on demand
// - Visitor: cancel a booking
// - Scanner: look up booking by token UUID
// - Scanner: redeem a booking

import express from 'express';
import QRCode from 'qrcode';
import jwt from 'jsonwebtoken';

import { getDb } from '../config/db.js';
import { JWT_SECRET } from '../middleware/auth.js';

const db = getDb();
const router = express.Router();

console.log('[BOOT] intimeVisitorRoutes loaded from routes/intimeVisitor.js');

/* -------------------------------------------------------------------------- */
/* Utils                                                                      */
/* -------------------------------------------------------------------------- */
function normalizeDeviceId(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.length > 128) return null;
  return s;
}

/* -------------------------------------------------------------------------- */
/* GET /api/intime/bookings/mine (visitor)                                    */
/* Query: ?device_id=<id>&status=BOOKED|REDEEMED|CANCELLED|all               */
/* -------------------------------------------------------------------------- */
router.get('/intime/bookings/mine', async (req, res) => {
  try {
    const { device_id, status } = req.query || {};

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
            ? b.human_ref.slice(0,3) + '-' + b.human_ref.slice(3,6) + '-' + b.human_ref.slice(6)
            : b.human_ref)
        : null,
    }));

    return res.json({ ok: true, bookings, count: bookings.length });
  } catch (err) {
    console.error('[INTIME] mine error:', err.message, err.stack);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/intime/bookings/qr/:token (visitor — generate QR on demand)       */
/* Returns { ok: true, image_base64: "data:image/png;base64,..." }           */
/* -------------------------------------------------------------------------- */
router.get('/intime/bookings/qr/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'MISSING_TOKEN' });

    const payload = `intime:booking:${token}`;
    const dataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      margin: 2,
      width: 440,
      color: { dark: '#1a1825', light: '#ffffff' }
    });

    return res.json({ ok: true, image_base64: dataUrl });
  } catch (err) {
    console.error('[INTIME] booking QR error:', err);
    return res.status(500).json({ ok: false, error: 'QR_FAILED', detail: String(err?.message || err) });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/intime/bookings/:id/cancel (visitor)                             */
/* Ownership enforced via device_id (anonymous) or visitor JWT cookie         */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* GET /api/intime/bookings/by-token/:token (scanner)                         */
/* token = raw token_id UUID or intime:booking:<uuid> prefix                  */
/* No auth required — operator device may not be logged in as host            */
/* -------------------------------------------------------------------------- */
router.get('/intime/bookings/by-token/:token', async (req, res) => {
  try {
    const raw = String(req.params.token || '').trim();
    if (!raw) return res.status(400).json({ ok: false, error: 'MISSING_TOKEN' });

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
        UPPER(b.status)                              AS status,
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

    return res.json({ ok: true, booking: row });
  } catch (err) {
    console.error('[INTIME] by-token error:', err);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err?.message || err) });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/intime/bookings/redeem (scanner)                                 */
/* Body: { booking_token, count? }                                            */
/* booking_token: raw UUID or intime:booking:<uuid>                           */
/* count: omit/0 = redeem full party; N = redeem N of party                  */
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

    await db.run(
      `
      UPDATE public.bookings
         SET status      = 'REDEEMED',
             redeemed_at = now(),
             updated_at  = now()
       WHERE booking_id  = $1
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

export default router;
