import "../lib/compat.js";
import { profile, signOut, startSignIn } from "../lib/account.js";
import {
  ENGINE_NAMES,
  accountHasSync,
  engineEnabled,
  forgetDevice,
  hasKey,
  remoteTabs,
  resetAccountData,
  setEngineEnabled,
  setPassphrase,
  status,
  syncNow,
  remoteAddons,
} from "../lib/sync.js";
import { get, set } from "../lib/store.js";
import { signInToWebsite } from "../lib/websites.js";

const $ = (id) => document.getElementById(id);
const LABELS = {
  bookmarks: "Bookmarks",
  history: "History (last 90 days)",
  cookies: "Site sign-ins (cookies)",
  tabs: "Open tabs",
  addons: "Add-on list",
};

function notice(text, isError = false) {
  const n = $("notice");
  n.textContent = text;
  n.classList.toggle("error", isError);
  n.hidden = !text;
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

let accountHas = null;

async function render() {
  const p = await profile();
  $("account-out").hidden = !!p;
  $("account-in").hidden = !p;
  $("sync-card").hidden = !p;
  if (!p) return;
  $("name").textContent = p.name;
  $("handle").textContent = `@${p.username}`;
  if (p.picture && /^https:/.test(p.picture)) $("avatar").src = p.picture;
  $("auto-sign-in").checked = await get("autoSignIn", true);

  const keyed = await hasKey();
  $("passphrase-form").hidden = keyed;
  $("sync-on").hidden = !keyed;
  if (!keyed) {
    $("sync-status").textContent = "";
    accountHas ??= await accountHasSync().catch(() => false);
    $("passphrase-help").textContent = accountHas
      ? "You already use sync on another device (Jace Browser or another Firefox). Enter the same sync passphrase, and you'll be signed in to the sites you use there."
      : "Pick a sync passphrase. You'll type it once on each device you add.";
    $("passphrase2").hidden = !!accountHas;
    return;
  }
  const s = await status();
  $("sync-status").textContent =
    s.state === "syncing" ? "Syncing…" : s.state === "error" ? `Last sync had a problem: ${s.error}` : `Last synced: ${s.lastSync ? new Date(s.lastSync).toLocaleString() : "not yet"}`;

  const engines = $("engines");
  engines.replaceChildren();
  for (const name of ENGINE_NAMES) {
    const label = document.createElement("label");
    label.className = "toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = await engineEnabled(name);
    box.addEventListener("change", () => setEngineEnabled(name, box.checked));
    const text = document.createElement("span");
    text.textContent = LABELS[name] ?? name;
    label.append(box, text);
    engines.append(label);
  }

  const tabs = $("remote-tabs");
  const devices = await remoteTabs();
  tabs.replaceChildren();
  for (const d of devices) {
    const head = document.createElement("div");
    head.className = "device";
    head.textContent = `${d.device} · ${new Date(d.modified).toLocaleString()}`;
    tabs.append(head);
    for (const t of d.tabs) {
      const a = document.createElement("a");
      a.href = t.url;
      a.target = "_blank";
      a.textContent = t.title || t.url;
      tabs.append(a);
    }
  }
  if (!devices.length) tabs.innerHTML = '<p class="muted">None yet.</p>';

  // Add-ons your other devices have and this Firefox doesn't.
  const box = $("remote-addons");
  const mine = new Set((await browser.management.getAll()).map((a) => a.id));
  const others = await remoteAddons();
  box.replaceChildren();
  for (const d of others) {
    const missing = (d.addons ?? []).filter((a) => !mine.has(a.id));
    if (!missing.length) continue;
    const head = document.createElement("div");
    head.className = "device";
    head.textContent = d.device;
    box.append(head);
    for (const a of missing) {
      const link = document.createElement("a");
      link.href = `https://addons.mozilla.org/firefox/addon/${encodeURIComponent(a.id)}/`;
      link.target = "_blank";
      link.textContent = `${a.name} - get it`;
      box.append(link);
    }
  }
  if (!box.children.length) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = others.length ? "You have them all." : "No other device has shared its add-ons yet.";
    box.append(note);
  }
}

$("sign-in").addEventListener("click", () => busy($("sign-in"), startSignIn));
$("sign-out").addEventListener("click", () => busy($("sign-out"), async () => {
  await signOut();
  accountHas = null;
}));
$("auto-sign-in").addEventListener("change", async (e) => {
  await set("autoSignIn", e.target.checked);
  if (e.target.checked) signInToWebsite().catch(() => {});
});
$("passphrase-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pass = $("passphrase").value;
  if (!accountHas && pass !== $("passphrase2").value) {
    notice("The two passphrases don't match.", true);
    return;
  }
  await busy(e.target.querySelector("button"), async () => {
    const { created } = await setPassphrase(pass);
    $("passphrase").value = $("passphrase2").value = "";
    notice(created ? "Sync is on. Use the same passphrase on your other devices." : "Sync is on. Your stuff is coming over now.");
  });
  render();
});
$("sync-now").addEventListener("click", () => busy($("sync-now"), syncNow));
$("forget").addEventListener("click", () => busy($("forget"), async () => {
  await forgetDevice();
  accountHas = null;
}));
$("reset").addEventListener("click", () => busy($("reset"), async () => {
  if (!confirm("Delete everything synced to your Jace account? Your devices keep their own copies but stop syncing until you set a new passphrase.")) return;
  await resetAccountData();
  accountHas = false;
  notice("Your synced data was deleted from Jace.");
}));

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "sign-in-failed") notice(msg.message, true);
  render();
});
render();
