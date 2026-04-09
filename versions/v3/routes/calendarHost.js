// routes/calendarHost.js
// Host Calendar Sync - Google OAuth2

import express from 'express';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';

import { authRequired, hostRequired, getHostId } from '../middleware/auth.js';
import { googleOAuth2Client } from '../config/googleCalendar.js';
import {
  upsertCalendarConnection,
  getHostCalendarConnection
} from '../lib/calendarConnections.js';

const router = express.Router();

const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// If Google OAuth client is not configured, just log and expose minimal errors
if (!googleOAuth2Client) {
  console.log(
    '[Calendar] Google Calendar OAuth not configured (missing env vars).'
  );
}

/**
 * GET /api/host/calendar/google/start
 * Start OAuth for the current host; returns the Google auth URL.
 */
router.get(
  '/host/calendar/google/start',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      if (!googleOAuth2Client) {
        return res
          .status(503)
          .json({ error: 'Google Calendar not configured on server' });
      }

      const hostId = getHostId(req);
      if (!hostId) {
        return res.status(401).json({ error: 'Host not resolved from token' });
      }

      const state = jwt.sign(
        { hostId, kind: 'calendar-google' },
        JWT_SECRET,
        { expiresIn: '15m' }
      );

      const url = googleOAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [
          'https://www.googleapis.com/auth/calendar.events',
          'https://www.googleapis.com/auth/calendar.readonly',
          'openid',
          'email'
        ],
        state
      });

      return res.json({ ok: true, authUrl: url });
    } catch (e) {
      console.error('[Calendar] start error:', e);
      return res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
);

/**
 * GET /api/host/calendar/google/callback
 * OAuth callback from Google → stores tokens for the host.
 *
 * This route is *not* behind auth; we trust the signed `state` parameter.
 */
router.get('/host/calendar/google/callback', async (req, res) => {
  try {
    if (!googleOAuth2Client) {
      return res.status(503).send('Google Calendar not configured.');
    }

    const { code, state } = req.query || {};
    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }

    let decoded;
    try {
      decoded = jwt.verify(String(state), JWT_SECRET);
    } catch {
      return res.status(400).send('Invalid state');
    }

    if (!decoded || decoded.kind !== 'calendar-google' || !decoded.hostId) {
      return res.status(400).send('Invalid state payload');
    }

    const hostId = decoded.hostId;

    // Exchange code for tokens
    const { tokens } = await googleOAuth2Client.getToken(String(code));
    googleOAuth2Client.setCredentials(tokens);

    // Fetch account email for info
    const oauth2 = google.oauth2({
      auth: googleOAuth2Client,
      version: 'v2'
    });
    const me = await oauth2.userinfo.get();
    const email = me.data?.email || null;
    const externalId = me.data?.id || null;

    await upsertCalendarConnection({
      hostId,
      provider: 'google',
      externalId,
      email,
      token: tokens
    });

    const redirectUrl = `${OAUTH_BASE_URL}/modules/InTime/manage/ManageVirtualQueues.html?calendar=google&status=connected`;
    return res.redirect(redirectUrl);
  } catch (e) {
    console.error('[Calendar] callback error:', e);
    return res.status(500).send('Calendar connection failed.');
  }
});

/**
 * GET /api/host/calendar/status
 * Returns which calendar providers are connected for this host.
 */
router.get(
  '/host/calendar/status',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      const hostId = getHostId(req);
      const googleConn = await getHostCalendarConnection(hostId, 'google');

      res.json({
        ok: true,
        providers: {
          google: !!googleConn
        }
      });
    } catch (e) {
      console.error('[Calendar] status error:', e);
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
);

/**
 * POST /api/host/calendar/google/test-event
 * Simple helper to insert a test event in the host's Google Calendar.
 *
 * Body:
 * {
 *   startIso: "2025-01-01T10:00:00.000Z",
 *   endIso:   "2025-01-01T10:30:00.000Z",
 *   summary?: "Custom summary",
 *   description?: "Custom description"
 * }
 */
router.post(
  '/host/calendar/google/test-event',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      if (!googleOAuth2Client) {
        return res
          .status(503)
          .json({ error: 'Google Calendar not configured on server' });
      }

      const hostId = getHostId(req);
      const conn = await getHostCalendarConnection(hostId, 'google');
      if (!conn) {
        return res.status(400).json({ error: 'NO_CONNECTION' });
      }

      googleOAuth2Client.setCredentials({
        access_token: conn.access_token,
        refresh_token: conn.refresh_token,
        expiry_date: conn.expiry_date,
        token_type: conn.token_type
      });

      const calendar = google.calendar({
        version: 'v3',
        auth: googleOAuth2Client
      });

      const {
        summary = 'In-Time test booking',
        description = 'Test event created from In-Time integration.',
        startIso,
        endIso
      } = req.body || {};

      if (!startIso || !endIso) {
        return res
          .status(400)
          .json({ error: 'Missing startIso or endIso' });
      }

      const event = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary,
          description,
          start: { dateTime: startIso },
          end: { dateTime: endIso }
        }
      });

      res.json({ ok: true, eventId: event.data.id });
    } catch (e) {
      console.error('[Calendar] test-event error:', e);
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
);

export default router;
