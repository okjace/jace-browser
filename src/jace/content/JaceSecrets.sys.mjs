/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Small secrets (the Jace access token, the sync key) stored in the
 * password manager under a chrome://jace-secrets origin, so they get the
 * same on-disk encryption (and primary password) as saved passwords.
 * The passwords sync engine skips this origin.
 */

export const SECRETS_ORIGIN = "chrome://jace-secrets";
const REALM = "Jace Browser";

const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");

async function find(name) {
  const logins = await Services.logins.searchLoginsAsync({ origin: SECRETS_ORIGIN, httpRealm: REALM });
  return logins.find((l) => l.username === name) ?? null;
}

export const JaceSecrets = {
  async get(name) {
    try {
      return (await find(name))?.password ?? null;
    } catch (e) {
      // e.g. the primary password prompt was cancelled
      console.warn("Jace: couldn't read a secret", e);
      return null;
    }
  },

  async set(name, value) {
    const existing = await find(name);
    const info = new LoginInfo(SECRETS_ORIGIN, null, REALM, name, value, "", "");
    if (existing) {
      Services.logins.modifyLogin(existing, info);
    } else {
      await Services.logins.addLoginAsync(info);
    }
  },

  async remove(name) {
    const existing = await find(name);
    if (existing) {
      Services.logins.removeLogin(existing);
    }
  },
};
