/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Jace Browser's new tab page (and home page): clock, greeting, search,
// shortcuts. JaceNewTab.sys.mjs makes the browser use it.
// Opened outside Jace Browser (to preview the design), browser parts are stubbed.

const inBrowser = typeof ChromeUtils !== "undefined";

const DEFAULT_SHORTCUTS = [
  { title: "Jace", url: "https://jaceo.vercel.app/" },
  { title: "YouTube", url: "https://www.youtube.com/" },
  { title: "Wikipedia", url: "https://www.wikipedia.org/" },
  { title: "Reddit", url: "https://www.reddit.com/" },
  { title: "GitHub", url: "https://github.com/" },
];
const SHORTCUTS_PREF = "jace.newtab.shortcuts";

const api = inBrowser ? browserApi() : previewApi();

function browserApi() {
  const { JaceAccount } = ChromeUtils.importESModule("chrome://jace/content/JaceAccount.sys.mjs");
  const { JaceSettingsPane } = ChromeUtils.importESModule("chrome://jace/content/JaceSettingsPane.sys.mjs");
  const win = () => window.browsingContext.topChromeWindow;
  return {
    accent: () => Services.prefs.getStringPref("jace.theme.accent", "#3ddc84"),
    onAccent(fn) {
      Services.prefs.addObserver("jace.theme.accent", fn);
      window.addEventListener("unload", () => Services.prefs.removeObserver("jace.theme.accent", fn));
    },
    name: () => JaceAccount.profile?.name ?? null,
    shortcuts() {
      try {
        const list = JSON.parse(Services.prefs.getStringPref(SHORTCUTS_PREF, ""));
        if (Array.isArray(list)) return list;
      } catch {}
      return DEFAULT_SHORTCUTS;
    },
    saveShortcuts(list) {
      Services.prefs.setStringPref(SHORTCUTS_PREF, JSON.stringify(list));
    },
    async engineIcon() {
      try {
        const engine = await Services.search.getDefault();
        return (await engine.getIconURL?.()) ?? engine.iconURI?.spec ?? null;
      } catch {
        return null;
      }
    },
    go(text) {
      // Same as the address bar: a web address opens, anything else is searched.
      const flags = Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP | Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
      const { preferredURI } = Services.uriFixup.getFixupURIInfo(text, flags);
      if (preferredURI) win().openTrustedLinkIn(preferredURI.spec, "current");
    },
    open(url) {
      win().openTrustedLinkIn(url, "current");
    },
    openSettings() {
      win().openTrustedLinkIn(JaceSettingsPane.url(), "current");
    },
  };
}

function previewApi() {
  let list = DEFAULT_SHORTCUTS;
  return {
    accent: () => "#3ddc84",
    onAccent() {},
    name: () => "Jace",
    shortcuts: () => list,
    saveShortcuts: (l) => (list = l),
    engineIcon: async () => null,
    go: () => {},
    open: () => {},
    openSettings: () => {},
  };
}

const $ = (id) => document.getElementById(id);

// ---- accent ----
function applyAccent() {
  const accent = api.accent();
  if (/^#[0-9a-f]{3,8}$/i.test(accent)) document.documentElement.style.setProperty("--accent", accent);
}
applyAccent();
api.onAccent(applyAccent);

// ---- clock and greeting ----
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function tick() {
  const now = new Date();
  $("clock").textContent = timeFormat.format(now);
  const h = now.getHours();
  const part = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const name = api.name();
  $("greeting").textContent = name ? `${part}, ${name}` : part;
}
tick();
setInterval(tick, 10_000);

// ---- search ----
$("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("query").value.trim();
  if (text) api.go(text);
});
api.engineIcon().then((src) => {
  if (src) {
    $("engine-icon").src = src;
    $("engine-icon").hidden = false;
  }
});

// ---- shortcuts ----
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function renderShortcuts() {
  const box = $("shortcuts");
  box.replaceChildren();
  const list = api.shortcuts();
  list.forEach((s, i) => {
    const a = document.createElement("a");
    a.className = "tile";
    a.href = s.url;
    a.title = s.url;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      api.open(s.url);
    });
    const icon = document.createElement("div");
    icon.className = "icon";
    const letter = (s.title || hostOf(s.url)).charAt(0).toUpperCase();
    if (inBrowser) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = `page-icon:${s.url}`;
      img.addEventListener("error", () => img.replaceWith(letter));
      icon.append(img);
    } else {
      icon.textContent = letter;
    }
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.title || hostOf(s.url);
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.title = `Remove ${name.textContent}`;
    remove.textContent = "×";
    remove.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      api.saveShortcuts(list.filter((_, j) => j !== i));
      renderShortcuts();
    });
    a.append(icon, name, remove);
    box.append(a);
  });
  if (list.length < 16) {
    const add = document.createElement("button");
    add.className = "tile add";
    add.style.border = "0";
    add.style.background = "none";
    add.style.font = "inherit";
    add.style.color = "inherit";
    add.innerHTML = '<div class="icon">+</div><span class="name">Add</span>';
    add.addEventListener("click", () => {
      $("add-form").hidden = false;
      $("add-url").focus();
    });
    box.append(add);
  }
}
renderShortcuts();

$("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  let url = $("add-url").value.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    new URL(url);
  } catch {
    $("add-url").focus();
    return;
  }
  api.saveShortcuts([...api.shortcuts(), { title: $("add-title").value.trim() || hostOf(url), url }]);
  $("add-title").value = $("add-url").value = "";
  $("add-form").hidden = true;
  renderShortcuts();
});
$("add-cancel").addEventListener("click", () => ($("add-form").hidden = true));

$("settings").addEventListener("click", () => api.openSettings());
