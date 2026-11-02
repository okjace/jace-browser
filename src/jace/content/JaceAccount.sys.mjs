/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * "Sign in with Jace" for the browser itself.
 *
 * Jace Browser is a public OAuth client (like Jace OS): it uses the
 * authorization-code flow with PKCE and a loopback redirect URI,
 * http://127.0.0.1:47613/jace-browser/callback. Nothing listens on that
 * port; we watch for the browser's own request to it (http-on-modify-request),
 * cancel it, and take the code from the URL. The code is then exchanged at
 * /api/oauth/token and the profile read from /api/oauth/userinfo.
 *
 * The access token is kept in the password manager (encrypted on disk, and
 * behind the primary password if one is set), never in prefs.
 */

import { JaceSecrets } from "chrome://jace/content/JaceSecrets.sys.mjs";

const PREF_SERVER = "jace.account.server";
const PREF_CLIENT_ID = "jace.account.clientId";
const PREF_PORT = "jace.account.redirectPort";
const PREF_PROFILE = "jace.account.profile"; // JSON: { sub, username, name, picture }
const PREF_DEVICE_NAME = "jace.account.deviceName";
const PREF_DEVICE_ID = "jace.account.deviceId";

const TOKEN_SECRET = "account-token";
const SCOPE = "profile sync";
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

export const ACCOUNT_CHANGED_TOPIC = "jace-account-changed";

function base64url(bytes) {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Base64url(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return base64url(new Uint8Array(digest));
}

function notify() {
  Services.obs.notifyObservers(null, ACCOUNT_CHANGED_TOPIC);
}

/** One pending sign-in at a time. */
let pending = null;

export class JaceAccountError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const JaceAccount = {
  get server() {
    return Services.prefs.getStringPref(PREF_SERVER, "https://jaceo.vercel.app").replace(/\/+$/, "");
  },

  get clientId() {
    return Services.prefs.getStringPref(PREF_CLIENT_ID, "00000000-0000-0000-0000-000000000003");
  },

  get redirectUri() {
    return `http://127.0.0.1:${Services.prefs.getIntPref(PREF_PORT, 47613)}/jace-browser/callback`;
  },

  /** The signed-in account's public profile, or null. */
  get profile() {
    try {
      const json = Services.prefs.getStringPref(PREF_PROFILE, "");
      return json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  },

  get signedIn() {
    return !!this.profile;
  },

  get signingIn() {
    return !!pending;
  },

  /** A stable id for this browser profile, sent with synced tabs. */
  get deviceId() {
    let id = Services.prefs.getStringPref(PREF_DEVICE_ID, "");
    if (!id) {
      id = Services.uuid.generateUUID().toString().slice(1, -1);
      Services.prefs.setStringPref(PREF_DEVICE_ID, id);
    }
    return id;
  },

  get deviceName() {
    const custom = Services.prefs.getStringPref(PREF_DEVICE_NAME, "");
    if (custom) {
      return custom;
    }
    let host = "";
    try {
      host = Services.dns.myHostName;
    } catch {}
    const os = Services.appinfo.OS === "WINNT" ? "Windows" : Services.appinfo.OS === "Darwin" ? "macOS" : "Linux";
    return host ? `Jace Browser on ${host}` : `Jace Browser on ${os}`;
  },

  set deviceName(name) {
    Services.prefs.setStringPref(PREF_DEVICE_NAME, String(name ?? "").slice(0, 80));
  },

  /**
   * Opens the Jace sign-in page in a new tab and resolves with the profile
   * once the person approves (or rejects with a JaceAccountError).
   */
  async signIn(win) {
    if (pending) {
      const gBrowser = pending.tab?.ownerGlobal?.gBrowser;
      if (gBrowser && pending.tab.isConnected) {
        gBrowser.selectedTab = pending.tab;
      }
      return pending.promise;
    }
    win ??= Services.wm.getMostRecentWindow("navigator:browser");
    if (!win) {
      throw new JaceAccountError("no_window", "Open a browser window first.");
    }

    const verifier = randomString(48);
    const state = randomString(24);
    const challenge = await sha256Base64url(verifier);
    const url = new URL(`${this.server}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const redirectPrefix = this.redirectUri;

    const observer = {
      observe: (subject) => {
        let channel;
        try {
          channel = subject.QueryInterface(Ci.nsIHttpChannel);
        } catch {
          return;
        }
        const spec = channel.URI.spec;
        if (!spec.startsWith(redirectPrefix)) {
          return;
        }
        channel.cancel(Cr.NS_BINDING_ABORTED);
        const params = new URL(spec).searchParams;
        const browser = channel.loadInfo?.browsingContext?.top?.embedderElement;
        finish(params, browser);
      },
    };

    const cleanup = () => {
      Services.obs.removeObserver(observer, "http-on-modify-request");
      win.clearTimeout(timer);
      pending = null;
      notify();
    };

    const finish = async (params, browser) => {
      if (params.get("state") !== state) {
        return; // not ours (or a stale tab); keep waiting
      }
      cleanup();
      const error = params.get("error");
      const code = params.get("code");
      try {
        if (error || !code) {
          throw new JaceAccountError(error || "no_code", params.get("error_description") || "Sign-in was cancelled.");
        }
        const profile = await this._finishSignIn(code, verifier);
        browser?.loadURI?.(Services.io.newURI("about:jace#signed-in"), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        resolve(profile);
      } catch (e) {
        browser?.loadURI?.(Services.io.newURI("about:jace#sign-in-failed"), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        reject(e instanceof JaceAccountError ? e : new JaceAccountError("sign_in_failed", String(e?.message ?? e)));
      }
    };

    const timer = win.setTimeout(() => {
      cleanup();
      reject(new JaceAccountError("timeout", "Sign-in took too long. Try again."));
    }, SIGN_IN_TIMEOUT_MS);

    Services.obs.addObserver(observer, "http-on-modify-request");
    const tab = win.gBrowser.addTrustedTab(url.href, { inBackground: false });
    win.gBrowser.selectedTab = tab;
    pending = { promise, tab };
    notify();
    return promise;
  },

  async _finishSignIn(code, verifier) {
    const response = await fetch(`${this.server}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: verifier,
      }).toString(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      throw new JaceAccountError(body.error || "token_failed", body.error_description || `Jace said ${response.status}.`);
    }
    if (!String(body.scope ?? "").split(" ").includes("sync")) {
      // Still signed in, but sync will tell the person it isn't allowed.
      console.warn("Jace: token has no sync scope:", body.scope);
    }
    await JaceSecrets.set(TOKEN_SECRET, body.access_token);
    const profile = await this.refreshProfile();
    if (!profile) {
      throw new JaceAccountError("userinfo_failed", "Couldn't read your Jace profile.");
    }
    return profile;
  },

  async getToken() {
    return JaceSecrets.get(TOKEN_SECRET);
  },

  /** Re-reads the profile from Jace (name or picture may have changed). */
  async refreshProfile() {
    const response = await this.fetch("/api/oauth/userinfo");
    if (!response.ok) {
      return null;
    }
    const info = await response.json();
    const profile = {
      sub: info.sub,
      username: info.username,
      name: info.name ?? info.username,
      picture: info.picture ?? null,
    };
    Services.prefs.setStringPref(PREF_PROFILE, JSON.stringify(profile));
    notify();
    return profile;
  },

  /**
   * fetch() against the Jace server with the account's bearer token. A 401
   * means the token was revoked (disconnected under Connected apps) or
   * expired, so we sign out locally.
   */
  async fetch(path, options = {}) {
    const token = await this.getToken();
    if (!token) {
      throw new JaceAccountError("signed_out", "Sign in to your Jace account first.");
    }
    const headers = { ...(options.headers ?? {}), Authorization: `Bearer ${token}`, Accept: "application/json" };
    const response = await fetch(`${this.server}${path}`, { ...options, headers, credentials: "omit", cache: "no-store" });
    if (response.status === 401) {
      await this.signOut({ reason: "expired" });
      throw new JaceAccountError("signed_out", "Your Jace sign-in expired. Sign in again.");
    }
    return response;
  },

  async signOut({ reason = "user" } = {}) {
    await JaceSecrets.remove(TOKEN_SECRET);
    Services.prefs.clearUserPref(PREF_PROFILE);
    Services.obs.notifyObservers(null, "jace-account-signed-out", reason);
    notify();
  },
};
