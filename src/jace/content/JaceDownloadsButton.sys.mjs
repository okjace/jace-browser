/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A Downloads button with the tabs: at the bottom of the vertical tabs
 * sidebar, or at the end of the tab strip when tabs are across the top.
 * It shows how many downloads are running and their progress.
 *
 * It's an icon; press it for your downloads as a list in a panel like the
 * site security panel. Each download: open it (click), show it in its
 * folder, cancel or retry.
 *
 * Off with jace.tabs.downloadsButton = false (Settings > Look).
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
});

const PREF = "jace.tabs.downloadsButton";
const ID = "jace-tabs-downloads";
const PANEL_ID = "jace-downloads-panel";
const HTML = "http://www.w3.org/1999/xhtml";
const SHOWN = 8;

/** Every download (newest first), shared by every window. */
const watchers = new Set();
let downloads = [];
let summary = { active: 0, progress: -1 };
let listening = false;

function notify() {
  let active = 0;
  let done = 0;
  let total = 0;
  for (const d of downloads) {
    if (d.stopped) continue;
    active++;
    if (d.hasProgress && d.totalBytes > 0) {
      done += d.currentBytes;
      total += d.totalBytes;
    }
  }
  summary = { active, progress: active && total ? Math.min(1, done / total) : -1 };
  for (const fn of watchers) fn();
}

async function listen() {
  if (listening) return;
  listening = true;
  const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
  const sort = () => downloads.sort((a, b) => (b.startTime?.getTime?.() ?? 0) - (a.startTime?.getTime?.() ?? 0));
  await list.addView({
    onDownloadAdded(d) {
      downloads.push(d);
      sort();
      notify();
    },
    onDownloadChanged() {
      notify();
    },
    onDownloadRemoved(d) {
      downloads = downloads.filter((x) => x !== d);
      notify();
    },
  });
}

// ------------------------------------------------------------ the list

function bytes(n) {
  if (!(n >= 0)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function fileName(d) {
  const path = d.target?.path ?? "";
  return path.split(/[\\/]/).pop() || d.source?.url || "Download";
}

function status(d) {
  if (d.succeeded) {
    const size = bytes(d.target?.size ?? d.totalBytes);
    let host = "";
    try {
      host = new URL(d.source.url).hostname.replace(/^www\./, "");
    } catch {}
    return [size, host].filter(Boolean).join(" · ");
  }
  if (d.error) return d.error.becauseBlocked ? "Blocked" : "Failed";
  if (d.canceled) return "Canceled";
  if (d.hasProgress && d.totalBytes) {
    const rate = d.speed > 0 ? ` · ${bytes(d.speed)}/s` : "";
    return `${d.progress}% · ${bytes(d.currentBytes)} of ${bytes(d.totalBytes)}${rate}`;
  }
  return `${bytes(d.currentBytes)}…`;
}

function el(doc, tag, attrs = {}, text = null) {
  const n = doc.createElementNS(HTML, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== null) n.textContent = text;
  return n;
}

function iconButton(doc, kind, title, onClick) {
  const b = el(doc, "button", { class: `jace-dl-action jace-dl-${kind}`, title, "aria-label": title });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Fills `box` with the downloads list (and keeps it current while it's on screen). */
function fillList(win, box, onDone) {
  const doc = win.document;
  const render = () => {
    box.replaceChildren();
    const header = el(doc, "div", { class: "jace-dl-header" });
    header.append(el(doc, "h1", { class: "jace-dl-title" }, "Downloads"));
    box.append(header, doc.createXULElement("toolbarseparator"));
    const list = el(doc, "div", { class: "jace-dl-items", role: "list" });
    if (!downloads.length) list.append(el(doc, "div", { class: "jace-dl-empty" }, "No downloads yet"));
    for (const d of downloads.slice(0, SHOWN)) {
      const row = el(doc, "div", { class: "jace-dl-item", role: "listitem" });
      row.toggleAttribute("active", !d.stopped);
      row.toggleAttribute("failed", !!d.error || d.canceled);
      if (d.succeeded) row.title = `Open ${fileName(d)}`;
      const icon = el(doc, "img", { class: "jace-dl-icon", alt: "" });
      icon.src = `moz-icon://${encodeURIComponent(fileName(d))}?size=16`;
      const text = el(doc, "div", { class: "jace-dl-text" });
      text.append(el(doc, "span", { class: "jace-dl-name" }, fileName(d)), el(doc, "span", { class: "jace-dl-status" }, status(d)));
      if (!d.stopped) {
        const bar = el(doc, "span", { class: "jace-dl-bar" });
        bar.style.setProperty("--p", d.hasProgress ? String(d.progress / 100) : "0.3");
        text.append(bar);
      }
      row.append(icon, text);
      if (!d.stopped) {
        row.append(iconButton(doc, "cancel", "Cancel", () => d.cancel().catch(() => {})));
      } else if (d.error || d.canceled) {
        row.append(iconButton(doc, "retry", "Try again", () => d.start().catch(() => {})));
      } else if (d.succeeded) {
        row.append(iconButton(doc, "folder", "Show in folder", () => d.showContainingDirectory().catch(() => {})));
      }
      row.addEventListener("click", () => {
        if (!d.succeeded) return;
        d.launch().catch((e) => console.warn("Jace: open download", e));
        onDone?.();
      });
      list.append(row);
    }
    box.append(list, doc.createXULElement("toolbarseparator"));
    const all = doc.createXULElement("toolbarbutton");
    all.className = "subviewbutton jace-dl-all";
    all.setAttribute("label", "Show all downloads");
    all.addEventListener("command", () => {
      onDone?.();
      win.switchToTabHavingURI("about:downloads", true);
    });
    box.append(all);
  };
  render();
  // Keep it current (progress) while shown; a little throttled.
  let pending = false;
  const update = () => {
    if (!box.isConnected || pending) return;
    pending = true;
    win.setTimeout(() => {
      pending = false;
      if (box.isConnected) render();
    }, 250);
  };
  watchers.add(update);
  return () => watchers.delete(update);
}

// ------------------------------------------------------------ showing it

/** The list in a panel from the icon, like the site security panel. */
function togglePanel(win, button) {
  const doc = win.document;
  let panel = doc.getElementById(PANEL_ID);
  if (!panel) {
    panel = doc.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("class", "panel-no-padding");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Downloads");
    panel.append(el(doc, "div", { class: "jace-dl-box" }));
    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);
    panel.addEventListener("popuphidden", () => {
      panel.__stop?.();
      panel.__stop = null;
      doc.getElementById(ID)?.removeAttribute("open");
    });
  }
  if (panel.state === "open" || panel.state === "showing") {
    panel.hidePopup();
    return;
  }
  panel.__stop?.();
  panel.__stop = fillList(win, panel.firstChild, () => panel.hidePopup());
  button.setAttribute("open", "true");
  const vertical = button.hasAttribute("vertical");
  panel.openPopup(button, vertical ? "end_after" : "bottomright topright");
}

function openDownloads(win, button) {
  try {
    togglePanel(win, button);
  } catch (e) {
    console.error("Jace: downloads list", e);
    win.switchToTabHavingURI("about:downloads", true);
  }
}

// ------------------------------------------------------------ the button

function make(win) {
  const doc = win.document;
  const button = doc.createXULElement("toolbarbutton");
  button.id = ID;
  // Not "toolbarbutton-1": Firefox paints that kind gray on hover. Jace styles it.
  button.className = "jace-tabs-downloads";
  button.setAttribute("label", "Downloads"); // for screen readers; only the icon shows
  button.setAttribute("tooltiptext", "Downloads");
  const bar = doc.createElementNS(HTML, "span");
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
      const strip = doc.getElementById("TabsToolbar-customization-target");
      if (strip && button.previousSibling !== strip) strip.after(button);
    }
    button.toggleAttribute("vertical", vertical);
  },
};
