function videoSource(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname;
  const path = url.pathname.split("/").filter(Boolean);
  const id = host === "youtu.be" ? path[0] :
    ["www.youtube.com", "youtube.com", "m.youtube.com", "www.youtube-nocookie.com"].includes(host)
      ? (path[0] === "watch" ? url.searchParams.get("v") : ["shorts", "embed"].includes(path[0]) ? path[1] : null)
      : null;
  if (id && /^[\w-]{11}$/.test(id)) return { src: "https://www.youtube-nocookie.com/embed/" + id, provider: "YouTube" };
  if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) {
    const vimeoId = path[0] === "video" ? path[1] : path[0];
    if (/^\d{1,15}$/.test(vimeoId || "")) return { src: "https://player.vimeo.com/video/" + vimeoId, provider: "Vimeo" };
  }
  if (/\.(mp4|webm)$/i.test(url.pathname)) return { src: url.href, provider: "Archivo", direct: true };
  return null;
}

function installBlogVideo(markdown, escape) {
  markdown.block.ruler.before("paragraph", "blog_video", (state, start, end, silent) => {
    const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    const match = /^@video\s+(\S+)\s*$/.exec(line);
    const video = match && videoSource(match[1]);
    if (!video || state.sCount[start] - state.blkIndent >= 4) return false;
    if (!silent) {
      state.line = start + 1;
      const token = state.push("blog_video", "figure", 0);
      token.meta = { ...video, url: match[1] };
    }
    return true;
  }, { alt: ["paragraph"] });
  markdown.renderer.rules.blog_video = (tokens, index, options, env) => {
    const { src, url, provider, direct } = tokens[index].meta;
    const player = env?.editor
      ? `<span>Video · ${escape(provider)}</span>`
      : direct
        ? `<video src="${escape(src)}" controls playsinline preload="none" aria-label="Video del artículo"></video>`
        : `<iframe src="${escape(src)}" title="Video del artículo en ${escape(provider)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`;
    return `<figure class="blog-video" data-blog-video="${escape(url)}"${env?.editor ? ' contenteditable="false"' : ''}>${player}</figure>\n`;
  };
}

module.exports = { installBlogVideo, videoSource };
