// lib/servicesModules.js
// Filesystem + DB helpers for /public/modules + services + account_services

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { getDB } from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MODULES_ROOT = path.join(PUBLIC_DIR, 'modules');
const SERVICES_MAPPING_FILE = path.join(MODULES_ROOT, 'services-mapping.json');

let db;
function ensureDB() {
  if (!db) db = getDB();
  return db;
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

// Turn "letsgout" or "InTime" → "Letsgout" / "In Time" etc.
export function niceNameFromKey(k) {
  return String(k || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Canonical string (for labels mapping)
function canon(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

// -----------------------------------------------------------------------------
// Load base.json for a module + build manage/use pages
// -----------------------------------------------------------------------------

async function loadBaseJson(serviceKey, mode) {
  const basePath = path.join(MODULES_ROOT, serviceKey, mode, 'base.json');
  try {
    const raw = await fs.readFile(basePath, 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : {};
  } catch (err) {
    console.warn(
      `[modules] base.json missing/invalid for ${serviceKey}/${mode}:`,
      err.message || err
    );
    return {};
  }
}

function buildPagesFromBase(serviceKey, mode, baseJson) {
  const pages = [];
  const entries = Object.entries(baseJson || {});

  const mainEntry = entries.find(
    ([k]) => k.trim().toLowerCase() === 'main'
  );
  if (mainEntry && mainEntry[1]) {
    pages.push({
      slug: 'main.html',
      label: String(mainEntry[1])
    });
  }

  const pageEntries = entries.filter(([k]) =>
    /^page\s+\d+$/i.test(k.trim())
  );
  pageEntries
    .sort((a, b) => {
      const na = parseInt(a[0].replace(/[^\d]/g, ''), 10) || 0;
      const nb = parseInt(b[0].replace(/[^\d]/g, ''), 10) || 0;
      return na - nb;
    })
    .forEach(([key, label]) => {
      if (!label) return;
      const slugBase = key.trim().toLowerCase();
      const encoded = encodeURIComponent(slugBase);
      pages.push({
        slug: `${encoded}.html`,
        label: String(label)
      });
    });

  return pages;
}

// Discover an icon base path for a module, eg /modules/InTime/icons/InTime - round
async function findIconBase(serviceKey) {
  const iconsDir = path.join(MODULES_ROOT, serviceKey, 'icons');
  try {
    const files = await fs.readdir(iconsDir);
    const off =
      files.find((f) => /-off\.png$/i.test(f)) ||
      files.find((f) => /\.png$/i.test(f));
    if (!off) return null;
    const publicPath = `/modules/${serviceKey}/icons/${off}`;
    // Strip -off / .png to get a base like "/modules/x/icons/file"
    return publicPath
      .replace(/-off\.png$/i, '')
      .replace(/\.png$/i, '');
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Scan /public/modules to build module descriptors
// -----------------------------------------------------------------------------

export async function scanModulesFromFS() {
  let entries;
  try {
    entries = await fs.readdir(MODULES_ROOT, { withFileTypes: true });
  } catch (err) {
    console.warn('[modules] failed to read modules folder:', err.message || err);
    return [];
  }

  const modules = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const key = d.name;

    const manageBase = await loadBaseJson(key, 'manage');
    const useBase = await loadBaseJson(key, 'use');

    const managePages = buildPagesFromBase(key, 'manage', manageBase);
    const usePages = buildPagesFromBase(key, 'use', useBase);

    const display_name =
      (manageBase && manageBase.main) ||
      (useBase && useBase.main) ||
      niceNameFromKey(key);

    const icon_base = await findIconBase(key);

    modules.push({
      service_key: key,
      display_name,
      icon_base,
      position: 0,
      managePages,
      usePages
    });
  }

  return modules;
}

// -----------------------------------------------------------------------------
// Services mapping (external JSON, optional)
// -----------------------------------------------------------------------------

// A11 → module config etc.
export let SERVICE_CODE_TO_MODULE = Object.create(null);
// label "In-Time" → { code: 'A11', module_key: 'InTime' }
export let SERVICE_LABEL_TO_CODE = Object.create(null);

export async function loadServiceMapping() {
  try {
    const raw = await fs.readFile(SERVICES_MAPPING_FILE, 'utf8');
    const json = JSON.parse(raw);

    SERVICE_CODE_TO_MODULE = json;
    SERVICE_LABEL_TO_CODE = Object.create(null);

    for (const [code, cfg] of Object.entries(json)) {
      if (cfg.label) {
        SERVICE_LABEL_TO_CODE[canon(cfg.label)] = {
          code,
          module_key: cfg.module_key,
          display_name: cfg.display_name || cfg.module_key || cfg.label
        };
      }
    }

    console.log(
      '[services-mapping] loaded',
      Object.keys(SERVICE_CODE_TO_MODULE).length,
      'entries'
    );
  } catch (e) {
    console.warn('[services-mapping] load failed:', e.message || e);
    SERVICE_CODE_TO_MODULE = Object.create(null);
    SERVICE_LABEL_TO_CODE = Object.create(null);
  }
}

// -----------------------------------------------------------------------------
// DB helpers: services + account_services
// -----------------------------------------------------------------------------

export async function upsertService({
  service_key,
  display_name,
  status = 'active',
  position = 0,
  icon_base = null
}) {
  const db = ensureDB();
  await db.run(
    `INSERT INTO services(service_key, display_name, status, position, icon_base)
     VALUES (?,?,?,?,?)
     ON CONFLICT(service_key) DO UPDATE SET
       display_name = excluded.display_name,
       status       = COALESCE(excluded.status, services.status),
       position     = COALESCE(excluded.position, services.position),
       icon_base    = COALESCE(excluded.icon_base, services.icon_base)`,
    [service_key, display_name, status, position, icon_base]
  );
}

/**
 * Returns full list of services + pages for a given account.
 *
 * - Ensures FS modules are reflected into `services` table.
 * - Merges account_services status with global service status.
 */
export async function getServicesForAccount(role, accountId) {
  const db = ensureDB();
  const roleNorm = String(role || '').toLowerCase();

  // Ensure FS modules are reflected in DB
  const modules = await scanModulesFromFS();

  let maxPosRow = await db.get(
    `SELECT COALESCE(MAX(position), 0) AS maxp FROM services`
  );
  let nextPos = Number(maxPosRow?.maxp || 0) + 1;

  for (const m of modules) {
    await upsertService({
      service_key: m.service_key,
      display_name: m.display_name,
      status: 'active',
      position: nextPos++,
      icon_base: m.icon_base
    });
  }

  const rows = await db.all(
    `
    SELECT
      s.service_key,
      s.display_name,
      s.status AS global_status,
      s.position,
      s.icon_base,
      a.status AS account_status
    FROM services s
    LEFT JOIN account_services a
      ON a.service_key = s.service_key
     AND a.role = ?
     AND a.account_id = ?
    WHERE s.status != 'deleted'
    ORDER BY s.position ASC, s.service_key ASC
  `,
    [roleNorm, accountId]
  );

  // Index FS modules by service_key so we can attach pages/icons
  const moduleIndex = new Map();
  for (const m of modules) {
    moduleIndex.set(m.service_key, m);
  }

  return rows.map((r) => {
    const fsMod = moduleIndex.get(r.service_key) || {};
    const effectiveStatus =
      r.account_status && r.account_status !== 'active'
        ? r.account_status
        : r.global_status;

    return {
      service_key: r.service_key,
      display_name:
        r.display_name || fsMod.display_name || niceNameFromKey(r.service_key),
      icon_base: r.icon_base || fsMod.icon_base || null,
      status: effectiveStatus,
      position: r.position,
      pages: {
        manage: fsMod.managePages || [],
        use: fsMod.usePages || []
      }
    };
  });
}
