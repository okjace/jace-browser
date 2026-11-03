/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Jace Browser's own installer, like Jace Launcher's: the download *is* the
 * app, and the first-run setup (about:jace-setup) installs it.
 *
 *   Linux  the .AppImage you ran is copied to ~/Applications, added to the
 *          applications menu (with its icon and as a web browser), registered
 *          with GNOME Software / KDE Discover, and optionally to the desktop.
 *   macOS  the app you opened from the .dmg (or Downloads) is copied to
 *          Applications, the "downloaded from the internet" flag is removed
 *          (no "damaged" warning), and it's optionally added to the Dock.
 *   Windows the setup .exe installs it (Start menu, desktop, Installed apps);
 *          nothing to do here.
 *
 * After installing, the installed copy starts and this one quits. Uninstall
 * (Linux/macOS) removes what install added; your data (the profile) stays.
 */

const HOME = () => Services.dirsvc.get("Home", Ci.nsIFile).path;
const APP_ID = "io.github.okjace.JaceBrowser";
const DESKTOP_ID = "jace-browser.desktop";

function file(path) {
  const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  f.initWithPath(path);
  return f;
}

function exists(path) {
  try {
    return file(path).exists();
  } catch {
    return false;
  }
}

/** Runs a program and waits; returns its exit code (-1 if it couldn't start). */
function run(program, args) {
  try {
    const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    proc.init(file(program));
    proc.runw(true, args);
    return proc.exitValue;
  } catch (e) {
    console.warn(`Jace install: ${program} failed`, e);
    return -1;
  }
}

function launch(program, args) {
  const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  proc.init(file(program));
  proc.runw(false, args);
}

function quitSoon() {
  Services.tm.dispatchToMainThread(() => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit));
}

// ---------------------------------------------------------------- Linux

const linux = {
  get appimage() {
    return Services.env.get("APPIMAGE") || null;
  },
  get target() {
    return PathUtils.join(HOME(), "Applications", "Jace-Browser.AppImage");
  },
  get desktopFile() {
    return PathUtils.join(HOME(), ".local", "share", "applications", DESKTOP_ID);
  },
  get installed() {
    return exists(this.target) && exists(this.desktopFile);
  },
  /** Running the installed copy already? */
  get runningInstalled() {
    return this.appimage === this.target;
  },

  async install({ desktopShortcut = false } = {}) {
    const share = PathUtils.join(HOME(), ".local", "share");
    await IOUtils.makeDirectory(PathUtils.parent(this.target), { createAncestors: true });
    // The app itself (a copy of the .AppImage you downloaded).
    if (this.appimage !== this.target) {
      await IOUtils.copy(this.appimage, this.target);
    }
    await IOUtils.setPermissions(this.target, 0o755);
    // Its icon, from the browser's own branding.
    const iconDir = PathUtils.join(share, "icons", "hicolor", "128x128", "apps");
    await IOUtils.makeDirectory(iconDir, { createAncestors: true });
    const icon = PathUtils.join(Services.dirsvc.get("GreD", Ci.nsIFile).path, "browser", "chrome", "icons", "default", "default128.png");
    if (await IOUtils.exists(icon)) await IOUtils.copy(icon, PathUtils.join(iconDir, "jace-browser.png"));
    // Applications menu entry, also offered as a web browser.
    const entry = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Jace Browser",
      "GenericName=Web Browser",
      "Comment=Browse the web with your Jace account",
      `Exec="${this.target}" %u`,
      "Icon=jace-browser",
      "Terminal=false",
      "Categories=Network;WebBrowser;",
      "MimeType=text/html;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;",
      "StartupNotify=true",
      "StartupWMClass=jace",
      "Actions=new-window;new-private-window;",
      "",
      "[Desktop Action new-window]",
      "Name=New Window",
      `Exec="${this.target}" --new-window`,
      "",
      "[Desktop Action new-private-window]",
      "Name=New Private Window",
      `Exec="${this.target}" --private-window`,
      "",
    ].join("\n");
    await IOUtils.makeDirectory(PathUtils.parent(this.desktopFile), { createAncestors: true });
    await IOUtils.writeUTF8(this.desktopFile, entry);
    // So GNOME Software / KDE Discover list it (and can uninstall it).
    const metainfoDir = PathUtils.join(share, "metainfo");
    await IOUtils.makeDirectory(metainfoDir, { createAncestors: true });
    await IOUtils.writeUTF8(
      PathUtils.join(metainfoDir, `${APP_ID}.metainfo.xml`),
      `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${APP_ID}</id>
  <name>Jace Browser</name>
  <summary>A clean, fast browser with your Jace account</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MPL-2.0</project_license>
  <launchable type="desktop-id">${DESKTOP_ID}</launchable>
  <url type="homepage">https://github.com/okjace/jace-browser</url>
  <developer id="io.github.okjace"><name>Jace</name></developer>
  <description><p>Jace Browser: vertical tabs, Jace sync and automatic sign-in to Jace websites. Based on Firefox.</p></description>
</component>
`,
    );
    if (desktopShortcut) {
      const desktopDir = PathUtils.join(HOME(), "Desktop");
      if (await IOUtils.exists(desktopDir)) {
        const shortcut = PathUtils.join(desktopDir, DESKTOP_ID);
        await IOUtils.writeUTF8(shortcut, entry);
        await IOUtils.setPermissions(shortcut, 0o755);
        if (exists("/usr/bin/gio")) run("/usr/bin/gio", ["set", shortcut, "metadata::trusted", "true"]);
      }
    }
    if (exists("/usr/bin/update-desktop-database")) run("/usr/bin/update-desktop-database", [PathUtils.parent(this.desktopFile)]);
    if (exists("/usr/bin/gtk-update-icon-cache")) run("/usr/bin/gtk-update-icon-cache", ["-q", "-t", PathUtils.join(share, "icons", "hicolor")]);
    return this.target;
  },

  async uninstall() {
    const share = PathUtils.join(HOME(), ".local", "share");
    for (const p of [
      this.desktopFile,
      PathUtils.join(HOME(), "Desktop", DESKTOP_ID),
      PathUtils.join(share, "metainfo", `${APP_ID}.metainfo.xml`),
      PathUtils.join(share, "icons", "hicolor", "128x128", "apps", "jace-browser.png"),
      this.target,
    ]) {
      await IOUtils.remove(p, { ignoreAbsent: true }).catch(() => {});
    }
  },

  relaunch() {
    launch(this.target, []);
    quitSoon();
  },
};

// ---------------------------------------------------------------- macOS

const mac = {
  /** The .app this is running from. */
  get bundle() {
    return Services.dirsvc.get("GreD", Ci.nsIFile).parent.parent; // .app/Contents/Resources
  },
  get inApplications() {
    const p = this.bundle.path;
    return p.startsWith("/Applications/") || p.startsWith(PathUtils.join(HOME(), "Applications") + "/");
  },
  /** Opened straight from the .dmg, from Downloads, or a quarantined copy macOS moved. */
  get needsInstall() {
    return this.bundle.leafName.endsWith(".app") && !this.inApplications;
  },
  get target() {
    const system = file("/Applications");
    return system.isWritable() ? "/Applications/Jace Browser.app" : PathUtils.join(HOME(), "Applications", "Jace Browser.app");
  },

  async install({ dock = true } = {}) {
    const target = this.target;
    await IOUtils.makeDirectory(PathUtils.parent(target), { createAncestors: true });
    await IOUtils.remove(target, { recursive: true, ignoreAbsent: true });
    if (run("/usr/bin/ditto", [this.bundle.path, target]) !== 0) throw new Error(`Couldn't copy Jace Browser to ${PathUtils.parent(target)}.`);
    // No "Jace Browser is damaged / from an unidentified developer" warning.
    run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", target]);
    if (dock) {
      const tile = `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://${encodeURI(target)}/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>`;
      run("/usr/bin/defaults", ["write", "com.apple.dock", "persistent-apps", "-array-add", tile]);
      run("/usr/bin/killall", ["Dock"]);
    }
    return target;
  },

  async uninstall() {
    // The app can't delete itself while running from Applications: move it to the Trash on quit.
    run("/usr/bin/osascript", ["-e", `tell application "Finder" to delete (POSIX file "${this.bundle.path}")`]);
  },

  relaunch(target) {
    launch("/usr/bin/open", ["-n", target]);
    quitSoon();
  },
};

// ---------------------------------------------------------------- shared

export const JaceInstall = {
  /**
   * What the setup's Install step should offer here, or null if there's
   * nothing to install: { os, where, installed, options: [...] }
   */
  get offer() {
    const os = Services.appinfo.OS;
    if (os === "Linux" && linux.appimage && !linux.runningInstalled) {
      return {
        os: "linux",
        where: PathUtils.parent(linux.target),
        installed: linux.installed,
        options: [{ id: "desktopShortcut", label: "Add to the desktop", checked: false }],
      };
    }
    if (os === "Darwin" && mac.needsInstall) {
      return {
        os: "mac",
        where: PathUtils.parent(mac.target),
        installed: exists(mac.target),
        options: [{ id: "dock", label: "Add to the Dock", checked: true }],
      };
    }
    return null;
  },

  /** Installs, then starts the installed copy and quits this one. */
  async install(options = {}) {
    const os = Services.appinfo.OS;
    if (os === "Linux") {
      await linux.install(options);
      return { relaunch: () => linux.relaunch() };
    }
    if (os === "Darwin") {
      const target = await mac.install(options);
      return { relaunch: () => mac.relaunch(target) };
    }
    throw new Error("The Windows setup installs Jace Browser.");
  },

  /** Linux/macOS: remove the installed app (your data stays). */
  get canUninstall() {
    const os = Services.appinfo.OS;
    return (os === "Linux" && linux.runningInstalled) || (os === "Darwin" && mac.inApplications);
  },
  async uninstall({ quit = true } = {}) {
    if (Services.appinfo.OS === "Linux") await linux.uninstall();
    else if (Services.appinfo.OS === "Darwin") await mac.uninstall();
    if (quit) quitSoon();
  },

  /** For the self-test: where the Linux install puts things. */
  get linuxPaths() {
    return { target: linux.target, desktopFile: linux.desktopFile };
  },
};
