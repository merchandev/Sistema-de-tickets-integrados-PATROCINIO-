const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const {
  createBlogStore,
  decorate,
  validatePost,
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
