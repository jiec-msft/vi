# VI

Voice Input.

MIT-licensed application and provider-interface experiments. CI uses a local
fixture service and synthetic audio; no account or external speech service is
needed. No application download packages are published here.

## Checks

| Check | Entire-job limit |
| --- | --- |
| Unit | 3 minutes |
| Startup smoke | 3 minutes |
| UI | 10 minutes |

Native Windows x64, Windows ARM64 and macOS ARM64 jobs run independently.
UI evidence includes a desktop video and a machine-readable report.
Checks deliberately fail when required native UI/audio/video operations fail.

The initial capability probe covers app startup, loopback protocol traffic,
synthetic microphone PCM, OS clipboard delivery to an owned editor, resource
release, nonactivating window placement and recording. It does not yet prove
cross-application accessibility, physical dragging, hardware hotplug or system
permissions outside the test environment.
macOS clipboard delivery uses the native editor Paste command, not a claim of
physical Cmd+V injection. The isolated macOS synthetic-input probe disables only
the audio-service sandbox to read its WAV fixture; renderer sandboxing remains on.

```text
npm ci
npm test
npm run smoke
npm run test:ui
```

Smoke/UI commands open native windows and are intended for isolated CI desktops.

## Service provider boundary

Service providers are loaded through a versioned `service-provider` manifest.
The host requires `open`, `audio`, `finish`, `close` and event subscriptions.
CI downloads a checksum-pinned public provider artifact and supplies only a
loopback endpoint and a synthetic credential source. It exercises the client's
actual protocol implementation without a live external service or account.

Providers are trusted local code, not a security sandbox. Other providers can
implement the same interface. Artifact availability is independent of app
source and no application installer is produced by this CI.

## Application framework

`npm start` opens the generic application: microphone preferences, configurable
shortcuts, Toggle/Push-to-talk, floating status, text plugins and final-only
delivery. Real transcription requires a compatible installed provider; the
framework does not select a live service by itself.

Provider defaults belong to the installed plugin's `config.json`. The application
only displays a user-supplied endpoint override, stored locally. Changing it
requires confirming trust because the provider may send credentials and speech.

Startup CI also launches this full framework independently, without choosing a
service, and verifies readiness and clean shutdown. UI CI additionally exercises
its real renderer and main process: consent, local microphone meter without
network traffic, recording/finalization, cancel, clipboard copying, preference
persistence, text-plugin processing and original comparison. Both UI suites
record the desktop. The framework suite uses synthetic microphone permission;
TCC/hardware permissions, physical shortcut/PTT dispatch, dragging and
cross-application accessibility remain separate acceptance gates.
