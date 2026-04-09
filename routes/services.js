// routes/services.js
// Role-aware "what services to render" endpoint: GET /api/services

import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

import { getDb } from '../config/db.js';
import { authRequired } from '../middleware/auth.js';

const router = express.Router();
const db = getDb();

// ----- Paths (public/modules + mapping file) -----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MODULES_ROOT = path.join(PUBLIC_DIR, 'modules');
const SERVICES_MAPPING_FILE = path.join(MODULES_ROOT, 'services-mapping.json');

// ----- Small helpers -----
function daysSince(iso) {
  const t = new Date(iso).getTime();
  if (!t) return 9999;
  return Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
}

function niceNameFromKey(k) {
  return String(k || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function canon(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

// ----- Load base.json + derive pages -----
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

// ----- Scan modules from filesystem -----
async function scanModulesFromFS() {
  let entries;
  try {
    entries = await fs.readdir(MODULES_ROOT, { withFileTypes: true });
  } catch (err) {
    console.warn(
      '[modules] failed to read modules folder:',
      err.message || err
    );
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

// ----- Services mapping (code/label → module_key) -----
let SERVICE_CODE_TO_MODULE = Object.create(null);
let SERVICE_LABEL_TO_CODE = Object.create(null);

async function loadServiceMapping() {
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
// GET /api/services  (role-aware services/dashboard modules)
// -----------------------------------------------------------------------------
router.get('/services', authRequired, async (req, res) => {
  try {
    const { role, id } = req.user;

    let userName = '';
    let createdAt = null;
    let suspended = 0;

    // 1) Scan all modules from filesystem
    const allModules = await scanModulesFromFS();
    const moduleMap = new Map(
      allModules.map(m => [String(m.service_key || '').toLowerCase(), m])
    );

    const getModuleByKey = key => {
      const k = String(key || '').toLowerCase();
      return moduleMap.get(k) || null;
    };

    function buildModulesPayload(allowedKeys, statusResolver) {
      const uniq = [];
      const seen = new Set();

      for (const raw of allowedKeys || []) {
        const k = String(raw || '').toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        uniq.push(k);
      }

      const out = [];
      for (const k of uniq) {
        const mod = getModuleByKey(k);
        if (!mod) continue;
        out.push({
          service_key: mod.service_key,
          display_name: mod.display_name,
          icon_base: mod.icon_base,
          position: mod.position ?? 0,
          managePages: mod.managePages || [],
          usePages: mod.usePages || [],
          status:
            typeof statusResolver === 'function'
              ? statusResolver(mod)
              : 'active'
        });
      }

      out.sort((a, b) => {
        const pa = Number(a.position || 0);
        const pb = Number(b.position || 0);
        if (pa !== pb) return pa - pb;
        return String(a.service_key || '').localeCompare(
          String(b.service_key || '')
        );
      });

      return out;
    }

    const computeStatus = () =>
      suspended
        ? 'suspended'
        : daysSince(createdAt) <= 14
        ? 'trial'
        : 'active';

    // ---------- HOST ----------
    if (role === 'host') {
      const host = await db.get(
        `SELECT company_name, selected_services, created_at, suspended
         FROM hosts WHERE id = ?`,
        [id]
      );
      if (!host) return res.status(404).json({ error: 'Host not found' });

      userName = host.company_name || 'Host';
      createdAt = host.created_at;
      suspended = Number(host.suspended || 0);

      // Load mapping only once if not already loaded
      if (
        !Object.keys(SERVICE_CODE_TO_MODULE).length &&
        !Object.keys(SERVICE_LABEL_TO_CODE).length
      ) {
        await loadServiceMapping();
      }

      const allowedKeySet = new Set();

      // Account-level services
      const svcRows = await db.all(
        `SELECT service_key
           FROM account_services
          WHERE role = 'host'
            AND account_id = ?
            AND status = 'active'`,
        [id]
      );
      for (const r of svcRows) {
        if (!r.service_key) continue;
        allowedKeySet.add(r.service_key);
      }

      // Legacy selected_services (codes or labels)
      const rawList = (() => {
        try {
          const parsed = JSON.parse(host.selected_services || '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();

      for (const entry of rawList) {
        if (!entry) continue;
        const asString = String(entry);

        const codeCfg = SERVICE_CODE_TO_MODULE[asString];
        if (codeCfg && codeCfg.module_key) {
          allowedKeySet.add(codeCfg.module_key);
          continue;
        }

        const labelCfg = SERVICE_LABEL_TO_CODE[canon(asString)];
        if (labelCfg && labelCfg.module_key) {
          allowedKeySet.add(labelCfg.module_key);
        }
      }

      let allowedKeys = Array.from(allowedKeySet);
      if (!allowedKeys.length) {
        allowedKeys = allModules.map(m => m.service_key);
      }

      const statusResolver = () => computeStatus();
      const modules = buildModulesPayload(allowedKeys, statusResolver);

      const header = {
        displayName: userName,
        role,
        avatar: null
      };

      return res.json({ user: header, modules });
    }

    // ---------- PARTNER ----------
    if (role === 'partner') {
      const partner = await db.get(
        `SELECT company_name, created_at, suspended
           FROM partners WHERE id = ?`,
        [id]
      );
      if (!partner) {
        return res.status(404).json({ error: 'Partner not found' });
      }

      userName = partner.company_name || 'Partner';
      createdAt = partner.created_at;
      suspended = Number(partner.suspended || 0);

      const svcRows = await db.all(
        `SELECT service_key
           FROM account_services
          WHERE role = 'partner'
            AND account_id = ?
            AND status = 'active'`,
        [id]
      );

      let allowedKeys = svcRows.map(r => r.service_key).filter(Boolean);
      if (!allowedKeys.length) {
        allowedKeys = allModules.map(m => m.service_key);
      }

      const statusResolver = mod => {
        const keyLower = String(mod.service_key || '').toLowerCase();
        const nameLower = String(mod.display_name || '').toLowerCase();
        if (keyLower.includes('ads') || nameLower.includes('advert')) {
          return 'upcoming';
        }
        return computeStatus();
      };

      const modules = buildModulesPayload(allowedKeys, statusResolver);

      const header = {
        displayName: userName,
        role,
        avatar: null
      };

      return res.json({ user: header, modules });
    }

    // ---------- VISITOR / GUIDE ----------
    const visitor = await db.get(
      `SELECT name, created_at, suspended
         FROM users WHERE id = ?`,
      [id]
    );
    if (!visitor) {
      return res.status(404).json({ error: 'Visitor not found' });
    }

    userName = visitor.name || 'Visitor';
    createdAt = visitor.created_at;
    suspended = Number(visitor.suspended || 0);

    const svcRows = await db.all(
      `SELECT service_key
         FROM account_services
        WHERE (role = 'visitor' OR role = 'guide')
          AND account_id = ?
          AND status = 'active'`,
      [id]
    );

    let allowedKeys = svcRows.map(r => r.service_key).filter(Boolean);
    if (!allowedKeys.length) {
      allowedKeys = allModules.map(m => m.service_key);
    }

    const statusResolver = () => computeStatus();
    const modules = buildModulesPayload(allowedKeys, statusResolver);

    const header = {
      displayName: userName,
      role,
      avatar: null
    };

    return res.json({ user: header, modules });
  } catch (e) {
    console.error('services error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
