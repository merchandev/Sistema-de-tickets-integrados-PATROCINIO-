// Sign-in for the dashboard shared by both sites.
// Named users (admin_users): one superadmin, who cannot be deleted, and any number of admins. Admins run
// the daily work (payments, access control, blog, sponsors) and change their own password; the
// superadmin also manages users and the sensitive configuration (see server.js). Passwords are salted
// scrypt hashes.
// Until the first user exists, the initial account still signs in: the one saved from the panel or,
// until one is saved, ADMIN_USER / ADMIN_PASSWORD. Once users exist, ADMIN_USER / ADMIN_PASSWORD only
// work over HTTP Basic, for the verification scripts, and never on the sign-in page.
// Sessions are random tokens stored as SHA-256 in SQLite, so they survive restarts.
const crypto = require('node:crypto');
const { db, getAllSettings, updateSettings } = require('./db');

const COOKIE = 'admin_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const ROLES = { superadmin: 'Superadministrador', admin: 'Administrador' };

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('superadmin', 'admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    last_login_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS admin_users_single_superadmin ON admin_users(role) WHERE role = 'superadmin';
  CREATE TRIGGER IF NOT EXISTS admin_users_keep_superadmin BEFORE DELETE ON admin_users
    WHEN OLD.role = 'superadmin'
    BEGIN SELECT RAISE(ABORT, 'El superadministrador no se puede eliminar.'); END;
  CREATE TRIGGER IF NOT EXISTS admin_users_keep_superadmin_role BEFORE UPDATE OF role ON admin_users
    WHEN OLD.role = 'superadmin' AND NEW.role <> 'superadmin'
    BEGIN SELECT RAISE(ABORT, 'El superadministrador no puede perder su rol.'); END;
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('admin_sessions') WHERE name = 'user_id'").get()) {
  db.exec('ALTER TABLE admin_sessions ADD COLUMN user_id INTEGER');
}

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
// Checked when the email is unknown, so an unknown email takes as long as a wrong password
const UNKNOWN_USER_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const validEmail = (email) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
function passwordProblem(password) {
  const length = String(password ?? '').length;
  if (length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (length > 200) return 'La contraseña es demasiado larga.';
  return null;
}
const hasUsers = () => Boolean(db.prepare('SELECT 1 FROM admin_users LIMIT 1').get());
const userById = (id) => db.prepare('SELECT id, email, role FROM admin_users WHERE id = ?').get(id);

// --- Initial account (only while no user exists) and service account (HTTP Basic for scripts) ---
function initialAccountName() {
  const s = getAllSettings();
  return s.admin_password_hash ? s.admin_user : (process.env.ADMIN_USER || 'admin');
}
function checkInitialAccount(user, password) {
  const s = getAllSettings();
  // Both comparisons always run, so the time taken does not reveal which one failed
  const userOk = safeEqual(normalizeEmail(user), String(initialAccountName()).toLowerCase());
  const passwordOk = s.admin_password_hash ? verifyPassword(password, s.admin_password_hash) : safeEqual(password, process.env.ADMIN_PASSWORD);
  return userOk && passwordOk;
}
function checkServiceAccount(user, password) {
  const userOk = safeEqual(normalizeEmail(user), String(process.env.ADMIN_USER || 'admin').toLowerCase());
  const passwordOk = Boolean(process.env.ADMIN_PASSWORD) && safeEqual(password, process.env.ADMIN_PASSWORD);
  return userOk && passwordOk;
}

/** Returns { id, email, role } for valid credentials, or null. `id` is null for the initial account. */
function authenticate(user, password) {
  if (!hasUsers()) return checkInitialAccount(user, password) ? { id: null, email: initialAccountName(), role: 'initial' } : null;
  const row = db.prepare('SELECT id, email, role, password_hash FROM admin_users WHERE email = ?').get(normalizeEmail(user));
  const ok = verifyPassword(password, row ? row.password_hash : UNKNOWN_USER_HASH);
  return row && ok ? { id: row.id, email: row.email, role: row.role } : null;
}
const checkCredentials = (user, password) => Boolean(authenticate(user, password));

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
  const row = db.prepare('SELECT user, user_id, expires_at FROM admin_sessions WHERE token_hash = ?').get(tokenHash);
  if (!row || row.expires_at <= Date.now()) return null;
  if (row.user_id == null) {
    // A session of the initial account ends as soon as the first user is created
    return hasUsers() ? null : { user: row.user, tokenHash, admin: { id: null, email: row.user, role: 'initial' } };
  }
  const user = userById(row.user_id);
  return user ? { user: user.email, tokenHash, admin: user } : null;
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
  const admin = authenticate(username, password);
  if (!admin) {
    recordFailure(ip);
    return res.status(401).json({ ok: false, message: 'Correo o contraseña incorrectos.' });
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO admin_sessions (token_hash, user, user_id, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), admin.email, admin.id, Date.now() + SESSION_MS);
  if (admin.id) db.prepare('UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(admin.id);
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
  let admin = session?.admin;
  const basic = !admin && /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (basic) {
    const raw = Buffer.from(basic[1], 'base64').toString();
    const i = raw.indexOf(':');
    if (i > 0) {
      const [user, password] = [raw.slice(0, i), raw.slice(i + 1)];
      admin = authenticate(user, password) || (checkServiceAccount(user, password) ? { id: null, email: String(process.env.ADMIN_USER || 'admin'), role: 'service' } : null);
    }
  }
  if (admin) {
    req.admin = admin;
    req.adminUser = admin.email;
    return next();
  }
  if (req.method === 'GET' && !req.originalUrl.startsWith('/api/')) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  return res.status(401).json({ ok: false, message: 'Tu sesión expiró. Inicia sesión de nuevo.' });
}

function closeOtherSessions(req, userId) {
  const current = sessionFrom(req);
  db.prepare('DELETE FROM admin_sessions WHERE user_id = ? AND token_hash != ?').run(userId, current ? current.tokenHash : '');
}

/**
 * The signed-in user's own password (needs the current one); other sessions of that user are closed.
 * For the initial account it still replaces user and password, as before users existed.
 */
function changeAccount(req, res) {
  const { current_password, new_user, new_password } = req.body || {};
  const admin = req.admin || { id: null, email: req.adminUser, role: 'initial' };
  if (admin.role === 'service') return res.status(403).json({ ok: false, message: 'Esta cuenta solo la usan los scripts de verificación.' });
  const problem = passwordProblem(new_password);

  if (admin.id) {
    const row = db.prepare('SELECT password_hash FROM admin_users WHERE id = ?').get(admin.id);
    if (!row || !verifyPassword(current_password, row.password_hash)) return res.status(403).json({ ok: false, field: 'current_password', message: 'La contraseña actual no es correcta.' });
    if (problem) return res.status(400).json({ ok: false, field: 'new_password', message: problem });
    db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), admin.id);
    closeOtherSessions(req, admin.id);
    return res.json({ ok: true, user: admin.email, message: 'Contraseña actualizada. Se cerraron tus otras sesiones abiertas.' });
  }

  if (!checkInitialAccount(admin.email, current_password)) return res.status(403).json({ ok: false, field: 'current_password', message: 'La contraseña actual no es correcta.' });
  const user = normalizeEmail(new_user);
  if (user.length < 3 || user.length > 254 || /\s/.test(user)) return res.status(400).json({ ok: false, field: 'new_user', message: 'Escribe un usuario o correo válido, sin espacios.' });
  if (problem) return res.status(400).json({ ok: false, field: 'new_password', message: problem });
  updateSettings({ admin_user: user, admin_password_hash: hashPassword(new_password) });
  const current = sessionFrom(req);
  db.prepare('DELETE FROM admin_sessions WHERE token_hash != ?').run(current ? current.tokenHash : '');
  if (current) db.prepare('UPDATE admin_sessions SET user = ? WHERE token_hash = ?').run(user, current.tokenHash);
  return res.json({ ok: true, user, message: 'Usuario y contraseña actualizados. Úsalos la próxima vez que inicies sesión.' });
}

// --- Users (shared by the panel and the console command in usuarios.js) ---
function createUser({ email, password, role = 'admin', createdBy = null }) {
  const address = normalizeEmail(email);
  if (!validEmail(address)) return { ok: false, status: 400, field: 'email', message: 'Escribe un correo válido.' };
  if (!Object.hasOwn(ROLES, role)) return { ok: false, status: 400, message: 'El rol debe ser superadmin o admin.' };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, status: 400, field: 'password', message: problem };
  if (db.prepare('SELECT 1 FROM admin_users WHERE email = ?').get(address)) return { ok: false, status: 409, field: 'email', message: `Ya existe un usuario con el correo ${address}.` };
  const superadmin = db.prepare("SELECT email FROM admin_users WHERE role = 'superadmin'").get();
  if (role === 'superadmin' && superadmin) return { ok: false, status: 409, message: `Ya existe un superadministrador (${superadmin.email}).` };
  const info = db.prepare('INSERT INTO admin_users (email, password_hash, role, created_by) VALUES (?, ?, ?, ?)').run(address, hashPassword(password), role, createdBy);
  return { ok: true, user: { id: Number(info.lastInsertRowid), email: address, role } };
}
function setUserPassword(id, password) {
  const problem = passwordProblem(password);
  if (problem) return { ok: false, status: 400, field: 'password', message: problem };
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
  return { ok: true };
}
function deleteUser(id) {
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
  db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
}
function listAllUsers() {
  return db.prepare("SELECT id, email, role, created_at, created_by, last_login_at FROM admin_users ORDER BY role = 'superadmin' DESC, email").all();
}

const fail = (res, { status, ...body }) => res.status(status).json(body);
// Only the superadmin creates, resets or deletes users; admins only change their own password
function namedUser(req, res) {
  if (req.admin?.id && req.admin.role === 'superadmin') return true;
  fail(res, { status: 403, ok: false, message: 'Solo el superadministrador puede administrar los usuarios del panel.' });
  return false;
}
// Target of a change: any admin other than yourself. The superadmin is only changed from its own account.
function targetUser(req, res, action) {
  const target = userById(parseInt(req.params.id, 10));
  if (!target) return fail(res, { status: 404, ok: false, message: 'Ese usuario ya no existe.' }), null;
  if (target.role === 'superadmin') {
    const message = action === 'delete' ? 'El superadministrador no se puede eliminar.' : 'La contraseña del superadministrador solo se cambia desde su propia cuenta.';
    return fail(res, { status: 403, ok: false, message }), null;
  }
  if (target.id === req.admin.id) {
    const message = action === 'delete' ? 'No puedes eliminar tu propio usuario.' : 'Para cambiar tu contraseña usa «Cambiar contraseña» en tu cuenta.';
    return fail(res, { status: 400, ok: false, message }), null;
  }
  return target;
}

function listUsersRoute(req, res) {
  return res.json({ ok: true, me: req.admin, users: listAllUsers() });
}
function createUserRoute(req, res) {
  if (!namedUser(req, res)) return;
  const { email, password } = req.body || {};
  const result = createUser({ email, password, role: 'admin', createdBy: req.admin.email });
  if (!result.ok) return fail(res, result);
  return res.status(201).json({ ok: true, user: result.user, message: `Se creó el administrador ${result.user.email}.` });
}
function resetPasswordRoute(req, res) {
  if (!namedUser(req, res)) return;
  const target = targetUser(req, res, 'password');
  if (!target) return;
  const result = setUserPassword(target.id, (req.body || {}).password);
  if (!result.ok) return fail(res, result);
  return res.json({ ok: true, message: `Se cambió la contraseña de ${target.email}. Sus sesiones abiertas se cerraron.` });
}
function deleteUserRoute(req, res) {
  if (!namedUser(req, res)) return;
  const target = targetUser(req, res, 'delete');
  if (!target) return;
  deleteUser(target.id);
  return res.json({ ok: true, message: `Se eliminó el usuario ${target.email}.` });
}

module.exports = {
  ROLES,
  requireAdmin, login, logout, changeAccount, sessionFrom, safeNext,
  hashPassword, verifyPassword, checkCredentials, authenticate, hasUsers,
  createUser, setUserPassword, deleteUser, listAllUsers, normalizeEmail,
  listUsersRoute, createUserRoute, resetPasswordRoute, deleteUserRoute
};
