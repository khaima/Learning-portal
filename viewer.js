/* ============================================================
   HPF Digital Learning Portal — in-portal content viewer.

   "Open to read" should stay inside the portal, not bounce the visitor
   out to a download or an external app. This opens a full-screen
   overlay and renders the file inline for every type a browser can
   actually display on its own — PDF, images, video, audio, plain
   text. Word/Excel/PowerPoint (and anything else) has no way to
   render in a browser without a server-side conversion this build
   doesn't have, so those still open in a new tab exactly as before;
   viewableKind() below is the one place that decision gets made, and
   nav.js checks it before deciding how to time the visit.
   ============================================================ */

const VIEWABLE_EXT = {
  pdf: "pdf",
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image", svg: "image",
  mp4: "video", webm: "video", ogv: "video", mov: "video",
  mp3: "audio", wav: "audio", m4a: "audio", oga: "audio",
  txt: "text", md: "text", csv: "text", log: "text",
};

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

/** "pdf" | "image" | "video" | "audio" | "text" | null (not inline-viewable). */
export function viewableKind(name) {
  return VIEWABLE_EXT[extOf(name)] || null;
}

let overlay = null;
let onCloseCb = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "viewer-overlay";
  overlay.innerHTML = `
    <div class="viewer-frame" role="dialog" aria-modal="true">
      <div class="viewer-bar">
        <b class="viewer-title"></b>
        <button type="button" class="viewer-close" aria-label="Close">&times;</button>
      </div>
      <div class="viewer-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeViewer(); });
  overlay.querySelector(".viewer-close").addEventListener("click", closeViewer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("is-open")) closeViewer();
  });
  return overlay;
}

/** Opens {title, url, name} inline if the file type allows it; returns
    true if it did. `onClose` fires once, whenever the viewer closes
    (X, Esc, backdrop click) — the caller uses it to mark the visit
    complete. Returns false without opening anything for a type that
    can't render inline (caller should fall back to a normal link). */
export function openViewer({ title, url, name }, onClose) {
  const kind = viewableKind(name);
  if (!kind) return false;

  const el = ensureOverlay();
  onCloseCb = onClose || null;
  el.querySelector(".viewer-title").textContent = title || name || "";
  const body = el.querySelector(".viewer-body");
  body.innerHTML = "";

  let node;
  if (kind === "pdf" || kind === "text") {
    node = document.createElement("iframe");
    node.src = url;
    node.title = title || name || "";
  } else if (kind === "image") {
    node = document.createElement("img");
    node.src = url;
    node.alt = title || name || "";
  } else if (kind === "video") {
    node = document.createElement("video");
    node.src = url;
    node.controls = true;
    node.autoplay = true;
  } else if (kind === "audio") {
    node = document.createElement("audio");
    node.src = url;
    node.controls = true;
    node.autoplay = true;
  }
  body.appendChild(node);
  el.classList.add("is-open");
  document.body.classList.add("viewer-locked");
  return true;
}

export function closeViewer() {
  if (!overlay || !overlay.classList.contains("is-open")) return;
  overlay.classList.remove("is-open");
  document.body.classList.remove("viewer-locked");
  overlay.querySelector(".viewer-body").innerHTML = ""; // stop any video/audio playback
  const cb = onCloseCb;
  onCloseCb = null;
  if (cb) cb();
}
