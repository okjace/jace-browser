// node --test tests/*.test.mjs
// Jace bills for transfer: the extension's real sync code (the same protocol
// as Jace Browser's JaceSync) against a fake Jace sync server, counting what
// goes over the wire. Checks it only downloads what changed (If-None-Match /
// 304), only uploads real changes, and batches uploads.
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- a fake browser (just what sync and the history engine use) ----
const storage = new Map();
let visits = [];
globalThis.browser = {
  runtime: { getPlatformInfo: async () => ({ os: "linux" }), sendMessage: async () => {}, getBrowserInfo: async () => ({}) },
  storage: {
    local: {
      async get(key) {
        if (key === null) return Object.fromEntries(storage);
        return storage.has(key) ? { [key]: structuredClone(storage.get(key)) } : {};
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) storage.set(k, structuredClone(v));
      },
      async remove(keys) {
        for (const k of [].concat(keys)) storage.delete(k);
      },
    },
  },
  history: {
    search: async () => visits.map((v) => ({ url: v.url, title: v.title, lastVisitTime: v.time })),
    addUrl: async () => {},
    deleteUrl: async () => {},
  },
};

// ---- a fake Jace sync server ----
const server = { collections: new Map(), log: [] };
globalThis.fetch = async (url, options = {}) => {
  const name = new URL(url).pathname.replace("/api/oauth/sync/", "");
  const method = options.method ?? "GET";
  const headers = options.headers ?? {};
  const have = server.collections.get(name);
  const entry = { method, name, ifNoneMatch: headers["If-None-Match"] ?? null, status: 0, bytes: 0 };
  server.log.push(entry);
  const reply = (status, body) => {
    entry.status = status;
    const text = body === undefined ? "" : JSON.stringify(body);
    entry.bytes = text.length;
    return new Response(status === 304 ? null : text, { status });
  };
  if (method === "GET") {
    if (!have) return reply(404, { error: "not_found" });
    if (entry.ifNoneMatch === `"${have.version}"`) return reply(304);
    return reply(200, { version: have.version, payload: have.payload });
  }
  if (method === "PUT") {
    const expected = Number(String(headers["If-Match"]).replace(/"/g, ""));
    if ((have?.version ?? 0) !== expected) return reply(412, { error: "conflict" });
    const body = JSON.parse(options.body);
    entry.bytes = options.body.length;
    const version = (have?.version ?? 0) + 1;
    server.collections.set(name, { version, payload: body.payload });
    entry.status = 200;
    return new Response(JSON.stringify({ version }), { status: 200 });
  }
  return reply(405, {});
};

const { JaceCrypto } = await import("../extension/lib/crypto.js");
const sync = await import("../extension/lib/sync.js");

// Signed in, with sync set up (a few PBKDF2 rounds: this is a test).
const salt = JaceCrypto.newSalt();
const key = await JaceCrypto.deriveKey("correct horse battery", salt, 1000);
server.collections.set("keys", { version: 1, payload: JaceCrypto.encodeKeysRecord(await JaceCrypto.makeKeysRecord(key, salt, 1000)) });
await browser.storage.local.set({ token: "t", profile: { sub: "u1", name: "Test" }, syncKey: key, deviceId: "dev-1" });
// Only the history collection, to keep the counts readable.
for (const name of sync.ENGINE_NAMES) await sync.setEngineEnabled(name, name === "history");

const now = Date.now();
visits = [
  { url: "https://a.example/", title: "A", time: now - 1000 },
  { url: "https://b.example/", title: "B", time: now - 2000 },
];

const calls = (name, method) => server.log.filter((e) => e.name === name && e.method === method);

test("first sync uploads history once", async () => {
  server.log.length = 0;
  await sync.syncNow();
  assert.equal(calls("history", "PUT").length, 1);
  assert.equal(server.collections.get("history").version, 1);
});

test("nothing changed: Jace answers 304 for every collection, nothing is uploaded", async () => {
  server.log.length = 0;
  await sync.syncNow();
  const gets = server.log.filter((e) => e.method === "GET");
  assert.deepEqual(
    gets.map((e) => [e.name, e.ifNoneMatch, e.status]),
    [
      ["keys", '"1"', 304],
      ["history", '"1"', 304],
    ],
  );
  assert.equal(server.log.filter((e) => e.method === "PUT").length, 0);
  assert.equal(server.log.reduce((n, e) => n + e.bytes, 0), 0, "no bytes downloaded or uploaded");
});

test("revisiting a page isn't a change", async () => {
  server.log.length = 0;
  visits[0].time = Date.now(); // same page, newer visit time
  await sync.syncNow();
  assert.equal(calls("history", "PUT").length, 0);
});

test("a new page right after an upload waits to be batched", async () => {
  server.log.length = 0;
  visits.push({ url: "https://c.example/", title: "C", time: Date.now() });
  await sync.syncNow();
  assert.equal(calls("history", "PUT").length, 0);
  // Still 304: the copy wasn't advanced, so the change stays pending.
  assert.equal(calls("history", "GET")[0].status, 304);
});

test("Sync now uploads pending changes right away", async () => {
  server.log.length = 0;
  await sync.syncNow({ force: true });
  assert.equal(calls("history", "PUT").length, 1);
  assert.equal(server.collections.get("history").version, 2);
  const uploaded = await JaceCrypto.decrypt(key, "history", server.collections.get("history").payload);
  assert.deepEqual(Object.keys(uploaded).sort(), ["https://a.example/", "https://b.example/", "https://c.example/"]);
});

test("another device's change is downloaded once, then 304 again", async () => {
  // Another device adds a page and uploads version 3.
  const theirs = await JaceCrypto.decrypt(key, "history", server.collections.get("history").payload);
  theirs["https://d.example/"] = { url: "https://d.example/", title: "D", modified: Date.now() };
  server.collections.set("history", { version: 3, payload: await JaceCrypto.encrypt(key, "history", theirs) });

  server.log.length = 0;
  await sync.syncNow();
  assert.equal(calls("history", "GET")[0].status, 200);
  assert.equal(calls("history", "PUT").length, 0, "nothing new here to send back");

  server.log.length = 0;
  await sync.syncNow();
  assert.equal(calls("history", "GET")[0].status, 304);
});
