"""Tests for scripts/debrand.py (python3 -m unittest discover -s tests -p "test_*.py")."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import debrand  # noqa: E402


class DebrandTest(unittest.TestCase):
    def test_visible_text_changes(self):
        self.assertEqual(debrand.rewrite_text("Firefox Labs"), "Jace Browser Labs")
        self.assertEqual(debrand.rewrite_text("Report a problem to Mozilla"), "Report a problem to Jace")
        self.assertEqual(debrand.rewrite_text("Mozilla Firefox is updating"), "Jace Browser is updating")
        self.assertEqual(debrand.rewrite_text("Sign in to your Firefox account"), "Sign in to your Jace Browser account")
        self.assertEqual(debrand.rewrite_text("the Firefox browser"), "the Jace Browser")

    def test_legal_names_and_links_stay(self):
        self.assertEqual(debrand.rewrite_text("under the Mozilla Public License"), "under the Mozilla Public License")
        self.assertEqual(debrand.rewrite_text("a project of the Mozilla Foundation"), "a project of the Mozilla Foundation")
        self.assertEqual(debrand.rewrite_text("see https://www.mozilla.org/firefox/"), "see https://www.mozilla.org/firefox/")
        self.assertEqual(debrand.rewrite_text('<a data-l10n-name="Firefox">Firefox</a>'), '<a data-l10n-name="Firefox">Jace Browser</a>')

    def test_ftl_ids_terms_and_placeables_stay(self):
        src = (
            "# Firefox comment stays\n"
            "-brand-product-name = Firefox\n"
            "firefox-labs-title = Firefox Labs\n"
            "    .tooltiptext = Try { -brand-short-name } with Mozilla\n"
            "about-firefox = { $count ->\n"
            "    [one] One Firefox window\n"
            "   *[other] { $count } Firefox windows\n"
            "}\n"
        )
        out = debrand.rewrite_ftl(src)
        self.assertIn("# Firefox comment stays", out)
        self.assertIn("-brand-product-name = Firefox", out)
        self.assertIn("firefox-labs-title = Jace Browser Labs", out)
        self.assertIn(".tooltiptext = Try { -brand-short-name } with Jace", out)
        self.assertIn("about-firefox = { $count ->", out)
        self.assertIn("[one] One Jace Browser window", out)
        self.assertIn("*[other] { $count } Jace Browser windows", out)

    def test_properties_and_dtd(self):
        self.assertEqual(
            debrand.rewrite_properties("firefoxKey=Firefox is ready\n# Firefox comment"),
            "firefoxKey=Jace Browser is ready\n# Firefox comment",
        )
        self.assertEqual(
            debrand.rewrite_dtd('<!ENTITY firefox.label "Open in Firefox">'),
            '<!ENTITY firefox.label "Open in Jace Browser">',
        )

    def test_legal_files_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "aboutRights.ftl").write_text("rights = Firefox is free software\n")
            (root / "menu.ftl").write_text("menu = About Firefox\n")
            (root / "branding").mkdir()
            (root / "branding" / "brand.ftl").write_text("x = Firefox\n")
            self.assertEqual(debrand.rewrite_tree(root), 1)
            self.assertEqual((root / "aboutRights.ftl").read_text(), "rights = Firefox is free software\n")
            self.assertEqual((root / "menu.ftl").read_text(), "menu = About Jace Browser\n")
            self.assertEqual((root / "branding" / "brand.ftl").read_text(), "x = Firefox\n")


if __name__ == "__main__":
    unittest.main()
