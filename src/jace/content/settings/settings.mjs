/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// about:jace (a privileged chrome page) - Jace account, sync, look, WebUSB, DRM.

const { JaceAccount } = ChromeUtils.importESModule("chrome://jace/content/JaceAccount.sys.mjs");
const { JaceSync } = ChromeUtils.importESModule("chrome://jace/content/sync/JaceSync.sys.mjs");
const { JaceUSBService } = ChromeUtils.importESModule("chrome://jace/content/usb/JaceUSBService.sys.mjs");
const { JaceUpdates } = ChromeUtils.importESModule("chrome://jace/content/JaceUpdates.sys.mjs");
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");

const $ = (id) => document.getElementById(id);
const browserWindow = () => window.browsingContext.topChromeWindow;

const ENGINE_LABELS = {
  bookmarks: "Bookmarks",
  history: "History (last 90 days)",
  passwords: "Passwords",
  cookies: "Site sign-ins (cookies)",
  tabs: "Open tabs",
  prefs: "Settings (look and a few preferences)",
  addons: "Add-on list",
};

function notice(text, isError = false) {
  const n = $("notice");
  n.textContent = text;
  n.classList.toggle("error", isError);
  n.hidden = !text;
  if (text) n.scrollIntoView({ block: "nearest" });
}

function item(label, title, actionLabel, action) {
  const row = document.createElement("div");
  row.className = "item";
  const span = document.createElement("span");
  span.textContent = label;
  if (title) span.title = title;
  row.append(span);
  if (actionLabel) {
    const b = document.createElement("button");
    b.textContent = actionLabel;
    b.addEventListener("click", action);
    row.append(b);
  }
  return row;
}

async function busy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    notice(e.message ?? String(e), true);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- account

function renderAccount() {
  const profile = JaceAccount.profile;
  $("account-signed-out").hidden = !!profile;
  $("account-signed-in").hidden = !profile;
  $("sign-in").textContent = JaceAccount.signingIn ? "Finish signing in in the other tab…" : "Sign in with Jace";
  if (profile) {
    $("profile-name").textContent = profile.name;
    $("profile-handle").textContent = `@${profile.username}`;
    if (profile.picture && /^https:/.test(profile.picture)) $("avatar").src = profile.picture;
    else $("avatar").removeAttribute("src");
    $("device-name").value = JaceAccount.deviceName;
  }
}

$("sign-in").addEventListener("click", (e) =>
  busy(e.target, async () => {
    await JaceAccount.signIn(browserWindow());
    notice("Signed in. Now turn on sync below.");
  }),
);
$("sign-out").addEventListener("click", (e) => busy(e.target, () => JaceAccount.signOut()));
$("refresh-profile").addEventListener("click", (e) => busy(e.target, () => JaceAccount.refreshProfile()));
$("device-name").addEventListener("change", (e) => {
  JaceAccount.deviceName = e.target.value.trim();
});

// ---------------------------------------------------------------- sync

let accountHasSync = null;

async function renderSync() {
  const signedIn = JaceAccount.signedIn;
  const status = JaceSync.status;
  const hasKey = signedIn && (await JaceSync.hasKey());
  $("passphrase-form").hidden = !signedIn || hasKey;
  $("sync-on").hidden = !hasKey;

  if (!signedIn) {
    $("sync-status").textContent = "Sign in to your Jace account to use sync.";
    return;
  }
  if (!hasKey) {
    if (accountHasSync === null) {
      accountHasSync = await JaceSync.accountHasSync().catch(() => false);
    }
    $("sync-status").textContent = "";
    $("passphrase-help").textContent = accountHasSync
      ? "You already use sync on another device. Enter the same sync passphrase to sync this browser too, and you'll be signed in to the sites you use there."
      : "Pick a sync passphrase. You'll type it once on each device you add.";
    $("passphrase-confirm-row").hidden = !!accountHasSync;
    $("passphrase").setAttribute("autocomplete", accountHasSync ? "current-password" : "new-password");
    return;
  }

  const when = status.lastSync ? new Date(status.lastSync).toLocaleString() : "not yet";
  $("sync-status").textContent =
    status.state === "syncing"
      ? "Syncing…"
      : status.state === "error"
        ? `Last sync had a problem: ${status.error}`
        : `Last synced: ${when}`;

  const engines = $("engines");
  engines.replaceChildren();
  for (const name of JaceSync.ENGINE_NAMES) {
    const label = document.createElement("label");
    label.className = "toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = JaceSync.engineEnabled(name);
    box.addEventListener("change", () => JaceSync.setEngineEnabled(name, box.checked));
    const text = document.createElement("span");
    text.textContent = ENGINE_LABELS[name] ?? name;
    label.append(box, text);
    engines.append(label);
  }

  const tabs = $("remote-tabs");
  const devices = await JaceSync.remoteTabs();
  tabs.replaceChildren();
  for (const d of devices) {
    const head = document.createElement("div");
    head.className = "device";
    head.textContent = `${d.device} · ${new Date(d.modified).toLocaleString()}`;
    tabs.append(head);
    for (const t of d.tabs) {
      tabs.append(item(t.title || t.url, t.url, "Open", () => browserWindow().openTrustedLinkIn(t.url, "tab")));
    }
  }
  if (!devices.length) tabs.innerHTML = '<p class="muted">None yet.</p>';

  const addonsBox = $("remote-addons");
  const mine = new Set((await AddonManager.getAllAddons()).map((a) => a.id));
  const remote = await JaceSync.remoteAddons();
  addonsBox.replaceChildren();
  for (const d of remote) {
    const missing = d.addons.filter((a) => !mine.has(a.id));
    if (!missing.length) continue;
    const head = document.createElement("div");
    head.className = "device";
    head.textContent = d.device;
    addonsBox.append(head);
    for (const a of missing) {
      addonsBox.append(
        item(a.name, a.id, "Get it", () =>
          browserWindow().openTrustedLinkIn(`https://addons.mozilla.org/firefox/addon/${encodeURIComponent(a.id)}/`, "tab"),
        ),
      );
    }
  }
  if (!addonsBox.children.length) addonsBox.innerHTML = '<p class="muted">You have them all.</p>';
}

$("passphrase-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pass = $("passphrase").value;
  if (!accountHasSync && pass !== $("passphrase-confirm").value) {
    notice("The two passphrases don't match.", true);
    return;
  }
  await busy(e.submitter ?? e.target.querySelector("button"), async () => {
    const { created } = await JaceSync.setPassphrase(pass);
    $("passphrase").value = $("passphrase-confirm").value = "";
    notice(created ? "Sync is on. Use the same passphrase on your other devices." : "Sync is on. Your stuff is coming over now.");
  });
  renderSync();
});

$("sync-now").addEventListener("click", (e) => busy(e.target, () => JaceSync.syncNow()));
$("forget-device").addEventListener("click", (e) =>
  busy(e.target, async () => {
    await JaceSync.forgetDevice();
    accountHasSync = null;
  }),
);
$("reset-sync").addEventListener("click", (e) =>
  busy(e.target, async () => {
    if (!window.confirm("Delete everything Jace Browser synced to your Jace account? Your other devices keep their own copies but stop syncing until you set a new passphrase.")) {
      return;
    }
    await JaceSync.resetAccountData();
    accountHasSync = false;
    notice("Your synced data was deleted from Jace.");
  }),
);

// ---------------------------------------------------------------- look & prefs

for (const box of document.querySelectorAll("input[data-pref]")) {
  const pref = box.dataset.pref;
  const read = () => (box.checked = Services.prefs.getBoolPref(pref, false));
  read();
  Services.prefs.addObserver(pref, read);
  window.addEventListener("unload", () => Services.prefs.removeObserver(pref, read));
  box.addEventListener("change", () => {
    if (pref === "sidebar.verticalTabs" && box.checked) Services.prefs.setBoolPref("sidebar.revamp", true);
    Services.prefs.setBoolPref(pref, box.checked);
    if (pref === "media.eme.enabled") renderDrm();
  });
}

$("accent").value = Services.prefs.getStringPref("jace.theme.accent", "#3ddc84");
$("accent").addEventListener("input", (e) => Services.prefs.setStringPref("jace.theme.accent", e.target.value));
$("accent-reset").addEventListener("click", () => {
  Services.prefs.clearUserPref("jace.theme.accent");
  $("accent").value = Services.prefs.getStringPref("jace.theme.accent", "#3ddc84");
});

// ---------------------------------------------------------------- WebUSB

async function renderUsb() {
  $("usb-helper").textContent = JaceUSBService.helperInstalled()
    ? "The USB helper is installed."
    : "The USB helper is missing from this build, so WebUSB can't reach devices.";
  const perms = await JaceUSBService.allPermissions();
  const list = $("usb-permissions");
  list.replaceChildren();
  for (const [origin, devices] of Object.entries(perms)) {
    for (const d of devices) {
      list.append(
        item(`${origin} — ${d.label}`, d.key, "Remove", async () => {
          await JaceUSBService.revoke(origin, d.key);
          renderUsb();
        }),
      );
    }
  }
  if (!list.children.length) list.innerHTML = '<p class="muted">None.</p>';
}

// ---------------------------------------------------------------- DRM

async function renderDrm() {
  const addon = await AddonManager.getAddonByID("gmp-widevinecdm").catch(() => null);
  let text;
  if (!Services.prefs.getBoolPref("media.eme.enabled", false)) {
    text = "DRM is off.";
  } else if (addon?.version && addon.version !== "null") {
    text = `Widevine ${addon.version} is installed${addon.isActive ? "" : " but turned off in Add-ons → Plugins"}.`;
  } else if (addon) {
    text = "Widevine will download the first time a site needs it.";
  } else {
    text = "Widevine isn't available in this build.";
  }
  $("widevine").textContent = text;
}

$("widevine-check").addEventListener("click", (e) =>
  busy(e.target, async () => {
    const { GMPInstallManager } = ChromeUtils.importESModule("resource://gre/modules/GMPInstallManager.sys.mjs");
    const result = await new GMPInstallManager().simpleCheckAndInstall();
    notice(result?.status === "nothing-new-to-install" ? "Widevine is up to date." : "Widevine checked; it's downloading if it was missing.");
    setTimeout(renderDrm, 3000);
  }),
);

// ---------------------------------------------------------------- about

$("versions").textContent = `Jace Browser ${JaceUpdates.currentVersion}, based on Firefox ${Services.appinfo.version}.`;
$("check-updates").addEventListener("click", (e) =>
  busy(e.target, async () => {
    const result = await JaceUpdates.check(browserWindow());
    $("update-result").textContent = result ? `Version ${result.latest} is available (see the bar at the top of the window).` : "You have the newest version.";
  }),
);

// ---------------------------------------------------------------- live updates

function renderAll() {
  renderAccount();
  renderSync().catch((e) => notice(e.message, true));
}

const observer = { observe: () => renderAll() };
Services.obs.addObserver(observer, "jace-account-changed");
Services.obs.addObserver(observer, "jace-sync-status");
window.addEventListener("unload", () => {
  Services.obs.removeObserver(observer, "jace-account-changed");
  Services.obs.removeObserver(observer, "jace-sync-status");
});

if (location.hash === "#signed-in") notice("You're signed in to Jace. You can close the sign-in tab.");
if (location.hash === "#sign-in-failed") notice("Signing in to Jace didn't work. Try again.", true);
if (location.hash === "#welcome") notice("Welcome to Jace Browser! Sign in with Jace to bring over your stuff from your other devices.");

renderAll();
renderUsb();
renderDrm();
