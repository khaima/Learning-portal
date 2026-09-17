/* ============================================================
   HPF Digital Learning Portal — dashboard side-nav + top bar.

   Two nav styles, picked automatically per dashboard:

   - "Paged" (opt-in): the side-nav links and top-level sections carry
     matching data-page attributes. Clicking a link shows only that
     section — a real separate view, not a scroll position — and the
     choice lives in the URL hash (#digital-library) so reload/back/
     forward and sharing a link to a specific page all work. The
     Education Team dashboard uses this.
   - Classic scroll+flash (everyone else, unchanged): the dashboards are
     one continuous scrolling page and a sidebar click jumps to (and
     briefly highlights) the matching section by heading text.

   Either way this also gives the notification bell something to do.
   Imported by every dashboard JS.
   ============================================================ */

import { $, $$, toast } from "./util.js";
import { startLibraryInteraction, completeLibraryInteraction } from "./store.js";
import { openViewer, openYouTubeViewer, viewableKind } from "./viewer.js";

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
    startLibraryInteraction(itemId)
      .then((interaction) => {
        const id = interaction?.id;
        openYouTubeViewer(
          { title: link.dataset.itemTitle || "", embedUrl: ytEmbed },
          () => { if (id) completeLibraryInteraction(id).catch(() => {}); },
        );
      })
      .catch(() => window.open(link.href, "_blank", "noopener"));
    return;
  }

  if (viewableKind(fileName)) {
    e.preventDefault();
    startLibraryInteraction(itemId)
      .then((interaction) => {
        const id = interaction?.id;
        const opened = openViewer(
          { title: link.dataset.itemTitle || fileName, url: link.href, name: fileName },
          () => { if (id) completeLibraryInteraction(id).catch(() => {}); },
        );
        if (!opened) window.open(link.href, "_blank", "noopener"); // shouldn't happen; safety net
      })
      .catch(() => window.open(link.href, "_blank", "noopener")); // tracking failed — still let them read it
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

/* ---------------------------------------------------------------- classic scroll+flash dashboards */
if (!pageLinks.length) {

/* nav label (lowercased) -> heading substrings to look for in a section */
const HEADING_MATCH = {
  "my classes": ["my classes", "classes"],
  "classes": ["classes"],
  "assignments": ["assignments", "this week"],
  "assessments": ["recent results", "results", "assessment"],
  "my results": ["recent results", "results", "this week"],
  "digital library": ["digital library", "from the digital library", "content library"],
  "teacher resources": ["teacher resources"],
  "forms & feedback": ["forms", "your forms"],
  "termly returns": ["termly returns"],
  "field visits": ["recent field visits", "field visits"],
  "field reports": ["field report", "recent field reports", "new field report"],
  "field surveys": ["field surveys"],
  "survey results": ["survey results"],
};
/* fallbacks for sections whose heading is dynamic or absent */
const SELECTOR_FALLBACK = {
  "my classes": ["#classGrid", "#classList"],
  "classes": ["#classGrid", "#classList"],
  "my results": [".hero-progress", "#resultList"],
  "assessments": ["#resultList"],
};

const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

function sectionFor(label) {
  const key = norm(label);
  if (key === "dashboard" || key === "overview") return null; // -> top
  const wants = HEADING_MATCH[key] || [key.split(/\s|&/)[0]];

  const sections = $$(".app-main .panel, .app-main .hero-progress, .app-main > div > .panel");
  for (const s of sections) {
    const h = norm(s.querySelector("h2, h1")?.textContent);
    if (h && wants.some((w) => h.includes(w))) return s;
  }
  for (const sel of SELECTOR_FALLBACK[key] || []) {
    const el = $(sel);
    if (el) return el.closest(".panel, .card-grid, .hero-progress") || el;
  }
  return null;
}

const links = $$(".side-nav .side-link");

function goTo(link) {
  links.forEach((l) => l.classList.toggle("active", l === link));
  $$(".app-main .nav-flash").forEach((p) => p.classList.remove("nav-flash"));
  const target = sectionFor(link.textContent);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    void target.offsetWidth; // restart the highlight animation
    target.classList.add("nav-flash");
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

links.forEach((link) => {
  link.setAttribute("role", "link");
  link.setAttribute("tabindex", "0");
  link.addEventListener("click", () => goTo(link));
  link.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goTo(link); }
  });
});

} // !pageLinks.length

/* notification bell — nothing to notify about yet, but it responds */
const bell = $(".app-top-actions .icon-btn");
if (bell) {
  bell.addEventListener("click", () => {
    bell.querySelector(".dot")?.remove();
    toast("You're all caught up", "No new notifications.");
  });
}
