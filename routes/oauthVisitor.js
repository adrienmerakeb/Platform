// routes/oauthVisitor.js
// Visitor OAuth: Google, Apple, Facebook, Twitter

import express from 'express';
import dotenv from 'dotenv';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import AppleStrategy from 'passport-apple';
import FacebookStrategy from 'passport-facebook';
import TwitterStrategy from 'passport-twitter-oauth2';
import crypto from 'crypto';

import { getDb } from '../config/db.js';
import {
  hashPassword,
  setLoginCookie,
  getClientIp
} from '../middleware/auth.js';

dotenv.config();

const router = express.Router();
const db = getDb();

const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'http://localhost:3000';

/* -------- Connection logs helper (same pattern everywhere) -------- */

async function safeLog({ userId = null, provider, ip, success = 1 }) {
  try {
    const uid = typeof userId === 'number' ? userId : null;
    await db.run(
      `INSERT INTO connection_logs (user_id, provider, ip, success)
       VALUES (?, ?, ?, ?)`,
      [uid, provider, ip, success]
    );
  } catch (err) {
    console.warn('Connection log failed:', err);
  }
}

/* ---------------- findOrCreateOAuthUser ---------------- */

async function findOrCreateOAuthUser({ provider, providerId, email, name }) {
  const prov = String(provider || '').toLowerCase();
  const pid = String(providerId || '');

  // 1) Existing record with same provider + provider_id
  let user = await db.get(
    'SELECT * FROM users WHERE provider = ? AND provider_id = ?',
    [prov, pid]
  );

  // 2) If not, try by email
  if (!user && email) {
    user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  }

  if (user) {
    // Attach provider if missing on legacy account
    if (!user.provider || !user.provider_id) {
      await db.run(
        'UPDATE users SET provider = ?, provider_id = ? WHERE id = ?',
        [prov, pid, user.id]
      );
      user = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
    }
    return user;
  }

  // 3) Create new visitor with random password
  const randomHash = await hashPassword(
    crypto.randomBytes(16).toString('hex')
  );
  const displayName = name || email || `${prov} user`;

  const result = await db.run(
    `INSERT INTO users (name, email, password_hash, role, status, has_guide_profile, provider, provider_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      displayName,
      email || `${pid}@${prov}.oauth.local`,
      randomHash,
      'visitor',
      'V',
      0,
      prov,
      pid
    ]
  );

  const newUser = await db.get('SELECT * FROM users WHERE id = ?', [
    result.lastID
  ]);
  return newUser;
}

/* ---------------- GOOGLE ---------------- */

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${OAUTH_BASE_URL}/auth/google/callback`
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value || null;
          const name =
            profile.displayName || profile.name?.givenName || null;
          const user = await findOrCreateOAuthUser({
            provider: 'google',
            providerId: profile.id,
            email,
            name
          });
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  // GET /auth/google
  router.get(
    '/auth/google',
    passport.authenticate('google', {
      scope: ['profile', 'email'],
      session: false
    })
  );

  // GET /auth/google/callback
  router.get(
    '/auth/google/callback',
    passport.authenticate('google', {
      failureRedirect: '/?login=failed',
      session: false
    }),
    async (req, res) => {
      const ip = getClientIp(req);
      const user = req.user;
      setLoginCookie(res, user);
      await safeLog({
        userId: user.id,
        provider: 'google-oauth',
        ip,
        success: 1
      });
      res.redirect('/dashboard');
    }
  );
} else {
  console.log('[OAuth] Google not configured (missing env vars).');
}

/* ---------------- APPLE ---------------- */

if (
  process.env.APPLE_CLIENT_ID &&
  process.env.APPLE_TEAM_ID &&
  process.env.APPLE_KEY_ID &&
  process.env.APPLE_PRIVATE_KEY
) {
  passport.use(
    new AppleStrategy(
      {
        clientID: process.env.APPLE_CLIENT_ID,
        teamID: process.env.APPLE_TEAM_ID,
        keyID: process.env.APPLE_KEY_ID,
        privateKeyString: process.env.APPLE_PRIVATE_KEY,
        callbackURL: `${OAUTH_BASE_URL}/auth/apple/callback`
      },
      async (accessToken, refreshToken, idToken, profile, done) => {
        try {
          const email = profile?.email || idToken?.email || null;
          const name = profile?.name || null;
          const user = await findOrCreateOAuthUser({
            provider: 'apple',
            providerId: profile?.id || idToken?.sub || 'unknown',
            email,
            name
          });
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  // GET /auth/apple
  router.get(
    '/auth/apple',
    passport.authenticate('apple', {
      scope: ['name', 'email'],
      session: false
    })
  );

  // POST /auth/apple/callback
  router.post(
    '/auth/apple/callback',
    passport.authenticate('apple', {
      failureRedirect: '/?login=failed',
      session: false
    }),
    async (req, res) => {
      const ip = getClientIp(req);
      const user = req.user;
      setLoginCookie(res, user);
      await safeLog({
        userId: user.id,
        provider: 'apple-oauth',
        ip,
        success: 1
      });
      res.redirect('/dashboard');
    }
  );
} else {
  console.log('[OAuth] Apple not configured (missing env vars).');
}

/* ---------------- FACEBOOK ---------------- */

if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
  passport.use(
    new FacebookStrategy(
      {
        clientID: process.env.FACEBOOK_CLIENT_ID,
        clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
        callbackURL: `${OAUTH_BASE_URL}/auth/facebook/callback`,
        profileFields: ['id', 'displayName', 'emails']
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value || null;
          const name = profile.displayName || null;
          const user = await findOrCreateOAuthUser({
            provider: 'facebook',
            providerId: profile.id,
            email,
            name
          });
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  // GET /auth/facebook
  router.get(
    '/auth/facebook',
    passport.authenticate('facebook', {
      scope: ['email'],
      session: false
    })
  );

  // GET /auth/facebook/callback
  router.get(
    '/auth/facebook/callback',
    passport.authenticate('facebook', {
      failureRedirect: '/?login=failed',
      session: false
    }),
    async (req, res) => {
      const ip = getClientIp(req);
      const user = req.user;
      setLoginCookie(res, user);
      await safeLog({
        userId: user.id,
        provider: 'facebook-oauth',
        ip,
        success: 1
      });
      res.redirect('/dashboard');
    }
  );
} else {
  console.log('[OAuth] Facebook not configured (missing env vars).');
}

/* ---------------- TWITTER (OAuth2) ---------------- */

if (process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET) {
  passport.use(
    new TwitterStrategy(
      {
        clientID: process.env.TWITTER_CLIENT_ID,
        clientSecret: process.env.TWITTER_CLIENT_SECRET,
        callbackURL: `${OAUTH_BASE_URL}/auth/twitter/callback`,
        scope: ['tweet.read', 'users.read']
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value || null;
          const name = profile.displayName || profile.username || null;
          const user = await findOrCreateOAuthUser({
            provider: 'twitter',
            providerId: profile.id,
            email,
            name
          });
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  // GET /auth/twitter
  router.get(
    '/auth/twitter',
    passport.authenticate('twitter', { session: false })
  );

  // GET /auth/twitter/callback
  router.get(
    '/auth/twitter/callback',
    passport.authenticate('twitter', {
      failureRedirect: '/?login=failed',
      session: false
    }),
    async (req, res) => {
      const ip = getClientIp(req);
      const user = req.user;
      setLoginCookie(res, user);
      await safeLog({
        userId: user.id,
        provider: 'twitter-oauth',
        ip,
        success: 1
      });
      res.redirect('/dashboard');
    }
  );
} else {
  console.log('[OAuth] Twitter not configured (missing env vars).');
}

export default router;
