// Small helpers over browser.storage.local.

export async function get(key, fallback = undefined) {
  const v = (await browser.storage.local.get(key))[key];
  return v === undefined ? fallback : v;
}

export function set(key, value) {
  return browser.storage.local.set({ [key]: value });
}

export function remove(keys) {
  return browser.storage.local.remove(keys);
}

/** Notifies open popups / options pages that something changed. */

import "./compat.js";
export function notify(type, detail = {}) {
  browser.runtime.sendMessage({ type, ...detail }).catch(() => {});
}
