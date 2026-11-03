/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Signs Firefox in to Jace websites with the extension's Jace account, the
 * same two ways Jace Browser does (see okjace/Jace lib/browserSignIn.ts):
 *
 * 1. The Jace website: POST /api/oauth/browser-session with the token, which
 *    sets the site's normal session cookie - unless someone is already
 *    signed in there.
 * 2. Jace's own apps: background.js adds X-Jace-Browser-Token to top-level
 *    visits to the Jace site's /oauth/authorize, so those apps skip the
 *    consent screen. Never in private windows or container tabs.
 */

import { IS_CHROME } from "./compat.js";
import { get } from "./store.js";
import { profile, server, token } from "./account.js";

export async function autoSignIn() {
  return get("autoSignIn", true);
}

/** Returns true if it signed the website in. */
export async function signInToWebsite() {
  if (!(await autoSignIn()) || !(await profile())) return false;
  const t = await token();
  if (!t) return false;
  const base = await server();
  const session = await fetch(`${base}/api/auth/session`, { credentials: "include", cache: "no-store" });
  const existing = session.ok ? await session.json().catch(() => null) : null;
  if (existing?.user) return false;
  const response = await fetch(`${base}/api/oauth/browser-session`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { Authorization: `Bearer ${t}`, "X-Jace-Browser": "1", Accept: "application/json" },
  });
  if (!response.ok) {
    console.warn("Jace: website sign-in answered", response.status);
    return false;
  }
  return !!(await response.json()).changed;
}

/** The X-Jace-Browser-Token header to add to this request, or null. */
export async function authorizeHeaderFor(details) {
  if (details.type !== "main_frame" || details.incognito) return null;
  if (details.cookieStoreId && details.cookieStoreId !== "firefox-default") return null;
  const base = new URL(await server());
  const url = new URL(details.url);
  if (url.origin !== base.origin || !url.pathname.startsWith("/oauth/authorize")) return null;
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) return null;
  if (!(await autoSignIn())) return null;
  const t = await token();
  return t ? { name: "X-Jace-Browser-Token", value: t } : null;
}

const AUTHORIZE_RULE = 1;

/**
 * Chrome: extensions can't change requests on the fly there, so the
 * X-Jace-Browser-Token header comes from a declarativeNetRequest rule for the
 * Jace site's /oauth/authorize, kept up to date with the account (call this
 * after signing in or out, and now and then: the token changes).
 * Chrome only runs extensions in incognito windows if you allow it.
 */
export async function updateAuthorizeRule() {
  if (!IS_CHROME || !browser.declarativeNetRequest) return;
  let addRules = [];
  if ((await autoSignIn()) && (await profile())) {
    const t = await token().catch(() => null);
    const base = new URL(await server());
    if (t && (base.protocol === "https:" || ["localhost", "127.0.0.1"].includes(base.hostname))) {
      addRules = [
        {
          id: AUTHORIZE_RULE,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders: [{ header: "X-Jace-Browser-Token", operation: "set", value: t }] },
          condition: { urlFilter: `|${base.origin}/oauth/authorize`, resourceTypes: ["main_frame"] },
        },
      ];
    }
  }
  await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [AUTHORIZE_RULE], addRules });
}
