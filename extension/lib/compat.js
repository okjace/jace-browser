/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One extension for Firefox and Chrome: Chrome has the same WebExtension
// APIs under `chrome` (returning promises in Manifest V3). Imported first by
// every file that uses `browser`.

if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined") {
  globalThis.browser = globalThis.chrome;
}

/** Chrome (or Edge, Brave, ...) rather than Firefox. */
// (Firefox also has a `chrome` object, but only Firefox has getBrowserInfo.)
export const IS_CHROME = !!globalThis.chrome?.runtime && typeof globalThis.browser?.runtime?.getBrowserInfo !== "function";
