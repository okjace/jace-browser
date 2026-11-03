/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * CI self-test, like Jace Launcher's --self-test. When the browser starts
 * with JACE_SELF_TEST_OUT=<file> (CI runs it headless right after
 * installing), this checks Jace Browser's own parts loaded, writes a report
 * ending in "SELF-TEST OK" or "SELF-TEST FAILED" to that file, and quits.
 */

import { getCustomizableUI } from "chrome://jace/content/JaceCompat.sys.mjs";

export const JaceSelfTest = {
  get requested() {
    return !!Services.env.get("JACE_SELF_TEST_OUT");
  },

  async run(win) {
    const out = Services.env.get("JACE_SELF_TEST_OUT");
    const lines = [];
    let ok = true;
    const check = async (name, fn) => {
      try {
        const result = await fn();
        lines.push(`${result ? "ok  " : "FAIL"} ${name}`);
        ok &&= !!result;
      } catch (e) {
        lines.push(`FAIL ${name}: ${e}`);
        ok = false;
      }
    };

    lines.push(`Jace Browser ${Services.prefs.getStringPref("jace.version", "?")} on Firefox ${Services.appinfo.version} (${Services.appinfo.OS})`);
    await check("Zen skin loaded into the window", () => win.__jaceReady);
    for (const what of ["jace", "jace-setup"]) {
      await check(`about:${what} is registered`, () => {
        const contract = `@mozilla.org/network/protocol/about;1?what=${what}`;
        if (!(contract in Cc)) {
          throw new Error("no about module registered");
        }
        const module = Cc[contract].getService(Ci.nsIAboutModule);
        return module.getChromeURI(Services.io.newURI(`about:${what}`)).spec.startsWith("chrome://jace/");
      });
    }
    await check("websites see Firefox (user agent)", () => {
      const ua = Cc["@mozilla.org/network/protocol;1?name=http"].getService(Ci.nsIHttpProtocolHandler).userAgent;
      if (!/ Firefox\/\d+\.\d+$/.test(ua)) throw new Error(ua);
      return true;
    });
    await check("the Jace new tab page is the new tab page", () => {
      const { JaceNewTab } = ChromeUtils.importESModule("chrome://jace/content/JaceNewTab.sys.mjs");
      return JaceNewTab.active;
    });
    await check("Jace look for the built-in pages is on", () => {
      const { JaceContentStyle } = ChromeUtils.importESModule("chrome://jace/content/JaceContentStyle.sys.mjs");
      return JaceContentStyle.started;
    });
    await check("Jace settings open in the browser's settings", () => {
      const { JaceSettingsPane } = ChromeUtils.importESModule("chrome://jace/content/JaceSettingsPane.sys.mjs");
      return JaceSettingsPane.url().startsWith("about:preferences");
    });
    await check("Firefox View, Relay and Firefox Suggest are off", () => {
      return (
        !Services.prefs.getBoolPref("browser.tabs.firefox-view", true) &&
        Services.prefs.getStringPref("signon.firefoxRelay.feature", "") === "disabled" &&
        !Services.prefs.getBoolPref("browser.urlbar.quicksuggest.enabled", true)
      );
    });
    await check("startup animation module loads", () => {
      const { ANIMATED_LOGO_SVG } = ChromeUtils.importESModule("chrome://jace/content/JaceSplash.sys.mjs");
      return ANIMATED_LOGO_SVG.includes("jace-logo-j");
    });
    await check("Mozilla telemetry is off and locked", () => {
      const wrong = [
        ["toolkit.telemetry.enabled", false],
        ["datareporting.healthreport.uploadEnabled", false],
        ["app.normandy.enabled", false],
        ["app.shield.optoutstudies.enabled", false],
        ["browser.newtabpage.activity-stream.showSponsored", false],
        ["dom.private-attribution.submission.enabled", false],
      ]
        .filter(([name, value]) => {
          try {
            return !Services.prefs.prefIsLocked(name) || Services.prefs.getBoolPref(name) !== value;
          } catch {
            return true;
          }
        })
        .map(([name]) => `${name}=${Services.prefs.getPrefType(name) ? Services.prefs.getBoolPref(name, null) : "missing"}${Services.prefs.prefIsLocked(name) ? " (locked)" : " (not locked)"}`);
      if (wrong.length) throw new Error(wrong.join(", "));
      return true;
    });
    await check("enterprise policies (distribution/policies.json) are active", () => {
      return Services.policies.status === Services.policies.ACTIVE && !Services.policies.isAllowed("Shield");
    });
    const expectKind = Services.env.get("JACE_SELF_TEST_UPDATE_KIND");
    if (expectKind) {
      await check(`can update itself (${expectKind})`, () => {
        const { JaceUpdates } = ChromeUtils.importESModule("chrome://jace/content/JaceUpdates.sys.mjs");
        return JaceUpdates.installKind === expectKind;
      });
    }
    await check("account and vertical tabs widgets exist", () => {
      const CustomizableUI = getCustomizableUI();
      return !!CustomizableUI.getWidget("jace-account-button")?.provider && !!CustomizableUI.getWidget("jace-vertical-tabs-button")?.provider;
    });
    await check("no profiles button; profiles listed for settings", () => {
      const CustomizableUI = getCustomizableUI();
      const { JaceProfiles } = ChromeUtils.importESModule("chrome://jace/content/JaceProfiles.sys.mjs");
      return !CustomizableUI.getPlacementOfWidget("jace-profiles-button") && Array.isArray(JaceProfiles.list());
    });
    await check("vertical tab style and window buttons applied", () => {
      const root = win.document.documentElement;
      const expected = Services.appinfo.OS === "Linux" ? "gnome" : "native";
      return root.getAttribute("jace-tabs-style") === "full" && root.getAttribute("jace-window-controls") === expected;
    });
    await check("Jace website sign-in is set up", () => {
      const { JaceAccount } = ChromeUtils.importESModule("chrome://jace/content/JaceAccount.sys.mjs");
      return typeof JaceAccount.signInToWebsite === "function" && JaceAccount.autoSignIn;
    });
    await check("Mozilla's terms-of-use screen is off", () => {
      return !Services.prefs.getBoolPref("browser.preonboarding.enabled", true) && Services.prefs.prefIsLocked("browser.preonboarding.enabled");
    });
    await check("vertical tabs on by default", () => Services.prefs.getBoolPref("sidebar.verticalTabs"));
    await check("Jace sync modules load", () => {
      const { JaceSync } = ChromeUtils.importESModule("chrome://jace/content/sync/JaceSync.sys.mjs");
      return JaceSync.ENGINE_NAMES.includes("cookies");
    });
    await check("sync encryption round-trips", async () => {
      const { JaceCrypto } = ChromeUtils.importESModule("chrome://jace/content/sync/JaceCrypto.sys.mjs");
      const key = await JaceCrypto.deriveKey("self-test passphrase", JaceCrypto.newSalt(), 1000);
      const blob = await JaceCrypto.encrypt(key, "bookmarks", { a: 1 });
      return (await JaceCrypto.decrypt(key, "bookmarks", blob)).a === 1;
    });
    await check("WebUSB helper installed and answering", async () => {
      const { JaceUSBService } = ChromeUtils.importESModule("chrome://jace/content/usb/JaceUSBService.sys.mjs");
      return JaceUSBService.helperInstalled() && Array.isArray(await JaceUSBService.listAll());
    });
    await check("DRM (EME + Widevine) enabled", () => {
      return Services.prefs.getBoolPref("media.eme.enabled") && Services.prefs.getBoolPref("media.gmp-widevinecdm.enabled");
    });
    await check("Widevine is offered on this platform", () => {
      // Built with --enable-eme=widevine: the Widevine plugin entry exists in the add-ons manager.
      return Services.prefs.getPrefType("media.gmp-widevinecdm.visible") === Ci.nsIPrefBranch.PREF_BOOL;
    });

    const { initErrors } = ChromeUtils.importESModule("chrome://jace/content/JaceLoader.sys.mjs");
    for (const e of initErrors) {
      lines.push(`startup error: ${e}`);
    }
    lines.push(ok ? "SELF-TEST OK" : "SELF-TEST FAILED");
    await IOUtils.writeUTF8(out, lines.join("\n") + "\n");
    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  },
};
