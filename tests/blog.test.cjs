const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const {
  createBlogStore,
  decorate,
  validatePost,
  analysis,
} = require("../sistema-central/src/blog");
test("drafts stay private, published articles are searchable, trash is recoverable", () => {
  const db = new DatabaseSync(":memory:");
  const store = createBlogStore(db);
  const draft = store.save({
    title: "Contenido con propósito",
    content: "## Una idea\n\n**Comparte** con tu comunidad.",
    category: "Contenido",
    status: "draft",
  });
  assert.equal(draft.slug, "contenido-con-proposito");
  assert.equal(store.bySlug(draft.slug), undefined);
  assert.equal(store.list({ publicOnly: true }).total, 0);
  const live = store.save({ ...draft, status: "published" }, draft.id);
  assert.equal(store.list({ publicOnly: true, search: "comunidad" }).total, 1);
  assert.equal(store.bySlug(live.slug).title, draft.title);
  assert.match(decorate(live).content_html, /<h2>Una idea<\/h2>/);
  assert.throws(
    () => store.save({ ...draft, status: "published" }, draft.id),
    (e) => e.status === 409,
  );
  const trashed = store.save({ ...live, status: "trash" }, live.id);
  assert.equal(store.bySlug(live.slug), undefined);
  const restored = store.save({ ...trashed, status: "draft" }, trashed.id);
  assert.equal(store.get(restored.id).status, "draft");
  assert.equal(store.list({ status: "draft" }).total, 1);
  db.close();
});

test("SEO metadata is generated from article text and editable overrides survive saving", () => {
  const db = new DatabaseSync(":memory:");
  const store = createBlogStore(db);
  const draft = store.save({
    title: "Marketing local para emprendedores",
    content: "Marketing local para emprendedores empieza con conocer a tu público. Esta guía te ayuda a dar ese primer paso.",
  });
  const auto = analysis(draft);
  assert.equal(auto.metadata.title, draft.title);
  assert.equal(auto.metadata.description, draft.content);
  assert.equal(auto.metadata.keyphrase, "Marketing local");
  assert.ok(auto.score < 78);
  const published = store.save({ ...draft, status: "published", seo_title: "Guía de marketing local para emprendedores", seo_description: "Un resumen escrito por el autor", focus_keyphrase: "marketing local" }, draft.id);
  assert.deepEqual(decorate(store.bySlug(published.slug)).seo, { title: published.seo_title, description: published.seo_description });
  assert.ok(!Object.hasOwn(decorate(published), "focus_keyphrase"));
  assert.equal(store.save({ ...published, seo_description: "" }, published.id).seo_description, "");
  db.close();
});

test("readability reports long text, heading hierarchy and missing image alt", () => {
  const report = analysis({
    title: "Plan de marketing para pequeños negocios",
    content: "### Sin sección principal\n\n" + "palabra ".repeat(125) + ".\n\n![](https://example.org/imagen.png)",
  });
  const tips = report.checks.filter((entry) => !entry.pass).map((entry) => entry.text).join("\n");
  assert.match(tips, /superan 120 palabras/);
  assert.match(tips, /superan 25 palabras/);
  assert.match(tips, /jerarquía|Usa H2/);
  assert.match(tips, /texto alternativo/);
});

test("rich Markdown emits heading and image tags and embeds only supported HTTPS video", () => {
  const html = decorate({
    content: "# Uno\n## Dos\n### Tres\n#### Cuatro\n##### Cinco\n###### Seis\n\n![Diagrama](https://example.org/imagen.png)\n\n@video https://youtu.be/dQw4w9WgXcQ\n\n@video https://example.org/video.webm\n\n@video https://youtu.be.example.org/dQw4w9WgXcQ\n\n@video javascript:alert(1)",
  }).content_html;
  for (let level = 1; level <= 6; level++) assert.ok(html.includes("<h" + level + ">"));
  assert.match(html, /alt="Diagrama"/);
  assert.match(html, /<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ"/);
  assert.match(html, /<video src="https:\/\/example\.org\/video\.webm"/);
  assert.equal((html.match(/<iframe /g) || []).length, 1);
});
test("duplicate links, empty publication and unsafe image URLs are rejected", () => {
  const db = new DatabaseSync(":memory:");
  const store = createBlogStore(db);
  store.save({ title: "Una idea", status: "draft" });
  assert.throws(
    () => store.save({ title: "Otra idea", slug: "una-idea" }),
    (e) => e.status === 409,
  );
  assert.throws(
    () => validatePost({ title: "Vacía", status: "published" }),
    (e) => e.status === 400,
  );
  for (const cover_url of [
    "javascript:alert(1)",
    "data:image/svg+xml,test",
    "http://example.com/image.png",
    "https://user:pass@example.com/a.png",
  ]) {
    assert.throws(
      () => validatePost({ title: "Imagen", cover_url }),
      (e) => e.status === 400,
    );
  }
  const html = decorate({
    content: "<script>alert(1)</script>\n\n[enlace](javascript:alert(1))",
  }).content_html;
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('href="javascript:'));
  db.close();
});
