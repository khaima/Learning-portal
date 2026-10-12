/* ============================================================
   HPF Digital Learning Portal — dashboards that stay current.

   Three small pieces, used by every dashboard:

   liveStatus(hosts, { refresh, every })
     Says how fresh what's on screen is, and reads it again:
       "Live · updated just now"      it refreshes by itself, and just did
       "Updated 5 minutes ago"        read once; press Refresh for now
       "Refreshing…"                  being read
       "Couldn't refresh · updated…"  the last try failed; what's shown is older
       "Offline · updated…"           no connection
       "Saved copy · 2 hours ago" the copy kept on this device, not the latest
     "Live" is only ever shown for a dashboard that really does refresh by
     itself (`every`), while it's doing so: the page is open and in view,
     the device is online, and the last read worked.

   swap(el, html)
     Puts a new render of a dashboard in place of the old one by changing
     only what differs, so nothing flickers, scroll and open sections stay
     put, and a figure that changed is marked for a moment.

   Nothing here reads data itself: each dashboard hands in the function
   that already loads it.
   ============================================================ */

import { esc } from "./util.js";

const TICK_MS = 15_000;         // labels re-worded, and "is anything due?" asked, this often
const STALE_ON_RETURN_MS = 60_000; // coming back to a tab or page: refresh if older than this
const statuses = new Set();

/** "just now", "5 minutes ago", "2 hours ago", or the date. */
export function timeAgo(at, now = Date.now()) {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 90) return "1 minute ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = new Date(at);
  return `on ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}
const everyText = (ms) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : ms >= 60_000 ? "minute" : `${Math.round(ms / 1000)} seconds`);

const REFRESH_ICON = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;

/** What to say for a status right now. */
function wording(st, now = Date.now()) {
  const age = st.at ? `updated ${timeAgo(st.at, now)}` : "";
  const online = navigator.onLine !== false;
  if (st.busy) return { state: "busy", main: "Refreshing…", rest: "", button: "Refresh" };
  if (!st.at && !st.error) return { state: "idle", main: "", rest: "", button: "Refresh" };
  if (st.saved) {
    const when = timeAgo(st.at, now);
    return { state: online ? "saved" : "offline", main: online ? "Saved copy" : "Offline", rest: online ? when : `copy saved ${when}`, button: "Refresh",
      title: "This is the copy kept on this device, not the latest from the server" };
  }
  if (!online) return { state: "offline", main: "Offline", rest: age, button: "Refresh" };
  if (st.error) return { state: "error", main: st.at ? "Couldn't refresh" : "Couldn't load", rest: age, button: "Try again" };
  if (st.every && now - st.at <= st.every * 2 + TICK_MS) {
    return { state: "live", main: "Live", rest: age, button: "Refresh", title: `Refreshes by itself every ${everyText(st.every)} while this page is open` };
  }
  return { state: "fresh", main: age.charAt(0).toUpperCase() + age.slice(1), rest: "", button: "Refresh" };
}

function paint(st) {
  st.hosts = st.hosts.filter((h) => h.isConnected);
  const w = wording(st);
  for (const host of st.hosts) {
    let box = host.querySelector(":scope > .live");
    if (!box) {
      host.setAttribute("data-live-keep", "");
      host.innerHTML = `<span class="live"><span class="live-dot" aria-hidden="true"></span><span class="live-text"><b></b><span></span></span>
        <button type="button" class="live-btn">${REFRESH_ICON}<span></span></button></span><span class="sr-only" role="status"></span>`;
      box = host.querySelector(".live");
      box.querySelector(".live-btn").addEventListener("click", () => st.api.refresh({ asked: true }));
    }
    box.dataset.state = w.state;
    box.hidden = w.state === "idle";
    box.title = w.title || "";
    box.querySelector(".live-text b").textContent = w.main;
    box.querySelector(".live-text span").textContent = w.rest ? ` · ${w.rest}` : "";
    const btn = box.querySelector(".live-btn");
    btn.disabled = st.busy || navigator.onLine === false;
    btn.querySelector("span").textContent = w.button;
    // Read out a refresh someone asked for — starting, landing or failing —
    // not the ones that happen by themselves, nor each re-wording of the age.
    const said = host.querySelector(":scope > [role=status]");
    const announce = !st.asked ? "" : w.state === "busy" ? "Refreshing" : st.justLanded ? (st.error ? "Couldn't refresh" : "Updated") : "";
    if (said && announce && said.textContent !== announce) said.textContent = announce;
    else if (said && !announce) said.textContent = "";
  }
  if (st.justLanded) st.asked = false;
  st.justLanded = false;
}

/** A freshness line with a Refresh control, drawn into each of `hosts`
    (one dashboard can show it on several of its pages).
      refresh   reads the data again and redraws; may return { at, saved }
      every     milliseconds between automatic refreshes (0: only when asked)
      onReturn  for a page that doesn't refresh by itself: read again when the
                person comes back to it and what's shown is older than this */
export function liveStatus(hosts, { refresh, every = 0, onReturn = 0 } = {}) {
  const st = { hosts: [].concat(hosts).filter(Boolean), every, onReturn, at: 0, busy: false, error: null, saved: false, lastTry: 0, justLanded: false, asked: false };
  const api = {
    /** A read has started (for loads the page starts itself — a filter change, say). */
    start() { st.busy = true; st.lastTry = Date.now(); paint(st); },
    /** It worked: `at` is when the data is from, `saved` when it's the copy kept on this device. */
    ok({ at = Date.now(), saved = false } = {}) { Object.assign(st, { busy: false, error: null, at, saved, justLanded: true }); paint(st); },
    fail(err) { Object.assign(st, { busy: false, error: err || new Error("failed"), justLanded: true }); paint(st); },
    /** Reads again now (the button, the schedule, or the page itself). */
    async refresh({ asked = false } = {}) {
      if (st.busy || !refresh) return;
      st.asked = asked;
      api.start();
      try {
        api.ok((await refresh()) || undefined);
      } catch (err) {
        api.fail(err);
      }
    },
    /** For a page being opened again: refresh if what's shown has aged. */
    refreshIfStale(maxAge = STALE_ON_RETURN_MS) {
      if (st.at && !st.busy && Date.now() - Math.max(st.at, st.lastTry) > maxAge) api.refresh();
    },
    /** More places to show it (a page drawn later). */
    addHost(host) { if (host && !st.hosts.includes(host)) { st.hosts.push(host); paint(st); } },
    get at() { return st.at; },
    get busy() { return st.busy; },
  };
  st.api = api;
  statuses.add(st);
  paint(st);
  startTicking();
  return api;
}

const shown = (st) => st.hosts.some((h) => h.isConnected && h.offsetParent !== null);

/** Re-words every status, and refreshes the automatic ones that are due —
    only for a dashboard someone is looking at, on a device that's online. */
function tick({ returning = false } = {}) {
  const now = Date.now();
  const active = document.visibilityState === "visible" && navigator.onLine !== false;
  for (const st of statuses) {
    if (!st.hosts.some((h) => h.isConnected)) { if (st.at) statuses.delete(st); continue; }
    // A read that failed, or a saved copy, is replaced as soon as the connection or the tab comes back.
    const retry = returning && (!!st.error || st.saved);
    if (active && (st.every || retry || (returning && st.onReturn)) && !st.busy && st.at && shown(st)) {
      const due = retry ? 0 : !returning ? st.every : st.every ? Math.min(st.every, STALE_ON_RETURN_MS) : st.onReturn;
      const last = st.saved ? st.lastTry : Math.max(st.at, st.lastTry);
      if (now - last >= due) { st.api.refresh(); continue; }
    }
    paint(st);
  }
}
let ticking = false;
function startTicking() {
  if (ticking) return;
  ticking = true;
  setInterval(tick, TICK_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick({ returning: true }); });
  window.addEventListener("online", () => setTimeout(() => tick({ returning: true }), 1500));
  window.addEventListener("offline", () => tick());
}

/* ------------------------------------------------------------ in-place updates */

const FORM_CONTROLS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
const HIGHLIGHT_MS = 2200;
const MAX_HIGHLIGHTS = 16; // more than this changed at once is a different view, not an update

function syncAttributes(a, b) {
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  for (const { name } of [...a.attributes]) {
    // An open <details> stays as the person left it.
    if (!b.hasAttribute(name) && name !== "open") a.removeAttribute(name);
  }
}

/** A list whose rows carry data-key: rows are matched by key, so one new
    row at the top is one insertion — not every row below it "changing". */
function morphKeyed(a, b, changed) {
  const old = new Map([...a.children].map((k) => [k.dataset.key, k]));
  const rows = [...b.children].map((nk) => {
    const ok = old.get(nk.dataset.key);
    if (!ok) { changed.push({ added: nk }); return nk; }
    old.delete(nk.dataset.key);
    morph(ok, nk, changed);
    return ok;
  });
  if (rows.length !== a.children.length || rows.some((r, i) => r !== a.children[i])) a.replaceChildren(...rows);
}
const keyed = (el) => el.children.length > 0 && [...el.children].every((k) => k.dataset.key != null);

function morph(a, b, changed) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) {
    a.replaceWith(b);
    changed.push(b.nodeType === 1 ? b : b.parentElement);
    return;
  }
  if (a.nodeType === 3) {
    if (a.nodeValue !== b.nodeValue) { a.nodeValue = b.nodeValue; changed.push(a.parentElement); }
    return;
  }
  if (a.nodeType !== 1 || a.hasAttribute("data-live-keep") || FORM_CONTROLS.has(a.nodeName)) return;
  a.classList.remove("live-changed");
  if (a.isEqualNode(b)) return;
  syncAttributes(a, b);
  if (keyed(b) && (keyed(a) || !a.children.length)) return morphKeyed(a, b, changed);
  const was = [...a.childNodes], now = [...b.childNodes];
  if (was.length !== now.length) {
    a.replaceChildren(...now);
    changed.push(a);
    return;
  }
  for (let i = 0; i < was.length; i++) morph(was[i], now[i], changed);
}

/** Should a change be marked? A row that's new to a list is; otherwise only
    a figure — a short piece of text with a number in it ("11", "251 of 398",
    "4 checks need attention") — not a sentence that happens to mention one,
    not a time that just ticked over, and not the insides of a chart (the
    chart itself moves). */
function markable(c) {
  const el = c?.added ?? c;
  if (!el || !el.isConnected || el.closest("time, [data-live-quiet], .live, svg")) return null;
  if (c.added) return el;
  const text = el.textContent.trim();
  return text.length <= 28 && /\d/.test(text) ? el : null;
}

/** Puts `html` into `el`. The first time (or over a skeleton or an error,
    or when `replace` says this is a different view — new filters, say) it's
    simply drawn; after that only what differs is changed, and — unless
    `highlight` is false, or nearly everything changed — each changed figure
    is marked for a moment. Returns how many were marked. */
export function swap(el, html, { highlight = true, replace = false } = {}) {
  if (!el) return 0;
  const placeholder = replace || !el.firstElementChild || el.querySelector(":scope > .skeleton-list, :scope > .error-state, :scope > .empty-state") || el.dataset.liveDrawn !== "1";
  if (placeholder) {
    el.innerHTML = html;
    el.dataset.liveDrawn = "1";
    return 0;
  }
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const was = [...el.childNodes], now = [...tpl.content.childNodes];
  const changed = [];
  if (was.length !== now.length) {
    el.replaceChildren(...now);
    return 0;
  }
  for (let i = 0; i < was.length; i++) morph(was[i], now[i], changed);
  if (!highlight) return 0;
  const marks = [...new Set(changed.map(markable).filter(Boolean))];
  if (!marks.length || marks.length > MAX_HIGHLIGHTS) return 0;
  for (const m of marks) {
    m.classList.remove("live-changed");
    void m.offsetWidth; // restart the animation if it's already running
    m.classList.add("live-changed");
    setTimeout(() => m.classList.remove("live-changed"), HIGHLIGHT_MS);
  }
  return marks.length;
}

/** For a page whose own code draws straight into its elements: runs `draw`
    (which sets them), then marks what changed in each since before. */
export function redraw(els, draw) {
  const list = els.filter(Boolean);
  const before = list.map((el) => el.innerHTML);
  draw();
  list.forEach((el, i) => {
    const after = el.innerHTML;
    if (after === before[i]) return;
    el.innerHTML = before[i];
    el.dataset.liveDrawn = "1";
    swap(el, after);
  });
}

/** A time that re-wording shouldn't count as a change: "5 minutes ago" in a <time>. */
export const agoTag = (v, text) => (v ? `<time datetime="${esc(new Date(v).toISOString())}" title="${esc(new Date(v).toLocaleString())}">${esc(text)}</time>` : esc(text));
