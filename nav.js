/* ============================================================
   HPF Digital Learning Portal — dashboard side-nav + top bar.

   The dashboards are single scrolling pages. This makes the sidebar
   links jump to (and highlight) their matching section, and gives the
   notification bell something to do. Imported by every dashboard JS.
   ============================================================ */

import { $, $$, toast } from "./util.js";

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

/* notification bell — nothing to notify about yet, but it responds */
const bell = $(".app-top-actions .icon-btn");
if (bell) {
  bell.addEventListener("click", () => {
    bell.querySelector(".dot")?.remove();
    toast("You're all caught up", "No new notifications.");
  });
}
