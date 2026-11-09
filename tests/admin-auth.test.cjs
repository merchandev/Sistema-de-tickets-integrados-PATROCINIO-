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
