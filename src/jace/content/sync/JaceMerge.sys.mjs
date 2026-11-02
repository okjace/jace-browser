/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Three-way merge for Jace sync collections. No browser APIs here, so
 * tests/merge.test.mjs runs it under Node.
 *
 * Every collection is a map of key -> record. We compare:
 *   local  - what this browser has now
 *   remote - what Jace has (written by any device)
 *   base   - what this browser and Jace agreed on after the last sync
 *
 * Per key:
 *   unchanged on one side          -> take the other side's version
 *   changed on both sides          -> the newer `modified` wins
 *   removed on one side, unchanged on the other -> removed everywhere
 *   removed on one side, changed on the other   -> the change wins
 *   new on one side                -> added to the other
 *
 * A record's `_local` field (e.g. this device's bookmark guid) and its
 * `modified` time are not compared. Records an engine no longer wants to keep
 * (`retain` false, e.g. history older than 90 days or an expired cookie)
 * quietly drop out without counting as deletions, so one device's cleanup
 * never deletes another device's data.
 */

export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => k !== "_local" && k !== "modified" && value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function sameRecord(a, b) {
  if (!a || !b) {
    return !a && !b;
  }
  return stableStringify(a) === stableStringify(b);
}

function stripLocal(record) {
  if (!record || !("_local" in record)) {
    return record;
  }
  const { _local, ...rest } = record;
  return rest;
}

/**
 * @param {object} args
 * @param {Object<string, object>} args.local
 * @param {Object<string, object>} args.remote
 * @param {Object<string, object>} args.base
 * @param {(record: object) => boolean} [args.retain] keep this record at all?
 * @param {(baseRecord: object) => boolean} [args.localDeletionCounts]
 *   whether a record missing locally (but in base) means the person deleted it.
 *   Cookies use this: a session cookie disappearing on restart isn't a sign-out.
 * @returns {{
 *   merged: Object<string, object>,           // the new remote and base (no _local)
 *   toAdd: object[], toUpdate: {local, remote}[], toRemove: object[],  // apply locally
 *   remoteChanged: boolean,                    // must upload merged
 * }}
 */
export function threeWayMerge({ local, remote, base, retain = () => true, localDeletionCounts = () => true }) {
  const merged = {};
  const toAdd = [];
  const toUpdate = [];
  const toRemove = [];
  let remoteChanged = false;

  const keep = (r) => (r && retain(r) ? r : undefined);
  const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);

  for (const key of keys) {
    const l = keep(local[key]);
    const r = keep(remote[key]);
    const b = keep(base[key]);
    if (!remote[key] !== !r) {
      remoteChanged = true; // an expired record leaves the remote copy
    }

    if (l && r) {
      if (sameRecord(l, r)) {
        merged[key] = stripLocal(r);
        continue;
      }
      const localChanged = !sameRecord(l, b);
      const remoteChangedHere = !sameRecord(r, b);
      let winner;
      if (localChanged && !remoteChangedHere) {
        winner = "local";
      } else if (!localChanged && remoteChangedHere) {
        winner = "remote";
      } else {
        winner = (r.modified ?? 0) > (l.modified ?? 0) ? "remote" : "local";
      }
      if (winner === "local") {
        merged[key] = stripLocal(l);
        remoteChanged = true;
      } else {
        merged[key] = stripLocal(r);
        toUpdate.push({ local: l, remote: r });
      }
    } else if (l && !r) {
      if (b && sameRecord(l, b)) {
        // Deleted on another device, untouched here: delete here too.
        toRemove.push(l);
      } else {
        // New here, or changed here after another device deleted it.
        merged[key] = stripLocal(l);
        remoteChanged = true;
      }
    } else if (!l && r) {
      if (b && sameRecord(r, b) && localDeletionCounts(b)) {
        // Deleted here, untouched elsewhere: delete on Jace too.
        remoteChanged = true;
      } else {
        merged[key] = stripLocal(r);
        toAdd.push(r);
      }
    }
    // Neither side has it (only base): already gone everywhere.
  }

  return { merged, toAdd, toUpdate, toRemove, remoteChanged };
}
