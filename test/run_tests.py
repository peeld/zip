#!/usr/bin/env python3
"""Run the lib/, core/ and op tests in headless Firefox.

    python3 test/run_tests.py

Generates fixture zips with Info-ZIP `zip` and Python's zipfile, serves the repo
on localhost, loads test/zip-test.html in headless Firefox, then verifies the
zips the browser wrote with zipfile and `unzip -t`.
"""
import base64
import binascii
import functools
import gzip
import hashlib
import http.server
import io
import json
import quopri
import random
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import zipfile
import zlib
from urllib.parse import quote, quote_plus, unquote
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

    # gzip fixtures. GzipFile stores the file name (FNAME) and mtime in the header.
    with open(work / "named.txt.gz", "wb") as raw, gzip.GzipFile("hello.txt", "wb", fileobj=raw, mtime=1715000000) as g:
        g.write(SOURCES["hello.txt"])
    (work / "plain.gz").write_bytes(gzip.compress(SOURCES["random.bin"], mtime=0))  # no name in header
    (work / "multi.gz").write_bytes(gzip.compress(b"part one\n") + gzip.compress(b"part two\n"))
    # Like bgzip: many ~64 KB members (8 MB of text in all).
    rng = random.Random(3)
    words = [bytes(rng.choice(b"abcdefghij") for _ in range(rng.randint(2, 9))) for _ in range(500)]
    text = b" ".join(rng.choice(words) for _ in range(1_400_000))[:8 << 20]
    (work / "bgzf-like.txt").write_bytes(text)
    (work / "bgzf-like.gz").write_bytes(b"".join(gzip.compress(text[i:i + 65280]) for i in range(0, len(text), 65280)))
    bad = bytearray(gzip.compress(SOURCES["hello.txt"]))
    bad[-6] ^= 0xFF  # CRC in the trailer
    (work / "badcrc.gz").write_bytes(bad)

    # base64 fixtures. encodebytes wraps at 76 columns with a final newline, like GNU base64.
    rnd = SOURCES["random.bin"]
    (work / "random.b64").write_bytes(base64.encodebytes(rnd))
    (work / "random.w0.b64").write_bytes(base64.b64encode(rnd))
    (work / "random-url.txt").write_bytes(base64.urlsafe_b64encode(rnd[:1000]).rstrip(b"="))
    png = b"\x89PNG\r\n\x1a\n" + random.Random(4).randbytes(5000)
    (work / "png.bin").write_bytes(png)
    (work / "pixel.txt").write_bytes(b"  data:image/png;base64," + base64.b64encode(png) + b"\n")
    (work / "concat.b64").write_bytes(base64.encodebytes(b"ab") + base64.encodebytes(b"cde") + base64.encodebytes(b"f"))
    (work / "not.b64").write_bytes(b"<html>hello</html>")
    make_uu_fixtures(work, png)
    make_hex_fixtures(work)
    make_textenc_fixtures(work)

    tars = make_tar_fixtures(work, src)
    hashes = make_hash_fixtures(work, src)
    ars = make_ar_fixtures(work, src)
    (work / "manifest.json").write_text(json.dumps({"zips": zips, "tars": tars, "ars": ars, "sources": names, "long": LONG, "hashes": hashes}))
    return {"zips": zips}


def uu_block(name: str, data: bytes, backtick=True, mode="644") -> bytes:
    """A uuencoded file the way GNU sharutils writes it ("`" for zero when backtick is set)."""
    lines = [binascii.b2a_uu(data[i:i + 45], backtick=backtick) for i in range(0, len(data), 45)]
    end = b"`\n" if backtick else b" \n"
    return f"begin {mode} {name}\n".encode() + b"".join(lines) + end + b"end\n"


def make_uu_fixtures(work: Path, png: bytes):
    rnd = SOURCES["random.bin"]
    (work / "random.uu").write_bytes(uu_block("random.bin", rnd))
    (work / "empty.uu").write_bytes(uu_block("empty.txt", b""))
    # Space for zero, CRLF line ends, trailing spaces stripped (as some mailers do).
    spaces = uu_block("unicodé 名前.txt", SOURCES["unicodé 名前.txt"], backtick=False)
    (work / "spaces.uue").write_bytes(b"\r\n".join(l.rstrip(b" ") for l in spaces.split(b"\n")))
    # An email with two files and text around them; the second is `uuencode -m` (base64).
    (work / "mail.txt").write_bytes(
        b"From: someone\nSubject: files\n\nHere you go:\n\n" + uu_block("dir/hello.txt", SOURCES["hello.txt"])
        + b"\nand the picture:\n" + b"begin-base64 600 pixel.png\n" + base64.encodebytes(png) + b"====\n-- \nbye\n")
    (work / "cut.uu").write_bytes(uu_block("random.bin", rnd)[:2000])
    (work / "bad.uu").write_bytes(b"begin 644 x.html\nM<html>{hello}</html>" + b"a" * 40 + b"\n`\nend\n")


def make_hex_fixtures(work: Path):
    """Dumps written by the real xxd, hexdump and od (unhex reads the first two, rejects od)."""
    def tool(args, data: bytes) -> bytes:
        return subprocess.run(args, input=data, capture_output=True, check=True).stdout

    rnd = SOURCES["random.bin"]
    (work / "random.xxd").write_bytes(tool(["xxd"], rnd))
    (work / "random.p.hex").write_bytes(tool(["xxd", "-p"], rnd[:10000]))
    (work / "hello.xxd").write_bytes(tool(["xxd", "-u", "-c", "8", "-g", "1"], SOURCES["unicodé 名前.txt"]))
    # Runs of repeated 16-byte lines, which hexdump -C collapses into '*'.
    rep = b"\0" * 100 + rnd[:5000] + b"\0" * 64 + b"abc"
    (work / "rep.bin").write_bytes(rep)
    (work / "rep.hexdump").write_bytes(tool(["hexdump", "-C"], rep))
    (work / "hello.od").write_bytes(tool(["od", "-x"], SOURCES["hello.txt"][:100]))
    (work / "intel.hex").write_bytes(b":10010000214601360121470136007EFE09D2190140\n:00000001FF\n")


QP_TEXT = ("Caf\u00e9 = 3 \u20ac, tabs\tand trailing spaces   \n"
           + "a long line " * 20 + "\r\n=41 is not an escape here\n.\nFrom the start\n\t\n"
           + "x" * 75 + "=\n" + "y" * 74 + " \nno newline at the end ").encode()


def make_textenc_fixtures(work: Path):
    """base32/base32hex from GNU basenc, ascii85/qp/url from Python (lib/textenc.js)."""
    def tool(args, data: bytes) -> bytes:
        return subprocess.run(args, input=data, capture_output=True, check=True).stdout

    rnd = SOURCES["random.bin"]
    (work / "random.b32").write_bytes(tool(["basenc", "--base32"], rnd))
    (work / "random.b32hex").write_bytes(tool(["basenc", "--base32hex"], rnd))
    (work / "short.w0.b32").write_bytes(tool(["base32", "-w", "0"], rnd[:1003]))
    zeros = b"\0" * 8 + rnd[:5000] + b"\0" * 6
    (work / "zeros.bin").write_bytes(zeros)
    (work / "zeros.a85").write_bytes(base64.a85encode(zeros, wrapcol=76, adobe=True) + b"\n")
    (work / "random.a85").write_bytes(base64.a85encode(rnd, wrapcol=76, adobe=True) + b"\n")
    (work / "plain.a85").write_bytes(base64.a85encode(rnd[:1001]))  # no <~ ~>, one line
    (work / "random.qp").write_bytes(binascii.b2a_qp(rnd, istext=False))
    (work / "qp-src.txt").write_bytes(QP_TEXT)
    py_qp = binascii.b2a_qp(QP_TEXT)
    (work / "text.qp").write_bytes(py_qp)
    (work / "text.qp.out").write_bytes(binascii.a2b_qp(py_qp))
    (work / "random.urlenc").write_bytes(quote(rnd, safe="").encode())
    (work / "form.urlenc").write_bytes(quote_plus(QP_TEXT, safe="").encode() + b"\n")


def verify_textenc(work: Path, results: list):
    """The browser's quoted-printable output, decoded by Python."""
    def check(ok, msg):
        results.append(f"{'PASS' if ok else 'FAIL'} {msg}")

    for name, want in (("written.qp", SOURCES["random.bin"]), ("written-text.qp", QP_TEXT)):
        p = work / name
        if not p.exists():
            check(False, f"{name} was not uploaded")
            continue
        data = p.read_bytes()
        check(binascii.a2b_qp(data) == want and quopri.decodestring(data) == want, f"{name}: binascii.a2b_qp and quopri decode it")
        longest = max(len(line) for line in data.split(b"\n"))
        check(longest <= 76 and all(32 <= c < 127 or c in (9, 10) for c in data), f"{name}: lines <= 76 ({longest}), printable ASCII")


HASH_ALGOS = ["md5", "sha1", "sha256", "sha384", "sha512"]


def all_hashes(data: bytes) -> dict:
    h = {a: hashlib.new(a, data).hexdigest() for a in HASH_ALGOS}
    h["crc32"] = f"{zlib.crc32(data):08x}"
    return h


def make_hash_fixtures(work: Path, src: Path) -> dict:
    """Reference hashes from hashlib/zlib, and checksum lists written by the real coreutils tools."""
    rnd = SOURCES["random.bin"]
    # Every length up to 300 crosses the 55/56/64 and 111/112/128 padding edges.
    prefixes = [all_hashes(rnd[:n]) for n in range(301)]
    files = {n: all_hashes(d) for n, d in SOURCES.items()}
    names = sorted(SOURCES)

    def tool(args, cwd=src) -> bytes:
        return subprocess.run(args, cwd=cwd, capture_output=True, check=True).stdout

    (work / "SHA256SUMS").write_bytes(tool(["sha256sum", *names]))
    (work / "tag.md5").write_bytes(tool(["md5sum", "--tag", *names]))
    (work / "star.sha1").write_bytes(tool(["sha1sum", "-b", "hello.txt", "empty.txt"]))
    odd = work / "odd"
    odd.mkdir()
    (odd / "back\\slash.txt").write_bytes(b"x")
    (odd / "new\nline.txt").write_bytes(b"y")
    (work / "odd.sha256").write_bytes(tool(["sha256sum", "back\\slash.txt", "new\nline.txt"], cwd=odd))
    (work / "odd.tag").write_bytes(tool(["sha512sum", "--tag", "back\\slash.txt"], cwd=odd))
    crc = lambda n: f"{zlib.crc32(SOURCES[n]):08X}"
    (work / "check.sfv").write_bytes(f"; made by hand\r\nhello.txt {crc('hello.txt')}\r\ndir/sub/nested.csv {crc('dir/sub/nested.csv')}\r\n".encode())
    return {"prefixes": prefixes, "files": files, "x": all_hashes(b"x"), "y": all_hashes(b"y")}


def verify_sums(work: Path, results: list):
    """Check the checksum lists the browser wrote with sha256sum -c / md5sum -c."""
    tagged = work / "written.CHECKSUMS"
    if tagged.exists():
        # Mixed tagged lists: split by tag, since coreutils < 9 has no `cksum -c`.
        lines = tagged.read_text().splitlines(keepends=True)
        for tag in ("SHA256", "SHA512"):
            (work / f"written.CHECKSUMS.{tag}").write_text("".join(l for l in lines if l.startswith(tag + " (")))
    for name, cmd in [("written.SHA256SUMS", "sha256sum"), ("written.MD5SUMS", "md5sum"),
                      ("written.CHECKSUMS.SHA256", "sha256sum"), ("written.CHECKSUMS.SHA512", "sha512sum")]:
        p = work / name
        if not p.exists():
            results.append(f"FAIL {name} was not uploaded")
            continue
        r = subprocess.run([cmd, "--strict", "-c", str(p)], cwd=work / "src", capture_output=True, text=True)
        ok_lines = r.stdout.count(": OK")
        results.append(f"{'PASS' if r.returncode == 0 and ok_lines == len(SOURCES) else 'FAIL'} {name}: {cmd} -c ({ok_lines} OK{', ' + r.stderr.strip() if r.stderr.strip() else ''})")
    p = work / "written.odd.sha256"
    if p.exists():
        r = subprocess.run(["sha256sum", "--strict", "-c", str(p)], cwd=work / "odd", capture_output=True, text=True)
        results.append(f"{'PASS' if r.returncode == 0 and r.stdout.count(': OK') == 2 else 'FAIL'} written.odd.sha256: escaped names pass sha256sum -c ({r.stdout.strip()!r} {r.stderr.strip()})")
    else:
        results.append("FAIL written.odd.sha256 was not uploaded")


# Over 100 bytes with no '/' that splits it into ustar's 155 + 100: needs a GNU 'L' or pax header.
LONG = "deep/" + "d" * 120 + "/" + "f" * 110 + ".txt"
TAR_MTIME = 1715000000


def make_tar_fixtures(work: Path, src: Path) -> list:
    """Tars in each format Python writes (+ GNU tar if present), with a dir, a symlink and a long name."""
    def add_all(t: tarfile.TarFile, long=True):
        d = tarfile.TarInfo("dir")
        d.type, d.mode, d.mtime = tarfile.DIRTYPE, 0o755, TAR_MTIME
        t.addfile(d)
        for n, data in SOURCES.items():
            i = tarfile.TarInfo(n)
            i.size, i.mtime = len(data), TAR_MTIME
            t.addfile(i, io.BytesIO(data))
        l = tarfile.TarInfo("link-to-hello")
        l.type, l.linkname = tarfile.SYMTYPE, "hello.txt"
        t.addfile(l)
        if long:
            i = tarfile.TarInfo(LONG)
            i.size = 5
            t.addfile(i, io.BytesIO(b"long\n"))

    names = list(SOURCES)
    tars = []
    for fmt, label, long in ((tarfile.USTAR_FORMAT, "ustar", False), (tarfile.GNU_FORMAT, "gnu", True),
                             (tarfile.PAX_FORMAT, "pax", True)):
        with tarfile.open(work / f"{label}.tar", "w", format=fmt, encoding="utf-8") as t:
            add_all(t, long)
        tars.append({"file": f"{label}.tar", "count": len(names) + long, "check": names, "long": long})
    with tarfile.open(work / "pax.tar.gz", "w:gz", format=tarfile.PAX_FORMAT) as t:
        add_all(t)
    tars.append({"file": "pax.tar.gz", "count": len(names) + 1, "check": names, "long": True})
    if shutil.which("tar"):
        subprocess.run(["tar", "-czf", str(work / "gnutar.tgz"), "."], cwd=src, check=True)
        tars.append({"file": "gnutar.tgz", "count": len(names), "check": names, "prefix": "./"})

    # Flip a byte in the second header: its checksum no longer matches.
    raw = bytearray((work / "ustar.tar").read_bytes())
    raw[512 + 10] ^= 0xFF
    (work / "corrupt.tar").write_bytes(raw)
    return tars


def verify_tar(work: Path, results: list):
    """Check the tars the browser wrote with Python's tarfile and GNU `tar -t`."""
    want = dict(SOURCES)
    want[LONG] = b"long\n"
    for name in ("written.tar", "written.tar.gz"):
        def check(ok, msg):
            results.append(f"{'PASS' if ok else 'FAIL'} {name}: {msg}")
        p = work / name
        if not p.exists():
            check(False, "was not uploaded")
            continue
        with tarfile.open(p) as t:
            files = {m.name: m for m in t.getmembers() if m.isfile()}
            check(sorted(files) == sorted(want), f"names ({len(files)} files)")
            for n, data in want.items():
                if n in files:
                    check(t.extractfile(files[n]).read() == data, f"content {n[:40]}")
            dirs = sorted(m.name for m in t.getmembers() if m.isdir())
            check(dirs == ["deep", "deep/" + "d" * 120, "dir", "dir/sub"], f"folder entries {[d[:12] for d in dirs]}")
            check(files["hello.txt"].mtime == TAR_MTIME and files["hello.txt"].mode == 0o644, "mtime and mode")
        check(p.stat().st_size % 10240 == 0 or name.endswith(".gz"), "padded to 10 KB records")
        if shutil.which("tar"):
            r = subprocess.run(["tar", "-tf", str(p)], capture_output=True, text=True)
            check(r.returncode == 0 and LONG in r.stdout.splitlines(), f"tar -t {r.stderr.strip()}")


def ar_member(field: str, data: bytes, mtime=TAR_MTIME) -> bytes:
    """One ar member: the 60-byte header (name field as given) and the data, padded to even."""
    h = f"{field:<16}{mtime:<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}`\n".encode()
    assert len(h) == 60, field
    return h + data + b"\n" * (len(data) & 1)


def make_ar_fixtures(work: Path, src: Path) -> list:
    """ar archives from GNU ar, a BSD/macOS-style one built by hand, and a .deb from dpkg-deb."""
    by_base = {n.split("/")[-1]: n for n in SOURCES}
    ars = []
    if shutil.which("ar"):
        subprocess.run(["ar", "rc", str(work / "gnu.a"), *SOURCES], cwd=src, check=True)
        ars.append({"file": "gnu.a", "count": len(SOURCES), "flavor": "gnu", "symbols": False, "check": by_base})
        # A GNU symbol table ("/") first, as `ar rcs` writes for object files.
        raw = (work / "gnu.a").read_bytes()
        (work / "gnu-sym.a").write_bytes(raw[:8] + ar_member("/", b"\0\0\0\0", 0) + raw[8:])
        ars.append({"file": "gnu-sym.a", "count": len(SOURCES), "flavor": "gnu", "symbols": True, "check": by_base})
        cut = bytearray(raw)
        cut[8 + 58] = ord("x")  # the first header's "`\n"
        (work / "corrupt.a").write_bytes(cut)
        (work / "cut.a").write_bytes(raw[:5000])
    # BSD / macOS: "#1/N" with the name (NUL-padded to 8) at the start of the data,
    # a "__.SYMDEF SORTED" table, and plain space-padded names when they fit.
    bsd = [b"!<arch>\n"]
    def bsd_member(name: str, data: bytes):
        b = name.encode()
        if len(b) <= 16 and " " not in name:
            return ar_member(name, data)
        b += b"\0" * (-len(b) % 8)
        return ar_member(f"#1/{len(b)}", b + data)
    bsd.append(bsd_member("__.SYMDEF SORTED", b"\0" * 8))
    for base, n in by_base.items():
        bsd.append(bsd_member(base, SOURCES[n]))
    (work / "bsd.a").write_bytes(b"".join(bsd))
    ars.append({"file": "bsd.a", "count": len(SOURCES), "flavor": "bsd", "symbols": True, "check": by_base})
    (work / "thin.a").write_bytes(b"!<thin>\n" + ar_member("hello.txt/", b""))

    if shutil.which("dpkg-deb"):
        pkg = work / "pkg"
        (pkg / "DEBIAN").mkdir(parents=True)
        (pkg / "DEBIAN" / "control").write_text(
            "Package: zm-test\nVersion: 1.0\nArchitecture: all\nMaintainer: test <t@example.com>\nDescription: test\n")
        doc = pkg / "usr" / "share" / "doc" / "zm-test"
        doc.mkdir(parents=True)
        (doc / "hello.txt").write_bytes(SOURCES["hello.txt"])
        subprocess.run(["dpkg-deb", "-Zgzip", "--root-owner-group", "--build", str(pkg), str(work / "pkg.deb")],
                       check=True, capture_output=True)
        ars.append({"file": "pkg.deb", "count": 3, "deb": True, "check": {}})
    return ars


def verify_ar(work: Path, results: list):
    """Check the ar / .deb the browser wrote with GNU ar and dpkg-deb."""
    def check(ok, msg):
        results.append(f"{'PASS' if ok else 'FAIL'} {msg}")

    p = work / "written.a"
    if not p.exists():
        check(False, "written.a was not uploaded")
    elif shutil.which("ar"):
        r = subprocess.run(["ar", "t", str(p)], capture_output=True)
        want = [n.split("/")[-1] for n in SOURCES]
        got = r.stdout.decode().splitlines()
        check(r.returncode == 0 and got == want, f"written.a: ar t lists the names in order ({got})")
        good = sum(subprocess.run(["ar", "p", str(p), n.split("/")[-1]], capture_output=True).stdout == d
                   for n, d in SOURCES.items())
        check(good == len(SOURCES), f"written.a: ar p gives each file's content ({good}/{len(SOURCES)})")
    p = work / "written.deb"
    if shutil.which("dpkg-deb"):
        if not p.exists():
            return check(False, "written.deb was not uploaded")
        r = subprocess.run(["dpkg-deb", "-c", str(p)], capture_output=True, text=True)
        i = subprocess.run(["dpkg-deb", "-f", str(p), "Package"], capture_output=True, text=True)
        check(r.returncode == 0 and "zm-test/hello.txt" in r.stdout and i.stdout.strip() == "zm-test",
              f"written.deb: dpkg-deb reads it {r.stderr.strip()} {i.stderr.strip()}")


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


def verify_gzip(work: Path, results: list):
    """Check the .gz the browser wrote with Python's gzip module and `gzip -t`."""
    def check(ok, msg):
        results.append(f"{'PASS' if ok else 'FAIL'} written.gz: {msg}")

    p = work / "written.gz"
    if not p.exists():
        return check(False, "was not uploaded")
    raw = p.read_bytes()
    check(gzip.decompress(raw) == SOURCES["unicodé 名前.txt"] * 50, "python gzip decompresses it")
    check(raw[3] & 8 and raw[10:raw.index(0, 10)] == "unicodé.txt".encode("latin-1"), "FNAME header field")
    check(int.from_bytes(raw[4:8], "little") == 1715000000, "MTIME header field")
    if shutil.which("gzip"):
        r = subprocess.run(["gzip", "-t", str(p)], capture_output=True, text=True)
        check(r.returncode == 0, f"gzip -t {r.stderr.strip()}")


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
        # Lazy loading: the bare page loads no op code; #unzip loads only unzip.
        requested.clear()
        run_firefox(f"{base}/public/index.html", seconds=8)
        bare = list(requested)
        requested.clear()
        run_firefox(f"{base}/public/index.html#unzip", seconds=8)
        hashed = list(requested)
    finally:
        server.shutdown()
    lazy = [
        ("/public/ops/registry.js" in bare, "page loads ops/registry.js"),
        (not any(p.startswith("/public/ops/") and p.endswith("/op.js") for p in bare),
         "bare page loads no op code until a command is run"),
        ("/public/ops/unzip/op.js" in hashed, "#unzip runs the unzip op"),
        ("/public/ops/zip/op.js" not in hashed, "#unzip does not load the zip op"),
    ]

    results = list(browser_result.get("log", []))
    results += [f"{'PASS' if ok else 'FAIL'} {msg}" for ok, msg in lazy]
    for name in ("written.zip", "stored.zip", "many.zip"):
        p = work / name
        if p.exists():
            verify_written(p, name, results)
        else:
            results.append(f"FAIL {name} was not uploaded")

    verify_gzip(work, results)
    verify_tar(work, results)
    verify_ar(work, results)
    verify_sums(work, results)
    verify_textenc(work, results)

    print("\n".join(results))
    fails = sum(r.startswith("FAIL") for r in results)
    print(f"\n{len(results) - fails} passed, {fails} failed")
    shutil.rmtree(work, ignore_errors=True)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
