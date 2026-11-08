#!/usr/bin/env python3
"""Local server for the mockup app: python3 serve.py [port]  (default 5173).

Same as `python3 -m http.server`, but tells the browser not to cache files, so
edits and rebuilt models show up on a normal reload.

It also answers /version.json with the git commit this folder is on, so the
app can tell you when GitHub has a newer version (js/update-check.js).
"""
import errno
import http.server
import json
import os
import re
import subprocess
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".glb": "model/gltf-binary",
        ".webmanifest": "application/manifest+json",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/version.json":
            body = json.dumps(local_version()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def git(*args):
    try:
        out = subprocess.run(["git", *args], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def local_version():
    """The commit and branch this folder is on, and its GitHub repo ("owner/name").
    All null when the folder isn't a git clone (e.g. downloaded as a ZIP)."""
    origin = git("remote", "get-url", "origin") or ""
    m = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$", origin)
    return {
        "commit": git("rev-parse", "HEAD"),
        "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "repo": m.group(1) if m else None,
    }


class Server(http.server.ThreadingHTTPServer):
    # Browsers fetch many modules at once; the default backlog of 5 drops some.
    request_queue_size = 128
    daemon_threads = True


os.chdir(os.path.dirname(os.path.abspath(__file__)))

# If the port is taken (e.g. the app is already running), use the next free one.
for port in range(PORT, PORT + 20):
    try:
        httpd = Server(("127.0.0.1", port), NoCacheHandler)
        break
    except OSError as e:
        if e.errno not in (errno.EADDRINUSE, 48, 98):
            raise
        print(f"Port {port} is in use, trying {port + 1}…")
else:
    sys.exit(f"No free port between {PORT} and {PORT + 19}.")

with httpd:
    print(f"Mockup3D Studio running at http://localhost:{port}  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
