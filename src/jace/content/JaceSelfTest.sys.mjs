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
        lines.push(`${result ? "ok  " : "FAIL"} ${name}${typeof result === "string" ? ` (${result})` : ""}`);
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
    await check("only-icons vertical tabs are narrow", async () => {
      // Also a probe: reports how this Firefox builds its sidebar, to fix the CSS against.
      const doc = win.document;
      const describe = (el) =>
        el ? `${el.localName}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}` : "none";
      const before = Services.prefs.getStringPref("jace.tabs.verticalStyle", "full");
      Services.prefs.setBoolPref("sidebar.verticalTabs", true);
      Services.prefs.setStringPref("jace.tabs.verticalStyle", "icons");
      await new Promise((r) => win.setTimeout(r, 800));
      const tab = win.gBrowser.selectedTab;
      const chain = [];
      for (let el = tab; el && el !== doc.documentElement && chain.length < 14; el = el.parentElement ?? el.getRootNode()?.host) {
        chain.push(`${describe(el)}=${Math.round(el.getBoundingClientRect?.().width ?? 0)}px`);
      }
      const label = tab.querySelector(".tab-label-container");
      const labelShown = label ? win.getComputedStyle(label).display !== "none" : false;
      const root = doc.documentElement;
      const info = [
        `attrs: vertical=${root.hasAttribute("jace-vertical-tabs")} style=${root.getAttribute("jace-tabs-style")}`,
        `tab label shown: ${labelShown}`,
        `tab -> root: ${chain.join(" < ")}`,
      ].join("; ");
      const tabBox = tab.getBoundingClientRect();
      const side = (doc.getElementById("sidebar-container") ?? doc.getElementById("sidebar-main"))?.getBoundingClientRect();
      const inside = side ? tabBox.left >= side.left - 1 && tabBox.right <= side.right + 1 : false;
      if (labelShown || tabBox.width > 60 || !inside) {
        throw new Error(
          `tab ${Math.round(tabBox.width)}px wide at ${Math.round(tabBox.left)}-${Math.round(tabBox.right)}, sidebar ${side ? `${Math.round(side.left)}-${Math.round(side.right)}` : "missing"}; ${info}`,
        );
      }
      Services.prefs.setStringPref("jace.tabs.verticalStyle", before);
      return true;
    });
    await check("the + New Tab button lines up with the tabs", async () => {
      const doc = win.document;
      const before = Services.prefs.getStringPref("jace.tabs.verticalStyle", "full");
      Services.prefs.setBoolPref("sidebar.verticalTabs", true);
      const problems = [];
      for (const style of ["full", "icons"]) {
        Services.prefs.setStringPref("jace.tabs.verticalStyle", style);
        await new Promise((r) => win.setTimeout(r, 700));
        const side = doc.getElementById("sidebar-container") ?? doc;
        const tabIcon = win.gBrowser.selectedTab.querySelector(".tab-icon-stack, .tab-icon-image");
        const button = side.querySelector("#vertical-tabs-newtab-button, #tabs-newtab-button, #new-tab-button");
        const buttonIcon = button?.querySelector(".toolbarbutton-icon") ?? button;
        if (!tabIcon || !buttonIcon) {
          problems.push(`${style}: tab icon ${!!tabIcon}, button ${button ? button.id : "missing"}`);
          continue;
        }
        const a = tabIcon.getBoundingClientRect();
        const b = buttonIcon.getBoundingClientRect();
        const off = style === "icons" ? b.left + b.width / 2 - (a.left + a.width / 2) : b.left - a.left;
        if (Math.abs(off) > 3) {
          const cs = win.getComputedStyle(button);
          const ci = win.getComputedStyle(buttonIcon);
          problems.push(
            `${style}: + is ${Math.round(off)}px off (button #${button.id} in ${button.parentElement?.localName}#${button.parentElement?.id}; ` +
              `tab icon ${Math.round(a.left)}+${Math.round(a.width)}, + icon ${Math.round(b.left)}+${Math.round(b.width)}; ` +
              `button margin ${cs.marginLeft}/${cs.marginRight} padding ${cs.paddingLeft}/${cs.paddingRight}; ` +
              `icon padding ${ci.paddingLeft} margin ${ci.marginLeft})`,
          );
        }
      }
      Services.prefs.setStringPref("jace.tabs.verticalStyle", before);
      if (problems.length) throw new Error(problems.join(" | "));
      return true;
    });
    await check("account panel and profile switcher build", async () => {
      const { JaceAccountPanel, ACCOUNT_VIEW, PROFILES_VIEW } = ChromeUtils.importESModule(
        "chrome://jace/content/JaceAccountPanel.sys.mjs",
      );
      const CustomizableUI = getCustomizableUI();
      if (CustomizableUI.getWidget("jace-account-button")?.type !== "view") throw new Error("account button isn't a panel button");
      JaceAccountPanel.install(win);
      const find = (id) => win.PanelMultiView?.getViewNode?.(win.document, id) ?? win.document.getElementById(id);
      const account = find(ACCOUNT_VIEW);
      const profiles = find(PROFILES_VIEW);
      await JaceAccountPanel.fillAccountView(account);
      JaceAccountPanel.fillProfilesView(profiles);
      const n = (v) => v.querySelectorAll("toolbarbutton, button").length;
      if (n(account) < 3 || n(profiles) < 2) throw new Error(`account ${n(account)} / profiles ${n(profiles)} buttons`);
      return true;
    });
    await check("Jace settings are in about:preferences", async () => {
      // Also a probe: reports how this Firefox's settings page is built.
      const tab = win.gBrowser.addTrustedTab("about:preferences#jace", { inBackground: true });
      const browser = tab.linkedBrowser;
      for (let i = 0; i < 40 && browser.contentDocument?.readyState !== "complete"; i++) {
        await new Promise((r) => win.setTimeout(r, 250));
      }
      await new Promise((r) => win.setTimeout(r, 800));
      const d = browser.contentDocument;
      const frames = d ? [...d.querySelectorAll(".jace-settings-frame")] : [];
      const found = frames.length > 0 || !!d?.getElementById("jace-settings-section");
      const probe = d
        ? [
            `uri=${d.documentURI}`,
            `categories=${!!d.getElementById("categories")}`,
            `mainPrefPane=${!!d.getElementById("mainPrefPane")}`,
            `register_module=${typeof d.defaultView?.register_module}`,
            `nav=${[...d.querySelectorAll("moz-page-nav, nav, [role=navigation], richlistbox")].map((e) => e.localName + (e.id ? "#" + e.id : "")).join(",") || "none"}`,
            `panes=${[...(d.getElementById("categories")?.querySelectorAll("[view], richlistitem[value]") ?? [])].map((n) => n.getAttribute("view") ?? n.getAttribute("value")).join(",")}`,
            `jace=${frames.length ? frames.map((f) => f.dataset.category + ":" + new URL(f.src).searchParams.get("only")).join(" ") : d.getElementById("jace-settings-section") ? "top" : "missing"}`,
          ].join("; ")
        : "no document";
      win.gBrowser.removeTab(tab);
      if (!found) throw new Error(probe);
      return probe;
    });
    await check("the account panel's Sign in with Jace button opens Jace's sign-in page", async () => {
      const { JaceAccount } = ChromeUtils.importESModule("chrome://jace/content/JaceAccount.sys.mjs");
      const { JaceAccountPanel, ACCOUNT_VIEW } = ChromeUtils.importESModule("chrome://jace/content/JaceAccountPanel.sys.mjs");
      JaceAccountPanel.install(win);
      const view = win.PanelMultiView?.getViewNode?.(win.document, ACCOUNT_VIEW) ?? win.document.getElementById(ACCOUNT_VIEW);
      await JaceAccountPanel.fillAccountView(view);
      const button = [...view.querySelectorAll("toolbarbutton")].find((b) => /Sign in with Jace/.test(b.getAttribute("label")));
      if (!button) throw new Error("no Sign in with Jace button in the panel");
      button.doCommand();
      await new Promise((r) => win.setTimeout(r, 800));
      const tab = JaceAccount.pendingTab;
      const ok = !!tab?.isConnected;
      JaceAccount.cancelSignIn();
      if (tab?.isConnected) win.gBrowser.removeTab(tab);
      if (!ok) throw new Error("no sign-in tab opened");
      return true;
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
