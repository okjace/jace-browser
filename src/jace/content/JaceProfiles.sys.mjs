/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Profiles: separate sets of tabs, history, passwords, add-ons and Jace
 * account - e.g. Personal and School. The profiles button in the toolbar
 * shows which one this window is and opens the others side by side.
 *
 * Hide the button with jace.profiles.showButton (the "Hide this button" link
 * in its panel, or about:jace -> Look); profiles stay in about:jace.
 */

import { getCustomizableUI } from "chrome://jace/content/JaceCompat.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
});
ChromeUtils.defineLazyGetter(lazy, "CustomizableUI", () => getCustomizableUI());

export const PROFILES_WIDGET = "jace-profiles-button";
const SHOW_PREF = "jace.profiles.showButton";
const COLORS = ["#3ddc84", "#38bdf8", "#a78bfa", "#f472b6", "#fb923c", "#f87171", "#facc15", "#2dd4bf"];

function service() {
  return Cc["@mozilla.org/toolkit/profile-service;1"].getService(Ci.nsIToolkitProfileService);
}

function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const JaceProfiles = {
  /** [{ name, current, running, color }] */
  list() {
    const svc = service();
    const current = this.currentName;
    const out = [];
    for (const profile of svc.profiles) {
      out.push({
        name: profile.name,
        current: profile.name === current,
        running: profile.name !== current && this._isRunning(profile),
        color: colorFor(profile.name),
      });
    }
    return out.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
  },

  /** This window's profile name (null when started with -profile <path>). */
  get currentName() {
    try {
      const svc = service();
      if (svc.currentProfile) return svc.currentProfile.name;
      // Started with a path: match it against the known profiles.
      const dir = Services.dirsvc.get("ProfD", Ci.nsIFile);
      for (const p of svc.profiles) {
        if (p.rootDir.equals(dir)) return p.name;
      }
    } catch {}
    return null;
  },

  _isRunning(profile) {
    try {
      const lock = profile.lock({});
      lock.unlock();
      return false;
    } catch {
      return true; // locked: open in another Jace Browser window
    }
  },

  /** Starts Jace Browser with another profile, in its own window. */
  open(name) {
    const svc = service();
    const profile = [...svc.profiles].find((p) => p.name === name);
    if (!profile) throw new Error(`There's no profile called ${name}.`);
    if (this._isRunning(profile)) {
      // Already open: ask it for a new window (the running copy handles -P + a URL).
      return this._launch(["-P", name, "--new-window", "about:blank"]);
    }
    return this._launch(["-P", name, "--no-remote"]);
  },

  _launch(args) {
    const exe = Services.dirsvc.get("XREExeF", Ci.nsIFile);
    const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    proc.init(exe);
    proc.runw(false, args);
  },

  /** Creates a profile and opens it. */
  async create(name) {
    name = String(name ?? "").trim().slice(0, 60);
    if (!name) throw new Error("Give the profile a name.");
    const svc = service();
    if ([...svc.profiles].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`There's already a profile called ${name}.`);
    }
    svc.createProfile(null, name);
    if (typeof svc.asyncFlush === "function") await svc.asyncFlush();
    else svc.flush();
    this.open(name);
  },

  /** A round badge with the profile's first letter, as a data: URL for the toolbar icon. */
  badge(name) {
    const letter = escapeXml((name ?? "?").trim().charAt(0).toUpperCase() || "?");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
      `<circle cx="8" cy="8" r="8" fill="${colorFor(name ?? "?")}"/>` +
      `<text x="8" y="11.6" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#0c1410">${letter}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  },

  get showButton() {
    return Services.prefs.getBoolPref(SHOW_PREF, true);
  },

  set showButton(show) {
    Services.prefs.setBoolPref(SHOW_PREF, !!show);
  },

  /** Puts the toolbar button where the pref says (called at startup and when the pref changes). */
  syncButtonPlacement() {
    const { CustomizableUI } = lazy;
    const placement = CustomizableUI.getPlacementOfWidget(PROFILES_WIDGET);
    if (this.showButton && !placement) {
      CustomizableUI.addWidgetToArea(PROFILES_WIDGET, CustomizableUI.AREA_NAVBAR);
    } else if (!this.showButton && placement) {
      CustomizableUI.removeWidgetFromArea(PROFILES_WIDGET);
    }
  },

  watchPref() {
    Services.prefs.addObserver(SHOW_PREF, () => this.syncButtonPlacement());
    // Removing the button with Customize Toolbar also counts as hiding it.
    lazy.CustomizableUI.addListener({
      onWidgetRemoved: (id) => {
        if (id === PROFILES_WIDGET && this.showButton) this.showButton = false;
      },
      onWidgetAdded: (id) => {
        if (id === PROFILES_WIDGET && !this.showButton) this.showButton = true;
      },
    });
  },
};
