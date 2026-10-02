/* ============================================================
   HPF Digital Learning Portal — make the app available offline.
   Registers the service worker (sw.js), which keeps the pages and
   scripts on this device so the portal opens without a connection.
   ============================================================ */

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("offline app not available:", err?.message));
  });
}
