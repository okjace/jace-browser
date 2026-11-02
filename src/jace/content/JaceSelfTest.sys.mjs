/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * CI self-test, like Jace Launcher's --self-test. When the browser starts
 * with JACE_SELF_TEST_OUT=<file> (CI runs it headless right after
 * installing), this checks Jace Browser's own parts loaded, writes a report
 * ending in "SELF-TEST OK" or "SELF-TEST FAILED" to that file, and quits.
 */

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
    await check("about:jace is registered", () => {
      const ch = Services.io.newChannelFromURI(
        Services.io.newURI("about:jace"),
        null,
        Services.scriptSecurityManager.getSystemPrincipal(),
        null,
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
        Ci.nsIContentPolicy.TYPE_OTHER,
      );
      return ch.URI.spec.startsWith("chrome://jace/");
    });
    await check("account and vertical tabs widgets exist", () => {
      const { CustomizableUI } = ChromeUtils.importESModule("resource:///modules/CustomizableUI.sys.mjs");
      return !!CustomizableUI.getWidget("jace-account-button")?.provider && !!CustomizableUI.getWidget("jace-vertical-tabs-button")?.provider;
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

    lines.push(ok ? "SELF-TEST OK" : "SELF-TEST FAILED");
    await IOUtils.writeUTF8(out, lines.join("\n") + "\n");
    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  },
};
