/* ============================================================
   HPF Digital Learning Portal — the build (Vite).

   The app is still plain HTML pages and ES modules; the build only
   bundles, minifies and fingerprints them:
   - one entry per page (index, learner, teacher, leader, field, and the
     four management workspaces, which share workspace.js);
   - code-split: what a page imports with import() (the console's
     feature modules, the sign-in library, exports…) is its own file,
     downloaded the first time it's needed;
   - every built file's name carries a hash of its content
     (dist/static/name-[hash].js), so browsers can keep it for a year;
   - public/ (the 404 page, robots.txt, the app manifest and icons) is
     copied as it is.
   scripts/build-sw.mjs then writes the service worker from the output.

   Relative paths (base "./"), so the same build works at the site root
   (Vercel) and under /Learning-portal/ (GitHub Pages).
   ============================================================ */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;
// Every page; workspace.html is markup the workspace pages pull in (workspace.js), not a page.
const pages = readdirSync(root).filter((f) => f.endsWith(".html") && f !== "workspace.html");

/* The stylesheet is the one file that holds up a page's first paint. Vite
   puts the stylesheet links after the scripts and their preloads, so on a
   slow line the JavaScript would be queued ahead of it: ask for it first. */
const stylesheetsFirst = {
  name: "hpf-stylesheets-first",
  transformIndexHtml: {
    order: "post",
    handler(html) {
      const sheets = html.match(/[ \t]*<link rel="stylesheet" crossorigin href="[^"]+\.css">\n?/g) ?? [];
      if (!sheets.length || html.search(/<script type="module" crossorigin/) < 0) return html;
      let out = html;
      for (const tag of sheets) out = out.replace(tag, "");
      const at = out.search(/[ \t]*<script type="module" crossorigin/);
      return out.slice(0, at) + sheets.join("") + out.slice(at);
    },
  },
};

export default defineConfig({
  base: "./",
  plugins: [stylesheetsFirst],
  publicDir: "public",
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "static",
    // Older phones in schools: ES2020 (Chrome 80, Safari 14) rather than the newest syntax.
    target: "es2020",
    // build-sw.mjs reads it to know which files the sign-in page needs.
    manifest: true,
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p.replace(/\.html$/, ""), resolve(root, p)])),
      output: {
        // base.css — the stylesheet every page links — is attached by the
        // bundler to its shared helper chunk and would be named after it;
        // call it what it is. (app.css keeps its own name.)
        assetFileNames: (asset) => (asset.names?.includes("preload-helper.css")
          ? "static/base-[hash][extname]"
          : "static/[name]-[hash][extname]"),
      },
    },
  },
});
