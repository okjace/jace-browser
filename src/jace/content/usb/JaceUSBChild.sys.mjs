/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Child half of the JaceUSB window actor (runs in the web content process).
 * Before a secure page's scripts run, it defines navigator.usb by running
 * webusb-polyfill.js in a sandbox that shares the page's principal, and gives
 * that sandbox (not the page) one private function to reach the parent.
 */

export class JaceUSBChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type === "DOMDocElementInserted" && event.target === this.document) {
      this.inject();
    }
  }

  inject() {
    const win = this.contentWindow;
    if (!win || !win.isSecureContext || !Services.prefs.getBoolPref("jace.usb.enabled", true)) {
      return;
    }
    if ("usb" in win.navigator.wrappedJSObject) {
      return;
    }
    const sandbox = Cu.Sandbox(win, {
      sandboxPrototype: win,
      sameZoneAs: win,
      wantXrays: false,
      wantComponents: false,
      sandboxName: "Jace Browser WebUSB",
    });

    const bridge = (cmd, argsJSON, resolve, reject) => {
      if (cmd === "__events") {
        this.eventCallback = resolve;
        return;
      }
      let userActivation = false;
      if (cmd === "requestDevice") {
        userActivation = this.document.hasValidTransientUserGestureActivation;
        if (userActivation) {
          this.document.consumeTransientUserGestureActivation();
        }
      }
      let args;
      try {
        args = JSON.parse(argsJSON);
      } catch {
        args = {};
      }
      this.sendQuery("usb", { cmd, args, userActivation }).then(
        (reply) => {
          if (reply?.ok) {
            resolve(JSON.stringify(reply.result ?? null));
          } else {
            reject(JSON.stringify(reply?.error ?? { name: "NetworkError", message: "USB request failed." }));
          }
        },
        () => reject(JSON.stringify({ name: "AbortError", message: "The page went away." })),
      );
    };
    Cu.exportFunction(bridge, sandbox, { defineAs: "__jaceUsbBridge" });
    Services.scriptloader.loadSubScript("resource://jace/content/usb/webusb-polyfill.js", sandbox);
  }

  receiveMessage({ name, data }) {
    if (name === "usb-event" && this.eventCallback) {
      try {
        this.eventCallback(JSON.stringify(data));
      } catch (e) {
        console.error(e);
      }
    }
  }
}
