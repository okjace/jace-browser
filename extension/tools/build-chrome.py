#!/usr/bin/env python3
"""Make the Chrome version of the Jace extension from the same code.

    python3 extension/tools/build-chrome.py [out-dir]   (default: dist/)

Writes <out-dir>/chrome-extension/ (load it in chrome://extensions with
"Load unpacked") and <out-dir>/jace-extension-chrome-<version>.zip (for the
Chrome Web Store, or to share). The code is the same as Firefox's; only the
manifest differs (lib/compat.js handles the rest).
"""
import json
import shutil
import sys
import zipfile
from pathlib import Path

EXT = Path(__file__).resolve().parents[1]
SKIP = {"tools", "README.md", "manifest.json", "web-ext-artifacts"}


def chrome_manifest(firefox: dict) -> dict:
    m = {k: v for k, v in firefox.items() if k != "browser_specific_settings"}
    # Chrome runs the background as a service worker (same file, an ES module).
    m["background"] = {"service_worker": "background.js", "type": "module"}
    perms = [p for p in m["permissions"] if p != "webRequestBlocking"]
    # Chrome adds the Jace website header with a rule instead of blocking webRequest.
    perms.append("declarativeNetRequestWithHostAccess")
    m["permissions"] = perms
    m["minimum_chrome_version"] = "121"
    m["description"] = m["description"].replace("in Firefox", "in Chrome")
    return m


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else EXT.parent / "dist"
    firefox = json.loads((EXT / "manifest.json").read_text())
    target = out / "chrome-extension"
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    for item in EXT.iterdir():
        if item.name in SKIP or item.name.startswith("."):
            continue
        if item.is_dir():
            shutil.copytree(item, target / item.name)
        else:
            shutil.copy(item, target / item.name)
    (target / "manifest.json").write_text(json.dumps(chrome_manifest(firefox), indent=2) + "\n")
    archive = out / f"jace-extension-chrome-{firefox['version']}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(target.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(target).as_posix())
    print(f"{target}\n{archive}")


if __name__ == "__main__":
    main()
