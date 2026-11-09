// Sign-in for the dashboard shared by both sites.
// Credentials: the account saved from the panel (scrypt hash in settings) or, until one is saved,
// ADMIN_USER / ADMIN_PASSWORD from the environment. Sessions are random tokens stored as SHA-256 in SQLite,
// so they survive restarts. HTTP Basic credentials are still accepted for the verification scripts.
const crypto = require('node:crypto');
const { db, getAllSettings, updateSettings } = require('./db');

const COOKIE = 'admin_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(String(password), salt, 64).toString('base64')}`;
}
function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  return crypto.timingSafeEqual(crypto.scryptSync(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length), expected);
}

function accountUser() {
  const s = getAllSettings();
  return s.admin_password_hash ? s.admin_user : (process.env.ADMIN_USER || 'admin');
}
function checkCredentials(user, password) {
  const s = getAllSettings();
  const name = String(user ?? '').trim().toLowerCase();
  // Both comparisons always run, so the time taken does not reveal which one failed
  const userOk = safeEqual(name, String(accountUser()).toLowerCase());
  const passwordOk = s.admin_password_hash ? verifyPassword(password, s.admin_password_hash) : safeEqual(password, process.env.ADMIN_PASSWORD);
  return userOk && passwordOk;
}

function readCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function sessionFrom(req) {
  const token = readCookie(req);
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = db.prepare('SELECT user, expires_at FROM admin_sessions WHERE token_hash = ?').get(tokenHash);
  return row && row.expires_at > Date.now() ? { user: row.user, tokenHash } : null;
}
function sessionCookie(req, token, maxAgeMs) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
}

// After signing in, only return to the dashboard, its files or a QR verification link.
function safeNext(next) {
  const value = String(next || '');
  return /^\/(admin|storage|verify)(\/|\?|#|$)/.test(value) && !value.startsWith('//') ? value : '/admin/';
}

const failures = new Map(); // ip -> { count, since }
function lockedOut(ip) {
  const entry = failures.get(ip);
  return Boolean(entry && Date.now() - entry.since < LOCKOUT_MS && entry.count >= MAX_FAILURES);
}
function recordFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.since >= LOCKOUT_MS) failures.set(ip, { count: 1, since: Date.now() });
  else entry.count++;
}

function login(req, res) {
  const ip = req.ip;
  if (lockedOut(ip)) return res.status(429).json({ ok: false, message: 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.' });
  const { username, password, next } = req.body || {};
  if (!checkCredentials(username, password)) {
    recordFailure(ip);
    return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos.' });
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO admin_sessions (token_hash, user, expires_at) VALUES (?, ?, ?)').run(sha256(token), accountUser(), Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_MS));
  return res.json({ ok: true, next: safeNext(next) });
}

function logout(req, res) {
  const session = sessionFrom(req);
  if (session) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(session.tokenHash);
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  return res.json({ ok: true });
}

function requireAdmin(req, res, next) {
  const session = sessionFrom(req);
  if (session) {
    req.adminUser = session.user;
    return next();
  }
  const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (basic) {
    const raw = Buffer.from(basic[1], 'base64').toString();
    const i = raw.indexOf(':');
    if (i > 0 && checkCredentials(raw.slice(0, i), raw.slice(i + 1))) {
      req.adminUser = accountUser();
      return next();
    }
  }
  if (req.method === 'GET' && !req.originalUrl.startsWith('/api/')) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  return res.status(401).json({ ok: false, message: 'Tu sesión expiró. Inicia sesión de nuevo.' });
}

// Replaces the account; the session that made the change continues, every other one is closed.
function changeAccount(req, res) {
  const { current_password, new_user, new_password } = req.body || {};
  if (!checkCredentials(req.adminUser, current_password)) return res.status(403).json({ ok: false, field: 'current_password', message: 'La contraseña actual no es correcta.' });
  const user = String(new_user || '').trim().toLowerCase();
  if (user.length < 3 || user.length > 254 || /\s/.test(user)) return res.status(400).json({ ok: false, field: 'new_user', message: 'Escribe un usuario o correo válido, sin espacios.' });
  if (String(new_password || '').length < 8) return res.status(400).json({ ok: false, field: 'new_password', message: 'La contraseña nueva debe tener al menos 8 caracteres.' });
  updateSettings({ admin_user: user, admin_password_hash: hashPassword(new_password) });
  const current = sessionFrom(req);
  db.prepare('DELETE FROM admin_sessions WHERE token_hash != ?').run(current ? current.tokenHash : '');
  if (current) db.prepare('UPDATE admin_sessions SET user = ? WHERE token_hash = ?').run(user, current.tokenHash);
  return res.json({ ok: true, user, message: 'Usuario y contraseña actualizados. Úsalos la próxima vez que inicies sesión.' });
}

module.exports = { requireAdmin, login, logout, changeAccount, sessionFrom, safeNext, hashPassword, verifyPassword, checkCredentials };
