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

```text
npm ci
npm test
npm run smoke
npm run test:ui
```

Smoke/UI commands open native windows and are intended for isolated CI desktops.
