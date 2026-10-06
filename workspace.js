/* The four management workspaces — platform.html (Super Admin), admin.html
   (Admin), me.html (M&E) and education.html (Education Team) — share their
   pages: workspace.html holds them once. The build puts its markup into
   this script's chunk (no separate download, versioned with the code);
   this puts it into the page, then starts the console (console.js), which
   signs the person in, checks this is their workspace and builds their
   own menu (navigation.js). */
import html from "./workspace.html?raw";

document.body.insertAdjacentHTML("afterbegin", html);
import("./console.js").catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin",
    `<div style="max-width:32rem;margin:4rem auto;padding:0 1rem;font-family:system-ui,sans-serif">
      <h1 style="font-size:1.3rem">The portal couldn't load</h1>
      <p>Check your connection and <a href="">try again</a>.</p></div>`);
});
