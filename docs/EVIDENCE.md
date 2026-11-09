# How Loom Desktop records: evidence

Analysis of the public Loom Desktop build **0.384.0** (released 2026-11-05), downloaded from Loom's own update feed (`packages.loom.com/desktop-packages/latest-mac.yml` and `latest.yml`). Only file listings, linked-framework tables, binary string tables, and identifiers are reported here. No Loom code is copied into this repository.

Reproduce:

```sh
curl -sLO https://packages.loom.com/desktop-packages/latest-mac.yml      # electron-updater manifest
curl -sLO "https://packages.loom.com/desktop-packages/Loom-<ver>-arm64-mac.zip"
ditto -x -k Loom-*.zip app && R=app/Loom.app/Contents
plutil -p $R/Info.plist | grep Usage                                        # permissions
otool -L $R/Resources/binaries/loom-recorder-production                     # capture/encode frameworks
strings  $R/Resources/binaries/loom-recorder-production | grep -- '^--'     # recorder CLI flags
npx @electron/asar extract $R/Resources/app.asar asar                       # JS + renderer windows
```

## 1. Shell: Electron

| Evidence | Meaning |
|---|---|
| `latest-mac.yml` / `latest.yml` update manifests, `Squirrel.framework`, `Loom Helper (GPU/Renderer/Plugin).app` | Electron app, packaged with electron-builder, auto-updated with electron-updater |
| `app.asar` → `@loomhq-desktop/entrypoint/package.json`: `"electron": "^43.8.3"` | Electron 43 |
| `Info.plist` `CFBundleIdentifier = com.loom.desktop`, `LSMinimumSystemVersion = 12.0` | macOS 12+ |

## 2. Every floating UI piece is its own transparent window

`dist/renderer/` contains one HTML page per window, including `camera.html`, `control_menu.html`, `countdown.html`, `drawing.html`, `cropping.html`, `mouse_highlight_overlay.html`, `window_selection_overlay.html`, `background_dimmer.html`, `confetti.html`, `pre_recording_panel.html`, `speaker_notes.html`, `recorder.html`.

The main bundle builds the camera window as a frameless, `transparent`, shadowless, non-resizable, `skipTaskbar` window kept on top at the `pop-up-menu` level. Click-through overlays use `setIgnoreMouseEvents(true)` and the `screen-saver` level. On Windows, the "hide recording controls" preference calls `setContentProtection()` on the control menu so it stays out of the final video.

**Takeaway:** the camera bubble is a real on-screen window. The screen capture records it the way it records anything else on screen, which is why it shows up in the video. The controls are hidden from the capture with OS content protection.

## 3. Capture and encoding run in a separate native process

`Resources/binaries/loom-recorder-production` (and `loom-recorder-production.exe` on Windows, per the path resolver in `main/index.js`) is a Swift/C++ daemon that the Electron main process spawns.

| Evidence (from `otool -L` / `strings`) | Meaning |
|---|---|
| Links `ScreenCaptureKit.framework`; symbols `SCStream`, `SCShareableContent`, `SCStreamConfiguration`, flag `--force-sck` | macOS screen capture uses ScreenCaptureKit |
| Links `VideoToolbox.framework`; `VTCompressionSession`, queue `com.loom.h264encoder.encodequeue`, flag `--hw-encoder-enabled` | Hardware H.264 encoding |
| Source paths `native/media/muxer/hls_muxer.cpp`, `hls_muxer_av_split.cpp`; JS scans folders for `.ts` + `.m3u8` | Output is **HLS segments**, written incrementally |
| Flags `--display-id`, `--region`, `--resolution`, `--system-audio-enabled`, `--audio-device-name`, `--camera-only`, `--output-path`, `--endpoint` | One daemon handles screen, region, camera, mic, and system audio |
| `--shm-name`, `--shm-width/height` + addon `@loomhq-desktop/shared-memory-sender` | Camera frames move from the Electron renderer to the recorder through **shared memory** |
| JS passes `"--endpoint", this.ipcServer.getEndpointPath()` | The main process controls the daemon over a local IPC socket |

## 4. Uploading during recording (the "instant link")

`main/index.js` contains about 109 references to S3 multipart upload (`createMultipartUpload` / `UploadPart`). It uploads parts as they are produced and picks content types per part (`.m3u8` playlist vs. segment). It also has a `headBucket` connection check and `aws-crt` native bindings. Because segments upload while you are still recording, the share link works almost as soon as you hit stop.

## 5. System audio, permissions, and other native helpers

| Evidence | Meaning |
|---|---|
| `Resources/libs/LoomAudioDevice.driver` + `install_audio_device.sh`; addon `internal-audio` | A virtual CoreAudio device (HAL plugin) for capturing system audio on macOS |
| `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, `NSAppleEventsUsageDescription` | Camera, mic, and system-audio prompts; Apple Events to bring the chosen window to the front |
| `node-mac-permissions`, `has-mac-mic-perms` | Pre-flight permission checks |
| `mouse-hook`, `osx-mouse` | Click highlights (`mouse_highlight_overlay.html`) |
| `change-active-window`, `set-window-flags`, `camera-bubble-click-thru-workaround` | Window focus and level tweaks native Electron lacks |
| `meeting-detector` (+ `libMeetingDetector.dylib`) | Detects Zoom/Meet calls for the meeting-recording feature |
| `loom_crashpad_handler`, Sentry flags on the recorder | Crash reporting |

## How openVideo maps to this

| Loom | openVideo v0.1 |
|---|---|
| Electron shell, one window per UI piece | Same: `panel`, `camera`, `controls`, `countdown` windows |
| Camera bubble as a captured, transparent, always-on-top window | Same approach |
| Controls hidden with content protection | Same, applied on macOS and Windows |
| Native ScreenCaptureKit/VideoToolbox daemon | Chromium's own capture stack via `getDisplayMedia` + `MediaRecorder`, which uses ScreenCaptureKit / Windows Graphics Capture and hardware H.264 underneath. No native code to ship |
| HLS segments written incrementally | 1-second fragmented-MP4 chunks appended to disk; a crash loses at most about 1 s |
| S3 multipart upload during recording | Not included. Recordings stay local by design |
| Virtual audio driver for system audio | Chromium loopback: official on Windows, feature-flagged ScreenCaptureKit audio on macOS 13+ |
