#!/usr/bin/env node
/* ============================================================
   Serves the build (dist/) the way Vercel does: the headers from
   vercel.json (CSP and the rest, caching), compressed (brotli or gzip),
   and 404.html for an unknown address. For checking a build locally —
   the service worker, the CSP, Lighthouse — before it's deployed.

     npm run build && npm run serve            # http://localhost:4173
     node scripts/serve-dist.mjs --port=5175 [--dir=some/other/build]
     node scripts/serve-dist.mjs --extra-origin=http://127.0.0.1:8787
       (adds a local test API to the CSP's connect/img/media/frame sources)
   ============================================================ */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

const ROOT = join(import.meta.dirname, "..");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DIST = normalize(arg("dir") ?? join(ROOT, "dist"));
const PORT = Number(arg("port") ?? process.env.PORT) || 4173;
const extra = arg("extra-origin");
if (!existsSync(join(DIST, "index.html"))) {
  console.error("✗ No build found — run `npm run build` first.");
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
const rules = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")).headers.map((rule) => ({
  test: new RegExp(`^${rule.source}$`),
  headers: rule.headers.map(({ key, value }) => [key, extra && key === "Content-Security-Policy"
    ? value.replace(/(connect-src|img-src|media-src|frame-src) ([^;]*)/g, `$1 $2 ${extra}`)
    : value]),
}));

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(DIST, path.endsWith("/") ? path + "index.html" : path));
  let status = 200;
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) { file = join(DIST, "404.html"); status = 404; }
  for (const rule of rules) if (rule.test.test(path)) for (const [k, v] of rule.headers) res.setHeader(k, v);
  if (!res.hasHeader("Cache-Control")) res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  let body = readFileSync(file);
  const accept = String(req.headers["accept-encoding"] ?? "");
  if (/^(text|application\/(json|manifest))/.test(type) && body.length > 1024) {
    if (accept.includes("br")) { body = brotliCompressSync(body); res.setHeader("Content-Encoding", "br"); }
    else if (accept.includes("gzip")) { body = gzipSync(body); res.setHeader("Content-Encoding", "gzip"); }
    res.setHeader("Vary", "Accept-Encoding");
  }
  res.writeHead(status, { "Content-Type": type, "Content-Length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}).listen(PORT, () => console.log(`Serving dist/ as Vercel would: http://localhost:${PORT}${extra ? ` (CSP also allows ${extra})` : ""}`));
