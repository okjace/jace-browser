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
  track(win, button);
  return button;
}

const TOOL_ID = "jace-sidebar-downloads-tool";

/** Keeps a button's look (badge, progress, tooltip) in step with the downloads. */
function track(win, node) {
  const update = () => {
    const { active, progress } = summary;
    node.toggleAttribute("downloading", active > 0);
    if (active) node.setAttribute("badge", String(active));
    else node.removeAttribute("badge");
    const tip = active ? `Downloads (${active} in progress${progress >= 0 ? `, ${Math.round(progress * 100)}%` : ""})` : "Downloads";
    node.setAttribute(node.localName === "toolbarbutton" ? "tooltiptext" : "title", tip);
    node.toggleAttribute("indeterminate", active > 0 && progress < 0);
    node.style.setProperty("--jace-dl-progress", progress >= 0 ? String(progress) : "0");
  };
  watchers.add(update);
  win.addEventListener("unload", () => watchers.delete(update));
  update();
  listen().catch((e) => console.warn("Jace: downloads button", e));
}

/** Styles for the button inside the sidebar's own (shadow) part. */
const TOOL_CSS = `
/* No resize handle inside the sidebar either (the tab style sets its width). */
:is(.splitter, .resizer, .sidebar-splitter, [id$="splitter"]) {
  display: none !important;
}
.wrapper, :host { border-inline-end-color: transparent !important; }
#${TOOL_ID} { position: relative; }
#${TOOL_ID}[downloading]::part(button) { color: var(--jace-accent, AccentColor); }
#${TOOL_ID}[badge]::after {
  content: attr(badge);
  position: absolute; top: 0; inset-inline-end: 0;
  min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box;
  border-radius: 7px; background: var(--jace-accent, AccentColor); color: #0c1410;
  font-size: 9.5px; font-weight: 700; line-height: 14px; text-align: center; pointer-events: none;
}
#${TOOL_ID}[downloading]::before {
  content: ""; position: absolute; left: 6px; right: 6px; bottom: 1px; height: 2px; border-radius: 1px;
  background: linear-gradient(var(--jace-accent, AccentColor), var(--jace-accent, AccentColor)) 0 0 / calc(var(--jace-dl-progress, 0) * 100%) 100% no-repeat,
    color-mix(in srgb, var(--jace-accent, AccentColor) 25%, transparent);
  pointer-events: none;
}
`;

/**
 * The sidebar's bottom row of icons (bookmarks, history, passwords,
 * settings) lives inside <sidebar-main>'s shadow DOM. Adds a Downloads icon
 * there, made the same way as Firefox's own (a moz-button), so it matches.
 */
function addSidebarTool(win) {
  const main = win.document.querySelector("sidebar-main");
  const root = main?.shadowRoot;
  if (!root) return null;
  let tool = root.getElementById(TOOL_ID);
  if (tool) return tool;
  // The row: the group holding the tool buttons (falls back to the bottom actions).
  const firstTool = root.querySelector(".tools-and-extensions moz-button, .actions-list moz-button, button-group moz-button");
  const row = firstTool?.parentNode ?? root.querySelector(".tools-and-extensions, .bottom-actions, button-group");
  if (!row) return null;
  const doc = win.document;
  tool = doc.createElement("moz-button");
  tool.id = TOOL_ID;
  tool.setAttribute("type", "icon ghost");
  tool.setAttribute("iconsrc", "chrome://jace/skin/icons/downloads.svg");
  tool.setAttribute("title", "Downloads");
  tool.setAttribute("aria-label", "Downloads");
  // Copy the look/size Firefox gives its own tool buttons.
  for (const attr of ["size", "class", "view"]) {
    if (firstTool?.hasAttribute(attr) && attr !== "view") tool.setAttribute(attr, firstTool.getAttribute(attr));
  }
  tool.addEventListener("click", (e) => {
    e.stopPropagation();
    openDownloads(win, tool);
  });
  // Before Firefox's own buttons (outside the part its renderer manages).
  if (firstTool) row.insertBefore(tool, row.firstChild);
  else row.append(tool);
  if (!root.getElementById("jace-sidebar-tool-style")) {
    const style = doc.createElementNS(HTML, "style");
    style.id = "jace-sidebar-tool-style";
    style.textContent = TOOL_CSS;
    root.append(style);
  }
  track(win, tool);
  // If the sidebar redraws its row, put it back.
  if (!main.__jaceToolObserver) {
    main.__jaceToolObserver = new win.MutationObserver(() => {
      if (Services.prefs.getBoolPref(PREF, true) && Services.prefs.getBoolPref("sidebar.verticalTabs", false) && !root.getElementById(TOOL_ID)) {
        win.setTimeout(() => addSidebarTool(win), 0);
      }
    });
    main.__jaceToolObserver.observe(root, { childList: true, subtree: true });
  }
  return tool;
}

export const JaceDownloadsButton = {
  /**
   * Vertical tabs: a Downloads icon in the sidebar's bottom row of icons.
   * Tabs across the top: at the end of the tab strip.
   */
  place(win) {
    const doc = win.document;
    let button = doc.getElementById(ID);
    const tool = doc.querySelector("sidebar-main")?.shadowRoot?.getElementById(TOOL_ID);
    if (!Services.prefs.getBoolPref(PREF, true)) {
      button?.remove();
      tool?.remove();
      return;
    }
    const vertical = Services.prefs.getBoolPref("sidebar.verticalTabs", false);
    if (vertical) {
      let added = null;
      try {
        added = addSidebarTool(win);
      } catch (e) {
        console.error("Jace: downloads icon in the sidebar", e);
      }
      // Not found yet: Jace tries again shortly. (Never inside the vertical
      // tabs area itself: Firefox's toolbar manager owns it, and a button it
      // doesn't know there breaks moving the tabs back to the top.)
      button?.remove();
      void added;
      return;
    } else {
      tool?.remove();
      button ??= make(win);
      // End of the tab strip, outside the part the toolbar editor manages
      // (several places to try: Firefox reshuffles this toolbar now and then).
      const strip = doc.getElementById("TabsToolbar-customization-target");
      const tabs = doc.getElementById("tabbrowser-tabs");
      const items = doc.querySelector("#TabsToolbar .toolbar-items");
      const toolbar = doc.getElementById("TabsToolbar");
      if (strip?.parentNode) {
        if (button.previousSibling !== strip) strip.after(button);
      } else if (items) {
        if (button.parentNode !== items) items.append(button);
      } else if (tabs?.parentNode) {
        if (button.previousSibling !== tabs) tabs.after(button);
      } else if (toolbar && button.parentNode !== toolbar) {
        toolbar.append(button);
      }
    }
    button.toggleAttribute("vertical", vertical);
  },

  /** Where the Downloads icon is (for the self-test). */
  find(win) {
    return win.document.querySelector("sidebar-main")?.shadowRoot?.getElementById(TOOL_ID) ?? win.document.getElementById(ID);
  },
};
