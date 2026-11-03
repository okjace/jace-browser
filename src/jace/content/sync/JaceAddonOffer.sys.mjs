/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * After a sync: if your other devices have add-ons this one doesn't, a bar
 * at the top of the window asks whether to install them.
 *
 *   Install     each one is downloaded from addons.mozilla.org and installed
 *   Not now     asks again next time Jace Browser starts
 *   Don't ask   never asks about these add-ons again (jace.sync.addons.declined)
 *
 * Nothing is installed without pressing Install. Add-ons that aren't on
 * addons.mozilla.org are skipped (the bar says which).
 */

try {
  Cu.importGlobalProperties(["fetch"]);
} catch {}

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  JaceSync: "chrome://jace/content/sync/JaceSync.sys.mjs",
});

const DECLINED_PREF = "jace.sync.addons.declined";
const BAR_ID = "jace-sync-addons";
const AMO_API = "https://addons.mozilla.org/api/v5/addons/addon/";

let lastSyncSeen = 0;
let snoozed = new Set(); // "Not now" (until Jace Browser restarts)
let started = false;

function declined() {
  try {
    return new Set(JSON.parse(Services.prefs.getStringPref(DECLINED_PREF, "[]")));
  } catch {
    return new Set();
  }
}

function decline(ids) {
  const set = declined();
  for (const id of ids) set.add(id);
  Services.prefs.setStringPref(DECLINED_PREF, JSON.stringify([...set]));
}

/** Add-ons your other devices have and this one doesn't (and you haven't said no to). */
export async function missingAddons() {
  const mine = new Set((await lazy.AddonManager.getAllAddons()).map((a) => a.id));
  const no = declined();
  const found = new Map();
  for (const device of await lazy.JaceSync.remoteAddons()) {
    for (const a of device.addons ?? []) {
      if (!a.id || mine.has(a.id) || no.has(a.id) || snoozed.has(a.id) || found.has(a.id)) continue;
      found.set(a.id, { ...a, device: device.device });
    }
  }
  return [...found.values()];
}

/** Downloads one add-on from addons.mozilla.org and installs it. */
async function installFromAMO(addon) {
  const response = await fetch(`${AMO_API}${encodeURIComponent(addon.id)}/`, { credentials: "omit" });
  if (!response.ok) throw new Error(response.status === 404 ? "not on addons.mozilla.org" : `addons.mozilla.org answered ${response.status}`);
  const info = await response.json();
  const url = info?.current_version?.file?.url;
  if (!url) throw new Error("no download on addons.mozilla.org");
  const install = await lazy.AddonManager.getInstallForURL(url, {
    name: addon.name,
    telemetryInfo: { source: "jace-sync" },
  });
  await install.install();
}

function names(list) {
  const shown = list.slice(0, 3).map((a) => a.name);
  return list.length > 3 ? `${shown.join(", ")} and ${list.length - 3} more` : shown.join(", ");
}

async function installAll(win, list) {
  const failed = [];
  for (const addon of list) {
    try {
      await installFromAMO(addon);
    } catch (e) {
      console.warn(`Jace: couldn't install ${addon.name}`, e);
      failed.push(`${addon.name} (${e.message})`);
    }
  }
  const done = list.length - failed.length;
  const box = win.gNotificationBox;
  if (!box) return;
  await box.appendNotification(
    `${BAR_ID}-done`,
    {
      label: failed.length
        ? `Installed ${done} of ${list.length} add-ons. Couldn't install: ${failed.join(", ")}.`
        : `Installed ${done} add-on${done === 1 ? "" : "s"} from your other devices.`,
      priority: failed.length ? box.PRIORITY_WARNING_MEDIUM : box.PRIORITY_INFO_MEDIUM,
    },
    [],
  );
}

async function offer() {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const box = win?.gNotificationBox;
  if (!box || box.getNotificationWithValue(BAR_ID)) return;
  let list = [];
  try {
    list = await missingAddons();
  } catch (e) {
    console.warn("Jace: add-ons from other devices", e);
    return;
  }
  if (!list.length) return;
  const from = [...new Set(list.map((a) => a.device).filter(Boolean))].join(", ");
  await box.appendNotification(
    BAR_ID,
    {
      label: `${from || "Your other devices"} ha${list.length === 1 ? "s an add-on" : "ve add-ons"} you don't have here: ${names(list)}. Install ${list.length === 1 ? "it" : "them"}?`,
      priority: box.PRIORITY_INFO_HIGH,
    },
    [
      {
        label: "Install",
        accessKey: "I",
        callback: () => {
          installAll(win, list);
        },
      },
      {
        label: "Not now",
        accessKey: "N",
        callback: () => {
          for (const a of list) snoozed.add(a.id);
        },
      },
      {
        label: "Don't ask again",
        accessKey: "D",
        callback: () => decline(list.map((a) => a.id)),
      },
    ],
  );
}

export const JaceAddonOffer = {
  missingAddons,
  installFromAMO,

  /** Checks after every finished sync. */
  start() {
    if (started) return;
    started = true;
    Services.obs.addObserver(() => {
      const status = lazy.JaceSync.status;
      if (status.state !== "idle" || !status.lastSync || status.lastSync === lastSyncSeen) return;
      if (!lazy.JaceSync.engineEnabled?.("addons")) return;
      lastSyncSeen = status.lastSync;
      offer().catch((e) => console.warn("Jace: add-on offer", e));
    }, "jace-sync-status");
  },
};
