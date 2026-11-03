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
