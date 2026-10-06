# Vendored third-party code

Served from the portal itself, so no page loads code from a CDN at run time
(and the Content-Security-Policy in `vercel.json` can allow scripts from
`'self'` only).

| File | What | Version | Licence |
|---|---|---|---|
| `supabase-js-2.117.2.js` | [@supabase/supabase-js](https://github.com/supabase/supabase-js) as one ES module (exports `createClient`), used by `supabase.js` for sign-in | 2.117.2 — the same release the pages loaded from esm.sh before | MIT (bundled dependencies: `LICENSES.txt`) |

SHA-256 of `supabase-js-2.117.2.js`:
`d45c743c329b1dcc1cb8e81e69ce073f1b92a417af519218e4664bde4626a9ce`

The version is in the file name, so a new version is a new address: browsers
may keep it for a year (`vercel.json` marks `/vendor/` immutable), and the
service worker (`sw.js`) lists it in the app shell.

## Rebuilding / upgrading

```bash
mkdir /tmp/sb && cd /tmp/sb && npm init -y
npm install --ignore-scripts @supabase/supabase-js@2.117.2 esbuild@0.25
echo 'export { createClient } from "@supabase/supabase-js";' > entry.js
npx esbuild entry.js --bundle --format=esm --minify --target=es2020 --platform=browser --legal-comments=eof --outfile=supabase-js-2.117.2.js
```

To upgrade: build the new version under its own file name, check it has no
`eval`/`new Function` (the CSP doesn't allow them), point `supabase.js`'s
import and `sw.js`'s `SHELL` list at it, bump `VERSION` in `sw.js`, update
the table and hash above and `LICENSES.txt`, then delete the old file.
