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

function inject(win) {
  const doc = win.document;
  if (doc.getElementById("category-jace")) return true;
  const categories = doc.getElementById("categories");
  const mainPane = doc.getElementById("mainPrefPane");
  if (!categories || !mainPane || typeof win.register_module !== "function" || typeof win.gotoPref !== "function") {
    return false;
  }

  // Sidebar entry, first in the list.
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
  categories.prepend(item);

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
  // Keep the frame as tall as its content so the page scrolls as one.
  frame.addEventListener("load", () => {
    const fit = () => {
      const body = frame.contentDocument?.documentElement;
      if (body) frame.style.height = `${body.scrollHeight + 8}px`;
    };
    fit();
    new frame.contentWindow.ResizeObserver(fit).observe(frame.contentDocument.documentElement);
  });

  if (/^#jace/.test(win.location.hash)) {
    win.gotoPref("paneJace");
  }
  return true;
}

function onSettingsDocument(doc) {
  const win = doc.defaultView;
  const run = () => {
    let ok = false;
    try {
      ok = inject(win);
    } catch (e) {
      console.error("Jace: couldn't add the Jace section to settings", e);
    }
    Services.prefs.setBoolPref(WORKS_PREF, ok);
    if (!ok && /^#jace/.test(win.location.hash)) {
      // This Firefox's settings page is different: show Jace's own page.
      win.location.replace(SETTINGS_PAGE + win.location.hash.replace(/^#jace/, ""));
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
    if (!Services.prefs.getBoolPref(WORKS_PREF, true)) {
      return SETTINGS_PAGE + (section ? `#${section}` : "");
    }
    return section ? `about:preferences?jace=${encodeURIComponent(section)}#jace` : SETTINGS_URL;
  },
};
