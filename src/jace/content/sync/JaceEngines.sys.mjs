/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What Jace sync syncs. Each engine turns part of the profile into a map of
 * key -> record (collect), and applies a merge result back (apply). The
 * merging itself is JaceMerge.threeWayMerge.
 *
 * Engines:
 *   bookmarks  - every bookmark, with its folder path
 *   history    - pages visited in the last 90 days (up to 5,000)
 *   passwords  - saved logins
 *   cookies    - site cookies, so a site you're signed in to on one device is
 *                signed in on all of them
 *   tabs       - this device's open tabs (shown on other devices, not opened)
 *   prefs      - a short list of look-and-feel settings
 *   addons     - installed add-ons (offered on other devices, not installed)
 */

import { SECRETS_ORIGIN } from "chrome://jace/content/JaceSecrets.sys.mjs";
import {
  COOKIE_VALUE_MAX,
  cookieKey,
  fromGeckoCookie,
  retainCookie,
  toGeckoSameSite,
} from "chrome://jace/content/sync/JaceCookies.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const SEP = "\u001f"; // same separator as JaceCookies.SEP
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- bookmarks

const ROOTS = () => ({
  menu: lazy.PlacesUtils.bookmarks.menuGuid,
  toolbar: lazy.PlacesUtils.bookmarks.toolbarGuid,
  unfiled: lazy.PlacesUtils.bookmarks.unfiledGuid,
  mobile: lazy.PlacesUtils.bookmarks.mobileGuid,
});

async function folderFor(path) {
  // path: ["toolbar", "Work", "Docs"]
  const roots = ROOTS();
  let parentGuid = roots[path[0]] ?? roots.unfiled;
  for (const title of path.slice(1)) {
    const children = await childrenOf(parentGuid);
    let found = children.find((c) => c.type === lazy.PlacesUtils.bookmarks.TYPE_FOLDER && c.title === title);
    if (!found) {
      found = await lazy.PlacesUtils.bookmarks.insert({
        parentGuid,
        type: lazy.PlacesUtils.bookmarks.TYPE_FOLDER,
        title,
        source: lazy.PlacesUtils.bookmarks.SOURCES.SYNC,
      });
    }
    parentGuid = found.guid;
  }
  return parentGuid;
}

async function childrenOf(parentGuid) {
  const tree = await lazy.PlacesUtils.promiseBookmarksTree(parentGuid, { includeItemIds: false });
  return (tree?.children ?? []).map((c) => ({
    guid: c.guid,
    title: c.title ?? "",
    type: c.typeCode,
  }));
}

const bookmarks = {
  name: "bookmarks",
  async collect() {
    const roots = ROOTS();
    const nameOf = Object.fromEntries(Object.entries(roots).map(([k, v]) => [v, k]));
    const out = {};
    const tree = await lazy.PlacesUtils.promiseBookmarksTree(lazy.PlacesUtils.bookmarks.rootGuid);
    const walk = (node, path) => {
      for (const child of node.children ?? []) {
        if (child.typeCode === lazy.PlacesUtils.bookmarks.TYPE_FOLDER) {
          const segment = path.length === 0 ? nameOf[child.guid] : child.title ?? "";
          if (path.length === 0 && !segment) {
            continue; // tags and other internal roots
          }
          walk(child, [...path, segment]);
        } else if (child.typeCode === lazy.PlacesUtils.bookmarks.TYPE_BOOKMARK && child.uri && path.length) {
          if (child.uri.startsWith("place:")) {
            continue; // smart bookmarks are per-device
          }
          const key = [...path, child.uri].join(SEP);
          out[key] = {
            url: child.uri,
            title: child.title ?? "",
            path,
            modified: Math.floor((child.lastModified ?? child.dateAdded ?? 0) / 1000),
            _local: { guid: child.guid },
          };
        }
      }
    };
    walk(tree, []);
    return out;
  },
  async apply({ toAdd, toUpdate, toRemove }) {
    const B = lazy.PlacesUtils.bookmarks;
    for (const r of toAdd) {
      await B.insert({ parentGuid: await folderFor(r.path), url: r.url, title: r.title, source: B.SOURCES.SYNC });
    }
    for (const { local, remote } of toUpdate) {
      await B.update({ guid: local._local.guid, title: remote.title, source: B.SOURCES.SYNC });
    }
    for (const r of toRemove) {
      await B.remove(r._local.guid, { source: B.SOURCES.SYNC }).catch(() => {});
    }
  },
};

// ---------------------------------------------------------------- history

const HISTORY_DAYS = 90;
const HISTORY_MAX = 5000;

const history = {
  name: "history",
  retain(r) {
    return r.modified > Date.now() - HISTORY_DAYS * DAY_MS;
  },
  async collect() {
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const since = (Date.now() - HISTORY_DAYS * DAY_MS) * 1000;
    const rows = await db.executeCached(
      `SELECT url, title, last_visit_date FROM moz_places
       WHERE last_visit_date > :since AND hidden = 0 AND url_hash != 0
         AND (url LIKE 'http://%' OR url LIKE 'https://%')
       ORDER BY last_visit_date DESC LIMIT :limit`,
      { since, limit: HISTORY_MAX },
    );
    const out = {};
    for (const row of rows) {
      const url = row.getResultByName("url");
      out[url] = {
        url,
        title: row.getResultByName("title") ?? "",
        modified: Math.floor(row.getResultByName("last_visit_date") / 1000),
      };
    }
    return out;
  },
  async apply({ toAdd, toUpdate, toRemove }) {
    const visits = [...toAdd, ...toUpdate.map((u) => u.remote)]
      .filter((r) => r.modified > 0)
      .map((r) => ({
        url: r.url,
        title: r.title || undefined,
        visits: [{ date: new Date(r.modified), transition: lazy.PlacesUtils.history.TRANSITIONS.LINK }],
      }));
    if (visits.length) {
      await lazy.PlacesUtils.history.insertMany(visits).catch((e) => console.warn("Jace: history insert", e));
    }
    if (toRemove.length) {
      await lazy.PlacesUtils.history.remove(toRemove.map((r) => r.url)).catch(() => {});
    }
  },
  // A page visit can't be "edited"; keep the newest visit time without fighting over titles.
  localDeletionCounts: () => true,
};

// ---------------------------------------------------------------- passwords

const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");

function loginKey(l) {
  return [l.origin, l.httpRealm ?? "", l.username ?? ""].join(SEP);
}

const passwords = {
  name: "passwords",
  async collect() {
    const out = {};
    for (const login of await Services.logins.getAllLogins()) {
      if (login.origin.startsWith(SECRETS_ORIGIN) || login.origin.startsWith("chrome://")) {
        continue; // Jace Browser's own secrets and other browser-internal entries never sync
      }
      login.QueryInterface(Ci.nsILoginMetaInfo);
      out[loginKey(login)] = {
        origin: login.origin,
        formActionOrigin: login.formActionOrigin ?? null,
        httpRealm: login.httpRealm ?? null,
        username: login.username ?? "",
        password: login.password,
        usernameField: login.usernameField ?? "",
        passwordField: login.passwordField ?? "",
        modified: login.timePasswordChanged ?? 0,
        _local: { guid: login.guid },
      };
    }
    return out;
  },
  async apply({ toAdd, toUpdate, toRemove }) {
    const make = (r) =>
      new LoginInfo(
        r.origin,
        r.httpRealm ? null : (r.formActionOrigin ?? ""),
        r.httpRealm ?? null,
        r.username,
        r.password,
        r.usernameField,
        r.passwordField,
      );
    const all = await Services.logins.getAllLogins();
    const byGuid = new Map(all.map((l) => [l.QueryInterface(Ci.nsILoginMetaInfo).guid, l]));
    for (const r of toAdd) {
      await Services.logins.addLoginAsync(make(r)).catch((e) => console.warn("Jace: add login", e));
    }
    for (const { local, remote } of toUpdate) {
      const existing = byGuid.get(local._local.guid);
      if (existing) {
        Services.logins.modifyLogin(existing, make(remote));
      }
    }
    for (const r of toRemove) {
      const existing = byGuid.get(r._local.guid);
      if (existing) {
        Services.logins.removeLogin(existing);
      }
    }
  },
};

// ---------------------------------------------------------------- cookies
// Records use the shared format in JaceCookies.sys.mjs, so the Jace
// extension can sync site sign-ins with Jace Browser.

const COOKIE_MAX = 20000;

function isDefaultContext(oa) {
  return !oa.userContextId && !oa.privateBrowsingId && !oa.firstPartyDomain && !oa.partitionKey && !oa.geckoViewSessionContextId;
}

/** Whether this Firefox's cookie expiry is in milliseconds (newer) or seconds (older). */
function geckoExpiryInMs() {
  for (const c of Services.cookies.cookies) {
    if (!c.isSession) return c.expiry > 1e11;
  }
  return Services.vc.compare(Services.appinfo.version, "138.0") >= 0;
}

const cookies = {
  name: "cookies",
  retain: (r) => retainCookie(r),
  // A session cookie vanishing because this device restarted isn't the person
  // signing out, so don't delete it from their other devices.
  localDeletionCounts(base) {
    return !base.session;
  },
  async collect() {
    const out = {};
    let count = 0;
    for (const c of Services.cookies.cookies) {
      if (!isDefaultContext(c.originAttributes) || c.value.length > COOKIE_VALUE_MAX) {
        continue;
      }
      if (++count > COOKIE_MAX) {
        break;
      }
      const r = fromGeckoCookie(c);
      out[cookieKey(r)] = r;
    }
    return out;
  },
  async apply({ toAdd, toUpdate, toRemove }) {
    const inMs = geckoExpiryInMs();
    for (const r of [...toAdd, ...toUpdate.map((u) => u.remote)]) {
      try {
        // (host, path, name, value, isSecure, isHttpOnly, isSession, expiry,
        //  originAttributes, sameSite, schemeMap, isPartitioned)
        const expiry = r.session ? Number.MAX_SAFE_INTEGER : inMs ? r.expires * 1000 : r.expires;
        Services.cookies.add(
          r.host,
          r.path,
          r.name,
          r.value,
          r.secure,
          r.httpOnly,
          r.session,
          expiry,
          {},
          toGeckoSameSite(r.sameSite),
          r.secure ? Ci.nsICookie.SCHEME_HTTPS : Ci.nsICookie.SCHEME_HTTP | Ci.nsICookie.SCHEME_HTTPS,
          false,
        );
      } catch (e) {
        console.warn(`Jace: couldn't set cookie ${r.name} for ${r.host}`, e);
      }
    }
    for (const r of toRemove) {
      try {
        Services.cookies.remove(r.host, r.name, r.path, {});
      } catch {}
    }
  },
};

// ---------------------------------------------------------------- tabs

const tabs = {
  name: "tabs",
  // One record per device. Other devices' tabs are shown in the account
  // panel and about:jace, never opened automatically.
  perDevice: true,
  async collect({ deviceId, deviceName }) {
    const list = [];
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        continue;
      }
      for (const tab of win.gBrowser.tabs) {
        const uri = tab.linkedBrowser.currentURI;
        if (!uri || !/^https?$/.test(uri.scheme)) {
          continue;
        }
        list.push({ url: uri.spec, title: tab.label, lastAccessed: tab.lastAccessed || 0 });
      }
    }
    list.sort((a, b) => b.lastAccessed - a.lastAccessed);
    return {
      [deviceId]: { device: deviceName, tabs: list.slice(0, 200).map(({ url, title }) => ({ url, title })), modified: Date.now() },
    };
  },
  async apply() {},
};

// ---------------------------------------------------------------- prefs

export const SYNCED_PREFS = [
  "sidebar.verticalTabs",
  "sidebar.visibility",
  "jace.theme.compact",
  "jace.theme.floatingContent",
  "jace.theme.accent",
  "jace.theme.id",
  "jace.theme.custom",
  "jace.tabs.verticalStyle",
  "jace.newtab.enabled",
  "jace.newtab.shortcuts",
  "jace.windowControls.style",
  "jace.startup.animation",
  "jace.account.autoSignIn",
  "browser.uidensity",
  "browser.startup.homepage",
  "browser.startup.page",
  "browser.newtabpage.enabled",
  "browser.tabs.closeWindowWithLastTab",
  "browser.urlbar.suggest.searches",
  "privacy.globalprivacycontrol.enabled",
  "privacy.trackingprotection.enabled",
  "layout.css.prefers-color-scheme.content-override",
];

function readPref(name) {
  switch (Services.prefs.getPrefType(name)) {
    case Ci.nsIPrefBranch.PREF_BOOL:
      return { type: "bool", value: Services.prefs.getBoolPref(name) };
    case Ci.nsIPrefBranch.PREF_INT:
      return { type: "int", value: Services.prefs.getIntPref(name) };
    case Ci.nsIPrefBranch.PREF_STRING:
      return { type: "string", value: Services.prefs.getStringPref(name) };
    default:
      return null;
  }
}

let lastPrefsSnapshot = null;

const prefs = {
  name: "prefs",
  async collect() {
    const out = {};
    const now = Date.now();
    for (const name of SYNCED_PREFS) {
      const v = readPref(name);
      if (v) {
        const prev = lastPrefsSnapshot?.[name];
        out[name] = { name, ...v, modified: prev && prev.value === v.value ? prev.modified : now };
      }
    }
    lastPrefsSnapshot = out;
    return out;
  },
  async apply({ toAdd, toUpdate }) {
    for (const r of [...toAdd, ...toUpdate.map((u) => u.remote)]) {
      if (!SYNCED_PREFS.includes(r.name)) {
        continue;
      }
      if (r.type === "bool") {
        Services.prefs.setBoolPref(r.name, !!r.value);
      } else if (r.type === "int") {
        Services.prefs.setIntPref(r.name, r.value | 0);
      } else if (r.type === "string") {
        Services.prefs.setStringPref(r.name, String(r.value));
      }
    }
  },
  localDeletionCounts: () => false,
};

// ---------------------------------------------------------------- add-ons

const addons = {
  name: "addons",
  // One record per device. Other devices' add-ons are listed in about:jace
  // with an Install button; never installed silently.
  perDevice: true,
  async collect({ deviceId, deviceName }) {
    const list = [];
    for (const a of await lazy.AddonManager.getAddonsByTypes(["extension", "theme"])) {
      if (a.isSystem || a.isBuiltin || a.hidden || !a.id) {
        continue;
      }
      list.push({ id: a.id, name: a.name, type: a.type });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    return { [deviceId]: { device: deviceName, addons: list, modified: Date.now() } };
  },
  async apply() {},
};

export const ENGINES = [bookmarks, history, passwords, cookies, tabs, prefs, addons];
