#!/usr/bin/env python3
"""Local static server for the HPF Digital Learning Portal's BUILD.

Serves dist/ — run `npm run build` first (the pages import npm packages,
so the sources need the build). For working on the code, `npm run dev`
(Vite, with instant reload) is the better choice; for the build exactly as
Vercel serves it (CSP and other headers, compression), `npm run serve`.
Reads the PORT environment variable when set (falling back to 5174), so
tooling that assigns its own port works without editing this file.

Usage:
    python serve.py          # $PORT, or 5174
    python serve.py 8080     # explicit port wins
"""

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
DEFAULT_PORT = 5174


def main():
    if not os.path.isfile(os.path.join(ROOT, "index.html")):
        sys.exit("No build in dist/ — run `npm run build` first.")
    port = int(os.environ.get("PORT") or DEFAULT_PORT)
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Invalid port '{sys.argv[1]}', using {port}.")

    class Handler(http.server.SimpleHTTPRequestHandler):
        """Serve the static site, but never let the browser cache it —
        local development should always reflect the files on disk."""

        def end_headers(self):
            self.send_header("Cache-Control", "no-store, must-revalidate")
            super().end_headers()

    handler = functools.partial(Handler, directory=ROOT)

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True

    with Server(("0.0.0.0", port), handler) as httpd:
        print("\n  HPF Digital Learning Portal")
        print("  " + "-" * 28)
        print(f"  Serving at:  http://localhost:{port}")
        print(f"  Directory:   {ROOT}")
        print("  Press Ctrl+C to stop.\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Stopped.\n")


if __name__ == "__main__":
    main()
