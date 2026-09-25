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

import { $, $$, toast } from "./util.js";
import { startLibraryInteraction, completeLibraryInteraction, awardLibraryBadge } from "./store.js";
import { openViewer, openYouTubeViewer, viewableKind, isViewerOpen, currentOpenId, showBadgeCelebration } from "./viewer.js";
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

document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-track-item]");
  if (!link) return;
  const itemId = link.dataset.trackItem;
  const fileName = link.dataset.fileName || "";
  const ytEmbed = link.dataset.ytEmbed || "";

  if (ytEmbed) {
    e.preventDefault();
    const title = link.dataset.itemTitle || "";
    startLibraryInteraction(itemId)
      .then((interaction) => {
        const id = interaction?.id;
        openYouTubeViewer(
          { title, embedUrl: ytEmbed },
          () => { if (id) completeLibraryInteraction(id).catch(() => {}); },
        );
        scheduleBadgeCheck(itemId, title);
      })
      .catch(() => window.open(link.href, "_blank", "noopener"));
    return;
  }

  // Library files: view-only unless the API granted a download (education
  // team only — see libraryFilesHtml in store.js).
  const viewUrl = link.dataset.viewUrl;
  if (viewUrl !== undefined) {
    e.preventDefault();
    const canDownload = link.dataset.canDownload === "1";
    const title = link.dataset.itemTitle || fileName;
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
    const open = (onClose) => openViewer({ title, url: viewUrl, name: fileName, allowDownload: canDownload }, onClose);
    startLibraryInteraction(itemId)
      .then((interaction) => {
        const id = interaction?.id;
        open(() => { if (id) completeLibraryInteraction(id).catch(() => {}); });
        scheduleBadgeCheck(itemId, title);
      })
      .catch(() => open()); // tracking failed — still let them read it
    return;
  }

  startLibraryInteraction(itemId)
    .then((interaction) => { if (interaction) pendingInteractions.push(interaction.id); })
    .catch(() => {}); // tracking must never block or break the actual link
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

/* notification bell — nothing to notify about yet, but it responds */
const bell = $(".app-top-actions .icon-btn");
if (bell) {
  bell.addEventListener("click", () => {
    bell.querySelector(".dot")?.remove();
    toast("You're all caught up", "No new notifications.");
  });
}

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
   The one network state worth interrupting every dashboard for — once
   the connection drops, actions (save, submit, sign in) start failing,
   so say so up front rather than leaving each one to fail silently and
   separately. Plain document flow at the very top of <body>, so it
   pushes the page down instead of overlapping it; appears the instant
   the browser goes offline (or immediately on load, if it already is)
   and disappears the instant it's back. Nothing to wire per page. */
const offlineBanner = document.createElement("div");
offlineBanner.className = "offline-banner";
offlineBanner.hidden = true;
offlineBanner.innerHTML = `<span class="dot"></span> You're offline — some actions won't work until you reconnect.`;
document.body.prepend(offlineBanner);

function updateOnlineState() {
  offlineBanner.hidden = navigator.onLine;
}
window.addEventListener("online", updateOnlineState);
window.addEventListener("offline", updateOnlineState);
updateOnlineState();
