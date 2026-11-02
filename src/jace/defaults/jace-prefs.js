/* Jace Browser default preferences. Installed to browser/defaults/preferences. */

// ---------- Look: Zen-style layout ----------
// Vertical tabs are on by default; turn them off with the tabs button in the
// toolbar, Ctrl+Alt+V (Cmd+Opt+V on macOS), or about:jace.
pref("sidebar.revamp", true);
pref("sidebar.verticalTabs", true);
pref("sidebar.visibility", "always-show");
pref("sidebar.main.tools", "history,bookmarks");
pref("browser.toolbars.bookmarks.visibility", "never");
pref("browser.tabs.inTitlebar", 1);
pref("browser.compactmode.show", true);
pref("svg.context-properties.content.enabled", true);
pref("jace.theme.compact", false);          // hide the sidebar until you hover the window edge
pref("jace.theme.floatingContent", true);   // rounded, inset web content with a shadow
pref("jace.theme.accent", "#3ddc84");       // Jace green

// ---------- Jace account & sync ----------
pref("jace.account.server", "https://jaceo.vercel.app");
pref("jace.account.clientId", "00000000-0000-0000-0000-000000000003");
pref("jace.account.redirectPort", 47613);
pref("jace.sync.enabled", true);
pref("jace.sync.intervalSeconds", 600);
pref("jace.sync.engine.bookmarks", true);
pref("jace.sync.engine.history", true);
pref("jace.sync.engine.passwords", true);
pref("jace.sync.engine.cookies", true);      // keeps you signed in to sites on every device
pref("jace.sync.engine.tabs", true);
pref("jace.sync.engine.prefs", true);
pref("jace.sync.engine.addons", true);
// Jace accounts replace Firefox accounts.
pref("identity.fxaccounts.enabled", false);

// ---------- WebUSB ----------
pref("jace.usb.enabled", true);

// ---------- DRM (Widevine) ----------
// Widevine is downloaded by Firefox's plugin manager from Google on first use
// (Windows, macOS, and Linux). These make sure it's on and visible.
pref("media.eme.enabled", true);
pref("media.gmp-provider.enabled", true);
pref("media.gmp-widevinecdm.visible", true);
pref("media.gmp-widevinecdm.enabled", true);
pref("media.gmp-manager.updateEnabled", true);
pref("browser.eme.ui.enabled", true);

// ---------- First run ----------
// Jace Browser shows its own setup (about:jace-setup) on first run instead
// of Firefox's welcome pages.
pref("browser.shell.checkDefaultBrowser", false);
pref("browser.aboutwelcome.enabled", false);
pref("browser.startup.homepage_override.mstone", "ignore");
pref("jace.setup.done", false);
pref("jace.startup.animation", true);

// ---------- Updates ----------
// Jace Browser updates itself from GitHub releases (JaceUpdates.sys.mjs).
pref("jace.update.check", true);
pref("jace.update.auto", true);

// Mozilla's tracking is switched off and locked in jace.cfg (see
// src/jace/README.md, "Privacy"), and by distribution/policies.json.
