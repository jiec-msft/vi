# Android keyboard prototype

独立 Java 原生 IME PoC，不接入 desktop runtime，不是可分发产品。
没有网络权限、endpoint、credential、认证、真实语音 provider 或 APK/AAB 发布。
默认 `device` flavor 明确显示 **Hardware capture unavailable**，不会开始采音。
`synthetic` flavor 仅为 CI 注入 320 个 16 kHz mono PCM16 方波样本，fake
provider 返回 `Synthetic final 你好` 并故意重复回调；这不是硬件录音或识别证据。

## API 边界与官方依据

声明范围 Android 10–15（API 29–35），minSdk 29 / compileSdk、targetSdk 35。
API 35 emulator 是首个验证目标；其他版本、OEM、真实硬件和跨 app editor
未经验证，不能从 minSdk 推断兼容性。AGP 8.9.2 / Gradle 8.11.1 / JDK 17 /
SDK Build Tools 35.0.0 来自
[AGP 官方 compatibility table](https://developer.android.com/build/releases/agp-8-9-0-release-notes)。

| 能力 | 合同与本 PoC 选择 |
| --- | --- |
| IME 注册 | [`InputMethodService`](https://developer.android.com/develop/ui/views/touch-and-input/creating-input-method)，service 以 `BIND_INPUT_METHOD` 保护，系统选择 IME。Setup 只打开系统 settings / picker，不自行启用。 |
| editor 生命周期 | [`onStartInput`](https://developer.android.com/reference/android/inputmethodservice/InputMethodService#onStartInput(android.view.inputmethod.EditorInfo,boolean)) 的 restarting 也重置 session；`onFinishInputView` 在隐藏或换目标前调用，`onFinishInput` 不涵盖同 editor restart，因此两者均处理，另处理 window hidden、unbind、destroy。 |
| final 提交 | [`InputConnection.commitText(text, 1)`](https://developer.android.com/reference/android/view/inputmethod/InputConnection#commitText(java.lang.CharSequence,int))（API 3）：在 editor 当前 selection/caret 一次提交，替换 selection。不送 partial/composing、KeyEvent、Enter 或 editor action；false/异常明确报错，不重试。 |
| 键盘切换 | [`switchToNextInputMethod(false)`](https://developer.android.com/reference/android/inputmethodservice/InputMethodService#switchToNextInputMethod(boolean))（API 28）；false 时展示系统 picker。切换前先取消。 |
| secure / inaccessible | 按官方 [`InputType`](https://developer.android.com/reference/android/text/InputType) class/variation mask 拒绝 text password、visible password、web password；numeric/phone/date/TYPE_NULL 一律不支持，numeric password 也被拒绝。`IME_FLAG_NO_PERSONALIZED_LEARNING` 额外保守拒绝；不是“此 flag 等同 password”。null/inactive connection 和隐藏状态拒绝。editor 未正确标注敏感性无法自动识别，不读取周边文本。 |
| 权限 | [`RECORD_AUDIO` runtime consent](https://developer.android.com/training/permissions/requesting) 从 API 23 起需要 runtime grant；Setup 点击才请求，并显示拒绝状态。键盘每次 Start 需要独立 checkbox consent，grant 后不自动开始，Start/Stop/Cancel 明确可见。 |
| microphone / background | [Android audio sharing](https://developer.android.com/media/platform/sharing-audio-input)：API 28 后无前台 UI/FGS 可能收到 silence，API 29+ 竞争采音仍可被 silenced，permission granted 不代表真实有效 PCM。此阶段不实现硬件 adapter / FGS，不假装已解决。 |
| FGS 限制 | [官方 restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)：target 31+ 的 background FGS 限制包含 current input method exemption，但 API 34+ while-in-use microphone 创建检查是另一层，**不能**将前者当作自动 microphone 授权。需要独立实测可见 IME、silencing、permission revocation 和必要 FGS type/notification 后才接硬件。 |

完整 IME 是有系统支持的跨 editor 输入入口；lighter Activity 只能在 owned
editor 内输入，其他 app 必须显式接入，不能代替系统键盘任意 caret 提交。
本阶段不申请 accessibility、overlay、background recording 或 always-listening。

## Provider / capture 边界

`DictationController.Provider` 每次 recording 独立创建：
`start(Events)`、按序 `audio(byte[])`（16 kHz mono little-endian PCM16）、
`finish()`、`close()`。`complete(String)` 只在用户 Stop 后有效；
`partial` 永不进 editor，`failure` 必须显示错误。capture
`start(audio, failure)` / `close()` 可注入；buffer 在异步交接前复制。
adapter 操作在序列化的 main dispatcher 上必须非阻塞，网络/硬件 adapter
应拥有后台 I/O 并异步回调，close 必须幂等、释放自己的资源。

公开 root README 的 JS `createSession` / `finish` / `cancel` contract
可作为语义参考，但 JS artifact **不是 Android runtime**。Java interface
没有自动加载 npm module、私有协议或 backend default。下个最小集成决策：
选择原生 provider adapter 或显式 bridge，并另验证 capture adapter；本阶段不猜。

每次 start / cancel / restart / hide / switch 增加 generation，final 提交前
再次核对 connection 身份、editor epoch、visibility、policy 和 permission。
重复或旧 generation callback 丢弃；capture 在 Stop 先释放，provider 在
final/cancel/error 释放。60 秒 recording / 5 秒 final deadline，超时丢弃。
所有采音失败、权限拒绝、空 final、commit 拒绝、cleanup failure 显示显式状态，
不存储 editor 内容或 audio，不持续监听。

## Actions 与证据

只在 `Android keyboard prototype` workflow 安装/编译/运行：
unit + 两个 flavor build + instrumentation build 整个 job ≤180 秒；
API 35 hosted Ubuntu KVM emulator、build、boot、GUI、capture、cleanup、
GIF conversion 和 artifact upload **同一个 job ≤600 秒**。不拆开隐藏开销。
receipt 记录 upload 前 elapsed；最终权威 whole-job duration 使用 Actions
job `started_at` / `completed_at`，超预算即 blocker。

JUnit 覆盖 permission/consent/capture unavailable、final-only、重复/旧回调、
目标丢失、cancel、deadline、PCM/provider/capture/cleanup/commit failure。
instrumentation 使用 debug-only owned `EditText` 的真实 connection wrapper，
通过系统启用 IME 和 UiAutomator 点击键盘，检查 selection replacement、
只 commit 一次、无 send action、cancel/换 editor/隐藏/换键盘释放、
password block、permission denied。debug editor 不是生产 integration。
`probe.json` 含 PID、API、合成输入、commit/action/resource counts；
截图中的 state 带 session generation，receipt 关联 exact head/run/attempt。

artifact 只含真实 emulator PNG/MP4/GIF、raw instrumentation/logcat 和报告，
绝不上传 app 包。成功后先核验 exact-head job 时长、输入和媒体，再按 root
README 的 bootstrap evidence-only prerelease 手动发布；现有 trusted desktop
publisher 不支持 Android workflow，不能借用其成功声明。
真实设备权限对话框、AudioRecord、silencing、热插拔、OEM、API 29–34、
API 36+、真实识别、认证、跨 app/editor 丰富文本均为明确未验证项。
