const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const origin = "https://hablemosdemarketingmaturin.com";
const date = (value) =>
  new Intl.DateTimeFormat("es-VE", {
    dateStyle: "long",
    timeZone: "America/Caracas",
  }).format(new Date(value));
function layout(title, description, pathname, body, { post, noindex = false } = {}) {
  const canonical = origin + pathname;
  const image = post?.cover_url ? new URL(post.cover_url, origin).href : '';
  const structured = post ? {
    "@context": "https://schema.org", "@type": "BlogPosting",
    headline: post.title, description, mainEntityOfPage: canonical, inLanguage: 'es',
    datePublished: post.published_at, dateModified: post.updated_at,
    author: { '@type': 'Person', name: post.author },
    ...(image ? { image: [image] } : {}),
  } : null;
  const extra = [
    noindex ? '<meta name="robots" content="noindex,follow">' : '',
    `<meta property="og:url" content="${escape(canonical)}"><meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    image ? `<meta property="og:image" content="${escape(image)}"><meta property="og:image:alt" content="${escape(post.cover_alt)}">` : '',
    structured ? `<script type="application/ld+json">${JSON.stringify(structured).replace(/</g, '\\u003c')}</script>` : '',
  ].join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}${post ? "" : " | Hablemos de Marketing"}</title><meta name="description" content="${escape(description)}"><link rel="canonical" href="${origin}${escape(pathname)}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:type" content="${post ? "article" : "website"}">${extra}<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/blog.css?v=seo-1"></head><body><nav class="nav"><div class="container nav-inner"><a href="/" class="logo" aria-label="Hablemos de Marketing — Inicio"><img class="brand-logo" src="/Logo%20HDM%20completp-03%20s.png" alt="Hablemos de Marketing" width="4500" height="4501"></a><div class="blog-nav"><a href="/">El encuentro</a><a href="/blog" aria-current="${pathname === "/blog" ? "page" : "false"}">Blog</a><a href="/comprar" class="btn btn-lime">Ver entradas</a></div></div></nav>${body}<footer><div class="container blog-footer"><a href="/">Hablemos de Marketing</a><span>Ideas que conectan · Maturín</span><a href="/blog">Todas las publicaciones ↗</a></div></footer></body></html>`;
}
function registerBlogPages(app, upstream) {
  async function api(pathname) {
    const response = await fetch(upstream + pathname, {
      signal: AbortSignal.timeout(7000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok)
      throw Object.assign(new Error("Blog no disponible"), {
        status: response.status,
      });
    return data;
  }
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /admin\nSitemap: " + origin + "/sitemap.xml\n");
  });
  app.get("/sitemap.xml", async (_req, res) => {
    try {
      const urls = ["/", "/blog"].map((path) => "<url><loc>" + origin + path + "</loc></url>");
      let page = 1, pages;
      do {
        const data = await api("/api/public/blog/posts?limit=100&page=" + page);
        for (const post of data.posts) {
          if (urls.length >= 50000) break;
          urls.push("<url><loc>" + origin + "/blog/" + escape(post.slug) + "</loc><lastmod>" + escape(post.updated_at) + "</lastmod></url>");
        }
        pages = data.pages;
      } while (++page <= pages && urls.length < 50000);
      res.type("application/xml").set("Cache-Control", "public, max-age=300")
        .send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls.join("") + "</urlset>");
    } catch {
      res.set("Retry-After", "30").sendStatus(503);
    }
  });
  app.get("/blog", async (req, res) => {
    const query = new URLSearchParams({
      limit: "12",
      page: String(Math.max(1, parseInt(req.query.page, 10) || 1)),
    });
    for (const key of ["search", "category"])
      if (req.query[key]) query.set(key, String(req.query[key]).slice(0, 100));
    try {
      const data = await api("/api/public/blog/posts?" + query);
      const cards = data.posts
        .map(
          (post) =>
            `<article class="journal-card"><a href="/blog/${escape(post.slug)}" class="journal-image" aria-label="Leer ${escape(post.title)}">${post.cover_url ? `<img src="${escape(post.cover_url)}" alt="${escape(post.cover_alt)}" loading="lazy" width="900" height="600">` : `<span aria-hidden="true">Hablemos de<br><em>ideas.</em></span>`}</a><div class="journal-card-copy"><span class="journal-category">${escape(post.category)}</span><h2><a href="/blog/${escape(post.slug)}">${escape(post.title)}</a></h2><p>${escape(post.excerpt)}</p><div class="journal-meta"><span>${escape(post.author)}</span><time datetime="${escape(post.published_at)}">${date(post.published_at)}</time></div></div></article>`,
        )
        .join("");
      const pageLink = (page) => {
        const params = new URLSearchParams(query);
        params.delete("limit");
        params.set("page", page);
        return "/blog?" + params;
      };
      res
        .set("Cache-Control", "no-store")
        .send(
          layout(
            "El blog",
            "Ideas, historias y herramientas de marketing para conectar con tu comunidad.",
            data.page > 1 && !query.has("search") && !query.has("category") ? "/blog?page=" + data.page : "/blog",
            `<main><header class="journal-hero"><div class="container"><span>HABLEMOS DE MARKETING</span><h1>Las ideas también<br>se <em>comparten.</em></h1><p>Conversaciones sobre contenido, estrategia y comunidad. Un espacio para seguir aprendiendo juntos.</p></div></header><section class="journal-content"><div class="container"><form class="journal-search" method="get" action="/blog"><label for="journal-search">Encuentra una idea</label><div><input id="journal-search" name="search" value="${escape(req.query.search || "")}" placeholder="Buscar publicaciones…" maxlength="100"><button type="submit">Buscar →</button></div></form><div class="journal-grid">${cards || '<div class="journal-empty"><h2>Este espacio está por comenzar.</h2><p>Pronto compartiremos artículos, novedades e ideas del encuentro.</p><a href="/">Conoce el evento ↗</a></div>'}</div>${data.pages > 1 ? `<nav class="journal-pagination" aria-label="Páginas del blog">${data.page > 1 ? `<a href="${escape(pageLink(data.page - 1))}">← Anterior</a>` : ""}<span>${data.page} / ${data.pages}</span>${data.page < data.pages ? `<a href="${escape(pageLink(data.page + 1))}">Siguiente →</a>` : ""}</nav>` : ""}</div></section></main>`,
            { noindex: query.has("search") || query.has("category") },
          ),
        );
    } catch {
      res
        .status(503)
        .set("Retry-After", "30")
        .send(
          layout(
            "Blog",
            "Blog de Hablemos de Marketing.",
            "/blog",
            '<main class="journal-not-found container"><h1>Volvemos en un momento.</h1><p>No pudimos cargar las publicaciones. Intenta de nuevo en unos segundos.</p><a href="/blog">Volver a intentar →</a></main>',
          ),
        );
    }
  });
  app.get("/blog/:slug", async (req, res) => {
    try {
      const { post } = await api(
        "/api/public/blog/posts/" + encodeURIComponent(req.params.slug),
      );
      const tags = post.tags
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      res
        .set("Cache-Control", "no-store")
        .send(
          layout(
            post.seo?.title || post.title,
            post.seo?.description || post.excerpt || post.title,
            "/blog/" + post.slug,
            `<main class="journal-article"><header class="container article-header"><a href="/blog" class="article-back">← Todas las publicaciones</a><span class="journal-category">${escape(post.category)}</span><h1>${escape(post.title)}</h1><p class="article-excerpt">${escape(post.excerpt)}</p><div class="article-byline"><span>${escape(post.author)}</span><time datetime="${escape(post.published_at)}">${date(post.published_at)}</time><span>${post.reading_minutes} min de lectura</span></div></header>${post.cover_url ? `<div class="container article-cover"><img src="${escape(post.cover_url)}" alt="${escape(post.cover_alt)}" width="1200" height="750"></div>` : ""}<article class="article-prose">${post.content_html}<div class="article-tags">${tags.map((tag) => `<span>${escape(tag)}</span>`).join("")}</div><a href="/blog" class="article-back">Seguir leyendo el blog →</a></article></main>`,
            { post },
          ),
        );
    } catch (error) {
      const status = error.status === 404 ? 404 : 503;
      res
        .status(status)
        .send(
          layout(
            status === 404 ? "Publicación no encontrada" : "Blog no disponible",
            "Blog de Hablemos de Marketing.",
            "/blog",
            `<main class="journal-not-found container"><h1>${status === 404 ? "Esta publicación no está disponible." : "Volvemos en un momento."}</h1><p>${status === 404 ? "Puedes explorar el resto de artículos del blog." : "No pudimos cargar el artículo. Intenta de nuevo más tarde."}</p><a href="/blog">Volver al blog →</a></main>`,
          ),
        );
    }
  });
}
module.exports = { registerBlogPages };
