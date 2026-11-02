/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Jace sync: keeps bookmarks, history, passwords, cookies (site sign-ins),
 * open tabs, a few settings, and the add-on list the same on every Jace
 * Browser signed in to the same Jace account.
 *
 * Storage is Jace's /api/oauth/sync (one encrypted blob per collection, with
 * a version number for optimistic concurrency). Encryption is JaceCrypto;
 * merging is JaceMerge; what each collection contains is JaceEngines.
 *
 * The first time a Jace account turns on sync, the person picks a sync
 * passphrase. On each other device they sign in to Jace and enter the same
 * passphrase once; after that sync (and the sign-ins to every site they were
 * signed in to) just happens.
 */

import { JaceAccount } from "chrome://jace/content/JaceAccount.sys.mjs";
import { JaceSecrets } from "chrome://jace/content/JaceSecrets.sys.mjs";
import { JaceCrypto } from "chrome://jace/content/sync/JaceCrypto.sys.mjs";
import { threeWayMerge, sameRecord } from "chrome://jace/content/sync/JaceMerge.sys.mjs";
import { ENGINES } from "chrome://jace/content/sync/JaceEngines.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const KEY_SECRET = "sync-key";
const PREF_STATUS = "jace.sync.status";
const DEVICE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export const SYNC_STATUS_TOPIC = "jace-sync-status";

export class JaceSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function baseFile(name) {
  return PathUtils.join(PathUtils.profileDir, "jace-sync", `${name}.json`);
}

async function readBase(name) {
  try {
    return await IOUtils.readJSON(baseFile(name));
  } catch {
    return {};
  }
}

async function writeBase(name, data) {
  await IOUtils.makeDirectory(PathUtils.join(PathUtils.profileDir, "jace-sync"), { ignoreExisting: true });
  await IOUtils.writeJSON(baseFile(name), data, { tmpPath: `${baseFile(name)}.tmp` });
}

async function clearBases() {
  await IOUtils.remove(PathUtils.join(PathUtils.profileDir, "jace-sync"), { recursive: true, ignoreAbsent: true });
}

async function api(path, options) {
  const response = await JaceAccount.fetch(`/api/oauth/sync${path}`, options);
  if (response.status === 403) {
    const body = await response.json().catch(() => ({}));
    throw new JaceSyncError(
      body.error || "forbidden",
      body.error === "insufficient_scope"
        ? "Jace didn't allow sync for this sign-in. Sign out and sign in again."
        : body.error_description || "Jace refused the sync request.",
    );
  }
  return response;
}

async function getCollection(name) {
  const response = await api(`/${name}`);
  if (response.status === 404) {
    return { version: 0, payload: null };
  }
  if (!response.ok) {
    throw new JaceSyncError("server", `Jace sync answered ${response.status}.`);
  }
  const body = await response.json();
  return { version: body.version, payload: body.payload, updatedBy: body.updated_by };
}

/** Returns the new version, or null on a version conflict. */
async function putCollection(name, payload, version) {
  const response = await api(`/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": `"${version}"` },
    body: JSON.stringify({ payload, device: JaceAccount.deviceName }),
  });
  if (response.status === 412) {
    return null;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new JaceSyncError(body.error || "server", body.error_description || `Jace sync answered ${response.status}.`);
  }
  return (await response.json()).version;
}

let timer = null;
let running = null;
let started = false;

function setStatus(patch) {
  const status = { ...JaceSync.status, ...patch };
  Services.prefs.setStringPref(PREF_STATUS, JSON.stringify(status));
  Services.obs.notifyObservers(null, SYNC_STATUS_TOPIC);
}

export const JaceSync = {
  ENGINE_NAMES: ENGINES.map((e) => e.name),

  /** { state: "idle"|"syncing"|"needs-passphrase"|"error"|"off", lastSync, error } */
  get status() {
    try {
      return JSON.parse(Services.prefs.getStringPref(PREF_STATUS, "{}"));
    } catch {
      return {};
    }
  },

  get enabled() {
    return Services.prefs.getBoolPref("jace.sync.enabled", true);
  },

  engineEnabled(name) {
    return Services.prefs.getBoolPref(`jace.sync.engine.${name}`, true);
  },

  setEngineEnabled(name, on) {
    Services.prefs.setBoolPref(`jace.sync.engine.${name}`, !!on);
  },

  async hasKey() {
    return !!(await JaceSecrets.get(KEY_SECRET));
  },

  /** Whether this Jace account already has sync set up (from another device). */
  async accountHasSync() {
    const keys = await getCollection("keys");
    return keys.version > 0;
  },

  /**
   * Sets this device's sync key from the passphrase. If the account has no
   * sync yet, this creates it; otherwise the passphrase must match the one
   * used on the other devices. Then syncs right away (which also signs this
   * browser in to the sites the person is signed in to elsewhere).
   */
  async setPassphrase(passphrase) {
    if (!JaceAccount.signedIn) {
      throw new JaceSyncError("signed_out", "Sign in to your Jace account first.");
    }
    if (typeof passphrase !== "string" || passphrase.length < 8) {
      throw new JaceSyncError("weak_passphrase", "Use a sync passphrase of at least 8 characters.");
    }
    const keys = await getCollection("keys");
    let created = false;
    if (keys.version > 0) {
      const record = JaceCrypto.decodeKeysRecord(keys.payload);
      const key = await JaceCrypto.deriveKey(passphrase, record.salt, record.rounds);
      if (!(await JaceCrypto.checkKey(key, record))) {
        throw new JaceSyncError("wrong_passphrase", "That isn't the sync passphrase you used on your other devices.");
      }
      await JaceSecrets.set(KEY_SECRET, key);
    } else {
      const salt = JaceCrypto.newSalt();
      const key = await JaceCrypto.deriveKey(passphrase, salt);
      const record = await JaceCrypto.makeKeysRecord(key, salt);
      const version = await putCollection("keys", JaceCrypto.encodeKeysRecord(record), 0);
      if (version === null) {
        // Another device created sync at the same moment; use theirs.
        return this.setPassphrase(passphrase);
      }
      await JaceSecrets.set(KEY_SECRET, key);
      created = true;
    }
    await clearBases(); // first sync on this device merges everything
    setStatus({ state: "idle", error: null });
    this.syncNow().catch(() => {});
    return { created };
  },

  /** Deletes all synced data on Jace and forgets the key everywhere (other devices will ask for a new passphrase). */
  async resetAccountData() {
    const response = await api("", { method: "DELETE" });
    if (!response.ok) {
      throw new JaceSyncError("server", `Jace sync answered ${response.status}.`);
    }
    await this.forgetDevice();
  },

  /** Forgets the sync key and sync state on this device only. */
  async forgetDevice() {
    await JaceSecrets.remove(KEY_SECRET);
    await clearBases();
    setStatus({ state: "needs-passphrase", lastSync: null, error: null });
  },

  /** Other devices' open tabs: [{ device, tabs: [{url, title}], modified }]. */
  async remoteTabs() {
    return this._otherDevices("tabs");
  },

  /** Other devices' add-ons: [{ device, addons: [{id, name, type}], modified }]. */
  async remoteAddons() {
    return this._otherDevices("addons");
  },

  async _otherDevices(name) {
    const base = await readBase(name);
    return Object.entries(base)
      .filter(([id]) => id !== JaceAccount.deviceId)
      .map(([, v]) => v)
      .sort((a, b) => b.modified - a.modified);
  },

  start({ firstSyncDelayMs = 15_000 } = {}) {
    if (started) {
      return;
    }
    started = true;
    Services.obs.addObserver(() => this.forgetDevice().catch(() => {}), "jace-account-signed-out");
    Services.obs.addObserver(() => this.syncNow().catch(() => {}), "jace-account-changed");
    this._schedule(firstSyncDelayMs);
  },

  stop() {
    if (timer) {
      lazy.clearTimeout(timer);
      timer = null;
    }
    started = false;
  },

  _schedule(delayMs) {
    if (timer) {
      lazy.clearTimeout(timer);
    }
    timer = lazy.setTimeout(async () => {
      timer = null;
      await this.syncNow().catch(() => {});
      if (started) {
        this._schedule(Services.prefs.getIntPref("jace.sync.intervalSeconds", 600) * 1000);
      }
    }, delayMs);
  },

  /** Syncs every enabled engine. Concurrent calls share one run. */
  syncNow() {
    if (!running) {
      running = this._sync().finally(() => {
        running = null;
      });
    }
    return running;
  },

  async _sync() {
    if (!this.enabled) {
      setStatus({ state: "off" });
      return;
    }
    if (!JaceAccount.signedIn) {
      return;
    }
    const key = await JaceSecrets.get(KEY_SECRET);
    if (!key) {
      setStatus({ state: "needs-passphrase" });
      return;
    }
    setStatus({ state: "syncing", error: null });
    try {
      // If someone reset sync or changed the passphrase on another device, stop and ask again.
      const keys = await getCollection("keys");
      if (keys.version === 0 || !(await JaceCrypto.checkKey(key, JaceCrypto.decodeKeysRecord(keys.payload)))) {
        await this.forgetDevice();
        return;
      }
      const errors = [];
      for (const engine of ENGINES) {
        if (!this.engineEnabled(engine.name)) {
          continue;
        }
        try {
          await this._syncEngine(engine, key);
        } catch (e) {
          if (e?.code === "signed_out") {
            throw e;
          }
          console.error(`Jace sync: ${engine.name} failed`, e);
          errors.push(`${engine.name}: ${e?.message ?? e}`);
        }
      }
      setStatus({ state: errors.length ? "error" : "idle", lastSync: Date.now(), error: errors.join("; ") || null });
    } catch (e) {
      setStatus({ state: e?.code === "signed_out" ? "off" : "error", error: String(e?.message ?? e) });
      throw e;
    }
  },

  async _syncEngine(engine, key) {
    const ctx = { deviceId: JaceAccount.deviceId, deviceName: JaceAccount.deviceName };
    for (let attempt = 0; attempt < 3; attempt++) {
      const remoteRec = await getCollection(engine.name);
      const remote = remoteRec.payload ? await JaceCrypto.decrypt(key, engine.name, remoteRec.payload) : {};
      const local = await engine.collect(ctx);

      let merged;
      let remoteChanged;
      if (engine.perDevice) {
        merged = { ...remote, ...local };
        const cutoff = Date.now() - DEVICE_STALE_MS;
        for (const [id, rec] of Object.entries(merged)) {
          if (id !== ctx.deviceId && (rec.modified ?? 0) < cutoff) {
            delete merged[id];
          }
        }
        remoteChanged =
          Object.keys(merged).length !== Object.keys(remote).length ||
          !sameRecord(remote[ctx.deviceId], local[ctx.deviceId]);
      } else {
        const base = await readBase(engine.name);
        const result = threeWayMerge({
          local,
          remote,
          base,
          retain: engine.retain ?? (() => true),
          localDeletionCounts: engine.localDeletionCounts ?? (() => true),
        });
        await engine.apply(result);
        merged = result.merged;
        remoteChanged = result.remoteChanged || remoteRec.version === 0;
      }

      if (remoteChanged) {
        const payload = await JaceCrypto.encrypt(key, engine.name, merged);
        const version = await putCollection(engine.name, payload, remoteRec.version);
        if (version === null) {
          continue; // another device wrote first: merge again with theirs
        }
      }
      await writeBase(engine.name, merged);
      return;
    }
    throw new JaceSyncError("busy", "Another device kept syncing at the same time; will try again later.");
  },
};
