/* ============================================================
   HPF Digital Learning Portal — the dashboards' Dark / Light mode.

   Dark — navy, after the programme's reference dashboard — is the default;
   the button in the top bar switches every dashboard to Light and back.
   The choice is kept on this device: it's a way of viewing, nothing more
   (a private window that can't keep it still switches, for the visit).
   Only the dashboards change (app.css .dash-screen): forms, lists and every
   other page keep the portal's own theme. The button shows only while the
   page on screen is a dashboard.
   ============================================================ */

const KEY = "hpf.dashMode";
let current = (() => {
  try { return localStorage.getItem(KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
})();

function paint() {
  document.documentElement.dataset.dash = current;
  const btn = document.getElementById("dashMode");
  if (!btn) return;
  const next = current === "dark" ? "light" : "dark";
  const word = btn.querySelector(".dm-word");
  if (word) word.textContent = current === "dark" ? "Dark" : "Light";
  btn.title = `Dashboards: ${current} mode. Switch to ${next}`;
  btn.setAttribute("aria-label", `Dashboards in ${current} mode. Switch to ${next} mode`);
}

let wired = false;
/** Paints the mode now (before the first dashboard draws) and wires the button, once. */
export function wireDashMode() {
  paint();
  if (wired) return;
  wired = true;
  document.getElementById("dashMode")?.addEventListener("click", () => {
    current = current === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, current); } catch { /* not kept: this visit only */ }
    paint();
  });
}

/** Shows the button only on a dashboard (a page whose screen is .dash-screen). */
export function showDashMode(section) {
  const btn = document.getElementById("dashMode");
  if (btn) btn.hidden = !(section && (section.matches(".dash-screen") || section.querySelector(".dash-screen")));
}
