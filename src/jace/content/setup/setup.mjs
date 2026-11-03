/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// about:jace-setup: the first-run setup. Shown once (jace.setup.done), and
// again from about:jace -> "Run setup again".
//
// Outside Jace Browser (opened as a plain file, e.g. to preview the design),
// the browser APIs are stubbed so every step still works.

const inBrowser = typeof ChromeUtils !== "undefined";

const api = inBrowser ? browserApi() : previewApi();

function browserApi() {
  const { JaceAccount } = ChromeUtils.importESModule("chrome://jace/content/JaceAccount.sys.mjs");
  const { JaceSync } = ChromeUtils.importESModule("chrome://jace/content/sync/JaceSync.sys.mjs");
  const { ANIMATED_LOGO_SVG } = ChromeUtils.importESModule("chrome://jace/content/JaceSplash.sys.mjs");
  const win = () => window.browsingContext.topChromeWindow;
  return {
    logo: ANIMATED_LOGO_SVG,
    os: Services.appinfo.OS,
    getBool: (p, d) => Services.prefs.getBoolPref(p, d),
    setBool: (p, v) => Services.prefs.setBoolPref(p, v),
    getString: (p, d) => Services.prefs.getStringPref(p, d),
    setString: (p, v) => Services.prefs.setStringPref(p, v),
    get profile() {
      return JaceAccount.profile;
    },
    signIn: () => JaceAccount.signIn(win()),
    hasKey: () => JaceSync.hasKey(),
    accountHasSync: () => JaceSync.accountHasSync(),
    setPassphrase: (p) => JaceSync.setPassphrase(p),
    onAccountChange(fn) {
      const observer = { observe: fn };
      Services.obs.addObserver(observer, "jace-account-changed");
      window.addEventListener("unload", () => Services.obs.removeObserver(observer, "jace-account-changed"));
    },
    async importData() {
      const { getMigrationUtils } = ChromeUtils.importESModule("chrome://jace/content/JaceCompat.sys.mjs");
      const MigrationUtils = getMigrationUtils();
      await MigrationUtils.showMigrationWizard(win(), {
        entrypoint: MigrationUtils.MIGRATION_ENTRYPOINTS?.FIRSTRUN ?? MigrationUtils.MIGRATION_ENTRYPOINTS?.UNKNOWN,
      });
    },
    async makeDefault() {
      let shell = win().ShellService;
      if (!shell) {
        const { getShellService } = ChromeUtils.importESModule("chrome://jace/content/JaceCompat.sys.mjs");
        shell = getShellService();
      }
      await shell.setDefaultBrowser(false);
      // The Linux test copy (scripts/try.sh) has its own app entry: point the
      // system's default browser at it, not at Firefox's (fox icon).
      if (Services.appinfo.OS === "Linux") {
        try {
          const entry = Services.dirsvc.get("Home", Ci.nsIFile);
          for (const part of [".local", "share", "applications", "jace-browser-test.desktop"]) entry.append(part);
          const tool = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          tool.initWithPath("/usr/bin/xdg-settings");
          if (entry.exists() && tool.exists()) {
            const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
            proc.init(tool);
            proc.runw(true, ["set", "default-web-browser", "jace-browser-test.desktop"]);
            return true;
          }
        } catch (e) {
          console.warn("Jace: couldn't set the test copy as default", e);
        }
      }
      return shell.isDefaultBrowser(false, false);
    },
    finish() {
      Services.prefs.setBoolPref("jace.setup.done", true);
      win().openTrustedLinkIn("about:home", "current");
    },
  };
}

function previewApi() {
  const prefs = { "sidebar.verticalTabs": true, "jace.theme.floatingContent": true, "jace.startup.animation": true };
  let profile = null;
  const listeners = [];
  return {
    logo: globalThis.JACE_PREVIEW_LOGO ?? null,
    os: "Linux",
    getBool: (p, d) => prefs[p] ?? d,
    setBool: (p, v) => (prefs[p] = v),
    getString: (p, d) => prefs[p] ?? d,
    setString: (p, v) => (prefs[p] = v),
    get profile() {
      return profile;
    },
    async signIn() {
      profile = { name: "Jace", username: "jace", picture: null };
      listeners.forEach((f) => f());
    },
    hasKey: async () => false,
    accountHasSync: async () => false,
    setPassphrase: async () => ({ created: true }),
    onAccountChange: (fn) => listeners.push(fn),
    importData: async () => {},
    makeDefault: async () => true,
    finish: () => {},
  };
}

const $ = (id) => document.getElementById(id);
const steps = [...document.querySelectorAll(".step")];
let index = 0;

// ------------------------------------------------------------------ navigation

const dots = $("dots");
for (let i = 0; i < steps.length; i++) dots.append(document.createElement("i"));

function show(i, back = false) {
  index = Math.max(0, Math.min(steps.length - 1, i));
  steps.forEach((s, n) => {
    s.classList.toggle("active", n === index);
    s.classList.toggle("back", n === index && back);
  });
  [...dots.children].forEach((d, n) => d.classList.toggle("on", n === index));
  dots.hidden = index === 0 || index === steps.length - 1;
  const step = steps[index];
  if (step.dataset.step === "done") burst();
  step.querySelector("button.primary, button")?.focus({ preventScroll: true });
  history.replaceState(null, "", `#${step.dataset.step}`);
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-next]")) show(index + 1);
  else if (e.target.closest("[data-back]")) show(index - 1, true);
});
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input")) return;
  if (e.key === "ArrowRight" && index > 0 && index < steps.length - 1) show(index + 1);
  if (e.key === "ArrowLeft" && index > 0) show(index - 1, true);
});

// ------------------------------------------------------------------ logo

let logoCount = 0;
function placeLogo(el) {
  if (!api.logo) {
    el.innerHTML = '<svg class="jace-logo" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#3ddc84"/></svg>';
    return;
  }
  // Each copy needs its own gradient id, or the second logo loses its color.
  const markup = api.logo.replaceAll("jace-logo-g", `jace-logo-g${++logoCount}`);
  el.replaceChildren(new DOMParser().parseFromString(markup, "image/svg+xml").documentElement);
}
placeLogo($("hero-logo"));
placeLogo($("done-logo"));

// ------------------------------------------------------------------ tabs

const tabChoices = document.querySelectorAll("[data-tabs]");
function renderTabs() {
  const vertical = api.getBool("sidebar.verticalTabs", true);
  tabChoices.forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.tabs === "vertical") === vertical)));
  // The tab style only matters for vertical tabs.
  $("tab-style").hidden = !vertical;
}
tabChoices.forEach((b) =>
  b.addEventListener("click", () => {
    const vertical = b.dataset.tabs === "vertical";
    if (vertical) api.setBool("sidebar.revamp", true);
    api.setBool("sidebar.verticalTabs", vertical);
    renderTabs();
  }),
);

/** A row of buttons that sets one string pref. */
function segmented(id, attr, pref, fallback) {
  const buttons = document.querySelectorAll(`#${id} [data-${attr}]`);
  const render = () => {
    const value = api.getString(pref, fallback);
    buttons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset[attr] === value)));
  };
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      api.setString(pref, b.dataset[attr]);
      render();
    }),
  );
  render();
}
segmented("tab-style", "style", "jace.tabs.verticalStyle", "full");
segmented("window-controls", "controls", "jace.windowControls.style", "system");
$("controls-system").textContent = api.os === "Linux" ? "GNOME" : api.os === "WINNT" ? "Windows" : "Match my system";
// macOS keeps its own window buttons.
$("window-controls-row").hidden = api.os === "Darwin";

renderTabs();

// ------------------------------------------------------------------ look

const ACCENTS = [
  ["Jace green", "#3ddc84"],
  ["Ocean", "#38bdf8"],
  ["Violet", "#a78bfa"],
  ["Pink", "#f472b6"],
  ["Sunset", "#fb923c"],
  ["Red", "#f87171"],
  ["Gold", "#facc15"],
  ["Mint", "#2dd4bf"],
];

function setAccent(color) {
  api.setString("jace.theme.accent", color);
  document.documentElement.style.setProperty("--accent", color);
  for (const s of document.querySelectorAll(".swatch")) {
    s.setAttribute("aria-pressed", String(s.dataset.color === color));
  }
}

for (const [name, color] of ACCENTS) {
  const b = document.createElement("button");
  b.className = "swatch";
  b.title = name;
  b.setAttribute("aria-label", name);
  b.dataset.color = color;
  b.style.setProperty("--c", color);
  b.addEventListener("click", () => setAccent(color));
  $("swatches").append(b);
}
setAccent(api.getString("jace.theme.accent", "#3ddc84"));

for (const [id, pref, fallback] of [
  ["compact", "jace.theme.compact", false],
  ["floating", "jace.theme.floatingContent", true],
  ["animation", "jace.startup.animation", true],
]) {
  const box = $(id);
  box.checked = api.getBool(pref, fallback);
  box.addEventListener("change", () => api.setBool(pref, box.checked));
}

// ------------------------------------------------------------------ import

$("import").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    await api.importData();
    $("import-result").textContent = "Done? Hit Continue. You can import again later from the Bookmarks menu.";
    document.querySelector('[data-step="import"] [data-next]').textContent = "Continue";
  } catch (err) {
    $("import-result").textContent = `Couldn't open the import window: ${err.message ?? err}`;
  } finally {
    e.target.disabled = false;
  }
});

// ------------------------------------------------------------------ account

let accountHasSync = null;

async function renderAccount() {
  const profile = api.profile;
  $("account-out").hidden = !!profile;
  $("account-in").hidden = !profile;
  if (!profile) return;
  $("name").textContent = profile.name;
  $("handle").textContent = `@${profile.username}`;
  if (profile.picture && /^https:/.test(profile.picture)) $("avatar").src = profile.picture;
  const hasKey = await api.hasKey();
  $("passphrase-form").hidden = hasKey;
  $("sync-on").hidden = !hasKey;
  $("account-next").textContent = hasKey ? "Continue" : "Skip sync";
  if (!hasKey) {
    accountHasSync ??= await api.accountHasSync().catch(() => false);
    $("passphrase-help").textContent = accountHasSync
      ? "Enter the sync passphrase you use on your other devices. You'll be signed in to your sites here too."
      : "Pick a sync passphrase. It encrypts your data so only your devices can read it; you'll type it once on each new device.";
    $("passphrase2").hidden = !!accountHasSync;
  }
}

$("sign-in").addEventListener("click", async (e) => {
  e.target.disabled = true;
  $("account-error").textContent = "";
  try {
    await api.signIn();
  } catch (err) {
    $("account-error").textContent = err.message ?? String(err);
  } finally {
    e.target.disabled = false;
  }
});

$("passphrase-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("account-error").textContent = "";
  const pass = $("passphrase").value;
  if (!accountHasSync && pass !== $("passphrase2").value) {
    $("account-error").textContent = "The two passphrases don't match.";
    return;
  }
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    await api.setPassphrase(pass);
    $("passphrase").value = $("passphrase2").value = "";
    await renderAccount();
    $("sync-on").hidden = false;
    $("passphrase-form").hidden = true;
  } catch (err) {
    $("account-error").textContent = err.message ?? String(err);
  } finally {
    button.disabled = false;
  }
});

api.onAccountChange(() => renderAccount());
renderAccount();

// ------------------------------------------------------------------ default browser

$("make-default").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    const ok = await api.makeDefault();
    $("default-result").textContent = ok
      ? "Jace Browser is your default browser."
      : "Finish in the window your system opened, then hit Continue.";
    document.querySelector('[data-step="default"] [data-next]').textContent = "Continue";
  } catch (err) {
    $("default-result").textContent = `Couldn't change it: ${err.message ?? err}`;
  } finally {
    e.target.disabled = false;
  }
});

// ------------------------------------------------------------------ done

function burst() {
  const box = $("burst");
  box.replaceChildren();
  const colors = ACCENTS.map(([, c]) => c);
  for (let i = 0; i < 70; i++) {
    const p = document.createElement("i");
    const angle = Math.random() * Math.PI * 2;
    const dist = 140 + Math.random() * 260;
    p.style.setProperty("--c", colors[i % colors.length]);
    p.style.setProperty("--x", `${Math.cos(angle) * dist}px`);
    p.style.setProperty("--y", `${Math.sin(angle) * dist + 120}px`);
    p.style.setProperty("--r", `${Math.random() * 720 - 360}deg`);
    p.style.setProperty("--d", `${Math.random() * 180}ms`);
    box.append(p);
  }
}

$("finish").addEventListener("click", () => api.finish());

// ------------------------------------------------------------------ start

const start = steps.findIndex((s) => `#${s.dataset.step}` === location.hash);
show(start > 0 ? start : 0);
