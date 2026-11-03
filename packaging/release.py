#!/usr/bin/env python3
"""Publish downloads to the GitHub release (and Jace Store), platform by platform.

    python3 packaging/release.py v1.0.1 file [file ...]

The first platform to pass creates the release (notes from CHANGELOG.md);
later ones add their files to it. Then, with JACE_STORE_TOKEN set, the
Jace Store entry is (re)published so it lists every download in the release.
Runs in GitHub Actions (needs `gh` with GH_TOKEN and GITHUB_REPOSITORY).
"""
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def gh(*args, check=True):
    res = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and res.returncode != 0:
        sys.exit(f"gh {args[0]} {args[1]} failed ({res.returncode}): {res.stderr.strip() or res.stdout.strip()}")
    return res


def notes(version: str) -> str:
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    m = re.search(rf"^## {re.escape(version)}\s*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    body = m.group(1).strip() if m else ""
    return body + "\n\n_Downloads for each platform are added here as their builds finish._\n"


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    tag, files = sys.argv[1], sys.argv[2:]
    repo = os.environ["GITHUB_REPOSITORY"]
    files = [f for f in files if Path(f).is_file()]
    if not files:
        sys.exit("nothing to publish")
    exists = gh("release", "view", tag, "-R", repo, check=False).returncode == 0
    if exists:
        print(f"{tag}: adding {', '.join(Path(f).name for f in files)}")
        gh("release", "upload", tag, "-R", repo, "--clobber", *files)
    else:
        version = tag.lstrip("v")
        note_file = ROOT / ".release-notes.md"
        note_file.write_text(notes(version), encoding="utf-8")
        print(f"{tag}: creating the release with {', '.join(Path(f).name for f in files)}")
        gh("release", "create", tag, "-R", repo, "--title", f"Jace Browser {tag}", "--notes-file", str(note_file),
           "--target", os.environ.get("GITHUB_SHA", "main"), *files)
    if os.environ.get("JACE_STORE_TOKEN"):
        # Re-publish so the store lists every download now in the release.
        subprocess.run([sys.executable, str(ROOT / "packaging" / "publish_store.py"), tag, "--replace"], check=True)
    else:
        print("::warning::JACE_STORE_TOKEN secret not set - skipping Jace Store")


if __name__ == "__main__":
    main()
