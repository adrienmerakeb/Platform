// config/googleCalendar.js
import { google } from 'googleapis';
import { JWT_SECRET } from '../middleware/auth.js';

const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'http://localhost:3000';

export const GOOGLE_CALENDAR_CLIENT_ID =
  process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CALENDAR_CLIENT_SECRET =
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';

export const GOOGLE_CALENDAR_REDIRECT_URL =
  process.env.GOOGLE_CALENDAR_REDIRECT_URL ||
  `${OAUTH_BASE_URL}/api/host/calendar/google/callback`;

export const googleOAuth2Client =
  GOOGLE_CALENDAR_CLIENT_ID && GOOGLE_CALENDAR_CLIENT_SECRET
    ? new google.auth.OAuth2(
        GOOGLE_CALENDAR_CLIENT_ID,
        GOOGLE_CALENDAR_CLIENT_SECRET,
        GOOGLE_CALENDAR_REDIRECT_URL
      )
    : null;

export { google, JWT_SECRET, OAUTH_BASE_URL };
