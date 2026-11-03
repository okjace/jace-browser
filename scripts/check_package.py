#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Checks a packaged Jace Browser has everything Jace's own code needs to start.

    python3 scripts/check_package.py <install dir>   (the folder with omni.ja)

Prints what it finds and exits non-zero if something's missing.
"""
import importlib.util
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("dev_install", here / "dev-install.py")
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)


def prefs_in_jar(jar: Path):
    found = {}
    if not jar.exists():
        return found
    for name, data in dev.read_jar_entries(jar.read_bytes()):
        if name.startswith(("defaults/pref", "defaults/preferences")) and b"general.config" in data:
            found[name] = [l.strip() for l in data.decode("utf-8", "replace").splitlines() if "general.config" in l]
    return found


def main():
    gre = Path(sys.argv[1])
    problems = []
    for rel in ["jace.cfg", "jacebrowser/content/JaceLoader.sys.mjs", "distribution/policies.json", "defaults/pref/autoconfig.js"]:
        ok = (gre / rel).exists()
        print(f"{'ok ' if ok else 'MISSING'} {rel}")
        if not ok and rel != "defaults/pref/autoconfig.js":
            problems.append(rel)
    on_disk = list(gre.glob("defaults/pref/*.js")) + list(gre.glob("browser/defaults/preferences/*.js"))
    for p in on_disk:
        lines = [l.strip() for l in p.read_text(errors="replace").splitlines() if "general.config" in l]
        print(f"on disk {p.relative_to(gre)}: {lines or 'no general.config prefs'}")
    for jar in [gre / "omni.ja", gre / "browser" / "omni.ja"]:
        for name, lines in prefs_in_jar(jar).items():
            print(f"in {jar.relative_to(gre)}: {name}: {lines}")
    cfg = gre / "jace.cfg"
    if cfg.exists():
        first = cfg.read_text(errors="replace").splitlines()[0]
        print(f"jace.cfg first line: {first[:80]}")
    if problems:
        sys.exit(f"missing: {', '.join(problems)}")


if __name__ == "__main__":
    main()
