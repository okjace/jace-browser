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
  JaceAccount: "chrome://jace/content/JaceAccount.sys.mjs",
  JaceSelfTest: "chrome://jace/content/JaceSelfTest.sys.mjs",
  JaceSync: "chrome://jace/content/sync/JaceSync.sys.mjs",
  JaceWindow: "chrome://jace/content/JaceWindow.sys.mjs",
  JaceProfiles: "chrome://jace/content/JaceProfiles.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "CustomizableUI", () => getCustomizableUI());

const ABOUT_JACE_URL = "chrome://jace/content/settings/settings.html";
const ABOUT_PAGES = {
  jace: { url: ABOUT_JACE_URL, cid: "{6c3f5d9e-2b1a-4b8e-9a51-6a0f2f3b7c11}" },
  "jace-setup": { url: "chrome://jace/content/setup/setup.html", cid: "{0f6a2c1e-8d3b-4f4a-b7e2-5c9d1a3e6b20}" },
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
function maybeOpenSetup(win) {
  if (setupChecked) return;
  setupChecked = true;
  if (Services.prefs.getBoolPref("jace.setup.done", false)) return;
  // Wait for Firefox's own first page (new tab / home) to finish opening, so
  // it can't replace the setup.
  win.setTimeout(() => {
    try {
      const url = jacePageURL("jace-setup");
      const gBrowser = win.gBrowser;
      const already = gBrowser.tabs.find((t) => /jace-setup|setup\/setup\.html/.test(t.linkedBrowser.currentURI?.spec ?? ""));
      if (already) {
        gBrowser.selectedTab = already;
        return;
      }
      const current = gBrowser.selectedBrowser.currentURI?.spec ?? "";
      if (gBrowser.tabs.length === 1 && /^about:(home|newtab|blank|welcome)?$/.test(current)) {
        win.openTrustedLinkIn(url, "current");
      } else {
        gBrowser.selectedTab = gBrowser.addTrustedTab(url);
      }
    } catch (e) {
      initErrors.push(`couldn't open setup: ${e}`);
      console.error("Jace: couldn't open setup", e);
    }
  }, 1200);
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

function createWidgets() {
  const { CustomizableUI } = lazy;

  CustomizableUI.createWidget({
    id: "jace-account-button",
    type: "button",
    label: "Jace account",
    tooltiptext: "Jace account and sync",
    defaultArea: CustomizableUI.AREA_NAVBAR,
    removable: true,
    onCreated(node) {
      lazy.JaceWindow.updateAccountButton(node);
    },
    onCommand(event) {
      lazy.JaceWindow.openAccountPanel(event.target.ownerGlobal, event.target);
    },
  });

  CustomizableUI.createWidget({
    id: "jace-profiles-button",
    type: "button",
    label: "Profiles",
    tooltiptext: "Switch profiles",
    defaultArea: CustomizableUI.AREA_NAVBAR,
    removable: true,
    onCreated(node) {
      lazy.JaceWindow.updateProfilesButton(node);
    },
    onCommand(event) {
      lazy.JaceWindow.openProfilesPanel(event.target.ownerGlobal, event.target);
    },
  });
  lazy.JaceProfiles.syncButtonPlacement();
  lazy.JaceProfiles.watchPref();

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
  }
}

export const JaceLoader = {
  ABOUT_JACE_URL,

  init() {
    if (initialized) {
      return;
    }
    initialized = true;

    for (const [what, fn] of [
      ["about:jace pages", registerAboutPages],
      ["WebUSB", registerWebUSB],
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
