import crypto from 'node:crypto';
import { db, persist } from './store.js';

/**
 * Local admin session for privileged operator commands.
 *
 * The console stays a loopback tool; the admin login gates privileged operator
 * actions and repository relay writes without protecting every read API or
 * breaking the bundled Python clients. Default credentials are printed in the
 * login modal and can be rotated from the same modal.
 */

const COOKIE = 'sightline_sid';
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

export function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

export function verifyPassword(password, salt, expected) {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const target = Buffer.from(String(expected || ''), 'hex');
  if (actual.length !== target.length) return false;
  return crypto.timingSafeEqual(actual, target);
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const out = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function currentAdmin(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { username: session.username, token };
}

export function adminStatus(req) {
  const admin = currentAdmin(req);
  const account = db().admin;
  return {
    ok: true,
    authenticated: Boolean(admin),
    username: admin?.username || null,
    defaultUser: account?.username || 'admin',
    mustChangePassword: Boolean(account?.mustChange),
    authScope: 'operator-commands-and-repository-relay',
  };
}

export function loginAdmin(req, res, username, password) {
  const account = db().admin;
  if (!account) throw new Error('No admin account is configured');
  if (String(username || '').trim() !== account.username) throw new Error('Invalid username or password');
  if (!verifyPassword(password, account.salt, account.hash)) throw new Error('Invalid username or password');
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username: account.username, expiresAt: Date.now() + SESSION_MS });
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`
  );
  return { username: account.username, mustChangePassword: Boolean(account.mustChange) };
}

export function logoutAdmin(req, res) {
  const admin = currentAdmin(req);
  if (admin) sessions.delete(admin.token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  return { ok: true };
}

export function changeAdminPassword(req, current, next) {
  const admin = currentAdmin(req);
  if (!admin) throw new Error('Sign in first');
  const account = db().admin;
  if (!verifyPassword(current, account.salt, account.hash)) throw new Error('Current password is incorrect');
  const password = String(next || '');
  if (password.length < 8) throw new Error('New password needs at least 8 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  account.salt = salt;
  account.hash = hashPassword(password, salt);
  account.mustChange = false;
  account.updatedAt = new Date().toISOString();
  persist();
  return { ok: true };
}
