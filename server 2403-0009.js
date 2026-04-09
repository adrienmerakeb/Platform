// server.js — bootstrap + wiring for routes/config

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';

// Ensure DB + mailer are initialized (side effects)
import './config/db.js';
import './config/mailer.js';

// Routers
import authVisitorRoutes from './routes/authVisitor.js';
import authHostRoutes from './routes/authHost.js';
import authPartnerRoutes from './routes/authPartner.js';
import oauthVisitorRoutes from './routes/oauthVisitor.js';
import servicesRoutes from './routes/services.js';
import intimeHostRoutes from './routes/intimeHost.js';
import adminRoutes from './routes/admin.js';
import miscRoutes from './routes/misc.js';
import calendarHostRoutes from './routes/calendarHost.js'; // Host calendar (Google, etc.)

// Let's Get Out! manage-side API
import letsGetOutRoutes from './routes/letsgetout.js';

dotenv.config();

// ---- Paths ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MODULES_ROOT = path.join(PUBLIC_DIR, 'modules');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// ---- App ----
const app = express();

// Core middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());

// Static assets
app.use(express.static(PUBLIC_DIR));
app.use('/modules', express.static(MODULES_ROOT));

// Uploaded files (audio, images, etc.)
app.use('/uploads', express.static(UPLOADS_DIR));

// Debug logs for host/partner APIs
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/host/')) {
    console.log('[HOST API]', req.method, req.path, 'CT:', req.headers['content-type']);
  }
  if (req.path.startsWith('/api/partner/')) {
    console.log('[PARTNER API]', req.method, req.path, 'CT:', req.headers['content-type']);
  }
  next();
});

// ---- Routes wiring ----

// Auth (local) – visitors/hosts/partners
app.use('/api', authVisitorRoutes);   // /api/register, /api/login, etc.
app.use('/api', authHostRoutes);      // /api/host/...
app.use('/api', authPartnerRoutes);   // /api/partner/...

// OAuth – Google/Apple/Facebook/Twitter for visitors
app.use('/', oauthVisitorRoutes);

// Role-aware services dashboard (/api/services)
app.use('/api', servicesRoutes);

// In-Time queues & bookings (/api/intime/...)
app.use('/api', intimeHostRoutes);

// Let's Get Out! host/manage APIs (/api/letsgetout/...)
app.use('/api/letsgetout', letsGetOutRoutes);

// Calendar integration for HOSTS (/api/host/calendar/...)
app.use('/api', calendarHostRoutes);

// Admin APIs (/api/admin/...)
app.use('/api', adminRoutes);

// Misc: /dashboard, /api/me, /api/logout, /api/host/me, /api/partner/me
app.use('/', miscRoutes);

// -----------------------------------------------------------------------------
// Fallback HTML (for non-API routes → send SPA shell / index.html)
// -----------------------------------------------------------------------------
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

export default app;
