# Imou Camera for Scrypted

Scrypted plugin for Imou / Lechange cameras using the **Imou Open Platform** (AppId + AppSecret). It discovers cameras on your account and provides **cloud live preview** over RTSP (same `getStreamUrl` flow as Home Assistant).

Wired cameras with a stable LAN RTSP URL should use Scrypted’s **ONVIF** or **RTSP** plugins when possible. Use this plugin when the device is cloud-only or battery-powered and preview must go through the platform.

## Features (current release)

- Open Platform login: **Server region**, **App ID**, **App Secret**
- Device discovery and camera entities (`VideoCamera`)
- Cloud preview: short-lived **RTSP** URL, rebroadcast as **720p15** H.264 Baseline short GOP (**H.264 video only**; see below)
- **AAC audio** forwarded when the cloud stream includes audio (WebRTC may transcode to Opus)
- Signed URL **refresh** before expiry (works with Rebroadcast / Prebuffer when enabled)
- **Refresh Devices** and optional **Debug** log level in plugin settings

Not included yet: motion, doorbell, snapshot, PTZ, two-way talk, HomeKit Secure Video automation beyond what Scrypted mixins provide.

## Requirements

- A running [Scrypted](https://scrypted.app/) server (tested with 0.147.x)
- Imou Open Platform application with **AppId** and **AppSecret**
- Devices bound to the same Imou account as the application
- Outbound **HTTPS** from the Scrypted host to the regional Open API host
- **Rebroadcast** (Prebuffer mixin) is optional; for cloud cameras, **turning off Main Prebuffer** often improves stability and reduces API rate limits
- Cloud live preview must carry **H.264** video. The plugin exposes only an **H.264** main stream to Scrypted (WebRTC, HomeKit, NVR mixins). **H.265 / HEVC-only** cloud streams are **not supported** in this release. If a device offers multiple encodings in the Imou app, use **H.264** for the stream used for cloud preview, or use **ONVIF / LAN RTSP** for HEVC when the camera supports it locally.

## Install

### From npm (when published)

1. Scrypted UI → **Plugins** → **Install Plugin**
2. Search for `@imou/scrypted-imou-camera` and install
3. Open **Imou Camera** → enter region, AppId, AppSecret → **Refresh Devices**

### Develop / deploy from source

```bash
npm install
npm run build
npx scrypted login    # once per machine
npm run scrypted-deploy <host:port>
```

In VS Code/Cursor, set `.vscode/settings.json` to your server address and use **Run and Debug** (same as the [TypeScript sample](https://github.com/koush/scrypted-vscode-typescript)).

After deploy: **Plugins** → disable and re-enable **Imou Camera** if the server did not reload automatically.

## Configure

| Setting | Description |
|--------|-------------|
| Server region | Singapore, Europe, North America, or China (same regions as Imou in Home Assistant) |
| App ID / App Secret | From the Open Platform console for your application |
| Log Level | **Info** for normal use; **Debug** for live URL and stream troubleshooting (no secrets logged) |
| Refresh Devices | Re-runs discovery after credential or account changes |

Each camera appears as a Scrypted **Camera**. Open live view in the UI or route through **WebRTC** / **HomeKit** mixins as with other cameras.

### Video format

| | Supported |
|--|-----------|
| Video | **H.264** only (output and expected cloud RTSP video) |
| Audio | **AAC** when present in the cloud RTSP stream |
| Output | Up to **720p**, **15 fps**, Baseline profile (for stable rebroadcast / prebuffer) |

If preview fails with decode or ffmpeg errors on a newer 4K/HEVC model, confirm the device is not cloud-previewing **main stream H.265** only.

### Cloud preview tips

- **Prebuffer**: Scrypted recommends **disabling Main Prebuffer** for cloud cameras. Leaving it on keeps a background pull and may hit concurrent-preview limits (`OP1009`) after errors.
- **Audio**: If preview is unstable, try **No Audio** on the camera stream settings while testing.
- **One viewer**: Avoid many browser tabs and the Imou phone app live view on the same device at once.

## Package metadata

| Field | Value |
|-------|--------|
| npm name | `@imou/scrypted-imou-camera` |
| Scrypted name | Imou Camera |
| Type | `DeviceProvider` |

## License

MIT
