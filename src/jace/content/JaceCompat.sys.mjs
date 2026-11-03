/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Firefox keeps moving its browser modules from resource:///modules/ to
 * moz-src:/// paths. These load a module from wherever this Firefox has it,
 * so Jace Browser keeps working across Firefox versions.
 */

export function importFirst(urls) {
  let lastError;
  for (const url of urls) {
    try {
      return ChromeUtils.importESModule(url);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

export function getCustomizableUI() {
  return importFirst([
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
    "resource:///modules/CustomizableUI.sys.mjs",
  ]).CustomizableUI;
}

export function getMigrationUtils() {
  return importFirst([
    "moz-src:///browser/components/migration/MigrationUtils.sys.mjs",
    "resource:///modules/MigrationUtils.sys.mjs",
  ]).MigrationUtils;
}

export function getShellService() {
  return importFirst([
    "moz-src:///browser/components/shell/ShellService.sys.mjs",
    "resource:///modules/ShellService.sys.mjs",
  ]).ShellService;
}

const PAGE_URLS = {
  jace: "chrome://jace/content/settings/settings.html",
  "jace-setup": "chrome://jace/content/setup/setup.html",
};

/**
 * The address of a Jace page: about:jace / about:jace-setup when those are
 * registered, otherwise the page's chrome:// address (works either way).
 */
export function jacePageURL(what) {
  const contract = `@mozilla.org/network/protocol/about;1?what=${what}`;
  return contract in Cc ? `about:${what}` : PAGE_URLS[what];
}
