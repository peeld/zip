#!/usr/bin/env python3
"""Run the lib/, core/ and op tests in headless Firefox.

    python3 test/run_tests.py

Generates fixture zips with Info-ZIP `zip` and Python's zipfile, serves the repo
on localhost, loads test/zip-test.html in headless Firefox, then verifies the
zips the browser wrote with zipfile and `unzip -t`.
"""
import base64
import binascii
import bz2
import functools
import gzip
import hashlib
import http.server
import io
import os
import json
import lzma
import quopri
import random
import re
import shutil
import struct
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

    zips += make_method_zips(work, src, names)

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
    cpios = make_cpio_fixtures(work, src)
    make_wasm(work)
    has_brotli = make_brotli_fixtures(work, png)
    xzs = make_xz_fixtures(work, src, text, png)
    zstds = make_zstd_fixtures(work, src, text, png)
    bzip2s = make_bzip2_fixtures(work, src, text, png)
    sevenzips = make_7z_fixtures(work, src)
    images = make_image_fixtures(work)
    (work / "manifest.json").write_text(json.dumps({"zips": zips, "tars": tars, "ars": ars, "cpios": cpios, "sources": names,
                                                    "long": LONG, "hashes": hashes, "brotli": has_brotli, "xzs": xzs,
                                                    "zstds": zstds, "bzip2s": bzip2s, "sevenzips": sevenzips,
                                                    "images": images}))
    return {"zips": zips}


def hand_zip(path: Path, items: list):
    """A zip built by hand, for methods Python's zipfile can't write. items: [(name, data, method, packed bytes)]."""
    out, cd = bytearray(), bytearray()
    for name, data, method, packed in items:
        n, crc = name.encode(), zlib.crc32(data)
        cd += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 63, 63, 0x800, method, 0, 0x21, crc, len(packed), len(data),
                          len(n), 0, 0, 0, 0, 0, len(out)) + n
        out += struct.pack("<IHHHHHIIIHH", 0x04034B50, 63, 0x800, method, 0, 0x21, crc, len(packed), len(data), len(n), 0) + n + packed
    path.write_bytes(bytes(out + cd + struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(items), len(items), len(cd), len(out), 0)))


def make_method_zips(work: Path, src: Path, names: list) -> list:
    """Zips with bzip2 (12), LZMA (14), xz (95) and zstd (93) entries: Python's zipfile, the 7-Zip command line, and by hand."""
    zips = []
    for method, label in ((zipfile.ZIP_BZIP2, "bzip2"), (zipfile.ZIP_LZMA, "lzma")):  # Python's LZMA has the end marker (flag bit 1)
        with zipfile.ZipFile(work / f"python-{label}.zip", "w", method) as z:
            for n in names:
                z.write(src / n, n)
        zips.append({"file": f"python-{label}.zip", "count": len(names), "check": names})
    if find_7z():
        for m in ("XZ", "BZip2", "LZMA"):
            out = work / f"cli-{m.lower()}.zip"
            # p7zip (CI's 7z) may not write every method into a zip: skip the ones it refuses.
            if subprocess.run([find_7z(), "a", "-tzip", f"-mm={m}", str(out), "."], cwd=src, capture_output=True).returncode == 0:
                zips.append({"file": out.name, "count": len(names), "check": names})
    hand_zip(work / "hand-xz.zip", [(n, d, 95, lzma.compress(d)) for n, d in SOURCES.items()])
    zips.append({"file": "hand-xz.zip", "count": len(names), "check": names})
    if shutil.which("zstd"):
        zst = lambda d: subprocess.run(["zstd", "-q", "-c"], input=d, capture_output=True, check=True).stdout
        hand_zip(work / "hand-zstd.zip", [(n, d, 93, zst(d)) for n, d in SOURCES.items()])
        zips.append({"file": "hand-zstd.zip", "count": len(names), "check": names})
    # Unsupported (PPMd), and a bzip2 entry with a flipped byte.
    hand_zip(work / "ppmd.zip", [("a.txt", b"abc", 98, b"\x07\x00junk")])
    bad = bytearray(bz2.compress(SOURCES["hello.txt"]))
    bad[len(bad) // 2] ^= 0x55
    hand_zip(work / "corrupt-bzip2.zip", [("hello.txt", SOURCES["hello.txt"], 12, bytes(bad))])
    return zips


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
        # The usual kind: data.tar.xz (dpkg-deb's default on Debian/Ubuntu). Read by untar via lib/xz.js.
        subprocess.run(["dpkg-deb", "-Zxz", "--root-owner-group", "--build", str(pkg), str(work / "pkg-xz.deb")],
                       check=True, capture_output=True)
        # data.tar.zst (Ubuntu's default since 21.10), if this dpkg-deb can write it.
        if "zstd" in subprocess.run(["dpkg-deb", "--help"], capture_output=True, text=True).stdout:
            subprocess.run(["dpkg-deb", "-Zzstd", "--root-owner-group", "--build", str(pkg), str(work / "pkg-zstd.deb")],
                           check=True, capture_output=True)
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


def make_cpio_fixtures(work: Path, src: Path) -> list:
    """cpios from GNU cpio in each format, one with links and a FIFO, gzipped, end to end, damaged."""
    if not shutil.which("cpio"):
        return []
    def cpio(fmt: str, cwd: Path) -> bytes:
        files = subprocess.run(["find", "."], cwd=cwd, capture_output=True, check=True).stdout
        return subprocess.run(["cpio", "-o", "-H", fmt, "--quiet"], cwd=cwd, input=files,
                              capture_output=True, check=True).stdout
    names = list(SOURCES)
    cpios = []
    for fmt, label in (("newc", "newc"), ("crc", "crc"), ("odc", "odc"), ("bin", "bin-le")):
        (work / f"{fmt}.cpio").write_bytes(cpio(fmt, src))
        cpios.append({"file": f"{fmt}.cpio", "files": len(names), "check": names, "formats": [label]})
    newc = (work / "newc.cpio").read_bytes()
    (work / "newc.cpio.gz").write_bytes(gzip.compress(newc))
    cpios.append({"file": "newc.cpio.gz", "files": len(names), "check": names, "formats": ["newc"]})

    # Hard link (data stored once in newc), symlink and FIFO.
    links = work / "cpio-links"
    links.mkdir()
    (links / "hello.txt").write_bytes(SOURCES["hello.txt"])
    (links / "hard.txt").hardlink_to(links / "hello.txt")
    (links / "soft").symlink_to("hello.txt")
    os.mkfifo(links / "fifo")
    for fmt in ("newc", "odc"):
        (work / f"links-{fmt}.cpio").write_bytes(cpio(fmt, links))
        cpios.append({"file": f"links-{fmt}.cpio", "links": True, "formats": [fmt],
                      "files": 1 if fmt == "newc" else 2, "check": []})

    # An initramfs-style image: two archives end to end, then gzip data that isn't read.
    (work / "concat.cpio").write_bytes((work / "links-newc.cpio").read_bytes() + (work / "odc.cpio").read_bytes())
    cpios.append({"file": "concat.cpio", "files": 1 + len(names), "check": names, "formats": ["newc", "odc"]})
    tail = gzip.compress(b"x" * 1000)
    (work / "trailing.cpio").write_bytes(newc + tail)
    cpios.append({"file": "trailing.cpio", "files": len(names), "check": names[:1], "formats": ["newc"], "trailing": len(tail)})

    cpios += make_initramfs_fixtures(work, cpio, newc, names)
    cpios += make_rpm_fixtures(work, newc, names)

    bad = bytearray(newc)
    bad[10] = ord("z")  # inside the first header's inode field
    (work / "corrupt.cpio").write_bytes(bad)
    (work / "cut.cpio").write_bytes(newc[:5000])
    return cpios


def make_initramfs_fixtures(work: Path, cpio, newc: bytes, names: list) -> list:
    """Initramfs images as dracut / mkinitramfs make them: an uncompressed cpio of CPU microcode, then the
    real one compressed (each compressor the kernel takes that we read). Plus lz4 after it (not read) and a
    compressed part that's cut off inside."""
    early = work / "early"
    (early / "kernel/x86/microcode").mkdir(parents=True)
    (early / "kernel/x86/microcode/GenuineIntel.bin").write_bytes(random.Random(5).randbytes(4000))
    micro = cpio("newc", early)
    assert len(micro) % 512 == 0
    parts = {"gzip": gzip.compress(newc), "xz": lzma.compress(newc), "lzma": lzma.compress(newc, format=lzma.FORMAT_ALONE),
             "bzip2": bz2.compress(newc)}
    if shutil.which("zstd"):
        parts["zstd"] = subprocess.run(["zstd", "-q", "-c"], input=newc, capture_output=True, check=True).stdout
    out = []
    for kind, data in parts.items():
        (work / f"initrd-{kind}.img").write_bytes(micro + data)
        out.append({"file": f"initrd-{kind}.img", "files": 1 + len(names), "check": names, "formats": ["newc"],
                    "parts": [None, kind], "second": len(micro)})
    lz4 = b"\x02\x21\x4c\x18" + random.Random(6).randbytes(200)
    (work / "initrd-lz4.img").write_bytes(micro + lz4)
    out.append({"file": "initrd-lz4.img", "files": 1, "check": [], "formats": ["newc"], "trailing": len(lz4), "trailingType": "lz4"})
    (work / "initrd-cut.img").write_bytes(micro + gzip.compress(newc[: len(newc) - 2000]))
    out.append({"file": "initrd-cut.img", "files": None, "check": [], "formats": ["newc"],
                "parts": [None, "gzip"], "second": len(micro), "error": "cpio archive is cut off"})
    return out


def rpm_header(tags: list) -> bytes:
    """An rpm header: [(tag, type, value)] with type 4 (int32), 6 (string) or 7 (binary)."""
    index, store = b"", bytearray()
    for tag, typ, val in tags:
        if typ == 4:
            store += b"\0" * (-len(store) % 4)
        index += struct.pack(">IIII", tag, typ, len(store), len(val) if typ == 7 else 1)
        store += val.to_bytes(4, "big") if typ == 4 else val.encode() + b"\0" if typ == 6 else val
    return b"\x8e\xad\xe8\x01\0\0\0\0" + struct.pack(">II", len(tags), len(store)) + index + bytes(store)


def make_rpm_fixtures(work: Path, newc: bytes, names: list) -> list:
    """.rpm packages built by hand (no rpmbuild needed): lead, signature header (padded to 8), main header, payload."""
    def rpm(name: str, compressor, payload: bytes, source=False):
        lead = b"\xed\xab\xee\xdb\x03\x00" + struct.pack(">HH", 1 if source else 0, 1) + name.encode().ljust(66, b"\0")
        lead += struct.pack(">HH", 1, 5) + b"\0" * 16
        tags = [(1000, 6, "hello"), (1001, 6, "1.0"), (1002, 6, "1.fc41"), (1022, 6, "x86_64"), (1124, 6, "cpio")]
        if compressor:
            tags.append((1125, 6, compressor))
        main = rpm_header(tags)
        # SIZE (1000) is the main header + payload; 269 is a SHA-1 (hex), 1004 an MD5 (binary). Neither is checked.
        sig = rpm_header([(1000, 4, len(main) + len(payload)), (269, 6, "3f" * 20), (1004, 7, b"\x01\x02\x03")])
        sig += b"\0" * (-len(sig) % 8)
        return lead + sig + main + payload
    pkgs = {"xz": lzma.compress(newc), "gzip": gzip.compress(newc), None: newc}
    if shutil.which("zstd"):
        pkgs["zstd"] = subprocess.run(["zstd", "-q", "-c", "-19"], input=newc, capture_output=True, check=True).stdout
    out = []
    for kind, payload in pkgs.items():
        name = f"hello-{kind or 'plain'}.rpm"
        data = rpm("hello-1.0-1.fc41", kind, payload)
        (work / name).write_bytes(data)
        out.append({"file": name, "files": len(names), "check": names, "formats": ["newc"], "rpm": "hello-1.0-1.fc41.x86_64",
                    "parts": [kind]})
    return out


def verify_cpio(work: Path, results: list):
    """Check the cpios the browser wrote with GNU cpio (list, then extract and compare)."""
    def check(ok, msg):
        results.append(f"{'PASS' if ok else 'FAIL'} {msg}")
    if not shutil.which("cpio"):
        return
    for name in ("written.cpio", "written.cpio.gz"):
        p = work / name
        if not p.exists():
            check(False, f"{name} was not uploaded")
            continue
        data = p.read_bytes()
        if name.endswith(".gz"):
            data = gzip.decompress(data)
        check(len(data) % 512 == 0, f"{name}: padded to 512 bytes ({len(data)})")
        out = work / f"{name}.out"
        out.mkdir()
        r = subprocess.run(["cpio", "-idm", "--quiet"], cwd=out, input=data, capture_output=True)
        good = sum((out / n).is_file() and (out / n).read_bytes() == d for n, d in SOURCES.items())
        check(r.returncode == 0 and good == len(SOURCES),
              f"{name}: cpio -id extracts every file ({good}/{len(SOURCES)}) {r.stderr.decode().strip()}")
        t = subprocess.run(["cpio", "-it", "--quiet"], input=data, capture_output=True)
        listed = t.stdout.decode().splitlines()
        check("dir" in listed and "dir/sub" in listed and listed.index("dir") < listed.index("dir/sub/nested.csv"),
              f"{name}: parent folders come first")
        mt = (out / "hello.txt").stat().st_mtime if (out / "hello.txt").exists() else 0
        check(int(mt) == 1715000000, f"{name}: mtime kept ({int(mt)})")


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


def make_xz_fixtures(work: Path, src: Path, text: bytes, png: bytes) -> list:
    """.xz / .lzma from Python's lzma (liblzma) and, if installed, the xz and tar tools.
    Each entry: { file, want (fixture with the expected output), size (from the index; null for .lzma) }."""
    xzs = []
    def add(name, data: bytes, want: str, raw: bytes, xz=True):
        (work / name).write_bytes(data)
        if not (work / want).exists():
            (work / want).write_bytes(raw)
        xzs.append({"file": name, "want": want, "size": len(raw) if xz else None})
    big = text[:3 << 20]  # 3 MB: more than one 2 MB LZMA2 chunk
    add("text.xz", lzma.compress(big), "text.txt", big)
    add("text-e.xz", lzma.compress(big, preset=9 | lzma.PRESET_EXTREME), "text.txt", big)
    add("text-0.xz", lzma.compress(big, preset=0), "text.txt", big)
    add("random.bin.xz", lzma.compress(SOURCES["random.bin"]), "src/random.bin", SOURCES["random.bin"])  # stored chunks
    add("empty.xz", lzma.compress(b""), "src/empty.txt", b"")
    small = big[:100_000]
    for check, label in ((lzma.CHECK_NONE, "none"), (lzma.CHECK_CRC32, "crc32"), (lzma.CHECK_SHA256, "sha256")):
        add(f"check-{label}.xz", lzma.compress(small, check=check), "small.txt", small)
    # lc/lp/pb other than the defaults, so the literal and position contexts are exercised.
    add("lclppb.xz", lzma.compress(big[:500_000], filters=[{"id": lzma.FILTER_LZMA2, "lc": 1, "lp": 3, "pb": 4}]),
        "half-mb.txt", big[:500_000])
    # A binary-ish file (x86 code), through the x86 BCJ filter; and the delta filter on 4-byte samples.
    code = bytes(random.Random(8).choice([0xe8, 0xe9, 0x00, 0xff, 0x48, 0x89, 0x8b, 0xc3]) for _ in range(200_000))
    add("code.x86.xz", lzma.compress(code, filters=[{"id": lzma.FILTER_X86}, {"id": lzma.FILTER_LZMA2}]), "code.bin", code)
    samples = b"".join(int(1000 + 800 * __import__("math").sin(i / 50)).to_bytes(4, "little") for i in range(50_000))
    add("samples.delta.xz", lzma.compress(samples, filters=[{"id": lzma.FILTER_DELTA, "dist": 4}, {"id": lzma.FILTER_LZMA2}]),
        "samples.bin", samples)
    # Two streams with stream padding between them and after (like `cat a.xz b.xz` plus padding).
    add("multi.xz", lzma.compress(b"part one\n") + b"\0" * 8 + lzma.compress(b"part two\n") + b"\0" * 4,
        "multi.txt", b"part one\npart two\n")
    add("picture.xz", lzma.compress(png), "png.bin", png)
    # Legacy .lzma: size unknown + end marker (what xz --format=lzma writes), and the same with the size filled in.
    add("text.lzma", lzma.compress(big, format=lzma.FORMAT_ALONE), "text.txt", big, xz=False)
    known = bytearray(lzma.compress(small, format=lzma.FORMAT_ALONE))
    known[5:13] = len(small).to_bytes(8, "little")
    add("known.lzma", bytes(known), "small.txt", small, xz=False)
    if shutil.which("xz"):
        def xz(args, data: bytes) -> bytes:
            return subprocess.run(["xz", "-c", *args], input=data, capture_output=True, check=True).stdout
        add("blocks.xz", xz(["-T1", "--block-size=700KiB"], big), "text.txt", big)  # 5 blocks, sizes in the headers
        add("cli-sha256.xz", xz(["--check=sha256", "-6"], big), "text.txt", big)
        add("cli.lzma", xz(["--format=lzma"], small), "small.txt", small, xz=False)
    # Archives inside xz, for untar / uncpio.
    tar_xz = io.BytesIO()
    with tarfile.open(fileobj=tar_xz, mode="w:xz") as t:
        for n in SOURCES:
            t.add(src / n, n)
    (work / "python.tar.xz").write_bytes(tar_xz.getvalue())
    if (work / "newc.cpio").exists():
        (work / "newc.cpio.xz").write_bytes(lzma.compress((work / "newc.cpio").read_bytes()))
    # Damaged: a flipped byte in the data, cut off, a wrong check, junk after the end, an unsupported filter.
    good = lzma.compress(small)
    bad = bytearray(good)
    bad[len(bad) // 2] ^= 0x55
    (work / "corrupt.xz").write_bytes(bad)
    (work / "cut.xz").write_bytes(good[: len(good) // 2])
    badcheck = bytearray(good)
    index_size = (int.from_bytes(good[-8:-4], "little") + 1) * 4  # the footer's backward size
    badcheck[-(12 + index_size + 8)] ^= 1  # first byte of the block's CRC64, just before the index
    (work / "badcheck.xz").write_bytes(badcheck)
    (work / "junk.xz").write_bytes(good + b"junk")
    (work / "arm.xz").write_bytes(lzma.compress(small, filters=[{"id": lzma.FILTER_ARM}, {"id": lzma.FILTER_LZMA2}]))
    return xzs


def make_zstd_fixtures(work: Path, src: Path, text: bytes, png: bytes) -> list:
    """.zst files from the zstd tool (none without it: the zstd tests are then skipped).
    Each entry: { file, want (fixture with the expected output), size (content size from the headers, or null) }."""
    if not shutil.which("zstd"):
        return []
    inp = work / "zstd-in.bin"
    def z(args, data: bytes, pipe=False) -> bytes:
        """zstd output. From a file the frame stores the content size; from a pipe it doesn't."""
        if pipe:
            return subprocess.run(["zstd", "-q", "-c", *args], input=data, capture_output=True, check=True).stdout
        inp.write_bytes(data)
        return subprocess.run(["zstd", "-q", "-c", *args, str(inp)], capture_output=True, check=True).stdout
    zstds = []
    def add(name, data: bytes, want: str, raw: bytes, size=True):
        (work / name).write_bytes(data)
        if not (work / want).exists():
            (work / want).write_bytes(raw)
        zstds.append({"file": name, "want": want, "size": len(raw) if size else None})
    part = text[:3 << 20]
    add("text.zst", z([], text), "bgzf-like.txt", text)  # level 3, 8 MB
    for name, args in (("text-1.zst", ["-1"]), ("text-19.zst", ["-19"]), ("text-22.zst", ["--ultra", "-22"]),
                       ("text-long.zst", ["--long=27"]), ("text-fast.zst", ["--fast=5"]), ("text-nocheck.zst", ["--no-check"]),
                       # A 128 KB window on 3 MB: the decoder keeps moving its window down.
                       ("text-wlog17.zst", ["--zstd=wlog=17"])):
        add(name, z(args, part), "zstd-text.txt", part)
    add("text-pipe.zst", z([], part, pipe=True), "zstd-text.txt", part, size=False)
    add("random.bin.zst", z([], SOURCES["random.bin"]), "src/random.bin", SOURCES["random.bin"])  # raw blocks
    add("empty.zst", z([], b""), "src/empty.txt", b"")
    small = text[:100_000]
    add("small.zst", z([], small), "zstd-small.txt", small)
    add("picture.zst", z([], png), "png.bin", png)
    # Two frames end to end (`cat a.zst b.zst`), and skippable frames around one (pzstd starts with one).
    add("multi.zst", z([], b"part one\n") + z([], b"part two\n"), "zstd-multi.txt", b"part one\npart two\n")
    skippable = lambda n, data: (0x184D2A50 + n).to_bytes(4, "little") + len(data).to_bytes(4, "little") + data
    add("skip.zst", skippable(0, b"pzstd!") + z([], small) + skippable(15, b""), "zstd-small.txt", small)
    # Frames of every length near the checksum's 32-byte stripes (XXH64's tail paths).
    lengths = [1, 3, 4, 7, 8, 9, 31, 32, 33, 40, 63, 64, 65, 100, 1000]
    add("sizes.zst", b"".join(z([], text[:n]) for n in lengths), "zstd-sizes.txt", b"".join(text[:n] for n in lengths))
    # Archives inside zstd, for untar / uncpio.
    tar = io.BytesIO()
    with tarfile.open(fileobj=tar, mode="w") as t:
        for n in SOURCES:
            t.add(src / n, n)
    (work / "python.tar.zst").write_bytes(z([], tar.getvalue()))
    if (work / "newc.cpio").exists():
        (work / "newc.cpio.zst").write_bytes(z([], (work / "newc.cpio").read_bytes()))
    # Damaged: a flipped byte, cut off, a wrong checksum, junk after the end; and unsupported:
    # a dictionary (id 7; one raw block "abc") and a 2 GB window.
    good = z(["-19"], small)
    bad = bytearray(good)
    bad[len(bad) // 2] ^= 0x55
    (work / "corrupt.zst").write_bytes(bad)
    (work / "cut.zst").write_bytes(good[: len(good) // 2])
    badcheck = bytearray(good)
    badcheck[-1] ^= 1
    (work / "badcheck.zst").write_bytes(badcheck)
    (work / "junk.zst").write_bytes(good + b"junk")
    magic = bytes.fromhex("28b52ffd")
    (work / "dict.zst").write_bytes(magic + bytes([0x21, 7, 3, 0x19, 0, 0]) + b"abc")
    (work / "bigwindow.zst").write_bytes(magic + bytes([0x00, 21 << 3, 0x19, 0, 0]) + b"abc")
    inp.unlink()
    return zstds


def n7(v: int) -> bytes:
    """A 7z variable-length number: i leading 1 bits in the first byte = i more bytes (little-endian)."""
    for i in range(9):
        if i == 8 or v < 1 << (7 * (i + 1)):
            first = (0xFF << (8 - i)) & 0xFF if i < 8 else 0xFF
            high = v >> (8 * i) if i < 8 else 0
            return bytes([first | high]) + v.to_bytes(8, "little")[:i]


def bits7(flags: list) -> bytes:
    """A 7z bit vector, highest bit first."""
    out = bytearray((len(flags) + 7) // 8)
    for i, f in enumerate(flags):
        if f:
            out[i // 8] |= 0x80 >> (i % 8)
    return bytes(out)


def hand7z(folders: list, empties=(), header_crc_ok=True) -> bytes:
    """A 7z built by hand, for coder chains libarchive can't write. folders: [{ coders: [(id, props)] (coder 0 is
    the outermost; coder i reads coder i+1's output), sizes: [each coder's output size], pack, files: [(name, data)] }].
    empties: names of empty files. Header not compressed."""
    packs = b"".join(f["pack"] for f in folders)
    h = bytearray([0x01, 0x04, 0x06]) + n7(0) + n7(len(folders)) + b"\x09" + b"".join(n7(len(f["pack"])) for f in folders) + b"\x00"
    h += b"\x07\x0b" + n7(len(folders)) + b"\x00"
    for f in folders:
        h += n7(len(f["coders"]))
        for cid, props in f["coders"]:
            h += bytes([len(cid) | (0x20 if props else 0)]) + cid + (n7(len(props)) + props if props else b"")
        for i in range(len(f["coders"]) - 1):
            h += n7(i) + n7(i + 1)  # coder i's input <- coder i+1's output
    h += b"\x0c" + b"".join(n7(x) for f in folders for x in f["sizes"])
    h += b"\x00\x08\x0d" + b"".join(n7(len(f["files"])) for f in folders)
    h += b"\x09" + b"".join(n7(len(d)) for f in folders for _, d in f["files"][:-1])
    h += b"\x0a\x01" + b"".join(zlib.crc32(d).to_bytes(4, "little") for f in folders for _, d in f["files"])
    h += b"\x00\x00"
    names = [n for f in folders for n, _ in f["files"]] + list(empties)
    h += b"\x05" + n7(len(names))
    if empties:
        flags = [False] * (len(names) - len(empties)) + [True] * len(empties)
        h += b"\x0e" + n7(len(bits7(flags))) + bits7(flags)
        h += b"\x0f" + n7(len(bits7([True] * len(empties)))) + bits7([True] * len(empties))
    utf16 = b"\x00" + b"".join(n.encode("utf-16-le") + b"\x00\x00" for n in names)
    h += b"\x11" + n7(len(utf16)) + utf16 + b"\x00\x00"
    tail = len(packs).to_bytes(8, "little") + len(h).to_bytes(8, "little") + (zlib.crc32(h) ^ (0 if header_crc_ok else 1)).to_bytes(4, "little")
    return b"7z\xbc\xaf\x27\x1c\x00\x04" + zlib.crc32(tail).to_bytes(4, "little") + tail + packs + bytes(h)


def libarchive_7z(path: Path, items: list, compression: str) -> bool:
    """Write a .7z with libarchive (through ctypes; it's often installed without bsdtar). items: [(name, bytes |
    None for a folder | ('link', target))]. False if libarchive isn't there."""
    import ctypes
    import ctypes.util
    try:
        la = ctypes.CDLL(ctypes.util.find_library("archive") or "libarchive.so.13")
    except OSError:
        return False
    vp, cp = ctypes.c_void_p, ctypes.c_char_p
    la.archive_write_new.restype = vp
    la.archive_entry_new.restype = vp
    la.archive_error_string.restype = cp
    for name, args in (("archive_write_set_format_7zip", [vp]), ("archive_write_set_options", [vp, cp]),
                       ("archive_write_open_filename", [vp, cp]), ("archive_write_header", [vp, vp]),
                       ("archive_write_data", [vp, cp, ctypes.c_size_t]), ("archive_write_close", [vp]),
                       ("archive_write_free", [vp]), ("archive_error_string", [vp]),
                       ("archive_entry_set_pathname_utf8", [vp, cp]), ("archive_entry_set_symlink_utf8", [vp, cp]),
                       ("archive_entry_set_size", [vp, ctypes.c_int64]), ("archive_entry_set_filetype", [vp, ctypes.c_uint]),
                       ("archive_entry_set_perm", [vp, ctypes.c_uint]), ("archive_entry_set_mtime", [vp, ctypes.c_int64, ctypes.c_long]),
                       ("archive_entry_free", [vp])):
        getattr(la, name).argtypes = args
    la.archive_write_data.restype = ctypes.c_ssize_t
    a = la.archive_write_new()
    try:
        if la.archive_write_set_format_7zip(a) or la.archive_write_set_options(a, f"compression={compression}".encode()):
            return False
        assert la.archive_write_open_filename(a, str(path).encode()) == 0, la.archive_error_string(a)
        for name, data in items:
            e = la.archive_entry_new()
            la.archive_entry_set_pathname_utf8(e, name.encode())
            la.archive_entry_set_mtime(e, 1715000000, 0)
            if data is None:
                la.archive_entry_set_filetype(e, 0o040000)
                la.archive_entry_set_perm(e, 0o755)
            elif isinstance(data, tuple):
                la.archive_entry_set_filetype(e, 0o120000)
                la.archive_entry_set_perm(e, 0o777)
                la.archive_entry_set_symlink_utf8(e, data[1].encode())
            else:
                la.archive_entry_set_filetype(e, 0o100000)
                la.archive_entry_set_perm(e, 0o644)
                la.archive_entry_set_size(e, len(data))
            assert la.archive_write_header(a, e) == 0, la.archive_error_string(a)
            if isinstance(data, bytes) and data:
                assert la.archive_write_data(a, data, len(data)) == len(data)
            la.archive_entry_free(e)
        assert la.archive_write_close(a) == 0, la.archive_error_string(a)
    finally:
        la.archive_write_free(a)
    return True


def find_7z():
    """The 7-Zip command line (7zz is 7-Zip's own Linux build; 7z / 7za are p7zip), or None."""
    return next((t for t in ("7zz", "7z", "7za") if shutil.which(t)), None)


def make_7z_fixtures(work: Path, src: Path) -> list:
    """.7z files from libarchive, from hand7z (coder chains), and from the 7-Zip command line if installed.
    Each entry: { file, files: { name: fixture with its content }, links: { name: target }, dirs: [names],
    problem (start of the message for an unsupported method, or null) }."""
    out = []
    names = list(SOURCES)
    files = {n: f"src/{n}" for n in names}
    # libarchive: a folder, a symlink, every file; one solid folder (store: one folder per file).
    items = [(n, SOURCES[n]) for n in names] + [("dir", None), ("link-to-hello", ("link", "hello.txt"))]
    for c, problem in (("lzma2", None), ("lzma1", None), ("deflate", None), ("store", None), ("bzip2", None)):
        if libarchive_7z(work / f"la-{c}.7z", items, c):
            # A symlink's target is its data: it can't be read when the method isn't supported (it lists as "?").
            links = {"link-to-hello": "?" if problem else "hello.txt"}
            out.append({"file": f"la-{c}.7z", "files": files, "links": links, "dirs": ["dir"], "problem": problem})
    # By hand: BCJ x86 + LZMA2, Delta + LZMA1 (raw streams from liblzma), two folders, an empty file.
    code = bytes(random.Random(8).choice([0xe8, 0xe9, 0x00, 0xff, 0x48, 0x89, 0x8b, 0xc3]) for _ in range(200_000))
    (work / "code.bin").write_bytes(code)
    samples = b"".join(int(1000 + 800 * __import__("math").sin(i / 50)).to_bytes(4, "little") for i in range(50_000))
    (work / "samples.bin").write_bytes(samples)
    bcj = lzma.compress(code, format=lzma.FORMAT_RAW, filters=[{"id": lzma.FILTER_X86}, {"id": lzma.FILTER_LZMA2, "dict_size": 1 << 20}])
    lz1 = {"id": lzma.FILTER_LZMA1, "dict_size": 1 << 20, "lc": 3, "lp": 0, "pb": 2}
    delta = lzma.compress(samples, format=lzma.FORMAT_RAW, filters=[{"id": lzma.FILTER_DELTA, "dist": 4}, lz1])
    hello, nested = SOURCES["hello.txt"], SOURCES["dir/sub/nested.csv"]
    two = lzma.compress(hello + nested, format=lzma.FORMAT_RAW, filters=[lz1])
    lzma_props = bytes([93]) + (1 << 20).to_bytes(4, "little")  # lc 3, lp 0, pb 2; 1 MB dictionary
    folders = [
        {"coders": [(b"\x03\x03\x01\x03", b""), (b"\x21", bytes([16]))], "sizes": [len(code), len(code)], "pack": bcj,
         "files": [("bin/code.bin", code)]},
        {"coders": [(b"\x03", bytes([3])), (b"\x03\x01\x01", lzma_props)], "sizes": [len(samples), len(samples)], "pack": delta,
         "files": [("samples.bin", samples)]},
        {"coders": [(b"\x03\x01\x01", lzma_props)], "sizes": [len(hello) + len(nested)], "pack": two,
         "files": [("hello.txt", hello), ("dir/sub/nested.csv", nested)]},
    ]
    (work / "hand.7z").write_bytes(hand7z(folders, empties=["empty.txt"]))
    out.append({"file": "hand.7z", "files": {"bin/code.bin": "code.bin", "samples.bin": "samples.bin", "hello.txt": "src/hello.txt",
                "dir/sub/nested.csv": "src/dir/sub/nested.csv", "empty.txt": "src/empty.txt"}, "links": {}, "dirs": [], "problem": None})
    # Damaged and unsupported, by hand.
    plain = [{"coders": [(b"\x00", b"")], "sizes": [len(hello)], "pack": hello, "files": [("hello.txt", hello)]}]
    good = hand7z(plain)
    (work / "badcrc.7z").write_bytes(good[:40] + bytes([good[40] ^ 1]) + good[41:])  # a byte of hello.txt's data
    (work / "badheader.7z").write_bytes(hand7z(plain, header_crc_ok=False))
    (work / "cut.7z").write_bytes(good[:-10])
    (work / "aes.7z").write_bytes(hand7z([dict(plain[0], coders=[(b"\x06\xf1\x07\x01", b"\x00")])]))
    (work / "ppmd.7z").write_bytes(hand7z([dict(plain[0], coders=[(b"\x03\x04\x01", b"\x06\x00\x00\x10\x00")])]))
    (work / "empty.7z").write_bytes(b"7z\xbc\xaf\x27\x1c\x00\x04" + zlib.crc32(bytes(20)).to_bytes(4, "little") + bytes(20))
    # The 7-Zip command line (CI installs p7zip-full): its defaults and the methods and filters people use.
    tool = find_7z()
    if tool:
        def sz(name, *args, problem=None, password=False):
            subprocess.run([tool, "a", "-t7z", "-bd", "-y", *args, str(work / name), "."], cwd=src, check=True, capture_output=True)
            out.append({"file": name, "files": files, "links": {}, "dirs": ["dir", "dir/sub"], "problem": problem})
        sz("cli.7z")  # LZMA2, solid, compressed header
        sz("cli-mx9.7z", "-mx=9")
        sz("cli-nonsolid.7z", "-ms=off", "-mhc=off")  # a folder per file, plain header
        sz("cli-lzma.7z", "-m0=LZMA")
        sz("cli-bcj.7z", "-m0=BCJ", "-m1=LZMA2")
        sz("cli-delta.7z", "-m0=Delta:4", "-m1=LZMA")
        sz("cli-deflate.7z", "-m0=Deflate")
        sz("cli-copy.7z", "-m0=Copy")
        sz("cli-bzip2.7z", "-m0=BZip2")
        sz("cli-ppmd.7z", "-m0=PPMd", problem="the 7z PPMd method")
        sz("cli-aes.7z", "-psecret", problem="this 7z is encrypted")
        subprocess.run([tool, "a", "-t7z", "-bd", "-y", "-psecret", "-mhe=on", str(work / "cli-aes-names.7z"), "."],
                       cwd=src, check=True, capture_output=True)
    return out


def make_bzip2_fixtures(work: Path, src: Path, text: bytes, png: bytes) -> list:
    """.bz2 files from the bzip2 tool (none without it: the bzip2 tests are then skipped).
    Each entry: { file, want (fixture with the expected output) }."""
    if not shutil.which("bzip2"):
        return []
    def bz(data: bytes, *args) -> bytes:
        return subprocess.run(["bzip2", "-c", *args], input=data, capture_output=True, check=True).stdout
    bzip2s = []
    def add(name, data: bytes, want: str, raw: bytes):
        (work / name).write_bytes(data)
        if not (work / want).exists():
            (work / want).write_bytes(raw)
        bzip2s.append({"file": name, "want": want})
    part = text[:3 << 20]
    add("text.bz2", bz(part), "bzip2-text.txt", part)  # -9: 900 KB blocks
    add("text-1.bz2", bz(part, "-1"), "bzip2-text.txt", part)  # 100 KB blocks: 32 of them
    add("random.bin.bz2", bz(SOURCES["random.bin"]), "src/random.bin", SOURCES["random.bin"])
    add("empty.bz2", bz(b""), "src/empty.txt", b"")
    add("one.bz2", bz(b"x"), "bzip2-one.txt", b"x")
    add("picture.bz2", bz(png), "png.bin", png)
    # Runs of every length around the first run-length step's 4 (+ a count up to 255), and long
    # zero runs in the MTF output (RUNA / RUNB).
    runs = b"".join(bytes([65 + n % 26]) * n for n in range(1, 300)) + bytes(1_000_000) + b"end" + b"ab" * 50_000
    add("runs.bz2", bz(runs, "-1"), "bzip2-runs.bin", runs)
    # Two streams end to end (`cat a.bz2 b.bz2`, pbzip2), and zero padding after the end.
    small = text[:100_000]
    add("multi.bz2", bz(b"part one\n") + bz(b"part two\n", "-1"), "bzip2-multi.txt", b"part one\npart two\n")
    add("padded.bz2", bz(small) + bytes(512), "bzip2-small.txt", small)
    # Archives inside bzip2, for untar / uncpio.
    tar = io.BytesIO()
    with tarfile.open(fileobj=tar, mode="w") as t:
        for n in SOURCES:
            t.add(src / n, n)
    (work / "python.tar.bz2").write_bytes(bz(tar.getvalue()))
    if (work / "newc.cpio").exists():
        (work / "newc.cpio.bz2").write_bytes(bz((work / "newc.cpio").read_bytes()))
    # Damaged: a flipped byte, cut off, a wrong block CRC (bytes 10-13, after "BZh9" and the
    # block magic), a wrong stream CRC (the last 32 bits before the padding), junk after the end;
    # and a block with the "randomised" bit set (bit 112), which only bzip2 0.9.x wrote.
    good = bz(small)
    def damaged(name, at, mask):
        bad = bytearray(good)
        bad[at] ^= mask
        (work / name).write_bytes(bad)
    damaged("corrupt.bz2", len(good) // 2, 0x55)
    damaged("badcrc.bz2", 11, 0x01)
    damaged("badstreamcrc.bz2", len(good) - 2, 0x01)
    damaged("randomised.bz2", 14, 0x80)
    (work / "cut.bz2").write_bytes(good[: len(good) // 2])
    (work / "junk.bz2").write_bytes(good + b"junk")
    return bzip2s


def make_brotli_fixtures(work: Path, png: bytes) -> bool:
    """.br files from the Python brotli module (pip install brotli). Without it the brotli tests are skipped."""
    try:
        import brotli
    except ImportError:
        return False
    (work / "hello.txt.br").write_bytes(brotli.compress(SOURCES["hello.txt"]))
    (work / "random.bin.br").write_bytes(brotli.compress(SOURCES["random.bin"], quality=5))
    (work / "picture.br").write_bytes(brotli.compress(png))  # no inner extension: named from the content
    (work / "empty.br").write_bytes(brotli.compress(b""))
    whole = brotli.compress(SOURCES["hello.txt"] + SOURCES["random.bin"])
    (work / "cut.br").write_bytes(whole[:len(whole) // 2])
    (work / "not.br").write_bytes(b"hello, this is not brotli at all\n" * 4)
    return True


def verify_brotli(work: Path, results: list):
    """Check the .br the browser wrote with the Python brotli module."""
    p = work / "written.br"
    try:
        import brotli
    except ImportError:
        return
    if not p.exists():
        return  # the browser has no native brotli encoder: zip-test.js logged a SKIP
    ok = brotli.decompress(p.read_bytes()) == SOURCES["unicodé 名前.txt"] * 50
    results.append(f"{'PASS' if ok else 'FAIL'} written.br: python brotli decompresses it")


# A hand-written module exporting add(i32, i32) -> i32, for the WebAssembly / CSP check.
ADD_WASM = bytes.fromhex(
    "0061736d01000000"            # magic, version 1
    "0107016002" "7f7f017f"       # type: (i32, i32) -> i32
    "03020100"                    # function 0 has type 0
    "070701036164640000"          # export "add" = function 0
    "0a09010700200020016a0b"      # code: local.get 0, local.get 1, i32.add
)


try:
    from PIL import Image, ImageCms, ImageOps, PngImagePlugin
except ImportError:
    Image = None

# Quadrant colours of img/rotated.jpg (40 x 20 stored, EXIF orientation 6: shown 20 x 40).
QUADS = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255)]


def pattern(w: int, h: int):
    im = Image.new("RGB", (w, h))
    im.putdata([(x * 4 % 256, y * 5 % 256, (x + y) * 2 % 256) for y in range(h) for x in range(w)])
    return im


def png16(w: int, h: int, value) -> bytes:
    """A 16-bit grayscale PNG, by hand (Pillow 9 mangles I;16 data)."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + b"".join(struct.pack(">H", value(x, y)) for x in range(w)) for y in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 16, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def qoi_encode(w: int, h: int, px: list) -> bytes:
    """QOI (qoiformat.org) from RGBA tuples, as the reference encoder does it (an independent check on lib/imagefmt.js)."""
    out = bytearray(b"qoif" + struct.pack(">IIBB", w, h, 4, 0))
    index = [(0, 0, 0, 0)] * 64
    prev, run = (0, 0, 0, 255), 0
    for i, p in enumerate(px):
        if p == prev:
            run += 1
            if run == 62 or i == len(px) - 1:
                out.append(0xc0 | (run - 1))
                run = 0
            continue
        if run:
            out.append(0xc0 | (run - 1))
            run = 0
        r, g, b, a = p
        hh = (r * 3 + g * 5 + b * 7 + a * 11) % 64
        if index[hh] == p:
            out.append(hh)
        else:
            index[hh] = p
            if a == prev[3]:
                dr, dg, db = [((x - y + 128) & 255) - 128 for x, y in zip(p[:3], prev[:3])]
                if -2 <= dr <= 1 and -2 <= dg <= 1 and -2 <= db <= 1:
                    out.append(0x40 | (dr + 2) << 4 | (dg + 2) << 2 | (db + 2))
                elif -32 <= dg <= 31 and -8 <= dr - dg <= 7 and -8 <= db - dg <= 7:
                    out += bytes([0x80 | (dg + 32), (dr - dg + 8) << 4 | (db - dg + 8)])
                else:
                    out += bytes([0xfe, r, g, b])
            else:
                out += bytes([0xff, r, g, b, a])
        prev = p
    return bytes(out + b"\0" * 7 + b"\1")


def qoi_decode(data: bytes):
    """(width, height, channels, [RGBA tuples]) of a QOI file; raises ValueError if it's malformed."""
    if data[:4] != b"qoif" or data[-8:] != b"\0" * 7 + b"\1":
        raise ValueError("no QOI magic or end marker")
    w, h, channels, _ = struct.unpack(">IIBB", data[4:14])
    index = [(0, 0, 0, 0)] * 64
    r, g, b, a = 0, 0, 0, 255
    px, p, end = [], 14, len(data) - 8
    while len(px) < w * h:
        if p >= end:
            raise ValueError(f"ran out of data after {len(px)} pixels")
        b1 = data[p]
        p += 1
        if b1 == 0xfe:
            r, g, b = data[p:p + 3]
            p += 3
        elif b1 == 0xff:
            r, g, b, a = data[p:p + 4]
            p += 4
        elif b1 >> 6 == 0:
            r, g, b, a = index[b1]
        elif b1 >> 6 == 1:
            r, g, b = (r + (b1 >> 4 & 3) - 2) & 255, (g + (b1 >> 2 & 3) - 2) & 255, (b + (b1 & 3) - 2) & 255
        elif b1 >> 6 == 2:
            b2, dg = data[p], (b1 & 63) - 32
            p += 1
            r, g, b = (r + dg - 8 + (b2 >> 4)) & 255, (g + dg) & 255, (b + dg - 8 + (b2 & 15)) & 255
        else:
            px += [(r, g, b, a)] * ((b1 & 63) + 1)
            index[(r * 3 + g * 5 + b * 7 + a * 11) % 64] = (r, g, b, a)
            continue
        index[(r * 3 + g * 5 + b * 7 + a * 11) % 64] = (r, g, b, a)
        px.append((r, g, b, a))
    if p != end or len(px) != w * h:
        raise ValueError(f"{len(px)} pixels for {w} x {h}, {end - p} bytes left over")
    return w, h, channels, px


def alpha_pattern(w: int, h: int):
    """RGBA with every kind of pixel QOI has an op for: runs, small and larger steps, alpha changes, transparent colours."""
    im = Image.new("RGBA", (w, h))
    im.putdata([(x * 4 % 256, y * 5 % 256, 255 - x, 255 if x < w // 2 else (x * 9 + y) % 256)
                if y % 8 else (10, 20, 30, 255) for y in range(h) for x in range(w)])
    return im


def pnm(magic: str, w: int, h: int, maxval, samples, ascii_=False, comment=None) -> bytes:
    """A PNM by hand (Pillow 9 writes only P4 / P5 / P6 at 8 bits)."""
    head = f"{magic}\n" + (f"# {comment}\n" if comment else "") + f"{w} {h}\n" + (f"{maxval}\n" if maxval else "")
    if ascii_:
        return (head + "\n".join(" ".join(map(str, samples[i:i + 12])) for i in range(0, len(samples), 12)) + "\n").encode()
    return head.encode() + b"".join(struct.pack(">H" if maxval > 255 else "B", v) for v in samples)


def make_image_fixtures(work: Path) -> bool:
    """img/*: sources for the convert op, made with Pillow (the tests are skipped without it)."""
    if Image is None:
        return False
    d = work / "img"
    d.mkdir()
    (work / "img-out").mkdir()
    opaque = pattern(64, 48)
    opaque.save(d / "opaque.png")
    opaque.save(d / "opaque.bmp")
    opaque.save(d / "photo.webp", quality=90)
    alpha = Image.new("RGBA", (64, 48), (200, 50, 50, 255))
    alpha.paste((0, 0, 255, 0), (0, 0, 32, 48))
    text = PngImagePlugin.PngInfo()
    text.add_text("Comment", "made by run_tests.py")
    alpha.save(d / "alpha.png", pnginfo=text)
    rot = Image.new("RGB", (40, 20))
    for i, c in enumerate(QUADS):
        rot.paste(c, (i % 2 * 20, i // 2 * 10, i % 2 * 20 + 20, i // 2 * 10 + 10))
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x8825] = {1: "N", 2: (51.0, 30.0, 0.0)}
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    rot.save(d / "rotated.jpg", quality=95, exif=exif, icc_profile=icc)
    red, blue = Image.new("RGB", (32, 32), (255, 0, 0)), Image.new("RGB", (32, 32), (0, 0, 255))
    red.save(d / "anim.gif", save_all=True, append_images=[blue], duration=100, loop=0)
    red.save(d / "anim.png", save_all=True, append_images=[blue], duration=100)
    red.save(d / "anim.webp", save_all=True, append_images=[blue], duration=100, lossless=True)
    (d / "deep.png").write_bytes(png16(32, 32, lambda x, y: (x * 32 + y) * 64))
    lossless = Image.new("RGBA", (48, 32), (10, 200, 30, 255))
    lossless.paste((0, 0, 0, 0), (0, 0, 24, 32))
    lossless.save(d / "lossless.webp", lossless=True)
    icon = Image.new("RGBA", (48, 48), (20, 40, 220, 255))
    icon.save(d / "icons.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    # Formats read and written by lib/imagefmt.js.
    ap = alpha_pattern(40, 24)
    (d / "alpha.qoi").write_bytes(qoi_encode(40, 24, list(ap.getdata())))
    ap.save(d / "alpha.tga")                                   # 32-bit, bottom-up
    opaque.save(d / "rle.tga", compression="tga_rle")         # 24-bit RLE
    opaque.save(d / "top.tga", orientation=1)                  # top-down
    opaque.quantize(16).save(d / "palette.tga")                # colour-mapped
    opaque.save(d / "opaque.ppm")                              # P6
    grey = opaque.convert("L")
    grey.save(d / "grey.pgm")                                  # P5
    (d / "deep.pgm").write_bytes(pnm("P5", 32, 32, 65535, [(x * 32 + y) * 64 for y in range(32) for x in range(32)]))
    (d / "ascii.ppm").write_bytes(pnm("P3", 64, 48, 255, [c for p in opaque.getdata() for c in p], True, "made by run_tests.py"))
    bits = [(x // 4 + y // 4) % 2 for y in range(20) for x in range(30)]  # 1 = black
    (d / "ascii.pbm").write_bytes(pnm("P1", 30, 20, None, bits, True))
    (d / "packed.pbm").write_bytes(b"P4\n30 20\n" + b"".join(
        int("".join(map(str, bits[y * 30:y * 30 + 30])) + "00", 2).to_bytes(4, "big") for y in range(20)))
    (d / "alpha.pam").write_bytes(b"P7\nWIDTH 40\nHEIGHT 24\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n"
                                  + bytes(c for p in ap.getdata() for c in p))
    checker = Image.new("L", (300, 300))
    checker.putdata([255 * ((x + y) % 2) for y in range(300) for x in range(300)])
    checker.convert("RGB").save(d / "checker.png")
    return True


def verify_images(work: Path, results: list):
    """The images the browser converted (uploaded as img-out/<name>), checked with Pillow."""
    def check(ok, msg):
        results.append(f"{'PASS' if ok else 'FAIL'} {msg}")

    if Image is None:
        results.append("SKIP convert: Pillow not installed (pip install pillow)")
        return
    out, src = work / "img-out", work / "img"

    def load(name, fmt, size):
        p = out / name
        if not p.exists():
            check(False, f"convert: {name} was not uploaded")
            return None
        im = Image.open(p)
        im.load()
        ok = im.format == fmt and im.size == size
        check(ok, f"convert: {name} is a {fmt} of {size} ({im.format}, {im.size}, {im.mode})")
        return im if ok else None

    def close(a, b, tol):
        return max(abs(x - y) for p, q in zip(a, b) for x, y in zip(p if isinstance(p, tuple) else (p,), q if isinstance(q, tuple) else (q,))) <= tol

    want = pattern(64, 48)
    if im := load("opaque.bmp", "BMP", (64, 48)):
        check(im.mode == "RGB" and list(im.getdata()) == list(want.getdata()), "convert: PNG -> BMP (ours) has the same pixels")
    if im := load("opaque-from-bmp.png", "PNG", (64, 48)):
        check(list(im.convert("RGB").getdata()) == list(want.getdata()), "convert: BMP -> PNG has the same pixels")
    if im := load("photo.png", "PNG", (64, 48)):
        ref = Image.open(src / "photo.webp").convert("RGB")
        check(close(list(im.convert("RGB").getdata()), list(ref.getdata()), 8), "convert: lossy WebP -> PNG matches Pillow's decode")
    if im := load("alpha.jpg", "JPEG", (64, 48)):
        px = im.convert("RGB")
        check(close([px.getpixel((8, 20))], [(255, 255, 255)], 6) and close([px.getpixel((50, 20))], [(200, 50, 50)], 12),
              f"convert: PNG -> JPEG fills transparency with white ({px.getpixel((8, 20))}, {px.getpixel((50, 20))})")
        check(not im.info.get("exif") and not im.info.get("icc_profile"), "convert: the JPEG has no EXIF or ICC profile")
    if im := load("alpha.webp", "WEBP", (64, 48)):
        px = im.convert("RGBA")
        check(px.getpixel((8, 20))[3] == 0 and px.getpixel((50, 20))[3] == 255 and close([px.getpixel((50, 20))[:3]], [(200, 50, 50)], 12),
              f"convert: PNG -> WebP keeps transparency ({px.getpixel((8, 20))}, {px.getpixel((50, 20))})")
    if im := load("rotated.png", "PNG", (20, 40)):
        ref = ImageOps.exif_transpose(Image.open(src / "rotated.jpg")).convert("RGB")
        pts = [(5, 5), (15, 5), (5, 35), (15, 35), (5, 15), (15, 25)]
        got, exp = [im.convert("RGB").getpixel(p) for p in pts], [ref.getpixel(p) for p in pts]
        check(close(got, exp, 12), f"convert: JPEG -> PNG is turned upright from EXIF orientation 6 ({got} vs {exp})")
        check("exif" not in im.info and "icc_profile" not in im.info and not im.getexif(), "convert: the PNG has no EXIF or ICC profile")
    for name in ("anim-gif.png", "anim-png.png", "anim-webp.png"):
        if im := load(name, "PNG", (32, 32)):
            check(close([im.convert("RGB").getpixel((16, 16))], [(255, 0, 0)], 2) and not getattr(im, "is_animated", False),
                  f"convert: {name}: one frame, the first one")
    if im := load("deep.png", "PNG", (32, 32)):
        got = [p[0] if isinstance(p, tuple) else p for p in im.getdata()]
        exp = [((x * 32 + y) * 64) / 257 for y in range(32) for x in range(32)]
        worst = max(abs(a - b) for a, b in zip(got, exp))
        check(im.mode in ("L", "LA", "RGB", "RGBA") and worst <= 2, f"convert: 16-bit PNG -> 8-bit PNG ({im.mode}, off by {worst:.1f} at most)")
    if im := load("lossless.bmp", "BMP", (48, 32)):
        check(im.getpixel((5, 5)) == (255, 255, 255) and im.getpixel((40, 5)) == (10, 200, 30),
              f"convert: lossless WebP -> BMP, transparency white ({im.getpixel((5, 5))}, {im.getpixel((40, 5))})")
    if im := load("icons.png", "PNG", (48, 48)):
        check(close([im.convert("RGB").getpixel((24, 24))], [(20, 40, 220)], 2), "convert: ICO -> PNG, the 48 x 48 icon")

    # lib/imagefmt.js: QOI, TGA, PNM in and out, and the ICO writer.
    ap = list(alpha_pattern(40, 24).getdata())
    def same(got, exp, what, opaque_only=False):
        bad = [i for i, (p, q) in enumerate(zip(got, exp)) if (p != q and not (opaque_only and q[3] < 255 and p[3] == q[3]))]
        check(len(got) == len(exp) and not bad, f"convert: {what}" + (f" (pixel {bad[0]}: {got[bad[0]]} vs {exp[bad[0]]})" if bad else ""))
    if im := load("alpha-from-qoi.tga", "TGA", (40, 24)):
        same(list(im.convert("RGBA").getdata()), ap, "QOI -> TGA (no canvas in between) keeps every pixel, transparent ones too")
    if im := load("alpha-from-qoi.png", "PNG", (40, 24)):
        same([p if p[3] == 255 else (0, 0, 0, p[3]) for p in im.convert("RGBA").getdata()],
             [p if p[3] == 255 else (0, 0, 0, p[3]) for p in ap], "QOI -> PNG: the opaque pixels and every alpha value", True)
    for name, src_name, what in (("alpha.qoi", "alpha.tga", "TGA (32-bit, bottom-up) -> QOI"), ("pam.qoi", "alpha.pam", "PAM -> QOI")):
        p = out / name
        try:
            w, h, ch, px = qoi_decode(p.read_bytes())
            check((w, h, ch) == (40, 24, 4), f"convert: {name} is a 40 x 24 QOI with alpha ({w} x {h}, {ch} channels)")
            same(px, ap, f"{what} keeps every pixel")
        except (OSError, ValueError) as e:
            check(False, f"convert: {name}: {e}")
    try:
        w, h, ch, px = qoi_decode((out / "opaque.qoi").read_bytes())
        check((w, h, ch) == (64, 48, 3) and px == [p + (255,) for p in want.getdata()],
              f"convert: PNG -> QOI: 3 channels, the same pixels ({w} x {h}, {ch} channels)")
        size = (out / "opaque.qoi").stat().st_size
        check(size == len(qoi_encode(64, 48, [p + (255,) for p in want.getdata()])), f"convert: our QOI is the reference encoder's size ({size})")
    except (OSError, ValueError) as e:
        check(False, f"convert: opaque.qoi: {e}")
    if im := load("alpha.tga", "TGA", (64, 48)):
        px = im.convert("RGBA")
        check(px.getpixel((8, 20)) == (0, 0, 0, 0) and px.getpixel((50, 20)) == (200, 50, 50, 255),
              f"convert: PNG -> TGA keeps transparency ({px.getpixel((8, 20))}, {px.getpixel((50, 20))})")
    wrgb = list(want.getdata())
    for name in ("rle.png", "top.png", "opaque-from-ppm.png", "ascii-ppm.png"):
        if im := load(name, "PNG", (64, 48)):
            check(list(im.convert("RGB").getdata()) == wrgb, f"convert: {name}: the same pixels as the source")
    if im := load("palette.png", "PNG", (64, 48)):
        ref = Image.open(src / "palette.tga").convert("RGB")
        check(list(im.convert("RGB").getdata()) == list(ref.getdata()), "convert: colour-mapped TGA -> PNG: Pillow's colours")
    if im := load("grey.png", "PNG", (64, 48)):
        check([p[0] for p in im.convert("RGB").getdata()] == list(want.convert("L").getdata()), "convert: PGM -> PNG, the same greys")
    if im := load("deep-pgm.png", "PNG", (32, 32)):
        got = [p[0] for p in im.convert("RGB").getdata()]
        exp = [round((x * 32 + y) * 64 * 255 / 65535) for y in range(32) for x in range(32)]
        check(got == exp, "convert: 16-bit PGM -> PNG, scaled to 8 bits")
    bw = [0 if (x // 4 + y // 4) % 2 else 255 for y in range(20) for x in range(30)]
    for name in ("ascii-pbm.png", "packed-pbm.png"):
        if im := load(name, "PNG", (30, 20)):
            check([p[0] for p in im.convert("RGB").getdata()] == bw, f"convert: {name}: black and white where the PBM says")
    if im := load("alpha.ppm", "PPM", (64, 48)):
        check(im.getpixel((8, 20)) == (255, 255, 255) and im.getpixel((50, 20)) == (200, 50, 50),
              f"convert: PNG -> PPM, transparency white ({im.getpixel((8, 20))}, {im.getpixel((50, 20))})")
    for name, size, sizes in (("opaque.ico", (48, 48), {(16, 16), (32, 32), (48, 48)}),
                              ("checker.ico", (256, 256), {(16, 16), (32, 32), (48, 48), (256, 256)})):
        if not (im := load(name, "ICO", size)):
            continue
        check(set(im.ico.sizes()) == sizes, f"convert: {name} holds {sorted(sizes)} ({sorted(im.ico.sizes())})")
        if name == "opaque.ico":
            px = im.convert("RGBA")
            check(px.getpixel((24, 2))[3] == 0 and px.getpixel((24, 45))[3] == 0 and px.getpixel((24, 24))[3] == 255,
                  f"convert: a 64 x 48 image as a 48 x 48 icon: centred, transparent above and below ({px.getpixel((24, 2))}, {px.getpixel((24, 24))})")
        else:
            im.size = (16, 16)
            im.load()
            greys = [p[0] for p in im.convert("RGB").getdata()]
            check(min(greys) >= 96 and max(greys) <= 160,
                  f"convert: a 1-pixel checkerboard shrunk to 16 x 16 is grey, not aliased ({min(greys)}-{max(greys)})")


def make_wasm(work: Path) -> None:
    """add.wasm -> add.wasm.js through tools/wasm2js.py, the same way ops will ship wasm."""
    (work / "add.wasm").write_bytes(ADD_WASM)
    subprocess.run([sys.executable, str(ROOT / "tools" / "wasm2js.py"), str(work / "add.wasm")],
                   check=True, stdout=subprocess.DEVNULL)


def csp_check_page(query: str) -> bytes:
    """A page with index.html's own <meta> CSP (GitHub Pages only has that one) that runs test/wasm-csp.js.
    ?nowasm drops 'wasm-unsafe-eval', ?noworker drops worker-src, to show the checks can fail."""
    html = (ROOT / "public" / "index.html").read_text()
    meta = re.search(r'<meta http-equiv="Content-Security-Policy"[^>]*>', html).group(0)
    if "nowasm" in query:
        meta = meta.replace(" 'wasm-unsafe-eval'", "")
    if "noworker" in query:
        meta = re.sub(r" worker-src [^;]*;", "", meta)
    return (f'<!doctype html><meta charset="utf-8">{meta}'
            '<script type="module" src="/test/wasm-csp.js"></script>').encode()


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
            if self.path.split("?")[0] == "/csp-check.html":
                body = csp_check_page(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
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
    verify_cpio(work, results)
    verify_sums(work, results)
    verify_textenc(work, results)
    verify_brotli(work, results)
    verify_images(work, results)

    print("\n".join(results))
    fails = sum(r.startswith("FAIL") for r in results)
    skips = sum(r.startswith("SKIP") for r in results)
    print(f"\n{len(results) - fails - skips} passed, {fails} failed" + (f", {skips} skipped" if skips else ""))
    shutil.rmtree(work, ignore_errors=True)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
