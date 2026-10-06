/* ============================================================
   HPF Digital Learning Portal — the offline app and its updates.

   Registers the service worker (sw.js, written by the build), which keeps
   the pages and code on this device so the portal opens without a
   connection.

   A new version of the portal downloads in the background and then waits.
   When it's ready this shows "Update available — Reload"; it starts only
   when the person chooses, so nobody's page changes under them halfway
   through marking or a field visit (anything not yet sent is kept on the
   device either way). "Later" puts it off until the next check. A
   dashboard can stay open all day, so it looks for a new version when the
   tab comes back into view, and every hour.
   ============================================================ */

const CHECK_EVERY_MS = 60 * 60 * 1000;
let registration = null;
let reloading = false;

function showUpdate(worker) {
  if (document.querySelector(".update-notice")) return;
  const box = document.createElement("div");
  box.className = "update-notice";
  box.setAttribute("role", "status");
  box.innerHTML = `<span><b>Update available</b> — a new version of the portal is ready.</span>
    <button type="button" class="btn btn-primary" data-update-reload>Reload</button>
    <button type="button" class="update-later" data-update-later>Later</button>`;
  box.querySelector("[data-update-reload]").addEventListener("click", () => {
    reloading = true;
    box.querySelector("[data-update-reload]").disabled = true;
    worker.postMessage({ type: "SKIP_WAITING" }); // the new version takes over → controllerchange → reload
    setTimeout(() => location.reload(), 4000); // in case the switch-over is never reported
  });
  box.querySelector("[data-update-later]").addEventListener("click", () => box.remove());
  document.body.appendChild(box);
}

/** Watch a registration for a new version that has finished installing. */
function watch(reg) {
  // A version installed earlier (e.g. while another tab was open) is already waiting.
  if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const worker = reg.installing;
    worker?.addEventListener("statechange", () => {
      // "installed" with a controller = an update (the very first install has none).
      if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate(worker);
    });
  });
}

const checkForUpdate = () => registration?.update().catch(() => {});

if (import.meta.env.PROD && "serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then((reg) => {
        registration = reg;
        watch(reg);
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
        setInterval(checkForUpdate, CHECK_EVERY_MS);
      })
      .catch((err) => console.warn("offline app not available:", err?.message));
  });
  // A part of the page couldn't be fetched — after a new deploy the old
  // version's files are gone from the server. Look for the new version now
  // (its notice follows); the page itself reports the failed action.
  window.addEventListener("vite:preloadError", checkForUpdate);
}
