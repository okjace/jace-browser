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
