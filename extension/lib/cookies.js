// Generated from src/jace/content/sync/JaceCookies.sys.mjs by extension/tools/sync-shared.py. Edit the original.
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The synced cookie format, shared by Jace Browser (JaceEngines, from
 * Firefox's nsICookie) and the Jace extension (from the WebExtension cookies
 * API), so both can sync site sign-ins with each other. No browser APIs
 * here; tests/cookies.test.mjs runs it under Node.
 *
 * Record:
 *   { host, path, name, value, secure, httpOnly, session,
 *     expires,   // seconds since 1970, 0 for a session cookie
 *     sameSite,  // "none" | "lax" | "strict" | "unset"
 *     modified } // ms, only a tie-breaker for the merge
 * host keeps Firefox's convention: ".example.com" for a domain cookie,
 * "example.com" for a host-only cookie.
 */

export const SEP = "\u001f";
export const COOKIE_VALUE_MAX = 4096;

export function cookieKey(r) {
  return [r.host, r.path, r.name].join(SEP);
}

export function retainCookie(r, now = Date.now()) {
  return r.session || r.expires * 1000 > now;
}

// ---- Firefox internals (nsICookie) ----

const GECKO_SAMESITE = { 0: "none", 1: "lax", 2: "strict", 256: "unset" };
const GECKO_SAMESITE_BACK = { none: 0, lax: 1, strict: 2, unset: 256 };

/** nsICookie.expiry is seconds in older Firefox and milliseconds in newer. */
export function geckoExpiryToSeconds(expiry) {
  return Math.floor(expiry > 1e11 ? expiry / 1000 : expiry);
}

export function fromGeckoCookie(c) {
  return {
    host: c.host,
    path: c.path,
    name: c.name,
    value: c.value,
    secure: !!c.isSecure,
    httpOnly: !!c.isHttpOnly,
    session: !!c.isSession,
    expires: c.isSession ? 0 : geckoExpiryToSeconds(c.expiry),
    sameSite: GECKO_SAMESITE[c.sameSite] ?? "unset",
    modified: Math.floor((c.lastAccessed ?? c.creationTime ?? 0) / 1000),
  };
}

export function toGeckoSameSite(name) {
  return GECKO_SAMESITE_BACK[name] ?? 256;
}

// ---- WebExtension cookies API ----

const EXT_SAMESITE = { no_restriction: "none", lax: "lax", strict: "strict", unspecified: "unset" };
const EXT_SAMESITE_BACK = { none: "no_restriction", lax: "lax", strict: "strict", unset: "unspecified" };

export function fromExtensionCookie(c) {
  return {
    host: c.hostOnly ? c.domain.replace(/^\./, "") : c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
    path: c.path,
    name: c.name,
    value: c.value,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    session: !!c.session,
    expires: c.session ? 0 : Math.floor(c.expirationDate ?? 0),
    sameSite: EXT_SAMESITE[c.sameSite] ?? "unset",
    modified: 0,
  };
}

/** The details for browser.cookies.set() that recreate a record. */
export function toExtensionCookieDetails(r) {
  const bareHost = r.host.replace(/^\./, "");
  const details = {
    url: `${r.secure ? "https" : "http"}://${bareHost}${r.path.startsWith("/") ? r.path : `/${r.path}`}`,
    name: r.name,
    value: r.value,
    path: r.path,
    secure: r.secure,
    httpOnly: r.httpOnly,
    sameSite: EXT_SAMESITE_BACK[r.sameSite] ?? "unspecified",
  };
  // A leading dot means a domain cookie; leaving domain out makes it host-only.
  if (r.host.startsWith(".")) details.domain = r.host;
  if (!r.session && r.expires) details.expirationDate = r.expires;
  return details;
}

/** The details for browser.cookies.remove(). */
export function toExtensionCookieRemoval(r) {
  const bareHost = r.host.replace(/^\./, "");
  return { url: `${r.secure ? "https" : "http"}://${bareHost}${r.path}`, name: r.name };
}
