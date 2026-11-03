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
  const { JaceSearch } = ChromeUtils.importESModule("chrome://jace/content/JaceSearch.sys.mjs");
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
      return (await JaceSearch.current().catch(() => null))?.icon ?? null;
    },
    engine: () => JaceSearch.current(),
    engines: () => JaceSearch.engines(),
    setEngine: (name) => JaceSearch.setDefault(name),
    onEngineChange(fn) {
      const stop = JaceSearch.onChange(fn);
      window.addEventListener("unload", stop);
    },
    suggest: (text) => JaceSearch.suggest(text, { max: 7 }),
    searchURL(term) {
      return JaceSearch.searchURL(term);
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
    engine: async () => ({ name: "Search" }),
    engines: async () => [{ name: "Search", isDefault: true }],
    setEngine: async () => {},
    onEngineChange() {},
    suggest: async (t) => [`${t} news`, `${t} weather`, `${t} meaning`],
    searchURL: () => null,
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

// ---- search: engine picker and suggestions ----
const sugBox = $("suggestions");
const engineMenu = $("engine-menu");
let suggestions = [];
let picked = -1;
let typed = "";
let query = 0;

function glass() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "glass");
  svg.innerHTML = '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>';
  return svg;
}

function renderSuggestions() {
  sugBox.replaceChildren();
  suggestions.forEach((term, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(i === picked));
    const label = document.createElement("span");
    // The part you typed plain, the rest bold (like most search boxes).
    if (term.toLowerCase().startsWith(typed.toLowerCase())) {
      label.append(term.slice(0, typed.length));
      const rest = document.createElement("b");
      rest.textContent = term.slice(typed.length);
      label.append(rest);
    } else {
      label.textContent = term;
    }
    b.append(glass(), label);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => searchFor(term));
    sugBox.append(b);
  });
  sugBox.hidden = !suggestions.length || document.activeElement !== $("query");
}

function searchFor(term) {
  const url = api.searchURL(term);
  if (url) api.open(url);
  else api.go(term);
}

async function updateSuggestions() {
  typed = $("query").value.trim();
  const id = ++query;
  const list = typed ? await api.suggest(typed).catch(() => []) : [];
  if (id !== query) return;
  suggestions = list;
  picked = -1;
  renderSuggestions();
}

let timer = null;
$("query").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(updateSuggestions, 80);
});
$("query").addEventListener("focus", () => renderSuggestions());
$("query").addEventListener("blur", () => setTimeout(() => (sugBox.hidden = true), 120));
$("query").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!suggestions.length) return;
    e.preventDefault();
    const n = suggestions.length;
    picked = e.key === "ArrowDown" ? (picked + 1) % n : picked <= 0 ? n - 1 : picked - 1;
    $("query").value = suggestions[picked];
    renderSuggestions();
  } else if (e.key === "Escape") {
    sugBox.hidden = true;
  }
});

$("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("query").value.trim();
  if (!text) return;
  if (picked >= 0 && suggestions[picked] === text) searchFor(text);
  else api.go(text);
});

async function showEngine() {
  const engine = await api.engine().catch(() => null);
  const src = await api.engineIcon();
  if (src) {
    $("engine-icon").src = src;
    $("engine-icon").hidden = false;
  }
  if (engine?.name) {
    $("query").placeholder = `Search with ${engine.name} or type a web address`;
    $("engine-button").title = `Search engine: ${engine.name} (click to change)`;
  }
}
showEngine();
api.onEngineChange(() => showEngine());

$("engine-button").addEventListener("click", async () => {
  if (!engineMenu.hidden) {
    engineMenu.hidden = true;
    return;
  }
  const engines = await api.engines().catch(() => []);
  engineMenu.replaceChildren();
  for (const engine of engines) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(engine.isDefault));
    if (engine.icon) {
      const img = document.createElement("img");
      img.src = engine.icon;
      img.alt = "";
      b.append(img);
    } else {
      b.append(glass());
    }
    b.append(engine.name);
    if (engine.isDefault) {
      const check = document.createElement("span");
      check.className = "check";
      check.textContent = "✓";
      b.append(check);
    }
    b.addEventListener("click", async () => {
      engineMenu.hidden = true;
      await api.setEngine(engine.name);
      showEngine();
      $("query").focus();
    });
    engineMenu.append(b);
  }
  sugBox.hidden = true;
  engineMenu.hidden = false;
});
document.addEventListener("click", (e) => {
  if (!e.target.closest?.("#engine-menu, #engine-button")) engineMenu.hidden = true;
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
    // Same element and layout as the other tiles, so they all line up.
    const add = document.createElement("a");
    add.className = "tile add";
    add.href = "#";
    add.setAttribute("role", "button");
    const addIcon = document.createElement("div");
    addIcon.className = "icon";
    addIcon.textContent = "+";
    const addName = document.createElement("span");
    addName.className = "name";
    addName.textContent = "Add";
    add.append(addIcon, addName);
    add.addEventListener("click", (e) => {
      e.preventDefault();
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
