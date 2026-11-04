const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const multer = require("multer");
const MarkdownIt = require("markdown-it");
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const slugify = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 150);
function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
function validatePost(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Datos de publicación inválidos.');
  const text = (key, max, fallback = "") => {
    const value = String(input[key] ?? fallback).trim();
    if (value.length > max)
      fail(400, `${key}: supera el límite de ${max} caracteres.`);
    return value;
  };
  const title = text("title", 180);
  if (!title) fail(400, "Escribe el título de la publicación.");
  const slug = slugify(input.slug || title);
  if (!slug) fail(400, "Escribe un enlace válido con letras o números.");
  const status = text("status", 20, "draft");
  if (!["draft", "published", "trash"].includes(status))
    fail(400, "Estado de publicación inválido.");
  const content = text("content", 200000);
  if (status === "published" && !content)
    fail(400, "Añade contenido antes de publicar.");
  const cover_url = text("cover_url", 2000);
  if (
    cover_url &&
    !/^\/api\/public\/blog\/media\/[a-f0-9-]+\.(png|jpg|webp)$/.test(cover_url)
  ) {
    let url;
    try {
      url = new URL(cover_url);
    } catch {
      fail(400, "La imagen debe tener una URL HTTPS válida.");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      fail(400, "La imagen debe usar HTTPS y no incluir credenciales.");
  }
  return {
    title,
    slug,
    status,
    content,
    cover_url,
    excerpt: text("excerpt", 500),
    category: text("category", 80, "Marketing digital") || "Marketing digital",
    tags: text("tags", 300),
    author:
      text("author", 100, "Equipo Hablemos de Marketing") ||
      "Equipo Hablemos de Marketing",
    cover_alt: text("cover_alt", 200),
  };
}
function createBlogStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS marketing_blog_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','trash')),
    content TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '', author TEXT NOT NULL, cover_url TEXT NOT NULL DEFAULT '',
    cover_alt TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
    published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS marketing_blog_status_date ON marketing_blog_posts(status,published_at);`);
  const fields = [
    "title",
    "slug",
    "status",
    "content",
    "excerpt",
    "category",
    "tags",
    "author",
    "cover_url",
    "cover_alt",
  ];
  const get = (id) =>
    db.prepare("SELECT * FROM marketing_blog_posts WHERE id=?").get(id);
  function save(input, id) {
    const post = validatePost(input);
    const previous = id ? get(id) : null;
    if (id && !previous) fail(404, "La publicación ya no existe.");
    if (previous && Number(input.version) !== previous.version)
      fail(
        409,
        "Esta publicación cambió en otra ventana. Recarga el listado y abre la versión actual.",
      );
    const duplicate = db
      .prepare("SELECT id FROM marketing_blog_posts WHERE slug=? AND id!=?")
      .get(post.slug, id || 0);
    if (duplicate) fail(409, "Ese enlace ya está en uso. Elige otro.");
    const now = new Date().toISOString();
    const published =
      previous?.published_at || (post.status === "published" ? now : null);
    try {
      if (previous) {
        const result = db
          .prepare(
            `UPDATE marketing_blog_posts SET ${fields.map((f) => f + "=?").join(",")},published_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?`,
          )
          .run(
            ...fields.map((f) => post[f]),
            published,
            now,
            id,
            previous.version,
          );
        if (!result.changes)
          fail(409, "Otra ventana guardó cambios. Recarga la publicación.");
        return get(id);
      }
      const result = db
        .prepare(
          `INSERT INTO marketing_blog_posts (${fields.join(",")},published_at,created_at,updated_at) VALUES (${Array(
            fields.length + 3,
          )
            .fill("?")
            .join(",")})`,
        )
        .run(...fields.map((f) => post[f]), published, now, now);
      return get(Number(result.lastInsertRowid));
    } catch (error) {
      if (String(error.message).includes("UNIQUE"))
        fail(409, "Ese enlace ya está en uso.");
      throw error;
    }
  }
  function list({
    status,
    search = "",
    category = "",
    page = 1,
    limit = 20,
    publicOnly = false,
  } = {}) {
    const where = [],
      args = [];
    if (publicOnly || status) {
      where.push("status=?");
      args.push(publicOnly ? "published" : status);
    }
    if (search) {
      where.push("(title LIKE ? OR content LIKE ? OR tags LIKE ?)");
      args.push(...Array(3).fill("%" + String(search).slice(0, 100) + "%"));
    }
    if (category) {
      where.push("category=?");
      args.push(String(category).slice(0, 80));
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    limit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    page = Math.max(1, parseInt(page, 10) || 1);
    const total = db
      .prepare("SELECT COUNT(*) AS count FROM marketing_blog_posts" + clause)
      .get(...args).count;
    const posts = db
      .prepare(
        "SELECT id,title,slug,status,excerpt,category,tags,author,cover_url,cover_alt,published_at,created_at,updated_at,version FROM marketing_blog_posts" +
          clause +
          ` ORDER BY ${publicOnly ? "published_at" : "updated_at"} DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, (page - 1) * limit);
    return { posts, total, page, pages: Math.ceil(total / limit) };
  }
  return {
    get,
    save,
    list,
    bySlug: (slug) =>
      db
        .prepare(
          "SELECT * FROM marketing_blog_posts WHERE slug=? AND status='published'",
        )
        .get(slug),
  };
}
function decorate(post) {
  return {
    ...post,
    content_html: markdown.render(post.content),
    reading_minutes: Math.max(
      1,
      Math.ceil(post.content.split(/\s+/).length / 200),
    ),
  };
}
function previewHtml(post) {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Vista previa</title><style>body{font:17px/1.8 system-ui;color:#231536;padding:24px;max-width:760px;margin:auto}h1{line-height:1.15}img{max-width:100%;height:auto}pre{overflow:auto;background:#f5f1fa;padding:16px}a{color:#5b21d6}blockquote{border-left:3px solid #5b21d6;padding-left:20px}</style><body><p>${escape(post.category)} · ${escape(post.author)}</p><h1>${escape(post.title)}</h1>${post.cover_url ? `<img src="${escape(post.cover_url)}" alt="${escape(post.cover_alt)}">` : ""}${markdown.render(post.content)}</body></html>`;
}
function registerBlogRoutes(app, { db, storageDir }) {
  const store = createBlogStore(db);
  const mediaDir = path.join(storageDir, "blog");
  fs.mkdirSync(mediaDir, { recursive: true });
  const safe = (handler) => (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (error) {
      res
        .status(error.status || 500)
        .json({
          ok: false,
          message: error.status
            ? error.message
            : "No se pudo guardar la publicación.",
        });
    }
  };
  app.use("/api/admin/blog", (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("origin")) {
      try {
        if (new URL(req.get("origin")).host !== req.get("host"))
          return res
            .status(403)
            .json({ ok: false, message: "Origen no permitido." });
      } catch {
        return res
          .status(403)
          .json({ ok: false, message: "Origen no permitido." });
      }
    }
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get(
    "/api/admin/blog/posts",
    safe((req, res) => {
      const counts = { all: 0, draft: 0, published: 0, trash: 0 };
      for (const row of db
        .prepare(
          "SELECT status,COUNT(*) AS n FROM marketing_blog_posts GROUP BY status",
        )
        .all()) {
        counts[row.status] = row.n;
        counts.all += row.n;
      }
      res.json({ ok: true, ...store.list(req.query), counts });
    }),
  );
  app.get(
    "/api/admin/blog/posts/:id",
    safe((req, res) => {
      const post = store.get(req.params.id);
      if (!post) fail(404, "Publicación no encontrada.");
      res.json({ ok: true, post });
    }),
  );
  app.post(
    "/api/admin/blog/posts",
    safe((req, res) =>
      res.status(201).json({ ok: true, post: store.save(req.body) }),
    ),
  );
  app.put(
    "/api/admin/blog/posts/:id",
    safe((req, res) =>
      res.json({ ok: true, post: store.save(req.body, req.params.id) }),
    ),
  );
  app.post(
    "/api/admin/blog/preview",
    safe((req, res) =>
      res.json({
        ok: true,
        html: previewHtml(validatePost({ ...req.body, status: "draft" })),
      }),
    ),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  }).single("image");
  app.post("/api/admin/blog/media", (req, res) =>
    upload(req, res, (error) => {
      if (error || !req.file)
        return res
          .status(400)
          .json({
            ok: false,
            message: "Selecciona una imagen PNG, JPG o WebP de hasta 5 MB.",
          });
      const b = req.file.buffer;
      const ext = b
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "png"
        : b[0] === 255 && b[1] === 216 && b[2] === 255
          ? "jpg"
          : b.toString("ascii", 0, 4) === "RIFF" &&
              b.toString("ascii", 8, 12) === "WEBP"
            ? "webp"
            : null;
      if (!ext)
        return res
          .status(400)
          .json({
            ok: false,
            message: "El archivo no es una imagen PNG, JPG o WebP válida.",
          });
      const filename = crypto.randomUUID() + "." + ext;
      try {
        fs.writeFileSync(path.join(mediaDir, filename), b, { flag: "wx" });
        res
          .status(201)
          .json({ ok: true, url: "/api/public/blog/media/" + filename });
      } catch {
        res
          .status(500)
          .json({ ok: false, message: "No se pudo guardar la imagen." });
      }
    }),
  );
  app.get("/api/public/blog/media/:file", (req, res) => {
    if (!/^[a-f0-9-]{36}\.(png|jpg|webp)$/.test(req.params.file))
      return res.sendStatus(404);
    res.set("X-Content-Type-Options", "nosniff");
    res.sendFile(
      req.params.file,
      { root: mediaDir, maxAge: "365d", immutable: true },
      (error) => {
        if (error && !res.headersSent) res.sendStatus(404);
      },
    );
  });
  app.get(
    "/api/public/blog/posts",
    safe((req, res) => {
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, ...store.list({ ...req.query, publicOnly: true }) });
    }),
  );
  app.get(
    "/api/public/blog/posts/:slug",
    safe((req, res) => {
      res.set("Cache-Control", "no-store");
      const post = store.bySlug(req.params.slug);
      if (!post) fail(404, "Publicación no encontrada.");
      res.json({ ok: true, post: decorate(post) });
    }),
  );
  return store;
}
module.exports = {
  createBlogStore,
  validatePost,
  slugify,
  decorate,
  registerBlogRoutes,
};
