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
import { mountBell, openNotifications } from "./notify-ui.js";
import { ICON, menuFor, ROLE_WORKSPACE, WORKSPACES } from "./navigation.js";
import { rawRequest } from "./api.js";

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

/* ---------------------------------------------------------------- the sidebar and its pages
   Built for the signed-in person from navigation.js (their workspace, and
   the items their permissions allow), once their profile has loaded —
   every dashboard calls mountNavigation(user) right after requireRole().

   A page is shown only if it's in that person's menu: an address for any
   other page (typed, bookmarked, or left over from another role) goes to
   their own landing page instead. That's the screen; the API checks every
   request again. The current page is the URL hash (#users, or
   #users?role=teacher for a filtered view) and the highlighted link, so
   reload / back / forward and shared links all agree. */
const iconSvg = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICON[name] ?? ICON.dashboard}</svg>`;
const navKey = (ws) => `hpf_nav_groups:${ws}`;
const readJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "") ?? d; } catch { return d; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const escText = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let pageHandler = null;

/** Who and where, under the page title: "School Head · Aitong Primary", "M&E · Meru County". */
function identityLine(user) {
  const role = ROLE_TEXT[user.role] || user.role;
  if (user.role === "learner") return [role, user.className || user.grade, user.school].filter(Boolean).join(" · ");
  if (user.role === "teacher" || user.role === "school_leader") return [role, user.school, user.county].filter(Boolean).join(" · ");
  return [role, user.scope?.label || user.county].filter(Boolean).join(" · ");
}
const ROLE_TEXT = {
  super_admin: "Super Admin", admin: "Admin", me: "M&E", education_team: "Education Team",
  field_officer: "Field Officer", school_leader: "School Head", teacher: "Teacher", learner: "Learner",
};

export function mountNavigation(user, { workspace, onPage } = {}) {
  const wsId = workspace || ROLE_WORKSPACE[user.role];
  const ws = WORKSPACES[wsId];
  const nav = $(".side-nav");
  if (!ws || !nav) return null;
  pageHandler = onPage || null;
  const groups = menuFor(wsId, user.permissions || [], user.grants || []);

  // ---- the header: which workspace this is, and who is signed in
  const pill = $(".app-top .pill");
  if (pill) pill.textContent = ws.title;
  const h1 = $(".app-top h1");
  if (h1 && !$(".top-identity")) {
    const p = document.createElement("p");
    p.className = "top-identity";
    h1.after(p);
  }
  const who = $(".top-identity");
  if (who) who.textContent = identityLine(user);
  const sideMeta = $("#sideMeta");
  if (sideMeta) sideMeta.textContent = identityLine(user);

  // ---- My profile is on every dashboard
  const main = $(".app-main");
  if (main && !$('.dash-page[data-page="profile"]')) {
    const sec = document.createElement("section");
    sec.className = "dash-page";
    sec.dataset.page = "profile";
    sec.hidden = true;
    main.appendChild(sec);
  }

  // ---- the menu
  const items = groups.flatMap((g) => g.items);
  const saved = readJson(navKey(wsId), null);
  const many = items.length > 14;
  nav.setAttribute("aria-label", `${ws.title} menu`);
  nav.innerHTML = groups.map((g, gi) => {
    const open = saved ? !saved.includes(g.label) : !many || gi === 0;
    return `<div class="side-section${open ? " open" : ""}" data-group="${escText(g.label)}">
      <button type="button" class="side-group-btn" aria-expanded="${open}"><span>${escText(g.label)}</span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <div class="side-items">${g.items.map((it) => {
        const badge = it.badge ? `<span class="nav-badge" data-badge="${it.badge}" hidden></span>` : "";
        const label = `<span class="side-label">${escText(it.label)}</span>`;
        if (it.action === "sync") return `<a class="side-link" href="#" data-open-sync-center title="${escText(it.label)}">${iconSvg(it.icon)}${label}${badge}</a>`;
        if (it.action === "notifications") return `<a class="side-link" href="#" data-open-notifications title="${escText(it.label)}">${iconSvg(it.icon)}${label}${badge}</a>`;
        const href = it.hash || `#${it.page}`;
        return `<a class="side-link" href="${escText(href)}" data-page="${it.page}"${it.hash ? " data-view" : ""} title="${escText(it.label)}">${iconSvg(it.icon)}${label}${badge}</a>`;
      }).join("")}</div></div>`;
  }).join("") + `<button type="button" class="side-rail-btn" title="Collapse the menu" aria-label="Collapse the menu">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span class="side-label">Collapse menu</span></button>`;

  // Expand / collapse a group (remembered per workspace on this device).
  nav.addEventListener("click", (e) => {
    const btn = e.target.closest(".side-group-btn");
    if (btn) {
      const sec = btn.closest(".side-section");
      const open = !sec.classList.contains("open");
      sec.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
      writeJson(navKey(wsId), $$(".side-section:not(.open)", nav).map((s) => s.dataset.group));
      return;
    }
    if (e.target.closest(".side-rail-btn")) {
      const rail = !$(".app-shell").classList.contains("nav-rail");
      $(".app-shell").classList.toggle("nav-rail", rail);
      try { localStorage.setItem("hpf_nav_rail", rail ? "1" : "0"); } catch { /* ignore */ }
      return;
    }
    if (e.target.closest("[data-open-notifications]")) { e.preventDefault(); openNotifications(); }
  });
  try { if (localStorage.getItem("hpf_nav_rail") === "1") $(".app-shell")?.classList.add("nav-rail"); } catch { /* ignore */ }

  // ---- which pages this person may open
  const allowed = new Set([...items.map((i) => i.page).filter(Boolean), "profile"]);
  const landing = items.find((i) => i.page)?.page || "profile";
  const pages = $$(".app-main .dash-page[data-page]");
  const links = $$(".side-link[data-page]", nav);
  const filterBar = $(".filter-bar");
  const parse = () => {
    let raw = decodeURIComponent((location.hash || "").slice(1));
    const [first] = raw.split("?");
    if (ws.aliases?.[first]) { raw = ws.aliases[first]; history.replaceState(null, "", `#${raw}`); }
    const [page, qs] = raw.split("?");
    return { raw, page, params: new URLSearchParams(qs || "") };
  };
  function show() {
    let { raw, page, params } = parse();
    if (!allowed.has(page)) {
      if (page) toast("That page isn't part of your workspace", "You've been taken to your own start page.", "error");
      history.replaceState(null, "", `#${landing}`);
      ({ raw, page, params } = { raw: landing, page: landing, params: new URLSearchParams() });
    }
    pages.forEach((p) => { p.hidden = p.dataset.page !== page; });
    const exact = links.find((l) => l.getAttribute("href") === `#${raw}`) ||
      links.find((l) => l.dataset.page === page && !l.hasAttribute("data-view"));
    links.forEach((l) => { l.classList.toggle("active", l === exact); l.toggleAttribute("aria-current", l === exact); });
    const sec = exact?.closest(".side-section");
    if (sec && !sec.classList.contains("open")) { sec.classList.add("open"); sec.querySelector(".side-group-btn")?.setAttribute("aria-expanded", "true"); }
    const item = items.find((i) => i.page === page);
    if (filterBar) filterBar.hidden = !item?.filters;
    const label = exact?.querySelector(".side-label")?.textContent.trim();
    document.title = `${page === "profile" ? "My profile" : label || item?.label || ws.title} — ${ws.title}`;
    window.scrollTo(0, 0);
    if (page === "profile") {
      import("./profile-ui.js").then((m) => m.renderProfile($('.dash-page[data-page="profile"]'), user)).catch(() => {});
    }
    // Export reports: loaded the first time a page that has it is opened.
    for (const el of $$(`.dash-page[data-page="${page}"] [data-export-center]:not([data-mounted])`)) {
      el.dataset.mounted = "1";
      import("./reports-ui.js").then((m) => m.mountExportCenter(el)).catch(() => { delete el.dataset.mounted; });
    }
    pageHandler?.(page, params);
  }
  window.addEventListener("hashchange", show);
  show();

  // ---- badges: what's waiting, only the counts this person may see
  async function badges() {
    if (!navigator.onLine) return;
    let b;
    try { b = (await rawRequest("GET", "/nav/badges")).badges || {}; } catch { return; }
    for (const el of $$("[data-badge]", nav)) {
      const n = Number(b[el.dataset.badge] || 0);
      el.hidden = !n;
      el.textContent = n > 99 ? "99+" : String(n);
    }
  }
  setTimeout(badges, 1500);
  setInterval(() => { if (document.visibilityState === "visible") badges(); }, 5 * 60_000);
  window.addEventListener("online", () => setTimeout(badges, 2000));
  document.addEventListener("hpf-notifications-read", badges);

  return { allowed, landing, workspace: wsId, refreshBadges: badges, canOpen: (page) => allowed.has(page) };
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
  // the page it just navigated to (the menu is built after sign-in).
  $(".side-nav")?.addEventListener("click", (e) => { if (e.target.closest(".side-link")) closeMenu(); });
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
