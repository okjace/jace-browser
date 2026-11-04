/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * One settings page: Jace Browser's settings (settings/settings.html,
 * embedded) are shown inside the browser's own settings categories:
 * account and sync in Sync, look/profiles/DRM in General, privacy and
 * WebUSB in Privacy, version and updates in About. Every "Jace settings"
 * link opens about:preferences#jace (?jace=<section> picks the category),
 * and about:jace forwards there too.
 *
 * If a Firefox version changes its settings page so this can't be done,
 * the settings go at the top of the page, or the stand-alone page opens.
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

const HTML = "http://www.w3.org/1999/xhtml";

/**
 * Firefox's own "Account" box (Mozilla accounts, which Jace Browser doesn't
 * use: "Account settings are unavailable") becomes a Jace account box.
 * Firefox draws its settings in stages, so keep looking for a few seconds.
 */
function replaceFirefoxAccountBox(win) {
  const doc = win.document;
  const tryReplace = () => {
    if (doc.getElementById("jace-account-box") || doc.querySelector("[jace-hidden='mozilla-account']")) return true;
    const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 4 /* text */);
    let firefoxBox = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (/settings are unavailable|Mozilla account|Firefox account/i.test(node.nodeValue)) {
        firefoxBox = node.parentElement?.closest("setting-group, moz-fieldset, groupbox, section, .setting-group, vbox") ?? node.parentElement;
        break;
      }
    }
    if (!firefoxBox) return false;
    // Jace's own account and sync are already on this page: just hide Mozilla's box.
    const jaceHere = [...doc.querySelectorAll(".jace-settings-frame")].some((f) => /only=[^&#]*account/.test(f.getAttribute("src") ?? ""));
    if (!jaceHere) firefoxBox.before(jaceAccountBox(win));
    firefoxBox.hidden = true;
    firefoxBox.style.display = "none";
    firefoxBox.setAttribute("jace-hidden", "mozilla-account");
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
        profile ? `Signed in as @${profile.username}.` : "Sign in to sync your stuff and stay signed in to Jace sites.",
      ),
    );
    const actions = el("div", { class: "jace-account-actions" });
    const button = (label, primary, onclick) => {
      const b = el("button", { class: primary ? "primary" : "" }, label);
      b.addEventListener("click", onclick);
      actions.append(b);
    };
    if (profile) {
      button("Sync settings", true, () => (win.location.href = JaceSettingsPane.url("sync")));
      button("Sign out", false, () => JaceAccount.signOut());
    } else {
      button("Sign in with Jace", true, () =>
        JaceAccount.signIn(win.browsingContext.topChromeWindow).catch((e) => {
          if (e?.code !== "cancelled") Services.prompt.alert(win, "Sign in with Jace", e.message);
        }),
      );
      button("Sync settings", false, () => (win.location.href = JaceSettingsPane.url("sync")));
    }
    box.append(pic, text, actions);
  };
  render();
  const observer = { observe: render };
  Services.obs.addObserver(observer, "jace-account-changed");
  win.addEventListener("unload", () => Services.obs.removeObserver(observer, "jace-account-changed"));
  return box;
}

/**
 * Where each part of Jace's settings goes in the browser's own categories.
 * Each entry: Jace sections, the Firefox panes to try (first that exists wins),
 * an optional label match for panes whose name isn't known, and whether
 * Jace replaces Firefox's own content there (Mozilla accounts sync, Firefox's
 * own About/version box), so nothing shows twice.
 */
const PLACEMENT = [
  // Account and sync: at the top of Firefox's "Account and sync" page (which,
  // since Firefox 15x, also has Default browser and Import), in place of the
  // Mozilla account box.
  { sections: ["account", "sync"], panes: ["paneSync"], label: /sync|account/i },
  { sections: ["about"], panes: ["paneAbout"], label: /^\s*about/i, replace: true },
  // The first of these that's actually shown (Firefox 159 hides General).
  { sections: ["look", "profiles", "drm"], panes: ["paneGeneral", "paneAppearance"], label: /general|appearance/i },
  { sections: ["search"], panes: ["paneSearch"], label: /search/i },
  { sections: ["privacy", "usb"], panes: ["panePrivacy"], label: /privacy|security/i },
];
const ALL_SECTIONS = PLACEMENT.flatMap((p) => p.sections);

/** The panes in the settings sidebar: [{ pane, label }]. */
function sidebarPanes(categories) {
  const win = categories.ownerDocument.defaultView;
  return [...categories.querySelectorAll("[view], richlistitem[value]")]
    .filter((n) => !n.hidden && win.getComputedStyle(n).display !== "none")
    .map((n) => ({ pane: n.getAttribute("view") ?? n.getAttribute("value"), label: n.textContent || n.getAttribute("label") || "" }))
    .filter((p) => p.pane);
}

/** Which pane each Jace section lands in; sections with no matching pane go to General. */
function planPlacement(categories) {
  const panes = sidebarPanes(categories);
  const has = (name) => panes.some((p) => p.pane === name);
  const general = ["paneGeneral", "paneAppearance", "paneSync"].find(has) ?? panes[0]?.pane;
  const plan = new Map(); // pane -> { sections, replace }
  for (const place of PLACEMENT) {
    let pane = place.panes.find(has) ?? panes.find((p) => place.label.test(p.label))?.pane;
    let replace = place.replace && !!pane;
    if (!pane) {
      pane = general;
      replace = false;
    }
    if (!pane) continue;
    const entry = plan.get(pane) ?? { sections: [], replace: false };
    entry.sections.push(...place.sections);
    entry.replace ||= replace;
    plan.set(pane, entry);
  }
  return plan;
}

function hideFirefoxContent(doc, pane) {
  const style = doc.createElementNS(HTML, "style");
  style.textContent = `#mainPrefPane > [data-category="${pane}"]:not(.jace-settings-frame) { display: none !important; }`;
  (doc.head ?? doc.documentElement).append(style);
}

/** Firefox's settings page: Jace's settings inside its own categories (Sync, General, Privacy, About). */
function inject(win, wantJace) {
  const doc = win.document;
  if (doc.querySelector(".jace-settings-frame") || doc.getElementById("jace-settings-section")) return true;
  const categories = doc.getElementById("categories");
  const mainPane = doc.getElementById("mainPrefPane");
  if (!categories || !mainPane || typeof win.gotoPref !== "function") {
    return injectAtTop(win);
  }
  const plan = planPlacement(categories);
  if (!plan.size) return injectAtTop(win);

  // ?jace=<section> picks where to open; anything else (a notice such as
  // "signed-in") is shown with the account.
  const asked = new URLSearchParams(win.location.search).get("jace") ?? "";
  const target = ALL_SECTIONS.includes(asked) ? asked : asked ? "account" : "";

  let targetFrame = null;
  let targetPane = null;
  for (const [pane, { sections, replace }] of plan) {
    const frame = doc.createElementNS(HTML, "iframe");
    frame.id = `jace-settings-${pane}`;
    frame.className = "jace-settings-frame";
    frame.setAttribute("data-category", pane);
    frame.setAttribute("hidden", "true");
    const notice = sections.includes("account") && asked && !ALL_SECTIONS.includes(asked) ? `#${asked}` : "";
    frame.setAttribute("src", `${SETTINGS_PAGE}?embedded=1&only=${sections.join(",")}${notice}`);
    if (replace) {
      // Firefox's own content for this category is Mozilla's (accounts, version): Jace's replaces it.
      hideFirefoxContent(doc, pane);
      mainPane.append(frame);
    } else {
      // Jace's parts come first in the category, then Firefox's own settings.
      const firstOfPane = mainPane.querySelector(`[data-category="${pane}"]`);
      // Firefox 15x draws each category as one <setting-pane> with its title
      // first: Jace's part goes right under the title, inside it (and shows
      // and hides with it).
      const header = firstOfPane?.localName === "setting-pane" ? firstOfPane.querySelector(":scope > moz-page-header, moz-page-header") : null;
      if (header) {
        header.after(frame);
        frame.removeAttribute("hidden");
        frame.removeAttribute("data-category");
      } else if (firstOfPane) {
        firstOfPane.before(frame);
      } else {
        mainPane.prepend(frame);
      }
    }
    fitFrame(frame);
    if (target && sections.includes(target)) {
      targetFrame = frame;
      targetPane = pane;
    }
  }

  // The category already on screen: show Jace's part of it now.
  const shown = [...mainPane.children].find((n) => n.dataset?.category && !n.hidden && !n.classList.contains("jace-settings-frame"));
  const shownPane = shown?.dataset.category;
  for (const frame of mainPane.querySelectorAll(".jace-settings-frame")) {
    if (frame.dataset.category === shownPane) frame.removeAttribute("hidden");
  }

  if (wantJace) {
    // Firefox may still switch to its own first page after this: switch back.
    const want = targetPane ?? plan.keys().next().value;
    for (const ms of [300, 1200]) {
      win.setTimeout(() => {
        const shown = [...mainPane.children].find((n) => n.dataset?.category && !n.hidden)?.dataset.category;
        if (shown && shown !== want) win.gotoPref(want);
      }, ms);
    }
    const pane = targetPane ?? (plan.has("paneGeneral") ? "paneGeneral" : plan.keys().next().value);
    win.gotoPref(pane);
    if (targetFrame && target) {
      targetFrame.addEventListener(
        "load",
        () =>
          win.setTimeout(() => {
            const el = targetFrame.contentDocument?.getElementById(target);
            if (el) win.scrollTo({ top: targetFrame.getBoundingClientRect().top + win.scrollY + el.offsetTop - 16 });
          }, 50),
        { once: true },
      );
    }
  }
  return true;
}

const JACE_ICON = "chrome://branding/content/icon32.png";

/**
 * Firefox's pictures on the settings page: the fox ("kit") on the
 * default-browser card goes, and Firefox / Mozilla logos on headings and
 * in the sidebar become Jace's. Also hides the "managed by your
 * organization" notice (that's Jace's own policies.json, not an employer).
 * Firefox draws parts of the page late, so this keeps watching.
 */
function debrandSettings(win) {
  const doc = win.document;
  const fix = () => {
    for (const el of doc.querySelectorAll("[imagesrc*='illustrations/kit-']")) el.removeAttribute("imagesrc");
    for (const el of doc.querySelectorAll("[iconsrc*='firefox'], [iconsrc*='mozilla-logo']")) {
      if (el.getAttribute("iconsrc") !== JACE_ICON) el.setAttribute("iconsrc", JACE_ICON);
    }
    const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 4 /* text */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (/being managed by your organi[sz]ation/i.test(node.nodeValue)) {
        const box = node.parentElement?.closest("moz-message-bar, .info-box-container, #policies-container, div, hbox") ?? node.parentElement;
        if (box && box.style.display !== "none") box.style.display = "none";
      }
    }
  };
  fix();
  let pending = false;
  const observer = new win.MutationObserver(() => {
    if (pending) return;
    pending = true;
    win.setTimeout(() => {
      pending = false;
      fix();
    }, 50);
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["imagesrc", "iconsrc"] });
  win.addEventListener("unload", () => observer.disconnect(), { once: true });
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
      debrandSettings(win);
    } catch (e) {
      console.error("Jace: settings pictures", e);
    }
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
    // After Firefox has drawn its sidebar (it decides which pages show then).
    win.addEventListener("load", () => whenSidebarReady(win, run), { once: true });
  }
}

function whenSidebarReady(win, fn) {
  let tries = 0;
  const check = () => {
    const nav = win.document.getElementById("categories");
    const ready = nav && [...nav.querySelectorAll("[view], richlistitem[value]")].some((n) => !n.hidden && win.getComputedStyle(n).display !== "none");
    if (ready || ++tries > 30) fn();
    else win.setTimeout(check, 100);
  };
  win.setTimeout(check, 0);
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
