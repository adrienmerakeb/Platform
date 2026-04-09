// config/microsoftCalendar.js
// Microsoft / Outlook Calendar OAuth2 client for host calendar sync

import dotenv from 'dotenv';
import { ConfidentialClientApplication } from '@azure/msal-node';

dotenv.config();

const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'http://localhost:3000';

// Environment variables you need to define:
//  - MS_CLIENT_ID
//  - MS_CLIENT_SECRET
//  - MS_TENANT_ID (use "common" for multi-tenant or your tenant id)
//  - MS_REDIRECT_URL (optional; falls back to OAUTH_BASE_URL + /api/host/calendar/microsoft/callback)

export const MS_CLIENT_ID = process.env.MS_CLIENT_ID || '';
export const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || '';
export const MS_TENANT_ID = process.env.MS_TENANT_ID || 'common';

export const MS_REDIRECT_URL =
  process.env.MS_REDIRECT_URL ||
  `${OAUTH_BASE_URL}/api/host/calendar/microsoft/callback`;

// Scopes for Microsoft Graph Calendar
// - offline_access: to obtain refresh token
// - Calendars.ReadWrite: read/write events
export const MS_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'https://graph.microsoft.com/User.Read'
];

let msApp = null;

if (MS_CLIENT_ID && MS_CLIENT_SECRET) {
  msApp = new ConfidentialClientApplication({
    auth: {
      clientId: MS_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${MS_TENANT_ID}`,
      clientSecret: MS_CLIENT_SECRET
    }
  });
} else {
  console.log(
    '[Calendar] Microsoft calendar not configured (missing MS_CLIENT_ID / MS_CLIENT_SECRET).'
  );
}

export function getMsConfidentialClient() {
  return msApp;
}
