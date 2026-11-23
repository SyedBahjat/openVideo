#!/bin/sh
# Builds the teleprompter's speech helper as a universal (Apple silicon + Intel) binary: native/bin/openvideo-speech
set -eu
cd "$(dirname "$0")"
# Machines with Xcode installed but its license not yet accepted can still build with the Command Line Tools.
if ! xcrun swiftc --version >/dev/null 2>&1 && [ -d /Library/Developer/CommandLineTools ]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi
mkdir -p bin
for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" -o "bin/openvideo-speech-$arch" speech-mac.swift
done
lipo -create -output bin/openvideo-speech bin/openvideo-speech-arm64 bin/openvideo-speech-x86_64
rm bin/openvideo-speech-arm64 bin/openvideo-speech-x86_64
echo "Built native/bin/openvideo-speech"
