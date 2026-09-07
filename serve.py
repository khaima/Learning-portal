#!/usr/bin/env python3
"""Local static server for the HPF Digital Learning Portal.

Serves the plain multi-page site for local development. Reads the PORT
environment variable when set (falling back to 5174), so tooling that
assigns its own port works without editing this file.

Usage:
    python serve.py          # $PORT, or 5174
    python serve.py 8080     # explicit port wins
"""

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 5174


def main():
    port = int(os.environ.get("PORT") or DEFAULT_PORT)
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Invalid port '{sys.argv[1]}', using {port}.")

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)

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
