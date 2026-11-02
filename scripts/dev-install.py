#!/usr/bin/env python3
"""Try Jace Browser's features in a regular Firefox, without a full build.

    python3 scripts/dev-install.py "/Applications/Firefox.app"      # macOS
    python3 scripts/dev-install.py "C:\\Program Files\\Mozilla Firefox"  # Windows
    python3 scripts/dev-install.py /usr/lib/firefox                  # Linux (a Firefox you can write to)
    python3 scripts/dev-install.py <dir> --remove                    # undo

Everything Jace Browser adds to Firefox is loaded through autoconfig (see
src/jace/README.md), so copying the same files into a Firefox install gives
you the Zen look, the vertical tabs toggle, Jace account and sync, about:jace
and WebUSB (if you build usb-helper first). Branding stays Firefox's.
Use a throwaway profile: firefox -no-remote -P jace-dev
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "jace"


def gre_dir(path: Path) -> Path:
    if path.suffix == ".app":
        return path / "Contents" / "Resources"
    return path


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
        print("Removed Jace Browser's files.")
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
    print(f"Installed into {gre}. Start Firefox with a fresh profile and open about:jace.")


if __name__ == "__main__":
    main()
