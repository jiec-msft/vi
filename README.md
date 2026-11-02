# VI

Voice Input.

## 0.6.4 Windows floating controls and clipboard delivery

Windows 浮窗改用 compact opaque native surface，仍然不激活、不抢焦点，
不关闭 GPU 或 sandbox。display/work-area 变化会按当前真实 work area
重新 clamp 224×54 DIP 边界；renderer 退出仅允许一次有界 reload，不重启
录音。主动 Hide 是独立用户意图，display/status 更新不能撤销；可从
settings 的 Show floating controls 或 tray 菜单显式恢复。
诊断只记录 owned overlay 的 show/hide、bounds、display、renderer 状态，
不记录其它窗口标题、全局光标或内容。Native `IsVisible`/topmost/bounds
不是实际像素证据；opaque surface 和这些 recovery path 的改变，也不等于
已证明某次历史窗口消失的唯一 compositor 原因。
Stop/Cancel 以 DOM pointerup/click 为唯一 action stream，不再把 polling
observer 的 ready 当作“必然会收到每次 press”。同一 pointerup 的后续 click
只消费该 DOM gesture，下一次 pointerdown 开新 gesture，无时间窗去重；
只有 mouse-down 被非激活窗口吞掉时，已 hover 的 pointerup 仍可完成首击。
native polling 仅保留 drag fallback，不再与 DOM 各自派发 Stop/Cancel。
真实物理首击与完整 quick press 仍须 native CI 证明，不能靠伪造 nativeDown。

Windows paste 在同一个 clipboard lock 内枚举并建立原生 backup，不再依赖
managed OLE 数据投影/反序列化。已知 bitmap/metafile/palette 按原生类型
clone；Unicode、rich formats、streams、registered HGLOBAL metadata 保留
原始 backed bytes。空 clipboard（没有格式）和零值 metadata 都有 roundtrip；
不能把 `GlobalAlloc(GMEM_MOVEABLE, 0)` 产生的 discarded handle 当作可复制的
空 buffer。discarded/零容量 HGLOBAL 或无法 render 的格式在修改前明确拒绝，
不填充伪造 bytes 或忽略格式。OLE 的 DataObject/Ole Private Data
仅为原 owner 的 marshalling bookkeeping，不可移交给新 owner；其它可用
用户格式仍须保留。owner-specific/non-HGLOBAL/不可保留格式明确失败，不
清空原剪贴板继续粘贴。上限为 256 formats、单项 64 MiB、总 backup
256 MiB；超限同样保留 preview，不进行不安全的部分 snapshot。
此规则不宣称 universal OLE restore。真实 managed OLE text/RTF/HTML producer
有单独 fixture；virtual-file `FileContents`/descriptor、embedded/link-source
等依赖 stream/storage contract 的格式，明确在读取 payload 前拒绝，不把
一个 HGLOBAL 或跳过 bookkeeping 当作支持全部第三方 OLE 的证据。

恢复时在同一 lock 内重新检查 owner/sequence，再交还 clone；用户的新 copy
优先。恢复被暂时阻塞时，helper 保留一个 bounded backup，在下一命令前
继续恢复，绝不重新发送 paste。helper 被强制结束或系统持续拒绝 clipboard
访问时不能保证恢复完成，必须报告错误，不宣称成功。busy、unpreservable
format、snapshot failure、changed 和 restore failure 分开；只有实际 API
返回的 Win32 code 才记录，0 不作为具体 Windows 故障证据。
EmptyClipboard 和每个 restore setter（包括失败）都在同一个 lock 内更新
本 transaction 的 sequence。部分 restore 是自己的 mutation，不能当作
新的 user copy 丢弃 backup；未确认的 same-owner sequence drift 也保留
backup 并报错。fixture 在清空后、首个 format 后注入失败，验证完整原始
bytes 恢复、late render 不重写 transcript，以及 genuinely new copy 优先。

Targeted paste 仍经过原有 focus/secure-field/modifier/IME guards，只发送一次
批准后的结果，不替换整个字段。失败后 approved preview 保留。Auto-copy
明确仅适用于 preview recording：targeted delivery 后不再额外覆盖 clipboard，
否则会破坏 native restore 或覆盖用户的新 copy；显式 Copy result 仍可用。
完整 0.6.4 必须是同源、同版本的三个真实目标：
`VI-0.6.4-windows-x64.zip`、`VI-0.6.4-windows-arm64.zip`、
`VI-0.6.4-macos-arm64.zip`。UI/About/tray 显示 runtime architecture，
`distribution-info.json` 明确为五个字段：`version`、`platform`、
`architecture`、`target`、`sourceRevision`；旧 `build-info.json` 仍为两字段。
不能给旧包改名代替。

CI-only Windows fixture 使用实际 transaction 类测试 empty/Unicode/rich/
image/zero-valued metadata、暂时/持续占用、不可保留格式、新 copy、early reader
和 restore failure；没有向真实用户字段发送输入。framework UI 另用 owned
editor 验证实际 caret 单次粘贴与 clipboard restore；浮窗检查从原生 desktop
capture 验证实际 controls pixels、受控越界/resize、renderer failure 及主动
Hide/Show，不把 `isVisible` mock 当成完整验收。Hide 的物理负对照必须在
同一 rectangle 捕获超过 90% 的 CI-owned red underlay，并让同一 painted
predicate 返回 false；不能用黑图、无 capture 或 window flag 代替。
display notification 是
synthetic seam，不宣称真实硬件 DPI/monitor/RDP/compositor incident 已复现。
这些新 gates 需要在 Windows x64/ARM64 CI 实际运行；旧 head 的 green
packaging receipts 不证明本功能修复通过，也不授权本机交互测试或发布。
零长度 allocation 有独立的真实 `SetClipboardData` probe（先验证相同 owner
可发布 backed text/metadata），记录 numeric format、allocation flags/bytes、
实际 API 返回值与立即捕获的 Win32 error。若系统接受该 discarded handle，
仍须验证 transaction 在修改前拒绝；若系统拒绝发布，明确记录该原生拒绝，
不冒称已经 roundtrip。另有真实 delayed/unrenderable producer 的无 mutation
负例。fixture 的 allocation/lock/set 失败包含 bounded case/stage/format/size/
nativeError，不输出 payload 或 format names；raw bytes 与 transaction 前
实际分配的原始 bytes 比较，不假设 `GlobalSize` 等于请求长度。
参见 [GlobalAlloc 的零长度契约](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-globalalloc)
和 [SetClipboardData 的 ownership/返回值](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setclipboarddata)。
Electron clipboard 的读写在 UI 与 final-extracted gate 中均等待完成；text/HTML
baseline 必须先验证为实际内容，再检查 targeted paste 后的恢复，不能用 Promise
对象代替 clipboard 内容。上述契约修正不定位任何历史用户 clipboard 故障。

Windows unit 先单独运行真实 cold helper READY 测试，再串行执行其余 files，
避免原生编译与共享 desktop/clipboard fixture 并发；任一失败仍使整个 unit
失败，不以预热后的成功替代 cold readiness。生产初始化 20 s、action 8 s、
pointer 重启上限 3 次及既有 CI budgets 不变。helper 在加载 diagnostics 之前、
各编译边界、protocol loop 之前输出有限 startup markers；只接收实际 child PID、
固定 stage、pointer size 和 PowerShell major/edition，不记录环境路径或内容。
fixture 另记录 engine/assembly/transaction/owned-fixture/case 边界，超时保留这些
标量证据。没有 marker 只表示尚未观察到该边界，不能归因为 host noise 或某个 API。
CI actor 子进程同样隔离 inherited `PSModulePath`，不改调用者或要求用户安装 Core。
隔离不是简单删除该变量后依赖默认搜索：child environment 固定到 Windows inbox
module directory，bootstrap 用实际 `$PSHOME\Modules` 的完整 manifest 路径导入
Management/Utility，再禁用隐式 module autoload。bootstrap 之前只用 .NET path
组合，不先调用尚未加载的 `Join-Path`。这避免 Core/user/all-users module
discovery 影响内部 helper；不修改用户、父进程或 registry。规则依据
[Windows PowerShell 模块路径构造契约](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-5.1)，
但不能仅凭原先空 stderr 或某次超时就断定历史根因。

`Windows native startup comparison (nonrelease)` 是单独的有限诊断，不是发布：
由维护者 push `ci/windows-native-probe` 或在 workflow 注册后手动触发。
默认只运行 x64／ARM64 两个 candidate，各用独立 hosted VM、每格 3 min。
早先 inherited／deleted／inbox-autoload 对照属于其原 source head 的测量，
不因无关根修复重新执行，也不迁移成当前版本的通过证据。candidate 首先
启动真实生产 `NativeDelivery`，保留原始 20 s READY deadline，再运行实际 clipboard、
native-diagnostics、native-types、diagnostics、native-delivery selectors。早期失败仍使整格失败。
CI-only observer 在 5 s 内核对该 helper
的真实 PID/parent/creation/image/PE machine；该观察与 readiness 重叠，会明确记录，
不宣称 uncached OS/disk 或最终 app GUI 测试。只准备源码不等于已执行此比较。

恢复失败新增固定 `restore-open/sequence/copy/empty/write` stage、numeric format
和实际 Win32 code，绝不记录 format names/bytes。OLE roundtrip 的 operation
与 Dispose 异常分别保留；两者都失败时保留 aggregate，而不是用 cleanup 覆盖
原始故障。没有证明的 restore failure 仍使 fixture/CI 失败：不会吞错、跳过 OLE、
放宽 owner/sequence 检查、释放 pending backup 或再次发送 paste。
所有 transaction 分支统一独立保留 operation／cleanup 异常，而不仅是 OLE 分支；
setter fault 的 hook 仍先恢复再 Dispose，最终 fixture cleanup 也不能覆盖原始异常。
成功 JSON 只在完整 cleanup 后输出。assertion 有明确的内部标记；其它 managed/API
异常按白名单 class、实际 HRESULT／可用的 Win32 code 记录，不一律归为断言失败。
最早 mixed-format 分支分别记录 Begin 返回、原有一次临时 text 读取返回、
Restore 返回及异常点的只读状态。observed sequence／owner 是分开采样的观察，
不是原子 ownership 证明；render 的 expected/observed sequence 与写入开始／完成
标量只描述最近一次 eligible callback，不额外调用 GetClipboardData 或发起 render。
新增 render 标量通过只读 bool／uint property 提供并由 fixture 实际消费；
不能仅用 reflection 读取 private 字段，让严格 PS5 Add-Type 将其判为未使用字段，
也不能通过忽略 compiler warning 来绕过真实 helper 编译门槛。
若该分支先失败，后面的 OLE 与其余分组属于未执行，不能沿用旧失败阶段推断。
初始 publication 另保留 CloseClipboard 调用前／返回后的序列、真实 BOOL 返回、
失败时立即捕获的 Win32 error，以及返回后的 owner 观察。它们只回答变化是否
跨越 close 边界，单独不能成为 authority；不能仅凭固定增量就认定某种合成格式、
补偿计数或接受未知变化。Close 观察值仅是一次 provisional receipt。

初始 publication 现在有明确的 publishing→sealed 阶段。持锁写入临时 locale、
history/cloud flags 和每次新建的 opaque transaction nonce，保留实际发布的完整
metadata bytes；Unicode 仍延迟提供。Close 后重新取得 lock，必须同时确认：
owner 是本 transaction，sequence 仍等于 receipt，格式集合只有这些 metadata
及 Unicode/系统 ANSI/OEM text aliases，metadata 的完整 bytes（包括 nonce）
逐项相等，三个 text format 尚无 materialized handle。metadata 最大 4 KiB/项、
格式数严格有界，不反序列化任何内容，也不读取／记录未知 text bytes。
验证 text handle 时每次 GetClipboardData 都创建独立 active probe，记录本次请求
及 Unicode backing format。只有该 native call 内、owned HWND 上对应 canonical
Unicode 的 WM_RENDERFORMAT 可以确认拒绝；NULL+error0 本身不构成证明，
WM_RENDERALL、过期或无关 format callback 均不能确认本次请求。任何非 NULL
都拒绝；无法取得关联证明的原生 alias 同样 fail closed，不扩大错误码白名单。
publishing renderer 明确拒绝生成数据，blocked callback 另计数，不伪称没有请求。
同一 lock 内验证前后 owner/sequence 必须不变，之后才建立初始 sequence authority；
renderer 在只读 seal Close 及最终 owner/sequence 检查期间仍禁写；比较的是不再
变化的 locked candidate，不是 callback 可更新的 shared sequence。全部 native
检查结束后，以无 native call 的 STA managed transition 同时提交 sequence、
sealed 并启用 renderer。Close/validation 失败保持禁写和 backup。后续 render/Restore
仍使用原严格 owner/sequence checks，不以 nonce 或内容一致为由接受后续漂移。

这不是把任意 post-close sequence 作为 baseline，也不推断 Close 的增量来源。
新 owner 表示真实新 copy，原样保留；同 owner 的未知格式、已写入 text、
nonce/metadata 改动或 receipt 后的 sequence 改动均明确失败并保留 pending backup。
失败时不 clear/re-paste。fixture 在真实 Close 与 receipt 之间注入未知格式、
materialized text、nonce 改写和外部新 copy，验证这些竞争不能被初始 seal 吞掉。
所有 token/bytes 都不进入日志，只有固定 stage、numeric format 和验证结果。
临时 Unicode clipboard 现在在同一 owned lock 内显式发布当前输入语言的
`CF_LOCALE`，再采样 sequence。Windows 能从 Unicode 合成 ANSI/OEM text，
并可在 `CloseClipboard` 时补充缺失的 locale；不能把这类自有发布边界上的
系统写入当作未知 user copy，也不能简单在 Restore 时重置 sequence。
参见 [系统格式转换](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats)
与 [CF_LOCALE 的 close 契约](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats)。
restore 仍严格检查 owner/sequence；delayed renderer 在任何写入前也检查
expected sequence，避免自有 render 掩盖先前未知修改。20 项真实 fixture 保留
原 13 项，并增加实际 same-owner mutation：render 不得覆盖／归属该变化，
backup 必须仍 pending，随后真正的新 copy 优先。OLE case 保留
Begin→Restore、不预读临时 text 的原路径，另测 render-all／真实读取后恢复；两条路径都检查
发布后的 sequence 与实际 locale，额外保留原始 HTML/locale bytes。
恢复时先交还 snapshot 中已有的原始 locale，再按原顺序交还其它格式；
不制造或改写原始 locale，也不改变其它格式间的优先顺序。这样在部分 setter
失败后 CloseClipboard 也不会因已恢复 text 但尚缺 locale 而额外合成 metadata。
真实故障 seam 覆盖 empty、locale 首项、首个 text 三个 mutation 边界，之后
RecoverPending 必须恢复完整原始 bytes；外部新 copy 的负例也经过首个 text。
上述 locale／sequence 处理仍需实际全分组通过；更早边界的失败仍是 blocker，
不能仅凭契约解释、源码通过或新增日志就声称原始恢复问题已解决。
另外两个新增组覆盖 seal-window 的四类真实 Win32 竞争，以及 Unicode/ANSI/OEM
读者。转换仍交给 Windows，没有自行选择编码或改变原始 locale；测试保留
非 ASCII 的 canonical Unicode、ANSI/OEM ASCII prefix 和完整原始 backup bytes。
原 16 组之后再追加四组：逐调用 probe 的 NULL0/过期/无关/RenderAll/非 NULL
负例；第二次 readonly Close 与最终 seal 的真实 render/新 owner 竞争；
GlobalCopy 的 post-allocation/post-lock 控制故障与实际 free 一次证明；
真实 validation+readonly-close 双失败的恰好两个 scalar causes。

GlobalCopy 从 GlobalAlloc 到成功完成两个 unlock 始终持有 allocation，任何
异常都在解锁后由唯一 finally 释放；成功返回才移交给 snapshot Item。故障
fixture 只使用小型 owned buffer 与真实 GlobalFree，不制造 OOM 或巨大分配。
异常投影最多遍历 32 个节点，每个 operation/cleanup phase 各保留两个 leaf，
越界显式标记 truncated；Aggregate 的两个成员不会被 InnerException 首项替代。
wire、JS error 和 privacy log 只接受固定 code/stage、numeric format/native code，
不包含 message/token/metadata，格式错误的 cause schema 明确拒绝为 protocol fault。

diagnostic `flush()` 是 200 ms bounded best effort，不是文件存在或持久化 ACK。
native privacy/content fixture 复用已有真实 writer fixture，先等 initialization
与目标 write sequence 的实际 ACK，再调用原来的 flush 和读取文件。测试故意
延迟消息 300 ms，验证不是靠固定 sleep 或 worker 启动快才通过；writer 错误、
exit 或 fixture ACK deadline 都明确失败。生产 checkpoint 25 ms／flush 200 ms
及失败通知不变，不把缺文件当空日志，不清除 warning。

Windows UI 在唯一的 CI-owned 初始 focus 请求后，有界等待 renderer/focus 状态；
每个 overlay recovery 边界仍须由真实 native capture 确认 foreground PID/HWND
未变，不通过再次 focus 或移除断言掩盖问题。物理 Stop/Cancel 的 held case
必须在按住及 native suspension 期间保持 recording 且零 action，实际释放后
恰好提交一次，后续 fresh gesture 仍可用。native polling 不重新成为按钮事件源。
owned-desktop wrapper 保留 PID/desktop 匹配的 bounded startup progress；
progress 写入 wrapper 实际读取的 desktop receipt directory，而非相邻 evidence root；
helper/attestor/renderer readiness 未完成时仍失败，不接受仅启动进程作为 READY。
这些阶段证据与 CI 生成脚本的源文件重定位修正，都不等于已证明 ARM 冷启动
或真实用户历史浮窗问题修复；仍需 exact-head native CI 和最终包 gates。

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
三个 neutral bases；默认应用版本为 `0.6.4`，且必须与 source package version 一致。没有自动 release、
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
Windows ZIP32 容量预算明确用正的 Int64 decimal `4026531840`（3.75 GiB）。
PowerShell 的八位十六进制 `0xf0000000` 是有符号 Int32 负数，不能直接
用作该上限。writer 在 receipt 输出实际文件数、总 bytes 与预算；空文件
仍须完整保留，只有完全没有文件的 payload 才拒绝，错误也保留这些数值。
数字字面量的 sign-bit 规则见
<https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_numeric_literals>。
相关启动规则见
<https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath>。

每个平台都用实际 packaged Electron 的 Node mode 加载完整 provider、
两种 factory 和共享 config loader，通过公开 fixture 的 loopback transport
发送 synthetic PCM。测试不使用真实麦克风、credential lookup 或外部服务；
进程 cwd/profile 独立，module/preload/credential environment 不继承，
模块来源逐文件与 bundle 内 provider inventory 比较。fresh native archive
解包后重复该检查，保存 archive SHA256、source revision、架构、helper/
payload 文件 hash、原始来源与 cleanup receipt。Windows 另有最终解包
native-delivery gate：matching、hash-pinned generic Electron host 加载实际
final package 的 DesktopInput/NativeDelivery 模块，验证所有模块与 native
PS/CS 的 final-path/hash 来源，执行实际 helper Add-Type/ready/capture，
再向唯一 owned editor 做 caret 单次粘贴并恢复 text/HTML clipboard。
这属于明确的 final-module/native-path equivalent gate，不冒称启动了最终
app main；raw stdout/stderr 和实际 helper exit 保存，失败阻断 producer。
Windows receipt 的 helperRuntimeExercised 只在此 gate 真正通过后为 true。
macOS 保持 strict signing/ditto/headless provider gate，不把 compiled helper
bytes 记录当作已执行；headlessOnly/helperRuntimeExercised 继续如实区分。
以上都不证明真实用户 GUI/TCC/硬件麦克风、notarization 或所有下游行为。
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
