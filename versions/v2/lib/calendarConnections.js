// lib/calendarConnections.js
import { db } from '../config/db.js';

export async function upsertCalendarConnection({
  hostId,
  provider,
  externalId,
  email,
  token
}) {
  const prov = String(provider || '').toLowerCase();
  const existing = await db.get(
    `SELECT id FROM calendar_connections
     WHERE host_id = ? AND provider = ?`,
    [hostId, prov]
  );

  const tokenType = token?.token_type || null;
  const scope = Array.isArray(token?.scope)
    ? token.scope.join(' ')
    : token?.scope || null;

  const expiryDate = token?.expiry_date ? Number(token.expiry_date) : null;

  if (existing) {
    await db.run(
      `UPDATE calendar_connections
         SET external_id = ?,
             email = ?,
             access_token = ?,
             refresh_token = ?,
             token_type = ?,
             scope = ?,
             expiry_date = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        externalId || null,
        email || null,
        token?.access_token || null,
        token?.refresh_token || null,
        tokenType,
        scope,
        expiryDate,
        existing.id
      ]
    );
    return existing.id;
  }

  const result = await db.run(
    `INSERT INTO calendar_connections
       (host_id, provider, external_id, email,
        access_token, refresh_token, token_type, scope, expiry_date)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      hostId,
      prov,
      externalId || null,
      email || null,
      token?.access_token || null,
      token?.refresh_token || null,
      tokenType,
      scope,
      expiryDate
    ]
  );
  return result.lastID;
}

export async function getHostCalendarConnection(hostId, provider = 'google') {
  const prov = String(provider || '').toLowerCase();
  return db.get(
    `SELECT * FROM calendar_connections
     WHERE host_id = ? AND provider = ?`,
    [hostId, prov]
  );
}
