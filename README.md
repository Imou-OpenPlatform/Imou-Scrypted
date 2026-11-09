# Imou Camera Plugin for Scrypted

Official-oriented Imou cloud camera plugin. Phase 1 goal: AppId login, device discovery, and cloud live preview in Scrypted.

Wired cameras with ONVIF should prefer Scrypted's ONVIF plugin. This plugin targets cloud / battery devices without a usable LAN stream.

## Status

Phase 1 (in progress): DeviceProvider skeleton based on the Scrypted camera provider sample. Cloud preview and Open Platform auth are not wired yet.

Out of scope for phase 1: motion, doorbell, snapshot, PTZ, HomeKit / HKSV.

## Develop

1. `npm install`
2. Open this directory in VS Code.
3. Edit `.vscode/settings.json` to point at your Scrypted server IP (default `127.0.0.1`).
4. Run `npx scrypted login` once if prompted, then Launch (Run and Debug) to deploy.

## Package

- npm: `@imou/scrypted-imou-camera`
- Scrypted display name: `Imou Camera`
- Type: `DeviceProvider`
