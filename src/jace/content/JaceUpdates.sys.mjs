/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Jace Browser updates itself (Firefox's own updater is turned off).
 *
 * A few times a day it asks GitHub for the newest okjace/jace-browser
 * release. New releases come out on their own whenever Mozilla ships a new
 * Firefox (.github/workflows/firefox-update.yml), so this is how new Firefox
 * versions reach you without anyone doing anything.
 *
 * With jace.update.auto on (the default) and an installed copy it can
 * replace, it:
 *   1. downloads the installer for this platform in the background
 *   2. checks it against the SHA-256 GitHub publishes for the file
 *   3. installs it as Jace Browser quits - or right away if you click
 *      "Restart to update" - and starts the new version
 *
 *   Windows  the setup .exe, silently, over the installed copy
 *   macOS    the .dmg's app replaces the one in place (old copy kept until the new one is in)
 *   Linux    the AppImage file is swapped for the new one
 *
 * The portable .zip and .tar.xz can't update themselves: those get an
 * "Update to vX" bar that opens the download instead.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

const REPO = "okjace/jace-browser";
const PREF_LAST_CHECK = "jace.update.lastCheck";
const PREF_PENDING = "jace.update.pending"; // JSON { version, file, kind }
const CHECK_EVERY_S = 6 * 60 * 60;

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function greDir() {
  return Services.dirsvc.get("GreD", Ci.nsIFile);
}

/** How this copy was installed, i.e. how (and whether) it can replace itself. */
function installKind() {
  const os = Services.appinfo.OS;
  if (os === "WINNT") {
    const helper = greDir();
    helper.append("uninstall");
    helper.append("helper.exe");
    return helper.exists() ? "windows-setup" : null; // no uninstaller = the portable zip
  }
  if (os === "Darwin") {
    const app = greDir().parent.parent; // Jace Browser.app/Contents/Resources -> .app
    return app.leafName.endsWith(".app") && app.parent.isWritable() ? "macos-app" : null;
  }
  const appimage = Services.env.get("APPIMAGE");
  if (appimage) {
    try {
      const f = localFile(appimage);
      return f.exists() && f.parent.isWritable() ? "appimage" : null;
    } catch {
      return null;
    }
  }
  return null;
}

function localFile(path) {
  const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  f.initWithPath(path);
  return f;
}

function assetForThisPlatform(assets) {
  const os = Services.appinfo.OS;
  const arch = Services.sysinfo.getProperty("arch");
  const ending =
    os === "WINNT"
      ? "-windows-x64-setup.exe"
      : os === "Darwin"
        ? arch === "aarch64"
          ? "-macos-arm64.dmg"
          : "-macos-x86_64.dmg"
        : "-x86_64.AppImage";
  return assets.find((a) => a.name.endsWith(ending));
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let started = false;
let applyOnQuit = null; // { version, file, kind }
let relaunchAfterApply = false;
let busy = null;

export const JaceUpdates = {
  get currentVersion() {
    return Services.prefs.getStringPref("jace.version", "0.0.0");
  },

  get auto() {
    return Services.prefs.getBoolPref("jace.update.auto", true);
  },

  get installKind() {
    return installKind();
  },

  /** Called for each new window; starts the background checks once. */
  checkSoon(win) {
    if (started || !Services.prefs.getBoolPref("jace.update.check", true) || Services.env.get("JACE_SELF_TEST_OUT")) {
      return;
    }
    started = true;
    this._restorePending();
    Services.obs.addObserver(() => this._applyAtQuit(), "quit-application-granted");
    const due = () => Date.now() / 1000 - Services.prefs.getIntPref(PREF_LAST_CHECK, 0) >= CHECK_EVERY_S;
    lazy.setTimeout(() => due() && this.check(win).catch((e) => console.warn("Jace update check:", e)), 30_000);
    lazy.setInterval(() => due() && this.check().catch((e) => console.warn("Jace update check:", e)), 60 * 60 * 1000);
  },

  _restorePending() {
    try {
      const pending = JSON.parse(Services.prefs.getStringPref(PREF_PENDING, "null"));
      if (pending && compareVersions(pending.version, this.currentVersion) > 0 && localFile(pending.file).exists()) {
        applyOnQuit = pending;
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        if (win) this.showReadyBar(win, pending.version);
      } else {
        Services.prefs.clearUserPref(PREF_PENDING);
      }
    } catch {
      Services.prefs.clearUserPref(PREF_PENDING);
    }
  },

  /**
   * Looks for a newer release. Returns { latest, url, ready } or null if
   * this is the newest. With auto updates, downloads it too.
   */
  check(win) {
    busy ??= this._check(win).finally(() => (busy = null));
    return busy;
  },

  async _check(win) {
    Services.prefs.setIntPref(PREF_LAST_CHECK, Math.floor(Date.now() / 1000));
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const release = await response.json();
    const latest = String(release.tag_name ?? "").replace(/^v/, "");
    if (!latest || compareVersions(latest, this.currentVersion) <= 0) return null;
    const asset = assetForThisPlatform(release.assets ?? []);
    const url = asset?.browser_download_url ?? release.html_url;
    win ??= Services.wm.getMostRecentWindow("navigator:browser");

    if (applyOnQuit?.version === latest) {
      if (win) this.showReadyBar(win, latest);
      return { latest, url, ready: true };
    }
    const kind = installKind();
    if (this.auto && kind && asset) {
      try {
        const file = await this._download(asset);
        applyOnQuit = { version: latest, file, kind };
        Services.prefs.setStringPref(PREF_PENDING, JSON.stringify(applyOnQuit));
        if (win) this.showReadyBar(win, latest);
        return { latest, url, ready: true };
      } catch (e) {
        console.warn("Jace: update download failed, offering the link instead", e);
      }
    }
    if (win) this.showDownloadBar(win, latest, url, release.html_url);
    return { latest, url, ready: false };
  },

  async _download(asset) {
    const dir = PathUtils.join(PathUtils.tempDir, "jace-update");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const file = PathUtils.join(dir, asset.name.replace(/[^\w.-]/g, "_"));
    const response = await fetch(asset.browser_download_url, { credentials: "omit" });
    if (!response.ok) throw new Error(`download answered ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (asset.size && bytes.length !== asset.size) throw new Error("download is the wrong size");
    // GitHub publishes "sha256:<hex>" for every release file.
    const expected = String(asset.digest ?? "").replace(/^sha256:/, "");
    if (!expected) throw new Error("GitHub didn't publish a checksum for this file");
    if ((await sha256Hex(bytes)) !== expected.toLowerCase()) throw new Error("checksum mismatch");
    await IOUtils.write(file, bytes);
    if (Services.appinfo.OS !== "WINNT") await IOUtils.setPermissions(file, 0o755);
    return file;
  },

  showReadyBar(win, version) {
    const box = win.gNotificationBox;
    if (!box) return;
    box.getNotificationWithValue("jace-update")?.close();
    box.appendNotification(
      "jace-update",
      { label: `Jace Browser ${version} is ready. It installs when you quit.`, priority: box.PRIORITY_INFO_MEDIUM },
      [{ label: "Restart to update", callback: () => this.restartNow() }],
    );
  },

  showDownloadBar(win, version, url, notesUrl) {
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

  restartNow() {
    relaunchAfterApply = true;
    // Session restore brings your tabs back in the new version.
    Services.prefs.setBoolPref("browser.sessionstore.resume_session_once", true);
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  },

  /** Hands the install to a small script that waits for us to exit. */
  _applyAtQuit() {
    if (!applyOnQuit) return;
    const { file, kind } = applyOnQuit;
    try {
      const pid = Services.appinfo.processID;
      const relaunch = relaunchAfterApply ? "1" : "0";
      const scriptDir = PathUtils.parent(file);
      if (kind === "windows-setup") {
        const exe = Services.dirsvc.get("XREExeF", Ci.nsIFile).path;
        const script = PathUtils.join(scriptDir, "apply-update.cmd");
        const text = [
          "@echo off",
          "rem Jace Browser update: wait for the browser to close, install over it, start it again.",
          ":wait",
          `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
          `"${file}" /S`,
          `if "${relaunch}"=="1" start "" "${exe}"`,
          `del "${file}"`,
          '(goto) 2>nul & del "%~f0"',
        ].join("\r\n");
        writeSync(script, text);
        run(Services.env.get("ComSpec") || "C:\\Windows\\System32\\cmd.exe", ["/c", script], true);
      } else {
        const script = PathUtils.join(scriptDir, "apply-update.sh");
        let body;
        if (kind === "macos-app") {
          const app = greDir().parent.parent.path;
          body = [
            `APP=${sh(app)}; DMG=${sh(file)}`,
            'MNT=$(mktemp -d)',
            'hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" || exit 1',
            'rm -rf "$APP.new" && ditto "$MNT/Jace Browser.app" "$APP.new" && rm -rf "$APP.old" && mv "$APP" "$APP.old" && mv "$APP.new" "$APP" && rm -rf "$APP.old"',
            'hdiutil detach "$MNT" -quiet; rmdir "$MNT"',
            'xattr -dr com.apple.quarantine "$APP" 2>/dev/null',
            'rm -f "$DMG"',
            `[ ${relaunch} = 1 ] && open "$APP"`,
          ];
        } else {
          body = [
            `NEW=${sh(file)}; TARGET=${sh(Services.env.get("APPIMAGE"))}`,
            'chmod +x "$NEW" && mv -f "$NEW" "$TARGET"',
            `[ ${relaunch} = 1 ] && (nohup "$TARGET" >/dev/null 2>&1 &)`,
          ];
        }
        const text = [
          "#!/bin/sh",
          "# Jace Browser update: wait for the browser to quit, swap in the new version.",
          `while kill -0 ${pid} 2>/dev/null; do sleep 1; done`,
          ...body,
          'rm -f "$0"',
          "",
        ].join("\n");
        writeSync(script, text);
        run("/bin/sh", [script], false);
      }
      Services.prefs.clearUserPref(PREF_PENDING);
    } catch (e) {
      console.error("Jace: couldn't start the update", e);
    }
  },
};

function writeSync(path, text) {
  const f = localFile(path);
  const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
  stream.init(f, 0x02 | 0x08 | 0x20, 0o755, 0); // write, create, truncate
  const converter = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
  converter.init(stream, "UTF-8");
  converter.writeString(text);
  converter.close();
}

function run(program, args, hidden) {
  const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  proc.init(localFile(program));
  if (hidden) proc.startHidden = true;
  proc.runw(false, args);
}
