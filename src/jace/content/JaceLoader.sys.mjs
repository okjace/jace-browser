/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Starts Jace Browser's features. jace.cfg (autoconfig) calls init() once,
 * early in startup, in the parent process:
 *
 * - registers about:jace (Jace settings: account, sync, look, WebUSB, DRM)
 * - adds the toolbar widgets (Jace account, vertical tabs on/off)
 * - sets up every browser window (JaceWindow: Zen-style look, shortcuts)
 * - registers the WebUSB window actor (navigator.usb in web pages)
 * - starts Jace sync once the first window is up
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI: "resource:///modules/CustomizableUI.sys.mjs",
  JaceSelfTest: "chrome://jace/content/JaceSelfTest.sys.mjs",
  JaceSync: "chrome://jace/content/sync/JaceSync.sys.mjs",
  JaceWindow: "chrome://jace/content/JaceWindow.sys.mjs",
});

const ABOUT_JACE_URL = "chrome://jace/content/settings/settings.html";
const ABOUT_JACE_CID = Components.ID("{6c3f5d9e-2b1a-4b8e-9a51-6a0f2f3b7c11}");

let initialized = false;
let syncStarted = false;

function registerAboutJace() {
  const chromeURI = Services.io.newURI(ABOUT_JACE_URL);
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
  Components.manager
    .QueryInterface(Ci.nsIComponentRegistrar)
    .registerFactory(ABOUT_JACE_CID, "about:jace", "@mozilla.org/network/protocol/about;1?what=jace", factory);
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
  if (!syncStarted) {
    syncStarted = true;
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
      ["about:jace", registerAboutJace],
      ["WebUSB", registerWebUSB],
    ]) {
      try {
        fn();
      } catch (e) {
        console.error(`Jace: couldn't register ${what}`, e);
      }
    }

    // Widgets need CustomizableUI, which needs the profile; windows come later.
    Services.obs.addObserver(function onWindow(subject) {
      onBrowserWindow(subject);
    }, "browser-delayed-startup-finished");

    Services.obs.addObserver(function onProfile() {
      Services.obs.removeObserver(onProfile, "final-ui-startup");
      try {
        createWidgets();
      } catch (e) {
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
