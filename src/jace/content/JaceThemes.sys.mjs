/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Themes: Jace's own color themes, a custom theme you make yourself, and
 * Firefox add-on themes (from addons.mozilla.org) - all three work.
 *
 *   jace.theme.id      "jace" (follows the system's light/dark), a preset id,
 *                      or "custom"
 *   jace.theme.custom  {"bg": "#…", "fg": "#…", "accent": "#…"} for "custom"
 *   jace.theme.accent  the accent color (a theme sets it when picked)
 *
 * A theme's colors go to the window (JaceWindow: CSS variables on <html>),
 * to the browser's own pages and Jace's pages (JaceContentStyle), and its
 * light/dark mode to everything else (web pages see it as their color scheme).
 * While an add-on theme is on, Jace steps back and lets it color the window.
 */

const ID_PREF = "jace.theme.id";
const CUSTOM_PREF = "jace.theme.custom";
const ACCENT_PREF = "jace.theme.accent";
const ACTIVE_THEME_PREF = "extensions.activeThemeID";
const DARK_PREF = "ui.systemUsesDarkTheme";
const CONTENT_SCHEME_PREF = "layout.css.prefers-color-scheme.content-override";

/** Firefox's built-in themes: not "add-on themes" (Jace's own look replaces them). */
const BUILTIN_THEMES = new Set([
  "default-theme@mozilla.org",
  "firefox-compact-light@mozilla.org",
  "firefox-compact-dark@mozilla.org",
  "firefox-alpenglow@mozilla.org",
]);
export const DEFAULT_THEME_ID = "default-theme@mozilla.org";

export const THEMES = {
  jace: { name: "Jace", note: "Light or dark, like your system", accent: "#3ddc84" },
  light: { name: "Light", mode: "light", bg: "#f4f5f7", card: "#ffffff", fg: "#16181d", accent: "#3ddc84" },
  dark: { name: "Dark", mode: "dark", bg: "#111317", card: "#1b1e24", fg: "#e6e8eb", accent: "#3ddc84" },
  black: { name: "Black", mode: "dark", bg: "#000000", card: "#121212", fg: "#f2f2f2", accent: "#3ddc84" },
  midnight: { name: "Midnight", mode: "dark", bg: "#0c1122", card: "#161d33", fg: "#e2e7f6", accent: "#818cf8" },
  ocean: { name: "Ocean", mode: "dark", bg: "#0a1923", card: "#112634", fg: "#ddedf6", accent: "#38bdf8" },
  forest: { name: "Forest", mode: "dark", bg: "#0e1912", card: "#16261c", fg: "#e0eee5", accent: "#4ade80" },
  grape: { name: "Grape", mode: "dark", bg: "#170f22", card: "#231834", fg: "#ece3f7", accent: "#c084fc" },
  ember: { name: "Ember", mode: "dark", bg: "#1a100c", card: "#271913", fg: "#f6e7df", accent: "#fb923c" },
  rose: { name: "Rose", mode: "light", bg: "#fbf0f2", card: "#ffffff", fg: "#2b1a1f", accent: "#e11d74" },
  sand: { name: "Sand", mode: "light", bg: "#f5efe4", card: "#fffaf1", fg: "#2a2318", accent: "#d97706" },
  sky: { name: "Sky", mode: "light", bg: "#eef5fb", card: "#ffffff", fg: "#13202b", accent: "#0284c7" },
  custom: { name: "Custom", note: "Your own colors" },
};

const HEX = /^#[0-9a-f]{6}$/i;

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mix(a, b, amount) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * amount).toString(16).padStart(2, "0")).join("")}`;
}

export function customTheme() {
  let c = {};
  try {
    c = JSON.parse(Services.prefs.getStringPref(CUSTOM_PREF, "{}")) ?? {};
  } catch {}
  const bg = HEX.test(c.bg) ? c.bg : "#14161c";
  const dark = luminance(bg) < 0.4;
  const fg = HEX.test(c.fg) ? c.fg : dark ? "#e8eaee" : "#16181d";
  const accent = HEX.test(c.accent) ? c.accent : "#3ddc84";
  return { name: "Custom", mode: dark ? "dark" : "light", bg, card: mix(bg, "#ffffff", dark ? 0.06 : 0.6), fg, accent };
}

export const JaceThemes = {
  THEMES,

  get id() {
    const id = Services.prefs.getStringPref(ID_PREF, "jace");
    return id in THEMES ? id : "jace";
  },

  /** True while a Firefox add-on theme (not a built-in one) is on. */
  get addonThemeActive() {
    const id = Services.prefs.getStringPref(ACTIVE_THEME_PREF, DEFAULT_THEME_ID);
    return !!id && !BUILTIN_THEMES.has(id);
  },

  /**
   * The colors to use, or null for "follow the system" (Jace's built-in
   * light and dark look) and while an add-on theme is on.
   * { mode, bg, card, fg, muted, line, accent }
   */
  palette() {
    if (this.addonThemeActive) return null;
    const id = this.id;
    const theme = id === "custom" ? customTheme() : THEMES[id];
    if (!theme?.bg) return null;
    return {
      ...theme,
      muted: mix(theme.fg, theme.bg, 0.42),
      line: mix(theme.fg, theme.bg, theme.mode === "dark" ? 0.86 : 0.88),
    };
  },

  /** Picks a theme (and its accent). Turns off an add-on theme so it shows. */
  async choose(id) {
    if (!(id in THEMES)) return;
    Services.prefs.setStringPref(ID_PREF, id);
    const accent = id === "custom" ? customTheme().accent : THEMES[id].accent;
    if (accent) Services.prefs.setStringPref(ACCENT_PREF, accent);
    if (this.addonThemeActive) {
      try {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const builtin = await AddonManager.getAddonByID(DEFAULT_THEME_ID);
        await builtin?.enable();
      } catch (e) {
        console.warn("Jace: couldn't turn off the add-on theme", e);
      }
    }
  },

  setCustom(colors) {
    const current = customTheme();
    const next = { bg: current.bg, fg: current.fg, accent: current.accent, ...colors };
    if (colors.bg && !colors.fg) {
      // A new background: keep the text readable.
      next.fg = luminance(colors.bg) < 0.4 ? "#e8eaee" : "#16181d";
    }
    Services.prefs.setStringPref(CUSTOM_PREF, JSON.stringify(next));
    Services.prefs.setStringPref(ACCENT_PREF, next.accent);
    Services.prefs.setStringPref(ID_PREF, "custom");
  },

  /** Light/dark for the whole browser and web pages, from the theme. */
  applyMode() {
    const p = this.palette();
    try {
      if (p?.mode) {
        Services.prefs.setIntPref(DARK_PREF, p.mode === "dark" ? 1 : 0);
        Services.prefs.setIntPref(CONTENT_SCHEME_PREF, p.mode === "dark" ? 0 : 1);
      } else {
        Services.prefs.clearUserPref(DARK_PREF);
        Services.prefs.clearUserPref(CONTENT_SCHEME_PREF);
      }
    } catch (e) {
      console.warn("Jace: couldn't set light/dark", e);
    }
  },

  /** Calls fn whenever the theme changes (Jace theme, custom colors, or an add-on theme). */
  observe(fn) {
    for (const pref of [ID_PREF, CUSTOM_PREF, ACTIVE_THEME_PREF]) Services.prefs.addObserver(pref, fn);
    return () => {
      for (const pref of [ID_PREF, CUSTOM_PREF, ACTIVE_THEME_PREF]) Services.prefs.removeObserver(pref, fn);
    };
  },

  PREFS: [ID_PREF, CUSTOM_PREF],
};
