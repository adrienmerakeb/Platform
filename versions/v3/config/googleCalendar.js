// config/googleCalendar.js
// Google Calendar OAuth2 client used for host calendar sync

import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config();

const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'http://localhost:3000';

// You can reuse GOOGLE_CLIENT_ID/SECRET if you prefer
export const GOOGLE_CALENDAR_CLIENT_ID =
  process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';

export const GOOGLE_CALENDAR_CLIENT_SECRET =
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET ||
  process.env.GOOGLE_CLIENT_SECRET ||
  '';

export const GOOGLE_CALENDAR_REDIRECT_URL =
  process.env.GOOGLE_CALENDAR_REDIRECT_URL ||
  `${OAUTH_BASE_URL}/api/host/calendar/google/callback`;

// Single shared OAuth2 client instance (or null if not configured)
export const googleOAuth2Client =
  GOOGLE_CALENDAR_CLIENT_ID && GOOGLE_CALENDAR_CLIENT_SECRET
    ? new google.auth.OAuth2(
        GOOGLE_CALENDAR_CLIENT_ID,
        GOOGLE_CALENDAR_CLIENT_SECRET,
        GOOGLE_CALENDAR_REDIRECT_URL
      )
    : null;

// Helper so other modules can request it in a consistent way
export function getGoogleOAuth2Client() {
  return googleOAuth2Client;
}

// Small helper if you need to check config elsewhere
export const hasGoogleCalendarConfig = !!googleOAuth2Client;

// Re-export google so callers can do:
//   import { google } from '../config/googleCalendar.js';
export { google };
