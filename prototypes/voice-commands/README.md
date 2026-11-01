# Voice command state-machine prototype

独立、无依赖的 Node 24 CommonJS MVP；**未接入 live app，不实现语音检测**。
只有 event → state/action 的纯同步逻辑，没有 microphone、network、clipboard、
OS paste/Enter、后台监听或默认发送目标。fake-event demo 不是 speech/hardware/UI evidence。

## Interaction

语音 opt-in 默认关闭。`consent` 只表示允许 command mode，`activate` 由调用方的显式
操作打开 command channel；两者均不启动 microphone。activation 如何触发（按键、按钮、
未来的 wake phrase）是外部产品决策，本 MVP 不选择 always-listening 或云端识别方案。
caller 必须把 command recognition 与 dictation transcript 分开路由，不能从 dictation
中搜索、删除或自动解释命令词。

| 输入 | 行为 |
| --- | --- |
| command channel 的 final intent `start`（“开始”） | `idle` / `ready` / `sent` → `dictating`，请求开始新 turn |
| command channel 的 final intent `finish`（“结束”） | `dictating` → `finishing`，请求 provider finalization |
| caller 的 `dictation-finished` | final 已排空后 `finishing` → `ready`，丢弃未 final 的 preview |
| command channel 的 final intent `send`（“发送”） | 非空 `ready` → `confirming`，只请求 confirmation modal |
| modal 的外部 `confirm-send` | 校验完整 binding 后 `confirming` → `sent`，输出一次 `send` action |
| `cancel-send` | `confirming` → `ready`，保留 draft，旧 confirmation 失效 |
| `cancel` / 撤销 consent / `close` | 丢弃 draft、target、activation，输出必要的 cancellation actions |

`confirming` 是独立交互模式，不是 dictation；新的 start/finish/send intent 都会报错，
不能通过重复说“发送”确认。`sent` 禁止对同一 draft 再次 request send；显式 start 才开启
新的 recording。keyboard / PTT / button 可以经 `manual` 入口发相同 intent，无需 voice
consent/activation；原 app 的这些路径完全未改动。engine 内撤销 consent 会取消当前工作；
单独 `deactivate` 保留正在进行的 dictation，以便 manual finish，但会取消 pending send。

`commandIntentFromPhrase(phrase)` 仅供已经显式路由到 command channel 的 adapter 使用，
exact-match “开始” / “结束” / “发送”，返回 English intent。含标点、额外空格、混合句子、
未知命令均抛 `UNRECOGNIZED_COMMAND`，不猜测 recognition confidence。普通 dictation
中的这些词（包括独立 final “发送”）全部原样保留。

## API

```js
const { createVoiceCommandEngine, commandIntentFromPhrase } = require('./engine.cjs');
const engine = createVoiceCommandEngine({ sessionId: 'unique-recording-controller-session' });
engine.dispatch({ type: 'consent', enabled: true });
engine.dispatch({ type: 'activate', activationId: 'unique-command-activation' });
const result = engine.dispatch({
  type: 'command',
  activationId: 'unique-command-activation',
  utteranceId: 'recognizer-utterance-1',
  phase: 'final',
  intent: commandIntentFromPhrase('开始'),
});
// The caller handles result.actions; the engine does not start recording.
```

`dispatch(event)` 返回 `{ status, reason, actions, snapshot }`。`status` 为 `applied` 或
`ignored`；ignored 的 `reason` 明确标识 partial、duplicate 或 unchanged input，没有动作。
非法结构、无效 transition、stale/replayed input 抛 `VoiceCommandError`，具有稳定 `code`；
caller 必须向用户或标准错误通道显示，不能吞错。`snapshot()` 返回独立副本：
`mode`、`consent`、`activationId`、`turnId`、`target`、final-only `text`、`preview`、
`pendingSend`、`sessionId`。调用方不能通过修改 snapshot/action 改写内部 binding。

| Event type | Required fields |
| --- | --- |
| `consent` | `enabled: boolean` |
| `activate`, `deactivate` | `activationId: string` |
| `command` | `activationId`, `utteranceId`, `phase: 'partial' \| 'final'`, `intent: 'start' \| 'finish' \| 'send'` |
| `manual` | 唯一 `eventId`，`intent: 'start' \| 'finish' \| 'send'` |
| `target` | `targetId: string`, `revision: nonnegative safe integer` |
| `dictation` | `turnId`, `segmentId`, `phase: 'partial' \| 'final'`, `text: string` |
| `dictation-finished` | `turnId` |
| `confirm-send` | `requestId`, `sessionId`, `targetId`, `revision` |
| `cancel-send` | 当前 `requestId` |
| `cancel`, `close` | 无额外字段 |

### Final ordering and identity

command partial 永不产生动作；同一 activation 下的 `utteranceId` 只能提交一个 final intent。
重复 final 无动作，更改 final intent 抛错。**结构合法但在当前状态被拒绝的 final ID 也被
消耗**，防止旧命令在后续状态复活。manual 的 `eventId` 有相同 single-use 语义；需要用户
重新操作时生成新 ID，而不是重用被拒绝的 ID。每次外部 activation 必须用新 `activationId`。

dictation partial 替换同一 segment 的 preview，final 锁定 segment 文本，重复 final 不追加，
冲突 final 抛错。segment 按首次出现顺序拼接，不插入空格或改写内容。caller 必须按语音顺序
注册 segment，且不能把不同 provider 的累计全文误作新 segment delta。finalizing 期间忽略
新 partial，但继续接受属于当前 turn 的 final；只有 adapter 确认所有 final 已 drain 后才
提交 `dictation-finished`，之后的 dictation 抛错。旧/cancelled turn 事件不会污染新 turn。

### Confirmation and target freshness

`target` 没有默认值，由 caller 明确选择。caller 提供 session 内全局单调递增的 `revision`：
focus/目标、editor 内容、selection 或发送语义改变都必须增加；相同 revision 仅能重复同一
未清除 target。cancel 后重新选择 target 也必须使用更高 revision。

`request-send-confirmation` action / `pendingSend` 含
`{ requestId, sessionId, turnId, targetId, revision, text, source }`。modal 应展示目标和
exact text，并只在明确用户确认后携带该 binding 调用 `confirm-send`。错误 request/session/
target/revision 会报错但不消耗当前有效 request。target 或 revision 改变立即取消旧 request；
撤销、close、deactivation、重复/迟到确认均不能产生 send action。

`confirm-send` 是可信 caller 的输入，不是身份认证。engine 只能比较 caller 最后提交的
target/revision：caller 必须在确认前读取当前目标并更新 revision，也必须在处理 `send` action
时重新校验真实 focus/editor revision。engine 与外部 OS 状态之间不能提供原子保证。
`sent` 表示 **send action 已请求**，不表示实际送达；adapter 负责安全执行、错误呈现以及
按 `requestId` 防重复。本 MVP 不提供失败自动 retry 或 exactly-once OS delivery。

`sessionId` 必须是每个 engine lifetime 唯一的 caller ID，重建 controller 不能复用它；
turn/request ID 使用该 session 与递增 sequence。engine 的 replay ledger 保留至 close，
不跨进程持久化。caller 在关闭时处理 `cancel-dictation`，取消 outstanding promises、移除
provider listeners、调用 provider `cancel()` / `close()`；engine 自身没有 timer/listener/IO。

## Public provider boundary / proposed integration contract

只参考 repository 公开的 versioned `service-provider` contract，不依赖任何 provider transport。
framework provider 的 `on('partial')` 是 preview；`finishTurn()` / `finish()` 返回 final string。
未来 adapter 应捕获 engine `turnId`，将同一 provider turn 的累计 preview/final 路由到同一
`segmentId`，await finish、提交 final 后再提交 `dictation-finished`。多个 segment 的语音
顺序由 adapter 负责。取消或 provider failure 时先 `cancel`，再做 provider cleanup，并显示
failure；晚到 callback 的 old turn 由 engine 拒绝。command intent 必须来自另外明确激活的
command channel，不能把 provider partial 或普通 final transcript 当作命令。

最小 app 接口仅需：explicit consent/activation UI、command/manual event router、recording
action adapter、target/revision owner 和独立 send-confirmation modal。以上均为待集成接口，
不是已实现功能；不会修改现有 app、PTT、microphone policy 或 clipboard delivery。

## CI and reproducible demo

所有执行仅在 GitHub Actions，**不要在本机运行**以下命令：

```text
node --check prototypes/voice-commands/engine.cjs
node --check prototypes/voice-commands/demo.cjs
node --check prototypes/voice-commands/engine.test.cjs
node --test prototypes/voice-commands/engine.test.cjs
node prototypes/voice-commands/demo.cjs
```

`.github/workflows/voice-commands.yml` 使用 Node 24 / `windows-2025`，整个 job 上限
180 秒，无 dependency install。demo 使用 synthetic IDs 和固定文字，生成可复现 JSON trace：
opt-in/activation、partial start、final start、重复 final、普通含命令词的 dictation、
finish/drained final、send request、显式确认和 close。tests 校验 exact actions、final-only
文本、duplicate、consent、modal、cancel、target/revision/session freshness 和 replay。
`voice-command-demo` artifact 含 runner 生成的 `demo.json` 与绑定 exact head/run/attempt
的 `report.json`；artifact 是 event evidence，不是媒体。

此 pure engine 没有 GUI 变化，因此本 prototype 不生成或声称 UI visual evidence。
既有 Platform checks 仍独立运行；任何已有 app 的 UI media 发布遵守 root README 的
PR visual evidence 流程，不能用本 trace 替代 native UI、speech 或 end-user integration 验证。
