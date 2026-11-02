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

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI: "resource:///modules/CustomizableUI.sys.mjs",
  JaceAccount: "chrome://jace/content/JaceAccount.sys.mjs",
  JaceSplash: "chrome://jace/content/JaceSplash.sys.mjs",
  JaceSync: "chrome://jace/content/sync/JaceSync.sys.mjs",
  JaceUpdates: "chrome://jace/content/JaceUpdates.sys.mjs",
});

const SKIN = "chrome://jace/skin/jace.css";
const VERTICAL_PREF = "sidebar.verticalTabs";
const LOOK_PREFS = {
  "sidebar.verticalTabs": "jace-vertical-tabs",
  "jace.theme.compact": "jace-compact",
  "jace.theme.floatingContent": "jace-floating",
};
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

function applyLook(win) {
  const root = win.document.documentElement;
  for (const [pref, attr] of Object.entries(LOOK_PREFS)) {
    root.toggleAttribute(attr, Services.prefs.getBoolPref(pref, false));
  }
  const accent = Services.prefs.getStringPref("jace.theme.accent", "#3ddc84");
  if (/^#[0-9a-f]{3,8}$/i.test(accent)) {
    root.style.setProperty("--jace-accent", accent);
  }
}

function allWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => !w.closed && w.__jaceReady);
}

const prefObserver = {
  observe(_subject, _topic, pref) {
    for (const win of allWindows()) {
      applyLook(win);
      if (pref === VERTICAL_PREF) {
        const node = win.document.getElementById("jace-vertical-tabs-button");
        if (node) JaceWindow.updateVerticalTabsButton(node);
      }
    }
  },
};
let observing = false;

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createXULElement ? doc.createXULElement(tag) : doc.createElementNS(XUL_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function html(doc, tag, attrs = {}, children = []) {
  const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function timeAgo(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export const JaceWindow = {
  /** Before the window is first drawn: the skin, and the startup animation on top. */
  early(win) {
    if (win.__jaceSkin) return;
    win.__jaceSkin = true;
    win.windowUtils.loadSheetUsingURIString(SKIN, win.windowUtils.AUTHOR_SHEET);
    applyLook(win);
    lazy.JaceSplash.maybeShow(win);
  },

  init(win) {
    if (win.__jaceReady) return;
    this.early(win);
    win.__jaceReady = true;

    if (!observing) {
      observing = true;
      for (const pref of [...Object.keys(LOOK_PREFS), "jace.theme.accent"]) {
        Services.prefs.addObserver(pref, prefObserver);
      }
      Services.obs.addObserver(() => this.refreshAccountButtons(), "jace-account-changed");
      Services.obs.addObserver(() => this.refreshAccountButtons(), "jace-sync-status");
    }

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

  async openAccountPanel(win, anchor) {
    const doc = win.document;
    let panel = doc.getElementById("jace-account-panel");
    if (!panel) {
      panel = el(doc, "panel", {
        id: "jace-account-panel",
        type: "arrow",
        role: "dialog",
        noautofocus: "true",
      });
      doc.getElementById("mainPopupSet").append(panel);
    }
    panel.replaceChildren(await this._panelBody(win, panel));
    panel.openPopup(anchor, "bottomright topright", 0, 0, false, false);
  },

  async _panelBody(win, panel) {
    const doc = win.document;
    const { JaceAccount, JaceSync } = lazy;
    const profile = JaceAccount.profile;
    const box = html(doc, "div", { class: "jace-panel" });
    const close = () => panel.hidePopup();
    const button = (label, onclick, cls = "") => {
      const b = html(doc, "button", { class: `jace-panel-button ${cls}`, text: label });
      b.addEventListener("click", onclick);
      return b;
    };
    const openSettings = (hash = "") => {
      close();
      win.switchToTabHavingURI(`about:jace${hash}`, true, { ignoreFragment: "whenComparingAndReplace" });
    };

    if (!profile) {
      box.append(
        html(doc, "div", { class: "jace-panel-title", text: "Jace account" }),
        html(doc, "p", {
          class: "jace-panel-text",
          text: "Sign in to sync your bookmarks, passwords, history, tabs, and the sites you're signed in to across every Jace Browser.",
        }),
        button(
          JaceAccount.signingIn ? "Finish signing in…" : "Sign in with Jace",
          () => {
            close();
            JaceAccount.signIn(win).catch((e) => console.warn("Jace sign-in:", e.message));
          },
          "primary",
        ),
      );
      return box;
    }

    const head = html(doc, "div", { class: "jace-panel-profile" });
    if (profile.picture && /^https:/.test(profile.picture)) {
      head.append(html(doc, "img", { class: "jace-avatar", src: profile.picture, alt: "" }));
    }
    head.append(
      html(doc, "div", {}, [
        html(doc, "div", { class: "jace-panel-name", text: profile.name }),
        html(doc, "div", { class: "jace-panel-handle", text: `@${profile.username}` }),
      ]),
    );
    box.append(head);

    const status = JaceSync.status;
    let line;
    switch (status.state) {
      case "needs-passphrase":
        line = "Sync needs your sync passphrase.";
        break;
      case "syncing":
        line = "Syncing…";
        break;
      case "error":
        line = `Sync problem: ${status.error ?? "unknown"}`;
        break;
      case "off":
        line = "Sync is off.";
        break;
      default:
        line = `Synced ${timeAgo(status.lastSync)}`;
    }
    box.append(html(doc, "p", { class: "jace-panel-text", text: line }));

    if (status.state === "needs-passphrase") {
      box.append(button("Set up sync", () => openSettings("#sync"), "primary"));
    } else {
      box.append(
        button("Sync now", async (e) => {
          e.target.disabled = true;
          await JaceSync.syncNow().catch(() => {});
          panel.replaceChildren(await this._panelBody(win, panel));
        }),
      );
    }

    const devices = await JaceSync.remoteTabs().catch(() => []);
    for (const device of devices.slice(0, 3)) {
      if (!device.tabs?.length) continue;
      box.append(html(doc, "div", { class: "jace-panel-section", text: `Tabs on ${device.device}` }));
      for (const tab of device.tabs.slice(0, 6)) {
        const link = html(doc, "button", { class: "jace-panel-link", text: tab.title || tab.url, title: tab.url });
        link.addEventListener("click", () => {
          close();
          win.openTrustedLinkIn(tab.url, "tab");
        });
        box.append(link);
      }
    }

    box.append(html(doc, "hr"), button("Jace settings", () => openSettings()));
    return box;
  },
};
