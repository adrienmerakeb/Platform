// config/googleCalendar.js
// Google Calendar OAuth2 client used for host calendar sync

import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config();

/**
 * Normalize a base URL:
 * - trims whitespace
 * - removes trailing slash
 */
function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * Build redirect URL from base + path, unless explicitly overridden.
 */
function resolveRedirectUrl() {
  const explicit = process.env.GOOGLE_CALENDAR_REDIRECT_URL;
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim();
  }

  const base = normalizeBaseUrl(process.env.OAUTH_BASE_URL || 'http://localhost:3000');
  // IMPORTANT: this must match exactly what you register in Google Cloud Console
  return `${base}/api/host/calendar/google/callback`;
}

// Accept either dedicated calendar creds or reuse general Google OAuth creds
export const GOOGLE_CALENDAR_CLIENT_ID =
  (process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '').trim();

export const GOOGLE_CALENDAR_CLIENT_SECRET =
  (process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '').trim();

export const GOOGLE_CALENDAR_REDIRECT_URL = resolveRedirectUrl();

// Single shared OAuth2 client instance (or null if not configured)
export const googleOAuth2Client =
  GOOGLE_CALENDAR_CLIENT_ID && GOOGLE_CALENDAR_CLIENT_SECRET
    ? new google.auth.OAuth2(
        GOOGLE_CALENDAR_CLIENT_ID,
        GOOGLE_CALENDAR_CLIENT_SECRET,
        GOOGLE_CALENDAR_REDIRECT_URL
      )
    : null;

export const hasGoogleCalendarConfig = !!googleOAuth2Client;

/**
 * Helper so other modules can request it in a consistent way.
 */
export function getGoogleOAuth2Client() {
  return googleOAuth2Client;
}

/**
 * Debug helper (safe): prints the redirect URI we actually use.
 * Call it from server.js once at startup if you want.
 */
export function logGoogleCalendarConfig() {
  if (!GOOGLE_CALENDAR_CLIENT_ID || !GOOGLE_CALENDAR_CLIENT_SECRET) {
    console.log('[GoogleCalendar] OAuth NOT configured (missing client id/secret).');
    return;
  }
  console.log('[GoogleCalendar] OAuth configured.');
  console.log('[GoogleCalendar] Redirect URI =', GOOGLE_CALENDAR_REDIRECT_URL);
}

// Re-export google so callers can do:
//   import { google } from '../config/googleCalendar.js';
export { google };
