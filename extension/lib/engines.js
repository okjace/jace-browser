/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What the extension syncs, through WebExtension APIs. Every record has the
 * same shape and key as Jace Browser's (src/jace/content/sync/JaceEngines),
 * so the two sync with each other.
 *
 *   bookmarks - every bookmark, with its folder path
 *   history   - pages visited in the last 90 days (up to 5,000)
 *   cookies   - site sign-ins (the shared format in cookies.js)
 *   tabs      - this browser's open tabs (shown on other devices, never opened)
 *
 * Passwords can't be synced: Firefox doesn't let extensions read them.
 */

import {
  COOKIE_VALUE_MAX,
  SEP,
  cookieKey,
  fromExtensionCookie,
  retainCookie,
  toExtensionCookieDetails,
  toExtensionCookieRemoval,
} from "./cookies.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- bookmarks

// Firefox's bookmark root ids (the same guids Jace Browser uses).
export const ROOTS = {
  menu: "menu________",
  toolbar: "toolbar_____",
  unfiled: "unfiled_____",
  mobile: "mobile______",
};
const ROOT_NAMES = Object.fromEntries(Object.entries(ROOTS).map(([k, v]) => [v, k]));

export function bookmarkKey(path, url) {
  return [...path, url].join(SEP);
}

/** Flattens a bookmarks.getTree() result into records (exported for tests). */
export function flattenBookmarks(tree) {
  const out = {};
  const walk = (node, path) => {
    for (const child of node.children ?? []) {
      if (child.type === "folder" || (!child.url && child.children)) {
        const segment = path.length === 0 ? ROOT_NAMES[child.id] : child.title ?? "";
        if (path.length === 0 && !segment) continue;
        walk(child, [...path, segment]);
      } else if (child.url && path.length && !child.url.startsWith("place:")) {
        out[bookmarkKey(path, child.url)] = {
          url: child.url,
          title: child.title ?? "",
          path,
          modified: child.dateGroupModified ?? child.dateAdded ?? 0,
          _local: { guid: child.id },
        };
      }
    }
  };
  for (const root of tree) walk(root, []);
  return out;
}

async function folderFor(path) {
  let parentId = ROOTS[path[0]] ?? ROOTS.unfiled;
  for (const title of path.slice(1)) {
    const children = await browser.bookmarks.getChildren(parentId);
    let folder = children.find((c) => (c.type === "folder" || !c.url) && c.title === title);
    if (!folder) folder = await browser.bookmarks.create({ parentId, title });
    parentId = folder.id;
  }
  return parentId;
}

const bookmarks = {
  name: "bookmarks",
  async collect() {
    return flattenBookmarks(await browser.bookmarks.getTree());
  },
  async apply({ toAdd, toUpdate, toRemove }) {
    for (const r of toAdd) {
      await browser.bookmarks.create({ parentId: await folderFor(r.path), url: r.url, title: r.title }).catch(() => {});
    }
    for (const { local, remote } of toUpdate) {
      await browser.bookmarks.update(local._local.guid, { title: remote.title }).catch(() => {});
    }
    for (const r of toRemove) {
      await browser.bookmarks.remove(r._local.guid).catch(() => {});
    }
  },
};

// ---------------------------------------------------------------- history

const HISTORY_DAYS = 90;
const HISTORY_MAX = 5000;

const history = {
  name: "history",
  retain: (r) => r.modified > Date.now() - HISTORY_DAYS * DAY_MS,
  async collect() {
    const items = await browser.history.search({
      text: "",
      startTime: Date.now() - HISTORY_DAYS * DAY_MS,
      maxResults: HISTORY_MAX,
    });
    const out = {};
    for (const h of items) {
      if (!/^https?:/.test(h.url)) continue;
      out[h.url] = { url: h.url, title: h.title ?? "", modified: Math.floor(h.lastVisitTime ?? 0) };
    }
    return out;
  },
  async apply({ toAdd, toUpdate, toRemove }) {
    for (const r of [...toAdd, ...toUpdate.map((u) => u.remote)]) {
      if (r.modified > 0) {
        await browser.history.addUrl({ url: r.url, title: r.title || undefined, visitTime: r.modified }).catch(() => {});
      }
    }
    for (const r of toRemove) {
      await browser.history.deleteUrl({ url: r.url }).catch(() => {});
    }
  },
};

// ---------------------------------------------------------------- cookies

const COOKIE_MAX = 20000;

const cookies = {
  name: "cookies",
  retain: (r) => retainCookie(r),
  localDeletionCounts: (base) => !base.session,
  async collect() {
    // The default cookie store only: not private windows, containers or partitioned cookies.
    const all = await browser.cookies.getAll({ firstPartyDomain: null, storeId: "firefox-default" });
    const out = {};
    let count = 0;
    for (const c of all) {
      if (c.partitionKey || c.firstPartyDomain || c.value.length > COOKIE_VALUE_MAX) continue;
      if (++count > COOKIE_MAX) break;
      const r = fromExtensionCookie(c);
      out[cookieKey(r)] = r;
    }
    return out;
  },
  async apply({ toAdd, toUpdate, toRemove }) {
    for (const r of [...toAdd, ...toUpdate.map((u) => u.remote)]) {
      await browser.cookies.set(toExtensionCookieDetails(r)).catch((e) => console.warn(`Jace: cookie ${r.name} for ${r.host}`, e));
    }
    for (const r of toRemove) {
      await browser.cookies.remove(toExtensionCookieRemoval(r)).catch(() => {});
    }
  },
};

// ---------------------------------------------------------------- tabs

const tabs = {
  name: "tabs",
  perDevice: true,
  async collect({ deviceId, deviceName }) {
    const list = (await browser.tabs.query({}))
      .filter((t) => !t.incognito && /^https?:/.test(t.url ?? ""))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
      .slice(0, 200)
      .map((t) => ({ url: t.url, title: t.title ?? t.url }));
    return { [deviceId]: { device: deviceName, tabs: list, modified: Date.now() } };
  },
  async apply() {},
};

export const ENGINES = [bookmarks, history, cookies, tabs];
