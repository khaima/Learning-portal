/* ============================================================
   HPF Digital Learning Portal — dashboard side-nav + top bar.

   One navigation system, shared by all five role dashboards: the
   side-nav links and top-level sections carry matching data-page
   attributes. Clicking a link shows only that section — a real
   separate view, not a scroll position — and the current page is both
   the URL hash (#my-classes) and the .active link, so reload/back/
   forward, sharing a link to a specific page, and "where am I right
   now" all agree with each other.

   Also owns: the mobile off-canvas drawer, the profile/account menu,
   and the notification bell. Imported by every dashboard JS — nothing
   here is page-specific.
   ============================================================ */

import "./pwa.js";
import { $, $$, toast, confirmDialog } from "./util.js";
import { startLibraryInteraction, completeLibraryInteraction, awardLibraryBadge, formatBytes } from "./store.js";
import { openViewer, openYouTubeViewer, viewableKind, isViewerOpen, currentOpenId, showBadgeCelebration } from "./viewer.js";
import * as sync from "./sync.js";
import { mountSyncStatus, openSyncPanel } from "./sync-ui.js";
import { mountBell } from "./notify-ui.js";

// Online / offline, last sync and what's waiting — on every dashboard; the
// Sync center opens from it (and from a "Sync center" link where there is one).
mountSyncStatus();
document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-open-sync-center]");
  if (!link) return;
  e.preventDefault();
  openSyncPanel();
});
/* ---------------------------------------------------------------- reading-badge celebration
   A real "you've been at this a while" moment, not a claim about what
   was learned: once a viewer session on one resource stays open past
   this threshold, award the (one-time-per-resource) badge and pop the
   celebration — but only if the visitor is still looking at THAT same
   session, not a stale timer left over from something they already
   moved on from (see currentOpenId()). Only fires for content this
   portal actually renders in its own viewer — an external new tab
   can't be watched, so it can't honestly earn one. */
const BADGE_THRESHOLD_MS = 60 * 1000;

function scheduleBadgeCheck(itemId, title) {
  const openId = currentOpenId();
  setTimeout(async () => {
    if (!isViewerOpen() || currentOpenId() !== openId) return;
    try {
      const res = await awardLibraryBadge(itemId, Math.round(BADGE_THRESHOLD_MS / 1000));
      if (res?.awarded) showBadgeCelebration({ title });
    } catch { /* badges are a bonus — never let a failure disturb reading */ }
  }, BADGE_THRESHOLD_MS);
}

/* ---------------------------------------------------------------- content-library usage tracking
   Delegated here so every dashboard gets it for free instead of wiring
   it per page: any link marked data-track-item (see libraryFilesHtml()
   in store.js) starts a timer the moment it's clicked.

   For a file type this portal knows how to render — PDF, image, video,
   audio, text directly, Word/Excel/PowerPoint via Microsoft's viewer —
   it opens in the portal's own in-app viewer instead of a new tab —
   "continue reading" without ever leaving the dashboard — and the visit
   is completed the moment that viewer closes, an exact boundary.
   Anything else still opens in a new tab, since neither a browser nor
   that viewer can display it; for that case the visit is "completed"
   the next time THIS tab regains focus — the only honest signal
   available when we can't see what happens in the new tab, not a
   literal measurement of reading time. */
const pendingInteractions = [];

/* Opens the viewer right away, still inside the click — browsers only
   allow full screen from a click, and it feels instant — then records
   the visit in the background. If the viewer is closed before the
   record comes back, it's completed as soon as it does. */
function openTracked(itemId, title, open) {
  let interactionId = null;
  let closed = false;
  // Without a connection the reading is timed here and sent later as one
  // finished session (start and end), like any other offline activity.
  let offline = !sync.isOnline();
  const startedAt = new Date();
  const sendLater = () => sync.send({
    method: "POST", path: `/library/${itemId}/interactions`,
    body: { startedAt: startedAt.toISOString(), completedAt: new Date().toISOString() },
    label: `Reading: ${title || "a resource"}`, kind: "reading",
  }).catch(() => {});
  open(() => {
    closed = true;
    if (interactionId) completeLibraryInteraction(interactionId).catch(() => {});
    else if (offline) sendLater();
  });
  if (offline) return;
  scheduleBadgeCheck(itemId, title);
  startLibraryInteraction(itemId)
    .then((interaction) => {
      interactionId = interaction?.id || null;
      if (closed && interactionId) completeLibraryInteraction(interactionId).catch(() => {});
    })
    .catch((err) => {
      if (!sync.isNetworkError(err)) return; // tracking must never get in the way of reading
      offline = true;
      if (closed) sendLater();
    });
}

document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-track-item]");
  if (!link) return;
  const itemId = link.dataset.trackItem;
  const fileName = link.dataset.fileName || "";
  const ytEmbed = link.dataset.ytEmbed || "";

  if (ytEmbed) {
    e.preventDefault();
    const title = link.dataset.itemTitle || "";
    openTracked(itemId, title, (onClose) => openYouTubeViewer({ title, embedUrl: ytEmbed }, onClose));
    return;
  }

  // Library files: view-only unless the API granted a download (education
  // team only — see libraryFilesHtml in store.js).
  const viewUrl = link.dataset.viewUrl;
  if (viewUrl !== undefined) {
    e.preventDefault();
    const canDownload = link.dataset.canDownload === "1";
    const title = link.dataset.itemTitle || fileName;
    // Saved on this device: open that copy — no connection or data needed.
    if (sync.savedFile(itemId, fileName)) {
      sync.savedFileUrl(itemId, fileName).then((url) => {
        if (!url) return;
        openTracked(itemId, title, (onClose) => openViewer({ title, url, name: fileName, allowDownload: false }, () => {
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          onClose?.();
        }));
      });
      return;
    }
    if (!sync.isOnline()) {
      toast("Not saved on this device", "This resource needs a connection. Next time you're online, use “Save offline” to keep it for reading offline.");
      return;
    }
    if (!viewUrl) {
      toast("Couldn't open that", "The file link has expired — refresh the page and try again.", "error");
      return;
    }
    if (!viewableKind(fileName)) {
      if (canDownload) {
        window.open(viewUrl, "_blank", "noopener");
        startLibraryInteraction(itemId)
          .then((interaction) => { if (interaction) pendingInteractions.push(interaction.id); })
          .catch(() => {});
      } else {
        toast("Preview not available", "This file type can't be shown in the portal, and downloads are limited to the Education Team.");
      }
      return;
    }
    openTracked(itemId, title, (onClose) =>
      openViewer({ title, url: viewUrl, name: fileName, allowDownload: canDownload }, onClose));
    return;
  }

  startLibraryInteraction(itemId)
    .then((interaction) => { if (interaction) pendingInteractions.push(interaction.id); })
    .catch(() => {}); // tracking must never block or break the actual link
});

/* ---------------------------------------------------------------- "Save offline"
   Downloads a resource onto this device for reading without a connection
   (in the portal's viewer only), or removes the saved copy. */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-save-offline]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const itemId = btn.dataset.saveOffline;
  const name = btn.dataset.fileName;
  const title = btn.dataset.itemTitle || name;
  const saved = sync.savedFile(itemId, name);
  const mark = (on) => $$(`[data-save-offline="${CSS.escape(itemId)}"][data-file-name="${CSS.escape(name)}"]`).forEach((b) => {
    b.classList.toggle("is-saved", on);
    b.textContent = on ? "✓ Offline" : "Save offline";
    b.title = on ? "Saved on this device — tap to remove" : "Save on this device to read without a connection";
  });
  if (saved) {
    if (!(await confirmDialog({ title: "Remove the offline copy?", body: `“${title}” won't open without a connection until you save it again.`, confirmLabel: "Remove" }))) return;
    const key = sync.status().savedFiles.find((f) => f.itemId === itemId && f.name === name)?.key;
    if (key) await sync.removeSavedFile(key);
    mark(false);
    return;
  }
  if (!sync.isOnline()) { toast("You're offline", "Saving a resource needs a connection."); return; }
  const size = Number(btn.dataset.size) || 0;
  if (size > 20 * 1024 * 1024 && !(await confirmDialog({
    title: `Save ${formatBytes(size)} on this device?`, body: "Downloading it uses that much data, and that much space on the device.", confirmLabel: "Save offline",
  }))) return;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    await sync.saveFile({ itemId, title, name, size, url: btn.dataset.viewUrl });
    mark(true);
    toast("Saved for offline reading", `“${title}” opens without a connection now.`, "success");
  } catch (err) {
    mark(false);
    toast("Couldn't save it", err?.message || "Check your connection and try again.", "error");
  } finally {
    btn.disabled = false;
  }
});

/* A library card (store.js libraryItemCard) is clickable as a whole —
   anywhere on the box that isn't already a button, link or control
   opens it, exactly as its own View / Open button would. */
document.addEventListener("click", (e) => {
  const card = e.target.closest("[data-open-card]");
  if (!card) return;
  const control = e.target.closest("a, button, select, input, summary, .lib-folder");
  if (control && card.contains(control)) return;
  card.querySelector(".lib-open")?.click();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !pendingInteractions.length) return;
  pendingInteractions.splice(0, pendingInteractions.length)
    .forEach((id) => completeLibraryInteraction(id).catch(() => {}));
});

/* ---------------------------------------------------------------- paged dashboards */

const pageLinks = $$(".side-nav .side-link[data-page]");

if (pageLinks.length) {
  const pages = $$(".app-main .dash-page[data-page]");
  const validPages = new Set(pageLinks.map((l) => l.dataset.page));

  function showPage(page) {
    if (!validPages.has(page)) page = pageLinks[0].dataset.page;
    pages.forEach((p) => { p.hidden = p.dataset.page !== page; });
    pageLinks.forEach((l) => l.classList.toggle("active", l.dataset.page === page));
    window.scrollTo(0, 0);
  }

  pageLinks.forEach((link) => {
    link.setAttribute("href", "#" + link.dataset.page);
    link.setAttribute("role", "link");
  });

  window.addEventListener("hashchange", () => showPage((location.hash || "").slice(1)));
  showPage((location.hash || "").slice(1));
}

/* notification bell — stored notifications, unread count, the list (notify-ui.js) */
mountBell();

/* ---------------------------------------------------------------- mobile nav drawer
   Below 860px the sidebar (.app-side, styles.css) goes off-canvas rather
   than just disappearing — this is the one place that's wired, so every
   dashboard's mobile menu is the same implementation, not five copies.
   Built here instead of in each HTML file: .app-top's own layout
   (title block, then .app-top-actions, space-between) is untouched —
   the button is inserted as a sibling in front of the title block, and
   stays display:none above 860px (styles.css), so nothing shifts on
   desktop. */
const appShell = $(".app-shell");
const appTop = $(".app-top");
const appSide = $(".app-side");
if (appShell && appTop && appSide) {
  const titleBlock = appTop.firstElementChild;
  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "menu-btn";
  menuBtn.setAttribute("aria-label", "Open menu");
  menuBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:flex-start";
  titleBlock.replaceWith(wrap);
  wrap.append(menuBtn, titleBlock);

  const backdrop = document.createElement("div");
  backdrop.className = "side-backdrop";
  appShell.appendChild(backdrop);

  const closeMenu = () => {
    appSide.classList.remove("is-open");
    backdrop.classList.remove("is-open");
  };
  menuBtn.addEventListener("click", () => {
    appSide.classList.add("is-open");
    backdrop.classList.add("is-open");
  });
  backdrop.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  // Picking a section closes the drawer instead of leaving it open over
  // the page it just navigated to.
  $$(".side-nav .side-link").forEach((link) => link.addEventListener("click", closeMenu));
}

/* ---------------------------------------------------------------- profile / account menu
   The name+avatar block (.side-user) is now the one entry point for
   account actions — click or Enter/Space reveals .side-menu (Sign out
   today; the same #signOutBtn id every dashboard already wires, just
   tucked away instead of sitting permanently in the sidebar). Closes on
   an outside click, Escape, or picking Sign out itself. */
const userBtn = $("#sideUserBtn");
const userMenu = $("#sideMenu");
if (userBtn && userMenu) {
  const closeUserMenu = () => {
    userMenu.hidden = true;
    userBtn.setAttribute("aria-expanded", "false");
  };
  const toggleUserMenu = () => {
    const open = userMenu.hidden;
    userMenu.hidden = !open;
    userBtn.setAttribute("aria-expanded", String(open));
  };
  userBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleUserMenu(); });
  userBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleUserMenu(); }
  });
  document.addEventListener("click", (e) => {
    if (!userMenu.hidden && !userMenu.contains(e.target) && e.target !== userBtn) closeUserMenu();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeUserMenu(); });
}

/* ---------------------------------------------------------------- offline banner
   Said up front the moment the connection drops: work that can be done
   offline (answers, hand-ins, marks, forms, visits, reading) is kept on
   the device and synced later; the rest waits for the connection. Plain
   document flow at the very top of <body>, so it pushes the page down
   instead of overlapping it; appears the instant the browser goes
   offline (or on load, if it already is) and goes when it's back. */
const offlineBanner = document.createElement("div");
offlineBanner.className = "offline-banner";
offlineBanner.hidden = true;
offlineBanner.innerHTML = `<span class="dot"></span> You're offline — keep working: your work is saved on this device and syncs when you reconnect.`;
document.body.prepend(offlineBanner);

function updateOnlineState() {
  offlineBanner.hidden = navigator.onLine;
}
window.addEventListener("online", updateOnlineState);
window.addEventListener("offline", updateOnlineState);
updateOnlineState();
