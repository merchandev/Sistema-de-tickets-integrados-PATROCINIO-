const words = (text) => String(text).match(/[\p{L}\p{N}]+/gu) || [];
const normalize = (text) => words(String(text).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()).join(" ");
const compact = (text) => String(text || "").replace(/\s+/g, " ").trim();
function shorten(text, length) {
  if (text.length <= length) return text;
  const head = text.slice(0, length - 1);
  const space = head.lastIndexOf(" ");
  return (space > length * 0.65 ? head.slice(0, space) : head) + "…";
}

function inspect(post, tokens, slugify) {
  const paragraphs = [], headings = [], images = [];
  let links = 0, videos = 0;
  const plain = (children = []) => children.map((child) => {
    if (child.type === "image") {
      images.push(compact(plain(child.children)));
      return "";
    }
    if (child.type === "link_open") links++;
    if (["text", "code_inline"].includes(child.type)) return child.content;
    return child.type.endsWith("break") ? " " : "";
  }).join("");
  tokens.forEach((token, index) => {
    if (token.type === "blog_video") videos++;
    if (token.type !== "inline") return;
    const parent = tokens[index - 1];
    const text = compact(plain(token.children));
    if (!text) return;
    if (parent.type === "paragraph_open") paragraphs.push(text);
    if (parent.type === "heading_open") headings.push({ level: Number(parent.tag.slice(1)), text });
  });
  const title = compact(post.title);
  const slug = slugify(post.slug || title);
  const autoTitle = shorten(title, 60);
  const autoDescription = shorten(compact(post.excerpt) || paragraphs[0] || title, 155);
  const stop = new Set("el la los las un una unos unas de del en al a y o e por para con sin que tu tus su sus este esta como sobre".split(" "));
  const titleWords = words(title);
  const start = titleWords.findIndex((word) => !stop.has(normalize(word)));
  const phraseWords = start < 0 ? [] : titleWords.slice(start, start + 3);
  while (phraseWords.length > 1 && stop.has(normalize(phraseWords.at(-1)))) phraseWords.pop();
  const autoPhrase = phraseWords.join(" ");
  const metadata = {
    title: compact(post.seo_title) || autoTitle,
    description: compact(post.seo_description) || autoDescription,
    keyphrase: compact(post.focus_keyphrase) || autoPhrase,
    slug,
  };
  const phrase = normalize(metadata.keyphrase);
  const contains = (value) => Boolean(phrase && (" " + normalize(value) + " ").includes(" " + phrase + " "));
  const checks = [];
  const check = (pass, points, good, tip) => checks.push({ pass, points, text: pass ? good : tip });
  const length = (value) => [...value].length;
  const titleLength = length(metadata.title);
  const descLength = length(metadata.description);
  const wordCount = words(paragraphs.join(" ")).length;
  const longParagraphs = paragraphs.filter((p) => words(p).length > 120).length;
  const sentences = paragraphs.flatMap((p) => p.split(/[.!?…]+(?:\s|$)/u)).filter((s) => words(s).length);
  const longSentences = sentences.filter((s) => words(s).length > 25).length;
  const missingAlt = images.filter((alt) => !alt).length + (post.cover_url && !compact(post.cover_alt) ? 1 : 0);
  const imageCount = images.length + Number(Boolean(post.cover_url));
  check(titleLength >= 30 && titleLength <= 60, 14, "El título SEO tiene una longitud útil.", `Título SEO: ${titleLength} caracteres. Prueba con 30–60 y describe el tema principal.`);
  check(descLength >= 100 && descLength <= 155, 14, "La descripción resume el artículo con una longitud útil.", `Descripción SEO: ${descLength} caracteres. Apunta a 100–155 y explica qué aprenderá el lector.`);
  check(Boolean(slug) && slug.length <= 75, 6, "El enlace permanente es breve.", "Acorta el enlace permanente a 75 caracteres o menos. Si ya publicaste, evita cambiarlo sin un plan para el enlace anterior.");
  check(contains(metadata.title) && contains(slug), 10, "La frase clave aparece en el título SEO y en el enlace.", "Incluye la frase clave de forma natural en el título SEO y el enlace.");
  check(contains(paragraphs[0] || "") && contains(metadata.description), 10, "La introducción y la descripción presentan la frase clave.", "Si encaja, menciona la frase clave en el primer párrafo y en la descripción SEO.");
  check(wordCount >= 250, 10, "El artículo tiene suficiente texto para desarrollar el tema.", `${wordCount} palabras en el cuerpo. Para una guía, considera unas 250 o más; añade ejemplos si aportan valor.`);
  check(headings.some((h) => h.level === 2) && headings.every((h, i) => h.level > 1 && h.level <= (headings[i - 1]?.level || 1) + 1), 10, "Los subtítulos siguen una jerarquía clara.", "Usa H2 para las secciones y H3–H6 para subdividirlas sin saltos. El título del artículo ya es H1.");
  check(paragraphs.length > 0 && longParagraphs === 0, 7, "Los párrafos son manejables.", longParagraphs ? `${longParagraphs} párrafo(s) superan 120 palabras. Divide cada uno por ideas.` : "Añade párrafos breves con una idea por bloque.");
  check(sentences.length > 0 && longSentences / sentences.length <= 0.25, 7, "La mayoría de las frases son fáciles de leer.", `${longSentences} de ${sentences.length} frases superan 25 palabras. Divide las más largas cuando ayude a entenderlas.`);
  check(imageCount > 0 && missingAlt === 0, 8, "Las imágenes tienen texto alternativo.", missingAlt ? `Completa el texto alternativo de ${missingAlt} imagen(es) con una descripción breve.` : "Añade una imagen relevante con texto alternativo, si ayuda a explicar el tema.");
  check(links > 0, 4, "El artículo contiene enlaces de apoyo.", "Añade un enlace interno o una fuente confiable cuando aporte contexto.");
  return {
    metadata,
    automatic: { title: autoTitle, description: autoDescription, keyphrase: autoPhrase },
    score: checks.reduce((sum, item) => sum + (item.pass ? item.points : 0), 0),
    checks,
    stats: { words: wordCount, images: imageCount, videos },
  };
}

module.exports = { inspect };
