/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The startup animation: when Jace Browser starts, the first window shows
 * the Jace logo drawing itself (the orbit ring spins in, the J is drawn,
 * a glow pulses), "Jace Browser" rises in, and then the whole thing zooms
 * past you to reveal the browser. About 1.6 seconds; the browser keeps
 * loading underneath, so it never makes startup slower. It never blocks
 * clicks and goes away early if you start typing.
 *
 * Turn it off with jace.startup.animation (about:jace -> Look). With
 * "reduce motion" on in the system settings it's a short fade instead.
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";

// The logo, drawn as separate parts so each can animate. Same shapes as
// branding/logo.svg.
export const ANIMATED_LOGO_SVG = `
<svg class="jace-logo" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="jace-logo-g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5ae69a"/>
      <stop offset="1" stop-color="#1f9d5a"/>
    </linearGradient>
  </defs>
  <rect class="jace-logo-tile" width="32" height="32" rx="9" fill="url(#jace-logo-g)"/>
  <g transform="rotate(-28 16 16)">
    <ellipse class="jace-logo-orbit" cx="16" cy="16" rx="12.2" ry="5.2" fill="none" stroke="#0c1410" stroke-opacity="0.28" stroke-width="1.3" pathLength="100"/>
  </g>
  <path class="jace-logo-j" d="M19.5 8.5v10.25a5 5 0 0 1-9.6 1.95" fill="none" stroke="#0c1410" stroke-width="3.4" stroke-linecap="round" pathLength="100"/>
  <circle class="jace-logo-spark" cx="27" cy="10.3" r="1.1" fill="#ffffff"/>
</svg>`;

let shownThisSession = false;

export const JaceSplash = {
  maybeShow(win) {
    if (shownThisSession || !Services.prefs.getBoolPref("jace.startup.animation", true)) {
      return;
    }
    shownThisSession = true;
    if (Services.env.get("JACE_SELF_TEST_OUT")) {
      return;
    }
    this.show(win);
  },

  show(win) {
    const doc = win.document;
    const splash = doc.createElementNS(HTML_NS, "div");
    splash.id = "jace-splash";
    const reduce = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      splash.setAttribute("reduced", "true");
    }
    // Parse the SVG with DOMParser so it isn't run through any HTML sanitizer.
    const svg = new win.DOMParser().parseFromString(ANIMATED_LOGO_SVG, "image/svg+xml").documentElement;
    const glow = doc.createElementNS(HTML_NS, "div");
    glow.className = "jace-splash-glow";
    const word = doc.createElementNS(HTML_NS, "div");
    word.className = "jace-splash-word";
    word.textContent = "Jace Browser";
    const stage = doc.createElementNS(HTML_NS, "div");
    stage.className = "jace-splash-stage";
    stage.append(glow, doc.importNode(svg, true), word);
    splash.append(stage);
    (doc.body ?? doc.documentElement).append(splash);

    let done = false;
    const remove = () => {
      if (done) return;
      done = true;
      splash.remove();
      win.removeEventListener("keydown", skip, true);
    };
    const skip = () => splash.setAttribute("leaving", "true");
    splash.addEventListener("animationend", (e) => {
      if (e.target === splash && e.animationName === "jace-splash-out") remove();
    });
    win.addEventListener("keydown", skip, true);
    // Never leave it up, even if an animation event goes missing.
    win.setTimeout(remove, reduce ? 1200 : 3000);
  },
};
