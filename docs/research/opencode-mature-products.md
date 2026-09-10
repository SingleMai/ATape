# OpenCode Adapter：开源产品选型与可靠采集设计

## 结论

有持续维护和公开故障反馈的产品，并没有收敛到同一种 OpenCode reader。Entire、AgentLogs 使用插件触发官方 `opencode export`；Confab 使用插件触发后台进程读取 SQLite，再追加本地 transcript；CASS 为本地历史搜索直接读取 SQLite，另行维护自己的索引与 Raw mirror。它们分别优化代码 checkpoint、团队分享、持续备份和历史搜索，保证也随之不同。[^1][^2][^3][^4]

对 ATape 本机历史导入、持续同步、对话与工具回放的目标，建议**把只读 SQLite 作为主候选，把官方 export 作为必须参与对照验证的候选；沿用 Collector 定期发现与有界 pull，首版不强制插件或常驻 OpenCode Server**。这个倾向来自离线覆盖和资源控制的适配性，不来自“最多项目都选了数据库”。Entire 的采用足以证明 export 是应认真比较的工程路线，不能因为此前研究偏向 SQLite 就将其排除。

更关键的选择是如何固定已观察内容，使网络失败和进程重启后仍能重放。建议讨论一个**受政策约束、有配额、有确认与回收规则的本地捕获边界**，借鉴 Entire 的原子安装与 Confab 的先落盘再上传，同时保留 ATape 较强的 revision、Raw receipt 和故障可见性。ATape 当前 ADR 明确不保存内容 spool，这项建议需要单独决定并形成 ADR，不能作为 Adapter 的内部小改动自动实施。[^5][^6]

若继续坚持不保存本地内容，应明确接受另一种保证：来源未变时可重放，来源已变且无法恢复时显式暂停或报告缺口。直接重查 SQLite、重新 export 或重新请求 SDK，都不能凭相同 Session ID 恢复已经被改写的旧字节。支持哪些会话、允许怎样的暂停率和恢复体验，需要与 reader 一起决定。

## 样本、版本与证据强度

这里的“值得参考”按实际产品匹配度、已发行实现、故障修复及测试证据判断。stars 只表示公开关注度；整个产品的成熟度也不能替代 OpenCode 集成的成熟度。证据截至 2026-09-10，源码固定 commit，发行 tag、main 和未合并 PR 分开判断。

| 产品 | 产品目标与关注度快照 | 已发行基线 | OpenCode 接入评价 |
| --- | --- | --- | --- |
| Entire | 与 Git 提交关联的 agent checkpoint；约 5,082 stars / 467 forks | v0.10.6，2026-09-07 | 四个重点样本中关注度最高，有官方文档、真实故障和运行时测试；官方仍标 preview，主 Session 覆盖有限 |
| CASS | 跨 provider 本地历史索引与搜索；约 1,121 / 138 | v0.7.1，2026-08-31 | 有大库和迁移的公开现场反馈，适合研究发现、扫描和存储；不等同于远端可靠归档 |
| AgentLogs | 团队 transcript 分享、提交关联与服务器；约 208 / 15 | plugin 0.0.5；CLI 0.1.7；Server 0.1.3 | 产品形态接近，但发行与 main 有差距，Raw 与持久恢复保证较弱 |
| Confab | transcript 持续备份、同步与分享；约 8 / 4 | v0.17.3，2026-06-17 | 架构最接近持续归档，已有实质修复；公开使用面小，不能称行业标准 |

上述数值和发行记录均来自项目仓库及包发行记录。Entire 的 OpenCode 目录在固定 main 与 v0.10.6 间无差异，但通用持久化代码另有发布后变化；Confab 的 main 与该 release 相同；CASS main 依赖 FAD 0.2.3，而 v0.7.1 依赖 0.2.1；AgentLogs 的最新 GitHub release 是 Server，不代表 plugin 或 CLI 的最新版。[^7]

许可证也应按组件区分。Entire、Confab 使用 MIT；AgentLogs 当前源码为 FSL-1.1-Apache-2.0；CASS LICENSE 带额外 rider，不能概括成普通 MIT。后两者仍有可核查的公开工程证据，但不能把全部样本笼统视作可直接复制代码的无条件开源依赖。本文建议借鉴设计与验收案例，不建议引入它们的源代码依赖。[^8]

Agent Sessions、Claude Code History Viewer 等 viewer 是辅助样本：它们支持本地读库、旧 JSON 兼容与按需加载的可行性，却没有提供 ATape 的远端确认与固定 cursor 重放证据。详细比较另见[历史工具研究](https://github.com/SingleMai/ATape/blob/045c81bfa37f38d8281b59527e83498116abc646/docs/research/opencode-ecosystem.md)。重点样本扩大到同步与 checkpoint 产品后，结论应从“偏向某种 reader”进一步发展为“分别选择来源、触发、捕获和投递机制”。

## 四种实际实现

| 产品 | 触发与发现 | 内容来源 | 本地固定内容 | 对外保存与更新 |
| --- | --- | --- | --- | --- |
| Entire | 项目 plugin 生命周期、turn 与 Git commit；另有显式 ID attach | 官方 export，全 Session JSON | 随机 staging → JSON 校验 → fsync → rename；随后 Git checkpoint | Git refs / pre-push queue；按 checkpoint 保留，不是周期性历史全量对账 |
| Confab | plugin lifecycle/reconcile → daemon；约 30 秒 poll；离线 list/save | 只读 SQLite 联表 | 本地 append-only `messages.jsonl` | backend 行号 receipt；已输出 message 不再更新 |
| AgentLogs | plugin idle/commit；手工 picker 或 ID 上传 | 官方 export | 导出临时文件；解析上传前删除，ID 缓存在 local.db | 统一 transcript hash + upsert；新快照覆盖旧投影 |
| CASS | 本地/镜像来源发现与增量 index | SQLite 优先，JSON 补充去重 | 自有规范化数据库；独立 Raw mirror | 本地索引与源文件证据；大文件分块去重 |

### Entire：官方 export 与原子缓存

Entire 的插件只传递小型生命周期 payload，Go Adapter 负责 export。这样把触发和内容处理分开，也把 SQLite schema 的读取责任交给 OpenCode。当前 export 子进程有 30 秒超时，stdout 直接写文件；候选输出经过 JSON 校验，再替换 `.entire/tmp/<sessionID>.json`。准备 transcript 时总是刷新，不能因为旧文件存在就认为 resumed session 或 mid-turn commit 已被覆盖。[^1][^9]

它很值得参考的地方是失败保留最后好副本：导出失败、空输出、损坏 JSON 都不应先截断旧文件。文件 Sync 先于 rename，目录 Sync 为 best-effort，Windows rename 冲突有有限重试与 staging 保留路径。这个设计缩小了“新内容没拿到，旧内容也丢了”的故障窗口。

但缓存、最新性和 Raw 保真是三件事。某些 hook 对刷新失败只做 best-effort，旧缓存仍可能被后续流程使用；OpenCode transcript 在分块或按 message 截取等 typed DTO 重编码路径中会丢掉未声明字段，因此不能笼统把 `full.jsonl` 视为无损 Raw。compact transcript 更有意只保留展示所需信息。它的 message-count position 也不等于 per-part revision，不能直接覆盖原地更新、后补 part 或撤回。[^10]

历史覆盖同样有限。官方文档不支持 OpenCode 的批量 `entire import`，但已发布的按需抓取能力允许显式 Session ID attach；这不是自动发现全部旧历史。文档仍声明只捕获主 Session，不能从 Entire 的整体成熟度推断其已解决 ATape 的完整 Thread topology。[^11]

### Confab：SQLite 与本地 transcript

Confab 的后台 collector 以只读方式打开 SQLite，通过单条联表查询读取 messages 与 parts，将 JSON 中缺少的关系 ID 补成 envelope，再写入本地 JSONL。插件负责启动与恢复触发；真正的持续同步由 daemon 轮询完成。当前发布源码还支持离线 list/save 和 capability 门控的 child sidechains，README 的 live-only/root-only 描述已经落后于实现。[^3][^12]

这条路线与 ATape 最接近：源数据库可能变化，而已经物化的 transcript 可以重复读取；通用同步层按行号向 backend 上传，进程重启可由现有 JSONL 恢复已输出 ID。不过这不是完整的崩溃持久性证明：实现未显式逐次 fsync，也没有足够的 torn-tail 修复与断电保证；本地原文在上传时才脱敏，未见内容配额、TTL 或成功上传后自动 trim。[^13]

更大的语义取舍是“只追加一次”。它使用 message ID 高水位，assistant 等待 finish/error，工具等待 completed/error；遇到未完成项停止，不越过缺口。这样适合完成消息的增量备份，但已输出 message 后续被修改、补 part、同一历史位置回填旧 ID，不会再生成新版本；长期不完成的项还可能阻挡后续内容。因此可借鉴固定内容和 receipt，不能照搬其 completion gate 作为 ATape 的全部更新算法。[^14]

### AgentLogs：官方 export 与最新投影上传

AgentLogs 对取数路线的动机有明确记录：为应对 OpenCode 从 JSON 迁往 SQLite，维护者把直接读 storage 改成 CLI export/session list。它希望来源存储变化留在 provider CLI 内部，plugin 和团队上传流程复用自己的公共 Module。这个维护成本考虑是支持 export 的直接证据。[^2]

实际交付机制比完整归档弱。导出临时文件在解析、转换、网络上传前就被删除；`local.db` 只缓存 Session 对应 transcript ID 和 commit 调用关联，不保存 payload、来源 revision 或待确认上传义务。下一次 idle 可以重传当时的最新内容，却无法保证重发上次的同一份内容。[^15]

服务端验证统一 transcript hash，相同 hash 返回 unchanged，不同内容覆盖固定 object key 并 upsert。由这条代码路径可以推导，旧快照晚到可能覆盖新快照；这里没有发现来源 revision 单调比较。这是代码分析出的风险，不是已复现的线上事故。2026-03-28 项目还明确移除了 Raw transcript 上传，因此不能把导出临时文件或统一 JSON 称为长期 Raw archive。[^16]

它的价值在于插件、CLI、脱敏和团队上传的责任划分，以及真实 export fixtures；其整套恢复语义不足以直接成为 ATape 的范本。常规 full/manual 入口跳过子会话，Task 主要转换成显示信息，未建立完整子树；部分其他入口行为不同，也不能概括为绝不处理 child。[^17]

### CASS：直接读库与规模反馈

CASS 的 Connector 已下沉到 FAD。当前读取顺序是小型 Session 元数据、变化候选集合、批量 messages、批量 parts，SQLite 与旧 JSON 按 Session ID 去重。它具有很实际的 Leverage：统一 Connector Interface 隐藏不同 provider 的发现与解析，调用方不必自己处理存储迁移。[^4]

它服务的是搜索完整性与扫描效率，遇到坏 JSON part 可以跳过并告警；不能将“搜索能显示这个会话”视为每条 Raw 都已保存。时间窗口、mirror 文件指纹和 Session 去重也不自动提供固定 cursor 的字节级重放。Raw mirror 是另一条源文件保存路径，其分块可重建文件内容，但不能据此推断任意活跃 DB/WAL 拷贝都是一致事务快照。

## 公开故障带来的设计约束

以下记录区分报告者观察、已合并实现、已发行版本和测试断言。大库大小、耗时与磁盘占用是公开用户报告，不作为独立性能基准；存在测试不代表这里运行过上游程序或认证了所有环境。

### 1. HTTP 接入假设与默认使用方式不匹配

Confab 的“Rewrite OpenCode integration to read SQLite (not HTTP)”将 HTTP/SSE reader 改成 SQLite。作者的理由是当时默认用户没有该实现依赖的可用 HTTP Server，原方案无法正常工作；其关于某历史版本默认行为的描述只能按当时问题背景理解，不能扩大成所有当前 OpenCode 产品均无 Server。PR 同时删除 SSE/reconnect/server_url 处理，并增加 SQLite fixtures 与同步集成测试。[^18]

对 ATape 的含义是安装体验必须参与选型。为“离线历史”额外启动服务，会引入端口、进程、版本与生命周期职责；官方提供 Server 不代表首版应该依赖它。若未来需要远程来源，再为真实变化的 production Implementation 设置 Seam，而不是先建三套 reader 或统一连接器抽象。

### 2. 插件已安装，恢复会话和退出尾部仍会丢

Confab 后续修复了 resumed session 不产生新的 created 事件、因而没有 daemon 的问题：使用 allowlisted lifecycle reconcile、来源/parent 查询、parent PID 与 orphan reaper。另一个修复在 collector shutdown 时做最后一次 SQLite reconcile，再让 daemon 尝试最终上传。当前有插件事件列表、恢复及最后消息的测试；人工验收项并非全部有完成证据。[^19]

这些修复证明“收到创建事件”不是持续覆盖契约，“收到 idle”也不是 durable ACK。最后 reconcile 仍受退出预算影响，不能替代崩溃后补录。ATape 应让周期发现承担正确性，hook 只提供更低延迟提示；若要安装插件，还要验证 resumed、run 退出和插件未运行三条路径。

### 3. 官方 export 也会在子进程边界被截断

Entire 的导出修复报告过约 64 KiB 截断，AgentLogs 的修复报告过约 256 KB 截断。两者都改为将 stdout 直接接文件，而非依赖原来的管道捕获；这些数字对应各自事故背景，不是 export 的通用输出上限。Entire 后续进一步加入 staging/validate/install，并测试部分失败、退出码 0 但 JSON 截断、空输出与旧缓存保护。[^20]

AgentLogs 的已发行修复则暴露另一种坑：同一个 export 逻辑存在多份 Implementation，修复只覆盖两条路径，交互 picker 仍使用同步管道；review 提出的 spawn error 和 timeout 缺失在对应主线路径仍能看见，也没有新增这次修复的回归测试。[^21]

ATape 若选 export，应该只有一个管理进程启动、输出、取消、超时、容量与清理的 Module。返回码 0、JSON 语法正确、Session 内容完整、远端确认，必须分别验证。stdout 写文件只是其中一个修复，不能直接把 CLI 当作天然的快照事务。

### 4. 事件顺序和运行时差异会制造静默缺口

Entire 修过重复 `session.created` 穿过 await guard 的竞态，以及 text part 尚未到达、代码已提交的时序问题。它先认领 Session，再等待关键 hook；message.updated 提前 turn-start，之后从 transcript backfill prompt。但仍有开放报告指出提前记 seen 导致后来的 user text 被跳过，不能宣称这一类时序问题已彻底消失。[^22]

另一个实际问题是插件使用 Bun globals，在 OpenCode Desktop 的 Node sidecar 中静默失败。修复改为 `node:child_process`，并增加实际 Node runtime canary，强于仅检查模板字符串；完整 Desktop 人工验收没有全部完成证据。[^23]

因此 hook payload 宜解释为“源可能变化”，最终文本从受控来源读取；采集失败还需要进入 Health/sourceFailures。保护宿主体验与显示采集故障可以同时做到，不能靠吞异常把不兼容伪装成暂无内容。

### 5. idle 高频触发会把轻量插件变成进程风暴

AgentLogs 的开放 PR 报告 idle burst 每次启动 npx，导致大量 npm 进程、CPU 占用和 ECOMPROMISED。候选修复做每 Session 节流、in-flight guard、串行队列和 CLI 路径缓存，并有相关单测；截至证据截点仍未合并，不能计入产品已交付能力。[^24]

对 ATape 可迁移的是合并触发、去重与背压。即使加入这些内存机制，也仍需考虑“最后一次更新被节流后，何时一定再读”；内存队列不等于 durable outbox。沿用已有 Collector 周期扫描，比每事件启动新包管理进程更适合当前产品目标。

### 6. 检测到 DB，不代表真的支持该历史格式

CASS 的 schema 问题报告约 4,323 个 Session、144,239 条 message 存在库里，却没有被索引。维护者确认 discovery 识别数据库，ingest 仍只处理旧 sidecar；修复增加真正的 SQLite reader，再更新产品依赖。当前测试创建真实 Drizzle 风格表与记录，通过公开 Connector.scan 检查输出。[^25]

AgentLogs 的早期转换修复也记录了从假定 fixtures 切换到真实 export 的过程，证明“看起来像合理 JSON”不足以建立来源契约。ATape 的支持矩阵应绑定实际 schema 与受控 native fixture；未知格式要明确报告 unsupported/partial，不能显示成功同步零条。[^26]

### 7. 增量在解码后过滤，仍会付出整库成本

CASS 的大库问题报告约 2.67 GB 来源扫描耗时 2.91 小时。维护者区分了镜像时间语义与解码顺序：旧内容新到达不能按本机时间简单跳过；另一方面，先读取大表全部 JSON 再筛 Session，也会让增量接近全量。修复包括成功扫描后保存文件集合指纹，以及 FAD 中先保留 Session 集合再批量查 messages/parts。[^27]

这条链还提示依赖交付核验：问题关闭时性能 hotfix 不等于 CASS 已 pin 并发布；当前 main 的 FAD 0.2.3 可以检查到优化与增量/全量一致测试，不能把它的全部行为自动回填给旧 release。

ATape 必须在取正文前筛选，并同时约束 rows、bytes、内存和单轮时间。`LIMIT 100` 不能限制一个巨大 tool output，输出 page 有界也不代表内部 SQL/JSON decode 有界；同步 SQLite 查询和大 JSON parse 还会影响 Node 事件循环。

### 8. 每次保存整库，会把恢复机制变成磁盘故障

CASS Raw mirror 问题最初报告两个文件约 31.93 GB，后续用户报告 OpenCode 完整数据库副本累计约 381.8 GB 并耗尽磁盘。修复对大于 8 MiB 的文件采用 4 MiB 内容寻址块，复用不变部分；清理时检查跨 manifest 共享引用。v0.7.1 已包含分块、重建、append、partial tail 和稀疏改写等测试。[^28]

这个经验不意味着 ATape 应实现另一个通用文件块仓库。更直接的选择是只捕获选中 Session 的必要记录，限制在途版本，确认后回收；只有实测证明需要长期大版本保存时，才考虑内容寻址与跨版本共享。整库复制会连带保存其他项目和非会话表，也与来源范围控制不匹配。

## 官方 Interface 与 ATape 契约的差距

OpenCode 官方提供 export、SDK/Server 与 plugin 扩展点，但这些概念没有替 ATape 定义归档保证。固定的 v1.18.30 源码显示，常用会话投影仍可被修改，export 从当前会话读取；SDK 路径名称中的 v2 也不能直接等同于一种全新的、不可变的存储模型。[^29]

retained EventV2 记录可能在特定覆盖条件下重建旧状态，是值得保留的技术可能；它又受历史迁移、导入、日志重置和 Session 删除影响。在四个重点产品的已检查采集实现中，没有发现把这条事件前缀当作通用历史恢复基础的先例。因此不建议首版同时发明一个完整上游事件投影器，以解决所有旧历史和未来演进。它可以留作特定能力优化，前提是独立证明覆盖。[^30]

ATape 要求 Host 主导 bounded pull：Adapter 返回观察、next cursor 和 Raw segments，Collector 负责校验、脱敏、Canonical/Raw 顺序、重试与进度。Canonical 成功后 Raw 仍可能失败；旧 cursor 未提交时重启，同一次消费必须能够重现身份、revision、源字节与分段。竞品的“下次重新读取最新会话”无法直接满足这个 Interface。[^5]

一个具体故障序列足以说明区别：第一次读取 part 为 A，Canonical 或部分 Raw 已提交，cursor 尚未推进；OpenCode 随后把 part 改为 B；Collector 重启。无论通过 SQLite、export 还是 SDK，最新来源只给 B。把 B 计算一个新 hash 并不能完成 A 的未确认义务；只保存 A 的摘要也不能恢复 A。长事务可以在当前连接内稳定读取，却不能跨进程重启保存旧视图。

同样不能混同领域身份。OpenCode Session.directory 可变化，fork 会复制历史内容，task 元数据可能沿用引用；ATape 的 Origin、Thread parent 与事件归属有自己的不变性要求。先采用其他产品的 reader，并不授权继承其按当前 cwd 归属、主 Session 过滤或 task 显示策略。Canonical、Raw 和 Search 应维持独立职责，未知字段不能先经展示 DTO 丢弃再声称 Raw 完整。[^31]

## 候选路线比较

| 维度 | A：只读 SQLite | B：官方 export | C：Server/SDK |
| --- | --- | --- | --- |
| 已有产品先例 | Confab、CASS；viewer 提供补充 | Entire、AgentLogs | 辅助插件/搜索产品有采用，重点归档样本未提供同等恢复先例 |
| 历史发现 | 可直接枚举本机来源、兼容探测 | 需 CLI list/显式 ID，验证完整枚举和目录范围 | 依赖可用 Server 与其可见来源 |
| 安装与生命周期 | 不需另起 OpenCode 进程；自己管理只读连接 | 需要可执行文件，每次导出有进程成本 | 需要服务地址、启动或连接管理 |
| 兼容责任 | ATape 维护路径、schema probe 和字段解释 | provider 维护存储读取；ATape 维护命令与输出契约 | provider 维护端点；ATape 维护服务版本和 API 契约 |
| 大会话与有界性 | 可以精细控制查询，仍需处理巨大单行与一致性 | 全会话导出需要容量、超时、解析策略 | 有分页不代表跨页固定快照或 byte bound |
| 原始字段 | 可保留所选源行未知 JSON，需定义稳定文本编码 | 可保留 export 未知字段，但不等于 DB 全部原始记录 | 受 API 返回表示和权限范围限制 |
| 改写后重放 | 单靠 reader 不提供 | 单靠重新 export 不提供 | 单靠重新请求不提供 |
| 本机首版判断 | 主候选，须证明 schema 与 bounded capture | 强对照候选，可能因维护收益胜出 | 当前额外运行责任较多，暂不优先 |

推荐 A 的理由是 ATape 已有定期 Collector，目标包含不开启 OpenCode 的旧历史，并且需要控制读取量和完整字段。推荐保留 B 的理由是它有较强产品采用先例和明确的迁移隔离动机；如果受控比较证明 SQL 兼容成本过高、export 输出可被有界处理，选 B 完全合理。

不建议首版同时交付 A/B/C 自动 fallback。不同 reader 的 Raw 表示、排序和观察时点可能不同，失败后静默换源会破坏重放，还会放大兼容矩阵。真正需要第二个 production Implementation 时再设置共同 Seam；研究对照不要求先引入通用框架。

## 建议的 Module 分工与持久化边界

```mermaid
flowchart LR
  P[Collector 定期发现] --> A[OpenCode Adapter]
  H[可选 plugin 唤醒] -.-> P
  S[只读 SQLite 或 export] --> A
  A --> F[固定观察与有界 page]
  F --> C[Collector 校验与脱敏]
  C --> K[Canonical 提交]
  K --> R[按政策处理 Raw]
  R --> D[确认义务与推进进度]
```

这是建议的职责分解，不表示已经接受本地内容存储。OpenCode Adapter 隐藏 provider-specific schema、关系映射、排序与编码；Collector 保持调度、确认和跨远端失败恢复；Presentation 只展示状态。文件、SQLite 和进程属于真实外部 Seam，生命周期、失败与异步工作在 TypeScript 中通过 Effect 管理。这样的 Depth 与 Locality 能让后续兼容修复留在 Adapter，而不是要求 Host 了解 OpenCode 内部事件。[^32]

本地捕获若获采用，需要同时定义以下行为，不能只增加一个 cache 目录：

- **先固定再承诺。** 在可能产生远端 side effect 前，可恢复地记录这次观察的内容、身份、编码版本与分段边界；候选失败保留此前有效版本。安装与进度如何原子关联必须由原型验证。
- **依政策保存最少内容。** Canonical 的在途恢复数据与 Raw 原文不是同一需求。Raw 关闭时不得额外为归档读取或持久化完整源字段；仅能讨论 Canonical 必要数据的最小、短期恢复表示。Raw 重新开启也不能虚构已读取/已确认范围。[^33]
- **明确容量与回收。** 设置每 Session、每 Project 和总量限制；只在相关义务完成后释放所需内容。定义磁盘满、损坏 staging、source 消失、进程被杀和政策切换的状态，不以删除未确认数据换取“同步成功”。
- **更新生成新版本。** 固定的是一次观察，不是永远忽略 message 后续变化。需要发现修改、后补 part 和回填旧 ID，再以明确 revision/generation 处理；保留已确认历史不等于自动删除源端撤回内容。
- **失败可见且可恢复。** 区分未发现、未知格式、暂时锁定、源已变化、候选不完整和远端未确认。已有旧副本只说明它可读，不能将状态标为已同步最新。

即使只保存已转换或已脱敏的 Canonical 页，跨进程持久化正文仍是新的 payload spool；限额、加密或 TTL 都不能使其自动符合现有 metadata-only 契约。若接受这项变更，Canonical 暂存宜限制为已投影、已脱敏、待确认的最小 delivery unit，冻结转换版本；它不能夹带原 export 或成为关闭 Raw 时的隐式回填仓库。把正文压缩进 opaque cursor 也不构成解决办法。[^5][^6][^33]

metadata-only 路线仍是实质候选：先固定边界和摘要，重读验证相同才消费；源不再匹配时停止该义务并解释缺口。它保留不存内容的架构优势，但无法恢复已经消失的 payload；若活跃会话频繁失配，安全地暂停也可能成为不可用的产品体验。应通过实际场景比较失败率与恢复步骤，不能只用静态契约论证可行。[^6]

## 从竞品事故转成验收场景

首个原型应使用同一批受控 native OpenCode 会话分别验证 SQLite 与 export；无需先实现两个完整 Adapter。样本至少包含普通对话、工具各状态、reasoning、child、fork、revert 后继续、compaction、目录移动和大输出。真实导出用于验证来源形状，合成数据用于放大边界，二者证据不可互相替代。

| 场景 | 已有事故或契约依据 | ATape 应检查的外部行为 |
| --- | --- | --- |
| 仅 DB 存在、未知 schema | CASS discovery/ingest 不一致 | 明确 unsupported/partial；不会报告成功但零历史 |
| 同 cursor，Canonical 后 Raw 失败，再改写源并重启 | ATape 两段确认契约 | 重放原观察或明确不可恢复；不混合 A/B，不假推进 |
| export 退出 0 但空/截断；缺 binary；超时 | Entire、AgentLogs | 旧候选不被破坏，错误分类正确，临时文件有界回收 |
| 一条巨大 tool part，数千 Session | CASS 性能记录 | rows/bytes/内存/时间都有边界，不靠最终 page 截断掩盖全量读取 |
| user 先到、part 后到；完成后修改与旧 ID 回填 | Confab completion/HWM；Entire 事件顺序 | 后续变化被发现，Canonical 身份稳定，revision 有据可查 |
| resumed、idle burst、run 立即退出、plugin 未运行 | Confab、AgentLogs、Entire | 周期发现最终补齐；不无限 spawn；最后提示丢失不等于历史永久丢失 |
| child/fork/task 引用；CWD 移动 | OpenCode 源语义 | topology 与 Origin 有来源证据，不由当前路径或工具显示名猜测 |
| Raw 开关变化、远端政策拒绝 | ATape Raw policy | 关闭不做归档读取、不造 receipt；Canonical 继续符合自己的契约 |
| 同源多次更新、磁盘满、旧暂存残留 | CASS Raw 放大 | 不每轮复制整库；占用和清理可解释，未确认义务不会静默消失 |
| WAL 并发写、同时间水位、复制来的旧历史 | SQLite 一致性与 CASS 增量问题 | 无跨页混合；成功后才推进覆盖；不会按时间误跳新到旧数据 |

这些是应验证的行为，不是已经通过的测试结果。现有竞品证据可以指导 fixture 和故障注入，但不能替代 ATape 自己通过 `collect` 与 Collector Interface 的端到端检查。测试应针对可观察的恢复和输出，不依赖 Adapter 私有查询顺序。

## 选型建议与后续决策

建议采用的工程原则已经比较清楚：薄触发、独立历史发现、单一取数 Implementation、候选原子安装、先筛后读、显式 receipt、来源失败可见、存储从第一天有上界。需要避免的做法也有充分证据：每事件 npx、把 ID 高水位当全部更新发现、未校验就覆盖旧缓存、每轮全库备份、全会话 upsert 代替 revision、typed DTO 重编码后声称 Raw 无损。

尚不能仅凭产品先例决定的是本地内容政策与最终 reader。建议优先讨论“是否允许为确定性重放保存最小在途捕获内容”，同时保留无内容持久化时的明确失败边界。之后用同一 native fixture 对照 SQLite 与 export，选择一个首版 Interface，并绑定真实验证过的版本/能力，不笼统承诺所有 SQLite 时代 OpenCode。

只读 SQLite 仍是本机首版的主候选；它应借鉴 Confab 的来源接入、Entire 的候选保护和 CASS 的资源约束，而不是完整复制任何一个产品。官方 export 是有实质先例的备选；它同样需要捕获与恢复设计。这个组合判断既利用已有经验，也保留 ATape 的领域与数据保证。

## 专项证据档案

各档案保留更细的固定行号、版本差异和测试局限：[Entire](opencode-mature/entire.md)、[Confab](opencode-mature/confab.md)、[AgentLogs](opencode-mature/agentlogs.md)、[CASS](opencode-mature/cass.md)。官方来源与语义的先行分析见[本机历史采集](https://github.com/SingleMai/ATape/blob/dc4ff22cb23af63c4909a2ebba7d8bd338c7f7fd/docs/research/opencode-storage.md)及[Session 与工具语义](https://github.com/SingleMai/ATape/blob/525ac1b75412149c9c7d0aaf082b66ce6f52e058/docs/research/opencode-semantics.md)。

## Sources

固定源码 SHA 是对应行为的证据基线；文档、发行及 issue/PR 状态截点为 2026-09-10。来源均为上游项目、官方发布渠道或 ATape 已接受的架构文档。

[^1]: Entire，OpenCode plugin 与 export reader，固定 main `0138471ae764ca9b846ed21ce0a9ff917724d0bf`：[plugin](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/entire_plugin.ts#L1-L269)、[export](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/cli_commands.go#L19-L76)。
[^2]: AgentLogs，2026-02-05，[Use CLI commands instead of reading storage files directly](https://github.com/agentlogs/agentlogs/commit/35fc9d2eff34236e04a03d5cdf066072ae1ee728)。
[^3]: Confab，v0.17.3 / main `6ea943ce8ee3328162909e16f3444fbd247f3094`：[SQLite reader](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_db.go#L17-L150)、[collector](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_collector.go#L17-L203)。
[^4]: CASS，main `2110e4b21067d569a1d29e0c20dfdf6181242a3d`：[Connector](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/2110e4b21067d569a1d29e0c20dfdf6181242a3d/src/connectors/opencode.rs#L1-L5)；FAD，0.2.3 对应 `0feebc55fed8db4d596f330742fe11ca4cb70764`：[reader](https://github.com/Dicklesworthstone/franken_agent_detection/blob/0feebc55fed8db4d596f330742fe11ca4cb70764/src/connectors/opencode.rs#L475-L607)、[scan](https://github.com/Dicklesworthstone/franken_agent_detection/blob/0feebc55fed8db4d596f330742fe11ca4cb70764/src/connectors/opencode.rs#L943-L1065)。
[^5]: ATape，2026-09-05，[ADR-0009: Pull Adapter Runtime and Checkpointed Collector](https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/architecture/adr/0009-pull-adapter-runtime-and-checkpointed-collector.md)。
[^6]: ATape，2026-09-07，[ADR-0027: Transactional Capture Checkpoints and Independent Raw Recovery](https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/architecture/adr/0027-transactional-capture-checkpoints.md)，状态为 Accepted design; Implementation pending。
[^7]: GitHub / npm，仓库元数据与发行：[Entire API](https://api.github.com/repos/entireio/cli)、[v0.10.6](https://github.com/entireio/cli/releases/tag/v0.10.6)、[CASS API](https://api.github.com/repos/Dicklesworthstone/coding_agent_session_search)、[v0.7.1](https://github.com/Dicklesworthstone/coding_agent_session_search/releases/tag/v0.7.1)、[AgentLogs API](https://api.github.com/repos/agentlogs/agentlogs)、[plugin 0.0.5](https://registry.npmjs.org/@agentlogs%2fopencode/0.0.5)、[CLI 0.1.7](https://registry.npmjs.org/agentlogs/0.1.7)、[Server 0.1.3](https://github.com/agentlogs/agentlogs/releases/tag/server-v0.1.3)、[Confab API](https://api.github.com/repos/ConfabulousDev/confab)、[v0.17.3](https://github.com/ConfabulousDev/confab/releases/tag/v0.17.3)；[CASS release dependency](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/19336ea7e992fe7e28cf070b5df4775203f986dc/Cargo.toml#L127)。
[^8]: 项目 LICENSE：[Entire](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/LICENSE)、[Confab](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/LICENSE)、[AgentLogs](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/LICENSE)、[CASS](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/2110e4b21067d569a1d29e0c20dfdf6181242a3d/LICENSE)。
[^9]: Entire，[PrepareTranscript / FetchTranscript](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/lifecycle.go#L148-L296)、[staging 与 rename](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/stage_export.go#L14-L97)。
[^10]: Entire，[typed export schema](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/types.go#L23-L111)、[message position](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/transcript.go#L44-L90)、[best-effort prepare](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/strategy/common.go#L1797-L1809)。
[^11]: Entire，[OpenCode 官方指南](https://docs.entire.io/agents/opencode)、[fetch on-demand transcripts for untracked sessions](https://github.com/entireio/cli/pull/1877)、[discover untracked sessions](https://github.com/entireio/cli/issues/1992)。
[^12]: Confab，[离线 list/save](https://github.com/ConfabulousDev/confab/pull/87)、[child collectors](https://github.com/ConfabulousDev/confab/pull/66)、[README](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/README.md#L117-L136)。
[^13]: Confab，[本地追加与 seed](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_collector.go#L17-L203)、[tracker 与 redaction](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/sync/tracker.go#L290-L466)、[上传与 receipt](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/sync/engine.go#L350-L423)。
[^14]: Confab，[message completion](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_session.go#L89-L160)、[collector 重启与 gap 测试](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_collector_test.go#L97-L159)。
[^15]: AgentLogs，main `ea49614eb01816872a88a3ac70aaae066de6e0ce`：[export 临时文件](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/commands/opencode/upload.ts#L16-L147)、[local.db](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/local-store.ts#L6-L181)。
[^16]: AgentLogs，[hash/unchanged](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/server/src/routes/api/ingest.ts#L67-L214)、[blob/upsert](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/server/src/routes/api/ingest.ts#L331-L454)；2026-03-28，[Remove raw transcript uploads](https://github.com/agentlogs/agentlogs/commit/144f9a6624271301a89bd98d68de8979a0a89197)。
[^17]: AgentLogs，[hook 覆盖](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/commands/opencode/hook.ts#L275-L427)、[converter](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/shared/src/opencode.ts#L228-L424)。
[^18]: Confab，2026-06-06，[Rewrite OpenCode integration to read SQLite (not HTTP)](https://github.com/ConfabulousDev/confab/pull/62)。
[^19]: Confab，2026-06-07，[Resume OpenCode sessions via reconcile + orphan hardening](https://github.com/ConfabulousDev/confab/pull/64)、[Final SQLite reconcile on collector shutdown](https://github.com/ConfabulousDev/confab/pull/65)、[final reconcile test](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_collector_test.go#L255-L290)。
[^20]: Entire，2026-04-02，[make OpenCode transcript export resilient to stdout truncation](https://github.com/entireio/cli/pull/832)、[cache failure tests](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/lifecycle_test.go#L369-L543)；AgentLogs，2026-04-18，[fix session truncation bug](https://github.com/agentlogs/agentlogs/pull/27)。
[^21]: AgentLogs，[spawn error review](https://github.com/agentlogs/agentlogs/pull/27#discussion_r3105792893)、[timeout review](https://github.com/agentlogs/agentlogs/pull/27#discussion_r3105792894)、[picker export](https://github.com/agentlogs/agentlogs/blob/ea49614eb01816872a88a3ac70aaae066de6e0ce/packages/cli/src/commands/upload.ts#L397-L422)。
[^22]: Entire，[session-start race](https://github.com/entireio/cli/issues/883)、[Make OpenCode E2E green again](https://github.com/entireio/cli/pull/967)、[Preserve user prompts when message events arrive in sequence](https://github.com/entireio/cli/issues/2001)。
[^23]: Entire，[hooks never fire in Desktop](https://github.com/entireio/cli/issues/2014)、2026-08-20，[spawn hooks via node:child_process](https://github.com/entireio/cli/pull/2018)、[Node runtime canary](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/hooks_test.go#L442-L522)。
[^24]: AgentLogs，2026-09-09，[throttle session.idle, serialize hooks, cache CLI resolution](https://github.com/agentlogs/agentlogs/pull/45)，开放 PR；[候选单测](https://github.com/agentlogs/agentlogs/blob/a0e71dfd2709d8a6b1fa6ce3ea9aba3cf4e2739a/packages/opencode/src/index.test.ts#L1-L91)。
[^25]: CASS，[OpenCode schema mismatch](https://github.com/Dicklesworthstone/coding_agent_session_search/issues/227)、[maintainer resolution](https://github.com/Dicklesworthstone/coding_agent_session_search/issues/227#issuecomment-4445898640)、[真实 SQLite scan test](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/2110e4b21067d569a1d29e0c20dfdf6181242a3d/tests/connector_opencode.rs#L109-L229)。
[^26]: AgentLogs，2026-01-12，[Rewrite converter for real export format](https://github.com/agentlogs/agentlogs/commit/28e95b169fdbe0ca41d681697e21e39455332b5e)。
[^27]: CASS，[large opencode.db scan](https://github.com/Dicklesworthstone/coding_agent_session_search/issues/372)、[fix / dependency distinction](https://github.com/Dicklesworthstone/coding_agent_session_search/issues/372#issuecomment-5157676545)；FAD，[parts keep-set](https://github.com/Dicklesworthstone/franken_agent_detection/blob/0feebc55fed8db4d596f330742fe11ca4cb70764/src/connectors/opencode.rs#L747-L808)、[incremental parity test](https://github.com/Dicklesworthstone/franken_agent_detection/blob/0feebc55fed8db4d596f330742fe11ca4cb70764/src/connectors/opencode.rs#L3189-L3282)。
[^28]: CASS，[Raw mirror full copies](https://github.com/Dicklesworthstone/coding_agent_session_search/issues/430)、[用户磁盘报告](https://github.com/Dicklesworthstone/coding_agent_session_search/issues/430#issuecomment-5471241760)、[chunking fix](https://github.com/Dicklesworthstone/coding_agent_session_search/commit/402515f893de3a166b029f222bc2be2c257316f9)、[v0.7.1 regression tests](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/19336ea7e992fe7e28cf070b5df4775203f986dc/src/raw_mirror.rs#L3452-L3856)。
[^29]: OpenCode，官方 [CLI](https://opencode.ai/docs/cli/)、[Server](https://opencode.ai/docs/server/)、[SDK](https://opencode.ai/docs/sdk/)、[Plugins](https://opencode.ai/docs/plugins/)；v1.18.30 固定源码 `3104c1428ec91f809e5ab86631300de41eb6952e`：[export](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/cli/cmd/export.ts#L222-L292)、[projector mutations](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/projector.ts#L234-L327)。
[^30]: OpenCode，[durable events](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/event.ts#L205-L360)、[event removal](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/event.ts#L514-L522)、[v2 state reset migration](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts#L5-L16)。
[^31]: OpenCode，[Moved projection](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/projector.ts#L242-L255)；ATape，[源语义证据及固定上游引用](https://github.com/SingleMai/ATape/blob/525ac1b75412149c9c7d0aaf082b66ce6f52e058/docs/research/opencode-semantics.md)、[Adapter contract](https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/adapters/package-manifest.md)。
[^32]: ATape，[Architecture manual](https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/architecture/codebase-design.md)、[TypeScript / Effect](https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/architecture/typescript-effect.md)。
[^33]: ATape，2026-09-09，[ADR-0056: Team and personal Raw capture policy](https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/architecture/adr/0056-configurable-raw-capture.md)。
