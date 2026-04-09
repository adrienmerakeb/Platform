// lib/servicesModules.js
// Filesystem + DB helpers for /public/modules + `services` registry

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { getDb } from '../config/db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths aligned with original server.js behaviour
export const PUBLIC_DIR = path.join(__dirname, '..', 'public');
export const MODULES_ROOT = path.join(PUBLIC_DIR, 'modules');
export const SERVICES_MAPPING_FILE = path.join(MODULES_ROOT, 'services-mapping.json');

/* ---------------- Small generic helpers ---------------- */

export function niceNameFromKey(k) {
  return String(k || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

export const daysSince = (iso) => {
  const t = new Date(iso).getTime();
  if (!t) return 9999;
  return Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
};

/* ---------------- Services table upsert ---------------- */

export async function upsertService({
  service_key,
  display_name,
  status = 'active',
  position = 0,
  icon_base = null
}) {
  const db = getDb();

  await db.run(
    `INSERT INTO services(service_key, display_name, status, position, icon_base)
     VALUES (?,?,?,?,?)
     ON CONFLICT(service_key) DO UPDATE SET
       display_name = excluded.display_name,
       status       = COALESCE(excluded.status, services.status),
       position     = COALESCE(excluded.position, services.position),
       icon_base    = COALESCE(excluded.icon_base, services.icon_base)
    `,
    [service_key, display_name, status, position, icon_base]
  );
}

/* ---------------- Base.json loaders ---------------- */

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

/* ---------------- Icon detection ---------------- */

async function findIconBase(serviceKey) {
  const iconsDir = path.join(MODULES_ROOT, serviceKey, 'icons');
  try {
    const files = await fs.readdir(iconsDir);
    const off =
      files.find(f => /-off\.png$/i.test(f)) ||
      files.find(f => /\.png$/i.test(f));
    if (!off) return null;
    const publicPath = `/modules/${serviceKey}/icons/${off}`;
    return publicPath
      .replace(/-off\.png$/i, '')
      .replace(/\.png$/i, '');
  } catch {
    return null;
  }
}

/* ---------------- Scan /public/modules from FS ---------------- */

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

/* ---------------- Services mapping (code ↔ module) ---------------- */

let SERVICE_CODE_TO_MODULE = Object.create(null);
let SERVICE_LABEL_TO_CODE = Object.create(null);

export function canon(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

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

export function getServiceCodeToModule() {
  return SERVICE_CODE_TO_MODULE;
}

export function getServiceLabelToCode() {
  return SERVICE_LABEL_TO_CODE;
}

export default {
  PUBLIC_DIR,
  MODULES_ROOT,
  SERVICES_MAPPING_FILE,
  niceNameFromKey,
  daysSince,
  upsertService,
  scanModulesFromFS,
  canon,
  loadServiceMapping,
  getServiceCodeToModule,
  getServiceLabelToCode
};
