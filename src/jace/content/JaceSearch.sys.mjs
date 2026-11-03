/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Search engines and search suggestions for Jace's own search boxes (the new
 * tab box, the start page) and the engine pickers in setup and settings.
 * The engine picked here is the browser's default everywhere, address bar
 * included.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SearchSuggestionController: "resource://gre/modules/SearchSuggestionController.sys.mjs",
});

const SUGGEST_PREF = "browser.search.suggest.enabled";

async function iconOf(engine) {
  try {
    return (await engine.getIconURL?.()) ?? engine.iconURI?.spec ?? null;
  } catch {
    return null;
  }
}

export const JaceSearch = {
  get suggestionsOn() {
    return Services.prefs.getBoolPref(SUGGEST_PREF, true);
  },
  set suggestionsOn(on) {
    Services.prefs.setBoolPref(SUGGEST_PREF, !!on);
    Services.prefs.setBoolPref("browser.urlbar.suggest.searches", !!on);
  },

  /** [{ name, icon, isDefault }] */
  async engines() {
    await Services.search.init();
    const current = await Services.search.getDefault();
    const list = await Services.search.getVisibleEngines();
    return Promise.all(list.map(async (e) => ({ name: e.name, icon: await iconOf(e), isDefault: e.name === current?.name })));
  },

  async current() {
    await Services.search.init();
    const engine = await Services.search.getDefault();
    return engine ? { name: engine.name, icon: await iconOf(engine) } : null;
  },

  async setDefault(name) {
    await Services.search.init();
    const engine = Services.search.getEngineByName(name);
    if (!engine) throw new Error(`No search engine called ${name}`);
    const reason = Ci.nsISearchService.CHANGE_REASON_USER ?? 0;
    await Services.search.setDefault(engine, reason);
  },

  /** Calls fn when the default engine changes; returns a function that stops it. */
  onChange(fn) {
    const observer = {
      observe(_s, _t, data) {
        if (data === "engine-default" || data === "engine-changed") fn();
      },
    };
    Services.obs.addObserver(observer, "browser-search-engine-modified");
    return () => Services.obs.removeObserver(observer, "browser-search-engine-modified");
  },

  /**
   * Suggestions for what you're typing, from the default engine (up to
   * `max`). Empty when suggestions are off or the engine has none.
   */
  async suggest(text, { max = 6, isPrivate = false } = {}) {
    text = text.trim();
    if (!text || !this.suggestionsOn || text.length > 100 || /^[a-z]+:\/\//i.test(text)) return [];
    await Services.search.init();
    const engine = await Services.search.getDefault();
    if (!engine) return [];
    let results = null;
    try {
      const controller = new lazy.SearchSuggestionController();
      controller.maxLocalResults = 0;
      controller.maxRemoteResults = max;
      // Newer Firefox takes one options object; older takes arguments.
      results =
        controller.fetch.length <= 1
          ? await controller.fetch({ searchString: text, inPrivateBrowsing: isPrivate, engine })
          : await controller.fetch(text, isPrivate, engine);
    } catch (e) {
      console.warn("Jace: search suggestions (controller)", e);
    }
    let remote = results?.remote?.map((r) => r?.value ?? r).filter((r) => typeof r === "string");
    if (!remote) {
      // Fallback: ask the engine's suggestion address directly.
      try {
        const sub = engine.getSubmission(text, "application/x-suggestions+json");
        if (!sub) return [];
        const response = await fetch(sub.uri.spec, { credentials: "omit" });
        const json = await response.json();
        remote = Array.isArray(json?.[1]) ? json[1].filter((r) => typeof r === "string") : [];
      } catch (e) {
        console.warn("Jace: search suggestions", e);
        remote = [];
      }
    }
    const lower = text.toLowerCase();
    return remote.filter((r) => r.toLowerCase() !== lower).slice(0, max);
  },
};
