# VI

Voice Input.

MIT-licensed application and provider-interface experiments. CI uses a local
fixture service and synthetic audio; no account or external speech service is
needed. Regular checks do not publish application download packages. The explicit
manual neutral-base workflow described below uploads endpointless CI build
artifacts only; it does not create releases or choose an external speech service.

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

Manifest、配置、依赖加载和 factory 创建失败显示为 **Provider setup error**，
不再误报 **Connection error**。详细消息保留原始错误与 cause。
异步 transport 失败仍显示连接错误；setup 失败不会切换 fallback provider。

## Application framework

`npm start` opens the generic application: microphone preferences, configurable
shortcuts, Toggle/Push-to-talk, floating status, text plugins and final-only
delivery. Real transcription requires a compatible installed provider; the
framework does not select a live service by itself.

Provider defaults belong to the installed plugin's `config.json`. The application
only displays a user-supplied endpoint override, stored locally. Changing it
requires confirming trust because the provider may send credentials and speech.

### Data-only distribution defaults

发行版可在 Windows `VI.exe` 同目录、macOS `VI.app` 外的同目录放
`VI.provider.json`。文件仅支持
`{"schemaVersion":1,"endpoint":"wss://service.example.invalid/speech"}`，
最多 4096 bytes，必须是非 symlink 的 regular file；不能包含代码、
plugin 路径、credential 或其它选项。远程 endpoint 仅支持不带
username/password/query/fragment 的 `wss:`，synthetic loopback 可用 `ws:`。
这只是显式信任的服务地址数据，不会改写 provider、app bundle 或 userData。

优先级为 bundled provider `config.json` → sibling data → 已有 user endpoint
override。`--provider-config=<absolute JSON path>` 显式选择数据文件；
文件缺失或非法会报 setup error。既有 `--provider-dir` 仍选择整个 trusted
executable plugin root，并默认不读取 sibling data；显式 `--provider-config`
仍可与它组合。已有 user override 最后生效，但不能掩盖非法 external file。
中性包没有配置 endpoint；没有 data 或 user override 时会明确报未配置，
不会回退到任何服务。

### Manual neutral native bases

`Neutral native distribution bases` 是原“不生成下载包”规则的明确、手动
CI artifact 例外。它只在 `workflow_dispatch` 执行，使用标准
Windows x64、Windows ARM64、macOS ARM64 runner，同一次输入版本生成
三个 neutral bases；默认应用版本为 `0.6.4-preview`。没有自动 release、
production endpoint、账户、外部语音请求或额外 repository checkout。
源码、测试、安装和 native build 仍只在 GitHub Actions 执行。

公开 provider 来源仍是 checksum-pinned `v0.1.1` TGZ，不宣称另有 provider
源码 release。打包记录原始 TGZ hash 与源文件 inventory，仅补充来自本仓库
lock 的 `ws` production closure/lock、保留许可证，写入空配置。
不会重命名成另一个 provider 版本。receipt 明确区分 upstream source
与 distribution metadata，不把重新组装冒充新的 provider 实现。
provider channel 本身目前没有独立 LICENSE 文件；receipt 保留 artifact
已有 license declaration（未声明则显式为 `null`）与全部原始 notice。
framework 的 MIT 不自动成为 provider 的新许可，发布审核须单独确认。
因此 manual workflow 的 `upload_bases` 默认 `false`，只上传 receipts；
owner 明确完成 upstream provider redistribution 审核后才选择上传 base
内容。这个开关不是新增许可或自动授权。

分发入口为 `resources/app/package.json` 的 `app/main.cjs`；当前中性包使用
普通 app directory，不声称存在 ASAR。Windows 先设置真实 PE version，
再用 inbox seekable .NET ZIP writer 写规范相对文件名，实际
`Expand-Archive` 后比较所有文件。macOS 先完成 Info.plist、public code、
provider 和 helper，再 inside-out ad-hoc signing、strict verification；
使用原生 `ditto` 保留 symlink/mode，解包后再次验证 seal 和完整 inventory。
后续服务地址 JSON 只能放 bundle 外，不能修改 sealed macOS bundle，
也不能将 macOS archive 用 Windows ZIP 工具重新打包。

Electron 45 的 npm package 可以在首次调用公开 `require('electron')` loader
时才准备 runtime。producer 必须先调用该 loader，再按返回的实际 executable
确认 Windows runtime directory 或 `Electron.app`，不能将 `npm ci` 成功或
固定的 `node_modules/electron/dist` 路径当成 binary 已存在的证据。
receipt 同时记录输入 Electron executable hash 与最终输出 hash；
不接受 dist override、另一份 runtime 或缺失 binary 的 fallback。

Windows producer 固定使用标准 native runner 的 PowerShell 7
`ProgramFiles/PowerShell/7/pwsh.exe`，没有 legacy PowerShell fallback。
版本编辑、读取、archive 和 extraction 共用同一 native Core engine、
隔离的 inbox module path 和 `-File` 参数边界，不修改 runner 全局环境，
也不传给应用进程。应用的 desktop helper 不因此更换 engine。
preflight 验证实际 engine 架构、Core edition，以及 cmdlet/function 的
实现文件：Security binary assembly 正常位于 engine 根目录，
Archive function 则来自该 engine 的 inbox `.psm1`。不能假设所有
`ModuleBase` 都在 `Modules` 子目录，也不能仅凭一个字符串目录前缀放行。
原始 toolchain JSON 在断言前保存，receipt 记录通过验证的来源。
签名拒绝、numeric version、完整解包和逐文件 hash gate 均保持不变。
legacy engine 的空输出超时本身不能定位在 startup、import 或其它阶段；
不能据此归责机器或推断生产 app 行为。
相关启动规则见
<https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath>。

每个平台都用实际 packaged Electron 的 Node mode 加载完整 provider、
两种 factory 和共享 config loader，通过公开 fixture 的 loopback transport
发送 synthetic PCM。测试不使用真实麦克风、credential lookup 或外部服务；
进程 cwd/profile 独立，module/preload/credential environment 不继承，
模块来源逐文件与 bundle 内 provider inventory 比较。fresh native archive
解包后重复该检查，保存 archive SHA256、source revision、架构、helper/
payload 文件 hash、原始来源与 cleanup receipt。此 headless gate 不证明
GUI、TCC、硬件麦克风、notarization 或下游组合后的全部 native 行为。
Windows PowerShell helper 与 macOS compiled helper 的 bytes/架构被记录，
但此 manual headless gate 不启动 desktop helper；receipt 明确标为未执行。
三个同版本 native bases、各自 receipts 与下游配置/下载校验未齐全前，
不能称为完整三平台 release。

Startup CI also launches this full framework independently, without choosing a
service, and verifies readiness and clean shutdown. UI CI additionally exercises
its real renderer and main process: consent, local microphone meter without
network traffic, recording/finalization, cancel, clipboard copying, preference
persistence, text-plugin processing and original comparison. Both UI suites
record the desktop. The framework suite uses synthetic microphone permission;
TCC/hardware permissions, physical shortcut/PTT dispatch, dragging and
cross-application accessibility remain separate acceptance gates.

Diagnostics are enabled by default in `<userData>/logs`: on Windows,
`%APPDATA%\VI\logs`; on macOS, `~/Library/Application Support/VI/logs`.
After an incident, quit VI if it responds and compress **the entire logs folder**
into one ZIP. Include the approximate incident time; no extra tool or repeated
test is required. Do not include the surrounding profile, provider or cache files.

`events.jsonl` and its three backups retain launch UUID/PID/sequence, stable or
preview version, available assembly/framework revisions, runtime/OS architecture,
monotonic spans, renderer/process faults, native request categories and recovery
state. Missing build metadata is explicitly `unavailable`. Main-process timings
use `main-performance`; Windows native files use their own `helper-stopwatch`
clock. Wall UTC timestamps correlate clocks but are not used as span durations.
No transcript, audio, endpoint, credential, raw error/stack, user path or private
window title is logged.

The main log has a bounded off-main writer (512 KiB per file, four files). Critical
markers are sent before synchronous operations, with at most a 25 ms acknowledgement
wait; queued ordinary records are batched. Pending memory is limited to 128 records
/ 32 KiB and exit flushing to 200 ms. Drops and write failures are explicit.
内容型 unit fixtures 先等待真实 writer 的持久化 sequence acknowledgement，
再调用原有 200 ms flush；不会清空错误或延长生产 deadline。专门的 stalled/
blocked/rotation/filesystem 测试仍独立验证原来的边界。native host-gap 内容测试
仅控制 fixture 的 pulse/sample bookkeeping，走真实 sampler 和 writer，
保留 5 秒生产阈值、重复通知断言与原 child deadline；它不把 PowerShell
cold-start 加上固定 sleep 的总时长冒充 sampler 性能或真实 OS 停顿验收。
An OS/filesystem stall can still prevent a marker from reaching disk; logging
cannot guarantee evidence through a power loss or a system-wide freeze.
`window-shown` is the completed native-order receipt, not the first rendered pixel.
Separate visible/show/focus/order events identify that distinction.

On Windows, the existing pointer helper also records bounded native sidecars
(128 KiB per file, three files per role), process birth/generation, safe Win32
codes and desktop/session classes. Its sampler/API thread only captures and
enqueues bounded metadata; a helper-local background writer handles sidecar and
stderr I/O. A slow or failed native log sink does not block READY/heartbeat/API
work or disable the independent main log. A missing main-process pulse for five seconds
is recorded independently once, then at most every 30 seconds; recovery is
recorded separately. This observer exists only after the pointer helper starts
and can itself be delayed by an OS stall. Main event-loop delay is a threshold
summary observable only after the loop resumes. Neither is an OS watchdog.
SmartScreen and other pre-process security gates are outside app observation.
On Windows, unavailable cursor access suspends native floating controls and
cancels the current gesture. A live suspended helper reports liveness while
waiting for desktop access to return; it does not consume the helper restart
budget. A silent or failed helper still follows the bounded recovery path, and
reconnection requires a fresh mouse press rather than replaying a held gesture.

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
