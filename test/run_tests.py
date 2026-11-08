#!/usr/bin/env python3
"""Run public/zip.js tests in headless Firefox.

    python3 test/run_tests.py

Generates fixture zips with Info-ZIP `zip` and Python's zipfile, serves the repo
on localhost, loads test/zip-test.html in headless Firefox, then verifies the
zips the browser wrote with zipfile and `unzip -t`.
"""
import functools
import http.server
import json
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from urllib.parse import unquote
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TIMEOUT = 180

SOURCES = {
    "hello.txt": b"hello world\n" * 1000,
    "empty.txt": b"",
    "random.bin": random.Random(1).randbytes(300_000),
    "photo.jpg": random.Random(2).randbytes(50_000),
    "dir/sub/nested.csv": b"a,b,c\n1,2,3\n" * 5000,
    "unicodé 名前.txt": "héllo wörld ✓\n".encode() * 100,
    # Byte 1000 falls inside the 3-byte "✓", to test the viewer's text cut-off.
    "split.txt": b"a" * 999 + "✓".encode() * 10,
}


def make_fixtures(work: Path) -> dict:
    src = work / "src"
    for name, data in SOURCES.items():
        p = src / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    names = list(SOURCES)
    zips = []

    subprocess.run(["zip", "-qr", str(work / "infozip.zip"), "."], cwd=src, check=True)
    zips.append({"file": "infozip.zip", "count": len(names), "check": names})

    with zipfile.ZipFile(work / "python.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            z.write(src / n, n)
    zips.append({"file": "python.zip", "count": len(names), "check": names})

    with zipfile.ZipFile(work / "python-zip64.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            with z.open(n, "w", force_zip64=True) as f:
                f.write(SOURCES[n])
    zips.append({"file": "python-zip64.zip", "count": len(names), "check": names})

    with zipfile.ZipFile(work / "python-many.zip", "w", zipfile.ZIP_STORED) as z:
        for i in range(70000):
            z.writestr(f"m/{i}.txt", f"entry {i}\n")
        for n in names[:2]:
            z.write(src / n, n)
    zips.append({"file": "python-many.zip", "count": 70002, "check": names[:2]})

    # Flip a byte inside the compressed data of the only entry.
    with zipfile.ZipFile(work / "corrupt.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("hello.txt", SOURCES["hello.txt"])
    raw = bytearray((work / "corrupt.zip").read_bytes())
    raw[30 + len("hello.txt") + 5] ^= 0xFF
    (work / "corrupt.zip").write_bytes(raw)

    (work / "manifest.json").write_text(json.dumps({"zips": zips, "sources": names}))
    return {"zips": zips}


def verify_written(path: Path, label: str, results: list):
    def check(ok, msg):
        results.append(f"{'PASS' if ok else 'FAIL'} {label}: {msg}")

    r = subprocess.run(["unzip", "-tq", str(path)], capture_output=True, text=True)
    check(r.returncode == 0, f"unzip -t ({r.stdout.strip() or r.stderr.strip()})")
    with zipfile.ZipFile(path) as z:
        check(z.testzip() is None, "zipfile CRC check")
        if label != "many.zip":
            check(sorted(z.namelist()) == sorted(SOURCES), "names")
            for n, data in SOURCES.items():
                check(z.read(n) == data, f"content {n}")
            info = z.getinfo("hello.txt")
            want = datetime.fromtimestamp(datetime(2024, 5, 6, 12, 30, 10, tzinfo=timezone.utc).timestamp())
            check(info.date_time == want.timetuple()[:6], f"timestamp {info.date_time}")
            if label == "written.zip":
                check(z.getinfo("hello.txt").compress_type == zipfile.ZIP_DEFLATED, "text deflated")
                check(z.getinfo("photo.jpg").compress_type == zipfile.ZIP_STORED, "jpg stored")
                check(z.getinfo("random.bin").compress_type == zipfile.ZIP_STORED, "incompressible fell back to stored")
            else:
                check(all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist()), "all stored")
        else:
            check(len(z.namelist()) == 70000, f"{len(z.namelist())} entries")
            check(z.read("m/69999.txt") == b"entry 69999\n", "last entry")


def run_firefox(url, until=None, seconds=None):
    """Open url in a throwaway headless Firefox until `until` is set or `seconds` pass."""
    # Snap Firefox can't see /tmp, so keep the throwaway profile in its own area.
    snap_home = Path.home() / "snap" / "firefox" / "common"
    profile = Path(tempfile.mkdtemp(prefix="zipmedia-profile-", dir=snap_home if snap_home.is_dir() else None))
    ff = subprocess.Popen(
        ["firefox", "--headless", "--no-remote", "--profile", str(profile), url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        if until is not None:
            if not until.wait(TIMEOUT):
                sys.exit(f"timed out waiting for browser ({url})")
        else:
            time.sleep(seconds)
    finally:
        ff.terminate()
        ff.wait(10)
        shutil.rmtree(profile, ignore_errors=True)


def main():
    if not shutil.which("firefox"):
        sys.exit("firefox not found")
    work = Path(tempfile.mkdtemp(prefix="zipmedia-test-"))
    make_fixtures(work)
    done = threading.Event()
    browser_result = {}
    requested = []

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            requested.append(self.path.split("?")[0])
            super().do_GET()

        def translate_path(self, path):
            path = path.split("?")[0]
            if path.startswith("/fixtures/"):
                return str(work / unquote(path[len("/fixtures/"):]))
            return super().translate_path(path)

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.path == "/result":
                browser_result.update(json.loads(body))
                done.set()
            elif self.path.startswith("/upload/"):
                (work / self.path[len("/upload/"):]).write_bytes(body)
            self.send_response(204)
            self.end_headers()

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    base = f"http://127.0.0.1:{server.server_port}"
    try:
        run_firefox(f"{base}/test/zip-test.html", until=done)
        # Lazy loading: opening the site must fetch only the default op's code.
        requested.clear()
        run_firefox(f"{base}/public/index.html", seconds=8)
    finally:
        server.shutdown()
    lazy = [
        ("/public/ops/registry.js" in requested, "page loads ops/registry.js"),
        ("/public/ops/unzip/op.js" in requested, "page loads the default op (unzip)"),
        ("/public/ops/zip/op.js" not in requested, "page does not load the zip op until its tab is opened"),
    ]

    results = list(browser_result.get("log", []))
    results += [f"{'PASS' if ok else 'FAIL'} {msg}" for ok, msg in lazy]
    for name in ("written.zip", "stored.zip", "many.zip"):
        p = work / name
        if p.exists():
            verify_written(p, name, results)
        else:
            results.append(f"FAIL {name} was not uploaded")

    print("\n".join(results))
    fails = sum(r.startswith("FAIL") for r in results)
    print(f"\n{len(results) - fails} passed, {fails} failed")
    shutil.rmtree(work, ignore_errors=True)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
