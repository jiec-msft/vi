# iOS input feasibility / lifecycle proof

这是独立的 native Swift 状态机，不是 iOS app、keyboard extension 或 speech
recognizer。没有 microphone、音频 fixture、网络、账号、默认服务、clipboard
adapter、App Groups、entitlements 或 UI。测试只发送 synthetic text callbacks。
不能将编译通过解释为系统权限、真实录音、转写或跨 app 输入已工作。

## 官方能力边界

核对日期：2026-11-01。目标基线 iOS 17+；CI 编译范围是 Xcode 16.4 /
iOS 18.5 simulator SDK 与 Xcode 26.3 / iOS 26.2 simulator SDK，实际版本以
runner receipt 为准。API 的 availability 不等于在所有 OS/device 上实测。
不使用 preview SDK，不承诺未验证的未来版本。

| 能力 | 官方依据与结论 |
| --- | --- |
| 替换 Apple keyboard / dictation backend | 在 [UIKit keyboard controller][controller]、[keyboard guide][keyboard]、[Speech recognizer][recognizer]、[SpeechAnalyzer][analyzer] 的公开文档中，未找到向系统 dictation 注册第三方 backend 的 supported extension point。不能声称可替换系统麦克风按钮的服务。 |
| Custom keyboard microphone | [keyboard guide][keyboard] 明确排除 microphone/dictation capture；[extension overview][extensions] 也明确排除 microphone，另列 iMessage 特例，不适用于 keyboard。该 archived guide 的 iOS 8 原始说明不能单独证明每个后续版本；当前 controller 文档仍引用它，现行 Review 4.4 要求遵守该 guide。 |
| `hasDictationKey` | [该属性][dictation-key] 自 iOS 8 可用，仅描述自带 dictation key 时禁用系统 key；不是 microphone grant、系统转写回调或 backend 注册入口。原型不设置它。 |
| Full Access / network | [当前 Open Access guide][open-access-guide] 区分 network / shared-container 写入与读取：正确配置的 keyboard 无 Open Access 仍可只读访问 containing app 的共享容器；network 与共享写入需 [`RequestsOpenAccess`][open-access]（自 iOS 8）及用户 Allow Full Access。[`hasFullAccess`][full-access] 自 iOS 11，用于读取实际授权。plist 请求不等于用户允许，不授予 microphone。必须保留无 Full Access 的基本键盘输入。 |
| Keyboard 启动 companion | 当前 [`NSExtensionContext.open`][extension-open] 仅明确列 Today / iMessage 支持；Review 4.4.1 禁止 keyboard 启动 Settings 之外的 app。不能靠 URL scheme、responder chain 或间接调用 `UIApplication.shared` 绕过。用户应手动切换 app。 |
| Keyboard 输入范围 | [guide][keyboard] 排除 secure fields、`phonePad` / `namePhonePad`；host app 可完全拒绝 custom keyboards。`textDocumentProxy` 只面向当前 editor，不能保存跨 app 焦点、控制 selection UI 或自动发送消息。 |
| Shared storage / signing | [App Groups][groups] 需要同 team 的 app/extension 配置 group entitlement，并在 developer account 注册 iOS group；共享容器需同步访问。companion 写入、keyboard 只读的路径不必要求 Full Access；keyboard 共享写入才需 Open Access。App Groups 配置仍是独立条件。无签名 SDK 编译不验证容器、安装或授权。 |
| Foreground companion capture | [`AVAudioApplication.requestRecordPermission`][record-permission] 自 iOS 17；需 `NSMicrophoneUsageDescription` 与用户明确允许。denied 时不能以静音伪装成功，应提示用户去 Settings。foreground app 可以使用公开音频 API，但本原型未实现。 |
| Apple app-owned recognition | [`SFSpeechRecognizer`][recognizer] 自 iOS 10，另需 speech authorization，语言/联网可用性不保证；[`SpeechAnalyzer`][analyzer] 自 iOS 26，是 app-owned analysis session，也需验证 assets、locale/device support。两者不是系统 dictation backend 替换。 |
| Copy / Paste | [`UIPasteboard`][pasteboard] 允许显式 Copy 后用户手动 Paste。iOS 14 有非用户意图读取提示；[`UIPasteControl`][paste-control] 自 iOS 16 支持用户触发 Paste，避免程序读取的 approval prompt。不能控制另一 app 的 editor 或保证该 app 接受 Paste。 |
| App Store | [Review Guidelines][review]，2026-10-16 版：2.5.1 public APIs；2.5.4 background service 用途；2.5.14 recording consent/指示；4.4.1 typed input、next keyboard、无 Full Access 仍可用、禁止启动其他 app；5.1.1/5.1.2 privacy、最小化、撤回与第三方 AI 数据共享明确同意。符合设计原则不是 Review approval。 |

## 两条合法候选与产品决策

| 路径 | 用户明确动作 | 成本与限制 |
| --- | --- | --- |
| Foreground companion + Copy/Paste（最小候选） | 手动打开 companion → 确認 microphone / provider 数据用途并 Start → Stop → review final → Copy → 手动返回目标 app → 选择 editor 并 Paste | 不安装 custom keyboard，不需 Full Access / App Groups；仍需真实 microphone 权限、native provider、签名与 device 验证。无法自动返回/定位/发送。 |
| Keyboard + foreground companion（非本阶段） | 安装并启用 keyboard → 手动切换 companion 录音/review → 明确保存短期 final → 手动返回目标 app 和非 secure editor → keyboard 上 review/Insert | keyboard 只转入已完成文本，不能录音或启动 companion。需 App Groups/entitlements；companion 写入、keyboard 只读可不要求 Full Access。若 keyboard 需 network 或回写共享状态（例如消费确认、删除），才需 Open Access 与用户 Allow Full Access。仍有 keyboard 安装成本，并需基本 typed input 与 next keyboard。返回后是新 editor，不能沿用旧上下文自动插入。 |

只读访问本身不提供 TTL、跨进程一次性消费、消费确认或删除保证。若选择只读路径，
仍需设计并验证过期拒绝、重复消费防护及 companion 侧清理；不能把进程内状态当成
跨进程保证。若选择 keyboard 回写共享 ack/delete，则这些写入才是要求 Full Access
的具体原因。本阶段不选择任一路径，也不实现共享 transport。

**待人选择**：是否接受手动切换与 Copy/Paste，或要求附加 keyboard 文本中转？
本 proof 不把前者静默宣布为既定产品 UX，也不以模拟 UI 掩盖原始语音键盘目标
的 blocker。Siri / Shortcuts 不是替换系统 dictation 的证据；本阶段不实现。

## 最小 MVP contract 与当前 proof

`InputSession` 是同步 value-type reducer。未来 host 必须在一个串行执行上下文
（例如 `MainActor`）持有它，并按返回的 `Effect` 顺序执行实际 native 操作：

| 输入 | 状态/输出 |
| --- | --- |
| `begin(consentGranted:isForeground:editorLease:)` | 每次新 turn 显式 Start，先检查 consent 与 foreground；只生成 `.openProvider(id)`，不自动录音。 |
| `providerOpened(sessionID:)` | 只有当前 opening session 可开始 capture；生成 `.startCapture(id)`。 |
| `providerPartial(sessionID:text:)` | 只做 preview，不生成 delivery，不可 `takeFinal`。 |
| `requestFinish()` | 先 `.stopCapture(id)` 再 `.finishProvider(id)`，不持续监听、不自动下一 turn。 |
| `providerFinal(sessionID:text:)` | 仅在 finalizing 接收；关闭 provider 并等待 review。空/纯空白 final 明确失败，非空文本保持原样。 |
| `takeFinal(editorLease:)` | 仅显式用户 Copy/Insert 后调用，一次性返回 final string；不会写 clipboard、注入键盘或发消息。 |
| `cancel()` / `leaveForeground()` / `invalidateEditor()` | 清除 preview/final；若 capturing，先 stop，再 cancel/close。取消后 callback 不可重启或交付。 |
| Provider failure | 明确 `.failed` / `.providerFailed`，无 success-shaped fallback；host 必须展示安全错误。 |
| 旧 callback | 返回显式 `.ignoredStale`，不影响新 session；当前 session 的错误顺序则抛 `invalidPhase`。 |

`editorLease` 是 host 生成的 opaque UUID，**只保护 owned editor**。focus、
selection 或内容变更、blur/re-focus、scene 失活时，host 必须失效旧 lease；
异步权限授权结束后必须重新核对 foreground / lease。不可由原 editor 的文本
内容推断仍有交付许可。lease 不匹配时 fail closed 并销毁 final。
不读取另一 app 的文本，也不认为 companion 能验证目标 app 原 editor。

尚未实现的 adapter 必须：

- 使用每个 session 独立的 capture/provider handles，late open 完成后也关闭已取消
  的 handle；取消/关闭幂等，任何失败均通知 host。测试只验证**清理命令**，不证明
  实际连接、音频 tap 或 resource release。
- 用 native Swift 实现或明确适配 provider-owned transport/credentials，不假设本仓库
  JavaScript provider 可在 iOS 运行。本仓库 root README 的 final/partial、
  finish/cancel/close 行为用于语义对照，不复制 JS manifest 或 wire protocol。
- 在用户 Start 前披露并确认接收音频的 provider、目的与保留策略；microphone
  系统授权不代替外部数据传输 consent。配置变化后重新同意，不加载下载的可执行插件。
- 串行处理音频，Stop 后不再读 microphone；处理 interruption、scene 失活、
  超时与取消，不启用 background recording，不自动重连、持续监听或 auto-send。
- 用单调时钟限制 capture/finalization 等待并调用取消。当前 reducer 没有 timer，
  因此没有实测超时、permission prompt 或 microphone 生命周期。
- Copy 必须单独明确触发，披露 general pasteboard 可被其他 app 使用；可用
  [`localOnly`][local-only] 限制 Handoff 并设置短期 expiration。取消时不要清空别人
  后来写入的 clipboard。keyboard 共享结果的目标是短期、一次性、同步消费且不保存
  audio；只读权限不保证这些目标，shared-write ack/delete 路径才需 Full Access。

## CI 范围与验收 blocker

[iOS input lifecycle workflow][workflow] 仅绑定本目录与自身文件，普通 hosted
`macos-15`，强制 ARM64，整个 job 上限 180 秒，无依赖安装、Apple account、
certificates、provisioning 或签名 secrets。Swift 6 tests 在 macOS 执行；
两个 iOS simulator SDK 只编译同一 library，**没有 boot / install / startup /
UI / simulator-runtime execution**。text-only receipt 记录 exact head/run/attempt、
image、Xcode/Swift/SDK。whole-job 实际耗时必须从完成后的 Actions jobs REST
`started_at` / `completed_at` 核对，不能用步骤计时替代。artifact 只有日志，不上传
library、app package 或媒体，因此无视觉成功 claim / PR media 证据。

当前 focused tests 覆盖 consent/foreground、final-only、Stop 顺序、各状态取消、
late callbacks、新旧 session 隔离、editor lease、provider/empty-final failure、
重复交付与 invalid transitions。iOS device/microphone/TCC、真实 provider、
keyboard 安装/Full Access/secure fields、App Groups、跨 app Paste、用户接受的 UX、
signing/distribution 与 App Store Review 都仍是单独 blocker，不由此 CI 证明。

[keyboard]: https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/CustomKeyboard.html
[extensions]: https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionOverview.html
[controller]: https://developer.apple.com/documentation/uikit/uiinputviewcontroller
[dictation-key]: https://developer.apple.com/documentation/uikit/uiinputviewcontroller/hasdictationkey
[open-access]: https://developer.apple.com/documentation/bundleresources/information-property-list/nsextension/nsextensionattributes/requestsopenaccess
[open-access-guide]: https://developer.apple.com/documentation/uikit/configuring-open-access-for-a-custom-keyboard
[full-access]: https://developer.apple.com/documentation/uikit/uiinputviewcontroller/hasfullaccess
[extension-open]: https://developer.apple.com/documentation/foundation/nsextensioncontext/open(_:completionhandler:)
[groups]: https://developer.apple.com/documentation/xcode/configuring-app-groups
[record-permission]: https://developer.apple.com/documentation/avfaudio/avaudioapplication/requestrecordpermission(completionhandler:)
[recognizer]: https://developer.apple.com/documentation/speech/sfspeechrecognizer
[analyzer]: https://developer.apple.com/documentation/speech/speechanalyzer
[pasteboard]: https://developer.apple.com/documentation/uikit/uipasteboard
[paste-control]: https://developer.apple.com/documentation/uikit/uipastecontrol
[local-only]: https://developer.apple.com/documentation/uikit/uipasteboard/optionskey/localonly
[review]: https://developer.apple.com/app-store/review/guidelines/
[workflow]: ../../.github/workflows/ios-input.yml
