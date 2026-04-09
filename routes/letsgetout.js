// routes/letsgetout.js
// Manage-side API for "Let's Get Out!" (guides + guidings + steps)

import express from 'express';
import { getDb } from '../config/db.js';
import { authRequired } from '../middleware/auth.js';

import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const router = express.Router();
const db = getDb();

// ---- FS setup for uploads ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// /uploads/lgo/audio under project root
const audioUploadDir = path.join(__dirname, '..', 'uploads', 'lgo', 'audio');

// Ensure directory exists (no top-level await)
fs.mkdir(audioUploadDir, { recursive: true }).catch((err) => {
  console.error('[LetsGetOut] Could not ensure audio upload dir:', err);
});

// Multer storage for audio
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, audioUploadDir);
  },
  filename: (req, file, cb) => {
    const ext = (file.originalname && path.extname(file.originalname)) || '.webm';
    const safeExt = (ext || '').toLowerCase() || '.webm';
    const base = 'step-audio-' + Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, base + safeExt);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

// ========== IMAGE UPLOAD (up to 5 images per step) ==========
const imageUploadDir = path.join(__dirname, '..', 'uploads', 'lgo', 'images');

fs.mkdir(imageUploadDir, { recursive: true }).catch((err) => {
  console.error('[LetsGetOut] Could not ensure image upload dir:', err);
});

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, imageUploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const base = 'step-img-' + Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, base + ext);
  }
});

const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

/* -------------------------------------------------------------------------- */
/* AUTH GUARDS                                                                */
/* -------------------------------------------------------------------------- */

// All routes below require a valid JWT cookie
router.use(authRequired);

// Allow:
//  - visitors with status "G" or "VG"
//  - hosts that have the "Let’s Get Out" service active (future-ready)
async function guideOrHostWithLgo(req, res, next) {
  try {
    const user = req.user || {};
    const role = user.role;
    const status = (user.status || '').toUpperCase();
    const accountId = user.id;

    // 1) Visitors with guide status
    if (role === 'visitor') {
      if (status === 'G' || status === 'VG') {
        return next();
      }
      return res.status(403).json({
        error: 'Guide status required (G or VG) to manage guidings.'
      });
    }

    // 2) Hosts with "Let's Get Out" service active
    if (role === 'host') {
      let hasLgo = false;

      // 2a) Modern way: account_services row
      const row = await db.get(
        `SELECT 1
           FROM account_services
          WHERE role = ?
            AND account_id = ?
            AND service_key = 'lgo'
            AND status = 'active'`,
        'host',
        accountId
      );

      if (row) {
        hasLgo = true;
      }

      // 2b) Fallback / legacy: hosts.selected_services JSON or text
      if (!hasLgo) {
        const hostRow = await db.get(
          'SELECT selected_services FROM hosts WHERE id = ?',
          accountId
        );

        if (hostRow && hostRow.selected_services) {
          const raw = hostRow.selected_services;

          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              const norm = parsed
                .map((s) => String(s || '').trim().toLowerCase())
                .filter(Boolean);

              if (
                norm.some(
                  (s) =>
                    s.includes('let’s get out') ||
                    s.includes("let's get out")
                )
              ) {
                hasLgo = true;
              }
            } else if (typeof parsed === 'string') {
              const s = parsed.toLowerCase();
              if (
                s.includes('let’s get out') ||
                s.includes("let's get out")
              ) {
                hasLgo = true;
              }
            }
          } catch {
            const s = String(raw).toLowerCase();
            if (
              s.includes('let’s get out') ||
              s.includes("let's get out")
            ) {
              hasLgo = true;
            }
          }
        }
      }

      if (hasLgo) {
        // Host passes guard; actual guide profile creation still visitor-only.
        return next();
      }

      return res.status(403).json({
        error: 'Host must have the "Let\'s Get Out!" service active to manage guidings.'
      });
    }

    // 3) Any other role: forbidden
    return res.status(403).json({
      error: 'Access restricted to guides and eligible hosts.'
    });
  } catch (err) {
    console.error('guideOrHostWithLgo error:', err);
    return res.status(500).json({ error: 'Authorization check failed' });
  }
}

// Apply guard to all routes in this router
router.use((req, res, next) => {
  Promise.resolve(guideOrHostWithLgo(req, res, next)).catch(next);
});

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolve canonical owner context from req.user.
 * This is what we use to attach / filter guidings:
 *   owner_role        = req.user.role  (lowercased)
 *   owner_account_id  = req.user.id
 */
function getOwnerContext(req) {
  const user = req.user || {};
  const ownerRole = (user.role || 'visitor').toLowerCase();
  const ownerAccountId = user.id;

  if (!ownerAccountId) {
    throw new Error('Missing account id on req.user');
  }

  return { ownerRole, ownerAccountId };
}

/**
 * Ensures the current account has a guide profile and returns it.
 *
 * Current implementation:
 *   - We only auto-create guide profiles for visitors.
 *   - For visitors:
 *       owner_role       = 'visitor'
 *       owner_account_id = users.id
 *       user_id          = users.id  (legacy FK)
 */
/**
 * Ensures the current account has a guide profile and returns it.
 *
 * Multi-role behaviour:
 *   - visitor:
 *       owner_role       = 'visitor'
 *       owner_account_id = users.id
 *       user_id          = users.id  (real visitor user)
 *
 *   - host:
 *       owner_role       = 'host'
 *       owner_account_id = hosts.id
 *       user_id          = shadow users.id
 *         (a synthetic "shadow visitor" user created only to satisfy
 *          lgo_guides.user_id NOT NULL + FK → users(id))
 */
async function getOrCreateGuideForCurrentAccount(req) {
  const { ownerRole, ownerAccountId } = getOwnerContext(req);

  // 1) Try existing guide profile by owner_role + owner_account_id
  let guide = await db.get(
    'SELECT * FROM lgo_guides WHERE owner_role = ? AND owner_account_id = ?',
    ownerRole,
    ownerAccountId
  );
  if (guide) return guide;

  // 2) VISITOR → create a real guide profile linked to real user
  if (ownerRole === 'visitor') {
    const user = await db.get(
      'SELECT name, email FROM users WHERE id = ?',
      ownerAccountId
    );
    const displayName = user?.name || user?.email || 'New guide';

    const result = await db.run(
      `INSERT INTO lgo_guides (user_id, owner_role, owner_account_id, display_name)
       VALUES (?,?,?,?)`,
      ownerAccountId,    // user_id (real visitor)
      ownerRole,         // 'visitor'
      ownerAccountId,    // owner_account_id = users.id
      displayName
    );

    guide = await db.get('SELECT * FROM lgo_guides WHERE id = ?', result.lastID);

    // Mark visitor as having a guide profile
    await db.run(
      'UPDATE users SET has_guide_profile = 1 WHERE id = ?',
      ownerAccountId
    );

    return guide;
  }

  // 3) HOST → create a "shadow visitor user" + guide profile
  if (ownerRole === 'host') {
    // Get host data for naming
    const host = await db.get(
      'SELECT company_name, email FROM hosts WHERE id = ?',
      ownerAccountId
    );
    if (!host) {
      throw new Error(`Host account not found for id=${ownerAccountId}`);
    }

    const displayName =
      host.company_name || host.email || `Host #${ownerAccountId}`;

    // Make a guaranteed-unique email for the shadow user
    const shadowEmail = `host-${ownerAccountId}@lgo-shadow.local`;

    // Create synthetic user row (never used for login)
    const userResult = await db.run(
      `INSERT INTO users (
         name,
         email,
         password_hash,
         role,
         status,
         has_guide_profile,
         provider
       )
       VALUES (?,?,?,?,?,?,?)`,
      displayName,
      shadowEmail,
      'lgo-host-shadow',   // dummy password hash (never used)
      'visitor',           // or 'host-shadow' if you later introduce that
      'G',                 // mark as guide-type status
      1,
      'lgo-host-shadow'    // provider marker
    );

    const shadowUserId = userResult.lastID;

    // Create guide profile pointing to the shadow user, but owned by host
    const guideResult = await db.run(
      `INSERT INTO lgo_guides (user_id, owner_role, owner_account_id, display_name)
       VALUES (?,?,?,?)`,
      shadowUserId,
      ownerRole,          // 'host'
      ownerAccountId,     // hosts.id
      displayName
    );

    guide = await db.get('SELECT * FROM lgo_guides WHERE id = ?', guideResult.lastID);
    return guide;
  }

  // 4) Other roles (partner, admin, ...) not supported yet
  throw new Error(
    'Guide profiles are currently only supported for visitor and host accounts.'
  );
}

/**
 * Helper: load a guiding that belongs to the CURRENT account (multi-role aware).
 * Uses lgo_guides.owner_role + lgo_guides.owner_account_id.
 */
async function loadOwnedGuidingOr404(req, guidingId) {
  const { ownerRole, ownerAccountId } = getOwnerContext(req);

  if (!guidingId || Number.isNaN(Number(guidingId))) return null;

  const guiding = await db.get(
    `
    SELECT g.*
      FROM lgo_guidings g
      JOIN lgo_guides lg ON lg.id = g.guide_id
     WHERE g.id = ?
       AND lg.owner_role = ?
       AND lg.owner_account_id = ?
    `,
    guidingId,
    ownerRole,
    ownerAccountId
  );

  return guiding || null;
}

/* -------------------------------------------------------------------------- */
/* STEP 1 – CONFIGURATION (page 1.html "Save & continue")                     */
/* -------------------------------------------------------------------------- */

router.post('/guidings/step1', async (req, res) => {
  try {
    const guide = await getOrCreateGuideForCurrentAccount(req);

    const {
      guidingId,
      type,
      freeUse,
      monetizationModel,
      priceCents,
      allowTeasers,
      tippingEnabled,
      offlineAllowed
    } = req.body || {};

    if (!type || !['online', 'live', 'irl'].includes(type)) {
      return res.status(400).json({ error: 'Invalid or missing guiding type' });
    }

    const free_use      = freeUse ? 1 : 0;
    const allow_teasers = allowTeasers ? 1 : 0;
    const tipping       = tippingEnabled ? 1 : 0;
    const offline       = offlineAllowed ? 1 : 0;
    const monetization  = monetizationModel || 'ads';
    const price         = Number.isFinite(priceCents) ? priceCents : 0;

    let id = guidingId || null;

    if (id) {
      // ---- UPDATE EXISTING GUIDING (owned by this account only) ----
      const existing = await loadOwnedGuidingOr404(req, id);
      if (!existing) {
        return res.status(404).json({ error: 'Guiding not found' });
      }

      await db.run(
        `UPDATE lgo_guidings
           SET type               = ?,
               free_use           = ?,
               monetization_model = ?,
               price_cents        = ?,
               allow_teasers      = ?,
               tipping_enabled    = ?,
               offline_allowed    = ?,
               status             = 'in-progress',
               is_active          = 0,
               updated_at         = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          type,
          free_use,
          monetization,
          price,
          allow_teasers,
          tipping,
          offline,
          id
        ]
      );
    } else {
      // ---- CREATE NEW GUIDING WITH A NON-NULL TITLE ----
      const result = await db.run(
        `INSERT INTO lgo_guidings (
           guide_id,
           title,
           type,
           status,
           is_active,
           free_use,
           monetization_model,
           price_cents,
           allow_teasers,
           tipping_enabled,
           offline_allowed
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          guide.id,
          'Draft guiding',   // placeholder title (NOT NULL)
          type,
          'in-progress',
          0,                 // not active yet
          free_use,
          monetization,
          price,
          allow_teasers,
          tipping,
          offline
        ]
      );
      id = result.lastID;
    }

    return res.json({ ok: true, guiding_id: id });
  } catch (err) {
    console.error('POST /guidings/step1 error', err);
    if (
      err &&
      typeof err.message === 'string' &&
      err.message.includes('visitor accounts')
    ) {
      return res.status(403).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to save guiding configuration (step 1)' });
  }
});

/* -------------------------------------------------------------------------- */
/* AUDIO & IMAGE UPLOAD                                                       */
/* -------------------------------------------------------------------------- */

router.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const relPath = path.relative(
      path.join(__dirname, '..'),
      req.file.path
    ); // e.g. "uploads/lgo/audio/step-audio-123.webm"

    const publicUrl = '/' + relPath.replace(/\\/g, '/');

    return res.json({ url: publicUrl });
  } catch (err) {
    console.error('POST /upload-audio error', err);
    return res.status(500).json({ error: 'Failed to upload audio' });
  }
});

router.post('/upload-image', uploadImage.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    const relPath = path.relative(
      path.join(__dirname, '..'),
      req.file.path
    );

    const publicUrl = '/' + relPath.replace(/\\/g, '/');

    return res.json({ url: publicUrl });
  } catch (err) {
    console.error('POST /upload-image error', err);
    return res.status(500).json({ error: 'Failed to upload image' });
  }
});

/* -------------------------------------------------------------------------- */
/* GUIDINGS LIST / SINGLE                                                     */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/letsgetout/guidings
 *
 * Returns ONLY guidings owned by the CURRENT account
 * via lgo_guides.owner_role / owner_account_id.
 */
router.get('/guidings', async (req, res) => {
  try {
    const { ownerRole, ownerAccountId } = getOwnerContext(req);

    const rows = await db.all(
      `SELECT g.*
         FROM lgo_guidings g
         JOIN lgo_guides lg ON lg.id = g.guide_id
        WHERE lg.owner_role = ?
          AND lg.owner_account_id = ?
        ORDER BY g.created_at DESC`,
      ownerRole,
      ownerAccountId
    );

    // Optional debug:
    console.log(
      '[LGO] /guidings for',
      ownerRole,
      ownerAccountId,
      '→',
      rows.length,
      'rows'
    );

    res.json(rows);
  } catch (err) {
    console.error('GET /guidings error', err);
    res.status(500).json({ error: 'Failed to load guidings' });
  }
});

// GET /api/letsgetout/guidings/:id → single guiding + steps
router.get('/guidings/:id', async (req, res) => {
  try {
    const guidingId = Number(req.params.id);

    const guiding = await loadOwnedGuidingOr404(req, guidingId);
    if (!guiding) return res.status(404).json({ error: 'Guiding not found' });

    const steps = await db.all(
      `SELECT *
         FROM lgo_guiding_steps
        WHERE guiding_id = ?
        ORDER BY order_index ASC`,
      guiding.id
    );

    res.json({ guiding, steps });
  } catch (err) {
    console.error('GET /guidings/:id error', err);
    res.status(500).json({ error: 'Failed to load guiding' });
  }
});

/* -------------------------------------------------------------------------- */
/* LEGACY CREATE (one-shot)                                                   */
/* -------------------------------------------------------------------------- */

router.post('/guidings', async (req, res) => {
  try {
    const guide = await getOrCreateGuideForCurrentAccount(req);

    const {
      title,
      type,                     // 'online' | 'live' | 'irl'
      free_use = true,
      monetization_model = 'ads',
      price_cents = 0,
      allow_teasers = false,
      tipping_enabled = false,
      offline_allowed = false,
      languages = [],
      description = '',
      tags = '',
      recommendations = '',
      standard_radius_m = 50
    } = req.body || {};

    if (!type) {
      return res.status(400).json({ error: 'type is required' });
    }

    const result = await db.run(
      `INSERT INTO lgo_guidings (
         guide_id, title, type,
         free_use, monetization_model, price_cents,
         allow_teasers, tipping_enabled, offline_allowed,
         languages_json, description, tags, recommendations,
         standard_radius_m
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      guide.id,
      title || 'Draft guiding',
      type,
      free_use ? 1 : 0,
      monetization_model,
      price_cents || 0,
      allow_teasers ? 1 : 0,
      tipping_enabled ? 1 : 0,
      offline_allowed ? 1 : 0,
      JSON.stringify(languages || []),
      description,
      tags,
      recommendations,
      standard_radius_m || 50
    );

    const guiding = await db.get(
      'SELECT * FROM lgo_guidings WHERE id = ?',
      result.lastID
    );

    res.status(201).json(guiding);
  } catch (err) {
    console.error('POST /guidings error', err);
    if (
      err &&
      typeof err.message === 'string' &&
      err.message.includes('visitor accounts')
    ) {
      return res.status(403).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to create guiding' });
  }
});

/* -------------------------------------------------------------------------- */
/* UPDATE GENERAL INFO (page 1 + 1-2 header)                                  */
/* -------------------------------------------------------------------------- */

router.put('/guidings/:id', async (req, res) => {
  try {
    const guidingId = Number(req.params.id);

    const existing = await loadOwnedGuidingOr404(req, guidingId);
    if (!existing) return res.status(404).json({ error: 'Guiding not found' });

    const payload = { ...existing, ...req.body };

    const languages =
      payload.languages ||
      (existing.languages_json ? JSON.parse(existing.languages_json) : []);

    const transportModes =
      payload.transport_modes ||
      (existing.transport_modes_json ? JSON.parse(existing.transport_modes_json) : []);

    await db.run(
      `UPDATE lgo_guidings SET
         title = ?,
         type = ?,
         free_use = ?,
         monetization_model = ?,
         price_cents = ?,
         allow_teasers = ?,
         tipping_enabled = ?,
         offline_allowed = ?,
         languages_json = ?,
         start_lat = ?, start_lng = ?,
         end_lat = ?, end_lng = ?,
         start_label = ?, end_label = ?,
         length_km = ?, duration_min = ?,
         transport_modes_json = ?,
         description = ?,
         tags = ?,
         recommendations = ?,
         standard_radius_m = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      payload.title || existing.title,
      payload.type || existing.type,
      payload.free_use ? 1 : 0,
      payload.monetization_model || existing.monetization_model,
      payload.price_cents ?? existing.price_cents ?? 0,
      payload.allow_teasers ? 1 : 0,
      payload.tipping_enabled ? 1 : 0,
      payload.offline_allowed ? 1 : 0,
      JSON.stringify(languages || []),
      payload.start_lat ?? existing.start_lat,
      payload.start_lng ?? existing.start_lng,
      payload.end_lat ?? existing.end_lat,
      payload.end_lng ?? existing.end_lng,
      payload.start_label ?? existing.start_label,
      payload.end_label ?? existing.end_label,
      payload.length_km ?? existing.length_km,
      payload.duration_min ?? existing.duration_min,
      JSON.stringify(transportModes || []),
      payload.description ?? existing.description,
      payload.tags ?? existing.tags,
      payload.recommendations ?? existing.recommendations,
      payload.standard_radius_m ?? existing.standard_radius_m ?? 50,
      existing.id
    );

    const updated = await db.get(
      'SELECT * FROM lgo_guidings WHERE id = ?',
      existing.id
    );
    res.json(updated);
  } catch (err) {
    console.error('PUT /guidings/:id error', err);
    res.status(500).json({ error: 'Failed to update guiding' });
  }
});

/* -------------------------------------------------------------------------- */
/* STEP 2 – STEPS & SUMMARY (page 1-2.html "Save")                            */
/* -------------------------------------------------------------------------- */

router.post('/guidings/:id/steps', async (req, res) => {
  const guidingId = Number(req.params.id);

  if (!guidingId || Number.isNaN(guidingId)) {
    return res.status(400).json({ error: 'Invalid guiding id' });
  }

  const { steps } = req.body || {};
  if (!Array.isArray(steps)) {
    return res.status(400).json({ error: 'steps must be an array' });
  }

  try {
    const guiding = await loadOwnedGuidingOr404(req, guidingId);
    if (!guiding) {
      return res.status(404).json({ error: 'Guiding not found' });
    }

    await db.run('BEGIN TRANSACTION');

    // 1) Delete existing steps
    await db.run(
      'DELETE FROM lgo_guiding_steps WHERE guiding_id = ?',
      guidingId
    );

    // 2) Prepare insert with extended columns
    const insertStmt = await db.prepare(`
      INSERT INTO lgo_guiding_steps (
        guiding_id,
        order_index,
        title,
        lat,
        lng,
        description,
        recommendations,
        audio_url,
        image_urls_json,
        video_urls_json,
        transport_mode,
        radius_override_m,
        country,
        city,
        transport_modes_json,
        has_fee,
        has_accessibility,
        emergency_tags_json
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    // Summary accumulators
    const countryCityList = [];
    const ccSeen = new Set();
    const transportCounts = {};
    let anyFees = 0;
    let anyAccessibility = 0;
    let anyEmergency = 0;

    let orderIndex = 0;

    for (const rawStep of steps) {
      if (!rawStep) continue;
      const s = rawStep || {};

      // Basic fields
      const title       = (s.title || '').trim() || null;
      const description = (s.description || '').trim() || null;
      const recommendations = s.recommendations || null;
      const audioUrl    = (s.audio_url || '').trim() || '';

      const lat =
        typeof s.lat === 'number'
          ? s.lat
          : (s.lat != null ? Number(s.lat) : 0) || 0;
      const lng =
        typeof s.lng === 'number'
          ? s.lng
          : (s.lng != null ? Number(s.lng) : 0) || 0;

      const radiusOverride =
        typeof s.radius_override_m === 'number'
          ? s.radius_override_m
          : (s.radius_override_m != null ? Number(s.radius_override_m) : null);

      // Country / city
      const country = (s.country || '').trim() || null;
      const city    = (s.city || '').trim() || null;

      // Transport modes (array or single string)
      let transportModesArr = [];
      if (Array.isArray(s.transport_modes)) {
        transportModesArr = s.transport_modes
          .map((m) => String(m).trim())
          .filter(Boolean);
      } else if (s.transport_mode) {
        transportModesArr = [String(s.transport_mode).trim()];
      }

      const transportModesJson =
        transportModesArr.length ? JSON.stringify(transportModesArr) : null;

      const hasFee =
        s.has_fee === true ||
        s.has_fee === 1 ||
        s.has_fee === '1'
          ? 1
          : 0;

      const hasAccessibility =
        s.has_accessibility === true ||
        s.has_accessibility === 1 ||
        s.has_accessibility === '1'
          ? 1
          : 0;

      const emergencyTagsArr = Array.isArray(s.emergency_tags)
        ? s.emergency_tags.map((t) => String(t).trim()).filter(Boolean)
        : [];
      const emergencyTagsJson =
        emergencyTagsArr.length ? JSON.stringify(emergencyTagsArr) : null;

      // Keep one main mode in legacy transport_mode column
      const mainTransportMode = transportModesArr[0] || null;

      // Insert step row
      await insertStmt.run(
        guidingId,               // guiding_id
        orderIndex,              // order_index
        title,                   // title
        lat,                     // lat
        lng,                     // lng
        description,             // description
        recommendations,         // recommendations
        audioUrl,                // audio_url
        null,                    // image_urls_json (future)
        null,                    // video_urls_json (future)
        mainTransportMode,       // transport_mode
        radiusOverride,          // radius_override_m
        country,                 // country
        city,                    // city
        transportModesJson,      // transport_modes_json
        hasFee,                  // has_fee
        hasAccessibility,        // has_accessibility
        emergencyTagsJson        // emergency_tags_json
      );

      // ---- Build guiding-level summary while looping ----

      if (country || city) {
        const key = `${country || ''}|||${city || ''}`;
        if (!ccSeen.has(key)) {
          ccSeen.add(key);
          countryCityList.push({ country: country || null, city: city || null });
        }
      }

      for (const mode of transportModesArr) {
        if (!transportCounts[mode]) transportCounts[mode] = 0;
        transportCounts[mode] += 1;
      }

      if (hasFee) anyFees = 1;
      if (hasAccessibility) anyAccessibility = 1;
      if (emergencyTagsArr.length) anyEmergency = 1;

      orderIndex += 1;
    }

    await insertStmt.finalize();

    // 3) Compute guiding-level summary fields
    const primary = countryCityList[0] || { country: null, city: null };

    const countriesCitiesJson =
      countryCityList.length ? JSON.stringify(countryCityList) : null;

    const transportSummaryArr = Object.entries(transportCounts).map(
      ([mode, count]) => ({ mode, count })
    );
    const transportSummaryJson =
      transportSummaryArr.length ? JSON.stringify(transportSummaryArr) : null;

    // 4) Update lgo_guidings with the computed summary
    await db.run(
      `
      UPDATE lgo_guidings
      SET
        primary_country        = ?,
        primary_city           = ?,
        countries_cities_json  = ?,
        transport_summary_json = ?,
        has_fees               = ?,
        has_accessibility      = ?,
        has_emergency_services = ?,
        updated_at             = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      primary.country,
      primary.city,
      countriesCitiesJson,
      transportSummaryJson,
      anyFees,
      anyAccessibility,
      anyEmergency,
      guidingId
    );

    await db.run('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /guidings/:id/steps error', err);
    try {
      await db.run('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    return res.status(500).json({ error: 'Failed to save steps' });
  }
});

/* -------------------------------------------------------------------------- */
/* PUBLISH (mark as finished + active)                                        */
/* -------------------------------------------------------------------------- */

router.post('/guidings/:id/publish', async (req, res) => {
  try {
    const guidingId = Number(req.params.id);

    const guiding = await loadOwnedGuidingOr404(req, guidingId);
    if (!guiding) return res.status(404).json({ error: 'Guiding not found' });

    await db.run(
      `UPDATE lgo_guidings
         SET status = 'published',
             is_active = 1,
             published_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      guiding.id
    );

    const updated = await db.get(
      'SELECT * FROM lgo_guidings WHERE id = ?',
      guiding.id
    );
    res.json(updated);
  } catch (err) {
    console.error('POST /guidings/:id/publish error', err);
    res.status(500).json({ error: 'Failed to publish guiding' });
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE GUIDING                                                             */
/* -------------------------------------------------------------------------- */

router.delete('/guidings/:id', async (req, res) => {
  try {
    const guidingId = Number(req.params.id);

    const guiding = await loadOwnedGuidingOr404(req, guidingId);
    if (!guiding) return res.status(404).json({ error: 'Guiding not found' });

    await db.run('DELETE FROM lgo_guiding_steps WHERE guiding_id = ?', guiding.id);
    await db.run('DELETE FROM lgo_guidings WHERE id = ?', guiding.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /guidings/:id error', err);
    res.status(500).json({ error: 'Failed to delete guiding' });
  }
});

/* -------------------------------------------------------------------------- */
/* STATE PATCH – In progress / Finished + Active toggle                       */
/* -------------------------------------------------------------------------- */

router.patch('/guidings/:id/state', async (req, res) => {
  try {
    const guidingId = Number(req.params.id);
    if (!guidingId || Number.isNaN(guidingId)) {
      return res.status(400).json({ error: 'Invalid guiding id' });
    }

    const existing = await loadOwnedGuidingOr404(req, guidingId);
    if (!existing) {
      return res.status(404).json({ error: 'Guiding not found' });
    }

    let { status, is_active } = req.body || {};
    let newStatus = (status || existing.status || 'in-progress').toLowerCase();

    if (newStatus !== 'published') {
      newStatus = 'in-progress';
    }

    let newActive = 0;
    if (newStatus === 'published') {
      newActive = is_active ? 1 : 0;
    } else {
      newActive = 0;
    }

    await db.run(
      `UPDATE lgo_guidings
         SET status    = ?,
             is_active = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      newStatus,
      newActive,
      guidingId
    );

    const updated = await db.get(
      'SELECT * FROM lgo_guidings WHERE id = ?',
      guidingId
    );

    return res.json(updated);
  } catch (err) {
    console.error('PATCH /guidings/:id/state error', err);
    return res.status(500).json({ error: 'Failed to update guiding state' });
  }
});

/* -------------------------------------------------------------------------- */
/* SUMMARY (for Preview)                                                      */
/* -------------------------------------------------------------------------- */

router.get('/guidings/:id/summary', async (req, res) => {
  try {
    const guidingId = Number(req.params.id);
    if (!guidingId || Number.isNaN(guidingId)) {
      return res.status(400).json({ error: 'Invalid guiding id' });
    }

    const guiding = await loadOwnedGuidingOr404(req, guidingId);
    if (!guiding) {
      return res.status(404).json({ error: 'Guiding not found' });
    }

    const steps = await db.all(
      `SELECT emergency_tags_json
         FROM lgo_guiding_steps
        WHERE guiding_id = ?`,
      guidingId
    );

    const stepsCount = steps.length;

    const emergencyTagSet = new Set();
    for (const s of steps) {
      if (!s || !s.emergency_tags_json) continue;
      try {
        const arr = JSON.parse(s.emergency_tags_json) || [];
        for (const tag of arr) {
          if (tag) emergencyTagSet.add(String(tag));
        }
      } catch {
        // ignore
      }
    }

    const emergencyTags = Array.from(emergencyTagSet);

    let transportModes = [];
    if (guiding.transport_summary_json) {
      try {
        const summaryArr = JSON.parse(guiding.transport_summary_json) || [];
        transportModes = summaryArr
          .map((x) => x.mode)
          .filter(Boolean);
      } catch {
        // ignore
      }
    } else if (guiding.transport_modes_json) {
      try {
        const arr = JSON.parse(guiding.transport_modes_json) || [];
        transportModes = Array.from(new Set(arr.filter(Boolean)));
      } catch {
        // ignore
      }
    }

    const hasAccessibility =
      guiding.has_accessibility === 1 || guiding.has_accessibility === true;
    const hasEmergency =
      guiding.has_emergency_services === 1 || guiding.has_emergency_services === true;

    const healthSummary = guiding.has_fees
      ? 'Some points may require entrance fees (museums, attractions, etc.).'
      : 'No specific health-related fees recorded.';

    const emergencySummary = hasEmergency
      ? (emergencyTags.length
          ? `Nearby emergency services: ${emergencyTags.join(', ')}.`
          : 'Emergency services have been flagged near some steps.')
      : 'No specific emergency facilities flagged.';

    const lengthKm    = guiding.length_km;
    const durationMin = guiding.duration_min;

    return res.json({
      ok: true,
      guiding_id: guidingId,
      steps_count: stepsCount,
      total_length_km: lengthKm,
      total_duration_min: durationMin,
      transport_modes: transportModes,
      has_accessibility: hasAccessibility,
      has_emergency_services: hasEmergency,
      health_facilities_summary: healthSummary,
      emergency_facilities_summary: emergencySummary
    });
  } catch (err) {
    console.error('GET /guidings/:id/summary error', err);
    return res.status(500).json({ error: 'Failed to compute guiding summary' });
  }
});

export default router;
