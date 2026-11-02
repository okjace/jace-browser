# Jace Browser

**A Firefox-based browser with a Zen-style look, Jace accounts, and sync that signs you in everywhere.**

<img src="branding/logo-1024.png" width="96" alt="Jace Browser logo">

## Features

- **Zen-style look**: the window is one soft surface, web pages float on it as a rounded card, tabs are pills, and the accent is Jace green (change it in about:jace).
- **Vertical tabs you can turn off**: on by default. Turn them off or on with the tabs button in the toolbar, **Ctrl+Alt+V** (**Cmd+Opt+V** on macOS), or **about:jace → Look**. Compact mode hides the sidebar until you hover the left edge.
- **Jace account**: the account button signs you in with your [Jace](https://jaceo.vercel.app) account (okjace/Jace), the same way Jace OS does.
- **Jace sync**: bookmarks, history (90 days), passwords, open tabs, settings, your add-on list, and **site sign-ins** (cookies).
  - Sign in to Jace on a new computer, enter your sync passphrase once, and you're signed in to the sites you were signed in to on your other devices.
  - Everything is encrypted on your device (AES-256-GCM, with a key made from your sync passphrase) before it goes to Jace, so Jace can't read it.
  - Tabs from your other devices are in the account panel; add-ons from your other devices are in about:jace with a **Get it** button.
  - Some sites tie a sign-in to one device or network and will still ask you to sign in.
- **WebUSB** (`navigator.usb`): Firefox doesn't have it, so Jace Browser adds it with a small native helper (`usb-helper/`).
  - A site only gets a device after you pick it.
  - Keyboards, mice, USB sticks, webcams, audio and other protected interfaces are blocked, the same as in Chrome.
  - Manage which sites can use which devices in about:jace.
- **DRM**: Widevine is on for **Windows and macOS** (and Linux). It downloads the first time a site needs it, so Netflix, Disney+, Spotify and the rest play.
- **Quiet**: telemetry, studies, sponsored tiles and Pocket are off.
- **Updates**: when a new release is out, an **Update to vX** bar appears. You can also use **about:jace → About → Check for updates**.

Everything Jace-specific is in **about:jace**.

## Downloads for Windows, macOS and Linux

GitHub Actions builds every platform. The workflow is in `.github/workflows/build.yml`.

| Platform | File | Install |
|---|---|---|
| Windows 10/11 | `JaceBrowser-<ver>-windows-x64-setup.exe` | Run it and follow the installer. Uninstall from **Settings → Apps → Installed apps**. |
| Windows (portable) | `JaceBrowser-<ver>-windows-x64-portable.zip` | Unzip anywhere and run `jace.exe`. |
| macOS 12+ (Apple Silicon) | `JaceBrowser-<ver>-macos-arm64.dmg` | Open it and drag **Jace Browser** to **Applications**. |
| macOS 12+ (Intel) | `JaceBrowser-<ver>-macos-x86_64.dmg` | Same as above. |
| Linux | `JaceBrowser-<ver>-x86_64.AppImage` | `chmod +x` it and run it. |
| Linux (tar.xz) | `JaceBrowser-<ver>-linux-x86_64.tar.xz` | Unpack it and run `jace/jace`. |

Every push to `main` builds and tests all of these; download them from the run's **Artifacts**. Each installer is tested in CI:
1. it's installed the way a person would (silent setup on Windows; from a quarantined .dmg on macOS; the AppImage on Linux)
2. the installed browser starts headless and runs a self-test: the Zen skin, about:jace, the toolbar buttons, sync encryption, the USB helper, and DRM
3. it's uninstalled

**Releasing is automatic** (same as Jace Launcher):
1. Raise `version` in `jace.json`.
2. Add a `## <version>` section to `CHANGELOG.md`.
3. Push to `main`.

If every build and test passes, CI tags `v<version>`, publishes the GitHub Release (with that changelog section as its notes), and lists it on [Jace Store](https://jace-store-deb.vercel.app/project/jace-browser). Pushes that don't change the version only build and test. Pushing a `v*` tag by hand still works too.

For Jace Store, add a `JACE_STORE_TOKEN` repository secret and create the `jace-browser` project once (`node packaging/jace-store.mjs create --type app --title "Jace Browser" --slug jace-browser --summary "..."`). Without the secret, that step is skipped.

**Build time:** Firefox is big. Each platform takes 2–5 hours on GitHub's free runners, within the 6-hour job limit. Pull requests only run the quick tests.

**Unsigned builds:** the apps aren't signed with paid Apple or Microsoft certificates, so:
- **macOS** says the app "can't be opened". Right-click it, choose **Open**, then **Open** again (only needed once). On macOS 15 and newer, go to **System Settings → Privacy & Security → Open Anyway** instead.
- **Windows SmartScreen** shows "Windows protected your PC". Click **More info → Run anyway**.

Some streaming services check that the browser is one they've approved (Widevine "VMP" signing, which needs an agreement with Google) and limit unapproved browsers to lower resolution. Jace Browser plays protected content, but may get SD instead of HD/4K on those services.

## Building it yourself

You need what Firefox needs: Python 3, ~40 GB of disk, and a few hours. Plus Rust (for the USB helper) and `pip install pillow`.

```bash
python3 scripts/build.py all
```

That downloads Firefox's source (checked against Mozilla's SHA-512 sums) to `engine/`, adds Jace Browser to it, builds it, and puts the installers in `dist/`. The steps on their own:

```bash
python3 scripts/build.py download
```

```bash
python3 scripts/build.py prepare
```

```bash
python3 scripts/build.py build
```

```bash
python3 scripts/build.py package
```

Windows builds are cross-compiled on Linux (`--platform windows`), the way Mozilla builds Firefox. macOS builds run on a Mac.

**Trying a change quickly:** everything Jace Browser adds loads through Firefox's autoconfig, so you can copy it into a regular Firefox and skip the build:

```bash
python3 scripts/dev-install.py "/Applications/Firefox.app"
```

Then start Firefox with a fresh profile and open about:jace. `--remove` undoes it.

**Updating Firefox:** change `firefox` in `jace.json`. Jace Browser changes only two lines of Firefox's own files (see `src/jace/README.md`), so new versions rarely need more.

## How it fits together

- `src/jace/`: the browser features (JavaScript modules, the skin, about:jace). See [`src/jace/README.md`](src/jace/README.md).
- `usb-helper/`: the native WebUSB helper (Rust, [nusb](https://crates.io/crates/nusb)).
- `branding/`: the logo; `scripts/build.py` turns it into every icon Firefox needs.
- `configs/`: build options (`mozconfig`), including `--enable-eme=widevine`.
- `tests/`: sync merge and encryption tests (`node --test tests/*.test.mjs`).
- The server side is in [okjace/Jace](https://github.com/okjace/jace): the `sync` scope, the Jace Browser sign-in client, and `/api/oauth/sync`.

### Jace sync, in detail

1. **Sign in**: Jace Browser is an OAuth public client (`00000000-0000-0000-0000-000000000003`) that signs in with PKCE on `http://127.0.0.1:47613/jace-browser/callback` and asks for `profile sync`. The token is kept in the password manager.
2. **Sync passphrase**: the first device picks one; a key is derived from it (PBKDF2-SHA256, 600,000 rounds). Jace stores only the salt and a check value, so another device can tell if you typed the right one.
3. **Each collection** (bookmarks, history, passwords, cookies, tabs, prefs, addons) is one AES-256-GCM blob on Jace with a version number. Devices merge three ways (this device, Jace, and the last state they agreed on), so deletions and edits travel correctly and two devices syncing at once never overwrite each other.
4. Every 10 minutes, at sign-in, and with **Sync now**.

## License

[MPL 2.0](LICENSE), like Firefox. Firefox is a trademark of the Mozilla Foundation; Jace Browser is not made or endorsed by Mozilla.

**Built by Claude, made by Anthropic.**
