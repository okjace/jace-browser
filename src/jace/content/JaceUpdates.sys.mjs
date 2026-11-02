/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Update check, like Jace Launcher's: once a day, ask GitHub for the newest
 * okjace/jace-browser release, and if it's newer than this build show an
 * "Update to vX" bar that opens the download for this platform.
 * (Firefox's own updater is turned off in Jace Browser builds.)
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const REPO = "okjace/jace-browser";
const PREF_LAST_CHECK = "jace.update.lastCheck";
const DAY_S = 24 * 60 * 60;

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

function assetForThisPlatform(assets) {
  const os = Services.appinfo.OS;
  const arch = Services.sysinfo.getProperty("arch");
  const ending =
    os === "WINNT" ? "-windows-x64-setup.exe" : os === "Darwin" ? (arch === "aarch64" ? "-macos-arm64.dmg" : "-macos-x86_64.dmg") : "-x86_64.AppImage";
  return assets.find((a) => a.name.endsWith(ending));
}

let checked = false;

export const JaceUpdates = {
  get currentVersion() {
    return Services.prefs.getStringPref("jace.version", "0.0.0");
  },

  checkSoon(win) {
    if (checked || !Services.prefs.getBoolPref("jace.update.check", true) || Services.env.get("JACE_SELF_TEST_OUT")) return;
    checked = true;
    const last = Services.prefs.getIntPref(PREF_LAST_CHECK, 0);
    if (Date.now() / 1000 - last < DAY_S) return;
    lazy.setTimeout(() => this.check(win).catch((e) => console.warn("Jace update check:", e)), 30_000);
  },

  async check(win) {
    Services.prefs.setIntPref(PREF_LAST_CHECK, Math.floor(Date.now() / 1000));
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
    });
    if (!response.ok) return null;
    const release = await response.json();
    const latest = String(release.tag_name ?? "").replace(/^v/, "");
    if (!latest || compareVersions(latest, this.currentVersion) <= 0) return null;
    const asset = assetForThisPlatform(release.assets ?? []);
    const url = asset?.browser_download_url ?? release.html_url;
    if (win && !win.closed) this.showBar(win, latest, url, release.html_url);
    return { latest, url };
  },

  showBar(win, version, url, notesUrl) {
    const box = win.gNotificationBox;
    if (!box || box.getNotificationWithValue("jace-update")) return;
    box.appendNotification(
      "jace-update",
      { label: `Jace Browser ${version} is out.`, priority: box.PRIORITY_INFO_MEDIUM },
      [
        { label: `Update to v${version}`, callback: () => win.openTrustedLinkIn(url, "tab") },
        { label: "What's new", callback: () => win.openTrustedLinkIn(notesUrl, "tab") },
      ],
    );
  },
};
