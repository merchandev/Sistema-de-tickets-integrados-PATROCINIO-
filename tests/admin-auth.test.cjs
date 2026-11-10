const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Own empty database and test-only credentials for this run.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "entradas-auth-"));
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASSWORD = "clave-de-prueba-123";
const auth = require("../sistema-central/src/adminAuth");

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}
const req = (body, ip = "203.0.113.7") => ({ body, ip, headers: { "x-forwarded-proto": "https" }, secure: false });

test("passwords are stored as salted scrypt hashes", () => {
  const stored = auth.hashPassword("una-clave-larga");
  assert.match(stored, /^scrypt\$/);
  assert.notEqual(stored, auth.hashPassword("una-clave-larga"));
  assert.equal(auth.verifyPassword("una-clave-larga", stored), true);
  assert.equal(auth.verifyPassword("otra-clave", stored), false);
});

test("sign-in sets a secure session cookie that opens the dashboard", () => {
  const res = fakeRes();
  auth.login(req({ username: "admin", password: "clave-de-prueba-123", next: "/admin/?verifyToken=TK-1" }), res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.next, "/admin/?verifyToken=TK-1");
  const cookie = res.headers["Set-Cookie"];
  assert.match(cookie, /^admin_session=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
  const session = auth.sessionFrom({ headers: { cookie: cookie.split(";")[0] } });
  assert.equal(session.user, "admin");
});

test("only the saved account works once it replaces the initial one", () => {
  assert.equal(auth.checkCredentials("admin", "clave-de-prueba-123"), true);
  const res = fakeRes();
  auth.changeAccount({ adminUser: "admin", headers: {}, body: { current_password: "mal", new_user: "x@y.test", new_password: "nueva-clave-456" } }, res);
  assert.equal(res.statusCode, 403);
  auth.changeAccount({ adminUser: "admin", headers: {}, body: { current_password: "clave-de-prueba-123", new_user: " Soporte@Ejemplo.test ", new_password: "nueva-clave-456" } }, res);
  assert.equal(res.body.user, "soporte@ejemplo.test");
  assert.equal(auth.checkCredentials("SOPORTE@ejemplo.test", "nueva-clave-456"), true);
  assert.equal(auth.checkCredentials("admin", "clave-de-prueba-123"), false);
});

test("after signing in it only returns to the dashboard, its files or a QR link", () => {
  assert.equal(auth.safeNext("/storage/tickets/ENTRADA-001.pdf"), "/storage/tickets/ENTRADA-001.pdf");
  assert.equal(auth.safeNext("/verify/TK-001"), "/verify/TK-001");
  assert.equal(auth.safeNext("https://ejemplo.test/admin"), "/admin/");
  assert.equal(auth.safeNext("//ejemplo.test/admin"), "/admin/");
  assert.equal(auth.safeNext("/administrar"), "/admin/");
});

test("repeated wrong passwords are locked out for a while", () => {
  let res;
  for (let i = 0; i < 8; i++) {
    res = fakeRes();
    auth.login(req({ username: "soporte@ejemplo.test", password: "incorrecta" }, "198.51.100.9"), res);
    assert.equal(res.statusCode, 401);
  }
  res = fakeRes();
  auth.login(req({ username: "soporte@ejemplo.test", password: "nueva-clave-456" }, "198.51.100.9"), res);
  assert.equal(res.statusCode, 429);
});

// --- Named users: one superadmin that cannot be deleted, admins with full access ---
const { db } = require("../sistema-central/src/db");
const signIn = (username, password, ip) => {
  const res = fakeRes();
  auth.login(req({ username, password }, ip), res);
  return { res, cookie: res.headers["Set-Cookie"]?.split(";")[0] };
};
const as = (cookie, extra = {}) => {
  const session = auth.sessionFrom({ headers: { cookie } });
  return { headers: { cookie }, admin: session?.admin, adminUser: session?.user, params: {}, body: {}, ...extra };
};
const basicReq = (user, password) => ({ headers: { authorization: "Basic " + Buffer.from(`${user}:${password}`).toString("base64") }, method: "GET", originalUrl: "/api/admin/overview" });

let initialCookie;
test("the first user ends the initial account on the sign-in page and its sessions", () => {
  initialCookie = signIn("soporte@ejemplo.test", "nueva-clave-456", "192.0.2.1").cookie;
  assert.equal(auth.sessionFrom({ headers: { cookie: initialCookie } }).admin.role, "initial");
  const created = auth.createUser({ email: " Jefe@Ejemplo.test ", password: "clave-super-789", role: "superadmin", createdBy: "consola" });
  assert.equal(created.ok, true);
  assert.equal(created.user.email, "jefe@ejemplo.test");
  assert.equal(auth.sessionFrom({ headers: { cookie: initialCookie } }), null);
  assert.equal(signIn("soporte@ejemplo.test", "nueva-clave-456", "192.0.2.1").res.statusCode, 401);
  assert.equal(signIn("admin", "clave-de-prueba-123", "192.0.2.1").res.statusCode, 401);
  const { res, cookie } = signIn("JEFE@ejemplo.test", "clave-super-789", "192.0.2.1");
  assert.equal(res.body.ok, true);
  assert.deepEqual({ ...auth.sessionFrom({ headers: { cookie } }).admin }, { id: created.user.id, email: "jefe@ejemplo.test", role: "superadmin" });
});

test("the environment account keeps working over HTTP Basic for scripts only", () => {
  let reqSeen;
  auth.requireAdmin(Object.assign(basicReq("admin", "clave-de-prueba-123"), {}), fakeRes(), function next() { reqSeen = true; });
  assert.equal(reqSeen, true);
  const scripted = basicReq("admin", "clave-de-prueba-123");
  auth.requireAdmin(scripted, fakeRes(), () => {});
  assert.equal(scripted.admin.role, "service");
  const res = fakeRes();
  auth.requireAdmin(basicReq("admin", "otra"), res, () => assert.fail("must not pass"));
  assert.equal(res.statusCode, 401);
  const change = fakeRes();
  auth.changeAccount({ ...scripted, body: { current_password: "clave-de-prueba-123", new_password: "x".repeat(10) } }, change);
  assert.equal(change.statusCode, 403);
});

test("there is a single superadmin and it cannot be deleted or demoted", () => {
  assert.equal(auth.createUser({ email: "otro@ejemplo.test", password: "clave-otra-123", role: "superadmin" }).status, 409);
  const superId = db.prepare("SELECT id FROM admin_users WHERE role = 'superadmin'").get().id;
  assert.throws(() => db.prepare("DELETE FROM admin_users WHERE id = ?").run(superId), /no se puede eliminar/);
  assert.throws(() => db.prepare("UPDATE admin_users SET role = 'admin' WHERE id = ?").run(superId), /no puede perder su rol/);
  const adminCookie = (() => {
    auth.createUser({ email: "admin@ejemplo.test", password: "clave-admin-123", role: "admin", createdBy: "jefe@ejemplo.test" });
    return signIn("admin@ejemplo.test", "clave-admin-123", "192.0.2.2").cookie;
  })();
  for (const [route, extra] of [[auth.deleteUserRoute, {}], [auth.resetPasswordRoute, { body: { password: "clave-nueva-999" } }]]) {
    const res = fakeRes();
    route(as(adminCookie, { params: { id: String(superId) }, ...extra }), res);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(auth.checkCredentials("jefe@ejemplo.test", "clave-super-789"), true);
});

test("only the superadmin creates, resets and deletes admins; admins only read the list", () => {
  const adminCookie = signIn("admin@ejemplo.test", "clave-admin-123", "192.0.2.3").cookie;
  const superCookie = signIn("jefe@ejemplo.test", "clave-super-789", "192.0.2.3").cookie;
  const me = auth.sessionFrom({ headers: { cookie: adminCookie } }).admin;
  let res = fakeRes();
  auth.createUserRoute(as(adminCookie, { body: { email: "nuevo@ejemplo.test", password: "clave-nuevo-123" } }), res);
  assert.equal(res.statusCode, 403);
  res = fakeRes();
  auth.createUserRoute(as(superCookie, { body: { email: "nuevo@ejemplo.test", password: "corta" } }), res);
  assert.equal(res.statusCode, 400);
  res = fakeRes();
  auth.createUserRoute(as(superCookie, { body: { email: "nuevo@ejemplo.test", password: "clave-nuevo-123", role: "superadmin" } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.user.role, "admin");
  res = fakeRes();
  auth.createUserRoute(as(superCookie, { body: { email: "NUEVO@ejemplo.test", password: "clave-nuevo-123" } }), res);
  assert.equal(res.statusCode, 409);

  const newId = db.prepare("SELECT id FROM admin_users WHERE email = 'nuevo@ejemplo.test'").get().id;
  for (const route of [auth.deleteUserRoute, auth.resetPasswordRoute]) {
    res = fakeRes();
    route(as(adminCookie, { params: { id: String(newId) }, body: { password: "clave-ajena-1" } }), res);
    assert.equal(res.statusCode, 403);
  }
  const newCookie = signIn("nuevo@ejemplo.test", "clave-nuevo-123", "192.0.2.3").cookie;
  res = fakeRes();
  auth.resetPasswordRoute(as(superCookie, { params: { id: String(newId) }, body: { password: "clave-cambiada-1" } }), res);
  assert.equal(res.body.ok, true);
  assert.equal(auth.sessionFrom({ headers: { cookie: newCookie } }), null);
  assert.equal(auth.checkCredentials("nuevo@ejemplo.test", "clave-cambiada-1"), true);

  const lateCookie = signIn("nuevo@ejemplo.test", "clave-cambiada-1", "192.0.2.3").cookie;
  res = fakeRes();
  auth.deleteUserRoute(as(superCookie, { params: { id: String(newId) } }), res);
  assert.equal(res.body.ok, true);
  assert.equal(auth.sessionFrom({ headers: { cookie: lateCookie } }), null);
  assert.equal(auth.checkCredentials("nuevo@ejemplo.test", "clave-cambiada-1"), false);

  res = fakeRes();
  auth.deleteUserRoute(as(adminCookie, { params: { id: String(me.id) } }), res);
  assert.equal(res.statusCode, 403);
  res = fakeRes();
  auth.listUsersRoute(as(adminCookie), res);
  assert.deepEqual(res.body.users.map(u => [u.email, u.role]), [["jefe@ejemplo.test", "superadmin"], ["admin@ejemplo.test", "admin"]]);
  assert.ok(res.body.users.every(u => !("password_hash" in u)));
});

test("users change their own password with the current one; the superadmin too", () => {
  const first = signIn("jefe@ejemplo.test", "clave-super-789", "192.0.2.4").cookie;
  const second = signIn("jefe@ejemplo.test", "clave-super-789", "192.0.2.4").cookie;
  let res = fakeRes();
  auth.changeAccount(as(first, { body: { current_password: "mal", new_password: "clave-super-nueva" } }), res);
  assert.equal(res.statusCode, 403);
  res = fakeRes();
  auth.changeAccount(as(first, { body: { current_password: "clave-super-789", new_password: "clave-super-nueva" } }), res);
  assert.equal(res.body.ok, true);
  assert.ok(auth.sessionFrom({ headers: { cookie: first } }));
  assert.equal(auth.sessionFrom({ headers: { cookie: second } }), null);
  assert.equal(auth.checkCredentials("jefe@ejemplo.test", "clave-super-nueva"), true);
  assert.equal(auth.checkCredentials("jefe@ejemplo.test", "clave-super-789"), false);
});
