import { profile, startSignIn } from "../lib/account.js";
import { hasKey, remoteTabs, status, syncNow } from "../lib/sync.js";

const $ = (id) => document.getElementById(id);

function ago(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

async function render() {
  const p = await profile();
  $("signed-out").hidden = !!p;
  $("signed-in").hidden = !p;
  if (!p) return;
  $("name").textContent = p.name;
  $("handle").textContent = `@${p.username}`;
  if (p.picture && /^https:/.test(p.picture)) $("avatar").src = p.picture;
  const s = await status();
  const keyed = await hasKey();
  $("status").textContent = !keyed
    ? "Sync needs your sync passphrase."
    : s.state === "syncing"
      ? "Syncing…"
      : s.state === "error"
        ? `Sync problem: ${s.error}`
        : `Synced ${ago(s.lastSync)}`;
  $("action").textContent = keyed ? "Sync now" : "Set up sync";
  $("action").onclick = async () => {
    if (!keyed) {
      browser.runtime.openOptionsPage();
      window.close();
      return;
    }
    $("action").disabled = true;
    await syncNow().catch(() => {});
    $("action").disabled = false;
    render();
  };
  const box = $("tabs");
  box.replaceChildren();
  for (const d of (await remoteTabs()).slice(0, 3)) {
    if (!d.tabs?.length) continue;
    const head = document.createElement("div");
    head.className = "device";
    head.textContent = d.device;
    box.append(head);
    for (const t of d.tabs.slice(0, 6)) {
      const a = document.createElement("a");
      a.href = t.url;
      a.textContent = t.title || t.url;
      a.title = t.url;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        browser.tabs.create({ url: t.url });
        window.close();
      });
      box.append(a);
    }
  }
}

$("sign-in").addEventListener("click", async () => {
  await startSignIn();
  window.close();
});
$("settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});
browser.runtime.onMessage.addListener(() => render());
render();
