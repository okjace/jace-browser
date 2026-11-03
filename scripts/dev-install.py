#!/usr/bin/env python3
"""Try Jace Browser's features in a regular Firefox, without a full build.

    python3 scripts/dev-install.py "/Applications/Firefox.app"      # macOS
    python3 scripts/dev-install.py "C:\\Program Files\\Mozilla Firefox"  # Windows
    python3 scripts/dev-install.py /usr/lib/firefox                  # Linux (a Firefox you can write to)
    python3 scripts/dev-install.py <dir> --remove                    # undo

Everything Jace Browser adds to Firefox is loaded through autoconfig (see
src/jace/README.md), so copying the same files into a Firefox install gives
you the Zen look, the vertical tabs toggle, Jace account and sync, about:jace
and WebUSB (if you build usb-helper first).

It also rebrands that copy as Jace Browser: the name in menus, titles and
the about dialog, the logos, and (with Pillow installed) the window icons.
The originals are backed up and --remove puts them back. --no-brand skips
it. The program file and process are still called "firefox"; only the real
build (scripts/build.py) renames those.
Use a throwaway profile, and start it with -purgecaches after installing:
    firefox --no-remote --profile ~/jace-test/profile -purgecaches
"""
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "jace"


def gre_dir(path: Path) -> Path:
    if path.suffix == ".app":
        return path / "Contents" / "Resources"
    return path


BRAND_FTL = {
    "-brand-shorter-name": "Jace",
    "-brand-short-name": "Jace Browser",
    "-brand-shortcut-name": "Jace Browser",
    "-brand-full-name": "Jace Browser",
    "-brand-product-name": "Jace Browser",
    "-vendor-short-name": "Jace",
    "trademarkInfo": "Jace Browser is built on Mozilla Firefox. Firefox is a trademark of the Mozilla Foundation.",
}
BRAND_PROPERTIES = {
    "brandShorterName": "Jace",
    "brandShortName": "Jace Browser",
    "brandFullName": "Jace Browser",
    "vendorShortName": "Jace",
}
WORDMARK = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="210" height="42" viewBox="0 0 210 42">'
    '<text x="0" y="31" font-family="system-ui, sans-serif" font-size="27" font-weight="700" '
    'fill="context-fill">Jace Browser</text></svg>\n'
)
BACKUP = ".firefox-original"


def logo_png(size):
    """The Jace logo as PNG bytes at size (w, h). Uses Pillow if it's
    installed, otherwise the nearest ready-made size in branding/png."""
    try:
        from PIL import Image
    except ImportError:
        made = sorted((int(p.stem.split("-")[1]), p) for p in (ROOT / "branding" / "png").glob("logo-*.png"))
        want = max(size)
        return next((p for n, p in made if n >= want), made[-1][1]).read_bytes()
    import io
    w, h = size
    side = min(w, h)
    logo = Image.open(ROOT / "branding" / "logo-1024.png").convert("RGBA").resize((side, side), Image.LANCZOS)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    img.paste(logo, ((w - side) // 2, (h - side) // 2))
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


def png_size(data):
    # PNG: width and height are big-endian at bytes 16..24
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def read_jar_entries(data: bytes):
    """Yields (name, bytes) from a zip, including Mozilla's "optimized" jars.

    Firefox's omni.ja puts the central directory at the start of the file
    (after a 4-byte header) instead of the end, which Python's zipfile and
    some unzip tools reject. Offsets in it are absolute, so read it directly.
    """
    import struct
    import zlib

    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise RuntimeError("not a zip file (no end-of-central-directory record)")
    _sig, _disk, _cd_disk, _n_disk, count, _cd_size, cd_offset, _clen = struct.unpack_from("<4s4H2LH", data, eocd)
    pos = cd_offset
    for _ in range(count):
        if data[pos : pos + 4] != b"PK\x01\x02":
            raise RuntimeError(f"bad central directory entry at {pos}")
        (method, csize, fnlen, extlen, comlen, local) = (
            struct.unpack_from("<H", data, pos + 10)[0],
            struct.unpack_from("<L", data, pos + 20)[0],
            *struct.unpack_from("<3H", data, pos + 28),
            struct.unpack_from("<L", data, pos + 42)[0],
        )
        name = data[pos + 46 : pos + 46 + fnlen].decode("utf-8")
        pos += 46 + fnlen + extlen + comlen
        if name.endswith("/"):
            continue
        if data[local : local + 4] != b"PK\x03\x04":
            raise RuntimeError(f"bad local header for {name}")
        lfn, lext = struct.unpack_from("<2H", data, local + 26)
        start = local + 30 + lfn + lext
        raw = data[start : start + csize]
        if method == 0:
            yield name, raw
        elif method == 8:
            yield name, zlib.decompress(raw, -15)
        else:
            raise RuntimeError(f"{name} uses zip compression method {method}, which this script can't read")


def extract_jar(jar: Path, dest: Path):
    try:
        with zipfile.ZipFile(jar) as z:
            z.extractall(dest)
            return
    except zipfile.BadZipFile:
        pass  # Mozilla's optimized jar layout: read it ourselves
    for name, content in read_jar_entries(jar.read_bytes()):
        out = (dest / name).resolve()
        if not str(out).startswith(str(dest.resolve())):
            raise RuntimeError(f"unsafe path in jar: {name}")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(content)


def rebrand_file(rel: str, path: Path, warn_icons):
    name = path.name
    if name == "brand.ftl":
        text = path.read_text(encoding="utf-8")
        for key, value in BRAND_FTL.items():
            text = re.sub(rf"^{re.escape(key)}\s*=.*$", f"{key} = {value}", text, flags=re.M)
        path.write_text(text, encoding="utf-8")
        return True
    if name == "brand.properties":
        text = path.read_text(encoding="utf-8")
        for key, value in BRAND_PROPERTIES.items():
            text = re.sub(rf"^{key}\s*=.*$", f"{key}={value}", text, flags=re.M)
        path.write_text(text, encoding="utf-8")
        return True
    if "/branding/" not in "/" + rel:
        return False
    if name.endswith(".svg") and "wordmark" in name:
        path.write_text(WORDMARK)
        return True
    if name.endswith(".svg") and ("logo" in name or name.startswith(("icon", "firefox"))):
        shutil.copy(ROOT / "branding" / "logo.svg", path)
        return True
    if name.endswith(".png"):
        data = logo_png(png_size(path.read_bytes()))
        path.write_bytes(data)
        return True
    return False


def rebrand(gre: Path):
    """Jace Browser name and logos in browser/omni.ja, and the window icons."""
    jar = gre / "browser" / "omni.ja"
    original = jar.with_name(jar.name + BACKUP)
    if not original.exists():
        shutil.copy(jar, original)
    warn_icons = []
    changed = 0
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        extract_jar(original, tmp)
        for f in sorted(p for p in tmp.rglob("*") if p.is_file()):
            changed += rebrand_file(f.relative_to(tmp).as_posix(), f, warn_icons)
        new = jar.with_name(jar.name + ".new")
        with zipfile.ZipFile(new, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(p for p in tmp.rglob("*") if p.is_file()):
                z.write(f, f.relative_to(tmp).as_posix())
        new.replace(jar)
    # Window and taskbar icons live outside omni.ja.
    icons = gre / "browser" / "chrome" / "icons" / "default"
    for png in sorted(icons.glob("default*.png")) if icons.exists() else []:
        backup = png.with_name(png.name + BACKUP)
        if not backup.exists():
            shutil.copy(png, backup)
        png.write_bytes(logo_png(png_size(backup.read_bytes())))
        changed += 1
    print(f"Rebranded as Jace Browser ({changed} files).")


def unbrand(gre: Path):
    for backup in gre.rglob("*" + BACKUP):
        shutil.move(backup, backup.with_name(backup.name[: -len(BACKUP)]))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    gre = gre_dir(Path(sys.argv[1]))
    if not (gre / "omni.ja").exists():
        sys.exit(f"{gre} doesn't look like a Firefox install (no omni.ja)")
    targets = [gre / "jace", gre / "jace.cfg", gre / "defaults" / "pref" / "autoconfig.js", gre / "browser" / "defaults" / "preferences" / "jace-prefs.js", gre / "distribution" / "policies.json"]
    if "--remove" in sys.argv:
        for t in targets:
            shutil.rmtree(t, ignore_errors=True) if t.is_dir() else t.unlink(missing_ok=True)
        unbrand(gre)
        print("Removed Jace Browser's files and put Firefox's branding back.")
        return
    shutil.rmtree(gre / "jace", ignore_errors=True)
    shutil.copytree(SRC, gre / "jace", ignore=shutil.ignore_patterns("autoconfig", "defaults", "policies", "README.md", "moz.build"))
    shutil.copy(SRC / "autoconfig" / "jace.cfg", gre / "jace.cfg")
    (gre / "defaults" / "pref").mkdir(parents=True, exist_ok=True)
    shutil.copy(SRC / "autoconfig" / "autoconfig.js", gre / "defaults" / "pref" / "autoconfig.js")
    (gre / "browser" / "defaults" / "preferences").mkdir(parents=True, exist_ok=True)
    shutil.copy(SRC / "defaults" / "jace-prefs.js", gre / "browser" / "defaults" / "preferences" / "jace-prefs.js")
    (gre / "distribution").mkdir(exist_ok=True)
    if (gre / "distribution" / "policies.json").exists():
        print("note: replacing this Firefox's existing distribution/policies.json")
    shutil.copy(SRC / "policies" / "policies.json", gre / "distribution" / "policies.json")
    exe = "jace-usb-helper.exe" if sys.platform == "win32" else "jace-usb-helper"
    helper = ROOT / "usb-helper" / "target" / "release" / exe
    if not helper.exists() and shutil.which("cargo"):
        subprocess.run(["cargo", "build", "--release"], cwd=ROOT / "usb-helper", check=False)
    if not helper.exists():
        print("note: Rust (cargo) isn't installed, so WebUSB can't reach devices in this copy. Everything else works.")
    if helper.exists():
        (gre / "jace" / "bin").mkdir(exist_ok=True)
        shutil.copy(helper, gre / "jace" / "bin" / exe)
    if "--no-brand" not in sys.argv:
        rebrand(gre)
    print(f"Installed into {gre}. Start it with -purgecaches the first time after installing.")


if __name__ == "__main__":
    main()
