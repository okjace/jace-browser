/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * One settings page: adds a "Jace" section at the top of the browser's own
 * settings (about:preferences) showing Jace Browser's settings
 * (settings/settings.html, embedded). Every "Jace settings" link opens
 * about:preferences#jace, and about:jace forwards there too.
 *
 * If a Firefox version changes its settings page so the section can't be
 * added, that page forwards to the stand-alone Jace settings instead.
 */

const SETTINGS_PAGE = "chrome://jace/content/settings/settings.html";
const WORKS_PREF = "jace.settings.inPreferences";

export const SETTINGS_URL = "about:preferences#jace";

function isSettingsDocument(doc) {
  return (
    doc?.nodePrincipal?.isSystemPrincipal &&
    /^about:(preferences|settings)/.test(doc.documentURI) &&
    doc.defaultView
  );
}

/**
 * Settings pages without the sidebar this file knows (Firefox keeps
 * redesigning it): put Jace's settings at the top of the page instead,
 * under a "Jace" heading, so they're always reachable from here.
 */
function injectAtTop(win) {
  const doc = win.document;
  if (doc.getElementById("jace-settings-section")) return true;
  // Above Firefox's own content area (it hides anything inside it that isn't
  // tagged with the current category).
  const firefoxPane = doc.getElementById("mainPrefPane");
  const container = firefoxPane?.parentNode ?? doc.querySelector("main, #main-content, .main-content") ?? doc.body;
  if (!container) return false;
  const section = doc.createElementNS("http://www.w3.org/1999/xhtml", "section");
  section.id = "jace-settings-section";
  const heading = doc.createElementNS("http://www.w3.org/1999/xhtml", "h1");
  heading.textContent = "Jace";
  heading.className = "jace-settings-heading";
  const params = new URLSearchParams(win.location.search);
  const hash = params.get("jace") ? `#${params.get("jace")}` : "";
  const frame = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
  frame.id = "jace-settings-frame";
  frame.setAttribute("src", `${SETTINGS_PAGE}?embedded=1${hash}`);
  section.append(heading, frame);
  if (firefoxPane) container.insertBefore(section, firefoxPane);
  else container.prepend(section);
  fitFrame(frame);
  if (/^#jace/.test(win.location.hash) || win.__jaceWantJace) section.scrollIntoView();
  return true;
}

function fitFrame(frame) {
  frame.addEventListener("load", () => {
    const fit = () => {
      const body = frame.contentDocument?.documentElement;
      if (body) frame.style.height = `${body.scrollHeight + 8}px`;
    };
    fit();
    new frame.contentWindow.ResizeObserver(fit).observe(frame.contentDocument.documentElement);
  });
}

/** Firefox's settings page as this file knows it: a "Jace" entry in its sidebar. */
const HTML = "http://www.w3.org/1999/xhtml";

/**
 * Firefox's own "Account" box (Mozilla accounts, which Jace Browser doesn't
 * use: "Account settings are unavailable") becomes a Jace account box.
 * Firefox draws its settings in stages, so keep looking for a few seconds.
 */
function replaceFirefoxAccountBox(win) {
  const doc = win.document;
  const tryReplace = () => {
    if (doc.getElementById("jace-account-box")) return true;
    const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 4 /* text */);
    let firefoxBox = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (/settings are unavailable|Mozilla account|Firefox account/i.test(node.nodeValue)) {
        firefoxBox = node.parentElement?.closest("setting-group, moz-fieldset, groupbox, section, .setting-group, vbox") ?? node.parentElement;
        break;
      }
    }
    if (!firefoxBox) return false;
    const box = jaceAccountBox(win);
    firefoxBox.before(box);
    firefoxBox.hidden = true;
    firefoxBox.style.display = "none";
    return true;
  };
  if (tryReplace()) return;
  const observer = new win.MutationObserver(() => {
    if (tryReplace()) observer.disconnect();
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  win.setTimeout(() => observer.disconnect(), 10000);
}

function jaceAccountBox(win) {
  const doc = win.document;
  const { JaceAccount } = ChromeUtils.importESModule("chrome://jace/content/JaceAccount.sys.mjs");
  const el = (tag, attrs = {}, text = null) => {
    const n = doc.createElementNS(HTML, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== null) n.textContent = text;
    return n;
  };
  const box = el("section", { id: "jace-account-box" });
  const render = () => {
    const profile = JaceAccount.profile;
    box.replaceChildren();
    const pic = el("img", { class: "jace-account-pic", alt: "" });
    pic.src = profile?.picture && /^https:/.test(profile.picture) ? profile.picture : "chrome://branding/content/icon64.png";
    const text = el("div", { class: "jace-account-text" });
    text.append(
      el("div", { class: "jace-account-title" }, profile ? profile.name : "Jace account"),
      el(
        "div",
        { class: "jace-account-sub" },
        profile ? `Signed in as @${profile.username}. Sync, profiles and more are in Jace below.` : "Sign in to sync your stuff and stay signed in to Jace sites.",
      ),
    );
    const actions = el("div", { class: "jace-account-actions" });
    const button = (label, primary, onclick) => {
      const b = el("button", { class: primary ? "primary" : "" }, label);
      b.addEventListener("click", onclick);
      actions.append(b);
    };
    if (profile) {
      button("Jace settings", true, () => (win.location.href = "about:preferences#jace"));
      button("Sign out", false, () => JaceAccount.signOut());
    } else {
      button("Sign in with Jace", true, () =>
        JaceAccount.signIn(win.browsingContext.topChromeWindow).catch((e) => {
          if (e?.code !== "cancelled") Services.prompt.alert(win, "Sign in with Jace", e.message);
        }),
      );
      button("Jace settings", false, () => (win.location.href = "about:preferences#jace"));
    }
    box.append(pic, text, actions);
  };
  render();
  const observer = { observe: render };
  Services.obs.addObserver(observer, "jace-account-changed");
  win.addEventListener("unload", () => Services.obs.removeObserver(observer, "jace-account-changed"));
  return box;
}

/** Jace's settings also at the top of the first settings page (General). */
function addToGeneral(win, mainPane) {
  const doc = win.document;
  if (doc.getElementById("jace-settings-general")) return;
  const frame = doc.createElementNS(HTML, "iframe");
  frame.id = "jace-settings-general";
  frame.className = "jace-settings-frame";
  frame.setAttribute("data-category", "paneGeneral");
  frame.setAttribute("src", `${SETTINGS_PAGE}?embedded=1`);
  mainPane.prepend(frame);
  fitFrame(frame);
}

/** The sidebar entry: a moz-page-nav button (Firefox 13x+) or an older richlistitem. */
function makeNavEntry(doc, categories) {
  if (categories.localName === "moz-page-nav") {
    const button = doc.createElement("moz-page-nav-button");
    button.id = "category-jace";
    button.setAttribute("view", "paneJace");
    button.setAttribute("iconsrc", "chrome://branding/content/icon32.png");
    button.setAttribute("title", "Jace account, sync, look, profiles, WebUSB, DRM, privacy");
    button.textContent = "Jace";
    return button;
  }
  const item = doc.createXULElement("richlistitem");
  item.id = "category-jace";
  item.className = "category";
  item.setAttribute("value", "paneJace");
  item.setAttribute("align", "center");
  item.setAttribute("tooltiptext", "Jace account, sync, look, profiles, WebUSB, DRM, privacy");
  const icon = doc.createXULElement("image");
  icon.className = "category-icon";
  const label = doc.createXULElement("label");
  label.className = "category-name";
  label.setAttribute("flex", "1");
  label.textContent = "Jace";
  item.append(icon, label);
  return item;
}

/** Firefox's settings page: a "Jace" entry at the top of its sidebar, with Jace's settings as its page. */
function inject(win, wantJace) {
  const doc = win.document;
  if (doc.getElementById("category-jace") || doc.getElementById("jace-settings-section")) return true;
  const categories = doc.getElementById("categories");
  const mainPane = doc.getElementById("mainPrefPane");
  if (!categories || !mainPane || typeof win.register_module !== "function" || typeof win.gotoPref !== "function") {
    return injectAtTop(win);
  }

  // The pane: Jace's settings page, embedded.
  const params = new URLSearchParams(win.location.search);
  const hash = params.get("jace") ? `#${params.get("jace")}` : "";
  const frame = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
  frame.id = "jace-settings-frame";
  frame.setAttribute("data-category", "paneJace");
  frame.setAttribute("hidden", "true");
  frame.setAttribute("src", `${SETTINGS_PAGE}?embedded=1${hash}`);
  mainPane.prepend(frame);
  win.register_module("paneJace", { init() {} });
  fitFrame(frame);
  addToGeneral(win, mainPane);

  try {
    const entry = makeNavEntry(doc, categories);
    categories.prepend(entry);
    if (categories.localName === "moz-page-nav") {
      // moz-page-nav reports clicks as "change-view"; Firefox only knows its own views.
      entry.addEventListener("click", () => win.gotoPref("paneJace"));
    }
  } catch (e) {
    console.error("Jace: couldn't add the sidebar entry; using the top of the page", e);
    frame.remove();
    return injectAtTop(win);
  }

  if (wantJace) {
    win.gotoPref("paneJace");
    win.history.replaceState(null, "", win.location.pathname + win.location.search + "#jace");
  }
  return true;
}

function onSettingsDocument(doc) {
  const win = doc.defaultView;
  // Remember the address now: Firefox replaces an unknown #jace with its own default.
  const wantJace = /^#jace/.test(win.location.hash);
  const run = () => {
    let ok = false;
    try {
      ok = inject(win, wantJace);
    } catch (e) {
      console.error("Jace: couldn't add Jace to settings, trying the top of the page", e);
      try {
        ok = injectAtTop(win);
      } catch (e2) {
        console.error("Jace: couldn't add Jace to settings", e2);
      }
    }
    Services.prefs.setBoolPref(WORKS_PREF, ok);
    try {
      replaceFirefoxAccountBox(win);
    } catch (e) {
      console.error("Jace: couldn't replace the account box", e);
    }
    if (!ok && wantJace) {
      // Couldn't add Jace to this page at all: show Jace's own page.
      win.location.replace(`${SETTINGS_PAGE}?standalone=1`);
    }
  };
  // Firefox builds its categories on load; add ours right after.
  if (doc.readyState === "complete") {
    run();
  } else {
    win.addEventListener("load", () => win.setTimeout(run, 0), { once: true });
  }
}

let started = false;

export const JaceSettingsPane = {
  SETTINGS_URL,

  start() {
    if (started) return;
    started = true;
    Services.obs.addObserver((subject) => {
      if (isSettingsDocument(subject)) onSettingsDocument(subject);
    }, "document-element-inserted");
  },

  /** The URL for Jace settings, with an optional section/notice ("sync", "signed-in"). */
  url(section = "") {
    return section ? `about:preferences?jace=${encodeURIComponent(section)}#jace` : SETTINGS_URL;
  },
};
