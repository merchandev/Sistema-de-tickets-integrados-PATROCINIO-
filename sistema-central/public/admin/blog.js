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
  $("blog-form").addEventListener("input", () => (dirty = true));
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
  document.querySelectorAll("[data-blog-format]").forEach((button) =>
    button.addEventListener("click", () => {
      const textarea = $("blog-content"),
        start = textarea.selectionStart,
        end = textarea.selectionEnd,
        selected = textarea.value.slice(start, end);
      const snippets = {
        heading: "\n## " + (selected || "Subtítulo") + "\n",
        bold: "**" + (selected || "Texto destacado") + "**",
        list: "\n- " + (selected || "Elemento de la lista") + "\n",
        link: "[" + (selected || "Texto del enlace") + "](https://)",
        quote: "\n> " + (selected || "Cita") + "\n",
      };
      textarea.setRangeText(
        snippets[button.dataset.blogFormat],
        start,
        end,
        "end",
      );
      textarea.focus();
      dirty = true;
    }),
  );
  window.addEventListener("beforeunload", (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  window.loadMarketingBlog = load;
})();
