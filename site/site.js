// Fill the download buttons from the newest Jace Browser release and
// highlight the visitor's platform. Without JavaScript the buttons still link
// to the releases page.
const REPO = "okjace/jace-browser";

const PLATFORMS = [
  { id: "windows", suffix: "-windows-x64-setup.exe", label: "Windows", note: "10 / 11" },
  { id: "mac-arm", suffix: "-macos-arm64.dmg", label: "macOS", note: "Apple Silicon" },
  { id: "mac-intel", suffix: "-macos-x86_64.dmg", label: "macOS", note: "Intel" },
  { id: "linux", suffix: "-x86_64.AppImage", label: "Linux", note: "AppImage" },
];
const EXTRAS = [
  { suffix: "-windows-x64-portable.zip", label: "Windows portable (.zip)" },
  { suffix: "-linux-x86_64.tar.xz", label: "Linux (.tar.xz)" },
];

function guessPlatform() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac-arm"; // most Macs sold since 2020
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return null;
}

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

async function releases() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function fill() {
  const box = document.getElementById("downloads");
  const note = document.getElementById("release-note");
  const more = document.getElementById("more-downloads");
  const ext = document.getElementById("extension-links");
  let list;
  try {
    list = await releases();
  } catch {
    if (note) note.innerHTML = `Couldn't load the latest version. <a href="https://github.com/${REPO}/releases">Download from GitHub</a>.`;
    return;
  }
  // The browser's releases are tagged v1.2.3; the extension's extension-v1.2.3.
  const browser = list.find((r) => /^v\d/.test(r.tag_name) && !r.prerelease && !r.draft);
  if (browser && box) {
    const mine = guessPlatform();
    box.replaceChildren();
    for (const p of PLATFORMS) {
      const asset = browser.assets.find((a) => a.name.endsWith(p.suffix));
      if (!asset) continue;
      const a = document.createElement("a");
      a.className = "btn" + (p.id === mine ? " primary mine" : "");
      a.href = asset.browser_download_url;
      a.innerHTML = `⬇ ${p.label} <small>${p.note} · ${mb(asset.size)}</small>`;
      if (p.id === mine) box.prepend(a);
      else box.append(a);
    }
    const extras = EXTRAS.map((e) => [e, browser.assets.find((a) => a.name.endsWith(e.suffix))]).filter(([, a]) => a);
    if (more && extras.length) {
      more.innerHTML = "Also: " + extras.map(([e, a]) => `<a href="${a.browser_download_url}">${e.label}</a>`).join(" · ");
    }
    if (note) note.innerHTML = `Version ${browser.tag_name.replace(/^v/, "")} · <a href="${browser.html_url}">release notes</a> · free and open source`;
  }
  const extension = list.find((r) => r.tag_name.startsWith("extension-v") && !r.prerelease && !r.draft);
  if (extension && ext) {
    const xpi = extension.assets.find((a) => a.name.endsWith(".xpi"));
    const zip = extension.assets.find((a) => a.name.includes("chrome") && a.name.endsWith(".zip"));
    ext.replaceChildren();
    for (const [asset, label, primary] of [[xpi, "For Firefox", true], [zip, "For Chrome", false]]) {
      if (!asset) continue;
      const a = document.createElement("a");
      a.className = "btn" + (primary ? " primary" : "");
      a.href = asset.browser_download_url;
      a.style.marginRight = "8px";
      a.innerHTML = `⬇ ${label} <small>${extension.tag_name.replace("extension-v", "v")}</small>`;
      ext.append(a);
    }
  }
}

fill();
