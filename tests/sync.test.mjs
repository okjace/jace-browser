// Runs under Node: node --test tests/
// Tests Jace sync's merge and encryption, which don't use any browser APIs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { threeWayMerge, sameRecord } from "../src/jace/content/sync/JaceMerge.sys.mjs";
import { JaceCrypto } from "../src/jace/content/sync/JaceCrypto.sys.mjs";

const r = (value, modified = 1) => ({ value, modified });

test("new items on each side reach the other", () => {
  const out = threeWayMerge({ local: { a: r(1) }, remote: { b: r(2) }, base: {} });
  assert.deepEqual(Object.keys(out.merged).sort(), ["a", "b"]);
  assert.deepEqual(out.toAdd, [r(2)]);
  assert.equal(out.remoteChanged, true);
});

test("a change on one side wins over an unchanged other side, whatever the timestamps", () => {
  const base = { a: r(1, 100) };
  const local = { a: r(2, 50) }; // changed here, older clock
  const remote = { a: r(1, 100) };
  const out = threeWayMerge({ local, remote, base });
  assert.equal(out.merged.a.value, 2);
  assert.equal(out.remoteChanged, true);
  assert.equal(out.toUpdate.length, 0);
});

test("remote change is applied locally", () => {
  const out = threeWayMerge({ local: { a: r(1) }, remote: { a: r(3, 5) }, base: { a: r(1) } });
  assert.equal(out.merged.a.value, 3);
  assert.equal(out.toUpdate.length, 1);
  assert.equal(out.remoteChanged, false);
});

test("both changed: newer modified wins", () => {
  const out = threeWayMerge({ local: { a: r(2, 10) }, remote: { a: r(3, 20) }, base: { a: r(1) } });
  assert.equal(out.merged.a.value, 3);
});

test("deleted on another device is deleted here", () => {
  const local = { a: { ...r(1), _local: { guid: "x" } } };
  const out = threeWayMerge({ local, remote: {}, base: { a: r(1) } });
  assert.deepEqual(out.toRemove, [local.a]);
  assert.equal(out.merged.a, undefined);
});

test("deleted here is deleted on Jace", () => {
  const out = threeWayMerge({ local: {}, remote: { a: r(1) }, base: { a: r(1) } });
  assert.equal(out.merged.a, undefined);
  assert.equal(out.remoteChanged, true);
  assert.equal(out.toAdd.length, 0);
});

test("a session cookie lost on restart isn't a sign-out on other devices", () => {
  const cookie = { value: "s", isSession: true, modified: 1 };
  const out = threeWayMerge({
    local: {},
    remote: { c: cookie },
    base: { c: cookie },
    localDeletionCounts: (b) => !b.isSession,
  });
  assert.deepEqual(out.merged.c, cookie);
  assert.deepEqual(out.toAdd, [cookie]); // and it comes back here
});

test("expired records drop out without deleting anything", () => {
  const old = { value: 1, modified: 1, expired: true };
  const out = threeWayMerge({
    local: { a: old },
    remote: { a: old },
    base: { a: old },
    retain: (x) => !x.expired,
  });
  assert.equal(out.merged.a, undefined);
  assert.equal(out.toRemove.length, 0);
  assert.equal(out.remoteChanged, true);
});

test("_local and modified are ignored when comparing", () => {
  assert.ok(sameRecord({ v: 1, modified: 1, _local: { guid: "a" } }, { v: 1, modified: 9 }));
  assert.ok(!sameRecord({ v: 1 }, { v: 2 }));
  assert.ok(sameRecord({ a: 1, b: 2 }, { b: 2, a: 1 }));
});

test("_local never goes to Jace", () => {
  const out = threeWayMerge({ local: { a: { v: 1, _local: { guid: "g" } } }, remote: {}, base: {} });
  assert.equal("_local" in out.merged.a, false);
});

test("encryption round-trips and is bound to the collection", async () => {
  const salt = JaceCrypto.newSalt();
  const key = await JaceCrypto.deriveKey("correct horse battery", salt, 1000);
  const blob = await JaceCrypto.encrypt(key, "cookies", { hello: "world" });
  assert.deepEqual(await JaceCrypto.decrypt(key, "cookies", blob), { hello: "world" });
  await assert.rejects(JaceCrypto.decrypt(key, "passwords", blob), /decrypt/);
  const other = await JaceCrypto.deriveKey("wrong passphrase!", salt, 1000);
  await assert.rejects(JaceCrypto.decrypt(other, "cookies", blob), /decrypt/);
});

test("keys record tells right and wrong passphrases apart", async () => {
  const salt = JaceCrypto.newSalt();
  const key = await JaceCrypto.deriveKey("my passphrase", salt, 1000);
  const record = JaceCrypto.decodeKeysRecord(JaceCrypto.encodeKeysRecord(await JaceCrypto.makeKeysRecord(key, salt, 1000)));
  assert.equal(record.salt, salt);
  assert.ok(await JaceCrypto.checkKey(await JaceCrypto.deriveKey("my passphrase", record.salt, record.rounds), record));
  assert.ok(!(await JaceCrypto.checkKey(await JaceCrypto.deriveKey("not it at all", record.salt, record.rounds), record)));
});

test("payloads are base64 the Jace server accepts", async () => {
  const key = await JaceCrypto.deriveKey("passphrase!", JaceCrypto.newSalt(), 1000);
  const blob = await JaceCrypto.encrypt(key, "bookmarks", { big: "x".repeat(200000) });
  assert.match(blob, /^[A-Za-z0-9+/=_-]+$/);
});
