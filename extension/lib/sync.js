/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Jace sync for the extension: the same protocol as Jace Browser's JaceSync
 * (one encrypted blob per collection on Jace's /api/oauth/sync, a version
 * number per write, a three-way merge), so Firefox with the extension and
 * Jace Browser keep each other's bookmarks, history, tabs and site sign-ins
 * up to date. Collections the extension can't use (passwords, prefs,
 * add-ons) are left alone.
 */

import { JaceCrypto } from "./crypto.js";
import { threeWayMerge, sameRecord } from "./merge.js";
import { ENGINES } from "./engines.js";
import { jaceFetch, profile, device, JaceError } from "./account.js";
import { get, set, remove, notify } from "./store.js";

const DEVICE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
export const ENGINE_NAMES = ENGINES.map((e) => e.name);

async function api(path, options) {
  const response = await jaceFetch(`/api/oauth/sync${path}`, options);
  if (response.status === 403) {
    const body = await response.json().catch(() => ({}));
    throw new JaceError(body.error || "forbidden", body.error_description || "Jace refused the sync request.");
  }
  return response;
}

async function getCollection(name) {
  const response = await api(`/${name}`);
  if (response.status === 404) return { version: 0, payload: null };
  if (!response.ok) throw new JaceError("server", `Jace sync answered ${response.status}.`);
  const body = await response.json();
  return { version: body.version, payload: body.payload };
}

/** The new version, or null on a version conflict. */
async function putCollection(name, payload, version) {
  const { name: deviceName } = await device();
  const response = await api(`/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": `"${version}"` },
    body: JSON.stringify({ payload, device: deviceName }),
  });
  if (response.status === 412) return null;
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new JaceError(body.error || "server", body.error_description || `Jace sync answered ${response.status}.`);
  }
  return (await response.json()).version;
}

export async function status() {
  return get("syncStatus", {});
}

async function setStatus(patch) {
  await set("syncStatus", { ...(await status()), ...patch });
  notify("sync-status");
}

export async function engineEnabled(name) {
  return get(`engine:${name}`, true);
}

export async function setEngineEnabled(name, on) {
  await set(`engine:${name}`, !!on);
}

export async function hasKey() {
  return !!(await get("syncKey"));
}

export async function accountHasSync() {
  return (await getCollection("keys")).version > 0;
}

/** Same rules as Jace Browser: creates sync, or checks the passphrase matches the other devices'. */
export async function setPassphrase(passphrase) {
  if (!(await profile())) throw new JaceError("signed_out", "Sign in to your Jace account first.");
  if (typeof passphrase !== "string" || passphrase.length < 8) {
    throw new JaceError("weak_passphrase", "Use a sync passphrase of at least 8 characters.");
  }
  const keys = await getCollection("keys");
  let created = false;
  if (keys.version > 0) {
    const record = JaceCrypto.decodeKeysRecord(keys.payload);
    const key = await JaceCrypto.deriveKey(passphrase, record.salt, record.rounds);
    if (!(await JaceCrypto.checkKey(key, record))) {
      throw new JaceError("wrong_passphrase", "That isn't the sync passphrase you used on your other devices.");
    }
    await set("syncKey", key);
  } else {
    const salt = JaceCrypto.newSalt();
    const key = await JaceCrypto.deriveKey(passphrase, salt);
    const version = await putCollection("keys", JaceCrypto.encodeKeysRecord(await JaceCrypto.makeKeysRecord(key, salt)), 0);
    if (version === null) return setPassphrase(passphrase);
    await set("syncKey", key);
    created = true;
  }
  await clearBases();
  await setStatus({ state: "idle", error: null });
  syncNow().catch(() => {});
  return { created };
}

async function clearBases() {
  const all = await browser.storage.local.get(null);
  await remove(Object.keys(all).filter((k) => k.startsWith("base:")));
}

export async function forgetDevice() {
  await remove("syncKey");
  await clearBases();
  await setStatus({ state: "needs-passphrase", lastSync: null, error: null });
}

export async function resetAccountData() {
  const response = await api("", { method: "DELETE" });
  if (!response.ok) throw new JaceError("server", `Jace sync answered ${response.status}.`);
  await forgetDevice();
}

/** Other devices' open tabs: [{ device, tabs: [{url, title}], modified }]. */
export async function remoteTabs() {
  const { id } = await device();
  const base = await get("base:tabs", {});
  return Object.entries(base)
    .filter(([deviceId]) => deviceId !== id)
    .map(([, v]) => v)
    .sort((a, b) => b.modified - a.modified);
}

let running = null;

/** Syncs every enabled engine; concurrent calls share one run. */
export function syncNow() {
  running ??= runSync().finally(() => (running = null));
  return running;
}

async function runSync() {
  if (!(await profile())) return;
  const key = await get("syncKey");
  if (!key) {
    await setStatus({ state: "needs-passphrase" });
    return;
  }
  await setStatus({ state: "syncing", error: null });
  try {
    const keys = await getCollection("keys");
    if (keys.version === 0 || !(await JaceCrypto.checkKey(key, JaceCrypto.decodeKeysRecord(keys.payload)))) {
      await forgetDevice(); // reset or passphrase changed on another device
      return;
    }
    const errors = [];
    for (const engine of ENGINES) {
      if (!(await engineEnabled(engine.name))) continue;
      try {
        await syncEngine(engine, key);
      } catch (e) {
        if (e?.code === "signed_out") throw e;
        console.error(`Jace sync: ${engine.name}`, e);
        errors.push(`${engine.name}: ${e?.message ?? e}`);
      }
    }
    await setStatus({ state: errors.length ? "error" : "idle", lastSync: Date.now(), error: errors.join("; ") || null });
  } catch (e) {
    await setStatus({ state: e?.code === "signed_out" ? "off" : "error", error: String(e?.message ?? e) });
    throw e;
  }
}

async function syncEngine(engine, key) {
  const { id: deviceId, name: deviceName } = await device();
  for (let attempt = 0; attempt < 3; attempt++) {
    const remoteRec = await getCollection(engine.name);
    const remote = remoteRec.payload ? await JaceCrypto.decrypt(key, engine.name, remoteRec.payload) : {};
    const local = await engine.collect({ deviceId, deviceName });

    let merged;
    let remoteChanged;
    if (engine.perDevice) {
      merged = { ...remote, ...local };
      const cutoff = Date.now() - DEVICE_STALE_MS;
      for (const [id, rec] of Object.entries(merged)) {
        if (id !== deviceId && (rec.modified ?? 0) < cutoff) delete merged[id];
      }
      remoteChanged = Object.keys(merged).length !== Object.keys(remote).length || !sameRecord(remote[deviceId], local[deviceId]);
    } else {
      const result = threeWayMerge({
        local,
        remote,
        base: await get(`base:${engine.name}`, {}),
        retain: engine.retain ?? (() => true),
        localDeletionCounts: engine.localDeletionCounts ?? (() => true),
      });
      await engine.apply(result);
      merged = result.merged;
      remoteChanged = result.remoteChanged || remoteRec.version === 0;
    }

    if (remoteChanged) {
      const version = await putCollection(engine.name, await JaceCrypto.encrypt(key, engine.name, merged), remoteRec.version);
      if (version === null) continue; // another device wrote first: merge again
    }
    await set(`base:${engine.name}`, merged);
    return;
  }
  throw new JaceError("busy", "Another device kept syncing at the same time; will try again later.");
}
