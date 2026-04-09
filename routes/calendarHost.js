// routes/calendarHost.js
// Host Calendar Sync - Google OAuth2 + Microsoft Graph OAuth2 + availability endpoint
// ✅ Updated: supports returnTo in start routes, carried via signed state, used in callback redirect.

import express from 'express';
import jwt from 'jsonwebtoken';
import https from 'https';
import { URL } from 'url';
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

// Default return page: Page 1, Tab 2 (you requested this)
const DEFAULT_RETURN_TO =
  '/modules/In-Time/manage/page%201.html?tab=2';

// Microsoft OAuth config
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || '';
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || '';
const MS_TENANT_ID = process.env.MS_TENANT_ID || 'common';
const MS_REDIRECT_URL =
  process.env.MS_REDIRECT_URL ||
  `${OAUTH_BASE_URL}/api/host/calendar/microsoft/callback`;

const MS_AUTHORITY = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0`;
const MS_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Calendars.Read'
];

// Logs
if (!googleOAuth2Client) {
  console.log('[Calendar] Google Calendar OAuth not configured (missing env vars).');
}
if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
  console.log('[Calendar] Microsoft Calendar OAuth not configured (missing MS_CLIENT_ID/MS_CLIENT_SECRET).');
}

/* -------------------------------------------------------------------------- */
/* returnTo safety helpers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Accepts:
 *  - relative path starting with "/modules/"
 *  - absolute URL on same origin, with pathname starting "/modules/"
 * Returns a relative "/modules/..." string, or null if invalid.
 */
function normalizeSafeReturnTo(raw) {
  if (!raw) return null;

  const s = String(raw).trim();
  if (!s) return null;

  // Relative path is easiest/safest
  if (s.startsWith('/modules/')) return s;

  // Sometimes front-end may send full URL; only allow same origin
  try {
    const u = new URL(s);
    const base = new URL(OAUTH_BASE_URL);

    const sameOrigin =
      u.protocol === base.protocol &&
      u.hostname === base.hostname &&
      String(u.port || '') === String(base.port || '');

    if (!sameOrigin) return null;

    if (!u.pathname.startsWith('/modules/')) return null;

    // Keep path + query + hash
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

function buildRedirectUrl(returnTo, calendarProvider, status) {
  // returnTo is a relative path+query+hash. We need to add query params safely.
  const abs = new URL(returnTo, OAUTH_BASE_URL);

  abs.searchParams.set('calendar', calendarProvider);
  abs.searchParams.set('status', status);

  return abs.toString();
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers (no extra deps)                                               */
/* -------------------------------------------------------------------------- */

function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function httpsRequest({ url, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const contentType = res.headers['content-type'] || '';
          const isJson = contentType.includes('application/json');

          let parsed = data;
          if (isJson) {
            try {
              parsed = data ? JSON.parse(data) : null;
            } catch {
              parsed = null;
            }
          }

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, data: parsed, raw: data });
          } else {
            const err = new Error(
              (parsed && parsed.error && parsed.error.message) ||
                (parsed && parsed.error_description) ||
                data ||
                `HTTP ${res.statusCode}`
            );
            err.status = res.statusCode;
            err.payload = parsed;
            reject(err);
          }
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function graphGET(path, accessToken, extraHeaders = {}) {
  const { data } = await httpsRequest({
    url: `https://graph.microsoft.com/v1.0${path}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    }
  });
  return data;
}

/* -------------------------------------------------------------------------- */
/* Google helpers                                                             */
/* -------------------------------------------------------------------------- */

async function getHostGoogleClient(hostId) {
  if (!googleOAuth2Client) return null;

  const conn = await getHostCalendarConnection(hostId, 'google');
  if (!conn) return null;

  googleOAuth2Client.setCredentials({
    access_token: conn.access_token,
    refresh_token: conn.refresh_token,
    expiry_date: conn.expiry_date,
    token_type: conn.token_type
  });

  return { oauthClient: googleOAuth2Client };
}

/* -------------------------------------------------------------------------- */
/* Microsoft helpers                                                          */
/* -------------------------------------------------------------------------- */

async function getHostMicrosoftConnectionFresh(hostId) {
  const conn = await getHostCalendarConnection(hostId, 'microsoft');
  if (!conn) return null;

  const expiry = Number(conn.expiry_date || 0);
  const shouldRefresh = expiry && Date.now() > (expiry - 60_000);

  if (!shouldRefresh) return conn;
  if (!conn.refresh_token) return conn;

  const body = formEncode({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: conn.refresh_token,
    redirect_uri: MS_REDIRECT_URL,
    scope: MS_SCOPES.join(' ')
  });

  try {
    const { data } = await httpsRequest({
      url: `${MS_AUTHORITY}/token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!data?.access_token) return conn;

    const refreshedToken = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || conn.refresh_token,
      token_type: data.token_type || 'Bearer',
      expiry_date: Date.now() + (Number(data.expires_in || 3600) * 1000),
      scope: data.scope || null
    };

    await upsertCalendarConnection({
      hostId,
      provider: 'microsoft',
      externalId: conn.external_id || null,
      email: conn.email || null,
      token: refreshedToken
    });

    return {
      ...conn,
      access_token: refreshedToken.access_token,
      refresh_token: refreshedToken.refresh_token,
      token_type: refreshedToken.token_type,
      expiry_date: refreshedToken.expiry_date,
      scope: refreshedToken.scope
    };
  } catch (e) {
    console.error('[Calendar][MS] refresh failed:', e?.message || e);
    return conn;
  }
}

/* -------------------------------------------------------------------------- */
/* Range helper                                                               */
/* -------------------------------------------------------------------------- */

function computeRange(view, refDateStr) {
  const ref = new Date(refDateStr + 'T00:00:00Z');

  if (Number.isNaN(ref.getTime())) {
    const today = new Date();
    const iso = today.toISOString().slice(0, 10);
    return computeRange(view, iso);
  }

  let timeMin, timeMax, startDate, endDate;

  if (view === 'day') {
    const start = new Date(ref);
    const end = new Date(ref);
    end.setUTCDate(end.getUTCDate() + 1);

    timeMin = start.toISOString();
    timeMax = end.toISOString();
    startDate = start.toISOString().slice(0, 10);
    endDate = startDate;
  } else if (view === 'month') {
    const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
    const end = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1));

    timeMin = start.toISOString();
    timeMax = end.toISOString();

    startDate = start.toISOString().slice(0, 10);

    const endMinusOne = new Date(end);
    endMinusOne.setUTCDate(endMinusOne.getUTCDate() - 1);
    endDate = endMinusOne.toISOString().slice(0, 10);
  } else {
    const start = new Date(ref);
    const day = start.getUTCDay();
    const diffToMonday = (day + 6) % 7;
    start.setUTCDate(start.getUTCDate() - diffToMonday);

    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    timeMin = start.toISOString();
    timeMax = end.toISOString();
    startDate = start.toISOString().slice(0, 10);

    const endMinusOne = new Date(end);
    endMinusOne.setUTCDate(endMinusOne.getUTCDate() - 1);
    endDate = endMinusOne.toISOString().slice(0, 10);
  }

  return { timeMin, timeMax, startDate, endDate };
}

/* -------------------------------------------------------------------------- */
/* GOOGLE OAUTH                                                               */
/* -------------------------------------------------------------------------- */

router.get(
  '/host/calendar/google/start',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      if (!googleOAuth2Client) {
        return res.status(503).json({ error: 'Google Calendar not configured on server' });
      }

      const hostId = getHostId(req);
      if (!hostId) return res.status(401).json({ error: 'Host not resolved from token' });

      const safeReturnTo =
        normalizeSafeReturnTo(req.query.returnTo) ||
        DEFAULT_RETURN_TO;

      const state = jwt.sign(
        { hostId, kind: 'calendar-google', returnTo: safeReturnTo },
        JWT_SECRET,
        { expiresIn: '15m' }
      );

      const url = googleOAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [
          // NOTE: for "busy blocks only", readonly is enough.
          'https://www.googleapis.com/auth/calendar.readonly',
          'openid',
          'email'
        ],
        state
      });

      return res.json({ ok: true, authUrl: url });
    } catch (e) {
      console.error('[Calendar] google start error:', e);
      return res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
);

router.get('/host/calendar/google/callback', async (req, res) => {
  try {
    if (!googleOAuth2Client) return res.status(503).send('Google Calendar not configured.');

    const { code, state } = req.query || {};
    if (!code || !state) return res.status(400).send('Missing code or state');

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

    const { tokens } = await googleOAuth2Client.getToken(String(code));
    googleOAuth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ auth: googleOAuth2Client, version: 'v2' });
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

    const safeReturnTo =
      normalizeSafeReturnTo(decoded.returnTo) ||
      DEFAULT_RETURN_TO;

    const redirectUrl = buildRedirectUrl(safeReturnTo, 'google', 'connected');
    return res.redirect(redirectUrl);
  } catch (e) {
    console.error('[Calendar] google callback error:', e);
    return res.status(500).send('Calendar connection failed.');
  }
});

/* -------------------------------------------------------------------------- */
/* MICROSOFT OAUTH                                                            */
/* -------------------------------------------------------------------------- */

router.get(
  '/host/calendar/microsoft/start',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
        return res.status(503).json({ error: 'Microsoft Calendar not configured on server' });
      }

      const hostId = getHostId(req);
      if (!hostId) return res.status(401).json({ error: 'Host not resolved from token' });

      const safeReturnTo =
        normalizeSafeReturnTo(req.query.returnTo) ||
        DEFAULT_RETURN_TO;

      const state = jwt.sign(
        { hostId, kind: 'calendar-microsoft', returnTo: safeReturnTo },
        JWT_SECRET,
        { expiresIn: '15m' }
      );

      const authorizeUrl = new URL(`${MS_AUTHORITY}/authorize`);
      authorizeUrl.searchParams.set('client_id', MS_CLIENT_ID);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('redirect_uri', MS_REDIRECT_URL);
      authorizeUrl.searchParams.set('response_mode', 'query');
      authorizeUrl.searchParams.set('scope', MS_SCOPES.join(' '));
      authorizeUrl.searchParams.set('state', state);
      authorizeUrl.searchParams.set('prompt', 'consent');

      return res.json({ ok: true, authUrl: authorizeUrl.toString() });
    } catch (e) {
      console.error('[Calendar][MS] start error:', e);
      return res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
);

router.get('/host/calendar/microsoft/callback', async (req, res) => {
  try {
    if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
      return res.status(503).send('Microsoft Calendar not configured.');
    }

    const { code, state, error, error_description } = req.query || {};

    if (error) {
      console.error('[Calendar][MS] OAuth error:', error, error_description);
      return res.status(400).send('Microsoft OAuth error.');
    }
    if (!code || !state) return res.status(400).send('Missing code or state');

    let decoded;
    try {
      decoded = jwt.verify(String(state), JWT_SECRET);
    } catch {
      return res.status(400).send('Invalid state');
    }

    if (!decoded || decoded.kind !== 'calendar-microsoft' || !decoded.hostId) {
      return res.status(400).send('Invalid state payload');
    }

    const hostId = decoded.hostId;

    const body = formEncode({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: MS_REDIRECT_URL,
      scope: MS_SCOPES.join(' ')
    });

    const { data } = await httpsRequest({
      url: `${MS_AUTHORITY}/token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!data?.access_token) {
      console.error('[Calendar][MS] token exchange failed:', data);
      return res.status(500).send('Microsoft token exchange failed.');
    }

    const token = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      token_type: data.token_type || 'Bearer',
      expiry_date: Date.now() + (Number(data.expires_in || 3600) * 1000),
      scope: data.scope || null
    };

    let email = null;
    let externalId = null;
    try {
      const me = await graphGET('/me', token.access_token);
      externalId = me?.id || null;
      email = me?.mail || me?.userPrincipalName || null;
    } catch (e) {
      console.warn('[Calendar][MS] unable to fetch /me:', e?.message || e);
    }

    await upsertCalendarConnection({
      hostId,
      provider: 'microsoft',
      externalId,
      email,
      token
    });

    const safeReturnTo =
      normalizeSafeReturnTo(decoded.returnTo) ||
      DEFAULT_RETURN_TO;

    const redirectUrl = buildRedirectUrl(safeReturnTo, 'microsoft', 'connected');
    return res.redirect(redirectUrl);
  } catch (e) {
    console.error('[Calendar][MS] callback error:', e);
    return res.status(500).send('Microsoft calendar connection failed.');
  }
});

/* -------------------------------------------------------------------------- */
/* STATUS                                                                     */
/* -------------------------------------------------------------------------- */

router.get(
  '/host/calendar/status',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      const hostId = getHostId(req);
      const googleConn = await getHostCalendarConnection(hostId, 'google');
      const msConn = await getHostCalendarConnection(hostId, 'microsoft');

      res.json({
        ok: true,
        providers: {
          google: !!googleConn,
          microsoft: !!msConn,
          other: false
        }
      });
    } catch (e) {
      console.error('[Calendar] status error:', e);
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* AVAILABILITY                                                               */
/* -------------------------------------------------------------------------- */

router.get(
  '/host/calendar/availability',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      const provider = String(req.query.provider || 'google').toLowerCase();
      const view = String(req.query.view || 'week').toLowerCase();
      const refDate = String(req.query.date || new Date().toISOString().slice(0, 10));

      const hostId = getHostId(req);
      const { timeMin, timeMax, startDate, endDate } = computeRange(view, refDate);

      if (provider === 'google') {
        const clientInfo = await getHostGoogleClient(hostId);
        if (!clientInfo?.oauthClient) {
          return res.status(400).json({
            ok: false,
            error: 'NO_CONNECTION',
            message: 'Google Calendar is not connected for this host.'
          });
        }

        const calendar = google.calendar({ version: 'v3', auth: clientInfo.oauthClient });
        const fbResponse = await calendar.freebusy.query({
          requestBody: { timeMin, timeMax, items: [{ id: 'primary' }] }
        });

        const data = fbResponse.data || {};
        const primary = data.calendars?.primary || {};
        const busySlots = Array.isArray(primary.busy) ? primary.busy : [];
        const timezone = data.timeZone || primary.timeZone || null;

        return res.json({ ok: true, provider: 'google', view, startDate, endDate, timezone, busySlots });
      }

      if (provider === 'microsoft') {
        if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
          return res.status(503).json({
            ok: false,
            error: 'NOT_CONFIGURED',
            message: 'Microsoft Calendar is not configured on server.'
          });
        }

        const conn = await getHostMicrosoftConnectionFresh(hostId);
        if (!conn?.access_token) {
          return res.status(400).json({
            ok: false,
            error: 'NO_CONNECTION',
            message: 'Microsoft Calendar is not connected for this host.'
          });
        }

        const startDateTime = timeMin;
        const endDateTime = timeMax;

        const data = await graphGET(
          `/me/calendarView?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}&$top=500`,
          conn.access_token
        );

        const items = Array.isArray(data?.value) ? data.value : [];
        const busySlots = items
          .map((ev) => {
            const s = ev?.start?.dateTime;
            const e = ev?.end?.dateTime;
            if (!s || !e) return null;
            return { start: s, end: e };
          })
          .filter(Boolean);

        return res.json({
          ok: true,
          provider: 'microsoft',
          view,
          startDate,
          endDate,
          timezone: null,
          busySlots
        });
      }

      return res.status(400).json({
        ok: false,
        error: 'PROVIDER_NOT_SUPPORTED',
        message: 'Provider not supported.'
      });
    } catch (e) {
      console.error('[Calendar] availability error:', e);
      return res.status(500).json({
        ok: false,
        error: 'SERVER_ERROR',
        message: 'Unable to fetch calendar availability.'
      });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* GOOGLE TEST EVENT (optional legacy)                                         */
/* -------------------------------------------------------------------------- */

router.post(
  '/host/calendar/google/test-event',
  authRequired,
  hostRequired,
  async (req, res) => {
    try {
      if (!googleOAuth2Client) {
        return res.status(503).json({ error: 'Google Calendar not configured on server' });
      }

      const hostId = getHostId(req);
      const conn = await getHostCalendarConnection(hostId, 'google');
      if (!conn) return res.status(400).json({ error: 'NO_CONNECTION' });

      googleOAuth2Client.setCredentials({
        access_token: conn.access_token,
        refresh_token: conn.refresh_token,
        expiry_date: conn.expiry_date,
        token_type: conn.token_type
      });

      const calendar = google.calendar({ version: 'v3', auth: googleOAuth2Client });

      const {
        summary = 'In-Time test booking',
        description = 'Test event created from In-Time integration.',
        startIso,
        endIso
      } = req.body || {};

      if (!startIso || !endIso) return res.status(400).json({ error: 'Missing startIso or endIso' });

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
