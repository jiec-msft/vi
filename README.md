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

Run test/build/lint/type checks, dependency installation, GUI checks and media
conversion only in GitHub Actions. Local work is limited to source reads/edits,
Git and GitHub administration. Smoke/UI commands open native windows.

The nine platform check names and whole-job budgets also apply to
`merge_group: checks_requested`. Different queue heads have separate concurrency
groups; only superseded PR runs are cancelled. Native GitHub merge queue is not
available for this personal-account repository. Organization ownership and
authorized repository/settings changes are prerequisites; manual serial
integration is not a native merge queue.

## PR visual evidence

Every relevant PR needs actual CI media in its body, not just an expiring Actions
artifact link. Successful PR checks create `pr-evidence-preview`: six GIF previews,
full desktop WebM recordings, screenshots and a sanitized timing report for both
UI suites on all three platforms. Media conversion runs in an additional
read-only Windows job (3-minute budget), after the nine checks; it is not included
in their timings or presented as an end-to-end speedup.

After reviewing the PR's public fake/synthetic inputs and recordings, a maintainer
dispatches **PR evidence** from the default branch:

```text
gh workflow run evidence.yml --repo jiec-msft/vi --ref main -f pr_number=NUMBER -f run_id=RUN_ID
```

The source must be a successful `Platform checks` PR run for the exact current
head/repository/branch, with all nine jobs within their budgets and both suites'
nonempty media present. Missing/expired artifacts, stale heads, exceeded budgets
or missing permissions are explicit blockers. Re-run checks after a new push;
old evidence is labeled with its exact head and does not validate the new head.
The run must have exactly one authoritative REST `pull_requests` association
matching the PR number/id/API URL, base/head repository ids/API URLs, base/head
refs and head SHA. Missing/empty/ambiguous associations, including unverifiable
fork associations, are blocked; matching head alone never substitutes for this
association. Verifiable fork associations are supported. Current base SHA
freshness remains the responsibility of strict integration checks.

The trusted workflow checks out default-branch publisher code, validates and
converts allowlisted media without write permissions, then uploads only processed
GIF/video/screenshot/report assets in a separate write-enabled job. It never
checks out or executes PR code with a write token, including fork PRs. Releases
named `evidence-pr-...` are public evidence-only prereleases, not application
downloads. The body update replaces only `<!-- vi-evidence:start -->` through
`<!-- vi-evidence:end -->`, preserving the rest of the description and closing
links. Unpaired/duplicate markers fail instead of guessing.
After uploads, the publisher revalidates the run id, attempt and all job timings
against the prepared manifest, then reads the PR again immediately before the
body update. This preserves edits already visible outside the evidence marker
and rejects a changed/closed PR. The final GET-to-PATCH window is not an atomic
compare-and-swap: concurrent edits, retargeting, head changes or reruns in that
window cannot be fully prevented. A post-write mismatch reports failure but
cannot undo a body update that already occurred.

Bootstrap: a new dispatch workflow must first land on the default branch.
Before that, maintainers can download this PR's read-only CI-generated
`pr-evidence-preview`, verify its report's run/head and the actual recordings,
upload only those assets with `gh release create/upload` to an evidence-only
prerelease, and update the same controlled body block with `gh pr edit`.
Do not run downloaded code or convert media locally. Verify the GIF actually
renders on the public PR and every full-video link works; publication is not
complete merely because an upload was requested. Automatic trusted dispatch
requires default-branch registration and `contents: write` / `pull-requests: write`.

If storage is exhausted, remove only obsolete evidence release assets while
keeping their releases/descriptions, then unneeded Actions artifacts. Retain
current evidence and necessary diagnostic assets; report any unresolved quota
or permission blocker.

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

### Windows caret indicator (experimental)

Settings includes an explicit, off-by-default **Windows caret indicator**.
During shortcut recording/finalization it adds a blue caret-side line and a
small rounded microphone badge. These are separate, owned, nonactivating,
pointer-transparent native windows; the application never changes the editor's
caret or adds a dictation control. The existing floating controls are unchanged.
Preview recordings and other platforms do not start the helper.

The initial native adapter supports only per-monitor-DPI-aware Windows `Edit`
controls with a verified collapsed selection, matching foreground HWND/PID/focus,
UIA password/read-only/focus checks, and the same medium integrity/session.
UIA-only editors, selected text, elevated/unknown/secure fields, inaccessible
Default input desktops and unverified geometry remain hidden. It does not read
target text or window titles. UIA runs on one bounded background worker in an
isolated helper; a native message-pump timer expires geometry after 250 ms.
Late completions cannot revive an invalidated turn.

Opt-in recordings use a stricter field lease: loss of focus, an unavailable
caret or expired query hides the indicator and suppresses automatic paste for
that turn, even if focus later returns. The final transcript remains available
for Copy. Cancellation/completion/quit destroy the helper and its marker windows.
This deliberate opt-in behavior does not alter delivery when the setting is off.

`Windows caret integration` is a separate, standard Windows x64 hosted check
with a 10-minute whole-job limit and an internal 180-second GUI watchdog. Its
synthetic native editor exercises the actual application, not the presentation
prototype. The hosted launcher uses only the runner's own existing filtered
medium token, checks its user/session and exact suspended root binary, attaches
an owned kill-on-close Job before resuming, and preserves nonzero exits and
cleanup receipts. It neither enables privileges nor weakens product integrity
checks. The additional quiet-exit fixture must fail with its exact raw code.
Current-head GIF/PNG and native receipts are required before claiming
CI qualification. CI does not establish real-device, UIA-only editor, secure
desktop, mixed-monitor or application-package acceptance.

The framework recording must contain a test-only visual marker in every test
frame. Windows CI suppresses first-login onboarding only inside the hosted VM,
so a system setup screen cannot conceal successful renderer-only operations.

Full applications load `plugin.json`, `config.json` and the declared entry module
from `<userData>/providers/default`, or an explicit `--provider-dir` directory.
The manifest declares `id`, `kind: "service-provider"`, `apiVersion: 1` and a
relative `entry`. Its module exports `createSession(options)`. Each recording
gets a session with:

| Member | Contract |
| --- | --- |
| `start()` | Resolve when audio can be sent; reject connection failures. |
| `audio(buffer)` | Consume 16 kHz, mono PCM16 chunks in order. |
| `finishTurn()` | Resolve a segment's final string while keeping the connection reusable. |
| `finish()` | Resolve the last final string and finish the recording. |
| `stopRecordingDeadline()` | Stop the provider's recording deadline during finalization. |
| `cancel()`, `close()` | Release owned connections and discard cancelled work. |
| `on('partial', listener)`, `on('failure', listener)` | Publish preview strings and safe errors. |

`config.json` contains provider-owned options; a saved endpoint override replaces
only its endpoint. Credentials and transport implementation belong to the
provider, not the application.
