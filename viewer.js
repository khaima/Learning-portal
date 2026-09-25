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

   It's a full-page reading view with its own Back button (the browser's
   Back works too), and the content is fitted to the screen — see
   styles.css. nav.js also
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
let historyPushed = false;

window.addEventListener("popstate", () => {
  if (!historyPushed || !isViewerOpen()) return;
  historyPushed = false;
  closeViewer();
});

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "viewer-overlay";
  overlay.innerHTML = `
    <div class="viewer-frame" role="dialog" aria-modal="true">
      <div class="viewer-bar">
        <button type="button" class="viewer-close" aria-label="Back">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg><span>Back</span>
        </button>
        <b class="viewer-title"></b>
        <span class="viewer-note" hidden>View only</span>
        <button type="button" class="viewer-fs" hidden>
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg><span>Full screen</span>
        </button>
      </div>
      <div class="viewer-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  const fsBtn = overlay.querySelector(".viewer-fs");
  fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else enterFullscreen();
  });
  document.addEventListener("fullscreenchange", () => {
    fsBtn.querySelector("span").textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeViewer(); });
  overlay.addEventListener("contextmenu", (e) => {
    if (overlay.querySelector(".viewer-frame").dataset.locked) e.preventDefault();
  });
  overlay.querySelector(".viewer-close").addEventListener("click", closeViewer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("is-open")) closeViewer();
  });
  return overlay;
}

/* Real browser full screen for reading (hides the browser's own bars
   and the taskbar). Browsers only allow it straight from a click, which
   is why nav.js opens the viewer synchronously in its click handler. If
   it's refused or unsupported (e.g. iPhone Safari), the full-page reader
   is still there. */
function enterFullscreen() {
  if (document.fullscreenElement || !overlay?.requestFullscreen) return;
  overlay.requestFullscreen().catch(() => {});
}

function showOverlay(title, node, onClose, kind, { fullscreen = false } = {}) {
  const el = ensureOverlay();
  onCloseCb = onClose || null;
  openSeq += 1;
  el.querySelector(".viewer-title").textContent = title || "";
  el.querySelector(".viewer-frame").dataset.kind = kind || "";
  el.querySelector(".viewer-frame").dataset.locked = "";
  el.querySelector(".viewer-note").hidden = true;
  const body = el.querySelector(".viewer-body");
  body.innerHTML = "";
  body.appendChild(node);
  // A history entry per viewing session, so the browser/phone Back
  // button closes the reader instead of leaving the dashboard.
  if (!el.classList.contains("is-open")) {
    history.pushState({ hpfViewer: true }, "");
    historyPushed = true;
  }
  el.classList.add("is-open");
  document.body.classList.add("viewer-locked");
  el.querySelector(".viewer-fs").hidden = !(fullscreen && document.fullscreenEnabled);
  if (fullscreen) enterFullscreen();
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
    can't render inline.

    `allowDownload` is only true for the education team. Otherwise the
    session is view-only: the browser's own PDF toolbar (with its
    download/print buttons), the video/audio "Download" menu entry,
    Office's download button, image dragging and the right-click menu
    are all switched off. That removes every built-in save path, though
    no web page can stop a screenshot. */
export function openViewer({ title, url, name, allowDownload = false }, onClose) {
  const kind = viewableKind(name);
  if (!kind) return false;
  const locked = !allowDownload;

  let node;
  if (kind === "pdf" || kind === "text") {
    node = document.createElement("iframe");
    // "view=FitH" (Chrome/Edge) and "zoom=page-width" (Firefox) open a
    // PDF with the page as wide as the screen — large, readable text,
    // scrolling down the pages — rather than shrinking a whole page to fit.
    node.src = kind === "pdf"
      ? `${url}#view=FitH&zoom=page-width${locked ? "&toolbar=0&navpanes=0" : ""}`
      : url;
    node.title = title || name || "";
  } else if (kind === "office") {
    node = document.createElement("iframe");
    node.src = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}${
      locked ? "&wdDownloadButton=False&wdPrint=0" : ""}`;
    node.title = title || name || "";
  } else if (kind === "image") {
    node = document.createElement("img");
    node.src = url;
    node.alt = title || name || "";
    if (locked) node.draggable = false;
  } else if (kind === "video") {
    node = document.createElement("video");
    node.src = url;
    node.controls = true;
    node.autoplay = true;
    if (locked) {
      node.setAttribute("controlsList", "nodownload");
      node.disablePictureInPicture = true;
    }
  } else if (kind === "audio") {
    node = document.createElement("div");
    node.className = "viewer-audio-card";
    const audio = document.createElement("audio");
    audio.src = url;
    audio.controls = true;
    audio.autoplay = true;
    if (locked) audio.setAttribute("controlsList", "nodownload");
    node.innerHTML = `<div class="viewer-audio-icon">&#127925;</div><b>${esc(title || name || "Audio")}</b>`;
    node.appendChild(audio);
  }
  showOverlay(title || name, node, onClose, kind, { fullscreen: true });
  overlay.querySelector(".viewer-frame").dataset.locked = locked ? "1" : "";
  overlay.querySelector(".viewer-note").hidden = !locked;
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
  showOverlay(title, node, onClose, "video", { fullscreen: true });
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

/** Opens plain, already-built HTML in the same overlay chrome — for a
    data view rather than a file (e.g. a teacher checking one learner's
    activity), not something viewableKind() would ever classify. Caller
    owns the markup and any wiring inside it; this just hosts it. */
export function openContentPanel({ title, html }, onClose) {
  const node = document.createElement("div");
  node.className = "viewer-html-panel";
  node.innerHTML = html;
  showOverlay(title, node, onClose);
  return node;
}

let badgeEl = null;

/** A one-off congratulatory popup for a freshly-earned reading badge —
    layered above the viewer so the celebration doesn't interrupt or
    close whatever's being read. Dismisses itself, or on click. */
export function showBadgeCelebration({ title } = {}) {
  if (!badgeEl) {
    badgeEl = document.createElement("div");
    badgeEl.className = "badge-toast";
    badgeEl.addEventListener("click", () => badgeEl.classList.remove("is-open"));
  }
  // In full screen only the reader itself is drawn, so the popup has to
  // live inside it to be seen.
  (document.fullscreenElement || document.body).appendChild(badgeEl);
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
  if (document.fullscreenElement === overlay) document.exitFullscreen().catch(() => {});
  overlay.classList.remove("is-open");
  document.body.classList.remove("viewer-locked");
  overlay.querySelector(".viewer-body").innerHTML = ""; // stop any video/audio playback
  const cb = onCloseCb;
  onCloseCb = null;
  if (cb) cb();
  if (historyPushed) {
    historyPushed = false;
    history.back();
  }
}
