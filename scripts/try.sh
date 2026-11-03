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

pkill -f "$DIR/firefox/firefox" 2>/dev/null || true
sleep 1
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

# Brand-new data every launch.
rm -rf "$DIR/profile"
mkdir -p "$DIR/profile"

echo "Checking (up to 90 seconds)..."
CHECK=$(mktemp -d)
JACE_SELF_TEST_OUT="$CHECK/report.txt" timeout 90 ./firefox/firefox --headless --no-remote --profile "$CHECK" -purgecaches >/dev/null 2>&1 || true
if [ -f "$CHECK/report.txt" ]; then
  grep -E "FAIL|startup error" "$CHECK/report.txt" || true
  tail -1 "$CHECK/report.txt"
else
  echo "NO SELF-TEST REPORT (Jace Browser's code didn't start)"
fi
rm -rf "$CHECK"

./firefox/firefox --no-remote --profile "$DIR/profile" -purgecaches >/dev/null 2>&1 &
echo "Started with a fresh profile."
