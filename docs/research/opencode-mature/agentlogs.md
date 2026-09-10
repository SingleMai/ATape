# AgentLogs 的 OpenCode 采集架构与修复记录

## 选型判断

AgentLogs 是有公开发行包、团队服务器、自动同步和真实兼容修复的产品，产品目标比单机历史 viewer 更接近 ATape。
它最值得借鉴的选择是：**让 plugin 只负责触发，复用统一 CLI 的转换和上传 Module，并用 `opencode export` 隔离 JSON→SQLite 的来源变化**。
这最后一点有维护者明确提交说明，不是根据代码猜测动机。[^1]

但它不适合作为“已证明持久归档可靠”的整套范本：OpenCode 路线没有可重放的本地 payload 队列，源更新以全会话覆盖上传处理，常规上传跳过子会话，服务端缺少来源 revision 顺序守卫。
还有一个会导致 idle 事件风暴、CPU 占用和 npm 锁错误的修复，截至 2026-09-10 仍是开放 PR，不能计入发布能力。[^2][^3][^4]

许可证也必须按版本区分：当前源码为 `FSL-1.1-Apache-2.0`，包含限制用途的条款和两年后 Apache 2.0 的未来许可；它不是当前即可一概视为 MIT/Apache 的代码来源。
npm 上旧 `@agentlogs/opencode@0.0.5` 元数据仍标 MIT，但默认会调用更新的 `agentlogs@latest` CLI。旧 plugin 的许可标签不能覆盖最新 CLI/服务器。[^5][^6]

## 核验对象和交付成熟度

证据截点为 2026-09-10；主仓库为 `agentlogs/agentlogs`，固定主线 commit 为 `ea49614eb01816872a88a3ac70aaae066de6e0ce`。
该仓库的产品文档提供 OpenCode plugin、CLI 手动上传、认证和团队服务器；源码同时有 converter fixture tests 与跨 CLI/服务器的通用上传测试。[^7][^8]

| 对象 | 可核验状态 | 对成熟度的含义 |
| --- | --- | --- |
| 主线 | `ea49614…`，2026-09-09 提交 | 当前开发状态，不能自动当作 npm 已交付 |
| OpenCode plugin | npm latest `0.0.5`，2026-02-10；gitHead `a98d94acbf1f5cbfe2d92d99b3c375943e3bbdfa` | 有真实发行；plugin source 到本次主线未改变 |
| CLI | npm latest `agentlogs@0.1.7`；gitHead `34d647cfb5e6726d54b5d9641926c938993e6b6d` | plugin 默认动态调用它，不锁定伴随版本 |
| Server | 最新 GitHub release `server-v0.1.3`，2026-04-18；同 `34d647c…` | 有 Docker/发行资产，但晚于此 tag 的修复不能计入 |
| idle 风暴修复 | PR「opencode plugin: throttle session.idle, serialize hooks, cache CLI resolution」，OPEN | 有改法和单测，尚未合并/发行 |

发行事实来自 npm registry、GitHub tag/release；不是下载量、stars 或“支持 OpenCode”宣传的替代判断。[^6][^9][^10]
当前主线的多 Git root 权限修复和 Edit diff UI 修复均晚于上述 CLI/Server tag。
因此下文每条修复分别标注“已发行”“已合并但不在最新发行 tag”或“开放 PR”。[^11][^12]

## 实际运行链：事件是提示，export 才是来源

```text
OpenCode plugin
  ├─ session.idle ────────────────┐
  └─ bash git commit before/after ┤
                                 v
agentlogs opencode hook  <── JSON stdin
  → opencode export <session-id>
  → 临时 JSON 文件 → 完整解析 → UnifiedTranscript
  → 仓库 capture 检查 → 敏感文件/秘密脱敏 → SHA-256
  → POST /api/ingest → transcript ID 响应
```

plugin 的 context 只声明 directory/worktree/project，当前实现没有读取 SDK session API，也没有直接开 OpenCode DB。
它把事件包装成 CLI stdin payload；普通事件只处理 `session.idle`，并 fire-and-forget 调用 hook。
before hook 仅拦截 bash 中的 git commit，等待 CLI 返回修改后的 args；after hook 跟踪 commit 结果。[^2]

CLI 的 `handleSessionIdle` 调用 full upload；before commit 可以先传 partial transcript，保证链接尽早可访问。
二者的数据都通过 `opencode export <sessionId>` 获取，区别不是分页或增量字节协议，只是何时导出以及调用方意图。[^3]

维护者在 2026-02-05 的「Use CLI commands instead of reading storage files directly」明确说，这是为 OpenCode SQLite 迁移作准备：不再直接读 `.local/share/opencode` 的 JSON，改用 export 和 session list。
这说明项目选择把**存储格式兼容责任**移交 provider CLI；没有找到同一材料明确声称“数据库轮询永远不可用”或完整比较过 SDK、SQLite、journal 三方案。[^1]

架构推论：export 是现实可用的外部 Seam，可以减少 ATape 自有 SQL schema 适配；但代价转移到可执行文件版本、命令启动成本、输出大小、超时与命令本身的行为。
AgentLogs 不自行控制 OpenCode WAL、只读连接或一致性事务，因此不能仅凭“不直接写数据库”宣称 export 无副作用或具备固定跨页快照。

## 本地持久性：ID 缓存，不是上传 spool

当前 hook 和专用手动上传把 export stdout 直接写入 `${tmpdir}/agentlogs-oc-${pid}-${Date.now()}.json`。
子进程结束后，读取整个文件为字符串，删除临时文件，再 JSON.parse/转换/上传。
没有“上传确认后才删除”的 durable payload 生命周期；进程被杀留下的文件也没有启动扫描恢复逻辑。[^13]

本地 `~/.config/agentlogs/local.db` 是 SQLite KV，保存 `transcript.<provider-session>.id` 的 CUID2 和 `call.<callId>.transcriptId` 等 commit 关联。
`getOrCreateTranscriptId` 是查询后生成并保存；它保存身份，不保存导出内容、来源 revision、上传状态或远端 Raw offset。[^14]

HTTP 上传默认 10 秒 timeout，错误返回 success=false；多环境上传逐环境执行并记录结果。
这条 OpenCode 路径没有持久队列、指数退避调度、receipt 后 checkpoint 提交或崩溃后重放事务。下一次 idle 或手动上传可以重新 export **当时的最新状态**，但不能保证重发上一次完全相同的 payload。[^15][^16]

上传失败通常不会阻断 OpenCode 的会话体验；另一方面，部分导出/上传失败在 hook 内记录后返回，plugin 又吞掉进程失败为 `modified:false`。
因此“自动同步已安装”不等于“每次变化均已确认远端持久化”，也不能从宿主会话继续运行反推采集健康。[^2][^3]

## 服务端确认、重复上传与源端更新

客户端对脱敏后的 UnifiedTranscript 计算 SHA-256，发送 multipart 的 id/hash/JSON；服务端验证 hash、认证和统一 schema。
已有 user+transcript 且 hash 相同则返回 `unchanged`；新 payload 则 upsert 同一个 user+transcript 记录。
这里的去重单位是整个会话投影，不是 ATape 的 Canonical Event identity/revision。[^16][^17]

客户端丢失 local.db 后若送来新的 client ID，服务器可以按 user+provider transcript 找到旧 ID，并返回 `exists` 供客户端缓存。
该分支在处理新 payload 之前返回，意味着“找回身份”响应本身不证明这次最新内容已写入；通常还需后续上传使用返回的 ID。[^17]

服务器把统一 JSON 写到固定的 repo/session object key，再 upsert metadata；未看到来源版本比较、条件覆盖或保留所有历史版本的表。
推论：两个不同快照并发到达时，老快照晚到可能覆盖新快照；blob 写入和 DB metadata 也不是一个跨存储原子事务。
这些是代码路径推导出的未解决风险，不是本次复现的线上事故。[^18]

2026-03-28 的「Upload: Remove raw transcript uploads」显式删除 raw 上传字段和服务器保存逻辑。
所以当前方案是统一投影存储；不能把 export 临时文件称为“长期 Raw archive”，也不能把统一 JSON 的 hash 当作 provider 原始字节保真证明。[^19]

通用 e2e 确实测试同 transcript 重传保留 ID、local.db 缺失返回现有 ID，但 fixture 是 Claude Code。
这能证明公共上传 Interface 有相应行为测试，不能扩大为“OpenCode export 崩溃、乱序修订、Raw 重放均被 e2e 验证”。[^8]

## 历史覆盖、拓扑和可变语义

历史补录有两个真实入口：`agentlogs upload --source opencode` 的交互选择器，以及 `agentlogs opencode upload <sessionId>`。
discovery 调用 `opencode session list --format json -n N`，按更新时间排序、限制结果，并过滤 parentId。
失败和未安装 OpenCode 都返回空列表；没有全历史分页 checkpoint 或守护扫描对账。文档最后仍写直接读 storage 路径，与当前实现已经不一致。[^7][^20]

full hook upload 和专用手动上传明确跳过 `info.parentID` 子会话；partial-before-commit 路径没有同样的显式 guard。
因此既不能声称完整子树支持，也不宜简单说“所有入口绝不上传 child”：覆盖由入口决定。[^3][^13]

converter 把 text、reasoning、tool 映射为 user/agent/thinking/tool-call；跳过 step-start/finish、TodoRead，其他未匹配 part 没有通用 Raw 保底。
Task 的 subagent_type 只变成工具显示名，没有子会话链接或 child transcript 遍历。
没有单独处理 fork copied-prefix、revert 撤回、compaction 保留与删除的档案语义；当前行为取决于 export 当时包含什么，再整体覆盖。[^21]

文本 message ID 使用 msgInfo.id，tool 使用 callID，thinking 没有等价的稳定 ID；同一 message 多个 text parts 会重复使用 message ID。
这适合数组型 transcript 呈现，但不能原样映射到 ATape 要求唯一 sourceEventId、稳定 eventIndex 与 revision 的 Canonical Interface。[^21]

当前测试 fixture 的 snapshot 明示 clientVersion `1.1.13`，另有 all-tools fixture；本次未找到 OpenCode `1.18.x` 新数据路径或大型可变历史恢复的专门测试。
这不是断言最新 OpenCode 一定失败，而是公开测试能支撑的版本范围有限。[^22]

## 隐私和仓库归属

公共 upload Module 在发送前重写本地文件链接、遮蔽敏感文件内容，再做 deep secret redaction；目标仓库由 capture 设置控制，并有 private/team/public visibility。
OpenCode hook 选 directory 时优先事件传入 cwd，其次 export.info.directory；专用手动上传优先 export 的 directory，再 fallback 当前目录。[^23][^3][^13]

重要差别：主线新增加的“录制过程中所有目录都必须被允许”是 JSONL 解析路径的行为。
OpenCode 已转换对象走 `uploadUnifiedToAllEnvs`，当前仍只把一个 cwd 交给 resolveUploadTarget。
因此不能把 Claude/Codex 多 root 集成测试宣传为已覆盖 OpenCode 会话里所有被访问目录；这仍是 ATape 需要自己界定的隐私边界。[^16][^24]

临时 export 包含未脱敏来源，`openSync(tmpFile,"w")` 没有在此处显式设置私有权限或 exclusive-create；上传前删除也不是安全擦除。
这应作为 snapshot 设计的文件权限与生命周期输入，不能因为网络 payload 已脱敏就忽略本地临时原文。[^13]

## 修复链及证据强度

### A. 假定格式与真实 export 不符：修复和回归 fixture，已发行

2026-01-12 的「Rewrite converter for real export format and add client API」明确把原先编造的 fixtures 换成真实 `crud.json` export，并重写 converter 处理实际 `info/messages` 结构。
同一 commit 删除原来的 compaction/reasoning 等假 fixture，新增真实 fixture 和 converter inline snapshot。
这是“来源假设被真实数据否定 → 改实现 → 改回归证据”的完整源码链；没有独立公开用户事故票，不能美化成长期现场验证。[^25]

紧接着「Fix OpenCode model identifier and git context extraction」修 provider/model 拼接和 message path 提取，测试加入 mock git context 和新的 snapshot。
这条链证明具体字段修正被测试锁定；mock git context 不证明真实 worktree/remote 检测全部成立。两项修复都早于已发行 plugin/CLI。[^26]

### B. export 约 256 KB 截断：已合并发行，但回归测试链不完整

PR「fix(cli): improve opencode upload error messages and fix session truncation bug」报告 export 截断，改为异步 spawn、stdout 文件描述符重定向；合并 commit 为 `1ba6758185da4f3528d1569075a83dde84473066`，包含在 CLI 0.1.7 的发行历史里。
代码还引用 Bun 上游问题，但本报告只据 AgentLogs PR 和修改判断其采取的修复。该 PR 只修改两份实现，没有新增对应测试。[^27]

公开 review 指出新实现丢失 spawn-error 处理与原有 30 秒 timeout；当前主线这两条 export 路径仍等待 close、没有 timeout/kill 和 error listener。
交互选择器的第三份 export Implementation 仍保留 spawnSync + piped stdout，未被同一修复统一。
因此这是一条重要的已交付故障修复经验，也暴露重复实现造成修复覆盖不完整；不能记为完整恢复保证。[^13][^28][^29]

### C. idle 风暴和 npm 锁错误：报告、修复、单测齐备，但尚未交付

开放 PR「opencode plugin: throttle session.idle, serialize hooks, cache CLI resolution」报告毫秒级 idle burst 每次启动 npx，造成大量并发 npm 进程、CPU 满载和 ECOMPROMISED。
候选 commit `a0e71dfd2709d8a6b1fa6ce3ea9aba3cf4e2739a` 增加每 session 60 秒节流、in-flight guard、串行 hook queue，优先解析已安装 CLI。
新增单测覆盖首发/间隔/in-flight、跨 session、串行顺序、失败后队列存活和 CLI resolution。[^4][^30]

截至证据截点该 PR 未合并，主线仍每事件解析/启动 npx。
即使未来合并，这个 in-memory queue 也不是 durable outbox；节流不替代崩溃补录、最后一次变化最终送达和失败 receipt。
作者给出的速度改善属于 PR 的本地声明，未据此推导 ATape 的性能数字。

### D. 多仓库内容可能随允许仓库上传：主线修复有测试，OpenCode 覆盖有限

「allowlist all touched roots and attribute by dominant git root」说明此前归属选择可让未允许仓库内容随允许仓库带出；修复要求每个 touched root 获准，并按聚合 root 权重选 attribution。
同一 commit 增加 mixed-root 与权重测试；后续「Enforce capture permissions across recorded directories」增加经真实 command entry 的集成测试。
这是第二类有明确问题描述、实现修复和测试的完整证据链，但晚于最新 CLI 发行，集成测试矩阵只列 Claude/Codex。[^11][^24][^31]

OpenCode 只能继承公共单 cwd 目标解析与脱敏行为，不能继承未实现的“所有 recorded roots”输入。
ATape 可以借鉴权限判断必须覆盖来源证据，而不是优先相信 hook cwd；不能把这套权重归属规则直接替换自己的原始身份与 Host attribution。[^16]

### E. Edit 工具 diff 缺失：真实 issue 与 UI 修复，未见新增自动测试

Issue「opencode edit tool usage not visualized 100%」提供缺失 diff 的截图；PR「server Render Edit tool output diff with DiffViewer instead of raw JSON」明确关联修复并给出对比截图，2026-06-09 合并。
PR 仅修改服务器页面，没有新增自动测试，且晚于 Server 0.1.3 tag。
它证明存在使用者反馈驱动的维护；不应计为发布版已修复或采集层完整性的证据。[^12]

## 对 ATape 的可执行借鉴

1. **复用责任划分。** 若采用 plugin，保持其作为薄触发 Adapter；capture/转换/脱敏/上传仍由 ATape 现有深 Module 负责。
2. **把 export 当候选 Interface。** AgentLogs 已明确用它规避存储迁移；ATape 仍需验证目标版本、有限资源读、失败分类和 Raw 定义。
3. **避免复制其三份 export reader。** 单一受测 Implementation 管理 spawn error、超时、取消、临时文件权限、容量与清理。
4. **让事件成为加速提示。** 用持久 checkpoint/发现补录保证不依赖最后一次 idle；不要每事件 npx，也不要把内存队列当可靠交付。
5. **保留 ATape 较强契约。** 继续使用 source revision/确定性分页/Raw receipt；全 transcript hash upsert 无法代替这些约束。
6. **建立真实版本 fixture。** 先抓受控 native export，覆盖当前 provider 路径、子会话、compaction/revert、并发更改和大输出，再宣布支持。

AgentLogs 支持“生产产品确实采用 plugin + CLI export”的选型论据，**不支持“该组合自动获得完整历史、Raw 保真和故障重放”**。
其最有价值的成熟度证据是可追溯的格式修正和真实故障；最明显的差距是公开发行滞后、恢复机制有限、OpenCode 专项测试不够深入。

## 来源

以下源码链接固定 commit；npm registry、issue/PR 状态取 2026-09-10 的可见结果。主线源码作者/发布者均为 AgentLogs 项目；历史提交保留各自日期。

[^1]: AgentLogs，2026-02-05，[Use CLI commands instead of reading storage files directly](https://github.com/agentlogs/agentlogs/commit/35fc9d2eff34236e04a03d5cdf066072ae1ee728)，维护者明确说明 SQLite 迁移动机。
[^2]: AgentLogs，主线，[plugin 触发、进程启动、before/after hooks](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/opencode/src/index.ts#L64-L245)。
[^3]: AgentLogs，主线，[hook 的 partial/full 导出与子会话过滤](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/commands/opencode/hook.ts#L275-L427)。
[^4]: AgentLogs，2026-09-09，[opencode plugin: throttle session.idle, serialize hooks, cache CLI resolution](https://github.com/agentlogs/agentlogs/pull/45)，公开故障报告与未合并修复。
[^5]: AgentLogs，[当前 LICENSE](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/LICENSE#L20-L52)、[未来许可条款](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/LICENSE#L87-L105)、[Legal: switch to FSL-1.1-Apache-2.0](https://github.com/agentlogs/agentlogs/commit/f459be2d467ad1551be9e60a740887947677925e)。
[^6]: npm registry，[plugin 包版本和发行时间](https://registry.npmjs.org/@agentlogs%2fopencode)、[plugin 0.0.5 元数据](https://registry.npmjs.org/@agentlogs%2fopencode/0.0.5)；AgentLogs，[对应源码 tag](https://github.com/agentlogs/agentlogs/tree/a98d94acbf1f5cbfe2d92d99b3c375943e3bbdfa)。
[^7]: AgentLogs，[OpenCode 集成指南](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/docs/agents/opencode.mdx#L39-L83)。
[^8]: AgentLogs，[通用上传 ID 重用与 local.db 丢失 e2e](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/e2e/tests/authenticated/upload.e2e.ts#L200-L261)，fixture 是 Claude Code。
[^9]: npm registry，[agentlogs 0.1.7 元数据](https://registry.npmjs.org/agentlogs/0.1.7)；GitHub，[CLI 0.1.7 release](https://github.com/agentlogs/agentlogs/releases/tag/cli-v0.1.7)。
[^10]: AgentLogs，2026-04-18，[Server 0.1.3 release](https://github.com/agentlogs/agentlogs/releases/tag/server-v0.1.3)。
[^11]: AgentLogs，[allowlist all touched roots and attribute by dominant git root](https://github.com/agentlogs/agentlogs/commit/cc925798faf283358850c7486de60f270fa37ec9)、[Enforce capture permissions across recorded directories](https://github.com/agentlogs/agentlogs/commit/f50fe221af5b16e9839d7162b1c2752dd09cc8a0)，主线已合并。
[^12]: AgentLogs，[opencode edit tool usage not visualized 100%](https://github.com/agentlogs/agentlogs/issues/36)、[server Render Edit tool output diff with DiffViewer instead of raw JSON](https://github.com/agentlogs/agentlogs/pull/39)、[修复 commit](https://github.com/agentlogs/agentlogs/commit/466af1b68c50b53752cda7584c383cccf41d94b6)。
[^13]: AgentLogs，[专用 OpenCode export、临时文件与手动上传](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/commands/opencode/upload.ts#L16-L147)。
[^14]: AgentLogs，[local.db KV 和 session/call ID 映射](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/local-store.ts#L6-L181)。
[^15]: AgentLogs，[HTTP timeout 与错误返回](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/shared/src/upload.ts#L63-L147)。
[^16]: AgentLogs，[统一上传的单 cwd 检查、脱敏、hash 与多环境处理](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/lib/perform-upload.ts#L536-L624)。
[^17]: AgentLogs，[ingest hash 校验、身份恢复和 unchanged](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/server/src/routes/api/ingest.ts#L67-L214)。
[^18]: AgentLogs，[统一 JSON 覆盖与 DB upsert/ack](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/server/src/routes/api/ingest.ts#L331-L454)。
[^19]: AgentLogs，2026-03-28，[Upload: Remove raw transcript uploads](https://github.com/agentlogs/agentlogs/commit/144f9a6624271301a89bd98d68de8979a0a89197)。
[^20]: AgentLogs，[OpenCode discovery 命令、过滤、上限与错误处理](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/shared/src/discovery.ts#L196-L289)。
[^21]: AgentLogs，[OpenCode converter 的消息、reasoning、tool 映射](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/shared/src/opencode.ts#L228-L424)。
[^22]: AgentLogs，[all-tools 与 crud 回归 fixture](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/shared/src/opencode.test.ts#L48-L112)。
[^23]: AgentLogs，[上传前链接重写与两级脱敏](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/lib/perform-upload.ts#L47-L69)。
[^24]: AgentLogs，[真实 command entry 权限集成测试及 provider 范围](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/lib/perform-upload.integration.test.ts#L153-L208)。
[^25]: AgentLogs，2026-01-12，[Rewrite converter for real export format and add client API](https://github.com/agentlogs/agentlogs/commit/28e95b169fdbe0ca41d681697e21e39455332b5e)、[当次真实 fixture snapshot test](https://github.com/agentlogs/agentlogs/blob/28e95b169fdbe0ca41d681697e21e39455332b5e/packages/shared/src/opencode.test.ts#L41-L65)。
[^26]: AgentLogs，2026-01-12，[Fix OpenCode model identifier and git context extraction](https://github.com/agentlogs/agentlogs/commit/6681b8110dd8e30839a040c2fc9e3d92caa21bc9)、[当次测试](https://github.com/agentlogs/agentlogs/blob/6681b8110dd8e30839a040c2fc9e3d92caa21bc9/packages/shared/src/opencode.test.ts#L25-L65)。
[^27]: AgentLogs，2026-04-18，[fix(cli): improve opencode upload error messages and fix session truncation bug](https://github.com/agentlogs/agentlogs/pull/27)、[合并 commit](https://github.com/agentlogs/agentlogs/commit/1ba6758185da4f3528d1569075a83dde84473066)。
[^28]: AgentLogs PR review，[spawn error 指出](https://github.com/agentlogs/agentlogs/pull/27#discussion_r3105792893)、[timeout 指出](https://github.com/agentlogs/agentlogs/pull/27#discussion_r3105792894)，仅作为代码审查证据，不当作额外用户事故。
[^29]: AgentLogs，[交互 picker 未统一的同步 export Implementation](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/commands/upload.ts#L397-L422)。
[^30]: AgentLogs，开放 PR 固定 head，[idle/queue/CLI resolution 单测](https://github.com/agentlogs/agentlogs/blob/a0e71dfd2709d8a6b1fa6ce3ea9aba3cf4e2739a/packages/opencode/src/index.test.ts#L1-L91)。
[^31]: AgentLogs，[mixed-root 与 dominant-root 回归测试](https://github.com/agentlogs/agentlogs/blob/cc925798faf283358850c7486de60f270fa37ec9/packages/cli/src/lib/repo-resolution.test.ts#L156-L194)。
