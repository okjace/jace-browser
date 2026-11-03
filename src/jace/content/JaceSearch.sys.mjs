/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Search engines and search suggestions for Jace's own search boxes (the new
 * tab box, the start page) and the engine pickers in setup and settings.
 * The engine picked here is the browser's default everywhere, address bar
 * included.
 */

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// fetch and FileReader for turning icons into data: URLs.
try {
  Cu.importGlobalProperties(["fetch", "FileReader"]);
} catch {}

import { getSearchService, getSearchSuggestionController } from "chrome://jace/content/JaceCompat.sys.mjs";

/** The search service (Services.search on older Firefox). */
const search = () => getSearchService();

const SUGGEST_PREF = "browser.search.suggest.enabled";

const icons = new Map(); // engine name -> Promise<url|null>

/**
 * An engine's icon (a data: URL when possible, so any page can show it).
 * Icons can take a while (they may come from the network on a new profile).
 */
function loadIcon(engine) {
  if (!icons.has(engine.name)) {
    const p = (async () => {
      let url = null;
      try {
        url = (await engine.getIconURL?.(32)) ?? engine.iconURI?.spec ?? null;
      } catch {}
      if (!url) return null;
      if (/^(blob|moz-[a-z-]+):/.test(url)) {
        // Only this module can read these: make a copy pages can show.
        try {
          const blob = await (await fetch(url)).blob();
          url = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        } catch {}
      }
      return url;
    })();
    icons.set(engine.name, p);
    p.then((url) => url || icons.delete(engine.name)); // try again next time
  }
  return icons.get(engine.name);
}

/** The icon if it's ready within `ms`, else null (it keeps loading). */
async function iconOf(engine, ms = 700) {
  return Promise.race([loadIcon(engine).catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);
}

/** The search service, ready (with a time limit so callers never hang). */
async function ready() {
  await Promise.race([search().init(), new Promise((_, no) => setTimeout(() => no(new Error("search service didn't start")), 8000))]);
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
    await ready();
    const current = await search().getDefault();
    const list = (await search().getVisibleEngines?.()) ?? (await search().getEngines());
    return Promise.all(list.map(async (e) => ({ name: e.name, icon: await iconOf(e), isDefault: e.name === current?.name })));
  },

  /** An engine's icon, waiting up to 10 s. */
  async iconFor(name) {
    await ready();
    const engine = search().getEngineByName(name);
    return engine ? iconOf(engine, 10000) : null;
  },

  async current() {
    await ready();
    const engine = await search().getDefault();
    return engine ? { name: engine.name, icon: await iconOf(engine, 10000) } : null;
  },

  /** The address that searches the default engine for `term`, or null. */
  searchURL(term) {
    try {
      return search().defaultEngine?.getSubmission(term)?.uri.spec ?? null;
    } catch {
      return null;
    }
  },

  async setDefault(name) {
    await ready();
    const engine = search().getEngineByName(name);
    if (!engine) throw new Error(`No search engine called ${name}`);
    const reason = Ci.nsISearchService?.CHANGE_REASON_USER ?? search().CHANGE_REASON_USER ?? 0;
    await search().setDefault(engine, reason);
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
    await ready();
    const engine = await search().getDefault();
    if (!engine) return [];
    let results = null;
    try {
      const controller = new (getSearchSuggestionController())();
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
