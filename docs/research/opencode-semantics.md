# OpenCode Session、消息与工具源语义调研

- 决策票：[核验 OpenCode Session、消息与工具的源语义](https://github.com/SingleMai/ATape/issues/110)。状态：研究证据，尚非接入决策或生产支持承诺。
- 核验日期：2026-09-10。GitHub latest 为非 prerelease 的 `v1.18.30`，发布时间 `2026-09-09T03:34:27Z`；通过 Git tag ref 核验并 checkout 的固定提交为 `3104c1428ec91f809e5ab86631300de41eb6952e`，不是 release 的 target_commitish。[固定版本][release]
- ATape 基线：`242b2f2a90c405528d8c70880ad0b3bad7d9d00f`。仅阅读官方文档和固定源码；没有读取用户私有历史、运行 OpenCode、安装上游依赖或生成伪造的运行证据。
- 本文区分**源事实**、**可行映射**、**待讨论选择**。建议仍需脱敏 fixture 与恢复测试验证；被接受的重要契约取舍再记录为 ADR。

## 可以进入讨论的结论

OpenCode 能提供稳定 Session/message/part ID、结构化工具状态和子会话证据，足以支持对话与工具回放。主要难点不是文本提取，而是把**会变化、会删除且可能缺少创建证据的源历史**接到 ATape 的确定性重放、不可变归属与当前 Canonical Interface 上。

1. 普通 TUI/CLI 的 `/session` 路径仍使用 v1 message/part 模型；其写入已经经过持久 EventV2 与投影。`/api/session` v2 路径也被服务器装配，另写 `session_message`，不能把源码里的 “v2” 一概理解成 SDK 命名或未启用实验。[运行入口][runtime] [普通 TUI][tui] [CLI][cli] [v2 路由][v2route]
2. `Session.parentID` 是 Session 关系；assistant 的 `parentID` 是其 user message 关系。普通 task 创建前者，但公共创建接口也允许它，且 task 可恢复已有 Session；不能仅凭字段名断言创建原因。[创建与 fork][session] [task][task] [消息 Schema][message]
3. 显式 fork 创建独立 Session，复制前缀并分配新 message/part ID；此路径不写源 Session ID 或 Session parentID。复制的 task metadata 仍可能指向原 child，不能据此迁移 child 归属。[创建与 fork][session]
4. `Session.directory` 是创建时 CWD 的初始值，却会被 move 改写。完整保留的 `session.created` 事件可提供更强的起点证据；老库迁移和 import 可能没有该事件。[创建与 fork][session] [Moved][moved] [事件缺口][reset] [导入][import]
5. revert 先留下边界，继续对话时删除投影尾部；持久事件可能仍保留旧内容。ATape 当前没有“从新 Active Path 中撤下既有 Event”的输入操作，单纯漏发尾部不能修复已发布时间线。[revert][revert] [cleanup 调用][promptcleanup] [ATape Event][atapeevent]

## 1. 实际运行模型与证据边界

### v1 和 v2 同时存在

普通 TUI 调用 `sdk.client.session.prompt`；`opencode run` 调用 `client.session.prompt`；旧 HTTP handler 注入 `Session.Service`、`SessionPrompt.Service`、`SessionRevert.Service`，读写 `message`/`part`。默认 `app-runtime` 同时注册 `SessionProjector` 和 `EventV2Bridge`。因此“message/part 是 v1”不等于“没有持久事件”。[TUI][tui] [CLI][cli] [默认运行时][runtime]

服务器还无条件装配 v2 `SessionV2.node`，其 `/api/session` handlers 注入 `SessionV2.Service`；v2 `session_message` 有 `type`、aggregate `seq` 与独立内容 Schema。第一版若仅实现 v1，应检测并明确报告 v2-only 数据，不能把无 v1 messages 的 Session 标记为完整空会话。本文详细内容映射针对普通 v1 路径；没有声称已完成 v2 全部 SessionMessage 变体的投影设计。[服务器装配][serverroutes] [v2 路由][v2route] [v2 handler][v2handler] [数据库 Schema][sql]

持久 v1 Created、Updated、MessageUpdated/Removed、PartUpdated/Removed 共用以 Session 为 aggregate 的版本化定义；`message.part.delta` 没有 durable 配置。PartUpdated 含完整 part 和发生时间，并由 projector 按同一 part ID upsert。[事件定义][events] [投影][projector]

但事件覆盖不能预设完整：最初 events migration 仅建表，没有为旧 message/part backfill；后续 reset migration 删除全部 event/event_sequence 和 v2 投影而保留 v1 表；当前 import 直接插入 v1 表。故“保留的持久日志足以重放某段”与“完整原生历史都可重放”是两种承诺。[建表 migration][eventmigration] [reset migration][reset] [导入][import]

### 身份、更新与顺序

| 源事实 | 对采集的含义（推论） |
| --- | --- |
| Session、message、part 各有 ID；message 与 part 是表主键，更新覆盖 `data`；Schema 不提供单调内容 revision。[Schema][sql] [投影][projector] | 可用源 ID 稳定命名 Canonical Event，不能把每次观察当新 Event；内容变化需要确定性的新 revision。 |
| message 排序是 `time_created` 再 ID，part 排序是 ID；源代码专门指出 imported IDs 不保证单调时间。[分页][messagequery] | 使用被核验的排序规则，而非全局字典序或数据库物理 row 顺序；时间相同也需要 tie-breaker。 |
| text-start 写空 part；delta 累积在内存并发布非持久通知；text-end 将完整累计文本写同一 ID，且插件可变更最终文本。[流式写入][stream] | SQLite 的运行中状态可能停在空/旧版本；不能保证逐 token 捕获，也不能把空 part 当最终内容。 |
| DB `time_updated` 由毫秒时钟更新；Session title/archive patch 可保持原 Session.time.updated，usage 更新显式保持它，project ID 重归属也保持它。[时间][timestamps] [Session patch][session] [投影][projector] [Project 迁移][projectmigration] | 单靠 Session.time.updated 高水位不构成完整变化检测；时间戳不能直接充当稳定修订计数。 |
| 持久 event 每个 aggregate 有 seq；message/part 删除也有事件，但删除整个 Session 后连 aggregate events 一起删除。[事件表][eventsql] [删除][remove] | 连续保留区间内可以使用 seq 作为版本证据；仍需处理起点缺失、重置、导入和整会话删除。 |

**建议候选**：一 source part 对应稳定投影槽位，合成较大的语义单元时保留确定性槽位规则。被固定的 source snapshot 或已验证 event prefix 提供 revision；occurrence time 来自源时间，不随采集重试变化。不要在此票锁定 cursor、Raw 分段或跨重启快照机制，它们属于采集契约决策。

## 2. Session、Thread、fork 与 task 的谱系

### 已证实的源事实

- 普通创建把当前 `ctx.directory`、project ID、worktree-relative path 与可选 `parentID` 写入 Session；`parentID` 由调用者提供。Public API 允许创建带 parentID 的 Session，故无法仅从该字段证明它由内置 task 产生。[Session 创建][session] [官方 Server 文档](https://opencode.ai/docs/server/#sessions)
- task 新建 child 时写 `parentID = 当前 Session ID`、subagent agent 与标题；task 工具 metadata 同时写 `parentSessionId` 和 `sessionId`（注意大小写不同）。`task_id` 存在时首先按 ID 取已有 Session，成功则复用，所读代码没有校验该 Session.parentID 等于当前调用方。嵌套深度沿 parentID 计算；默认深度限制是 1，可配置。[task][task]
- task 结果取 child 最后一个 text；这是一份父工具输出，不等价于完整 child 历史。后台 task 受实验开关约束，还可能注入 `synthetic: true` 的 user text 通知。[task 结果][taskresult]
- assistant message.parentID 指向 user message；一个用户回合可有多条 assistant message。没有证据把该边当成所有消息的单链 previous-message 指针。[消息 Schema][message] [prompt][assistantcreate]
- fork 以当前 instance CWD 创建新 Session、继承 workspaceID 与 metadata、生成 fork 标题；不设置 Session.parentID。它复制目标 message **之前**的前缀，未找到目标时复制全部；生成新 message/part IDs，重映射 assistant parentID 和 compaction tail_start_id；消息原来的时间、assistant.path、tool callID/metadata 随 spread 保留。此固定实现无显式源 Session linkage；“标题像 fork”不是可靠谱系证据。[fork][session]
- API 的 children 描述写了 “forked”，但实际 children 按 `parent_id` 查询；fork 实现不设置它。判定应以该固定版本的查询与创建代码为准。[children 实现][children] [API 描述][childrenannotation]

### 可行映射比较（待选择）

| 方案 | 收益 | 风险与要求 |
| --- | --- | --- |
| 每个 OpenCode Session 都成为独立 Captured Session | 身份与分页简单，fork 自包含；不需要先获知祖先 | 正常 task 不再是产品要求的 child Captured Thread；只适合明确受限的临时支持范围。 |
| 根 Session 为 Captured Session，证据一致的 descendants 为 child Captured Threads | 保留主对话和 subagent 回放，符合现有域模型 | 必须在发布前确定 ownership，核对 child.parentID 与 task metadata；跨根 task_id 复用、被复制的 task 引用、缺失父节点不能自动收编。 |
| 仅用 task metadata 组织树 | tool-to-child 直接可用 | fork 复制旧 metadata、task_id 复用会造成错误归属；不建议单独作为权威。 |

推荐进入讨论的是第二条：明确 parentID 的关系证据和 task 调用的创建/复用证据，分别处理“child 的所有权”与“某次工具调用指向 child”。保留 fork 的复制前缀，使用 fork Session 的新 namespace；不要做跨 Session 全局去重。跨 Session 引用不能硬塞为当前 Session 内 `childSourceThreadId`。

ATape 当前 Thread parent 不可变，Event Session/Thread 所属也不可变。先当独立 Captured Session 发布，再发现它属于别的根，不能通过提高 revision 移动；“先挂 root，以后改为精确嵌套 parent”也不被接受。需要讨论 unresolved parent 是延迟 Canonical、固定为 Detached Subagent Thread 并标记 degraded，还是另设有限支持规则；不能假装已有自动修复能力。[ATape 不可变归属][atapeownership]

## 3. Origin CWD、Project 与 Git identity

源 `projectID` 不是 ATape Project identity。当前解析先使用 normalized Git remote 的 hash，再尝试 `.git` common directory 内缓存 ID、root commit；无仓库则 `global`。remote normalization 与 ATape Host 的 Git attribution 契约不同，且仅有 hash 不能还原 remote URL。旧 project ID 可以迁移为新 ID并重写 Session.project_id，Session ID 不变。[Project 解析][project] [Project 迁移][projectmigration]

Session.directory 初始等于创建 CWD，Session.path 初始是相对 worktree 路径；Moved projector 会更新 directory/path/workspace。Move 要求目标解析成同一 OpenCode project ID，这只是源约束，不能证明绝对 CWD 未改变，也不能替代 ATape attribution。[创建][session] [move 约束][moveoperation] [Moved 投影][moved]

**证据优先级候选**：完整可靠的 Created 事件及其初始 info.directory ＞ 已在首次采集固定并有充分来源说明的 immutable origin evidence ＞ 当前 Session.directory。第三者只是当前位置，缺失前两者时不应擅自提交为 Session Origin CWD。第一条也要排除导入/replay/rebase 等使创建记录变成“导入时状态”的来源；当前 migration/import 缺口已足以禁止无条件使用。

assistant.path.cwd/root 记录生成 assistant 时的上下文；fork 会复制这些旧值，因此“第一条 assistant 的 cwd”也未必是 fork 自己的起点。Session.created 的时间是新 fork 时间，但复制消息可能更早，这不是排序损坏证据。[fork][session] [assistant Schema][message]

ATape Git Adapter 必须给 Host 提供稳定 sourceId、immutable originKey、原始 CWD 和可选 provider remote。不能用用户配置的 Project.path、OpenCode project.worktree 或后续 assistant cwd 填补起点；无证据应走 attribution unknown/诊断。[ATape attribution 契约][atapecontract]。以上是现有约束的推论，是否对事件缺失历史接受可披露的降级，需要 HITL/ADR 决策。

## 4. 回退、压缩与删除：保留的是哪一种历史

| 操作 | v1 源行为 | 采集后果 |
| --- | --- | --- |
| revert | 写 Session.revert messageID/可选 partID；若选 part 前没有 text/tool，可能退到最近 user 边界；同时处理工作区 snapshot/diff。此时没有立即删除所有消息。[revert][revert] | 默认展示必须解释边界；单纯读取所有消息不代表当前继续路径。 |
| unrevert | 恢复文件 snapshot、清除 revert 标记。[revert][revert] | 在 cleanup 前旧尾部仍可重新成为当前历史，不能永久当作子线程。 |
| revert 后新 prompt | 先 cleanup，删除边界及之后 message，或保留边界 message 的前缀 parts，再清除标记。[cleanup][revert] [prompt][promptcleanup] | snapshot diff 会发现删除；若先前已发布，漏发无法撤下旧 Canonical。 |
| compaction | 新建同 Session、summary=true 的 assistant，agent/mode 为 compaction；filterCompacted 构造给模型的上下文并可重排 retained tail；原库完整消息查询没有这个过滤。[summary][compaction] [上下文过滤][filtercompacted] | 压缩是上下文选择，不是新 Captured Session/child Thread。历史回放与“模型当前看到的上下文”应分开。 |
| prune 工具输出 | 给已完成工具加 time.compacted；该函数保留 output 原文。模型转换才用 cleared 占位文案并省略附件。[prune][prune] [model conversion][toolconversion] | 不应误称持久化工具原文已经删除，也不应把模型占位文案覆盖到 Raw。 |
| 删除单 message/part | 删除投影行，调整 Session usage 汇总，持久 removed 事件仍可能在该 Session aggregate。[投影][projector] | 事件日志在覆盖有效的前提下可以保留被删版本；仅取当前行无法恢复。 |
| 删除 Session | 递归删除 children，删除 Session 与其 aggregate events；message/part 由外键 cascade。[删除][remove] [外键][sql] | 下次历史扫描可能只见缺席。未曾捕获的历史不可凭空恢复；源删除不等于删除 ATape 已捕获历史。 |

v2 的 revert 是独立 staged/cleared/committed 事件；commit projector 按 seq 删除边界之后的 `session_message` 和相关 `session_input`。其边界规则不同于上表 v1 cleanup，不能混用 ID 排序/边界推断。[v2 revert][v2revert] [v2 投影][v2revertprojector]

**待讨论核心**：ATape 要展示最新源指示 Active Path，还是全部已捕获历史并明确标注已回退？前者需要通用 Canonical 撤下/active-path 或快照成员机制；后者需要产品确认，不能默认混成一条当前对话。现有 Interface 不含 tombstone/active-membership 操作，历史 Event 不在新 observation 里并不会使它被删除。[ATape 输入][atapeevent] [ATape 应用逻辑][atapeownership]

## 5. 内容、工具、usage 到 ACP 的候选投影

以下均为候选映射，保留完整源证据后再定投影规则。

| v1 源单元 | 可行 Canonical 投影 | 需要保留/避免的失真 |
| --- | --- | --- |
| user/assistant text | user_message_chunk / agent_message_chunk | 保留完整语义 part，稳定 ID；synthetic、ignored 与空字符串不是普通用户输入同义词。 |
| reasoning part | agent_thought_chunk | 保留 text，provider metadata/signature 留 Raw；空 reasoning 不伪造正文。 |
| file part | ACP image/audio/resource-link/embedded resource 中可验证的一种 | 源是 mime、URL、filename、可选 file/symbol/resource source；引用不等于已有文件字节。禁止为“完整”猜读整个原始路径或自动联网下载。 |
| tool pending/running/completed/error | 固定 tool identity 的 tool_call / tool_call_update | pending 有 raw 参数文本；running 有 input、可选 title/metadata；completed 有 output、title、metadata、时间和附件；error 有错误与 metadata。应保留 input/output 结构而非仅拼一行摘要。 |
| task tool | 同上，且只在已验证同 Captured Session 的 child ownership 时挂 childSourceThreadId | tool callID 不是 child Session ID；不同 tool 调用可指向同一恢复的 child；fork 中相同 callID/metadata 不构成全局相同 Event。 |
| compaction、agent、subtask、step、snapshot、patch、retry | 默认 Raw；需要时使用少量 derived 叙述或单独 usage | subtask 描述本身没有 child ID；patch 是 hash/files，不等于完整 diff；retry 不是用户对话。不要为了映射每个原始 record 扩张公共 ACP taxonomy。 |

各 part 的字段在固定 Schema 中定义。[内容 Schema][contentschema] [工具 Schema][toolschema] [消息 Schema][message]。模型转换会将 pending/running 工具补成 interrupted error、替换 compacted 输出、对媒体增加 synthetic user message；那是模型输入适配，不是 Raw 或源历史的忠实导出，Adapter 不应直接把 `toModelMessages()` 结果当采集源。[model conversion][toolconversion]

usage 尤其不能直接照搬字段：OpenCode getUsage 把 inputTokens 减掉 cache read/write，把 outputTokens 减掉 reasoning，分别存 `tokens.input/output/reasoning/cache`；ATape 契约则 input 包含 cache、output 包含 reasoning。因此对于来源有效的 v1 step-finish 候选映射为 `inputTokens = input + cache.read + cache.write`、`outputTokens = output + reasoning`，cache 分量单独保留。[源归一化][usage] [ATape usage][atapeusage]

优先研究一 step-finish ID 对应一 sourceUsageId：processor 写每步 usage；assistant.cost 是累加、assistant.tokens 是当次覆盖，Session 汇总又由 step-finish 投影维护，三层不可相加，message 层也不能假定所有字段都是累计值。Fork 复制 step-finish 会重复出现原有 usage；“捕获对话的 usage”与“实际新支出”需明确口径。源 getUsage 本身把未知计数归零，ATape 无法从这些零区分真实零与源未上报。[processor][processorusage] [usage projector][projector] [fork][session]

## 6. Raw 与当前 ATape Interface 的缺口

ATape 的 Raw segment 有 sourceGeneration、sourceOffset，但 Canonical rawRef 仅有 sourceObjectId 和 fragment，没有 generation。若每次把整个可变 SQLite 快照作为同一个 Raw object 的新 generation，旧 Event 的引用是否仍能唯一定位其当时原文必须回答；仅在 cursor 里记 generation 不会补到引用里。[Raw Interface][ataperaw]

可行比较：

- **稳定事件日志对象**：将保留的 native durable event 逐条确定性序列化，引用 event ID/seq；在日志覆盖连续且源未重置时，旧版本与删除证据具有自然坐标。要界定 source-owned representation、兼容旧无事件基线、缺口检测及 rebase，不能认为所有 SQLite 已变成 append-only。
- **不可变基线/快照对象**：每个被固定快照或内容版本分配独立 sourceObjectId，fragment 指向 source Session/message/part；容易保持引用唯一，但会有大量重复字节、对象和发现成本。
- **同对象重写 generation**：Raw 原有传输支持，但引用语义与旧 Canonical 对应仍有问题；需验证 reader/服务端或补充通用模型，不能仅因“Raw 支持 generation”就选它。

Canonical Event 可以增加 revision 更新正文，却不能换 Session/Thread；Raw lossless retention、Canonical selected view、Search read model 必须独立。新增通用 Seam 应解决多种真实源的复杂性，不能把 OpenCode-specific revert 或 sqlite 行类型推入服务端或 Presentation。[ATape Interface][atapecontract] [归属与版本][atapeownership]

## 7. 后续 fixture 与决策边界

实施前的最小行为证据应覆盖：

1. 同一 part 从空 text 到最终完整 text、同毫秒多次更新，采集分页/重启后 Event ID 与 revision 一致。
2. 普通 task、嵌套 task、task_id 恢复、子会话先发现、父 Session 缺失、跨根 task_id、fork 复制带 child 引用的前缀。
3. fork 目标存在/不存在，复制消息时间早于新 Session.created，不能以时间修正历史或全局去重。
4. revert → unrevert；revert → 新 prompt cleanup；part 边界回退；被删尾部在 event 完整与有缺口两种状态。
5. compaction 有/无 retained tail；pruned output 的原文仍在；failed/aborted assistant 不能按模型过滤函数丢掉。
6. 原目录 → move → 首次采集；Created 缺失的 import/迁移；fork 复制的 assistant.cwd 指向原目录；Git remote 改变导致 project ID 重映射。
7. 工具错误携带 metadata.output、工具附件 URL/内嵌 data、未知 part、usage 包含 cache/reasoning；fork usage 双计数口径。
8. 同库 v1 与 v2-only Sessions；整 Session 删除；事件日志被 reset；同 cursor 重放时源已变。

仍需人参与的选择：

- 正式首版是否覆盖 v2 `/api/session` 历史；否则如何在第一方支持契约中声明并诊断。
- Active Path 与已捕获被回退历史的产品语义，以及是否先补充通用 Canonical 模型。
- parent 未解析时的首次发布策略、Detached Subagent Thread 的适用条件、跨根工具引用的降级表现。
- 无 immutable origin evidence 的旧库/import 会话是否拒绝归属、有限降级，还是扩大源证据收集；不得默认猜原始 CWD。
- Raw 快照/日志/对象策略，永久 source identity 与 revision、恢复窗口，usage 的历史成本口径。

本票解决“源提供什么证据、证据哪里会缺失”。它不替代上述用户选择，也不批准实现、合并、发布或部署。

补充固定证据：v1 upsert/delete 与 usage 调整见 [projector 260–327](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/projector.ts#L260-L327)；aggregate 日志删除见 [Event.remove](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/event.ts#L514-L522)；Raw segment generation 见 [AdapterRawSegment](https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/packages/domain/src/collector.ts#L233-L241)。

[release]: https://github.com/anomalyco/opencode/releases/tag/v1.18.30
[runtime]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/effect/app-runtime.ts#L65-L88
[tui]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/tui/src/component/prompt/index.tsx#L1092-L1112
[cli]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/cli/cmd/run.ts#L863-L870
[v2route]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/protocol/src/groups/session.ts#L129-L142
[serverroutes]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/server/routes/instance/httpapi/server.ts#L276-L306
[v2handler]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/server/src/handlers/session.ts#L19-L76
[session]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L667-L821
[task]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/tool/task.ts#L92-L211
[taskresult]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/tool/task.ts#L213-L310
[children]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L596-L624
[childrenannotation]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts#L143-L159
[message]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/schema/src/v1/session.ts#L332-L490
[contentschema]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/schema/src/v1/session.ts#L81-L257
[toolschema]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/schema/src/v1/session.ts#L259-L325
[moved]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/projector.ts#L242-L255
[moveoperation]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/control-plane/move-session.ts#L77-L111
[reset]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts#L1-L17
[eventmigration]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/migration/20260323234822_events.ts#L1-L25
[import]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/cli/cmd/import.ts#L179-L225
[revert]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/revert.ts#L38-L124
[promptcleanup]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/prompt.ts#L1052-L1058
[events]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/schema/src/v1/session.ts#L502-L641
[projector]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/projector.ts#L260-L327
[sql]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/sql.ts#L22-L138
[messagequery]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/message-v2.ts#L410-L599
[stream]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/processor.ts#L500-L545
[timestamps]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/schema.sql.ts#L1-L10
[projectmigration]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/project/project.ts#L159-L185
[eventsql]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/event/sql.ts#L1-L25
[remove]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L604-L627
[assistantcreate]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/prompt.ts#L1185-L1215
[project]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/project.ts#L65-L125
[compaction]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/compaction.ts#L392-L419
[filtercompacted]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/message-v2.ts#L523-L573
[prune]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/compaction.ts#L278-L315
[toolconversion]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/message-v2.ts#L290-L393
[v2revert]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/revert.ts#L60-L121
[v2revertprojector]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/projector.ts#L394-L449
[usage]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L338-L375
[processorusage]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/processor.ts#L452-L470
[atapeevent]: https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/packages/domain/src/collector.ts#L202-L255
[atapeownership]: https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/server/internal/canonical/store.go#L154-L240
[atapecontract]: https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/adapters/package-manifest.md#L63-L127
[atapeusage]: https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/packages/domain/src/collector.ts#L218-L231
[ataperaw]: https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/packages/domain/src/collector.ts#L60-L85
