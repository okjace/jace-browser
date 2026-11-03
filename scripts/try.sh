#!/usr/bin/env bash
# Try the latest Jace Browser code on Linux, without building it.
#
#   bash ~/jace-test/jace-browser/scripts/try.sh
#
# Every run: gets the latest code, puts it into a separate copy of Firefox
# in ~/jace-test (your own Firefox isn't touched), starts with a brand-new
# profile (no old data), runs Jace Browser's self-test, and opens it.
set -e
DIR="$HOME/jace-test"

# Close any open test copy first (it would keep the setup from showing):
# ask nicely, wait up to 10 seconds, then force it.
pkill -f "$DIR/firefox/" 2>/dev/null || true
for _ in $(seq 20); do
  pgrep -f "$DIR/firefox/" >/dev/null || break
  sleep 0.5
done
if pgrep -f "$DIR/firefox/" >/dev/null; then
  echo "Closing the Jace Browser test copy that was still open..."
  pkill -9 -f "$DIR/firefox/" 2>/dev/null || true
  sleep 1
fi
mkdir -p "$DIR"
cd "$DIR"

if [ -d jace-browser/.git ]; then
  git -C jace-browser pull -q
else
  git clone -q --depth 1 https://github.com/okjace/jace-browser
fi
echo "Jace Browser code: $(git -C jace-browser log --oneline -1 | cut -c1-80)"

if [ ! -x firefox/firefox ]; then
  echo "Downloading Firefox (once)..."
  curl -sL "https://download.mozilla.org/?product=firefox-latest-ssl&os=linux64&lang=en-US" -o firefox.tar.xz
  tar -xf firefox.tar.xz
  rm firefox.tar.xz
fi
python3 jace-browser/scripts/dev-install.py "$DIR/firefox" >/dev/null

# Its own taskbar entry and icon: the window announces itself as
# "jace-browser-test" (not "firefox"), and this app entry gives that name the
# Jace icon. The entry opens the test copy (and links, if you make it your
# default browser) with your current test data; run this script again to
# update and start fresh. (The real build is named "jace" and ships its own entry.)
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
cat > "$APPS/jace-browser-test.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Jace Browser (test)
Comment=The latest Jace Browser code, with fresh data each launch
Exec=$DIR/firefox/firefox --name jace-browser-test --class jace-browser-test --profile $DIR/profile %u
Icon=$DIR/jace-browser/branding/png/logo-256.png
Terminal=false
Categories=Network;WebBrowser;
MimeType=text/html;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
StartupWMClass=jace-browser-test
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" >/dev/null 2>&1 || true
NAME_ARGS=(--name jace-browser-test --class jace-browser-test)

# Brand-new data every launch.
rm -rf "$DIR/profile"
mkdir -p "$DIR/profile"

echo "Checking (up to 90 seconds)..."
CHECK=$(mktemp -d)
JACE_SELF_TEST_OUT="$CHECK/report.txt" timeout 90 ./firefox/firefox --headless --no-remote --profile "$CHECK" -purgecaches >/dev/null 2>&1 || true
if [ -f "$CHECK/report.txt" ]; then
  grep -E "FAIL|startup error|close button|search engines|sidebar's edge" "$CHECK/report.txt" || true
  tail -1 "$CHECK/report.txt"
else
  echo "NO SELF-TEST REPORT (Jace Browser's code didn't start)"
fi
rm -rf "$CHECK"

./firefox/firefox "${NAME_ARGS[@]}" --no-remote --profile "$DIR/profile" -purgecaches >/dev/null 2>&1 &
echo "Started with a fresh profile."

# What happened while it started (written by Jace Browser into the profile).
sleep 8
echo "--- startup log:"
cat "$DIR/profile/jace-startup.log" 2>/dev/null || echo "(no startup log: Jace Browser's code didn't start in this window)"
