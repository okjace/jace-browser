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
 *   addons    - the add-ons installed here (offered on other devices)
 *
 * Passwords can't be synced: Firefox doesn't let extensions read them.
 */

import { IS_CHROME } from "./compat.js";
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

// Chrome's roots: "1" bookmarks bar, "2" other bookmarks, "3" mobile. It has
// no bookmarks menu, so Firefox's menu lives in a "Bookmarks Menu" folder
// inside Other bookmarks (and syncs back to the menu).
export const CHROME_ROOTS = { toolbar: "1", unfiled: "2", mobile: "3" };
export const CHROME_MENU_FOLDER = "Bookmarks Menu";
const CHROME_ROOT_NAMES = { 1: "toolbar", 2: "unfiled", 3: "mobile" };

export function bookmarkKey(path, url) {
  return [...path, url].join(SEP);
}

/** Flattens a bookmarks.getTree() result into records (exported for tests). */
export function flattenBookmarks(tree, { chrome = IS_CHROME } = {}) {
  const out = {};
  const walk = (node, path) => {
    for (const child of node.children ?? []) {
      if (child.type === "folder" || (!child.url && child.children)) {
        let next;
        if (path.length === 0) {
          const root = (chrome ? CHROME_ROOT_NAMES : ROOT_NAMES)[child.id];
          if (!root) continue;
          next = [root];
        } else if (chrome && path.length === 1 && path[0] === "unfiled" && child.title === CHROME_MENU_FOLDER) {
          next = ["menu"]; // Chrome's stand-in for Firefox's bookmarks menu
        } else {
          next = [...path, child.title ?? ""];
        }
        walk(child, next);
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

async function childFolder(parentId, title) {
  const children = await browser.bookmarks.getChildren(parentId);
  const folder = children.find((c) => (c.type === "folder" || !c.url) && c.title === title);
  return folder ?? (await browser.bookmarks.create({ parentId, title }));
}

async function folderFor(path) {
  let parentId;
  if (IS_CHROME) {
    parentId = path[0] === "menu" ? (await childFolder(CHROME_ROOTS.unfiled, CHROME_MENU_FOLDER)).id : CHROME_ROOTS[path[0]] ?? CHROME_ROOTS.unfiled;
  } else {
    parentId = ROOTS[path[0]] ?? ROOTS.unfiled;
  }
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
        // Chrome's addUrl only takes the address (no title or time).
        await browser.history.addUrl(IS_CHROME ? { url: r.url } : { url: r.url, title: r.title || undefined, visitTime: r.modified }).catch(() => {});
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
    // Firefox: the normal (non-container, non-isolated) cookies; Chrome: the normal profile's.
    const all = await browser.cookies.getAll(IS_CHROME ? {} : { firstPartyDomain: null, storeId: "firefox-default" });
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

// ---------------------------------------------------------------- add-ons

/**
 * The add-ons installed in this Firefox (extensions and themes), one record
 * per device, same shape as Jace Browser's "addons" engine. Other devices
 * show them and offer to install them; nothing is installed from here.
 */
const addons = {
  name: "addons",
  perDevice: true,
  async collect({ deviceId, deviceName }) {
    const self = browser.runtime.id;
    const list = (await browser.management.getAll())
      .filter((a) => a.id && a.id !== self && (a.type === "extension" || a.type === "theme") && a.installType !== "development")
      .map((a) => ({ id: a.id, name: a.name, type: a.type }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { [deviceId]: { device: deviceName, addons: list, modified: Date.now() } };
  },
  async apply() {},
};

export const ENGINES = [bookmarks, history, cookies, tabs, addons];
