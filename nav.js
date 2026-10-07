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
import { ICON, menuFor, ROLE_WORKSPACE, WORKSPACES, workspacesFor } from "./navigation.js";
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

   The sidebar has one row per entry; a module's other pages are tabs drawn
   above the page, under a breadcrumb (Workspace › Module › Tab).

   A page is shown only if it's in that person's menu — a row or a tab: an
   address for any other page (typed, bookmarked, or left over from another
   role) goes to their own landing page instead. That's the screen; the API checks every
   request again. The current page is the URL hash (#users, or
   #users?role=teacher for a filtered view) and the highlighted link, so
   reload / back / forward and shared links all agree. */
const iconSvg = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICON[name] ?? ICON.dashboard}</svg>`;
const escText = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const hrefOf = (it) => it.hash || `#${it.page}`;
const badgeText = (n) => (!n ? "" : n > 99 ? "99+" : String(n));

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

/* Under the person's name: their profile, notifications (also the bell),
   the Sync center (also the sync chip), and Sign out — the same on every
   dashboard, so none of it takes a row in the menu. */
function mountAccountMenu() {
  const menu = $("#sideMenu");
  if (!menu || menu.querySelector("[data-account-links]")) return;
  const box = document.createElement("div");
  box.className = "side-menu-links";
  box.dataset.accountLinks = "";
  box.innerHTML = `
    <a class="side-menu-link" href="#profile">${iconSvg("user")}My profile</a>
    <a class="side-menu-link" href="#" data-open-notifications>${iconSvg("bell")}Notifications</a>
    <a class="side-menu-link" href="#" data-open-sync-center>${iconSvg("sync")}Sync center</a>`;
  menu.prepend(box);
  menu.addEventListener("click", (e) => {
    if (e.target.closest("[data-open-notifications]")) { e.preventDefault(); openNotifications(); }
    if (e.target.closest("a")) { menu.hidden = true; $("#sideUserBtn")?.setAttribute("aria-expanded", "false"); }
  });
}

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
  mountAccountMenu();

  // ---- My profile is on every dashboard
  const main = $(".app-main");
  if (main && !$('.dash-page[data-page="profile"]')) {
    const sec = document.createElement("section");
    sec.className = "dash-page";
    sec.dataset.page = "profile";
    sec.hidden = true;
    main.appendChild(sec);
  }

  // ---- the menu: one row per entry; a module's other pages are its tabs.
  // Someone who may open more than one workspace (a Super Admin) switches
  // between them here — the operational areas stay out of their own menu.
  const items = groups.flatMap((g) => g.items);
  const switchable = workspacesFor(user.role);
  nav.setAttribute("aria-label", `${ws.title} menu`);
  nav.innerHTML = (switchable.length > 1 ? `
    <details class="ws-switch">
      <summary title="Switch workspace">${iconSvg("layers")}<span class="side-label"><small>Workspace</small>${escText(ws.title)}</span></summary>
      <div class="ws-list">${switchable.map((id) => id === wsId
        ? `<span class="ws-link current" aria-current="page">${escText(WORKSPACES[id].title)}</span>`
        : `<a class="ws-link" href="${escText(WORKSPACES[id].page)}">${escText(WORKSPACES[id].title)}</a>`).join("")}</div>
    </details>` : "")
    + `<div class="side-items">${groups.map((g) => {
      const badge = g.badge ? `<span class="nav-badge" data-badge="${escText(g.badge)}" hidden></span>` : "";
      return `<a class="side-link" href="${escText(hrefOf(g.items[0]))}" data-entry="${escText(g.id)}" title="${escText(g.label)}">${iconSvg(g.icon)}<span class="side-label">${escText(g.label)}</span>${badge}</a>`;
    }).join("")}</div>`
    + `<button type="button" class="side-rail-btn" title="Collapse the menu" aria-label="Collapse the menu">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span class="side-label">Collapse menu</span></button>`;

  nav.addEventListener("click", (e) => {
    if (e.target.closest(".side-rail-btn")) {
      const rail = !$(".app-shell").classList.contains("nav-rail");
      $(".app-shell").classList.toggle("nav-rail", rail);
      try { localStorage.setItem("hpf_nav_rail", rail ? "1" : "0"); } catch { /* ignore */ }
    }
  });
  try { if (localStorage.getItem("hpf_nav_rail") === "1") $(".app-shell")?.classList.add("nav-rail"); } catch { /* ignore */ }

  // ---- where you are: a breadcrumb, and a module's tabs, above the page
  let trail = $(".page-trail");
  if (!trail && main) {
    trail = document.createElement("nav");
    trail.className = "page-trail";
    trail.setAttribute("aria-label", "Where you are");
    ($(".app-top", main) ?? main.firstElementChild)?.after(trail);
  }
  const badgeCounts = {};
  const badgeHtml = (key) => (key ? `<span class="nav-badge" data-badge="${escText(key)}"${badgeCounts[key] ? "" : " hidden"}>${escText(badgeText(badgeCounts[key]))}</span>` : "");
  function drawTrail(g, item, raw, page) {
    if (!trail) return;
    const home = groups[0];
    if (page === "profile") {
      trail.hidden = false;
      trail.innerHTML = `<ol class="crumbs"><li><a href="${escText(hrefOf(home.items[0]))}">${escText(ws.title)}</a></li><li aria-current="page">My profile</li></ol>`;
      return;
    }
    if (!g || (g === home && g.items.length === 1)) { trail.hidden = true; trail.innerHTML = ""; return; }
    const isModule = g.items.length > 1;
    // "My schools › My schools" says nothing twice: a tab named like its module ends the trail at the module.
    const deeper = isModule && item && item.label !== g.label;
    const crumbs = [
      `<li><a href="${escText(hrefOf(home.items[0]))}">${escText(ws.title)}</a></li>`,
      deeper ? `<li><a href="${escText(hrefOf(g.items[0]))}">${escText(g.label)}</a></li>` : `<li aria-current="page">${escText(g.label)}</li>`,
      ...(deeper ? [`<li aria-current="page">${escText(item.label)}</li>`] : []),
    ];
    trail.hidden = false;
    trail.innerHTML = `<ol class="crumbs">${crumbs.join("")}</ol>` + (isModule ? `<div class="module-tabs">${g.items.filter((it) => !it.hidden || it === item).map((it) => {
      const on = it === item;
      return `<a class="module-tab${on ? " active" : ""}" href="${escText(hrefOf(it))}"${on ? ' aria-current="page"' : ""}>${iconSvg(it.icon)}<span>${escText(it.label)}</span>${badgeHtml(it.badge)}</a>`;
    }).join("")}</div>` : "");
  }

  // ---- which pages this person may open: every item of every entry
  const allowed = new Set([...items.map((i) => i.page).filter(Boolean), "profile"]);
  const landing = items.find((i) => i.page)?.page || "profile";
  const pages = $$(".app-main .dash-page[data-page]");
  const entryLinks = $$(".side-link[data-entry]", nav);
  const filterBar = $(".filter-bar");
  const parse = () => {
    let raw = decodeURIComponent((location.hash || "").slice(1));
    const [first] = raw.split("?");
    if (ws.aliases?.[first]) { raw = ws.aliases[first]; history.replaceState(null, "", `#${raw}`); }
    const [page, qs] = raw.split("?");
    return { raw, page, params: new URLSearchParams(qs || "") };
  };
  /** The entry and item this address belongs to: an exact filtered view first, then the page itself. */
  const locate = (page, raw) => {
    for (const g of groups) { const it = g.items.find((i) => hrefOf(i) === `#${raw}`); if (it) return [g, it]; }
    for (const g of groups) { const it = g.items.find((i) => i.page === page && !i.hash) ?? g.items.find((i) => i.page === page); if (it) return [g, it]; }
    return [null, null];
  };
  function show() {
    let { raw, page, params } = parse();
    if (!allowed.has(page)) {
      if (page) toast("That page isn't part of your workspace", "You've been taken to your own start page.", "error");
      history.replaceState(null, "", `#${landing}`);
      ({ raw, page, params } = { raw: landing, page: landing, params: new URLSearchParams() });
    }
    pages.forEach((p) => { p.hidden = p.dataset.page !== page; });
    const [g, item] = page === "profile" ? [null, null] : locate(page, raw);
    entryLinks.forEach((l) => { const on = l.dataset.entry === g?.id; l.classList.toggle("active", on); l.toggleAttribute("aria-current", on); });
    drawTrail(g, item, raw, page);
    if (filterBar) filterBar.hidden = !item?.filters;
    const title = page === "profile" ? "My profile" : g && g.items.length > 1 && item?.label !== g.label ? `${item?.label} — ${g.label}` : g?.label;
    document.title = `${title || ws.title} — ${ws.title}`;
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

  // ---- badges: what's waiting, only the counts this person may see (menu rows and tabs)
  async function badges() {
    if (!navigator.onLine) return;
    let b;
    try { b = (await rawRequest("GET", "/nav/badges")).badges || {}; } catch { return; }
    Object.assign(badgeCounts, b);
    for (const el of $$("[data-badge]")) {
      const n = Number(badgeCounts[el.dataset.badge] || 0);
      el.hidden = !n;
      el.textContent = badgeText(n);
    }
  }
  setTimeout(badges, 1500);
  setInterval(() => { if (document.visibilityState === "visible") badges(); }, 5 * 60_000);
  window.addEventListener("online", () => setTimeout(badges, 2000));
  document.addEventListener("hpf-notifications-read", badges);

  return { allowed, landing, workspace: wsId, refreshBadges: badges, canOpen: (page) => allowed.has(page) };
}
/** A page that goes deeper than its menu — a school inside Schools — adds
    its own steps to the breadcrumb: "Schools › Aitong Primary › Teachers".
    The step it came from becomes a link back. Cleared on the next page. */
export function extendTrail(parts) {
  const ol = $(".page-trail .crumbs");
  if (!ol) return;
  ol.querySelectorAll("[data-extra]").forEach((li) => li.remove());
  const last = ol.querySelector("li[aria-current]");
  if (last && parts.length) {
    last.removeAttribute("aria-current");
    last.innerHTML = `<a href="#${escText((location.hash.slice(1) || "").split("?")[0])}">${escText(last.textContent)}</a>`;
  }
  parts.forEach((p, i) => {
    const li = document.createElement("li");
    li.dataset.extra = "";
    const end = i === parts.length - 1;
    if (end) li.setAttribute("aria-current", "page");
    li.innerHTML = p.href && !end ? `<a href="${escText(p.href)}">${escText(p.label)}</a>` : escText(p.label);
    ol.appendChild(li);
  });
}

/* notification bell — stored notifications, unread count, the list (notify-ui.js) */
mountBell();

/* ---------------------------------------------------------------- mobile nav drawer
   Below 860px the sidebar (.app-side, app.css) goes off-canvas rather
   than just disappearing — this is the one place that's wired, so every
   dashboard's mobile menu is the same implementation, not five copies.
   Built here instead of in each HTML file: .app-top's own layout
   (title block, then .app-top-actions, space-between) is untouched —
   the button is inserted as a sibling in front of the title block, and
   stays display:none above 860px (app.css), so nothing shifts on
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
