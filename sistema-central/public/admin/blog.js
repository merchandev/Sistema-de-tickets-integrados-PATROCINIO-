(() => {
  const $ = (id) => document.getElementById(id);
  let current = null,
    dirty = false,
    page = 1,
    status = "",
    totalPages = 0,
    loading = false;
  const fields = [
    "title",
    "slug",
    "excerpt",
    "content",
    "category",
    "tags",
    "author",
    "cover_url",
    "cover_alt",
    "seo_title",
    "seo_description",
    "focus_keyphrase",
  ];
  const statusNames = {
    draft: "Borrador",
    published: "Publicada",
    trash: "Papelera",
  };
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  async function api(url, options) {
    const response = await fetch("/api/admin/blog" + url, options);
    const data = await response.json();
    if (!response.ok || !data.ok)
      throw new Error(data.message || "No se pudo completar la operación.");
    return data;
  }
  function notice(text, error = false) {
    const el = $("blog-message");
    el.textContent = text;
    el.classList.toggle("blog-error", error);
  }
  function payload(postStatus) {
    return {
      ...Object.fromEntries(fields.map((key) => [key, $("blog-" + key).value])),
      status: postStatus,
      version: current?.version,
    };
  }
  const visual = $("blog-visual"), source = $("blog-content");
  const converter = typeof TurndownService === "function" ? new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" }) : null;
  converter?.addRule("blogVideo", {
    filter: (node) => node.nodeName === "FIGURE" && node.hasAttribute("data-blog-video"),
    replacement: (_content, node) => "\n\n@video " + node.getAttribute("data-blog-video") + "\n\n",
  });
  let analysisTimer, analysisRun = 0, editorRun = 0, visualMode = false;
  const postJSON = (value) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  function renderSEO(data) {
    const { metadata, automatic, score, stats, checks } = data;
    $("blog-focus_keyphrase").placeholder = automatic.keyphrase || "Se genera a partir del título";
    $("blog-seo_title").placeholder = automatic.title || "Se genera a partir del título";
    $("blog-seo_description").placeholder = automatic.description || "Se genera a partir del extracto o del contenido";
    $("blog-seo-url").textContent = "hablemosdemarketingmaturin.com/blog/" + (metadata.slug || "tu-articulo");
    $("blog-seo-title-preview").textContent = metadata.title || "Título de la publicación";
    $("blog-seo-description-preview").textContent = metadata.description || "Aquí aparecerá la descripción.";
    $("blog-seo-score").value = score + "%";
    $("blog-seo-score").dataset.level = score >= 78 ? "ready" : score >= 55 ? "review" : "work";
    $("blog-seo-stats").textContent = [stats.words + " palabras", stats.images + " imágenes", stats.videos + " videos", "Meta editorial: 78–100%"].join(" · ");
    $("blog-seo-checks").replaceChildren(...[...checks].sort((a, b) => Number(a.pass) - Number(b.pass)).map((check) => {
      const row = document.createElement("li");
      row.dataset.pass = String(check.pass);
      row.textContent = (check.pass ? "✓ " : "• ") + check.text;
      return row;
    }));
  }
  function scheduleSEO(delay = 250) {
    clearTimeout(analysisTimer);
    const run = ++analysisRun;
    analysisTimer = setTimeout(async () => {
      try {
        const data = await api("/analyze", postJSON(payload("draft")));
        if (run === analysisRun) renderSEO(data);
      } catch {
        if (run === analysisRun) {
          $("blog-seo-score").value = "—";
          $("blog-seo-stats").textContent = "No se pudo actualizar el análisis. Vuelve a editar un campo para reintentarlo.";
        }
      }
    }, delay);
  }
  function setMode(showVisual) {
    visualMode = showVisual;
    visual.hidden = !showVisual;
    source.hidden = showVisual;
    $("blog-visual-tools").hidden = !showVisual;
    $("blog-visual-mode").setAttribute("aria-pressed", String(showVisual));
    $("blog-markdown-mode").setAttribute("aria-pressed", String(!showVisual));
  }
  async function openVisual(focus = false) {
    if (!converter) return;
    const run = ++editorRun;
    const content = source.value;
    $("blog-visual-mode").disabled = true;
    try {
      const data = content ? await api("/analyze", postJSON({ content, render: true })) : { content_html: "" };
      if (run !== editorRun || content !== source.value || $("blog-editor").hidden) return;
      visual.innerHTML = data.content_html;
      lastRange = null;
      setMode(true);
      document.execCommand("defaultParagraphSeparator", false, "p");
      if (focus) visual.focus();
    } catch {
      if (run === editorRun) notice("No se pudo abrir el editor visual. Puedes seguir en Markdown.", true);
    } finally {
      if (run === editorRun) $("blog-visual-mode").disabled = false;
    }
  }
  function syncVisual() {
    if (!visualMode) return;
    rememberSelection();
    source.value = converter.turndown(visual);
    dirty = true;
    scheduleSEO();
  }
  function date(value) {
    return new Date(value).toLocaleString("es-VE", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Caracas",
    });
  }
  async function load() {
    try {
      const query = new URLSearchParams({
        page,
        limit: 15,
        search: $("blog-search").value,
      });
      if (status) query.set("status", status);
      const data = await api("/posts?" + query);
      totalPages = data.pages;
      $("blog-post-list").innerHTML = data.posts.length
        ? data.posts
            .map(
              (post) =>
                `<article class="blog-row"><div><span class="blog-state ${post.status}">${statusNames[post.status]}</span><button type="button" class="blog-post-title" data-edit="${post.id}">${escape(post.title)}</button><small>/${escape(post.slug)} · ${escape(post.category)}</small></div><div class="blog-row-meta"><strong>${escape(post.author)}</strong><span>${date(post.updated_at)}</span></div><div class="blog-row-actions"><button type="button" data-edit="${post.id}">Editar</button>${post.status === "published" ? `<a href="https://hablemosdemarketingmaturin.com/blog/${escape(post.slug)}" target="_blank" rel="noopener">Ver ↗</a>` : ""}</div></article>`,
            )
            .join("")
        : '<div class="blog-empty"><strong>Aquí comienzan las próximas ideas.</strong><p>No hay publicaciones para este filtro. Crea una entrada y guárdala como borrador o publícala cuando esté lista.</p></div>';
      for (const key of ["all", "draft", "published", "trash"])
        $("blog-count-" + key).textContent = data.counts[key] || 0;
      $("blog-pagination").textContent =
        `Página ${page} de ${Math.max(1, totalPages)} · ${data.total} publicaciones`;
      $("blog-previous").disabled = page <= 1;
      $("blog-next").disabled = page >= totalPages;
    } catch (error) {
      notice(error.message, true);
    }
  }
  function leaveEditor() {
    return (
      !dirty || confirm("Tienes cambios sin guardar. ¿Quieres descartarlos?")
    );
  }
  function showEditor(post = null) {
    current = post;
    for (const key of fields)
      $("blog-" + key).value =
        post?.[key] ||
        {
          category: "Marketing digital",
          author: "Equipo Hablemos de Marketing",
        }[key] ||
        "";
    $("blog-editor-title").textContent = post
      ? "Editar publicación"
      : "Nueva publicación";
    $("blog-editor-state").textContent = statusNames[post?.status || "draft"];
    $("blog-trash").hidden = !post || post.status === "trash";
    $("blog-save-draft").textContent =
      post?.status === "trash"
        ? "Restaurar como borrador"
        : post?.status === "published"
          ? "Cambiar a borrador"
          : "Guardar borrador";
    $("blog-publish").textContent =
      post?.status === "published" ? "Actualizar publicación" : "Publicar";
    $("blog-preview-frame").hidden = true;
    $("blog-editor").hidden = false;
    $("blog-seo-score").value = "—";
    $("blog-seo-checks").replaceChildren();
    $("blog-seo-stats").textContent = "Analizando la publicación…";
    setMode(false);
    openVisual();
    scheduleSEO(0);
    dirty = false;
    $("blog-title").focus();
    notice("");
    $("blog-editor").scrollIntoView({ block: "start" });
  }
  async function edit(id) {
    if (!leaveEditor()) return;
    try {
      const data = await api("/posts/" + id);
      showEditor(data.post);
    } catch (error) {
      notice(error.message, true);
    }
  }
  async function save(nextStatus) {
    if (loading) return;
    if (!document.getElementById("blog-form").reportValidity()) return;
    if (
      nextStatus === "trash" &&
      !confirm(
        "¿Mover esta publicación a la papelera? Dejará de estar visible en la web y podrás restaurarla.",
      )
    )
      return;
    if (
      nextStatus === "draft" &&
      current?.status === "published" &&
      !confirm(
        "¿Cambiar esta publicación a borrador? Dejará de estar visible en la web.",
      )
    )
      return;
    loading = true;
    document
      .querySelectorAll(".blog-save-action")
      .forEach((b) => (b.disabled = true));
    try {
      const data = await api("/posts" + (current ? "/" + current.id : ""), {
        method: current ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload(nextStatus)),
      });
      current = data.post;
      dirty = false;
      $("blog-slug").value = current.slug;
      scheduleSEO(0);
      $("blog-editor-state").textContent = statusNames[current.status];
      $("blog-trash").hidden = current.status === "trash";
      $("blog-publish").textContent =
        current.status === "published" ? "Actualizar publicación" : "Publicar";
      $("blog-save-draft").textContent =
        current.status === "trash"
          ? "Restaurar como borrador"
          : current.status === "published"
            ? "Cambiar a borrador"
            : "Guardar borrador";
      notice(
        nextStatus === "published"
          ? "Publicación guardada y visible en Hablemos de Marketing."
          : nextStatus === "trash"
            ? "Publicación movida a la papelera."
            : "Borrador guardado. Solo es visible desde el administrador.",
      );
      await load();
    } catch (error) {
      notice(error.message, true);
    } finally {
      loading = false;
      document
        .querySelectorAll(".blog-save-action")
        .forEach((b) => (b.disabled = false));
    }
  }
  $("blog-new").addEventListener("click", () => {
    if (leaveEditor()) showEditor();
  });
  $("blog-close").addEventListener("click", () => {
    if (leaveEditor()) {
      $("blog-editor").hidden = true;
      dirty = false;
    }
  });
  $("blog-post-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit]");
    if (button) edit(button.dataset.edit);
  });
  $("blog-form").addEventListener("input", (event) => {
    if (event.target === visual) return;
    dirty = true;
    scheduleSEO();
  });
  $("blog-form").addEventListener("submit", (event) => {
    event.preventDefault();
    save(current?.status === "published" ? "published" : "draft");
  });
  $("blog-save-draft").addEventListener("click", () => save("draft"));
  $("blog-publish").addEventListener("click", () => save("published"));
  $("blog-trash").addEventListener("click", () => save("trash"));
  $("blog-preview").addEventListener("click", async () => {
    try {
      const data = await api("/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload("draft")),
      });
      $("blog-preview-frame").srcdoc = data.html;
      $("blog-preview-frame").hidden = false;
    } catch (error) {
      notice(error.message, true);
    }
  });
  $("blog-upload").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append("image", file);
    notice("Subiendo imagen…");
    try {
      const data = await api("/media", { method: "POST", body: form });
      $("blog-cover_url").value = data.url;
      dirty = true;
      scheduleSEO();
      notice(
        "Imagen subida. Añade un texto alternativo y guarda la publicación.",
      );
    } catch (error) {
      notice(error.message, true);
    } finally {
      event.target.value = "";
    }
  });
  document.querySelectorAll("[data-blog-status]").forEach((button) =>
    button.addEventListener("click", () => {
      status = button.dataset.blogStatus;
      page = 1;
      document
        .querySelectorAll("[data-blog-status]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      load();
    }),
  );
  let timer;
  $("blog-search").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      page = 1;
      load();
    }, 250);
  });
  $("blog-previous").addEventListener("click", () => {
    page--;
    load();
  });
  $("blog-next").addEventListener("click", () => {
    page++;
    load();
  });
  let lastRange = null, mediaKind = "", editingImage = null;
  const dialog = $("blog-media-dialog");
  $("blog-visual-mode").addEventListener("click", () => { if (!visualMode) openVisual(true); });
  $("blog-markdown-mode").addEventListener("click", () => {
    editorRun++;
    $("blog-visual-mode").disabled = !converter;
    setMode(false);
    source.focus();
  });
  if (!converter) $("blog-visual-mode").disabled = true;
  function rememberSelection() {
    if (!visualMode || dialog.open) return;
    const selection = getSelection();
    if (!selection.rangeCount || !visual.contains(selection.anchorNode) || !visual.contains(selection.focusNode)) return;
    lastRange = selection.getRangeAt(0).cloneRange();
    const block = selection.anchorNode.parentElement?.closest("p,h1,h2,h3,h4,h5,h6,blockquote");
    $("blog-block").value = block && visual.contains(block) ? block.tagName.toLowerCase() : "p";
  }
  document.addEventListener("selectionchange", rememberSelection);
  function restoreSelection() {
    const selection = getSelection();
    let range = selection.rangeCount && visual.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.getRangeAt(0).cloneRange() : lastRange;
    if (!range || !visual.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(visual);
      range.collapse(false);
    }
    visual.focus();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function format(command, value = null) {
    restoreSelection();
    document.execCommand(command, false, value);
    syncVisual();
  }
  visual.addEventListener("input", syncVisual);
  visual.addEventListener("paste", (event) => {
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    syncVisual();
  });
  visual.addEventListener("drop", (event) => event.preventDefault());
  $("blog-block").addEventListener("change", (event) => format("formatBlock", event.target.value));
  document.querySelectorAll("[data-blog-command]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => format(button.dataset.blogCommand));
  });
  function openMedia(kind, image = null) {
    mediaKind = kind;
    editingImage = image;
    $("blog-media-form").reset();
    $("blog-media-title").textContent = image ? "Editar imagen" : { image: "Insertar imagen", link: "Insertar enlace", video: "Insertar video" }[kind];
    $("blog-media-insert").textContent = image ? "Guardar imagen" : "Insertar";
    $("blog-media-file-field").hidden = kind !== "image";
    $("blog-media-text-field").hidden = kind === "video";
    $("blog-media-text-label").textContent = kind === "image" ? "Texto alternativo" : "Texto del enlace";
    $("blog-media-text").value = image?.alt || (kind === "link" ? lastRange?.toString().slice(0, 200) || "" : "");
    $("blog-media-url").value = image?.getAttribute("src") || "";
    $("blog-media-url").required = kind !== "image";
    $("blog-media-help").textContent = kind === "video" ? "Pega una URL HTTPS de YouTube, Vimeo, MP4 o WebM." : kind === "image" ? "Describe qué muestra la imagen y por qué es relevante." : "";
    $("blog-media-error").textContent = "";
    dialog.showModal();
  }
  document.querySelectorAll("[data-blog-media]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => openMedia(button.dataset.blogMedia));
  });
  visual.addEventListener("click", (event) => {
    if (event.target instanceof HTMLImageElement && !dialog.open) openMedia("image", event.target);
  });
  $("blog-media-cancel").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if ($("blog-media-insert").disabled) event.preventDefault(); });
  $("blog-media-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const insert = $("blog-media-insert"), cancel = $("blog-media-cancel");
    insert.disabled = cancel.disabled = true;
    $("blog-media-error").textContent = "";
    try {
      const file = $("blog-media-file").files[0];
      let url = $("blog-media-url").value.trim();
      const label = $("blog-media-text").value.trim();
      if (mediaKind === "image" && file) {
        const form = new FormData();
        form.append("image", file);
        url = (await api("/media", { method: "POST", body: form })).url;
      } else if (!(mediaKind === "image" && /^\/api\/public\/blog\/media\/[a-f0-9-]{36}\.(png|jpg|webp)$/.test(url))) {
        let parsed;
        try { parsed = new URL(url); } catch { /* Report a useful editor error below. */ }
        if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password)
          throw new Error("Escribe una URL HTTPS válida.");
        url = parsed.href;
      }
      if (editingImage) {
        editingImage.setAttribute("src", url);
        editingImage.alt = label;
        dialog.close();
        syncVisual();
        return;
      }
      let element;
      if (mediaKind === "video") {
        const { provider } = await api("/video", postJSON({ url }));
        element = document.createElement("figure");
        element.dataset.blogVideo = url;
        element.className = "blog-video";
        element.contentEditable = "false";
        element.textContent = "Video · " + provider;
      } else if (mediaKind === "image") {
        element = document.createElement("img");
        element.src = url;
        element.alt = label;
      } else {
        element = document.createElement("a");
        element.href = url;
        element.textContent = label || url;
      }
      dialog.close();
      const html = mediaKind === "image" ? "<p>" + element.outerHTML + "</p>" : element.outerHTML;
      format("insertHTML", html + (mediaKind === "link" ? "" : "<p><br></p>"));
    } catch (error) {
      $("blog-media-error").textContent = error.message;
    } finally {
      insert.disabled = cancel.disabled = false;
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  window.loadMarketingBlog = load;
})();
