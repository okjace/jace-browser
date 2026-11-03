/* Jace Browser default preferences. Installed to browser/defaults/preferences. */

// ---------- Startup ----------
// Run jace.cfg (next to the browser) at startup: it loads all of Jace
// Browser's own features (see src/jace/README.md). These used to be in
// defaults/pref/autoconfig.js; default prefs here are read just as early.
pref("general.config.filename", "jace.cfg");
pref("general.config.obscure_value", 0);
pref("general.config.sandbox_enabled", false);

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
// Menus drawn by the browser (in Jace's colors), not by the system (GTK gray).
pref("widget.gtk.native-context-menus", false);
pref("browser.display.use_system_colors", false);
pref("jace.theme.compact", false);          // hide the sidebar until you hover the window edge
pref("jace.theme.floatingContent", true);   // rounded, inset web content with a shadow
pref("jace.theme.accent", "#3ddc84");       // Jace green
pref("jace.theme.id", "jace");              // JaceThemes.sys.mjs: "jace" follows the system's light/dark
pref("jace.theme.custom", "{}");            // colors for the "custom" theme
pref("jace.newtab.popup", true);            // Ctrl+T / + opens a small search box over the page
pref("jace.tabs.verticalStyle", "full");    // "full", "icons" (icons only), or "hover" (icons, expand on hover)
pref("jace.windowControls.style", "system"); // "system" (GNOME look on Linux, the real buttons on Windows and macOS), "jace" (colored dots), or "minimal"

// ---------- No Firefox-branded features ----------
// Jace Browser has its own account, sync, profiles and settings; these
// Firefox/Mozilla features and promotions are turned off or hidden.
pref("browser.tabs.firefox-view", false);              // Firefox View
pref("browser.firefox-view.feature-tour", "{\"screen\":\"\",\"complete\":true}");
pref("signon.firefoxRelay.feature", "disabled");       // Firefox Relay
pref("browser.preferences.moreFromMozilla", false);    // "More from Mozilla"
pref("browser.preferences.experimental.hidden", true); // Firefox Labs
pref("browser.urlbar.quicksuggest.enabled", false);    // Firefox Suggest
pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);
pref("browser.privatebrowsing.vpnpromourl", "");       // Mozilla VPN promo
pref("browser.promo.focus.enabled", false);            // Firefox Focus promo
pref("browser.promo.pin.enabled", false);
pref("browser.profiles.enabled", false);               // Firefox's profiles UI (Jace has its own)
pref("browser.messaging-system.whatsNewPanel.enabled", false);
pref("browser.uitour.enabled", false);
pref("browser.newtabpage.activity-stream.showWeather", false);
pref("browser.newtabpage.activity-stream.feeds.section.highlights", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false);

// ---------- Help and feedback go to Jace Browser, not Mozilla ----------
// (Firefox opens <support.baseURL><topic>; the topic lands as an anchor on the README.)
pref("app.support.baseURL", "https://github.com/okjace/jace-browser#");
pref("app.feedback.baseURL", "https://github.com/okjace/jace-browser/issues/new?title=");
pref("app.releaseNotesURL", "https://github.com/okjace/jace-browser/releases");
pref("app.releaseNotesURL.aboutDialog", "https://github.com/okjace/jace-browser/releases");
pref("app.releaseNotesURL.prompt", "https://github.com/okjace/jace-browser/releases");
pref("browser.contentblocking.report.manage_devices.url", "");
pref("browser.contentblocking.report.lockwise.mobile-android.url", "");
pref("browser.contentblocking.report.lockwise.mobile-ios.url", "");

// ---------- New tab ----------
// Jace's own new tab and home page (newtab/newtab.html) instead of Firefox's.
pref("jace.newtab.enabled", true);
// Default shortcuts (instead of Firefox's, like "Add-ons for Firefox").
pref("browser.newtabpage.activity-stream.default.sites", "https://jaceo.vercel.app/,https://www.youtube.com/,https://www.wikipedia.org/,https://www.reddit.com/,https://github.com/");
pref("browser.newtabpage.activity-stream.improvesearch.topSiteSearchShortcuts", false);
// Newer Firefox downloads its default shortcuts from Mozilla; use ours instead.
pref("browser.topsites.useRemoteSetting", false);

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
// No Mozilla terms-of-use / privacy-notice screens: Jace Browser has its own setup.
pref("browser.preonboarding.enabled", false);
pref("termsofuse.bypassNotification", true);
pref("termsofuse.acceptedVersion", 999);
pref("termsofuse.acceptedDate", "1735689600000");
pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
pref("datareporting.policy.firstRunURL", "");
pref("browser.rights.3.shown", true);
pref("jace.startup.animation", true);

// ---------- Updates ----------
// Jace Browser updates itself from GitHub releases (JaceUpdates.sys.mjs).
pref("jace.update.check", true);
pref("jace.update.auto", true);

// Mozilla's tracking is switched off and locked in jace.cfg (see
// src/jace/README.md, "Privacy"), and by distribution/policies.json.

// ---------- Jace websites ----------
// Keep the Jace website signed in, and sign in to Jace's own apps without the consent screen.
pref("jace.account.autoSignIn", true);

// ---- Smooth, fast, clean ----
// Smooth scrolling that glides and settles naturally (mouse wheel and keys).
pref("general.smoothScroll", true);
pref("general.smoothScroll.msdPhysics.enabled", true);
pref("general.smoothScroll.msdPhysics.continuousMotionMaxDeltaMS", 12);
pref("general.smoothScroll.msdPhysics.motionBeginSpringConstant", 600);
pref("general.smoothScroll.msdPhysics.regularSpringConstant", 650);
pref("general.smoothScroll.msdPhysics.slowdownMinDeltaMS", 25);
pref("general.smoothScroll.msdPhysics.slowdownSpringConstant", 250);
pref("general.smoothScroll.currentVelocityWeighting", "1");
pref("general.smoothScroll.stopDecelerationWeighting", "1");
pref("mousewheel.default.delta_multiplier_y", 100);
pref("apz.overscroll.enabled", true);           // a soft bounce at the ends of pages
pref("widget.gtk.overlay-scrollbars.enabled", true);
pref("widget.non-native-theme.scrollbar.style", 1);

// Pages appear sooner, tabs switch faster.
pref("nglayout.initialpaint.delay", 0);
pref("nglayout.initialpaint.delay_in_oopif", 0);
pref("content.notify.interval", 100000);
pref("browser.tabs.animate", true);
pref("browser.tabs.warmup.max", 8);
pref("browser.tabs.min_inactive_duration_before_unload", 1800000);  // only unload tabs idle 30+ min when memory runs low
pref("gfx.webrender.all", true);
pref("gfx.canvas.accelerated", true);
pref("layers.gpu-process.enabled", true);
pref("media.hardware-video-decoding.enabled", true);
pref("image.mem.decode_bytes_at_a_time", 32768);

// Faster loading: look up and connect to links you're likely to open.
pref("network.dns.disablePrefetch", false);
pref("network.dns.disablePrefetchFromHTTPS", false);
pref("network.prefetch-next", true);
pref("network.predictor.enabled", true);
pref("network.http.speculative-parallel-limit", 10);
pref("browser.urlbar.speculativeConnect.enabled", true);
pref("browser.places.speculativeConnect.enabled", true);
pref("network.http.max-persistent-connections-per-server", 10);
pref("network.http.pacing.requests.enabled", false);
pref("browser.cache.memory.capacity", 262144);  // 256 MB memory cache for back/forward and images
pref("browser.sessionhistory.max_total_viewers", 6);
pref("browser.sessionstore.interval", 60000);   // save the session every minute, not every 15 s (less disk work)

// Clean: no clutter.
pref("browser.tabs.tabmanager.enabled", false);
pref("browser.urlbar.trimHttps", true);
pref("browser.urlbar.suggest.trending", false);
pref("browser.urlbar.suggest.weather", false);
pref("browser.urlbar.suggest.yelp", false);
pref("browser.urlbar.suggest.mdn", false);
pref("browser.urlbar.suggest.addons", false);
pref("browser.urlbar.suggest.fakespot", false);
pref("browser.urlbar.suggest.pocket", false);
pref("browser.urlbar.showSearchTerms.enabled", true);
pref("browser.download.autohideButton", true);
pref("browser.aboutConfig.showWarning", false);
pref("full-screen-api.transition-duration.enter", "0 0");
pref("full-screen-api.transition-duration.leave", "0 0");
pref("full-screen-api.warning.timeout", 0);
