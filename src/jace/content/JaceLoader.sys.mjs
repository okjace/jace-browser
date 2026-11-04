/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Starts Jace Browser's features. jace.cfg (autoconfig) calls init() once,
 * early in startup, in the parent process:
 *
 * - registers about:jace (Jace settings) and about:jace-setup (first-run setup)
 * - adds the toolbar widgets (Jace account, vertical tabs on/off)
 * - sets up every browser window (JaceWindow: Zen-style look, shortcuts)
 * - registers the WebUSB window actor (navigator.usb in web pages)
 * - starts Jace sync once the first window is up
 */

import { getCustomizableUI, jacePageURL } from "chrome://jace/content/JaceCompat.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JaceAddonOffer: "chrome://jace/content/sync/JaceAddonOffer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  JaceDownloadsButton: "chrome://jace/content/JaceDownloadsButton.sys.mjs",
  JaceAccount: "chrome://jace/content/JaceAccount.sys.mjs",
  JaceSelfTest: "chrome://jace/content/JaceSelfTest.sys.mjs",
  JaceSync: "chrome://jace/content/sync/JaceSync.sys.mjs",
  JaceWindow: "chrome://jace/content/JaceWindow.sys.mjs",
  JaceContentStyle: "chrome://jace/content/JaceContentStyle.sys.mjs",
  JaceSettingsPane: "chrome://jace/content/JaceSettingsPane.sys.mjs",
  JaceNewTab: "chrome://jace/content/JaceNewTab.sys.mjs",
  JaceAccountPanel: "chrome://jace/content/JaceAccountPanel.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "CustomizableUI", () => getCustomizableUI());

const ABOUT_JACE_URL = "chrome://jace/content/settings/settings.html";
const ABOUT_PAGES = {
  jace: { url: ABOUT_JACE_URL, cid: "{6c3f5d9e-2b1a-4b8e-9a51-6a0f2f3b7c11}" },
  "jace-setup": { url: "chrome://jace/content/setup/setup.html", cid: "{0f6a2c1e-8d3b-4f4a-b7e2-5c9d1a3e6b20}" },
  "jace-debug": { url: "chrome://jace/content/debug/debug.html", cid: "{3d8e1f42-7c5a-4e19-b0d6-2a9f8c4e5b71}" },
};

let initialized = false;
/** Errors from startup, before the console is listening; the self-test prints them. */
export const initErrors = [];
let syncStarted = false;
let setupChecked = false;

function registerAboutPages() {
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  for (const [what, { url, cid }] of Object.entries(ABOUT_PAGES)) {
    const chromeURI = Services.io.newURI(url);
    const aboutModule = {
      QueryInterface: ChromeUtils.generateQI(["nsIAboutModule"]),
      newChannel(uri, loadInfo) {
        const channel = Services.io.newChannelFromURIWithLoadInfo(chromeURI, loadInfo);
        channel.originalURI = uri;
        return channel;
      },
      getURIFlags() {
        return Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI;
      },
      getChromeURI() {
        return chromeURI;
      },
    };
    const factory = {
      QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
      createInstance(iid) {
        return aboutModule.QueryInterface(iid);
      },
    };
    registrar.registerFactory(Components.ID(cid), `about:${what}`, `@mozilla.org/network/protocol/about;1?what=${what}`, factory);
  }
}

/** First run: show Jace Browser's setup in the first window. */
/** Lines for jace-startup.log in the profile (scripts/try.sh prints it). */
const startupLog = [];
/** For about:jace-debug. */
export function getStartupLog() {
  return [...startupLog, ...initErrors.map((e) => `ERROR ${e}`)];
}
let logTimer = null;
export function logStartup(line) {
  startupLog.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
  // Saved a moment later (scripts/try.sh prints it).
  if (!logTimer) {
    logTimer = lazy.setTimeout(() => {
      logTimer = null;
      writeStartupLog();
    }, 500);
  }
}

async function writeStartupLog() {
  try {
    const lines = [...startupLog, ...initErrors.map((e) => `ERROR ${e}`)];
    await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "jace-startup.log"), lines.join("\n") + "\n");
  } catch {}
}

function setupTabIn(gBrowser) {
  return [...gBrowser.tabs].find((t) => /jace-setup|setup\/setup\.html/.test(t.linkedBrowser.currentURI?.spec ?? ""));
}

/** First run: show Jace Browser's setup in its own tab, and check it stayed. */
function maybeOpenSetup(win) {
  if (setupChecked) return;
  setupChecked = true;
  if (Services.prefs.getBoolPref("jace.setup.done", false)) {
    logStartup("setup already done");
    return;
  }
  const url = jacePageURL("jace-setup");
  const open = (attempt) => {
    try {
      const gBrowser = win.gBrowser;
      const existing = setupTabIn(gBrowser);
      if (existing) {
        gBrowser.selectedTab = existing;
        logStartup(`setup showing (attempt ${attempt})`);
        return;
      }
      const tab = gBrowser.addTrustedTab(url, { inBackground: false });
      gBrowser.selectedTab = tab;
      logStartup(`setup opened at ${url} (attempt ${attempt})`);
      // The window's first page (new tab / home) isn't needed under it.
      for (const t of [...gBrowser.tabs]) {
        const spec = t.linkedBrowser.currentURI?.spec ?? "";
        if (t !== tab && (/^about:(home|newtab|blank)?$/.test(spec) || spec.startsWith("chrome://jace/content/newtab/"))) {
          gBrowser.removeTab(t);
        }
      }
    } catch (e) {
      initErrors.push(`couldn't open setup (attempt ${attempt}): ${e}`);
    }
    writeStartupLog();
  };
  win.setTimeout(() => open(1), 800);
  // Something (session restore, the home page) can still replace it: check again.
  win.setTimeout(() => {
    if (!setupTabIn(win.gBrowser)) open(2);
    else logStartup("setup still showing after 4s");
    writeStartupLog();
  }, 4000);
}

/**
 * Websites must see a normal Firefox. Jace Browser's own build is named
 * "jace", which could put "jace/159.0" in the user agent; if so, use exactly
 * Firefox's ("... Firefox/159.0"), set as a default pref each start so it
 * follows the version.
 */
function keepFirefoxUserAgent() {
  const http = Cc["@mozilla.org/network/protocol;1?name=http"].getService(Ci.nsIHttpProtocolHandler);
  const ua = http.userAgent;
  const version = Services.appinfo.version.split(".").slice(0, 2).join(".");
  if (/\bFirefox\/\d/.test(ua)) return;
  const firefoxUA = /\S+\/[\d.]+$/.test(ua) ? ua.replace(/\S+\/[\d.]+$/, `Firefox/${version}`) : `${ua} Firefox/${version}`;
  Services.prefs.getDefaultBranch("").setStringPref("general.useragent.override", firefoxUA);
}

/**
 * Firefox's new tab component (activity stream) writes its own default
 * prefs once it loads, which drops the locks jace.cfg put on its sponsored
 * and telemetry prefs. Put them back, and again whenever they change.
 */
const NEWTAB_LOCKED = [
  "browser.newtabpage.activity-stream.showSponsored",
  "browser.newtabpage.activity-stream.showSponsoredTopSites",
  "browser.newtabpage.activity-stream.feeds.telemetry",
  "browser.newtabpage.activity-stream.telemetry",
  "browser.newtabpage.activity-stream.feeds.section.topstories",
];
let relocking = false;
function relockNewTabPrefs() {
  if (relocking) return;
  relocking = true;
  try {
    for (const name of NEWTAB_LOCKED) {
      if (Services.prefs.prefIsLocked(name) && !Services.prefs.getBoolPref(name, false)) continue;
      if (Services.prefs.prefIsLocked(name)) Services.prefs.unlockPref(name);
      Services.prefs.getDefaultBranch("").setBoolPref(name, false);
      Services.prefs.clearUserPref(name);
      Services.prefs.lockPref(name);
    }
  } catch (e) {
    initErrors.push(`couldn't relock new tab prefs: ${e}`);
  } finally {
    relocking = false;
  }
}

function registerWebUSB() {
  ChromeUtils.registerWindowActor("JaceUSB", {
    parent: { esModuleURI: "chrome://jace/content/usb/JaceUSBParent.sys.mjs" },
    child: {
      // resource://jace/ (not chrome://) because content processes can load it.
      esModuleURI: "resource://jace/content/usb/JaceUSBChild.sys.mjs",
      events: { DOMDocElementInserted: { capture: true } },
    },
    allFrames: true,
    // WebUSB is only for secure contexts; the child re-checks isSecureContext.
    matches: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  });
}

/** Search engines Jace doesn't list (AI answer engines bundled as Mozilla partners). */
const HIDDEN_ENGINES = ["Perplexity"];
async function hideSearchEngines() {
  const { getSearchService } = ChromeUtils.importESModule("chrome://jace/content/JaceCompat.sys.mjs");
  const search = getSearchService();
  await search.init();
  for (const name of HIDDEN_ENGINES) {
    const engine = search.getEngineByName(name);
    if (engine && !engine.hidden) engine.hidden = true;
  }
}

function createWidgets() {
  const { CustomizableUI } = lazy;

  CustomizableUI.createWidget({
    id: "jace-account-button",
    type: "view",
    viewId: "PanelUI-jace-account",
    label: "Jace account",
    tooltiptext: "Jace account and profiles",
    defaultArea: CustomizableUI.AREA_NAVBAR,
    removable: true,
    onCreated(node) {
      lazy.JaceAccountPanel.install(node.ownerGlobal);
      lazy.JaceWindow.updateAccountButton(node);
    },
    onBeforeCreated(doc) {
      lazy.JaceAccountPanel.install(doc.defaultView);
    },
    onViewShowing(event) {
      const filling = lazy.JaceAccountPanel.fillAccountView(event.target);
      // Show the panel once it's filled, so it doesn't jump.
      event.detail?.addBlocker?.(filling.catch((e) => console.error("Jace: account panel", e)));
    },
  });

  // The profiles button was removed (profiles live in Settings -> Jace);
  // take it off toolbars it was put on before.
  // Firefox's AI / smart-window buttons (its AI features are off): off the toolbars.
  for (const id of ["ai-window-toggle", "smartwindow-group-tabs-button", "ipprotection-button", "firefox-view-button"]) {
    try {
      if (CustomizableUI.getPlacementOfWidget(id)) CustomizableUI.removeWidgetFromArea(id);
    } catch {}
  }
  if (CustomizableUI.getPlacementOfWidget("jace-profiles-button")) {
    CustomizableUI.removeWidgetFromArea("jace-profiles-button");
  }

  // Downloads at the end of the tab strip (tabs across the top); with
  // vertical tabs it's in the sidebar instead (JaceDownloadsButton.place).
  CustomizableUI.createWidget({
    id: "jace-tabs-downloads",
    type: "button",
    label: "Downloads",
    tooltiptext: "Downloads",
    removable: true,
    onCreated(node) {
      lazy.JaceDownloadsButton.widgetCreated(node);
    },
    onCommand(event) {
      lazy.JaceDownloadsButton.widgetCommand(event);
    },
  });

  CustomizableUI.createWidget({
    id: "jace-vertical-tabs-button",
    type: "button",
    label: "Vertical tabs",
    tooltiptext: "Turn vertical tabs on or off (Ctrl+Alt+V)",
    defaultArea: CustomizableUI.AREA_NAVBAR,
    removable: true,
    onCreated(node) {
      lazy.JaceWindow.updateVerticalTabsButton(node);
    },
    onCommand() {
      lazy.JaceWindow.toggleVerticalTabs();
    },
  });
}

function onBrowserWindow(win) {
  logStartup(`window ready (${win.gBrowser?.selectedBrowser?.currentURI?.spec ?? "?"})`);
  try {
    lazy.JaceWindow.init(win);
  } catch (e) {
    console.error("Jace: window setup failed", e);
  }
  if (lazy.JaceSelfTest.requested) {
    lazy.JaceSelfTest.run(win);
    return;
  }
  try {
    maybeOpenSetup(win);
  } catch (e) {
    initErrors.push(`couldn't open setup: ${e}`);
    console.error("Jace: couldn't open setup", e);
  }
  if (!syncStarted) {
    syncStarted = true;
    lazy.JaceAccount.startWebsiteSignIn().catch((e) => console.warn("Jace: website sign-in", e));
    // Give startup a moment before the first sync.
    lazy.JaceSync.start({ firstSyncDelayMs: 15_000 });
    // Ask to install add-ons your other devices have.
    lazy.JaceAddonOffer.start();
  }
}

export const JaceLoader = {
  ABOUT_JACE_URL,

  init() {
    if (initialized) {
      return;
    }
    initialized = true;
    logStartup(`Jace started (Firefox ${Services.appinfo.version})`);
    // CI self-test: say straight away that Jace's code is running (if the
    // report stops here, the browser window never finished opening).
    const selfTestOut = Services.env.get("JACE_SELF_TEST_OUT");
    if (selfTestOut) {
      IOUtils.writeUTF8(selfTestOut, "Jace's code started; waiting for the browser window…\n").catch(() => {});
    }

    for (const [what, fn] of [
      ["about:jace pages", registerAboutPages],
      ["WebUSB", registerWebUSB],
      ["the Jace look for built-in pages", () => lazy.JaceContentStyle.start()],
      ["the Jace section in settings", () => lazy.JaceSettingsPane.start()],
    ]) {
      try {
        fn();
      } catch (e) {
        initErrors.push(`couldn't register ${what}: ${e}\n${e?.stack ?? ""}`);
        console.error(`Jace: couldn't register ${what}`, e);
      }
    }

    // Widgets need CustomizableUI, which needs the profile; windows come later.
    Services.obs.addObserver(function onWindow(subject) {
      onBrowserWindow(subject);
    }, "browser-delayed-startup-finished");
    // Earlier, before the window is drawn: skin + startup animation, so there's no flash.
    Services.obs.addObserver(function onBeforeShow(subject) {
      try {
        lazy.JaceWindow.early(subject);
      } catch (e) {
        console.error("Jace: early window setup failed", e);
      }
    }, "browser-window-before-show");

    Services.obs.addObserver(function onProfile() {
      Services.obs.removeObserver(onProfile, "final-ui-startup");
      try {
        keepFirefoxUserAgent();
      } catch (e) {
        initErrors.push(`couldn't check the user agent: ${e}`);
      }
      logStartup("browser UI starting (toolbar, new tab page, user agent)");
      relockNewTabPrefs();
      for (const name of NEWTAB_LOCKED) {
        Services.prefs.addObserver(name, () => relockNewTabPrefs());
      }
      hideSearchEngines().catch((e) => initErrors.push(`couldn't tidy the search engines: ${e}`));
      try {
        lazy.JaceNewTab.start();
      } catch (e) {
        initErrors.push(`couldn't set the Jace new tab page: ${e}`);
      }
      try {
        createWidgets();
      } catch (e) {
        initErrors.push(`couldn't create toolbar widgets: ${e}`);
        console.error("Jace: couldn't create toolbar widgets", e);
      }
    }, "final-ui-startup");

    // If we were loaded late (e.g. by scripts/dev-run.sh), catch up.
    if (Services.wm.getMostRecentWindow("navigator:browser")) {
      try {
        createWidgets();
      } catch (e) {
        console.error(e);
      }
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        if (win.gBrowserInit?.delayedStartupFinished) {
          onBrowserWindow(win);
        }
      }
    }

    Services.obs.addObserver(() => lazy.JaceSync.stop(), "quit-application-granted");
  },
};
