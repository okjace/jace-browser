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
    '<svg xmlns="http://www.w3.org/2000/svg" width="172" height="42" viewBox="0 0 172 42">'
    '<text x="0" y="31" font-family="system-ui, sans-serif" font-size="28" font-weight="700" '
    'fill="context-fill">Jace Browser</text></svg>\n'
)
BACKUP = ".firefox-original"


def logo_png(size):
    """The Jace logo as PNG bytes at size (w, h), or None without Pillow."""
    try:
        from PIL import Image
    except ImportError:
        return None
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


def extract_jar(jar: Path, dest: Path):
    try:
        with zipfile.ZipFile(jar) as z:
            z.extractall(dest)
    except zipfile.BadZipFile:
        # Mozilla's "optimized" jars confuse some zip readers; unzip copes (with a warning).
        res = subprocess.run(["unzip", "-qo", str(jar), "-d", str(dest)], capture_output=True)
        if res.returncode not in (0, 1, 2):
            raise RuntimeError(f"couldn't unpack {jar}: {res.stderr.decode(errors='replace')}")


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
    if name in ("about-wordmark.svg", "firefox-wordmark.svg"):
        path.write_text(WORDMARK)
        return True
    if name in ("about-logo.svg", "firefox-logo.svg"):
        shutil.copy(ROOT / "branding" / "logo.svg", path)
        return True
    if name.endswith(".png"):
        data = logo_png(png_size(path.read_bytes()))
        if data is None:
            warn_icons.append(rel)
            return False
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
        data = logo_png(png_size(backup.read_bytes()))
        if data is None:
            warn_icons.append(png.name)
        else:
            png.write_bytes(data)
            changed += 1
    print(f"Rebranded as Jace Browser ({changed} files).")
    if warn_icons:
        print("note: install Pillow (python3 -m pip install --user pillow) to also replace the Firefox icons.")


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
