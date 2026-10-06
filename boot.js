/* ============================================================
   HPF Digital Learning Portal — the sign-in page's first moments.

   A small classic script (not a module), loaded at the end of index.html
   before index.js, so it runs at once even on a slow connection. It's a
   file rather than inline code so the Content-Security-Policy can allow
   scripts from the portal only (vercel.json).
   ============================================================ */
(function () {
  /* The fonts load without holding up the page (media="print" until they
     arrive, then for every medium); the page shows in system fonts first. */
  var font = document.querySelector("link[data-font]");
  if (font) {
    if (font.sheet) font.media = "all";
    else font.addEventListener("load", function () { font.media = "all"; });
  }

  /* Show the role tiles at once — unless there's a session or a sign-in
     link to check first. */
  try {
    var stored = function (st) {
      for (var i = 0; i < st.length; i++) {
        var k = st.key(i);
        if (k === "hpf_learner_token" || /^sb-.+-auth-token$/.test(k)) return true;
      }
      return false;
    };
    if (!/[?&](code|flow|invite|error)=/.test(location.search) && !stored(localStorage) && !stored(sessionStorage)) {
      document.getElementById("stepLoading").hidden = true;
      document.getElementById("stepRole").hidden = false;
      document.querySelector(".gate-card").setAttribute("data-step", "role");
    }
  } catch (e) { /* storage blocked: wait for index.js */ }

  /* On a slow connection the page's code can take a while; if it hasn't
     started after 12 seconds, say so, with a way to try again. */
  var retry = document.getElementById("gateRetry");
  if (retry) retry.addEventListener("click", function () { location.reload(); });
  setTimeout(function () {
    if (!window.__hpfReady) document.getElementById("gateSlow").hidden = false;
  }, 12000);
})();
