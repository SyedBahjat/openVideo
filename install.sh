#!/bin/bash
# openVideo installer for macOS.
#   curl -fsSL https://raw.githubusercontent.com/SyedBahjat/openVideo/main/install.sh | bash
#
# Downloads the latest release for your Mac (Apple silicon or Intel) and installs it in /Applications.
# Why a script: openVideo isn't notarized by Apple yet, and macOS blocks un-notarized apps that a
# browser downloaded. Files downloaded with curl aren't flagged, so the app opens normally.
set -euo pipefail

REPO="SyedBahjat/openVideo"
APP="/Applications/openVideo.app"
TMP="$(mktemp -d)"
MNT=""
cleanup() { [ -n "$MNT" ] && hdiutil detach -quiet "$MNT" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

if [ "$(uname)" != "Darwin" ]; then
  echo "This installer is for macOS. On Windows, download the .exe from https://github.com/$REPO/releases/latest" >&2
  exit 1
fi

assets="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | cut -d'"' -f4)"
if [ "$(uname -m)" = "arm64" ]; then
  url="$(echo "$assets" | grep -- '-arm64\.dmg$' | head -1)"
else
  url="$(echo "$assets" | grep -v -- '-arm64\.dmg$' | head -1)"
fi
if [ -z "$url" ]; then
  echo "Couldn't find a macOS download in the latest release: https://github.com/$REPO/releases/latest" >&2
  exit 1
fi

echo "Downloading $(basename "$url")..."
curl -fL --progress-bar -o "$TMP/openVideo.dmg" "$url"

MNT="$(hdiutil attach -nobrowse -readonly "$TMP/openVideo.dmg" | awk -F'\t' '/\/Volumes\//{print $NF}')"
osascript -e 'quit app "openVideo"' >/dev/null 2>&1 || true
rm -rf "$APP"
cp -R "$MNT/openVideo.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Installed $(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString) to /Applications. Opening openVideo..."
open "$APP"
