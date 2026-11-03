/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A Downloads button with the tabs: at the bottom of the vertical tabs
 * sidebar, or at the end of the tab strip when tabs are across the top.
 * Shows how many downloads are running and their progress; click for the
 * downloads panel (or the Downloads page).
 *
 * Off with jace.tabs.downloadsButton = false (Settings > Look).
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
});

const PREF = "jace.tabs.downloadsButton";
const ID = "jace-tabs-downloads";

/** Download progress, shared by every window. */
const watchers = new Set();
let summary = { active: 0, progress: -1 };
let listening = false;

async function listen() {
  if (listening) return;
  listening = true;
  const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
  const all = new Set();
  const recompute = () => {
    let active = 0;
    let done = 0;
    let total = 0;
    for (const d of all) {
      if (d.stopped) continue;
      active++;
      if (d.hasProgress && d.totalBytes > 0) {
        done += d.currentBytes;
        total += d.totalBytes;
      }
    }
    summary = { active, progress: active && total ? Math.min(1, done / total) : -1 };
    for (const fn of watchers) fn();
  };
  await list.addView({
    onDownloadAdded(d) {
      all.add(d);
      recompute();
    },
    onDownloadChanged() {
      recompute();
    },
    onDownloadRemoved(d) {
      all.delete(d);
      recompute();
    },
  });
}

function make(win) {
  const doc = win.document;
  const button = doc.createXULElement("toolbarbutton");
  button.id = ID;
  button.className = "toolbarbutton-1 jace-tabs-downloads";
  button.setAttribute("label", "Downloads");
  button.setAttribute("tooltiptext", "Downloads");
  const bar = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  bar.className = "jace-downloads-progress";
  button.append(bar);
  button.addEventListener("command", () => openDownloads(win, button));
  const update = () => {
    const { active, progress } = summary;
    button.toggleAttribute("downloading", active > 0);
    if (active) button.setAttribute("badge", String(active));
    else button.removeAttribute("badge");
    button.setAttribute("tooltiptext", active ? `Downloads (${active} in progress${progress >= 0 ? `, ${Math.round(progress * 100)}%` : ""})` : "Downloads");
    button.style.setProperty("--jace-dl-progress", progress >= 0 ? String(progress) : "0");
    button.toggleAttribute("indeterminate", active > 0 && progress < 0);
  };
  watchers.add(update);
  win.addEventListener("unload", () => watchers.delete(update));
  update();
  listen().catch((e) => console.warn("Jace: downloads button", e));
  return button;
}

/** The downloads panel, anchored to the toolbar; the Downloads page if there's no panel. */
function openDownloads(win, button) {
  try {
    if (win.DownloadsPanel?.showPanel) {
      win.DownloadsPanel.showPanel(true, false);
      win.setTimeout(() => {
        if (!win.DownloadsPanel.isPanelShowing) showPage(win);
      }, 500);
      return;
    }
  } catch (e) {
    console.warn("Jace: downloads panel", e);
  }
  showPage(win);
}

function showPage(win) {
  win.switchToTabHavingURI("about:downloads", true);
}

export const JaceDownloadsButton = {
  /** Puts the button where the tabs are (or removes it when turned off). */
  place(win) {
    const doc = win.document;
    let button = doc.getElementById(ID);
    if (!Services.prefs.getBoolPref(PREF, true)) {
      button?.remove();
      return;
    }
    button ??= make(win);
    const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", false);
    if (vertical) {
      // Bottom of the sidebar's tab area, under the (scrolling) tabs.
      const target = doc.getElementById("vertical-tabs");
      if (target && button.parentNode !== target) target.append(button);
    } else {
      // End of the tab strip, outside the part the toolbar editor manages.
      const items = doc.querySelector("#TabsToolbar .toolbar-items");
      const strip = doc.getElementById("TabsToolbar-customization-target");
      if (items && strip && button.previousSibling !== strip) strip.after(button);
    }
    button.toggleAttribute("vertical", vertical);
  },
};
