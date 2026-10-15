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

   The sidebar has one row per area; an area with several pages opens in
   place to list them. Above each page, a breadcrumb (Workspace › Area › Page).

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
/** A link from a dashboard to a detail page, saying which dashboard it came
    from (`via`): the page's breadcrumb then leads back there. */
export function withVia(href, via) {
  if (!href || !via || !href.startsWith("#")) return href;
  return `${href}${href.includes("?") ? "&" : "?"}via=${encodeURIComponent(via)}`;
}
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
  // On the start page the header greets the person and says who they are;
  // on every other page it names the page and says what it is for, so
  // nobody has to work out where they are from the breadcrumb.
  const homeHead = [h1, who, $("#topSub")].filter(Boolean);
  let pageHead = $(".top-page");
  if (h1 && !pageHead) {
    pageHead = document.createElement("div");
    pageHead.className = "top-page";
    pageHead.hidden = true;
    pageHead.innerHTML = `<h1 class="top-title"></h1><p class="top-purpose"></p>`;
    h1.before(pageHead);
  }
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

  // ---- the menu: a row per area. An area with one page is a link; an area
  // with several opens in place to list them — the one you're in is open,
  // and any you open stay open (remembered per workspace). On the collapsed
  // icon rail an area's pages appear beside it on hover or focus; in the
  // phone drawer the areas open in place. Someone who may open more than
  // one workspace (a Super Admin) switches between them at the top.
  const items = groups.flatMap((g) => g.items);
  const switchable = workspacesFor(user.role);
  const OPEN_KEY = `hpf_nav_open_${wsId}`;
  let opened;
  try { opened = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")); } catch { opened = new Set(); }
  const saveOpened = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...opened])); } catch { /* ignore */ } };
  const badgeCounts = {};
  const badgeHtml = (key) => (key ? `<span class="nav-badge" data-badge="${escText(key)}"${badgeCounts[key] ? "" : " hidden"}>${escText(badgeText(badgeCounts[key]))}</span>` : "");
  const chevron = `<svg class="icon chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
  nav.setAttribute("aria-label", `${ws.title} menu`);
  nav.innerHTML = (switchable.length > 1 ? `
    <details class="ws-switch">
      <summary title="Switch workspace">${iconSvg("layers")}<span class="side-label"><small>Workspace</small>${escText(ws.title)}</span></summary>
      <div class="ws-list">${switchable.map((id) => id === wsId
        ? `<span class="ws-link current" aria-current="page">${escText(WORKSPACES[id].title)}</span>`
        : `<a class="ws-link" href="${escText(WORKSPACES[id].page)}">${escText(WORKSPACES[id].title)}</a>`).join("")}</div>
    </details>` : "")
    + `<ul class="side-items">${groups.map((g) => {
      const label = escText(g.label);
      if (g.items.length === 1) {
        return `<li class="side-entry" data-entry="${escText(g.id)}"><a class="side-link" href="${escText(hrefOf(g.items[0]))}" title="${label}">${iconSvg(g.icon)}<span class="side-label">${label}</span>${badgeHtml(g.badge || g.items[0].badge)}</a></li>`;
      }
      const sub = `side-sub-${escText(g.id)}`;
      return `<li class="side-entry has-sub" data-entry="${escText(g.id)}">
        <button type="button" class="side-link side-toggle" aria-expanded="false" aria-controls="${sub}" title="${label}">${iconSvg(g.icon)}<span class="side-label">${label}</span>${badgeHtml(g.badge)}${chevron}</button>
        <ul class="side-sub" id="${sub}"><li class="side-sub-title" aria-hidden="true">${label}</li>${g.items.map((it, i) =>
          `<li${it.hidden ? " hidden" : ""}><a class="side-sublink" href="${escText(hrefOf(it))}" data-item="${i}">${escText(it.label)}${badgeHtml(it.badge)}</a></li>`).join("")}</ul>
      </li>`;
    }).join("")}</ul>`
    + `<button type="button" class="side-rail-btn" title="Collapse the menu" aria-label="Collapse the menu">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span class="side-label">Collapse menu</span></button>`;

  const setOpen = (li, on) => {
    li.classList.toggle("open", on);
    li.querySelector(":scope > .side-toggle")?.setAttribute("aria-expanded", String(on));
  };
  nav.addEventListener("click", (e) => {
    const toggle = e.target.closest(".side-toggle");
    if (toggle) {
      const li = toggle.closest(".side-entry");
      const on = !li.classList.contains("open");
      setOpen(li, on);
      if (on) opened.add(li.dataset.entry); else opened.delete(li.dataset.entry);
      saveOpened();
      return;
    }
    if (e.target.closest(".side-rail-btn")) {
      const rail = !$(".app-shell").classList.contains("nav-rail");
      $(".app-shell").classList.toggle("nav-rail", rail);
      try { localStorage.setItem("hpf_nav_rail", rail ? "1" : "0"); } catch { /* ignore */ }
    }
  });
  try { if (localStorage.getItem("hpf_nav_rail") === "1") $(".app-shell")?.classList.add("nav-rail"); } catch { /* ignore */ }

  // ---- where you are: a breadcrumb above the page (Workspace › Area › Page)
  let trail = $(".page-trail");
  if (!trail && main) {
    trail = document.createElement("nav");
    trail.className = "page-trail";
    trail.setAttribute("aria-label", "Where you are");
    ($(".app-top", main) ?? main.firstElementChild)?.after(trail);
  }
  function drawTrail(g, item, page, via = null) {
    if (!trail) return;
    const home = groups[0];
    // Opened from a dashboard: the trail is the way back to it — the dashboard
    // keeps the county, school and dates it had.
    if (via) {
      const [vg, vi] = via;
      const viaDeeper = vg.items.length > 1 && vi.label !== vg.label && vg !== home;
      trail.hidden = false;
      trail.innerHTML = `<ol class="crumbs">${[
        `<li><a href="${escText(hrefOf(home.items[0]))}">${escText(ws.title)}</a></li>`,
        ...(viaDeeper ? [`<li><a href="${escText(hrefOf(vg.items[0]))}">${escText(vg.label)}</a></li>`] : []),
        vg === home && vg.items.length === 1 ? "" : `<li><a href="${escText(hrefOf(vi))}">${escText(vi.label)}</a></li>`,
        `<li aria-current="page">${escText(item?.label || g?.label || page)}</li>`,
      ].join("")}</ol>`;
      return;
    }
    if (page === "profile") {
      trail.hidden = false;
      trail.innerHTML = `<ol class="crumbs"><li><a href="${escText(hrefOf(home.items[0]))}">${escText(ws.title)}</a></li><li aria-current="page">My profile</li></ol>`;
      return;
    }
    if (!g || (g === home && g.items.length === 1)) { trail.hidden = true; trail.innerHTML = ""; return; }
    // An area's page named like the area ("My visits") ends the trail at the area.
    const deeper = g.items.length > 1 && item && item.label !== g.label;
    const crumbs = [
      `<li><a href="${escText(hrefOf(home.items[0]))}">${escText(ws.title)}</a></li>`,
      deeper ? `<li><a href="${escText(hrefOf(g.items[0]))}">${escText(g.label)}</a></li>` : `<li aria-current="page">${escText(g.label)}</li>`,
      ...(deeper ? [`<li aria-current="page">${escText(item.label)}</li>`] : []),
    ];
    trail.hidden = false;
    trail.innerHTML = `<ol class="crumbs">${crumbs.join("")}</ol>`;
  }

  // ---- which pages this person may open: every item of every entry
  const allowed = new Set([...items.map((i) => i.page).filter(Boolean), "profile"]);
  const landing = items.find((i) => i.page)?.page || "profile";
  const pages = $$(".app-main .dash-page[data-page]");
  const entries = $$(".side-entry", nav);
  const byEntry = new Map(groups.map((gr) => [gr.id, gr]));
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
    // The area you're in is marked and open; inside it, the page you're on.
    for (const li of entries) {
      const here = li.dataset.entry === g?.id;
      li.classList.toggle("current", here);
      if (!li.classList.contains("has-sub")) {
        const link = li.querySelector(":scope > .side-link");
        if (here) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
        continue;
      }
      setOpen(li, here || opened.has(li.dataset.entry));
      const list = byEntry.get(li.dataset.entry).items;
      const at = here ? list.indexOf(item) : -1;
      for (const a of li.querySelectorAll(".side-sublink")) {
        const i = Number(a.dataset.item);
        if (i === at) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
        // A page kept for old links is listed only while it's the one open.
        if (list[i].hidden) a.parentElement.hidden = i !== at;
      }
    }
    const viaPage = params.get("via");
    const via = viaPage && viaPage !== page && allowed.has(viaPage) ? locate(viaPage, viaPage) : [null, null];
    drawTrail(g, item, page, via[0] && via[1] ? via : null);
    // The filter bar shows on the pages its filters narrow, with only the
    // filters that apply there (a page lists them, or uses all).
    if (filterBar) {
      filterBar.hidden = !item?.filters;
      const fields = Array.isArray(item?.filters) ? item.filters : null;
      for (const f of filterBar.querySelectorAll("[data-gf]")) f.classList.toggle("gf-off", !!fields && !fields.includes(f.dataset.gf));
      filterBar.dataset.fields = item?.filters ? (fields || ["county", "school", "term", "role"]).join(" ") : "";
    }
    const home = page === landing;
    const heading = page === "profile" ? "My profile" : item?.heading || item?.label || g?.label || ws.title;
    const purpose = page === "profile" ? "Your details, what your role lets you do, and your password." : item?.purpose || "";
    homeHead.forEach((el) => { el.hidden = !home; });
    if (pageHead) {
      pageHead.hidden = home;
      pageHead.querySelector(".top-title").textContent = heading;
      const p = pageHead.querySelector(".top-purpose");
      p.textContent = purpose;
      p.hidden = !purpose;
    }
    main?.classList.toggle("is-home", home);
    document.title = `${heading} — ${ws.title}`;
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
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;
  appSide.id ||= "appSide";
  menuBtn.setAttribute("aria-controls", appSide.id);

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:flex-start";
  titleBlock.replaceWith(wrap);
  wrap.append(menuBtn, titleBlock);

  const backdrop = document.createElement("div");
  backdrop.className = "side-backdrop";
  appShell.appendChild(backdrop);
  // A way out inside the drawer itself, as well as tapping beside it.
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "side-close";
  closeBtn.setAttribute("aria-label", "Close menu");
  closeBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  appSide.prepend(closeBtn);

  // On a phone the closed drawer is off screen — and out of the keyboard's way too.
  const phone = window.matchMedia("(max-width: 860px)");
  const isOpen = () => appSide.classList.contains("is-open");
  const setInert = () => { appSide.inert = phone.matches && !isOpen(); };
  phone.addEventListener?.("change", setInert);
  const closeMenu = ({ refocus = false } = {}) => {
    if (!isOpen()) return;
    appSide.classList.remove("is-open");
    backdrop.classList.remove("is-open");
    menuBtn.setAttribute("aria-expanded", "false");
    setInert();
    if (refocus) menuBtn.focus();
  };
  menuBtn.addEventListener("click", () => {
    appSide.classList.add("is-open");
    backdrop.classList.add("is-open");
    menuBtn.setAttribute("aria-expanded", "true");
    setInert();
    // Straight to where you are in the menu.
    (appSide.querySelector('.side-nav [aria-current="page"]') || appSide.querySelector(".side-nav a, .side-nav button"))?.focus();
  });
  closeBtn.addEventListener("click", () => closeMenu({ refocus: true }));
  backdrop.addEventListener("click", () => closeMenu());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu({ refocus: true }); });
  // Picking a page closes the drawer; opening or closing an area doesn't.
  $(".side-nav")?.addEventListener("click", (e) => { if (e.target.closest("a.side-link, a.side-sublink, a.ws-link")) closeMenu(); });
  setInert();
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
