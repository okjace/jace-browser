// node --test tests/*.test.mjs
// The shared cookie format: Jace Browser (nsICookie) and the extension
// (WebExtension cookies API) must describe the same cookie identically.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cookieKey,
  fromExtensionCookie,
  fromGeckoCookie,
  retainCookie,
  toExtensionCookieDetails,
  toGeckoSameSite,
} from "../src/jace/content/sync/JaceCookies.sys.mjs";
import { flattenBookmarks, bookmarkKey } from "../extension/lib/engines.js";

const strip = ({ modified, ...rest }) => rest;

test("the same domain cookie looks the same from Jace Browser and the extension", () => {
  const gecko = {
    host: ".example.com", path: "/", name: "sid", value: "abc", isSecure: true, isHttpOnly: true,
    isSession: false, expiry: 1893456000000 /* ms, newer Firefox */, sameSite: 1, lastAccessed: 1700000000000000,
  };
  const ext = {
    domain: ".example.com", hostOnly: false, path: "/", name: "sid", value: "abc", secure: true, httpOnly: true,
    session: false, expirationDate: 1893456000.25, sameSite: "lax",
  };
  assert.deepEqual(strip(fromGeckoCookie(gecko)), strip(fromExtensionCookie(ext)));
  assert.equal(cookieKey(fromGeckoCookie(gecko)), cookieKey(fromExtensionCookie(ext)));
});

test("host-only cookies and old Firefox's seconds-based expiry", () => {
  const gecko = { host: "app.example.com", path: "/a", name: "t", value: "1", isSecure: false, isHttpOnly: false,
    isSession: false, expiry: 1893456000, sameSite: 256 };
  const ext = { domain: "app.example.com", hostOnly: true, path: "/a", name: "t", value: "1", secure: false,
    httpOnly: false, session: false, expirationDate: 1893456000, sameSite: "unspecified" };
  assert.deepEqual(strip(fromGeckoCookie(gecko)), strip(fromExtensionCookie(ext)));
});

test("session cookies have no expiry and are always kept", () => {
  const r = fromExtensionCookie({ domain: "x.com", hostOnly: true, path: "/", name: "s", value: "v", secure: true,
    httpOnly: false, session: true, sameSite: "strict" });
  assert.equal(r.expires, 0);
  assert.ok(retainCookie(r));
  assert.ok(!retainCookie({ ...r, session: false, expires: 1000 }));
});

test("a record turns back into cookies.set() details", () => {
  const domain = toExtensionCookieDetails({ host: ".example.com", path: "/", name: "sid", value: "abc", secure: true,
    httpOnly: true, session: false, expires: 1893456000, sameSite: "lax" });
  assert.deepEqual(domain, { url: "https://example.com/", name: "sid", value: "abc", path: "/", secure: true,
    httpOnly: true, sameSite: "lax", domain: ".example.com", expirationDate: 1893456000 });
  const hostOnly = toExtensionCookieDetails({ host: "app.example.com", path: "/a", name: "t", value: "1", secure: false,
    httpOnly: false, session: true, expires: 0, sameSite: "none" });
  assert.equal(hostOnly.domain, undefined);
  assert.equal(hostOnly.expirationDate, undefined);
  assert.equal(hostOnly.sameSite, "no_restriction");
  assert.equal(hostOnly.url, "http://app.example.com/a");
  assert.equal(toGeckoSameSite("strict"), 2);
});

test("extension bookmarks get Jace Browser's keys (root names + folder path + url)", () => {
  const tree = [{ id: "root________", children: [
    { id: "toolbar_____", type: "folder", title: "Bookmarks Toolbar", children: [
      { id: "a", type: "bookmark", title: "Jace", url: "https://jaceo.vercel.app/", dateAdded: 5 },
      { id: "f", type: "folder", title: "Work", children: [
        { id: "b", type: "bookmark", title: "Docs", url: "https://docs.example/", dateAdded: 6 },
        { id: "s", type: "bookmark", title: "Smart", url: "place:sort=8" },
      ] },
    ] },
    { id: "tags________", type: "folder", title: "Tags", children: [{ id: "t", type: "bookmark", url: "https://x/" }] },
  ] }];
  const out = flattenBookmarks(tree);
  assert.deepEqual(Object.keys(out).sort(), [
    bookmarkKey(["toolbar"], "https://jaceo.vercel.app/"),
    bookmarkKey(["toolbar", "Work"], "https://docs.example/"),
  ].sort());
  assert.deepEqual(out[bookmarkKey(["toolbar", "Work"], "https://docs.example/")].path, ["toolbar", "Work"]);
});

test("Chrome bookmarks map to the same paths as Firefox's", () => {
  const tree = [
    {
      id: "0",
      children: [
        { id: "1", title: "Bookmarks bar", children: [{ id: "a", title: "Jace", url: "https://jaceo.vercel.app/" }] },
        {
          id: "2",
          title: "Other bookmarks",
          children: [
            { id: "m", title: "Bookmarks Menu", children: [{ id: "b", title: "News", url: "https://news.example/" }] },
            { id: "c", title: "Misc", url: "https://misc.example/" },
          ],
        },
      ],
    },
  ];
  const out = flattenBookmarks(tree, { chrome: true });
  assert.ok(out[bookmarkKey(["toolbar"], "https://jaceo.vercel.app/")]);
  assert.ok(out[bookmarkKey(["menu"], "https://news.example/")]);
  assert.ok(out[bookmarkKey(["unfiled"], "https://misc.example/")]);
});
