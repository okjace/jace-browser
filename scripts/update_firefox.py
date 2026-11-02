#!/usr/bin/env python3
"""Move Jace Browser to Mozilla's newest Firefox release, if there's a new one.

    python3 scripts/update_firefox.py            # update jace.json + CHANGELOG.md if needed
    python3 scripts/update_firefox.py --check    # only say whether there's a newer Firefox

Run every day by .github/workflows/firefox-update.yml. When Mozilla ships
a Firefox release, this:
  1. checks the release's source is published (its SHA512SUMS lists the source tarball)
  2. sets "firefox" in jace.json to it and raises Jace Browser's version
     (patch number, e.g. 1.0.3 -> 1.0.4)
  3. adds a CHANGELOG.md section for the new version
The workflow then commits that and starts the build, which releases it if
every platform builds and passes its installer tests - and every installed
Jace Browser picks the release up and updates itself.

Prints KEY=value lines (changed, version, firefox) and appends them to
$GITHUB_OUTPUT when running in GitHub Actions.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("JACE_ROOT", Path(__file__).resolve().parent.parent))
VERSIONS_URL = "https://product-details.mozilla.org/1.0/firefox_versions.json"


def parse(v: str) -> tuple:
    """'144.0.2' -> (144, 0, 2). Betas and ESR suffixes aren't releases we follow."""
    if not re.fullmatch(r"\d+(\.\d+){1,2}", v):
        raise ValueError(f"not a Firefox release version: {v}")
    parts = [int(x) for x in v.split(".")]
    return tuple(parts + [0] * (3 - len(parts)))


def latest_firefox() -> str:
    override = os.environ.get("JACE_LATEST_FIREFOX")  # for tests
    if override:
        return override
    with urllib.request.urlopen(VERSIONS_URL, timeout=30) as r:
        return json.load(r)["LATEST_FIREFOX_VERSION"]


def source_published(version: str) -> bool:
    if os.environ.get("JACE_SKIP_SOURCE_CHECK"):  # for tests
        return True
    url = f"https://archive.mozilla.org/pub/firefox/releases/{version}/SHA512SUMS"
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return f"source/firefox-{version}.source.tar.xz" in r.read().decode()
    except urllib.error.HTTPError:
        return False


def bump_patch(version: str) -> str:
    major, minor, patch = parse(version)
    return f"{major}.{minor}.{patch + 1}"


def add_changelog(path: Path, version: str, firefox: str, previous: str) -> None:
    text = path.read_text(encoding="utf-8")
    entry = (
        f"## {version}\n"
        f"- **Firefox {firefox}** (was {previous}): Mozilla's latest security fixes and improvements. "
        f"Release notes: https://www.mozilla.org/firefox/{firefox}/releasenotes/\n"
        f"- Updated automatically: installed copies of Jace Browser download and install this version on their own.\n\n"
    )
    marker = "# Changelog\n"
    if marker in text:
        head, rest = text.split(marker, 1)
        text = head + marker + "\n" + entry + rest.lstrip("\n")
    else:
        text = entry + text
    path.write_text(text, encoding="utf-8")


def output(**values) -> None:
    lines = [f"{k}={v}" for k, v in values.items()]
    print("\n".join(lines))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write("\n".join(lines) + "\n")


def main() -> None:
    config_path = ROOT / "jace.json"
    config = json.loads(config_path.read_text())
    current = config["firefox"]
    latest = latest_firefox()
    if parse(latest) <= parse(current):
        print(f"Jace Browser already uses Firefox {current} (latest is {latest}).", file=sys.stderr)
        output(changed="false", version=config["version"], firefox=current)
        return
    if not source_published(latest):
        print(f"Firefox {latest} is out but its source isn't published yet; trying again next time.", file=sys.stderr)
        output(changed="false", version=config["version"], firefox=current)
        return
    if "--check" in sys.argv:
        print(f"Firefox {latest} is newer than {current}.", file=sys.stderr)
        output(changed="true", version=config["version"], firefox=latest)
        return
    new_version = bump_patch(config["version"])
    config["firefox"] = latest
    config["version"] = new_version
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    add_changelog(ROOT / "CHANGELOG.md", new_version, latest, current)
    print(f"Jace Browser {new_version}: Firefox {current} -> {latest}", file=sys.stderr)
    output(changed="true", version=new_version, firefox=latest)


if __name__ == "__main__":
    main()
