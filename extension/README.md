# Jace for Firefox

A Firefox extension that brings your Jace account to regular Firefox.

- **Sign in with Jace** from the toolbar button.
- **Jace sync**, end-to-end encrypted with your sync passphrase: bookmarks, history (90 days), open tabs, and **site sign-ins** (cookies), so you're signed in to the same sites as on your other devices. It uses the same sync as [Jace Browser](../README.md), so Jace Browser and Firefox with this extension keep each other up to date.
- **Signed in to Jace websites automatically**: the Jace website, and Jace's own apps (Jace Social, Jace Store, …) skip the sign-in screen. Not in private windows or container tabs. Turn it off in the extension's settings.

Passwords aren't synced: Firefox doesn't let extensions read them. Jace Browser syncs them.

## Install

**Signed release** (once the repo has Mozilla signing keys, see below): download `jace-extension-<version>.xpi` from the [releases](https://github.com/okjace/jace-browser/releases) page in Firefox and click **Add**.

**For testing, without signing**:
1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and pick `extension/manifest.json`.

A temporary add-on is removed when Firefox closes.

## Signing and releases

Firefox only installs extensions signed by Mozilla. GitHub Actions (`.github/workflows/extension.yml`) does it:
1. Get a free API key at https://addons.mozilla.org/developers/addon/api/key/ (sign in with a Firefox account).
2. Add the two values as repository secrets **AMO_JWT_ISSUER** and **AMO_JWT_SECRET** (Settings → Secrets and variables → Actions).
3. Raise `version` in `extension/manifest.json` and push.

The workflow then signs it as an "unlisted" add-on (not shown on addons.mozilla.org) and publishes it as a release tagged `extension-v<version>`.

## How it works

- `lib/account.js`: Sign in with Jace, with the same OAuth client as Jace Browser (PKCE, loopback redirect, caught by `background.js`).
- `lib/sync.js`, `lib/engines.js`: sync through Jace's `/api/oauth/sync`, one encrypted collection per kind of data.
- `lib/crypto.js`, `lib/merge.js`, `lib/cookies.js`: **copies** of Jace Browser's `src/jace/content/sync/` files, so both encrypt, merge and describe cookies identically. Edit the originals and run `python3 extension/tools/sync-shared.py`; CI fails if they differ.
- `lib/websites.js`: signing in to Jace websites.
