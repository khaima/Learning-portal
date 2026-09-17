/* ============================================================
   HPF Digital Learning Portal — in-portal content viewer.

   "Open to read" should stay inside the portal, not bounce the visitor
   out to a download or an external app. This opens a full-screen
   overlay and renders the file inline for every type a browser can
   display directly — PDF, images, video, audio, plain text — plus
   Word/Excel/PowerPoint via Microsoft's Office viewer service (it needs
   a URL it can fetch itself, which is exactly what a signed Storage URL
   is; nothing about the file's content is private to begin with once
   it's shared through the library). Only a handful of formats this
   build has no way to render at all (zip, generic binaries, …) still
   open in a new tab; viewableKind() is the one place that decision gets
   made, and nav.js checks it before deciding how to time the visit.

   The frame sizes itself per content kind (see styles.css) — full and
   roomy for something you read, snug and centered for an image or an
   audio track — rather than one fixed box for everything. nav.js also
   uses currentOpenId()/isViewerOpen() here to award a reading badge (see
   showBadgeCelebration()) once a session has stayed open a while. */

import { esc } from "./util.js";

const VIEWABLE_EXT = {
  pdf: "pdf",
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image", svg: "image",
  mp4: "video", webm: "video", ogv: "video", mov: "video",
  mp3: "audio", wav: "audio", m4a: "audio", oga: "audio",
  txt: "text", md: "text", csv: "text", log: "text",
  doc: "office", docx: "office", xls: "office", xlsx: "office", ppt: "office", pptx: "office",
};

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

/** "pdf" | "image" | "video" | "audio" | "text" | "office" | null (not inline-viewable). */
export function viewableKind(name) {
  return VIEWABLE_EXT[extOf(name)] || null;
}

/* YouTube is the one external site worth special-casing: unlike most
   sites, its embed player is explicitly designed to be framed, so a
   pasted watch/share link can actually play inline instead of just
   linking out. Anything else external opens in a new tab — most sites
   send X-Frame-Options/CSP specifically to block this, so attempting it
   generally would just show a broken frame. */
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/i;

/** The embeddable player URL for a YouTube link, or null. */
export function youTubeEmbedUrl(url) {
  const m = YOUTUBE_RE.exec(url || "");
  return m ? `https://www.youtube.com/embed/${m[1]}` : null;
}

let overlay = null;
let onCloseCb = null;
let openSeq = 0;

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

function showOverlay(title, node, onClose, kind) {
  const el = ensureOverlay();
  onCloseCb = onClose || null;
  openSeq += 1;
  el.querySelector(".viewer-title").textContent = title || "";
  el.querySelector(".viewer-frame").dataset.kind = kind || "";
  const body = el.querySelector(".viewer-body");
  body.innerHTML = "";
  body.appendChild(node);
  el.classList.add("is-open");
  document.body.classList.add("viewer-locked");
}

/** True while a viewer session is on screen — nav.js checks this before
    awarding a reading badge, so a stale timer from a resource the
    visitor already left never fires for whatever's open now. */
export function isViewerOpen() {
  return !!overlay && overlay.classList.contains("is-open");
}

/** Identifies the current viewer session; changes every time something
    new opens. Pair with isViewerOpen() to confirm a badge timer still
    refers to the same open session, not a later one. */
export function currentOpenId() {
  return openSeq;
}

/** Opens {title, url, name} inline if the file type allows it; returns
    true if it did. `onClose` fires once, whenever the viewer closes
    (X, Esc, backdrop click) — the caller uses it to mark the visit
    complete. Returns false without opening anything for a type that
    can't render inline (caller should fall back to a normal link). */
export function openViewer({ title, url, name }, onClose) {
  const kind = viewableKind(name);
  if (!kind) return false;

  let node;
  if (kind === "pdf" || kind === "text") {
    node = document.createElement("iframe");
    node.src = url;
    node.title = title || name || "";
  } else if (kind === "office") {
    node = document.createElement("iframe");
    node.src = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;
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
    node = document.createElement("div");
    node.className = "viewer-audio-card";
    const audio = document.createElement("audio");
    audio.src = url;
    audio.controls = true;
    audio.autoplay = true;
    node.innerHTML = `<div class="viewer-audio-icon">&#127925;</div><b>${esc(title || name || "Audio")}</b>`;
    node.appendChild(audio);
  }
  showOverlay(title || name, node, onClose, kind);
  return true;
}

/** Opens a YouTube video inline given its embed URL (see
    youTubeEmbedUrl()). Same open/close contract as openViewer(). */
export function openYouTubeViewer({ title, embedUrl }, onClose) {
  const node = document.createElement("iframe");
  node.src = embedUrl;
  node.title = title || "";
  node.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  node.allowFullscreen = true;
  showOverlay(title, node, onClose, "video");
}

/** Opens any already-embeddable URL inline (e.g. a KoboToolbox survey's
    iframe-friendly form link) — for content that isn't a library file at
    all, just a page this portal is allowed to frame. Same contract as
    openViewer(). */
export function openIframeViewer({ title, url }, onClose) {
  const node = document.createElement("iframe");
  node.src = url;
  node.title = title || "";
  showOverlay(title, node, onClose);
}

let badgeEl = null;

/** A one-off congratulatory popup for a freshly-earned reading badge —
    layered above the viewer so the celebration doesn't interrupt or
    close whatever's being read. Dismisses itself, or on click. */
export function showBadgeCelebration({ title } = {}) {
  if (!badgeEl) {
    badgeEl = document.createElement("div");
    badgeEl.className = "badge-toast";
    document.body.appendChild(badgeEl);
    badgeEl.addEventListener("click", () => badgeEl.classList.remove("is-open"));
  }
  badgeEl.innerHTML = `
    <div class="badge-toast-card">
      <div class="badge-toast-icon">&#127942;</div>
      <div>
        <b>Badge earned — Focused Reader!</b>
        <p>You've spent real time with <em>${esc(title || "this resource")}</em>. Keep it up.</p>
      </div>
    </div>`;
  badgeEl.classList.add("is-open");
  clearTimeout(badgeEl._dismissTimer);
  badgeEl._dismissTimer = setTimeout(() => badgeEl.classList.remove("is-open"), 9000);
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
