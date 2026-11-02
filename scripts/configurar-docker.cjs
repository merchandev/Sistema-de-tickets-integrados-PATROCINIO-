const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const file = path.join(__dirname, '..', '.env.docker');
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, `ADMIN_USER=admin\nADMIN_PASSWORD=${crypto.randomBytes(24).toString('hex')}\n`, {mode:0o600});
  console.log('Credenciales creadas en .env.docker');
} else console.log('.env.docker ya existe; se conservan las credenciales.');
const proxyKey = path.join(__dirname, '..', '.web-proxy-key');
if (!fs.existsSync(proxyKey)) fs.writeFileSync(proxyKey, crypto.randomBytes(32).toString('hex'), {mode:0o600});
