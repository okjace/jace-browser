"""Rewrite the browser's leftover "Firefox" / "Mozilla" text as Jace Browser.

Used by scripts/build.py (on Firefox's source, before building) and
scripts/dev-install.py (on a Firefox install's omni.ja). Most of the UI
already names the browser through the brand strings (-brand-short-name, ...),
which branding sets to Jace Browser; this catches the text that names Firefox
or Mozilla directly ("Firefox Labs", "Report a problem to Mozilla", ...).

Only visible text changes:
- Fluent (.ftl): message values and attributes; not ids, not { placeables },
  not web addresses
- .properties / .dtd / .ini: values; not keys, not web addresses
Kept as they are, because they're legal notices or names of legal entities:
- the files about rights and licenses
- "Mozilla Public License", "Mozilla Foundation", "Mozilla Corporation",
  trademark notices
"""
import re
from pathlib import Path

# Files that are legal notices: never changed.
LEGAL_FILES = re.compile(r"(rights|license|licence|credits|trademark)", re.I)

# Phrases that stay as they are (legal names). Protected before replacing.
KEEP = [
    "Mozilla Public License",
    "Mozilla Foundation",
    "Mozilla Corporation",
    "Mozilla and Firefox are trademarks",
    "Firefox and the Firefox logos are trademarks",
    "trademarks of the Mozilla Foundation",
]

REPLACEMENTS = [
    (re.compile(r"\bMozilla Firefox\b"), "Jace Browser"),
    (re.compile(r"\bFirefox Browser\b"), "Jace Browser"),
    (re.compile(r"\bFirefox Account(s?)\b"), r"Jace Account\1"),
    (re.compile(r"\bMozilla account(s?)\b"), r"Jace account\1"),
    (re.compile(r"\bFirefox\b"), "Jace Browser"),
    (re.compile(r"\bMozilla\b"), "Jace"),
]

# Bits of a value that must never change: { placeables }, web addresses,
# email addresses, and anything in <angle brackets> (markup / attributes).
PROTECT = re.compile(r"\{[^{}]*\}|https?://\S+|[\w.+-]+@[\w-]+\.[\w.]+|<[^<>]*>")


def rewrite_text(text: str) -> str:
    """Rewrites one visible string."""
    saved = []

    def stash(m):
        saved.append(m.group(0))
        return f"\x00{len(saved) - 1}\x00"

    for phrase in KEEP:
        if phrase in text:
            saved.append(phrase)
            text = text.replace(phrase, f"\x00{len(saved) - 1}\x00")
    text = PROTECT.sub(stash, text)
    for pattern, repl in REPLACEMENTS:
        text = pattern.sub(repl, text)
    # "Jace Browser Browser" can appear when the original said "Firefox browser".
    text = re.sub(r"\bJace Browser [Bb]rowser\b", "Jace Browser", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: saved[int(m.group(1))], text)


FTL_VALUE = re.compile(r"^(\s*(?:[A-Za-z][\w-]*|\.[\w-]+)\s*=\s?)(.*)$")


def rewrite_ftl(source: str) -> str:
    out = []
    for line in source.split("\n"):
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#") or stripped.startswith("-"):
            # comments, blank lines, and term definitions (-brand-...) stay
            out.append(line)
            continue
        m = FTL_VALUE.match(line)
        if m:
            out.append(m.group(1) + rewrite_text(m.group(2)))
        elif line.startswith((" ", "\t")):
            # continuation of a multi-line value (or a variant: "[one] ...")
            out.append(rewrite_text(line))
        else:
            out.append(line)
    return "\n".join(out)


def rewrite_properties(source: str) -> str:
    out = []
    for line in source.split("\n"):
        if line.lstrip().startswith(("#", "!")) or "=" not in line:
            out.append(line)
            continue
        key, value = line.split("=", 1)
        out.append(f"{key}={rewrite_text(value)}")
    return "\n".join(out)


DTD_ENTITY = re.compile(r'(<!ENTITY\s+[\w.-]+\s+")([^"]*)(")')


def rewrite_dtd(source: str) -> str:
    return DTD_ENTITY.sub(lambda m: m.group(1) + rewrite_text(m.group(2)) + m.group(3), source)


def rewrite_file(path: Path) -> bool:
    """Rewrites one localization file in place. Returns True if it changed."""
    if LEGAL_FILES.search(path.name):
        return False
    rewriters = {".ftl": rewrite_ftl, ".properties": rewrite_properties, ".dtd": rewrite_dtd}
    rewriter = rewriters.get(path.suffix)
    if not rewriter:
        return False
    try:
        before = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return False
    after = rewriter(before)
    if after != before:
        path.write_text(after, encoding="utf-8")
        return True
    return False


def rewrite_tree(root: Path, skip_dirs=("branding",)) -> int:
    """Rewrites every localization file under root. Returns how many changed."""
    changed = 0
    for path in root.rglob("*"):
        if path.is_file() and not any(part in skip_dirs for part in path.relative_to(root).parts[:-1]):
            changed += rewrite_file(path)
    return changed
