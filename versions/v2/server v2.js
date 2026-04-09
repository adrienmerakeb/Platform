// server.js — modular WanderPal server (auth + services + In-Time + OAuth + calendar)

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import passport from 'passport';

// DB init
import { initDB } from './config/db.js';

// Routers
import adminRoutes from './routes/admin.js';
import authVisitorRoutes from './routes/authVisitor.js';
import authHostRoutes from './routes/authHost.js';
import authPartnerRoutes from './routes/authPartner.js';
import oauthVisitorRoutes from './routes/oauthVisitor.js';
import servicesRoutes from './routes/services.js';
import calendarHostRoutes from './routes/calendarHost.js';
import intimeHostRoutes from './routes/intimeHost.js';
import miscRoutes from './routes/misc.js';

dotenv.config();

// ---- Paths ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, 'public');
const MODULES_ROOT = path.join(PUBLIC_DIR, 'modules');

const IS_PROD = process.env.NODE_ENV === 'production';

// ---- App ----
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());

// Static assets
app.use(express.static(PUBLIC_DIR));
app.use('/modules', express.static(MODULES_ROOT));

// Debug log for role APIs (from original server.js)
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/host/')) {
    console.log(
      '[HOST API]',
      req.method,
      req.path,
      'CT:',
      req.headers['content-type']
    );
  }
  if (req.path.startsWith('/api/partner/')) {
    console.log(
      '[PARTNER API]',
      req.method,
      req.path,
      'CT:',
      req.headers['content-type']
    );
  }
  next();
});

// Passport for OAuth (strategies are configured in routes/oauthVisitor.js)
app.use(passport.initialize());

// ---- Routes ----

// Admin (login, moderation, services & account_services, scan-modules, etc.)
// e.g. /api/admin/login, /api/admin/services
app.use('/api', adminRoutes);

// Local auth: visitor, host, partner
// Visitor:  /api/register, /api/login, /api/forgot, /api/reset, /api/status, /api/guide/create
app.use('/api', authVisitorRoutes);

// Host:     /api/host/register, /api/host/login, /api/host/forgot, /api/host/reset
app.use('/api', authHostRoutes);

// Partner:  /api/partner/register, /api/partner/login, /api/partner/forgot, /api/partner/reset
app.use('/api', authPartnerRoutes);

// OAuth for visitors: /auth/google, /auth/google/callback, /auth/apple..., /auth/facebook...
app.use(oauthVisitorRoutes);

// Dashboard services: /api/services
app.use('/api', servicesRoutes);

// Host calendar sync: /api/host/calendar/google/start, /api/host/calendar/status, etc.
app.use('/api', calendarHostRoutes);

// In-Time queues & bookings: host + public
// Host:   /api/host/intime/queues, /api/host/intime/bookings, ...
// Public: /api/intime/queues/:id, /api/intime/queues/:id/book
app.use('/api', intimeHostRoutes);

// Misc: /api/ping, /api/logout, /dashboard, /api/me, /api/hosts
app.use(miscRoutes);

// ---- Fallback route (SPA-style) ----
app.get('*', (req, res) => {
  // Unknown API endpoints → 404 JSON
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Anything else → front-end index.html
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---- Start server after DB init ----
(async () => {
  try {
    await initDB(); // sets up schema, migrations, etc.

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`WanderPal server listening on port ${PORT}`);
      if (!IS_PROD) {
        console.log(`Public dir: ${PUBLIC_DIR}`);
      }
    });
  } catch (err) {
    console.error('DB init failed:', err);
    process.exit(1);
  }
})();
