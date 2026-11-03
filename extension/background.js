/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Jace extension's background page. Listeners are registered at the top
// level so Firefox can wake this (non-persistent) page for them.

import { IS_CHROME } from "./lib/compat.js";
import { REDIRECT_URI, finishSignIn } from "./lib/account.js";
import { syncNow } from "./lib/sync.js";
import { authorizeHeaderFor, signInToWebsite, updateAuthorizeRule } from "./lib/websites.js";
import { notify } from "./lib/store.js";

const SYNC_MINUTES = 10;

// 1. Finish "Sign in with Jace": catch the tab's request to the loopback
//    redirect address, cancel it (Firefox; Chrome only lets extensions watch,
//    and the tab is sent on anyway), and show our own "signed in" page.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details.url.startsWith(REDIRECT_URI)) return IS_CHROME ? undefined : {};
    finishSignIn(details.url).then(
      (p) => {
        if (!p) return;
        browser.tabs.update(details.tabId, { url: browser.runtime.getURL("pages/signed-in.html#ok") });
        signInToWebsite().catch(() => {});
        updateAuthorizeRule().catch(() => {});
        syncNow().catch(() => {});
      },
      (e) => {
        notify("sign-in-failed", { message: e.message });
        browser.tabs.update(details.tabId, {
          url: browser.runtime.getURL(`pages/signed-in.html#failed:${encodeURIComponent(e.message)}`),
        });
      },
    );
    return IS_CHROME ? undefined : { cancel: true };
  },
  { urls: ["http://127.0.0.1/*"], types: ["main_frame"] },
  IS_CHROME ? [] : ["blocking"],
);

// 2. Jace's own apps skip the consent screen (see lib/websites.js).
if (IS_CHROME) {
  // Chrome: a header rule, refreshed when the account changes.
  let pending = null;
  browser.storage.onChanged.addListener((changes) => {
    // Only account changes (token, profile, auto sign-in) matter here.
    if (Object.keys(changes).every((k) => k.startsWith("base:") || k.startsWith("engine:") || ["syncStatus", "syncKey", "deviceId"].includes(k))) return;
    clearTimeout(pending);
    pending = setTimeout(() => updateAuthorizeRule().catch(() => {}), 500);
  });
} else {
  browser.webRequest.onBeforeSendHeaders.addListener(
    async (details) => {
      const header = await authorizeHeaderFor(details).catch(() => null);
      if (!header) return {};
      return { requestHeaders: [...details.requestHeaders.filter((h) => h.name.toLowerCase() !== "x-jace-browser-token"), header] };
    },
    { urls: ["https://*/oauth/authorize*", "http://localhost/oauth/authorize*", "http://127.0.0.1/oauth/authorize*"], types: ["main_frame"] },
    ["blocking", "requestHeaders"],
  );
}

// 3. Sync every 10 minutes, and when the browser starts.
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "sync") return;
  syncNow().catch(() => {});
  updateAuthorizeRule().catch(() => {});
});

async function onStart() {
  await browser.alarms.create("sync", { periodInMinutes: SYNC_MINUTES, delayInMinutes: 1 });
  updateAuthorizeRule().catch((e) => console.warn("Jace: website sign-in rule", e));
  signInToWebsite().catch((e) => console.warn("Jace: website sign-in", e));
}

browser.runtime.onStartup.addListener(onStart);
browser.runtime.onInstalled.addListener(async ({ reason }) => {
  await onStart();
  if (reason === "install") {
    browser.runtime.openOptionsPage();
  }
});
