/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The account button's panel, built like the browser's own panels (a
 * <panelview> shown by the toolbar button, so it opens, animates and looks
 * like the site security panel):
 *
 *   signed in:  picture, name, @username, sync status + Sync now, tabs on
 *               your other devices, Switch profile, Jace settings, Sign out
 *   signed out: Sign in with Jace, Switch profile, Jace settings
 *
 * "Switch profile" opens a second view listing the browser profiles
 * (JaceProfiles): pick one to open it in its own window, or make a new one.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JaceAccount: "chrome://jace/content/JaceAccount.sys.mjs",
  JaceProfiles: "chrome://jace/content/JaceProfiles.sys.mjs",
  JaceSettingsPane: "chrome://jace/content/JaceSettingsPane.sys.mjs",
  JaceSync: "chrome://jace/content/sync/JaceSync.sys.mjs",
});

export const ACCOUNT_VIEW = "PanelUI-jace-account";
export const PROFILES_VIEW = "PanelUI-jace-profiles";
const HTML_NS = "http://www.w3.org/1999/xhtml";

function timeAgo(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function xul(doc, tag, attrs = {}) {
  const node = doc.createXULElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function html(doc, tag, attrs = {}, text = null) {
  const node = doc.createElementNS(HTML_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== null) node.textContent = text;
  return node;
}

/** A standard panel row (like the ones in the app menu). */
function row(doc, label, onCommand, { nav = false, icon = null } = {}) {
  const b = xul(doc, "toolbarbutton", {
    class: `subviewbutton${nav ? " subviewbutton-nav" : ""}${icon ? " subviewbutton-iconic" : ""}`,
    label,
  });
  if (nav) b.setAttribute("closemenu", "none");
  if (icon) b.setAttribute("image", icon);
  b.addEventListener("command", onCommand);
  return b;
}

function closePanel(view) {
  const panel = view.closest("panel");
  if (!panel) return;
  const win = view.ownerGlobal;
  if (win.PanelMultiView?.hidePopup) win.PanelMultiView.hidePopup(panel);
  else panel.hidePopup?.();
}

function makeView(doc, id, title) {
  const view = xul(doc, "panelview", { id, class: "PanelUI-subView jace-panelview", title });
  view.append(xul(doc, "vbox", { class: "panel-subview-body" }));
  return view;
}

export const JaceAccountPanel = {
  /** Adds the two panel views to a window (once), where the toolbar can find them. */
  install(win) {
    const doc = win.document;
    if (doc.getElementById(ACCOUNT_VIEW)) return;
    const cache = doc.getElementById("appMenu-viewCache");
    const parent = cache?.content ?? cache ?? doc.getElementById("mainPopupSet");
    if (!parent) return;
    parent.append(makeView(doc, ACCOUNT_VIEW, "Jace account"), makeView(doc, PROFILES_VIEW, "Switch profile"));
    // Fill the profiles list whenever it's shown (the panel copies views
    // out of the cache when they're first used).
    win.addEventListener(
      "ViewShowing",
      (e) => {
        if (e.target.id === PROFILES_VIEW) this.fillProfilesView(e.target);
      },
      true,
    );
  },

  /** Called by the account button's widget (onViewShowing) every time the panel opens. */
  async fillAccountView(view) {
    const doc = view.ownerDocument;
    const win = doc.defaultView;
    const body = view.querySelector(".panel-subview-body");
    body.replaceChildren();
    const { JaceAccount, JaceSync, JaceSettingsPane } = lazy;
    const profile = JaceAccount.profile;
    const openSettings = (section) => {
      closePanel(view);
      win.switchToTabHavingURI(JaceSettingsPane.url(section), true, {
        ignoreFragment: "whenComparingAndReplace",
        ignoreQueryString: true,
      });
    };

    // Header, like the site security panel's: who you are, and the state.
    const header = html(doc, "div", { class: "jace-account-header" });
    if (profile) {
      const pic = html(doc, "img", { class: "jace-account-avatar", alt: "" });
      if (profile.picture && /^https:/.test(profile.picture)) pic.src = profile.picture;
      else pic.src = "chrome://branding/content/icon64.png";
      const text = html(doc, "div", { class: "jace-account-who" });
      text.append(html(doc, "div", { class: "jace-account-name" }, profile.name), html(doc, "div", { class: "jace-account-handle" }, `@${profile.username}`));
      header.append(pic, text);
    } else {
      const pic = html(doc, "img", { class: "jace-account-avatar", alt: "", src: "chrome://branding/content/icon64.png" });
      const text = html(doc, "div", { class: "jace-account-who" });
      text.append(
        html(doc, "div", { class: "jace-account-name" }, "Not signed in"),
        html(doc, "div", { class: "jace-account-handle" }, "Sign in to sync your stuff and stay signed in to Jace sites."),
      );
      header.append(pic, text);
    }
    body.append(header);

    if (!profile) {
      const signIn = row(doc, JaceAccount.signingIn ? "Finish signing in…" : "Sign in with Jace", () => {
        closePanel(view);
        JaceAccount.signIn(win).catch((e) => {
          if (e?.code === "cancelled") return;
          console.error("Jace sign-in:", e);
          Services.prompt.alert(win, "Sign in with Jace", `Signing in didn't work: ${e?.message ?? e}`);
        });
      });
      signIn.classList.add("jace-account-primary");
      body.append(signIn);
    } else {
      // Sync status line + action
      const status = JaceSync.status;
      const keyed = await JaceSync.hasKey().catch(() => false);
      let line;
      if (!keyed) line = "Sync isn't set up on this device.";
      else if (status.state === "syncing") line = "Syncing…";
      else if (status.state === "error") line = `Sync problem: ${status.error ?? "unknown"}`;
      else line = `Synced ${timeAgo(status.lastSync)}`;
      body.append(html(doc, "div", { class: "jace-account-status", "data-state": keyed ? (status.state ?? "idle") : "needs-passphrase" }, line));
      if (keyed) {
        body.append(
          row(doc, "Sync now", async () => {
            await JaceSync.syncNow().catch(() => {});
            this.fillAccountView(view);
          }),
        );
      } else {
        body.append(row(doc, "Set up sync…", () => openSettings("sync")));
      }

      // Tabs from other devices (up to 5)
      const devices = await JaceSync.remoteTabs().catch(() => []);
      const tabs = devices.flatMap((d) => (d.tabs ?? []).slice(0, 3).map((t) => ({ ...t, device: d.device }))).slice(0, 5);
      if (tabs.length) {
        body.append(xul(doc, "toolbarseparator"), html(doc, "div", { class: "jace-account-section" }, "On your other devices"));
        for (const t of tabs) {
          const b = row(doc, t.title || t.url, () => {
            closePanel(view);
            win.openTrustedLinkIn(t.url, "tab");
          });
          b.setAttribute("tooltiptext", `${t.url}\n${t.device}`);
          body.append(b);
        }
      }
    }

    body.append(
      xul(doc, "toolbarseparator"),
      row(doc, `Switch profile${lazy.JaceProfiles.currentName ? ` (${lazy.JaceProfiles.currentName})` : ""}`, (e) => {
        const multi = view.closest("panelmultiview");
        if (multi && win.PanelMultiView?.forNode) {
          win.PanelMultiView.forNode(multi).showSubView(PROFILES_VIEW, e.target);
        } else {
          win.PanelUI?.showSubView(PROFILES_VIEW, e.target);
        }
      }, { nav: true }),
      row(doc, "Jace settings", () => openSettings()),
    );
    if (profile) {
      body.append(
        row(doc, "Sign out", () => {
          closePanel(view);
          JaceAccount.signOut();
        }),
      );
    }
  },

  /** The profiles view: every browser profile; pick one to open it in its own window. */
  fillProfilesView(view) {
    const doc = view.ownerDocument;
    const win = doc.defaultView;
    const body = view.querySelector(".panel-subview-body");
    body.replaceChildren();
    const { JaceProfiles } = lazy;
    let list = [];
    try {
      list = JaceProfiles.list();
    } catch (e) {
      console.warn("Jace: couldn't list profiles", e);
    }
    if (!list.length) {
      body.append(html(doc, "div", { class: "jace-account-status" }, "This window isn't using a named profile."));
    }
    for (const p of list) {
      const b = row(doc, p.name, () => {
        if (p.current) return;
        try {
          JaceProfiles.open(p.name);
          closePanel(view);
        } catch (e) {
          Services.prompt.alert(win, "Switch profile", e.message);
        }
      });
      b.classList.add("jace-profile-row");
      if (p.current) {
        b.setAttribute("checked", "true");
        b.setAttribute("type", "checkbox");
        b.setAttribute("label", `${p.name} (this window)`);
      } else if (p.running) {
        b.setAttribute("label", `${p.name} (open)`);
      }
      b.style.setProperty("--jace-profile-color", p.color);
      body.append(b);
    }
    body.append(
      xul(doc, "toolbarseparator"),
      row(doc, "New profile…", async () => {
        const name = { value: "" };
        if (!Services.prompt.prompt(win, "New profile", "Name for the new profile (e.g. Work, School):", name, null, {})) return;
        try {
          await JaceProfiles.create(name.value);
          closePanel(view);
        } catch (e) {
          Services.prompt.alert(win, "New profile", e.message);
        }
      }),
      row(doc, "Manage profiles", () => {
        closePanel(view);
        win.switchToTabHavingURI("about:profiles", true);
      }),
    );
  },
};
