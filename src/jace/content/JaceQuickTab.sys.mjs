/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * New tab, the Jace way: Ctrl+T or the + button opens a small search box
 * floating over the current page instead of an empty tab. Type an address or
 * a search, pick a site you visit often, or jump to a tab that's already open.
 *
 *   Enter          open in a new tab (or switch to that open tab)
 *   Shift+Enter    open in this tab
 *   Esc            close
 *   "Empty tab"    the classic empty new tab
 *
 * Off with jace.newtab.popup = false (Settings -> Look).
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  JaceSearch: "chrome://jace/content/JaceSearch.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const PREF = "jace.newtab.popup";
const PANEL_ID = "jace-quicktab";
const HTML = "http://www.w3.org/1999/xhtml";
const WIDTH = 620;
const MAX_RESULTS = 9;

function searchURL(text) {
  try {
    return lazy.JaceSearch.searchURL(text);
  } catch {
    return null;
  }
}

function el(doc, tag, attrs = {}, text = null) {
  const n = doc.createElementNS(HTML, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== null) n.textContent = text;
  return n;
}

function fixup(text) {
  const flags = Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP | Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
  try {
    const info = Services.uriFixup.getFixupURIInfo(text, flags);
    return { url: info.preferredURI?.spec ?? null, isSearch: !!info.keywordProviderName };
  } catch {
    return { url: null, isSearch: false };
  }
}

async function places(text) {
  const db = await lazy.PlacesUtils.promiseDBConnection();
  if (!text) {
    const rows = await db.executeCached(
      `SELECT url, title FROM moz_places
       WHERE hidden = 0 AND frecency > 0 AND url LIKE :http
       ORDER BY frecency DESC LIMIT 6`,
      // Firefox's history database only accepts LIKE patterns as bindings.
      { http: "http%" },
    );
    return rows.map((r) => ({ url: r.getResultByName("url"), title: r.getResultByName("title") }));
  }
  const q = `%${text.replace(/[%_/]/g, "/$&")}%`;
  const rows = await db.executeCached(
    `SELECT url, title FROM moz_places
     WHERE hidden = 0 AND frecency > 0 AND (url LIKE :q ESCAPE '/' OR title LIKE :q ESCAPE '/')
     ORDER BY frecency DESC LIMIT 6`,
    { q },
  );
  return rows.map((r) => ({ url: r.getResultByName("url"), title: r.getResultByName("title") }));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function build(win) {
  const doc = win.document;
  const panel = doc.createXULElement("panel");
  panel.id = PANEL_ID;
  panel.setAttribute("noautofocus", "true");
  panel.setAttribute("consumeoutsideclicks", "true");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "New tab");

  const box = el(doc, "div", { class: "qt-box" });
  const row = el(doc, "div", { class: "qt-input-row" });
  const icon = el(doc, "span", { class: "qt-search-icon", "aria-hidden": "true" });
  const input = el(doc, "input", { class: "qt-input", type: "text", placeholder: "Search or type an address", spellcheck: "false" });
  row.append(icon, input);
  const list = el(doc, "div", { class: "qt-results", role: "listbox" });
  const foot = el(doc, "div", { class: "qt-foot" });
  const hint = el(doc, "span", { class: "qt-hint" }, "Enter: new tab · Shift+Enter: this tab · Esc: close");
  const empty = el(doc, "button", { class: "qt-empty" }, "Empty tab");
  foot.append(hint, empty);
  box.append(row, list, foot);
  panel.append(box);
  (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);

  const state = { items: [], selected: 0, query: 0, openEmpty: null };

  const render = () => {
    list.replaceChildren();
    state.items.forEach((item, i) => {
      const r = el(doc, "div", { class: "qt-item", role: "option", "data-kind": item.kind });
      if (i === state.selected) r.setAttribute("selected", "true");
      const img = el(doc, "img", { class: "qt-icon", alt: "" });
      if (item.url && !["search", "suggestion"].includes(item.kind)) {
        img.src = item.tab?.image || `page-icon:${item.url}`;
        img.addEventListener("error", () => img.removeAttribute("src"));
      }
      const text = el(doc, "div", { class: "qt-text" });
      text.append(el(doc, "span", { class: "qt-title" }, item.title || hostOf(item.url)));
      if (item.sub) text.append(el(doc, "span", { class: "qt-sub" }, item.sub));
      r.append(img, text);
      if (item.badge) r.append(el(doc, "span", { class: "qt-badge" }, item.badge));
      r.addEventListener("mousemove", () => {
        if (state.selected !== i) {
          state.selected = i;
          for (const [n, node] of [...list.children].entries()) node.toggleAttribute("selected", n === i);
        }
      });
      r.addEventListener("click", (e) => run(item, e.shiftKey ? "current" : "tab"));
      list.append(r);
    });
    list.hidden = !state.items.length;
  };

  const update = async () => {
    const text = input.value.trim();
    const id = ++state.query;
    const items = [];
    if (text) {
      const { url, isSearch } = fixup(text);
      if (url) {
        items.push(
          isSearch
            ? { kind: "search", title: text, sub: "Search the web", url, badge: "Search" }
            : { kind: "go", title: url, sub: "Open this address", url, badge: "Go" },
        );
      }
      const needle = text.toLowerCase();
      for (const tab of win.gBrowser.tabs) {
        const spec = tab.linkedBrowser.currentURI?.spec ?? "";
        if (tab.selected || !(tab.label.toLowerCase().includes(needle) || spec.toLowerCase().includes(needle))) continue;
        items.push({ kind: "tab", title: tab.label, sub: hostOf(spec), url: spec, tab, badge: "Switch to tab" });
        if (items.length >= 4) break;
      }
    }
    const [found, suggestions] = await Promise.all([
      places(text).catch((e) => {
        console.warn("Jace: new tab search", e);
        return [];
      }),
      lazy.JaceSearch.suggest(text, { max: 4, isPrivate: lazy.PrivateBrowsingUtils?.isWindowPrivate?.(win) ?? false }).catch(() => []),
    ]);
    if (id !== state.query) return; // a newer search is running
    const seen = new Set(items.map((i) => i.url));
    for (const term of suggestions) {
      const url = searchURL(term);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      items.push({ kind: "suggestion", title: term, url });
    }
    for (const p of found) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      items.push({ kind: "history", title: p.title || hostOf(p.url), sub: hostOf(p.url), url: p.url });
    }
    state.items = items.slice(0, MAX_RESULTS);
    state.selected = 0;
    render();
  };

  const close = () => panel.hidePopup();

  const run = (item, where) => {
    if (!item) return;
    close();
    if (item.kind === "tab" && where === "tab") {
      win.gBrowser.selectedTab = item.tab;
      return;
    }
    win.openTrustedLinkIn(item.url, where);
  };

  let timer = null;
  input.addEventListener("input", () => {
    win.clearTimeout(timer);
    timer = win.setTimeout(update, 50);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!state.items.length) return;
      const n = state.items.length;
      state.selected = (state.selected + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const text = input.value.trim();
      const item = state.items[state.selected] ?? (text ? { kind: "go", url: fixup(text).url } : null);
      if (item?.url) run(item, e.shiftKey ? "current" : "tab");
      else if (!text) {
        close();
        state.openEmpty?.();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
      // Ctrl+T again: a plain empty tab.
      e.preventDefault();
      close();
      state.openEmpty?.();
    }
  });
  empty.addEventListener("click", () => {
    close();
    state.openEmpty?.();
  });
  panel.addEventListener("popupshown", () => {
    input.focus();
    input.select();
  });
  panel.addEventListener("popuphidden", () => panel.removeAttribute("jace-open"));

  return {
    panel,
    open(openEmpty) {
      state.openEmpty = openEmpty;
      input.value = "";
      state.items = [];
      render();
      update();
      lazy.JaceSearch.current()
        .then((engine) => {
          input.placeholder = engine ? `Search with ${engine.name} or type an address` : "Search or type an address";
          if (engine?.icon) icon.style.backgroundImage = `url("${engine.icon.replace(/"/g, "%22")}")`;
          else icon.style.removeProperty("background-image");
        })
        .catch(() => {});
      const anchor = win.gBrowser.selectedBrowser?.closest(".browserStack") ?? win.gBrowser.selectedBrowser ?? doc.getElementById("tabbrowser-tabbox");
      const width = anchor.getBoundingClientRect().width;
      box.style.width = `${Math.min(WIDTH, Math.max(320, width - 40))}px`;
      const x = Math.max(20, Math.round((width - Math.min(WIDTH, width - 40)) / 2));
      panel.setAttribute("jace-open", "true");
      panel.openPopup(anchor, { position: "overlap", x, y: 72 });
    },
  };
}

export const JaceQuickTab = {
  get enabled() {
    return Services.prefs.getBoolPref(PREF, true);
  },

  /** Shows (or hides, if it's open) the box in a window. */
  toggle(win, openEmpty) {
    win.__jaceQuickTab ??= build(win);
    const { panel } = win.__jaceQuickTab;
    if (panel.state === "open" || panel.state === "showing") {
      panel.hidePopup();
      return;
    }
    win.__jaceQuickTab.open(openEmpty);
  },

  /** New tab commands (Ctrl+T, the + buttons) open the box instead of an empty tab. */
  install(win) {
    const commands = win.BrowserCommands;
    if (!commands?.openTab || commands.__jaceQuickTab) return false;
    const original = commands.openTab;
    commands.__jaceQuickTab = true;
    commands.openTab = function (options = {}) {
      const { event, url } = options ?? {};
      // Middle-clicks, an address, or the box turned off: the normal new tab.
      const plain = url || !JaceQuickTab.enabled || (event && (event.button === 1 || event.shiftKey));
      if (plain) return original.call(this, options);
      try {
        JaceQuickTab.toggle(win, () => original.call(this, options));
        return undefined;
      } catch (e) {
        console.error("Jace: new tab box", e);
        return original.call(this, options);
      }
    };
    return true;
  },
};
