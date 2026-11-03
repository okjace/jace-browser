/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Per-window setup for Jace Browser:
 * - loads the Zen-style skin (chrome://jace/skin/jace.css)
 * - mirrors look prefs onto <html> attributes the skin keys off
 *   (jace-vertical-tabs, jace-compact, jace-floating) and the accent color
 * - Ctrl+Alt+V (Cmd+Opt+V on macOS) turns vertical tabs on/off
 * - the Jace account panel (sign in, sync status, other devices' tabs)
 */

import { getCustomizableUI } from "chrome://jace/content/JaceCompat.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JaceAccount: "chrome://jace/content/JaceAccount.sys.mjs",
  JaceSettingsPane: "chrome://jace/content/JaceSettingsPane.sys.mjs",
  JaceAccountPanel: "chrome://jace/content/JaceAccountPanel.sys.mjs",
  JaceThemes: "chrome://jace/content/JaceThemes.sys.mjs",
  JaceQuickTab: "chrome://jace/content/JaceQuickTab.sys.mjs",
  JaceDownloadsButton: "chrome://jace/content/JaceDownloadsButton.sys.mjs",
  JaceSplash: "chrome://jace/content/JaceSplash.sys.mjs",
  JaceSync: "chrome://jace/content/sync/JaceSync.sys.mjs",
  JaceUpdates: "chrome://jace/content/JaceUpdates.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "CustomizableUI", () => getCustomizableUI());

const SKIN = "chrome://jace/skin/jace.css";
const VERTICAL_PREF = "sidebar.verticalTabs";
const LOOK_PREFS = {
  "sidebar.verticalTabs": "jace-vertical-tabs",
  "jace.theme.compact": "jace-compact",
  "jace.theme.floatingContent": "jace-floating",
};
const TAB_STYLE_PREF = "jace.tabs.verticalStyle"; // "full" | "icons" | "hover"
const CONTROLS_PREF = "jace.windowControls.style"; // "system" | "jace" | "minimal"

/**
 * The window button style actually drawn. "system" (the default) means
 * GNOME/Adwaita-style buttons on Linux (skin/jace.css), and the real system
 * buttons on Windows and macOS ("native": nothing restyled).
 */
export function windowControlsStyle() {
  const style = Services.prefs.getStringPref(CONTROLS_PREF, "system");
  if (style === "jace" || style === "minimal") return style;
  return Services.appinfo.OS === "Linux" ? "gnome" : "native";
}
export const TAB_STYLES = ["full", "icons", "hover"];

function tabStyle() {
  const style = Services.prefs.getStringPref(TAB_STYLE_PREF, "full");
  return TAB_STYLES.includes(style) ? style : "full";
}

/**
 * Vertical tab style, done by Jace itself (skin/jace.css, the
 * jace-tabs-style attribute) so it works the same on every Firefox version:
 *   full   - names and icons
 *   icons  - only icons
 *   hover  - only icons, growing over the page while you hover
 * Firefox's own sidebar stays in its normal (expanded, always shown) mode so
 * the two never fight.
 */
function applyTabStyleGlobally() {
  if (Services.prefs.getStringPref("sidebar.visibility", "always-show") === "expand-on-hover") {
    Services.prefs.setStringPref("sidebar.visibility", "always-show");
  }
  Services.prefs.setBoolPref("sidebar.expandOnHover", false);
}

function applyTabStyle(win) {
  const style = tabStyle();
  const root = win.document.documentElement;
  root.setAttribute("jace-tabs-style", style);
  // Names must exist for "full" and for the hover mode to show them.
  const expand = () => {
    try {
      if (win.SidebarController?.sidebarMain && !win.SidebarController.sidebarMain.expanded) {
        win.SidebarController.toggleExpanded?.(true);
      }
    } catch (e) {
      console.warn("Jace: couldn't expand the sidebar", e);
    }
  };
  expand();
  // Firefox restores its own sidebar state a moment after the window opens.
  win.setTimeout(expand, 1500);
  alignIconsSoon(win);
}

const ICON_COLUMN = 56; // px: the icon column in the "icons" and "hover" styles

/**
 * In the icon styles, centers the tab icons and the + New Tab icon in the
 * icon column by measuring where they really are (Firefox's own spacing
 * changes between versions) and nudging them with the `translate` property.
 */
function alignIcons(win) {
  const doc = win.document;
  const root = doc.documentElement;
  const style = root.getAttribute("jace-tabs-style");
  if (!root.hasAttribute("jace-vertical-tabs") || (style !== "icons" && style !== "hover")) {
    root.style.removeProperty("--jace-tab-nudge");
    root.style.removeProperty("--jace-newtab-nudge");
    return;
  }
  const container = doc.getElementById("sidebar-container") ?? doc.getElementById("sidebar-main");
  if (!container) return;
  const left = container.getBoundingClientRect().left;
  const nudge = (el, prop) => {
    const r = el?.getBoundingClientRect();
    if (!r?.width) return;
    const current = parseFloat(root.style.getPropertyValue(prop)) || 0;
    const delta = ICON_COLUMN / 2 - (r.left + r.width / 2 - left);
    if (Math.abs(delta) > 0.5) root.style.setProperty(prop, `${Math.round((current + delta) * 2) / 2}px`);
  };
  const tab = win.gBrowser?.selectedTab;
  nudge(tab?.querySelector(".tab-icon-stack") ?? tab?.querySelector(".tab-icon-image"), "--jace-tab-nudge");
  nudge(
    doc.querySelector(":is(#vertical-tabs-newtab-button, #tabs-newtab-button, #new-tab-button) .toolbarbutton-icon"),
    "--jace-newtab-nudge",
  );
}

function alignIconsSoon(win) {
  for (const ms of [0, 300, 1600, 3000]) {
    win.setTimeout(() => {
      try {
        alignIcons(win);
      } catch (e) {
        console.warn("Jace: couldn't line up the tab icons", e);
      }
    }, ms);
  }
  if (!win.__jaceAlignHooked) {
    win.__jaceAlignHooked = true;
    win.addEventListener("resize", () => alignIconsSoon(win));
    win.gBrowser?.tabContainer?.addEventListener("TabSelect", () => win.setTimeout(() => alignIcons(win), 50));
  }
}

function applyLook(win) {
  const root = win.document.documentElement;
  for (const [pref, attr] of Object.entries(LOOK_PREFS)) {
    root.toggleAttribute(attr, Services.prefs.getBoolPref(pref, false));
  }
  root.setAttribute("jace-window-controls", windowControlsStyle());
  const accent = Services.prefs.getStringPref("jace.theme.accent", "#3ddc84");
  if (/^#[0-9a-f]{3,8}$/i.test(accent)) {
    root.style.setProperty("--jace-accent", accent);
  }
  applyTheme(win);
}

/** Jace's own close button on a tab (Firefox's hides itself in some sidebar layouts). */
function addCloseButton(tab) {
  if (!tab || tab.querySelector(".jace-tab-close")) return;
  // On top of the tab (its .tab-stack layers everything in one spot), not in
  // the row of icon/label/buttons, where Firefox's layouts can squeeze it out.
  const host = tab.querySelector(".tab-stack") ?? tab.querySelector(".tab-content") ?? tab;
  const doc = tab.ownerDocument;
  const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  button.className = "jace-tab-close";
  button.setAttribute("role", "button");
  button.setAttribute("title", "Close tab");
  // Clicks are handled for the whole window in watchCloseClicks: the tab
  // strip grabs the mouse (for dragging tabs) before a button inside a tab
  // would see it.
  host.append(button);
}

/**
 * Close-button clicks, caught at the window before the tab strip (which
 * takes the mouse for dragging) can swallow them: a press and release on a
 * tab's close button closes that tab.
 */
function watchCloseClicks(win) {
  if (win.__jaceCloseClicks) return;
  win.__jaceCloseClicks = true;
  const within = (button, e) => {
    const r = button.getBoundingClientRect();
    return r.width > 0 && e.clientX >= r.left - 1 && e.clientX <= r.right + 1 && e.clientY >= r.top - 1 && e.clientY <= r.bottom + 1;
  };
  const hit = (e) => {
    const tab = e.target?.closest?.(".tabbrowser-tab");
    const button = tab?.querySelector(".jace-tab-close");
    if (!button || tab.pinned || !within(button, e)) return null;
    const style = win.getComputedStyle(button);
    if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) < 0.05) return null;
    return { tab, button };
  };
  let pressed = null;
  const swallow = (e) => {
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  win.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      const h = hit(e);
      if (!h) return;
      pressed = h;
      h.button.setAttribute("pressed", "true");
      swallow(e);
    },
    true,
  );
  win.addEventListener(
    "mouseup",
    (e) => {
      if (!pressed) return;
      const { tab, button } = pressed;
      pressed = null;
      button.removeAttribute("pressed");
      swallow(e);
      if (within(button, e) && !tab.closing && tab.isConnected) win.gBrowser.removeTab(tab, { animate: true });
    },
    true,
  );
  for (const type of ["click", "auxclick", "dblclick", "dragstart"]) {
    win.addEventListener(
      type,
      (e) => {
        if (hit(e)) swallow(e);
      },
      true,
    );
  }
}

function addCloseButtons(win) {
  watchCloseClicks(win);
  const gBrowser = win.gBrowser;
  if (!gBrowser) return;
  for (const tab of gBrowser.tabs) addCloseButton(tab);
  if (win.__jaceCloseHooked) return;
  win.__jaceCloseHooked = true;
  // New tabs (the event reaches the window whichever strip the tab is in),
  // and anything else that adds or rebuilds a tab.
  const sweep = () => {
    for (const tab of gBrowser.tabs) addCloseButton(tab);
  };
  win.addEventListener("TabOpen", (e) => addCloseButton(e.target), true);
  for (const type of ["TabSelect", "TabMove", "TabPinned", "TabUnpinned", "TabAttrModified"]) {
    win.addEventListener(type, () => win.setTimeout(sweep, 0), true);
  }
  const strip = gBrowser.tabContainer ?? win.document.getElementById("tabbrowser-tabs");
  if (strip) new win.MutationObserver(() => sweep()).observe(strip, { childList: true, subtree: true });
  win.setTimeout(sweep, 1000);
  win.setTimeout(sweep, 4000);
}

/**
 * Closing the last tab keeps the window open and shows your startup page
 * (Jace start page or your website), not an empty tab.
 */
function watchLastTab(win) {
  const gBrowser = win.gBrowser;
  if (!gBrowser || win.__jaceLastTabHooked) return;
  win.__jaceLastTabHooked = true;
  gBrowser.tabContainer.addEventListener("TabClose", (e) => {
    if (Services.prefs.getBoolPref("browser.tabs.closeWindowWithLastTab", false)) return;
    const others = [...gBrowser.tabs].filter((t) => t !== e.target && !t.closing);
    if (others.length) return;
    win.setTimeout(() => {
      const tab = gBrowser.tabs.length === 1 ? gBrowser.tabs[0] : null;
      if (!tab) return;
      let home = "about:home";
      try {
        home = win.HomePage?.get?.(win)?.split("|")[0] || Services.prefs.getStringPref("browser.startup.homepage", "about:home").split("|")[0];
      } catch {}
      const spec = tab.linkedBrowser.currentURI?.spec ?? "";
      if (spec !== home) tab.linkedBrowser.fixupAndLoadURIString(home, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    }, 0);
  });
}

function placeDownloads(win) {
  // After Firefox has moved its tab strip for the new layout (and drawn its sidebar).
  for (const ms of [0, 400, 1500, 4000]) {
    win.setTimeout(() => {
      try {
        lazy.JaceDownloadsButton.place(win);
      } catch (e) {
        console.error("Jace: downloads button", e);
      }
    }, ms);
  }
}

const THEME_VARS = ["--jace-surface", "--jace-surface-2", "--jace-text", "--jace-muted", "--jace-hover", "--jace-selected"];

/** The Jace theme's colors (JaceThemes), or the add-on theme's. */
function applyTheme(win) {
  const root = win.document.documentElement;
  const { JaceThemes } = lazy;
  root.toggleAttribute("jace-addon-theme", JaceThemes.addonThemeActive);
  root.setAttribute("jace-theme", JaceThemes.addonThemeActive ? "addon" : JaceThemes.id);
  const p = JaceThemes.palette();
  if (!p) {
    for (const v of THEME_VARS) root.style.removeProperty(v);
    root.removeAttribute("jace-theme-mode");
    return;
  }
  const dark = p.mode === "dark";
  root.setAttribute("jace-theme-mode", p.mode);
  root.style.setProperty("--jace-surface", p.bg);
  root.style.setProperty("--jace-surface-2", p.card);
  root.style.setProperty("--jace-text", p.fg);
  root.style.setProperty("--jace-muted", p.muted);
  root.style.setProperty("--jace-hover", `color-mix(in srgb, ${p.fg} ${dark ? 9 : 7}%, transparent)`);
  root.style.setProperty("--jace-selected", dark ? `color-mix(in srgb, ${p.fg} 12%, transparent)` : p.card);
}

function allWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => !w.closed && w.__jaceReady);
}

const prefObserver = {
  observe(_subject, _topic, pref) {
    if (pref === TAB_STYLE_PREF) applyTabStyleGlobally();
    for (const win of allWindows()) {
      applyLook(win);
      if (pref === TAB_STYLE_PREF) applyTabStyle(win);
      if (pref === VERTICAL_PREF) {
        const node = win.document.getElementById("jace-vertical-tabs-button");
        if (node) JaceWindow.updateVerticalTabsButton(node);
      }
      if (pref === VERTICAL_PREF || pref === "jace.tabs.downloadsButton") placeDownloads(win);
    }
  },
};
let observing = false;

export const JaceWindow = {
  /** Before the window is first drawn: the skin, and the startup animation on top. */
  early(win) {
    if (win.__jaceSkin) return;
    win.__jaceSkin = true;
    win.windowUtils.loadSheetUsingURIString(SKIN, win.windowUtils.AUTHOR_SHEET);
    applyLook(win);
    try {
      lazy.JaceAccountPanel.install(win);
    } catch (e) {
      console.error("Jace: account panel", e);
    }
    lazy.JaceSplash.maybeShow(win);
  },

  init(win) {
    if (win.__jaceReady) return;
    this.early(win);
    win.__jaceReady = true;
    try {
      addCloseButtons(win);
      watchLastTab(win);
      placeDownloads(win);
    } catch (e) {
      console.error("Jace: tab close buttons", e);
    }
    try {
      lazy.JaceQuickTab.install(win);
    } catch (e) {
      console.error("Jace: new tab box", e);
    }

    if (!observing) {
      observing = true;
      applyTabStyleGlobally();
      for (const pref of [...Object.keys(LOOK_PREFS), "jace.theme.accent", "jace.tabs.downloadsButton", TAB_STYLE_PREF, CONTROLS_PREF]) {
        Services.prefs.addObserver(pref, prefObserver);
      }
      lazy.JaceThemes.applyMode();
      lazy.JaceThemes.observe(() => {
        lazy.JaceThemes.applyMode();
        for (const w of allWindows()) applyTheme(w);
      });
      Services.obs.addObserver(() => this.refreshAccountButtons(), "jace-account-changed");
      Services.obs.addObserver(() => this.refreshAccountButtons(), "jace-sync-status");
    }

    applyTabStyle(win);

    win.addEventListener(
      "keydown",
      (event) => {
        const accel = Services.appinfo.OS === "Darwin" ? event.metaKey : event.ctrlKey;
        if (accel && event.altKey && !event.shiftKey && event.code === "KeyV") {
          event.preventDefault();
          event.stopPropagation();
          this.toggleVerticalTabs();
        }
      },
      true,
    );

    lazy.JaceUpdates.checkSoon(win);
  },

  toggleVerticalTabs() {
    const on = !Services.prefs.getBoolPref(VERTICAL_PREF, true);
    if (on) {
      // Vertical tabs need the new sidebar.
      Services.prefs.setBoolPref("sidebar.revamp", true);
    }
    Services.prefs.setBoolPref(VERTICAL_PREF, on);
  },

  updateVerticalTabsButton(node) {
    const on = Services.prefs.getBoolPref(VERTICAL_PREF, true);
    node.toggleAttribute("checked", on);
    node.setAttribute("tooltiptext", on ? "Turn off vertical tabs (Ctrl+Alt+V)" : "Turn on vertical tabs (Ctrl+Alt+V)");
  },

  refreshAccountButtons() {
    for (const win of allWindows()) {
      const node = win.document.getElementById("jace-account-button");
      if (node) this.updateAccountButton(node);
    }
  },

  updateAccountButton(node) {
    const profile = lazy.JaceAccount.profile;
    const status = lazy.JaceSync.status;
    node.toggleAttribute("signed-in", !!profile);
    node.setAttribute("sync-state", status.state ?? "idle");
    node.setAttribute("label", profile ? profile.name : "Sign in with Jace");
    node.setAttribute("tooltiptext", profile ? `Jace account: ${profile.name} (@${profile.username})` : "Sign in with Jace");
    if (profile?.picture && /^https:/.test(profile.picture)) {
      node.style.setProperty("list-style-image", `url("${profile.picture.replace(/"/g, "%22")}")`);
    } else {
      node.style.removeProperty("list-style-image");
    }
  },
};
