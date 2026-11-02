/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent half of the JaceUSB window actor: checks every navigator.usb call
 * from a page against the site's permissions and passes it to
 * JaceUSBService. Pages only ever name devices by an opaque guid, and only
 * get guids for devices the person picked for that site.
 */

import { JaceUSBService, deviceKey } from "chrome://jace/content/usb/JaceUSBService.sys.mjs";

const DEVICE_COMMANDS = new Set([
  "open",
  "close",
  "selectConfiguration",
  "claimInterface",
  "releaseInterface",
  "selectAlternateInterface",
  "controlTransferIn",
  "controlTransferOut",
  "transferIn",
  "transferOut",
  "clearHalt",
  "reset",
]);

const actors = new Set();
let listening = false;

function onHelperEvent(msg) {
  for (const actor of actors) {
    actor.forwardEvent(msg).catch(() => {});
  }
}

function asError(e) {
  return { ok: false, error: { name: e?.name || "NetworkError", message: String(e?.message ?? e) } };
}

export class JaceUSBParent extends JSWindowActorParent {
  actorCreated() {
    actors.add(this);
    if (!listening) {
      listening = true;
      JaceUSBService.addEventListener(onHelperEvent);
    }
  }

  didDestroy() {
    actors.delete(this);
  }

  get origin() {
    return this.manager.documentPrincipal.originNoSuffix;
  }

  /** Same rule as Chrome's default Permissions Policy for "usb": the page's own origin, and same-origin frames. */
  get allowedHere() {
    const top = this.browsingContext.top.currentWindowGlobal?.documentPrincipal;
    return !!top && top.originNoSuffix === this.origin && !this.manager.documentPrincipal.isNullPrincipal;
  }

  async forwardEvent(msg) {
    if (msg.event === "disconnect") {
      this.sendAsyncMessage("usb-event", { type: "disconnect", guid: msg.guid });
    } else if (msg.event === "connect" && (await JaceUSBService.isAllowed(this.origin, msg.device.guid))) {
      this.sendAsyncMessage("usb-event", { type: "connect", device: msg.device });
    }
  }

  async receiveMessage({ name, data }) {
    if (name !== "usb") {
      return null;
    }
    try {
      if (!JaceUSBService.enabled) {
        throw Object.assign(new Error("WebUSB is turned off in about:jace."), { name: "NotSupportedError" });
      }
      if (!this.allowedHere) {
        throw Object.assign(new Error("WebUSB isn't allowed in cross-origin frames."), { name: "SecurityError" });
      }
      const { cmd, args = {} } = data;
      switch (cmd) {
        case "getDevices":
          return { ok: true, result: await JaceUSBService.allowedDevices(this.origin) };
        case "requestDevice": {
          if (!data.userActivation) {
            throw Object.assign(new Error("requestDevice() must be called from a click or key press."), {
              name: "SecurityError",
            });
          }
          const device = await JaceUSBService.choose(
            this.browsingContext,
            this.origin,
            args.filters ?? [],
            args.exclusionFilters ?? [],
          );
          if (!device) {
            throw Object.assign(new Error("No device selected."), { name: "NotFoundError" });
          }
          return { ok: true, result: device };
        }
        case "forget": {
          const device = JaceUSBService.device(args.guid);
          if (device) {
            await JaceUSBService.revoke(this.origin, deviceKey(device));
          }
          return { ok: true, result: null };
        }
        default:
          if (!DEVICE_COMMANDS.has(cmd)) {
            throw Object.assign(new Error(`Unknown USB command ${cmd}.`), { name: "NotSupportedError" });
          }
          return { ok: true, result: await JaceUSBService.call(this.origin, cmd, args) };
      }
    } catch (e) {
      return asError(e);
    }
  }
}
