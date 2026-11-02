# src/jace: Jace Browser's own code

Everything Jace Browser adds to Firefox lives here. `scripts/build.py prepare`
copies it to `engine/browser/jace` and installs it next to the browser:

| Installed as | From | What it does |
|---|---|---|
| `defaults/pref/autoconfig.js` + `jace.cfg` | `autoconfig/` | Firefox's autoconfig runs `jace.cfg` at startup. It registers `chrome://jace/` and `resource://jace/` from the `jace/` folder and starts `JaceLoader`. |
| `browser/defaults/preferences/jace-prefs.js` | `defaults/` | Default settings: vertical tabs on, DRM on, Jace account server, telemetry off. |
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
- `JaceUpdates.sys.mjs`: "Update to vX" bar from GitHub releases.
- `JaceSelfTest.sys.mjs`: what CI's installer tests run (`JACE_SELF_TEST_OUT=file`).
- `settings/`: about:jace.
