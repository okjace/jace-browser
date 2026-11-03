/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * One look everywhere: gives the browser's own pages (settings, new tab,
 * add-ons, downloads, passwords, ...) Jace Browser's colors, accent and
 * rounded style, to match the window (skin/jace.css) and Jace's pages.
 *
 * Firefox's built-in pages share design tokens (--color-accent-primary,
 * --background-color-canvas, ...); a user style sheet scoped to those pages
 * overrides them. It also hides Firefox-only sections of the settings page
 * (Firefox updates, data collection, More from Mozilla). The sheet is
 * rebuilt when the accent color changes.
 */

const PAGES = [
  "about:preferences",
  "about:settings",
  "about:addons",
  "about:newtab",
  "about:home",
  "about:privatebrowsing",
  "about:downloads",
  "about:logins",
  "about:profiles",
  "about:support",
  "about:config",
  "about:protections",
  "about:certerror",
  "about:neterror",
  "about:tabcrashed",
  "about:welcome",
];

function css(accent) {
  const scope = PAGES.map((p) => `url-prefix("${p}")`).join(", ");
  return `@-moz-document ${scope} {
  :root {
    --jace-accent: ${accent};
    --color-accent-primary: ${accent} !important;
    --color-accent-primary-hover: color-mix(in srgb, ${accent} 85%, black) !important;
    --color-accent-primary-active: color-mix(in srgb, ${accent} 70%, black) !important;
    --color-accent-primary-selected: ${accent} !important;
    --button-background-color-primary: ${accent} !important;
    --button-background-color-primary-hover: color-mix(in srgb, ${accent} 88%, black) !important;
    --button-background-color-primary-active: color-mix(in srgb, ${accent} 75%, black) !important;
    --button-text-color-primary: #0c1410 !important;
    --button-text-color-primary-hover: #0c1410 !important;
    --button-text-color-primary-active: #0c1410 !important;
    --in-content-primary-button-background: ${accent} !important;
    --in-content-primary-button-background-hover: color-mix(in srgb, ${accent} 88%, black) !important;
    --in-content-primary-button-background-active: color-mix(in srgb, ${accent} 75%, black) !important;
    --in-content-primary-button-text-color: #0c1410 !important;
    --in-content-accent-color: ${accent} !important;
    --focus-outline-color: ${accent} !important;
    --link-color: ${accent} !important;
    --link-color-hover: color-mix(in srgb, ${accent} 85%, black) !important;
    --checkbox-checked-bgcolor: ${accent} !important;
    --border-radius-small: 6px !important;
    --border-radius-medium: 10px !important;
    --border-radius-large: 14px !important;
    --background-color-canvas: #f4f5f7 !important;
    --background-color-box: #ffffff !important;
    --in-content-page-background: #f4f5f7 !important;
    --in-content-box-background: #ffffff !important;
    --newtab-background-color: #f4f5f7 !important;
    --newtab-background-color-secondary: #ffffff !important;
    accent-color: ${accent};
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --color-accent-primary-hover: color-mix(in srgb, ${accent} 85%, white) !important;
      --link-color-hover: color-mix(in srgb, ${accent} 85%, white) !important;
      --background-color-canvas: #111317 !important;
      --background-color-box: #1b1e24 !important;
      --in-content-page-background: #111317 !important;
      --in-content-box-background: #1b1e24 !important;
      --newtab-background-color: #111317 !important;
      --newtab-background-color-secondary: #1b1e24 !important;
    }
  }
  body {
    background-color: var(--background-color-canvas);
  }
  :is(button, .button, moz-button)[type="primary"],
  :is(button, .button).primary,
  :is(button, .button)[default] {
    border-radius: var(--border-radius-medium) !important;
  }

  /* Settings: Firefox-only sections Jace Browser doesn't use */
  #category-more-from-mozilla,
  #moreFromMozillaCategory,
  #category-experimental,
  #firefoxExperimentalCategory,
  #updateApp,
  #updatesCategory,
  #dataCollectionCategory,
  #dataCollectionGroup,
  #category-sync,
  #fxaGroup,
  #firefoxViewSection,
  #relayIntegrationBox,
  .helpButton,
  #helpButton {
    display: none !important;
  }

  /* The Jace section added by JaceSettingsPane */
  #category-jace .category-icon {
    list-style-image: url("chrome://branding/content/icon32.png");
  }
  #jace-settings-frame {
    display: block;
    width: 100%;
    min-height: calc(100vh - 120px);
    border: 0;
    background: transparent;
  }
}`;
}

const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
let current = null;

function apply() {
  const accent = Services.prefs.getStringPref("jace.theme.accent", "#3ddc84");
  const safe = /^#[0-9a-f]{3,8}$/i.test(accent) ? accent : "#3ddc84";
  const uri = Services.io.newURI(`data:text/css;charset=utf-8,${encodeURIComponent(css(safe))}`);
  if (current && sss.sheetRegistered(current, sss.USER_SHEET)) {
    sss.unregisterSheet(current, sss.USER_SHEET);
  }
  sss.loadAndRegisterSheet(uri, sss.USER_SHEET);
  current = uri;
}

let started = false;

export const JaceContentStyle = {
  get started() {
    return started && !!current && sss.sheetRegistered(current, sss.USER_SHEET);
  },

  start() {
    if (started) return;
    started = true;
    apply();
    Services.prefs.addObserver("jace.theme.accent", () => apply());
  },
};
