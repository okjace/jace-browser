/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * navigator.usb for Jace Browser (https://wicg.github.io/webusb/).
 *
 * Runs in a sandbox whose prototype is the page's window, with Xrays off, so
 * `window` here is the page's own window and objects we build with the page's
 * constructors (window.Object, window.Promise, ...) belong to the page.
 * `__jaceUsbBridge` is a private function from JaceUSBChild; the page can't
 * see it. Every call goes through the parent, which checks permissions.
 */

(function () {
  "use strict";

  const bridge = __jaceUsbBridge;
  const W = window;
  const { Promise, DOMException, Event, EventTarget, DataView, Uint8Array, ArrayBuffer, Object: WObject } = W;
  const wJSON = W.JSON;

  function call(cmd, args) {
    return new Promise((resolve, reject) => {
      bridge(
        cmd,
        JSON.stringify(args ?? {}),
        (json) => resolve(json === "null" ? null : wJSON.parse(json)),
        (json) => {
          let e;
          try {
            e = JSON.parse(json);
          } catch {
            e = { name: "NetworkError", message: "USB request failed." };
          }
          reject(new DOMException(e.message, e.name));
        },
      );
    });
  }

  function toBase64(data) {
    let bytes;
    if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      throw new W.TypeError("data must be an ArrayBuffer or ArrayBufferView");
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    }
    return W.btoa(binary);
  }

  function fromBase64(text) {
    const binary = W.atob(text || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new DataView(bytes.buffer);
  }

  /** A page-owned object with read-only data properties and methods. */
  function make(proto, props) {
    const obj = WObject.create(proto);
    for (const [k, v] of Object.entries(props)) {
      WObject.defineProperty(obj, k, typeof v === "function" && v.isGetter ? { get: v, enumerable: true } : { value: v, enumerable: true });
    }
    return obj;
  }
  function getter(fn) {
    fn.isGetter = true;
    return fn;
  }

  // Prototypes for the WebUSB interface objects, so `instanceof` works.
  function defineInterface(name) {
    const ctor = function () {
      throw new W.TypeError("Illegal constructor");
    };
    const proto = WObject.create(W.Object.prototype);
    WObject.defineProperty(proto, W.Symbol.toStringTag, { value: name });
    W[name] = WObject.assign(ctor, {});
    WObject.defineProperty(W[name], "prototype", { value: proto });
    WObject.defineProperty(proto, "constructor", { value: W[name] });
    return proto;
  }
  const P = {};
  for (const name of [
    "USBDevice",
    "USBConfiguration",
    "USBInterface",
    "USBAlternateInterface",
    "USBEndpoint",
    "USBInTransferResult",
    "USBOutTransferResult",
  ]) {
    P[name] = defineInterface(name);
  }

  const devices = new Map(); // guid -> { obj, state, desc }

  function buildConfiguration(c, state) {
    const interfaces = c.interfaces.map((i) => {
      const alternates = i.alternates.map((a) =>
        make(P.USBAlternateInterface, {
          alternateSetting: a.alternateSetting,
          interfaceClass: a.interfaceClass,
          interfaceSubclass: a.interfaceSubclass,
          interfaceProtocol: a.interfaceProtocol,
          interfaceName: a.interfaceName ?? null,
          endpoints: W.Array.from(
            a.endpoints.map((e) =>
              make(P.USBEndpoint, {
                endpointNumber: e.endpointNumber,
                direction: e.direction,
                type: e.type,
                packetSize: e.packetSize,
              }),
            ),
          ),
        }),
      );
      return make(P.USBInterface, {
        interfaceNumber: i.interfaceNumber,
        alternates: W.Array.from(alternates),
        alternate: getter(() => {
          const alt = state.alternates.get(i.interfaceNumber) ?? 0;
          return alternates.find((a) => a.alternateSetting === alt) ?? alternates[0] ?? null;
        }),
        claimed: getter(() => state.claimed.has(i.interfaceNumber)),
      });
    });
    return make(P.USBConfiguration, {
      configurationValue: c.configurationValue,
      configurationName: c.configurationName ?? null,
      interfaces: W.Array.from(interfaces),
    });
  }

  function deviceFor(desc) {
    let entry = devices.get(desc.guid);
    if (entry) {
      entry.update(desc);
      return entry.obj;
    }
    const state = { opened: false, claimed: new Set(), alternates: new Map(), configs: [], current: null };
    const guid = desc.guid;
    const update = (d) => {
      if (d.configurations && d.configurations.length) {
        state.configs = d.configurations.map((c) => buildConfiguration(c, state));
      }
      if (d.configuration !== undefined && d.configuration !== null) {
        state.current = d.configuration;
      }
    };
    update(desc);

    const needOpen = () => {
      if (!state.opened) {
        throw new DOMException("The device must be opened first.", "InvalidStateError");
      }
    };
    const run = (cmd, args) => call(cmd, { guid, ...args });
    const method = (fn) =>
      function (...args) {
        try {
          return fn(...args);
        } catch (e) {
          return Promise.reject(e);
        }
      };

    const obj = make(P.USBDevice, {
      usbVersionMajor: desc.usbVersionMajor,
      usbVersionMinor: desc.usbVersionMinor,
      usbVersionSubminor: desc.usbVersionSubminor,
      deviceClass: desc.deviceClass,
      deviceSubclass: desc.deviceSubclass,
      deviceProtocol: desc.deviceProtocol,
      vendorId: desc.vendorId,
      productId: desc.productId,
      deviceVersionMajor: desc.deviceVersionMajor,
      deviceVersionMinor: desc.deviceVersionMinor,
      deviceVersionSubminor: desc.deviceVersionSubminor,
      manufacturerName: desc.manufacturerName ?? null,
      productName: desc.productName ?? null,
      serialNumber: desc.serialNumber ?? null,
      opened: getter(() => state.opened),
      configurations: getter(() => W.Array.from(state.configs)),
      configuration: getter(
        () => state.configs.find((c) => c.configurationValue === state.current) ?? null,
      ),
      open: method(() =>
        run("open").then((d) => {
          update(d);
          state.opened = true;
        }),
      ),
      close: method(() =>
        run("close").then(() => {
          state.opened = false;
          state.claimed.clear();
          state.alternates.clear();
        }),
      ),
      forget: method(() =>
        call("forget", { guid }).then(() => {
          state.opened = false;
          devices.delete(guid);
        }),
      ),
      selectConfiguration: method((value) => {
        needOpen();
        return run("selectConfiguration", { value }).then(() => {
          state.current = value;
          state.claimed.clear();
          state.alternates.clear();
        });
      }),
      claimInterface: method((iface) => {
        needOpen();
        return run("claimInterface", { interface: iface }).then(() => {
          state.claimed.add(iface);
        });
      }),
      releaseInterface: method((iface) => {
        needOpen();
        return run("releaseInterface", { interface: iface }).then(() => {
          state.claimed.delete(iface);
          state.alternates.delete(iface);
        });
      }),
      selectAlternateInterface: method((iface, alternate) => {
        needOpen();
        return run("selectAlternateInterface", { interface: iface, alternate }).then(() => {
          state.alternates.set(iface, alternate);
        });
      }),
      controlTransferIn: method((setup, length) => {
        needOpen();
        return run("controlTransferIn", { setup: plainSetup(setup), length }).then((r) =>
          make(P.USBInTransferResult, { data: fromBase64(r.data), status: r.status }),
        );
      }),
      controlTransferOut: method((setup, data) => {
        needOpen();
        return run("controlTransferOut", { setup: plainSetup(setup), data: data === undefined ? "" : toBase64(data) }).then(
          (r) => make(P.USBOutTransferResult, { bytesWritten: r.bytesWritten, status: r.status }),
        );
      }),
      transferIn: method((endpointNumber, length) => {
        needOpen();
        return run("transferIn", { endpoint: endpointNumber, length }).then((r) =>
          make(P.USBInTransferResult, { data: fromBase64(r.data), status: r.status }),
        );
      }),
      transferOut: method((endpointNumber, data) => {
        needOpen();
        return run("transferOut", { endpoint: endpointNumber, data: toBase64(data) }).then((r) =>
          make(P.USBOutTransferResult, { bytesWritten: r.bytesWritten, status: r.status }),
        );
      }),
      clearHalt: method((direction, endpointNumber) => {
        needOpen();
        return run("clearHalt", { direction, endpoint: endpointNumber });
      }),
      reset: method(() => {
        needOpen();
        return run("reset");
      }),
      isochronousTransferIn: method(() =>
        Promise.reject(new DOMException("Isochronous transfers aren't supported yet.", "NotSupportedError")),
      ),
      isochronousTransferOut: method(() =>
        Promise.reject(new DOMException("Isochronous transfers aren't supported yet.", "NotSupportedError")),
      ),
    });
    entry = { obj, state, update };
    devices.set(guid, entry);
    return obj;
  }

  function plainSetup(s) {
    if (!s || typeof s !== "object") {
      throw new W.TypeError("setup must be a USBControlTransferParameters object");
    }
    return {
      requestType: String(s.requestType),
      recipient: String(s.recipient),
      request: Number(s.request),
      value: Number(s.value),
      index: Number(s.index),
    };
  }

  function plainFilter(f) {
    const out = {};
    for (const k of ["vendorId", "productId", "classCode", "subclassCode", "protocolCode"]) {
      if (f && f[k] !== undefined) out[k] = Number(f[k]);
    }
    if (f && f.serialNumber !== undefined) out.serialNumber = String(f.serialNumber);
    return out;
  }

  // navigator.usb: a real page EventTarget with the WebUSB methods on it.
  const usb = new EventTarget();
  const USBProto = defineInterface("USB");
  WObject.setPrototypeOf(USBProto, EventTarget.prototype);
  WObject.setPrototypeOf(usb, USBProto);
  let onconnect = null;
  let ondisconnect = null;

  WObject.defineProperties(usb, {
    getDevices: {
      value: function getDevices() {
        return call("getDevices").then((list) => W.Array.from(list.map ? list.map(deviceFor) : []));
      },
    },
    requestDevice: {
      value: function requestDevice(options) {
        if (!options || !Array.isArray(options.filters)) {
          return Promise.reject(new W.TypeError("requestDevice() needs { filters: [...] }"));
        }
        return call("requestDevice", {
          filters: Array.from(options.filters, plainFilter),
          exclusionFilters: Array.from(options.exclusionFilters ?? [], plainFilter),
        }).then(deviceFor);
      },
    },
    onconnect: {
      get: () => onconnect,
      set: (fn) => {
        onconnect = typeof fn === "function" ? fn : null;
      },
    },
    ondisconnect: {
      get: () => ondisconnect,
      set: (fn) => {
        ondisconnect = typeof fn === "function" ? fn : null;
      },
    },
  });

  bridge("__events", "", (json) => {
    const msg = JSON.parse(json);
    let device;
    if (msg.type === "connect") {
      device = deviceFor(msg.device);
    } else {
      const entry = devices.get(msg.guid);
      if (!entry) return;
      entry.state.opened = false;
      device = entry.obj;
    }
    const event = new Event(msg.type);
    WObject.defineProperty(event, "device", { value: device });
    const handler = msg.type === "connect" ? onconnect : ondisconnect;
    usb.dispatchEvent(event);
    if (handler) {
      try {
        handler.call(usb, event);
      } catch (e) {
        W.reportError?.(e);
      }
    }
  });

  WObject.defineProperty(W.Navigator.prototype, "usb", {
    get() {
      return usb;
    },
    enumerable: true,
    configurable: true,
  });
})();
