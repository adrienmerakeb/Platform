// routes/audioCast.js
// LGO Audio Cast — subscription-gated one-way local guide audio sessions.

import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import QRCode from 'qrcode';

import { getDb } from '../config/db.js';
import {
  authRequired,
  JWT_SECRET,
  setLoginCookie
} from '../middleware/auth.js';

const router = express.Router();
const db = getDb();

const AUDIO_CAST_PRICE_CENTS = 2500;
const AUDIO_CAST_CURRENCY = 'eur';
const ACTIVE_SUBSCRIPTION_STATES = new Set(['active', 'trialing']);
const ACTIVE_SESSION_STATES = new Set(['READY', 'ACTIVE', 'PAUSED', 'INTERRUPTED']);
const SESSION_TRANSITIONS = Object.freeze({
  READY: new Set(['ACTIVE', 'ENDED']),
  ACTIVE: new Set(['PAUSED', 'INTERRUPTED', 'ENDED']),
  PAUSED: new Set(['ACTIVE', 'INTERRUPTED', 'ENDED']),
  INTERRUPTED: new Set(['ACTIVE', 'PAUSED', 'ENDED']),
  ENDED: new Set()
});
const JOIN_SCHEMA = 'lgo-audio-cast-join-v1';

router.use(authRequired);

function stripeSecret() {
  return String(process.env.STRIPE_SECRET_KEY || '').trim();
}

function publicBaseUrl(req) {
  const explicit = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '')
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

function tokenKey() {
  const material = String(process.env.AUDIO_CAST_TOKEN_KEY || JWT_SECRET || 'audio-cast-dev-key');
  return crypto.createHash('sha256').update(material).digest();
}

function encryptJoinToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decryptJoinToken(value) {
  const packed = Buffer.from(String(value || ''), 'base64url');
  if (packed.length < 29) throw new Error('Invalid Audio Cast token envelope');
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function hashJoinToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeMetric(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function normalizeSignalQuality(value) {
  const q = String(value || '').trim().toUpperCase();
  return ['EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'LOST'].includes(q) ? q : null;
}

async function loadVisitor(userId) {
  return db.get(
    `SELECT id, name, email, role, status, has_guide_profile, suspended
       FROM users
      WHERE id = ?`,
    [userId]
  );
}

async function ensureVisitor(req, res, next) {
  try {
    if (req.user?.role !== 'visitor') {
      return res.status(403).json({ error: 'Audio Cast requires a visitor account.' });
    }
    const user = await loadVisitor(req.user.id);
    if (!user || Number(user.suspended || 0) === 1) {
      return res.status(403).json({ error: 'Visitor account is unavailable.' });
    }
    req.audioCastUser = user;
    next();
  } catch (err) {
    next(err);
  }
}

async function findGuideForVisitor(userId) {
  return db.get(
    `SELECT *
       FROM lgo_guides
      WHERE owner_role = 'visitor'
        AND owner_account_id = ?`,
    [userId]
  );
}

async function activateGuideProfile(user) {
  let guide = await findGuideForVisitor(user.id);
  if (!guide) {
    const result = await db.run(
      `INSERT INTO lgo_guides (
         user_id, owner_role, owner_account_id, display_name
       ) VALUES (?,?,?,?)
       RETURNING id`,
      [
        user.id,
        'visitor',
        user.id,
        user.name || user.email || 'LGO Guide'
      ]
    );
    guide = await db.get('SELECT * FROM lgo_guides WHERE id = ?', [result.lastID]);
  }

  await db.run(
    `UPDATE users
        SET has_guide_profile = 1,
            status = CASE WHEN UPPER(COALESCE(status, 'V')) = 'G' THEN 'G' ELSE 'VG' END
      WHERE id = ?`,
    [user.id]
  );
  return guide;
}

async function subscriptionForGuide(guideId) {
  return db.get(
    `SELECT *
       FROM lgo_audio_cast_subscriptions
      WHERE guide_id = ?`,
    [guideId]
  );
}

async function retrieveStripeSubscription(subscriptionId) {
  const secret = stripeSecret();
  if (!secret || !subscriptionId) return null;
  const response = await axios.get(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { headers: { Authorization: `Bearer ${secret}` } }
  );
  return response.data;
}

async function syncSubscription(guideId, row) {
  if (!row?.provider_subscription_id || !stripeSecret()) return row || null;
  try {
    const stripeSubscription = await retrieveStripeSubscription(row.provider_subscription_id);
    if (!stripeSubscription) return row;
    const periodEnd = stripeSubscription.current_period_end
      ? new Date(Number(stripeSubscription.current_period_end) * 1000).toISOString()
      : null;
    await db.run(
      `UPDATE lgo_audio_cast_subscriptions
          SET status = ?,
              current_period_end = ?,
              updated_at = NOW()
        WHERE guide_id = ?`,
      [stripeSubscription.status || 'inactive', periodEnd, guideId]
    );
    return subscriptionForGuide(guideId);
  } catch (err) {
    console.warn('[AudioCast] Stripe subscription sync failed:', err.response?.data || err.message);
    return row;
  }
}

async function requireGuide(req, res, next) {
  try {
    if (req.user?.role !== 'visitor') {
      return res.status(403).json({ error: 'Audio Cast guide tools require a visitor account with a guide profile.' });
    }
    const user = await loadVisitor(req.user.id);
    if (!user || Number(user.suspended || 0) === 1) {
      return res.status(403).json({ error: 'Visitor account is unavailable.' });
    }
    const guide = await findGuideForVisitor(user.id);
    if (!guide) {
      return res.status(403).json({ error: 'Activate your guide profile before using Audio Cast.' });
    }
    req.audioCastUser = user;
    req.audioCastGuide = guide;
    next();
  } catch (err) {
    next(err);
  }
}

async function requireAudioCastSubscription(req, res, next) {
  try {
    const guide = req.audioCastGuide;
    let subscription = await subscriptionForGuide(guide.id);
    subscription = await syncSubscription(guide.id, subscription);
    if (!subscription || !ACTIVE_SUBSCRIPTION_STATES.has(String(subscription.status || '').toLowerCase())) {
      return res.status(402).json({
        error: 'An active Audio Cast subscription is required.',
        subscription_status: subscription?.status || 'inactive',
        price_cents: AUDIO_CAST_PRICE_CENTS,
        currency: AUDIO_CAST_CURRENCY.toUpperCase()
      });
    }
    req.audioCastSubscription = subscription;
    next();
  } catch (err) {
    next(err);
  }
}

async function ownedSession(guideId, sessionId) {
  return db.get(
    `SELECT *
       FROM lgo_audio_cast_sessions
      WHERE session_id = ?
        AND guide_id = ?`,
    [sessionId, guideId]
  );
}

async function currentSessionForGuide(guideId) {
  return db.get(
    `SELECT *
       FROM lgo_audio_cast_sessions
      WHERE guide_id = ?
        AND status <> 'ENDED'
      ORDER BY created_at DESC
      LIMIT 1`,
    [guideId]
  );
}

async function participantCount(sessionId) {
  const row = await db.get(
    `SELECT COUNT(*)::int AS count
       FROM lgo_audio_cast_participants
      WHERE session_id = ?
        AND status = 'CONNECTED'`,
    [sessionId]
  );
  return Number(row?.count || 0);
}

function publicSession(row) {
  if (!row) return null;
  return {
    session_id: row.session_id,
    title: row.title,
    status: row.status,
    participant_limit: Number(row.participant_limit || 25),
    created_at: row.created_at,
    started_at: row.started_at,
    paused_at: row.paused_at,
    ended_at: row.ended_at,
    updated_at: row.updated_at
  };
}

function joinPayload({ session, token, transport }) {
  return {
    schema: JOIN_SCHEMA,
    session_id: session.session_id,
    join_token: token,
    transport: transport || null
  };
}

function encodeJoinPayload(payload) {
  return `LGOAC1:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function validateTransport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mode = String(value.mode || '').trim();
  if (!['local-hotspot', 'same-lan', 'peer', 'internet-fallback'].includes(mode)) return null;
  const result = { mode };
  if (value.host) result.host = String(value.host).slice(0, 255);
  if (Number.isFinite(Number(value.port))) result.port = Math.trunc(Number(value.port));
  if (value.ssid) result.ssid = String(value.ssid).slice(0, 128);
  if (value.passphrase) result.passphrase = String(value.passphrase).slice(0, 128);
  if (value.service) result.service = String(value.service).slice(0, 128);
  if (value.protocol) result.protocol = String(value.protocol).slice(0, 32);
  return result;
}

/* -------------------------------------------------------------------------- */
/* PROFILE + SUBSCRIPTION                                                     */
/* -------------------------------------------------------------------------- */

router.post('/guide/profile/activate', ensureVisitor, async (req, res, next) => {
  try {
    const guide = await activateGuideProfile(req.audioCastUser);
    const updatedUser = await loadVisitor(req.audioCastUser.id);
    setLoginCookie(res, updatedUser);
    res.json({
      ok: true,
      guide: {
        id: guide.id,
        display_name: guide.display_name
      },
      user: {
        id: updatedUser.id,
        status: updatedUser.status,
        has_guide_profile: !!updatedUser.has_guide_profile
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/guide/subscription', requireGuide, async (req, res, next) => {
  try {
    let subscription = await subscriptionForGuide(req.audioCastGuide.id);
    subscription = await syncSubscription(req.audioCastGuide.id, subscription);
    res.json({
      configured: !!stripeSecret(),
      price_cents: AUDIO_CAST_PRICE_CENTS,
      currency: AUDIO_CAST_CURRENCY.toUpperCase(),
      vat_included: false,
      status: subscription?.status || 'inactive',
      current_period_end: subscription?.current_period_end || null
    });
  } catch (err) {
    next(err);
  }
});

router.post('/guide/subscription/checkout', requireGuide, async (req, res, next) => {
  try {
    const secret = stripeSecret();
    if (!secret) {
      return res.status(503).json({
        error: 'Stripe is not configured for Audio Cast checkout.'
      });
    }

    const baseUrl = publicBaseUrl(req);
    const body = new URLSearchParams();
    body.set('mode', 'subscription');
    body.set('client_reference_id', `audio-cast:${req.audioCastUser.id}`);
    body.set('customer_email', req.audioCastUser.email);
    body.set('success_url', `${baseUrl}/modules/Let's%20Get%20Out!/audio-cast/guide.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    body.set('cancel_url', `${baseUrl}/modules/Let's%20Get%20Out!/audio-cast/guide.html?checkout=cancelled`);
    body.set('automatic_tax[enabled]', 'true');
    body.set('tax_id_collection[enabled]', 'true');
    body.set('line_items[0][quantity]', '1');
    body.set('line_items[0][price_data][currency]', AUDIO_CAST_CURRENCY);
    body.set('line_items[0][price_data][unit_amount]', String(AUDIO_CAST_PRICE_CENTS));
    body.set('line_items[0][price_data][recurring][interval]', 'month');
    body.set('line_items[0][price_data][tax_behavior]', 'exclusive');
    body.set('line_items[0][price_data][product_data][name]', 'LGO Audio Cast');
    body.set('line_items[0][price_data][product_data][description]', 'Local one-way guide audio broadcasting for live visitor groups.');

    const checkout = await axios.post(
      'https://api.stripe.com/v1/checkout/sessions',
      body.toString(),
      {
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    return res.json({ checkout_url: checkout.data.url });
  } catch (err) {
    console.error('[AudioCast] Checkout creation failed:', err.response?.data || err);
    next(err);
  }
});

router.get('/guide/subscription/confirm', requireGuide, async (req, res, next) => {
  try {
    const secret = stripeSecret();
    const checkoutId = String(req.query.session_id || '').trim();
    if (!secret || !checkoutId) {
      return res.status(400).json({ error: 'Missing configured Stripe checkout session.' });
    }

    const checkoutResponse = await axios.get(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(checkoutId)}`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const checkout = checkoutResponse.data;

    if (checkout.mode !== 'subscription'
      || checkout.client_reference_id !== `audio-cast:${req.audioCastUser.id}`
      || !checkout.subscription) {
      return res.status(400).json({ error: 'Checkout session does not belong to this Audio Cast account.' });
    }

    const stripeSubscription = await retrieveStripeSubscription(checkout.subscription);
    const status = stripeSubscription?.status || 'inactive';
    const periodEnd = stripeSubscription?.current_period_end
      ? new Date(Number(stripeSubscription.current_period_end) * 1000).toISOString()
      : null;

    await db.run(
      `INSERT INTO lgo_audio_cast_subscriptions (
         guide_id, provider, provider_customer_id, provider_subscription_id,
         status, price_cents, currency, current_period_end, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,NOW())
       ON CONFLICT (guide_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         provider_customer_id = EXCLUDED.provider_customer_id,
         provider_subscription_id = EXCLUDED.provider_subscription_id,
         status = EXCLUDED.status,
         price_cents = EXCLUDED.price_cents,
         currency = EXCLUDED.currency,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = NOW()`,
      [
        req.audioCastGuide.id,
        'stripe',
        checkout.customer || null,
        checkout.subscription,
        status,
        AUDIO_CAST_PRICE_CENTS,
        AUDIO_CAST_CURRENCY.toUpperCase(),
        periodEnd
      ]
    );

    return res.json({
      ok: ACTIVE_SUBSCRIPTION_STATES.has(String(status).toLowerCase()),
      status,
      current_period_end: periodEnd
    });
  } catch (err) {
    console.error('[AudioCast] Checkout confirmation failed:', err.response?.data || err);
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* GUIDE SESSION CONTROL                                                      */
/* -------------------------------------------------------------------------- */

router.get('/guide/sessions/current', requireGuide, requireAudioCastSubscription, async (req, res, next) => {
  try {
    const session = await currentSessionForGuide(req.audioCastGuide.id);
    if (!session) return res.json({ session: null });
    let token = null;
    try {
      token = decryptJoinToken(session.join_secret_encrypted);
    } catch (err) {
      console.warn('[AudioCast] Could not recover current join token:', err.message);
    }
    return res.json({
      session: {
        ...publicSession(session),
        join_token: token,
        participant_count: await participantCount(session.session_id)
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/guide/sessions', requireGuide, requireAudioCastSubscription, async (req, res, next) => {
  try {
    const existing = await currentSessionForGuide(req.audioCastGuide.id);
    if (existing) {
      return res.status(409).json({
        error: 'Finish the current Audio Cast session before creating another.',
        current_session: publicSession(existing)
      });
    }

    const sessionId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    const title = String(req.body?.title || 'Live Audio Cast').trim().slice(0, 160) || 'Live Audio Cast';
    const participantLimit = Math.max(1, Math.min(25, Number.parseInt(req.body?.participant_limit, 10) || 25));

    await db.run(
      `INSERT INTO lgo_audio_cast_sessions (
         session_id, guide_id, title, status, join_secret_hash,
         join_secret_encrypted, participant_limit
       ) VALUES (?,?,?,?,?,?,?)`,
      [
        sessionId,
        req.audioCastGuide.id,
        title,
        'READY',
        hashJoinToken(token),
        encryptJoinToken(token),
        participantLimit
      ]
    );

    const session = await ownedSession(req.audioCastGuide.id, sessionId);
    return res.status(201).json({
      session: {
        ...publicSession(session),
        join_token: token,
        participant_count: 0
      }
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/guide/sessions/:sessionId/state', requireGuide, requireAudioCastSubscription, async (req, res, next) => {
  try {
    const session = await ownedSession(req.audioCastGuide.id, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Audio Cast session not found.' });

    const nextState = String(req.body?.state || '').trim().toUpperCase();
    if (!SESSION_TRANSITIONS[session.status]?.has(nextState)) {
      return res.status(409).json({
        error: `Invalid Audio Cast transition ${session.status} -> ${nextState}.`
      });
    }

    const sets = ['status = ?', 'updated_at = NOW()'];
    const params = [nextState];
    if (nextState === 'ACTIVE' && !session.started_at) sets.push('started_at = NOW()');
    if (nextState === 'PAUSED') sets.push('paused_at = NOW()');
    if (nextState === 'ENDED') sets.push('ended_at = NOW()');
    params.push(session.session_id);

    await db.run(
      `UPDATE lgo_audio_cast_sessions
          SET ${sets.join(', ')}
        WHERE session_id = ?`,
      params
    );

    if (nextState === 'ENDED') {
      await db.run(
        `UPDATE lgo_audio_cast_participants
            SET status = CASE WHEN status = 'CONNECTED' THEN 'LEFT' ELSE status END,
                left_at = CASE WHEN status = 'CONNECTED' THEN NOW() ELSE left_at END,
                last_seen_at = NOW()
          WHERE session_id = ?`,
        [session.session_id]
      );
    }

    const updated = await ownedSession(req.audioCastGuide.id, session.session_id);
    return res.json({
      session: {
        ...publicSession(updated),
        participant_count: await participantCount(updated.session_id)
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/guide/sessions/:sessionId/qr', requireGuide, requireAudioCastSubscription, async (req, res, next) => {
  try {
    const session = await ownedSession(req.audioCastGuide.id, req.params.sessionId);
    if (!session || session.status === 'ENDED') {
      return res.status(404).json({ error: 'Active Audio Cast session not found.' });
    }
    const transport = validateTransport(req.body?.transport);
    if (!transport) {
      return res.status(400).json({ error: 'A valid Audio Cast transport descriptor is required.' });
    }

    const token = decryptJoinToken(session.join_secret_encrypted);
    const payload = joinPayload({ session, token, transport });
    const encoded = encodeJoinPayload(payload);
    const qrDataUrl = await QRCode.toDataURL(encoded, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512
    });

    return res.json({
      schema: JOIN_SCHEMA,
      qr_payload: encoded,
      qr_data_url: qrDataUrl,
      session: publicSession(session)
    });
  } catch (err) {
    next(err);
  }
});

router.get('/guide/sessions/:sessionId/participants', requireGuide, requireAudioCastSubscription, async (req, res, next) => {
  try {
    const session = await ownedSession(req.audioCastGuide.id, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Audio Cast session not found.' });

    const participants = await db.all(
      `SELECT participant_id, status, signal_quality, latency_ms, jitter_ms,
              transport_mode, joined_at, last_seen_at, left_at, kicked_at
         FROM lgo_audio_cast_participants
        WHERE session_id = ?
        ORDER BY joined_at ASC`,
      [session.session_id]
    );
    return res.json({ participants });
  } catch (err) {
    next(err);
  }
});

router.post('/guide/sessions/:sessionId/participants/:participantId/kick',
  requireGuide,
  requireAudioCastSubscription,
  async (req, res, next) => {
    try {
      const session = await ownedSession(req.audioCastGuide.id, req.params.sessionId);
      if (!session || session.status === 'ENDED') {
        return res.status(404).json({ error: 'Active Audio Cast session not found.' });
      }

      const participant = await db.get(
        `SELECT participant_id
           FROM lgo_audio_cast_participants
          WHERE session_id = ?
            AND participant_id = ?`,
        [session.session_id, req.params.participantId]
      );
      if (!participant) return res.status(404).json({ error: 'Listener not found.' });

      await db.run(
        `UPDATE lgo_audio_cast_participants
            SET status = 'KICKED',
                kicked_at = NOW(),
                last_seen_at = NOW()
          WHERE participant_id = ?`,
        [participant.participant_id]
      );
      return res.json({ ok: true, participant_id: participant.participant_id });
    } catch (err) {
      next(err);
    }
  }
);

/* -------------------------------------------------------------------------- */
/* VISITOR JOIN / HEARTBEAT / LEAVE                                            */
/* -------------------------------------------------------------------------- */

router.post('/visitor/join', ensureVisitor, async (req, res, next) => {
  try {
    const sessionId = String(req.body?.session_id || '').trim();
    const token = String(req.body?.join_token || '').trim();
    if (!sessionId || !token) return res.status(400).json({ error: 'Invalid Audio Cast join payload.' });

    const session = await db.get(
      `SELECT s.*, g.display_name AS guide_name
         FROM lgo_audio_cast_sessions s
         JOIN lgo_guides g ON g.id = s.guide_id
        WHERE s.session_id = ?`,
      [sessionId]
    );
    if (!session || !ACTIVE_SESSION_STATES.has(session.status)) {
      return res.status(410).json({ error: 'This Audio Cast session is no longer available.' });
    }

    const expected = Buffer.from(String(session.join_secret_hash), 'hex');
    const actual = Buffer.from(hashJoinToken(token), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return res.status(403).json({ error: 'This Audio Cast QR code is invalid or expired.' });
    }

    let participant = await db.get(
      `SELECT *
         FROM lgo_audio_cast_participants
        WHERE session_id = ?
          AND visitor_user_id = ?`,
      [session.session_id, req.audioCastUser.id]
    );

    if (participant?.status === 'KICKED') {
      return res.status(403).json({ error: 'This listener has been removed from the session.' });
    }

    if (!participant || participant.status !== 'CONNECTED') {
      const count = await participantCount(session.session_id);
      if (count >= Number(session.participant_limit || 25)) {
        return res.status(409).json({ error: 'This Audio Cast session is full.' });
      }
    }

    if (participant) {
      await db.run(
        `UPDATE lgo_audio_cast_participants
            SET status = 'CONNECTED',
                joined_at = COALESCE(joined_at, NOW()),
                last_seen_at = NOW(),
                left_at = NULL
          WHERE participant_id = ?`,
        [participant.participant_id]
      );
    } else {
      const participantId = crypto.randomUUID();
      await db.run(
        `INSERT INTO lgo_audio_cast_participants (
           participant_id, session_id, visitor_user_id, status
         ) VALUES (?,?,?,'CONNECTED')`,
        [participantId, session.session_id, req.audioCastUser.id]
      );
      participant = await db.get(
        'SELECT * FROM lgo_audio_cast_participants WHERE participant_id = ?',
        [participantId]
      );
    }

    return res.json({
      participant_id: participant.participant_id,
      session: {
        session_id: session.session_id,
        title: session.title,
        status: session.status,
        guide_name: session.guide_name,
        participant_limit: Number(session.participant_limit || 25)
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/visitor/sessions/:sessionId/heartbeat', ensureVisitor, async (req, res, next) => {
  try {
    const participant = await db.get(
      `SELECT p.*, s.status AS session_status
         FROM lgo_audio_cast_participants p
         JOIN lgo_audio_cast_sessions s ON s.session_id = p.session_id
        WHERE p.session_id = ?
          AND p.visitor_user_id = ?`,
      [req.params.sessionId, req.audioCastUser.id]
    );
    if (!participant) return res.status(404).json({ error: 'Audio Cast listener session not found.' });
    if (participant.status === 'KICKED') return res.status(403).json({ error: 'Listener removed by guide.' });
    if (participant.session_status === 'ENDED') return res.status(410).json({ error: 'Audio Cast session ended.' });

    const quality = normalizeSignalQuality(req.body?.signal_quality);
    const latency = safeMetric(req.body?.latency_ms, 0, 60_000);
    const jitter = safeMetric(req.body?.jitter_ms, 0, 60_000);
    const transportMode = req.body?.transport_mode
      ? String(req.body.transport_mode).slice(0, 40)
      : null;

    await db.run(
      `UPDATE lgo_audio_cast_participants
          SET last_seen_at = NOW(),
              signal_quality = COALESCE(?, signal_quality),
              latency_ms = COALESCE(?, latency_ms),
              jitter_ms = COALESCE(?, jitter_ms),
              transport_mode = COALESCE(?, transport_mode)
        WHERE participant_id = ?`,
      [quality, latency, jitter, transportMode, participant.participant_id]
    );
    return res.json({
      ok: true,
      participant_status: participant.status,
      session_status: participant.session_status
    });
  } catch (err) {
    next(err);
  }
});

router.post('/visitor/sessions/:sessionId/leave', ensureVisitor, async (req, res, next) => {
  try {
    await db.run(
      `UPDATE lgo_audio_cast_participants
          SET status = CASE WHEN status = 'KICKED' THEN status ELSE 'LEFT' END,
              left_at = CASE WHEN status = 'KICKED' THEN left_at ELSE NOW() END,
              last_seen_at = NOW()
        WHERE session_id = ?
          AND visitor_user_id = ?`,
      [req.params.sessionId, req.audioCastUser.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/visitor/sessions/current', ensureVisitor, async (req, res, next) => {
  try {
    const row = await db.get(
      `SELECT p.participant_id, p.status AS participant_status,
              p.signal_quality, p.latency_ms, p.jitter_ms, p.transport_mode,
              p.joined_at, p.last_seen_at,
              s.session_id, s.title, s.status AS session_status,
              s.participant_limit,
              g.display_name AS guide_name
         FROM lgo_audio_cast_participants p
         JOIN lgo_audio_cast_sessions s ON s.session_id = p.session_id
         JOIN lgo_guides g ON g.id = s.guide_id
        WHERE p.visitor_user_id = ?
          AND p.status = 'CONNECTED'
          AND s.status <> 'ENDED'
        ORDER BY p.joined_at DESC
        LIMIT 1`,
      [req.audioCastUser.id]
    );
    return res.json({ session: row || null });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* ERROR HANDLER                                                              */
/* -------------------------------------------------------------------------- */

router.use((err, _req, res, _next) => {
  console.error('[AudioCast] route error:', err.response?.data || err);
  const status = Number(err.response?.status);
  if (status >= 400 && status < 600) {
    return res.status(502).json({ error: 'Audio Cast provider request failed.' });
  }
  return res.status(500).json({ error: 'Audio Cast operation failed.' });
});

export default router;
