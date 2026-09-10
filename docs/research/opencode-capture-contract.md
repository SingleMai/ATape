# OpenCode 身份、观察记录与待确认内容契约

状态：历史讨论提案与一次性实验。负责人已接受首版包含通用 Canonical 原子发布；最终选择以 [ADR-0059](https://github.com/SingleMai/ATape/blob/2989ab656f4720fa7cb0e0e02cb3037df4a63350/docs/architecture/adr/0059-opencode-publication-and-recovery.md) 和[详细契约](https://github.com/SingleMai/ATape/blob/2989ab656f4720fa7cb0e0e02cb3037df4a63350/docs/architecture/opencode-capture-publication.md) 为准。下文保留比较过程，不代表这些选择仍待批准；生产实现与原生验收仍未完成。

采集路线已接受：只读 SQLite、现有 Collector、最小有界待确认内容；见
[ADR-0058](https://github.com/SingleMai/ATape/blob/d945efb3e72ff69b1925e7de181cdf58b6f2422f/docs/architecture/adr/0058-opencode-sqlite-and-bounded-capture.md)。
本提案推进[身份映射、Raw 表示与可变历史同步契约](https://github.com/SingleMai/ATape/issues/113)，不重新征求同一项暂存方向批准。

## 核心建议

采用 Collector 所有的 **prepared delivery units**：Adapter 在一个有界、只读的来源观察中解析数据，Host 校验并脱敏，冻结实际投递内容与进度关系后再发送。进程重启先恢复已有 pending unit，不重新查询 OpenCode 来生成同一个请求。

一份 prepared unit 只证明其承诺内容的重放。若一页中有多条 observation，必须固定整页的未完成内容；若要承诺同一 Session target 跨多页一致，就需要额外的 target manifest 与封存/验证边界。不能把当前页暂存描述为整个 Session 的持久快照。

另一个独立边界是 **Canonical 原子发布**。固定待发送内容不使现有增量 ingest 获得撤下旧 Event 的能力。OpenCode revert 后继续对话需要按新的 Active Path 更新成员集合，不能简单省略旧 Event 后继续 append。

## 与现有模型一致的映射

| 来源情况 | 推荐契约 | 不允许的捷径 |
| --- | --- | --- |
| 可证明的原生根 Session | 原生根 ID 定义 Captured Session；每个原生 Session 对应一个 Captured Thread | 用目录、标题或 OpenCode project hash 作为会话身份 |
| 原生 parent 链完整 | 按链确定根归属与 Thread parent；发布前固定 | 先作为独立根上传，后来再搬入别的 Session |
| 已知 family，精确 parent 不明 | 沿用 Detached Subagent Thread，明确 degraded；不得事后默默改 parent | 依据 task 显示名或附近时间猜父级 |
| 连根 family 都无法证明 | 保持未发布并报告 attribution/关系缺口，继续处理其他来源 | 随便挂到当前 Project 的某个根 |
| task 调用指向 child | 先验证 child 属于同一 Captured Session，再设置 childSourceThreadId | 把 callID 当 child ID，或把跨根 task_id 复用当 ownership |
| fork | 独立 Captured Session，复制前缀留在新会话身份空间 | 跨 Session 根据同正文/callID 全局去重；收编被复制的旧 child 引用 |
| compaction | 同一 Thread 的 summary 和实际源记录；不另建 Session/Thread | 将发给模型的 cleared 占位内容当成源工具原文 |
| 源 Session 删除 | 保留已经捕获的 ATape 历史；未捕获内容无法补造 | 调用用户整 Session 删除 API 来模拟 source cleanup |

上述大部分是现有领域规则的应用，不是新的产品投票。基线见 [CONTEXT](https://github.com/SingleMai/ATape/blob/cac0467f72eb086de9d049cd3d242af19493e8ac/CONTEXT.md)；OpenCode 具体事实和固定源码见[源语义研究](https://github.com/SingleMai/ATape/blob/525ac1b75412149c9c7d0aaf082b66ce6f52e058/docs/research/opencode-semantics.md)。

### 身份、修订与排序

建议 Event key 由原生 Session ID、message ID、part ID 与固定投影槽位组合，置于 Host 的现有来源命名空间内。文本和思考按 part 投影；工具采用固定的调用/更新槽位，不以每次观察正文生成新 Event identity。来源 ID 冲突必须诊断，数据库路径变动不能自动重命名已有会话。

摘要用于判断内容是否变化，不直接当作大小有序的 revision；来源毫秒时间也不是严格单调 revision。持久账本应为确定的身份和内容版本原子保留单调修订，重试复用原保留值，A→B→A 仍能表达一次新的观察。若采用通用发布协议，target head 与这些源实体修订各司其职，不拿 target head 替代全部原生身份。

`occurredAt` 保留源时间；观察时间独立固定。原生 message 的排序与 part 排序使用已经核验的规则，时间相同要有稳定 tie-breaker。Fork 复制消息可能早于新 Session 创建时间，不得据此重写它们的发生时间。

Origin 优先来自与当前来源身份一致、可验证的创建证据，再交给 Host Git attribution。当前 directory、第一条 assistant.path 和配置的 Project.path 都不能冒充原始 CWD。缺证据的旧/导入会话先 unknown，不引入猜测或新的人工归属产品流程。

### 会话撤回对首版的影响

示例：OpenCode 原来为 `提问 → 旧回答 → 旧工具结果`，撤回后成为 `提问 → 新回答`。
旧 ingest 接收后者并不会撤下已存的旧回答/工具结果，可能形成错误的混合时间线。整 Session DELETE 又会建立永久 tombstone，不能用于一次 revert。

推荐完整方向：以通用 target membership / atomic publication 实现新视图，准备期间保留上次成功视图；激活后旧成员退出默认时间线及 Search eligibility，新 Search 索引允许异步完成。Raw 已保存的旧观察继续保留。采用 [ADR-0025](https://github.com/SingleMai/ATape/blob/cac0467f72eb086de9d049cd3d242af19493e8ac/docs/architecture/adr/0025-atomic-canonical-publication.md) 的领域方向，需要真正落地相应 Interface、持久化与恢复，不能假定该 ADR 已实现。

有限首版的实质替代：检测到无法安全表达的路径撤回时暂停该 Session 更新，明确上次成功视图已经过时，普通会话继续；这缩小交付范围。不能通过空消息、全新 Session 或伪 subagent 表示历史分支。负责人已明确选择前述完整方向：首版同时包含通用原子发布；暂停撤回会话的有限首版未选中。

## Raw：不可变的来源状态观察

建议保存 ATape **实际观察到**的完整行状态，名称明确为 observation log，不称 OpenCode 原生 event log。轮询之间被覆盖的中间值无法保证采到；删除也只能在完整成功的来源范围核验后记录 `absence-observed`，一次分页未看到或读取失败不能推断删除。

一条记录可包含固定的 format、observation ID、observedAt、table/row key、来源关系与时间列、operation，以及保留未知字段的原始 `data` JSON。外壳是 ATape 的编码；如果保留数据库 data 的原始合法 JSON 文本，应直接按固定规范嵌入，不能先 parse/stringify 后声称与来源字节相同。Raw 的保真受已声明脱敏变换约束。

同一 part A→B 时追加 B 的完整行观察，不重复整份 Session。相邻扫描无变化不追加；再次回到 A 要保留新的观察次序。Canonical 与 Raw 的判变分别记录，Raw 关闭时不能为将来归档额外保存完整源材料。

### 对象与引用

当前 rawRef 只有 objectId/fragment，没有 generation。因此建议每个有界、不可变的观察分段对应一个 object，永久只使用一个 generation。分段 ID 在远端写入前持久保留；一段可装多条完整记录，避免每 token 一个 object。

消息新版本创建新的观察分段；新的 Canonical revision 可指向新 object，旧已确认 Raw 不改写。fragment 使用稳定记录 identity，不能混用脱敏前 source offset 与脱敏后 server offset。精确记录跳转仍需 reader 明确支持，当前字符串 fragment 不是已实现的跳转能力。

尚需在最终 Interface 中闭合 **Raw 关闭后重新开启的引用**：必须保持 ADR-0056 所要求的 Canonical identity/content 稳定，不能为了补链偷偷增加虚假的语义修订；也不能把新抓到的不同原文绑定到旧版本引用。不能证明旧原文对应关系时，该旧版本的 Raw 保持 unavailable，新观察可独立归档。这是引用/可用性契约，不能靠 sourceGeneration 字符串解决。

### 巨型值与元数据规模

当前 Raw 是整串脱敏、完整记录边界，单 segment 和 observation Raw 上限为 16 MiB；Canonical observation 上限为 3 MiB。SQL LIMIT 限行数不限制一个大 part。随意切 JSON string、增加换行或 Base64 包装都不能绕过这一真实边界。

首个增量需明确选择已声明的 limit/partial，或落地 ADR-0026 的 byte-frame 与跨 frame masking 能力。前者不得静默截断 Raw，也不得把 Canonical 已处理误算成 Raw 已确认。这里没有宣布任意大 part 已得到支持。

每行摘要/修订、完成的观察和 Raw receipts 会随历史增长，不能装进 1 MiB cursor，也不能每次全量复制 current rawObjects 数组。新 capability 需要可分页的持久 metadata Interface，仅把当前 pending 与必要 active offsets 送入处理；旧 Codex/Claude 路径无需在首增量同时迁移。

## 两种暂存 Interface 形状

### A. Collector 固定最终投递单元（推荐）

概念 Interface：`prepare(scope, expectedCheckpoint, units, nextCursor)`、`load(scope)`、`recordReceipt(id, receipt)`、`complete(id, expectedCheckpoint)`。这是职责草图，尚非要逐个公开的最终 API。

Host 先完成校验、脱敏及 wire preparation，保存 Canonical 实际请求和 Raw 实际 bytes/packing metadata，再原子绑定 pending manifest 与输入 checkpoint。恢复时先读取 pending，跳过重新 collect 旧 cursor；远端结果不确定时重发相同 unit，确认后再提交进度与回收。

仅保存 redacted AdapterObservation 还不够：当前 HTTP Adapter 后续才做 ACP→wire projection 和 batch hash，Host/Adapter 升级可能改变它。推荐存最终 wire unit，或显式冻结并保留完整转换实现。冻结后的秘密处理结果不应在重启时用新的环境规则再处理一遍；政策变化需显式拒绝/终止，不暗改旧请求。

Raw 无需为 offset 保留未脱敏原文：prepare 时记录 sourceLength/sourceEnd 等元数据，正文只保存固定的脱敏结果。文件权限、实例/用户/Project/installation 隔离、锁与 owner fencing 仍须由生产持久化 Adapter 保证。

### B. Adapter 固定来源材料，Host 管生命周期

概念 Interface：`prepareCapture(request, hostStagingSink) → sealedCaptureRef`；后续 collect 分页读取 captureRef，Host 根据真实确认回收。

它更直接固定跨页源视图，但引入 provider-specific 持久格式和 Adapter 升级读取能力；Raw 关闭时不能统一保存全部 message/part 原文。固定源材料也未固定重启后的 projection/redaction/wire encoding，仍需版本冻结或再次保存 wire unit。

比较后更倾向 A：让 Adapter 隐藏源格式，Collector 隐藏跨网络恢复。需要多页 target 时，在 A 上明确 capture manifest、所有承诺页与封存/激活条件，而不是新增一个由 Adapter 自治的内容队列。

## 建议的状态与原子边界

| 状态/动作 | 可见行为与必须成立的条件 |
| --- | --- |
| Preparing | 只在受控来源视图中准备；未封存材料不能以对应身份产生内容投递 |
| Prepared | 输入 checkpoint、所有 unit identities、正文与下一进度关系可恢复；来源事务可关闭 |
| Sending / result unknown | 保存原 unit；超时/进程死不意味着远端失败，不重新读取源替换正文 |
| Canonical acknowledged | 独立记录真实确认；Raw 允许时可继续待处理 |
| Raw acknowledged | 保存真实 source/server ranges 与 packing；没有确认的范围不前移 |
| Raw canceled by policy | 停止未完成归档并回收其待发送正文；保留真实 receipts，取消不是 ACK |
| Completed | 所有相关义务已完成或按明确政策终止；原子更新进度/ledger 与可回收标记 |
| Capacity / damaged / source unknown | 对受影响来源显式失败或背压；保留已有成功视图，不伪装完成 |

本地 payload 与 metadata 同存 SQLite 可以把准备与确认放入同一事务，但仍需控制大 BLOB 的读取量、WAL 增长与清理。若正文存文件，应采用私有 staging、内容校验、可靠安装、manifest 事务和可恢复回收；文件 fsync/rename 与数据库提交不是一个事务，必须验证孤儿与 dangling reference。具体存储选择与配额值要结合目标规模实测，不能从合成小实验直接推出生产值。

在涉及整 Session 原子视图时，还要区分 unit 确认与 target 激活：未激活 target 的已上传部分不代表来源覆盖完成。一个未封存 capture 在重启后丢失 SQLite read snapshot 时，不能将新源剩余页接到旧视图后面；应从仍可验证的固定材料恢复，或明确废弃该 target attempt 并重新捕获。长事务不得跨网络等待维持“快照”。

## 已完成的可复现证据

[交互演示](../../packages/application/prototypes/opencode-recovery-prototype.html)是单文件 HTML，双击即可运行。它显示来源、本机进度/待确认内容、远端已接受状态，并提供正常完成、失败后改写、确认前重启、Raw 政策取消和容量背压五条 walkthrough。浏览器 DOM 操作已走通这些路径；仅摘要对照在 A 被改为 B 后保持未完成，不会假提交。

[SQLite 进程崩溃实验](../../packages/application/prototypes/opencode-recovery-probe.py)只用自动清理的 scratch DB 与合成 part。运行命令：

```sh
python3 packages/application/prototypes/opencode-recovery-probe.py
```

实际运行结果：

1. pending prepare 事务提交前 SIGKILL：恢复后无 pending，无远端效果。
2. 远端 Canonical 提交后、本机记录确认前 SIGKILL；来源 A 改为 B：恢复重传 A，远端只有一个 Canonical unit。
3. 远端 Raw 提交后、本机记录确认前 SIGKILL：恢复同一 Raw unit，无重复结果。
4. 本地推进 cursor 与删除 pending 的事务中 SIGKILL：两项一起回滚；再次完成后 cursor=1、pending 为空。
5. Raw 全程关闭：pending 仅含最小 Canonical 投影；Raw-only sentinel 未进入 Canonical 暂存；没有 Raw 请求或 Raw receipt。

这个实验使用真实 SQLite WAL、FULL synchronous 和子进程 SIGKILL，但“remote”也是 scratch SQLite，并非 HTTP Server。脱敏只替换一个合成 literal，不是生产 SecretRedactor。它未调用生产 `collect` Interface、未运行原生 OpenCode、未验证断电/Windows/Node SQLite/多进程 writer fencing，也没有证明跨页 Session 一致性。它提供状态与持久化方向的有限证据，不关闭[正式有界采集原型验收](https://github.com/SingleMai/ATape/issues/115)。

## 原子发布的补充证据

[原子发布交互演示](../../packages/application/prototypes/opencode-publication-prototype.html)通过浏览器 DOM 控件走通五条场景：正常切换、不完整时失败、确认前重启、旧确认不能回滚、并发更新冲突。验证切换前保留 MySQL，切换后旧结果退出搜索，新索引随后加入；后来更新为 SQLite 后，旧确认重试保持 SQLite，旧捕获的 Raw 仍可完成归档。此 HTML 状态在内存中，重启按钮只是语义演示。

[原子发布进程崩溃实验](../../packages/application/prototypes/opencode-publication-probe.py)独立使用 scratch SQLite WAL/FULL 与真实子进程 SIGKILL；已运行，全部模型断言通过：

- staging、seal 与 validation 期间保留 A/B/C；缺失 part、篡改重放、未校验 target 不得激活。
- 激活事务提交前杀进程：head、receipt、Search outbox 一起回滚。
- 提交后确认前杀进程：A/D 已可见，重试得到原 receipt；B/C 立即退出搜索，D 异步加入。
- A/E 后重放 A/D 的旧激活：返回旧 receipt，head 保持 A/E。
- stale fence/base 被拒绝；同 Event 的旧索引 descriptor 不可命中新版本；历史 Raw A/B/C/D 保留。

运行命令：

```sh
python3 packages/application/prototypes/opencode-publication-probe.py
```

这仍非 PostgreSQL、真实 HTTP 或 OpenCode 接口验证；不覆盖断电、权限、租约与 receipt 过期、配额、GC、patch 或完整 Search worker。两个 Python 模型与两个 HTML 都只保留在一次性原型分支，不进入生产实现提交。

## 下一步验收

身份与 Raw 映射、完整 target 封存、SQLite journal、原子发布和 Raw policy 恢复的工程选择已记录在最终契约。Raw-off 版本保持 unavailable，重开仅新增可用源行的独立观察；不存在等待负责人再次批准的同一项范围问题。

准确来源版本、legacy/v2-only/巨型 part、平台与数值配额仍需原生 fixture 和压力证据定清楚。[正式有界采集原型验收](https://github.com/SingleMai/ATape/issues/115)继续验证真实来源、public Interface、HTTP/PostgreSQL、并发和重启；不能凭这些模型直接关闭。Origin/parent 无证据时沿用诊断与隔离规则，不扩大成人工归属产品。

## 代码证据定位

- ATape 基线 `cac0467`：[collect / redact / send / checkpoint](https://github.com/SingleMai/ATape/blob/cac0467f72eb086de9d049cd3d242af19493e8ac/packages/application/src/collector.ts#L375-L457)、[Raw sourceEnd / receipts](https://github.com/SingleMai/ATape/blob/cac0467f72eb086de9d049cd3d242af19493e8ac/packages/application/src/collector.ts#L525-L606)。
- [Adapter/Checkpoint shapes](https://github.com/SingleMai/ATape/blob/cac0467f72eb086de9d049cd3d242af19493e8ac/packages/domain/src/collector.ts#L276-L371)、[actual wire preparation](https://github.com/SingleMai/ATape/blob/cac0467f72eb086de9d049cd3d242af19493e8ac/apps/cli/src/runtime/collectorLayers.ts#L465-L509)、[runtime redactor](https://github.com/SingleMai/ATape/blob/cac0467f72eb086de9d049cd3d242af19493e8ac/apps/cli/src/runtime/collectorLayers.ts#L60-L85)。
- [Postgres Canonical application](https://github.com/SingleMai/ATape/blob/cac0467f72eb086de9d049cd3d242af19493e8ac/server/internal/adapters/postgres/store.go#L117-L180)、[Raw capture policy](https://github.com/SingleMai/ATape/blob/cac0467f72eb086de9d049cd3d242af19493e8ac/docs/architecture/adr/0056-configurable-raw-capture.md)。
- OpenCode `3104c1428ec91f809e5ab86631300de41eb6952e`：[fork](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L691-L732)、[task](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/tool/task.ts#L136-L195)、[revert / cleanup](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/revert.ts#L38-L124)、[Moved](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/projector.ts#L242-L255)。
