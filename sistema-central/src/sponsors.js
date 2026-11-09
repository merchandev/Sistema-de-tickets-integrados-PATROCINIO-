// Sponsor logos for the «Juntos lo hacemos posible» carousel, shared by both sites.
// Up to 30 images, each with an optional name (alt text) and one optional link that opens in a new tab.
// Images live in <storage>/patrocinadores and are served publicly; the list is public, changes need the panel.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');

const MAX_SPONSORS = 30;
const MAX_BYTES = 5 * 1024 * 1024;
const FILE_RE = /^[a-f0-9-]{36}\.(png|jpg|webp)$/;

function imageExtension(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Normalizes the sponsor link: empty, or an http(s), mailto or tel address. A bare domain such as
 * instagram.com/marca or wa.me/58412... gets https:// in front. Returns { ok, value } or { ok: false, message }.
 */
function normalizeLink(value) {
  let link = String(value ?? '').trim();
  if (!link) return { ok: true, value: '' };
  if (link.length > 500 || /\s/.test(link)) return { ok: false, message: 'El enlace no puede tener espacios ni más de 500 caracteres.' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(link)) link = `https://${link.replace(/^\/+/, '')}`;
  let url;
  try { url = new URL(link); } catch { return { ok: false, message: 'Escribe un enlace válido, por ejemplo https://instagram.com/marca o wa.me/584121234567.' }; }
  if (!['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol)) return { ok: false, message: 'Usa un enlace web (https://), de correo (mailto:) o de teléfono (tel:).' };
  if (/^https?:$/.test(url.protocol) && !url.hostname.includes('.')) return { ok: false, message: 'Escribe un enlace válido, por ejemplo https://instagram.com/marca.' };
  return { ok: true, value: url.href };
}

const cleanName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
const nameFromFile = (filename) => cleanName(path.parse(String(filename || '')).name.replace(/[_-]+/g, ' '));

function registerSponsorRoutes(app, { db, storageDir }) {
  const mediaDir = path.join(storageDir, 'patrocinadores');
  fs.mkdirSync(mediaDir, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS sponsors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      link_url TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const toPublic = (row) => ({ id: row.id, name: row.name, link_url: row.link_url, image_url: `/api/public/sponsors/media/${row.image}` });
  const list = () => db.prepare('SELECT * FROM sponsors ORDER BY position, id').all().map(toPublic);
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM sponsors').get().n;

  // Same-origin check for changes, as in the blog: the panel always sends its own origin
  app.use('/api/admin/sponsors', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.get('origin')) return next();
    try {
      if (new URL(req.get('origin')).host === req.get('host')) return next();
    } catch { /* falls through */ }
    return res.status(403).json({ ok: false, message: 'Origen no permitido.' });
  });

  app.get('/api/public/sponsors', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, sponsors: list() });
  });
  app.get('/api/public/sponsors/media/:file', (req, res) => {
    if (!FILE_RE.test(req.params.file)) return res.sendStatus(404);
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(req.params.file, { root: mediaDir, maxAge: '365d', immutable: true }, (error) => {
      if (error && !res.headersSent) res.sendStatus(404);
    });
  });

  app.get('/api/admin/sponsors', (_req, res) => res.json({ ok: true, max: MAX_SPONSORS, sponsors: list() }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: MAX_SPONSORS } }).array('images', MAX_SPONSORS);
  app.post('/api/admin/sponsors', (req, res) => upload(req, res, (error) => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'Cada imagen puede pesar hasta 5 MB.' : `Puedes subir hasta ${MAX_SPONSORS} imágenes.`;
      return res.status(400).json({ ok: false, message });
    }
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, message: 'Selecciona al menos una imagen PNG, JPG o WebP.' });
    const invalid = files.filter(f => !imageExtension(f.buffer)).map(f => f.originalname);
    if (invalid.length) return res.status(400).json({ ok: false, message: `Solo se aceptan imágenes PNG, JPG o WebP: ${invalid.join(', ')}.` });
    const room = MAX_SPONSORS - count();
    if (files.length > room) {
      return res.status(409).json({ ok: false, message: room > 0 ? `Solo caben ${room} imagen(es) más: el límite es ${MAX_SPONSORS}.` : `Ya hay ${MAX_SPONSORS} imágenes, el máximo. Elimina alguna para subir otra.` });
    }
    const written = [];
    try {
      db.exec('BEGIN IMMEDIATE');
      if (count() + files.length > MAX_SPONSORS) throw Object.assign(new Error('limit'), { status: 409 });
      let position = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM sponsors').get().p;
      const insert = db.prepare('INSERT INTO sponsors (image, name, position) VALUES (?, ?, ?)');
      for (const file of files) {
        const filename = `${crypto.randomUUID()}.${imageExtension(file.buffer)}`;
        fs.writeFileSync(path.join(mediaDir, filename), file.buffer, { flag: 'wx' });
        written.push(filename);
        insert.run(filename, nameFromFile(file.originalname), ++position);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      for (const filename of written) fs.rmSync(path.join(mediaDir, filename), { force: true });
      return res.status(err.status || 500).json({ ok: false, message: err.status ? `El límite es ${MAX_SPONSORS} imágenes.` : 'No se pudieron guardar las imágenes.' });
    }
    return res.status(201).json({ ok: true, message: files.length === 1 ? 'Se subió 1 imagen.' : `Se subieron ${files.length} imágenes.`, sponsors: list() });
  }));

  app.put('/api/admin/sponsors/order', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const current = db.prepare('SELECT id FROM sponsors').all().map(r => r.id);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every(id => current.includes(id))) {
      return res.status(400).json({ ok: false, message: 'El orden no coincide con las imágenes actuales. Recarga la sección.' });
    }
    const update = db.prepare('UPDATE sponsors SET position = ? WHERE id = ?');
    db.exec('BEGIN');
    ids.forEach((id, i) => update.run(i + 1, id));
    db.exec('COMMIT');
    return res.json({ ok: true, sponsors: list() });
  });

  app.put('/api/admin/sponsors/:id', (req, res) => {
    const row = db.prepare('SELECT id FROM sponsors WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ ok: false, message: 'Esa imagen ya no existe.' });
    const link = normalizeLink(req.body?.link_url);
    if (!link.ok) return res.status(400).json({ ok: false, field: 'link_url', message: link.message });
    db.prepare('UPDATE sponsors SET name = ?, link_url = ? WHERE id = ?').run(cleanName(req.body?.name), link.value, row.id);
    return res.json({ ok: true, message: 'Cambios guardados.', sponsors: list() });
  });

  app.delete('/api/admin/sponsors/:id', (req, res) => {
    const row = db.prepare('SELECT id, image FROM sponsors WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ ok: false, message: 'Esa imagen ya no existe.' });
    db.prepare('DELETE FROM sponsors WHERE id = ?').run(row.id);
    if (FILE_RE.test(row.image)) fs.rmSync(path.join(mediaDir, row.image), { force: true });
    return res.json({ ok: true, message: 'Imagen eliminada.', sponsors: list() });
  });
}

module.exports = { registerSponsorRoutes, normalizeLink, MAX_SPONSORS };
