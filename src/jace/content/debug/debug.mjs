/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// about:jace-debug: what the browser window looks like inside, for fixing
// layout problems from a screenshot.

const { getCustomizableUI } = ChromeUtils.importESModule("chrome://jace/content/JaceCompat.sys.mjs");
const { getStartupLog } = ChromeUtils.importESModule("chrome://jace/content/JaceLoader.sys.mjs");

const win = () => Services.wm.getMostRecentWindow("navigator:browser");

function describe(n) {
  if (!n) return "—";
  const r = n.getBoundingClientRect?.();
  const st = n.ownerGlobal?.getComputedStyle?.(n);
  const id = n.id ? `#${n.id}` : "";
  const cls = typeof n.className === "string" && n.className ? `.${n.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
  const size = r ? ` ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : "";
  const vis = st ? ` ${st.display}${st.visibility !== "visible" ? " " + st.visibility : ""}${st.opacity !== "1" ? " op" + st.opacity : ""}` : "";
  const parent = n.parentNode ? ` in ${n.parentNode.id || n.parentNode.localName}` : " (not in page)";
  return `${n.localName}${id}${cls}${size}${vis}${parent}`;
}

function children(n) {
  return n ? [...n.children].map((c) => `  ${describe(c)}`).join("\n") : "—";
}

function section(title, text) {
  const h = document.createElement("h2");
  h.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = text;
  return [h, pre];
}

function render() {
  const w = win();
  const out = document.getElementById("out");
  if (!w) {
    out.textContent = "No browser window.";
    return;
  }
  const d = w.document;
  const root = d.documentElement;
  let cui = "";
  try {
    const CUI = getCustomizableUI();
    cui = [
      `downloads widget: ${JSON.stringify(CUI.getPlacementOfWidget("jace-tabs-downloads"))}`,
      `tab strip: ${CUI.getWidgetIdsInArea(CUI.AREA_TABSTRIP).join(", ")}`,
      `nav bar: ${CUI.getWidgetIdsInArea(CUI.AREA_NAVBAR).join(", ")}`,
    ].join("\n");
  } catch (e) {
    cui = `error: ${e}`;
  }
  const sideRoot = d.querySelector("sidebar-main")?.shadowRoot;
  const prefs = ["sidebar.verticalTabs", "sidebar.revamp", "jace.tabs.verticalStyle", "jace.tabs.downloadsButton", "sidebar.visibility"]
    .map((p) => {
      const type = Services.prefs.getPrefType(p);
      const v = type === Services.prefs.PREF_BOOL ? Services.prefs.getBoolPref(p) : type === Services.prefs.PREF_STRING ? Services.prefs.getStringPref(p) : type === Services.prefs.PREF_INT ? Services.prefs.getIntPref(p) : "(unset)";
      return `${p} = ${v}`;
    })
    .join("\n");
  out.replaceChildren(
    ...section("Jace", `${Services.prefs.getStringPref("jace.version", "?")} on Firefox ${Services.appinfo.version}; window attrs: vertical=${root.hasAttribute("jace-vertical-tabs")} style=${root.getAttribute("jace-tabs-style")} controls=${root.getAttribute("jace-window-controls")}`),
    ...section("Settings", prefs),
    ...section("Toolbars (Firefox's toolbar system)", cui),
    ...section("Downloads buttons", [
      `tab strip: ${describe(d.getElementById("jace-tabs-downloads"))}`,
      `backup:    ${describe(d.getElementById("jace-tabs-downloads-backup"))}`,
      `sidebar:   ${describe(sideRoot?.getElementById("jace-sidebar-downloads-tool"))}`,
    ].join("\n")),
    ...section("Tab bar (#TabsToolbar)", `${describe(d.getElementById("TabsToolbar"))}\n.toolbar-items:\n${children(d.querySelector("#TabsToolbar .toolbar-items"))}\ncustomization target:\n${children(d.getElementById("TabsToolbar-customization-target"))}`),
    ...section("Sidebar", `${describe(d.getElementById("sidebar-main") ?? d.querySelector("sidebar-main"))}\n#vertical-tabs:\n${children(d.getElementById("vertical-tabs"))}`),
    ...section("Startup log", getStartupLog().join("\n") || "(empty)"),
  );
}

render();
setInterval(render, 2000);
