/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * "Sign in with Jace" for the extension. It uses the same public OAuth
 * client as Jace Browser (PKCE, no secret, loopback redirect), so its token
 * works with Jace's sync API and auto sign-in.
 *
 * Nothing listens on 127.0.0.1:47613: background.js watches for the tab's
 * request to the redirect address (webRequest), cancels it, and finishes
 * here. The pending sign-in is kept in storage.session so it survives the
 * background page being unloaded while you type your password.
 */

import { get, set, remove, notify } from "./store.js";

export const CLIENT_ID = "00000000-0000-0000-0000-000000000003";
export const REDIRECT_URI = "http://127.0.0.1:47613/jace-browser/callback";
const SCOPE = "profile sync";

export class JaceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function server() {
  return (await get("server", "https://jaceo.vercel.app")).replace(/\/+$/, "");
}

function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const randomString = (n = 32) => base64url(crypto.getRandomValues(new Uint8Array(n)));

async function sha256url(text) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

export async function profile() {
  return get("profile", null);
}

export async function token() {
  return get("token", null);
}

/** Opens Jace's sign-in page in a tab; finishSignIn() completes it. */
export async function startSignIn() {
  const verifier = randomString(48);
  const state = randomString(24);
  const url = new URL(`${await server()}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: await sha256url(verifier),
    code_challenge_method: "S256",
  }).toString();
  const tab = await browser.tabs.create({ url: url.href });
  await browser.storage.session.set({ pendingSignIn: { state, verifier, tabId: tab.id, at: Date.now() } });
}

/** Called by background.js with the redirect URL it intercepted. Returns the page to show in that tab. */
export async function finishSignIn(redirectUrl) {
  const { pendingSignIn } = await browser.storage.session.get("pendingSignIn");
  const params = new URL(redirectUrl).searchParams;
  if (!pendingSignIn || params.get("state") !== pendingSignIn.state) {
    return null; // not ours
  }
  await browser.storage.session.remove("pendingSignIn");
  if (params.get("error") || !params.get("code")) {
    throw new JaceError(params.get("error") || "cancelled", params.get("error_description") || "Sign-in was cancelled.");
  }
  const response = await fetch(`${await server()}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.get("code"),
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pendingSignIn.verifier,
    }).toString(),
    credentials: "omit",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new JaceError(body.error || "token_failed", body.error_description || `Jace said ${response.status}.`);
  }
  await set("token", body.access_token);
  const p = await refreshProfile();
  if (!p) throw new JaceError("userinfo_failed", "Couldn't read your Jace profile.");
  return p;
}

export async function refreshProfile() {
  const response = await jaceFetch("/api/oauth/userinfo");
  if (!response.ok) return null;
  const info = await response.json();
  const p = { sub: info.sub, username: info.username, name: info.name ?? info.username, picture: info.picture ?? null };
  await set("profile", p);
  notify("account-changed");
  return p;
}

/** fetch() against Jace with the bearer token. A 401 signs out (token revoked or expired). */
export async function jaceFetch(path, options = {}) {
  const t = await token();
  if (!t) throw new JaceError("signed_out", "Sign in to your Jace account first.");
  const response = await fetch(`${await server()}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), Authorization: `Bearer ${t}`, Accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
  });
  if (response.status === 401) {
    await signOut();
    throw new JaceError("signed_out", "Your Jace sign-in expired. Sign in again.");
  }
  return response;
}

export async function signOut() {
  await remove(["token", "profile", "syncKey", "syncStatus"]);
  const all = await browser.storage.local.get(null);
  await remove(Object.keys(all).filter((k) => k.startsWith("base:")));
  notify("account-changed");
}

/** A stable id and a readable name for this Firefox, sent with synced tabs. */
export async function device() {
  let id = await get("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    await set("deviceId", id);
  }
  let name = await get("deviceName");
  if (!name) {
    const { os } = await browser.runtime.getPlatformInfo();
    const osName = { win: "Windows", mac: "macOS", linux: "Linux", android: "Android" }[os] ?? os;
    name = `Firefox (Jace extension) on ${osName}`;
  }
  return { id, name };
}
