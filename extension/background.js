/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Jace extension's background page. Listeners are registered at the top
// level so Firefox can wake this (non-persistent) page for them.

import { REDIRECT_URI, finishSignIn } from "./lib/account.js";
import { syncNow } from "./lib/sync.js";
import { authorizeHeaderFor, signInToWebsite } from "./lib/websites.js";
import { notify } from "./lib/store.js";

const SYNC_MINUTES = 10;

// 1. Finish "Sign in with Jace": catch the tab's request to the loopback
//    redirect address, cancel it, and show our own "signed in" page instead.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details.url.startsWith(REDIRECT_URI)) return {};
    finishSignIn(details.url).then(
      (p) => {
        if (!p) return;
        browser.tabs.update(details.tabId, { url: browser.runtime.getURL("pages/signed-in.html#ok") });
        signInToWebsite().catch(() => {});
        syncNow().catch(() => {});
      },
      (e) => {
        notify("sign-in-failed", { message: e.message });
        browser.tabs.update(details.tabId, {
          url: browser.runtime.getURL(`pages/signed-in.html#failed:${encodeURIComponent(e.message)}`),
        });
      },
    );
    return { cancel: true };
  },
  { urls: ["http://127.0.0.1/*"], types: ["main_frame"] },
  ["blocking"],
);

// 2. Jace's own apps skip the consent screen (see lib/websites.js).
browser.webRequest.onBeforeSendHeaders.addListener(
  async (details) => {
    const header = await authorizeHeaderFor(details).catch(() => null);
    if (!header) return {};
    return { requestHeaders: [...details.requestHeaders.filter((h) => h.name.toLowerCase() !== "x-jace-browser-token"), header] };
  },
  { urls: ["https://*/oauth/authorize*", "http://localhost/oauth/authorize*", "http://127.0.0.1/oauth/authorize*"], types: ["main_frame"] },
  ["blocking", "requestHeaders"],
);

// 3. Sync every 10 minutes, and when Firefox starts.
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") syncNow().catch(() => {});
});

async function onStart() {
  await browser.alarms.create("sync", { periodInMinutes: SYNC_MINUTES, delayInMinutes: 1 });
  signInToWebsite().catch((e) => console.warn("Jace: website sign-in", e));
}

browser.runtime.onStartup.addListener(onStart);
browser.runtime.onInstalled.addListener(async ({ reason }) => {
  await onStart();
  if (reason === "install") {
    browser.runtime.openOptionsPage();
  }
});
