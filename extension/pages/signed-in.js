import "../lib/compat.js";

const hash = decodeURIComponent(location.hash.slice(1));
if (hash.startsWith("failed")) {
  document.getElementById("title").textContent = "Couldn't sign in";
  document.getElementById("text").textContent = hash.slice("failed:".length) || "Signing in to Jace didn't work. Try again.";
}
document.getElementById("settings").addEventListener("click", () => browser.runtime.openOptionsPage());
