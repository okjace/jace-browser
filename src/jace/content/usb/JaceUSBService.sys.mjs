/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The parent-process side of Jace Browser's WebUSB.
 *
 * - Runs jace-usb-helper (usb-helper/ in the repo, installed next to the
 *   browser in jace/bin/) and talks to it with JSON lines.
 * - Remembers which sites may use which devices (jace-usb-permissions.json
 *   in the profile), the same way Chrome does: a site gets a device only
 *   after the person picks it in the chooser that navigator.usb.requestDevice()
 *   opens.
 * - Blocks the interface classes Chrome's WebUSB blocks (HID, mass storage,
 *   audio, video, smart cards, wireless controllers...), so a page can't use
 *   WebUSB to read your keyboard or your USB stick.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

// https://wicg.github.io/webusb/#protected-interface-classes
const PROTECTED_CLASSES = new Set([0x01, 0x03, 0x08, 0x0b, 0x0e, 0x10, 0xe0]);

const PERMISSIONS_FILE = () => PathUtils.join(PathUtils.profileDir, "jace-usb-permissions.json");

function helperPath() {
  const dir = Services.dirsvc.get("GreD", Ci.nsIFile);
  dir.append("jace");
  dir.append("bin");
  dir.append(Services.appinfo.OS === "WINNT" ? "jace-usb-helper.exe" : "jace-usb-helper");
  return dir;
}

/** What a remembered permission is tied to: the same model of device, and the same unit when it has a serial number. */
export function deviceKey(d) {
  return `${d.vendorId}:${d.productId}:${d.serialNumber ?? ""}`;
}

export function deviceLabel(d) {
  const hex = (n) => n.toString(16).padStart(4, "0");
  const name = d.productName || `USB device ${hex(d.vendorId)}:${hex(d.productId)}`;
  return d.manufacturerName ? `${name} (${d.manufacturerName})` : name;
}

/** Does a device match one requestDevice() filter? */
export function matchesFilter(d, f) {
  if (f.vendorId !== undefined && f.vendorId !== d.vendorId) return false;
  if (f.productId !== undefined && f.productId !== d.productId) return false;
  if (f.serialNumber !== undefined && f.serialNumber !== d.serialNumber) return false;
  const classMatch = (cls, sub, proto) =>
    (f.classCode === undefined || f.classCode === cls) &&
    (f.subclassCode === undefined || f.subclassCode === sub) &&
    (f.protocolCode === undefined || f.protocolCode === proto);
  if (f.classCode === undefined && f.subclassCode === undefined && f.protocolCode === undefined) {
    return true;
  }
  if (classMatch(d.deviceClass, d.deviceSubclass, d.deviceProtocol)) {
    return true;
  }
  for (const c of d.configurations ?? []) {
    for (const i of c.interfaces) {
      for (const a of i.alternates) {
        if (classMatch(a.interfaceClass, a.interfaceSubclass, a.interfaceProtocol)) return true;
      }
    }
  }
  return false;
}

class Helper {
  constructor() {
    this.proc = null;
    this.starting = null;
    this.nextId = 1;
    this.waiting = new Map();
    this.listeners = new Set();
  }

  async ensure() {
    if (this.proc) return;
    if (!this.starting) {
      this.starting = this._start().finally(() => (this.starting = null));
    }
    await this.starting;
  }

  async _start() {
    const file = helperPath();
    if (!file.exists()) {
      throw new DOMExceptionLike("NotSupportedError", "Jace Browser's USB helper isn't installed.");
    }
    this.proc = await lazy.Subprocess.call({
      command: file.path,
      arguments: [],
      stderr: "ignore",
    });
    this._readLoop(this.proc);
    this.proc.wait().then(() => {
      this.proc = null;
      for (const [, { reject }] of this.waiting) {
        reject(new DOMExceptionLike("NetworkError", "The USB helper stopped."));
      }
      this.waiting.clear();
    });
    await this.request("hello");
  }

  async _readLoop(proc) {
    let buffer = "";
    for (;;) {
      const chunk = await proc.stdout.readString();
      if (!chunk) break;
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this._onLine(line);
      }
    }
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event) {
      for (const l of this.listeners) {
        try {
          l(msg);
        } catch (e) {
          console.error(e);
        }
      }
      return;
    }
    const w = this.waiting.get(msg.id);
    if (!w) return;
    this.waiting.delete(msg.id);
    if (msg.ok) {
      w.resolve(msg.result);
    } else {
      w.reject(new DOMExceptionLike(msg.error?.name ?? "NetworkError", msg.error?.message ?? "USB error"));
    }
  }

  async request(cmd, args = {}) {
    if (cmd !== "hello") await this.ensure();
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    await this.proc.stdin.write(JSON.stringify({ ...args, id, cmd }) + "\n");
    return promise;
  }
}

/** A plain error with a DOMException name, which the page side turns into a real DOMException. */
export class DOMExceptionLike extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

let permissions = null; // { [origin]: [{ key, label }] }

async function loadPermissions() {
  if (!permissions) {
    try {
      permissions = await IOUtils.readJSON(PERMISSIONS_FILE());
    } catch {
      permissions = {};
    }
  }
  return permissions;
}

async function savePermissions() {
  await IOUtils.writeJSON(PERMISSIONS_FILE(), permissions ?? {}, { tmpPath: `${PERMISSIONS_FILE()}.tmp` });
}

const helper = new Helper();
const devicesByGuid = new Map();
// guid -> the full description (with configurations) from the last open()
const openedInfo = new Map();
helper.listeners.add((msg) => {
  if (msg.event === "disconnect") {
    devicesByGuid.delete(msg.guid);
    openedInfo.delete(msg.guid);
  }
});

export const JaceUSBService = {
  PROTECTED_CLASSES,

  get enabled() {
    return Services.prefs.getBoolPref("jace.usb.enabled", true);
  },

  helperInstalled() {
    return helperPath().exists();
  },

  addEventListener(fn) {
    helper.listeners.add(fn);
  },

  removeEventListener(fn) {
    helper.listeners.delete(fn);
  },

  async listAll() {
    const list = await helper.request("list");
    devicesByGuid.clear();
    for (const d of list) devicesByGuid.set(d.guid, d);
    return list;
  },

  device(guid) {
    return devicesByGuid.get(guid) ?? null;
  },

  async allowedDevices(origin) {
    const perms = (await loadPermissions())[origin] ?? [];
    const keys = new Set(perms.map((p) => p.key));
    return (await this.listAll()).filter((d) => keys.has(deviceKey(d)));
  },

  async isAllowed(origin, guid) {
    let d = devicesByGuid.get(guid);
    if (!d) {
      await this.listAll();
      d = devicesByGuid.get(guid);
    }
    if (!d) return false;
    const perms = (await loadPermissions())[origin] ?? [];
    return perms.some((p) => p.key === deviceKey(d));
  },

  async grant(origin, device) {
    const perms = await loadPermissions();
    const list = (perms[origin] ??= []);
    if (!list.some((p) => p.key === deviceKey(device))) {
      list.push({ key: deviceKey(device), label: deviceLabel(device) });
      await savePermissions();
    }
  },

  async revoke(origin, key) {
    const perms = await loadPermissions();
    perms[origin] = (perms[origin] ?? []).filter((p) => key !== undefined && p.key !== key);
    if (!perms[origin].length) delete perms[origin];
    await savePermissions();
  },

  /** { [origin]: [{ key, label }] } for about:jace. */
  async allPermissions() {
    return structuredClone(await loadPermissions());
  },

  /**
   * Shows the device chooser for a requestDevice() call. Resolves with the
   * chosen device, or null if the person cancelled or nothing matched.
   */
  async choose(browsingContext, origin, filters, exclusionFilters) {
    const all = await this.listAll();
    const candidates = all.filter(
      (d) =>
        (!filters.length || filters.some((f) => matchesFilter(d, f))) &&
        !exclusionFilters.some((f) => matchesFilter(d, f)),
    );
    const win = browsingContext.topChromeWindow ?? Services.wm.getMostRecentWindow("navigator:browser");
    const host = (() => {
      try {
        return new URL(origin).host;
      } catch {
        return origin;
      }
    })();
    if (!candidates.length) {
      Services.prompt.alert(win, "Connect a USB device", `${host} wants to connect to a USB device, but no matching device is plugged in.`);
      return null;
    }
    const labels = candidates.map(deviceLabel);
    const selection = {};
    const ok = Services.prompt.select(win, "Connect a USB device", `${host} wants to connect to a USB device. Pick one to allow:`, labels, selection);
    if (!ok || selection.value < 0) return null;
    const device = candidates[selection.value];
    await this.grant(origin, device);
    return device;
  },

  /** Runs one USBDevice method for an origin that has permission for the device. */
  async call(origin, cmd, args) {
    if (!(await this.isAllowed(origin, args.guid))) {
      throw new DOMExceptionLike("SecurityError", "This site doesn't have access to that device.");
    }
    if (cmd === "claimInterface") {
      const opened = openedInfo.get(args.guid);
      const config = opened?.configurations?.find((c) => c.configurationValue === opened.configuration) ?? opened?.configurations?.[0];
      const iface = config?.interfaces.find((i) => i.interfaceNumber === args.interface);
      if (iface?.alternates.some((a) => PROTECTED_CLASSES.has(a.interfaceClass))) {
        throw new DOMExceptionLike("SecurityError", "That interface is a protected class (like a keyboard or USB stick) and can't be used with WebUSB.");
      }
    }
    const result = await helper.request(cmd, args);
    if (cmd === "open") {
      openedInfo.set(args.guid, result);
    } else if (cmd === "selectConfiguration" && openedInfo.has(args.guid)) {
      openedInfo.get(args.guid).configuration = args.value;
    } else if (cmd === "close") {
      openedInfo.delete(args.guid);
    }
    return result;
  },
};
