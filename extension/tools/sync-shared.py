#!/usr/bin/env python3
"""Copy Jace Browser's shared sync code into the extension.

    python3 extension/tools/sync-shared.py           # update extension/lib/
    python3 extension/tools/sync-shared.py --check   # fail if they differ (CI)

The extension and Jace Browser must encrypt, merge and describe cookies the
same way to sync with each other, so they use the same files. Edit the
originals in src/jace/content/sync/, then run this.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FILES = {
    "src/jace/content/sync/JaceCrypto.sys.mjs": "extension/lib/crypto.js",
    "src/jace/content/sync/JaceMerge.sys.mjs": "extension/lib/merge.js",
    "src/jace/content/sync/JaceCookies.sys.mjs": "extension/lib/cookies.js",
}


def generated(src: str) -> str:
    header = f"// Generated from {src} by extension/tools/sync-shared.py. Edit the original.\n"
    return header + (ROOT / src).read_text(encoding="utf-8")


def main() -> None:
    check = "--check" in sys.argv
    stale = []
    for src, dest in FILES.items():
        want = generated(src)
        path = ROOT / dest
        if check:
            if not path.exists() or path.read_text(encoding="utf-8") != want:
                stale.append(dest)
        else:
            path.write_text(want, encoding="utf-8")
            print(f"{src} -> {dest}")
    if stale:
        sys.exit("Out of date (run python3 extension/tools/sync-shared.py): " + ", ".join(stale))


if __name__ == "__main__":
    main()
