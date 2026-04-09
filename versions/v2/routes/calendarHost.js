// routes/calendarHost.js
import { authRequired, hostRequired, getHostId } from '../middleware/auth.js';
import { googleOAuth2Client, google, JWT_SECRET, OAUTH_BASE_URL } from '../config/googleCalendar.js';
import { upsertCalendarConnection, getHostCalendarConnection } from '../lib/calendarConnections.js';
import jwt from 'jsonwebtoken';

export function registerCalendarHostRoutes(app) {
  if (!googleOAuth2Client) {
    console.log('[Calendar] Google Calendar OAuth not configured (missing env vars).');
    return;
  }

  // 1) Start OAuth for current host
  app.get(
    '/api/host/calendar/google/start',
    authRequired,
    hostRequired,
    async (req, res) => {
      try {
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

  // 2) OAuth callback
  app.get('/api/host/calendar/google/callback', async (req, res) => {
    try {
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

      const { tokens } = await googleOAuth2Client.getToken(String(code));
      googleOAuth2Client.setCredentials(tokens);

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

      const redirectUrl = `${OAUTH_BASE_URL}/modules/In-Time/manage/page%202.html?calendar=google&status=connected`;
      return res.redirect(redirectUrl);
    } catch (e) {
      console.error('[Calendar] callback error:', e);
      return res.status(500).send('Calendar connection failed.');
    }
  });

  // 3) Status endpoint for UI
  app.get(
    '/api/host/calendar/status',
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

  // 4) Test event
  app.post(
    '/api/host/calendar/google/test-event',
    authRequired,
    hostRequired,
    async (req, res) => {
      try {
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
          return res.status(400).json({ error: 'Missing startIso or endIso' });
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
}
