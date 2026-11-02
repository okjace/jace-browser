# src/jace: Jace Browser's own code

Everything Jace Browser adds to Firefox lives here. `scripts/build.py prepare`
copies it to `engine/browser/jace` and installs it next to the browser:

| Installed as | From | What it does |
|---|---|---|
| `defaults/pref/autoconfig.js` + `jace.cfg` | `autoconfig/` | Firefox's autoconfig runs `jace.cfg` at startup. It registers `chrome://jace/` and `resource://jace/` from the `jace/` folder and starts `JaceLoader`. |
| `browser/defaults/preferences/jace-prefs.js` | `defaults/` | Default settings: vertical tabs on, DRM on, Jace account server, updates. |
| `distribution/policies.json` | `policies/` | Enterprise policies: telemetry, studies, Pocket, sponsored content and Mozilla's messaging off. |
| `jace/content/` | `content/` | The features (below). |
| `jace/skin/` | `skin/` | The Zen-style look and icons. |
| `jace/bin/jace-usb-helper` | `../../usb-helper` | Native USB access for WebUSB. |

Because it's loaded this way, Firefox's own source needs only two one-line
changes (a `DIRS` entry and the package manifest), so moving to a new Firefox
version is just changing `firefox` in `jace.json`.

## Modules

- `JaceLoader.sys.mjs`: startup; registers about:jace, the toolbar buttons, the WebUSB actor, and each window.
- `JaceWindow.sys.mjs`: per-window look, Ctrl+Alt+V for vertical tabs, the account panel.
- `JaceAccount.sys.mjs`: Sign in with Jace (OAuth + PKCE on a loopback redirect, like Jace OS).
- `JaceSecrets.sys.mjs`: the token and sync key, kept in the password manager.
- `sync/`: Jace sync. `JaceCrypto` (AES-256-GCM, PBKDF2 passphrase key), `JaceMerge` (three-way merge), `JaceEngines` (bookmarks, history, passwords, cookies, tabs, prefs, add-ons), `JaceSync` (talks to Jace's `/api/oauth/sync`).
- `usb/`: WebUSB. `JaceUSBChild` defines `navigator.usb` in secure pages using `webusb-polyfill.js`; `JaceUSBParent` checks permissions; `JaceUSBService` runs the helper, shows the device chooser and remembers choices.
- `JaceSplash.sys.mjs`: the startup animation (styles at the end of `skin/jace.css`).
- `setup/`: about:jace-setup, the first-run setup. Opening `setup.html` from a plain web server shows it with the browser parts stubbed out, for working on the design.
- `JaceUpdates.sys.mjs`: automatic updates: download, SHA-256 check, install on quit.
- `JaceSelfTest.sys.mjs`: what CI's installer tests run (`JACE_SELF_TEST_OUT=file`).
- `settings/`: about:jace.

## Privacy

Mozilla's tracking is removed in two layers, both locked so add-ons, studies
or a pref reset can't turn it back on:

- `autoconfig/jace.cfg` `lockPref`s every data-collection pref: telemetry
  and Glean, Normandy/Nimbus studies and experiments, crash report
  submission, sponsored content and its tracking, privacy-preserving
  attribution, search telemetry, recommendations, captive portal and
  connectivity pings, region lookup, Mozilla accounts, and Firefox's updater.
- `policies/policies.json` turns on the matching enterprise policies
  (DisableTelemetry, DisableFirefoxStudies, DisablePocket, FirefoxHome,
  FirefoxSuggest, UserMessaging, ...).

The build itself has no crash reporter, updater, maintenance service or
default browser agent (`configs/mozconfig.*`).

Safe Browsing, Remote Settings security lists, the Widevine download and
add-on updates stay on; about:jace explains why.
