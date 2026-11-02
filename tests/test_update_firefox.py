"""Tests for scripts/update_firefox.py (python3 -m unittest discover tests)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "update_firefox.py"


def run(root: Path, latest: str, *args: str) -> dict:
    env = {**os.environ, "JACE_ROOT": str(root), "JACE_LATEST_FIREFOX": latest, "JACE_SKIP_SOURCE_CHECK": "1"}
    env.pop("GITHUB_OUTPUT", None)
    out = subprocess.run([sys.executable, str(SCRIPT), *args], env=env, capture_output=True, text=True, check=True).stdout
    return dict(line.split("=", 1) for line in out.strip().splitlines())


class UpdateFirefoxTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        (self.root / "jace.json").write_text(json.dumps({"name": "Jace Browser", "version": "1.0.3", "firefox": "144.0"}))
        (self.root / "CHANGELOG.md").write_text("# Changelog\n\n## 1.0.3\n- older\n")

    def tearDown(self):
        self.dir.cleanup()

    def test_new_firefox_bumps_version_and_changelog(self):
        out = run(self.root, "145.0.1")
        self.assertEqual(out, {"changed": "true", "version": "1.0.4", "firefox": "145.0.1"})
        config = json.loads((self.root / "jace.json").read_text())
        self.assertEqual((config["version"], config["firefox"], config["name"]), ("1.0.4", "145.0.1", "Jace Browser"))
        log = (self.root / "CHANGELOG.md").read_text()
        self.assertTrue(log.startswith("# Changelog\n\n## 1.0.4\n- **Firefox 145.0.1** (was 144.0)"))
        self.assertIn("## 1.0.3\n- older", log)

    def test_same_or_older_firefox_changes_nothing(self):
        before = (self.root / "jace.json").read_text()
        for latest in ("144.0", "143.0.4"):
            self.assertEqual(run(self.root, latest)["changed"], "false")
        self.assertEqual((self.root / "jace.json").read_text(), before)

    def test_dot_release_counts(self):
        self.assertEqual(run(self.root, "144.0.1")["changed"], "true")

    def test_check_only_changes_nothing(self):
        before = (self.root / "jace.json").read_text()
        self.assertEqual(run(self.root, "146.0", "--check")["changed"], "true")
        self.assertEqual((self.root / "jace.json").read_text(), before)

    def test_rejects_non_release_versions(self):
        env = {**os.environ, "JACE_ROOT": str(self.root), "JACE_LATEST_FIREFOX": "146.0b3", "JACE_SKIP_SOURCE_CHECK": "1"}
        result = subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
