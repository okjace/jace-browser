/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Makes Jace Browser's own new tab page (newtab/newtab.html) the new tab
 * page and the default home page, instead of Firefox's. Turn it off with
 * jace.newtab.enabled (Settings -> Jace -> Look).
 */

import { importFirst } from "chrome://jace/content/JaceCompat.sys.mjs";

export const NEWTAB_URL = "chrome://jace/content/newtab/newtab.html";

function aboutNewTab() {
  return importFirst([
    "moz-src:///browser/components/newtab/AboutNewTab.sys.mjs",
    "resource:///modules/AboutNewTab.sys.mjs",
  ]).AboutNewTab;
}

function apply() {
  const on = Services.prefs.getBoolPref("jace.newtab.enabled", true);
  const AboutNewTab = aboutNewTab();
  if (on) {
    AboutNewTab.newTabURL = NEWTAB_URL;
    // Default (not user) value: a home page you chose yourself still wins.
    Services.prefs.getDefaultBranch("").setStringPref("browser.startup.homepage", NEWTAB_URL);
  } else {
    AboutNewTab.resetNewTabURL?.();
    Services.prefs.getDefaultBranch("").setStringPref("browser.startup.homepage", "about:home");
  }
}

let started = false;

export const JaceNewTab = {
  NEWTAB_URL,

  get active() {
    try {
      return aboutNewTab().newTabURL === NEWTAB_URL;
    } catch {
      return false;
    }
  },

  start() {
    if (started) return;
    started = true;
    apply();
    Services.prefs.addObserver("jace.newtab.enabled", () => apply());
  },
};
