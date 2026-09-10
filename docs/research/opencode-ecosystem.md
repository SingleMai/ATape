# OpenCode 历史工具的接入取舍

调研日期：2026-09-10。对应决策票：[比较 GitHub 历史工具的 OpenCode 接入取舍](https://github.com/SingleMai/ATape/issues/111)。本文是源码调查，供接入决策使用，不代表已选择 ATape 的采集方案或完成兼容性验收。

## 结论

四个样本证明了两条实际路线：独立 viewer 直接读取本地 SQLite/旧 JSON；运行于 OpenCode 内的 plugin 通过 SDK 读取历史，再维护可重建索引。它们处理的是浏览、搜索或上下文召回，均不能直接证明 ATape 所需的远端幂等提交、Raw 字节回放与跨进程分页快照成立。

最有用的经验是：区分读取失败与权威空集；按 provider session ID 而非共享 DB 文件路径识别会话；把 WAL 变化视为刷新提示；为大历史显式分页；按会话保留成功状态，避免并发任务越过失败水位。最需要警惕的是：SQLite/JSON 共存策略并不一致；目录分组不等于 ATape 的 Git attribution；源端删除与派生索引删除不等于历史归档删除；“SDK v2”也不表示读取新的 `session_message` 数据模型。证据详见下文。

## 样本与证据边界

仅阅读以下仓库的固定 commit、README、实现和测试源码。没有运行第三方程序、安装依赖、执行仓库脚本或读取用户聊天数据；没有实测性能。文中的性能上限是源码行为或作者声明，不是本次 benchmark。

| 样本 | 固定 commit | 选择原因 |
| --- | --- | --- |
| [Claude Code History Viewer](https://github.com/jhlee0409/claude-code-history-viewer/tree/fdfc766ce7f0d76dceb03087aedac47add33d61b) | `fdfc766ce7f0d76dceb03087aedac47add33d61b` | 跨 agent viewer；SQLite 与 JSON 合并 |
| [Agent Sessions](https://github.com/jazzyalex/agent-sessions/tree/6f9b6c72d0512bb01881f0b66120816db9e89f2f) | `6f9b6c72d0512bb01881f0b66120816db9e89f2f` | 跨 agent viewer；共享 DB 中的会话身份、刷新与索引清理 |
| [opencode-history-search](https://github.com/joeyism/opencode-history-search/tree/bf191ae22f2b35ecb5110b5fe18b72fd5423b6a0) | `bf191ae22f2b35ecb5110b5fe18b72fd5423b6a0` | OpenCode tool/plugin 使用方式，但直接读 SQLite/JSON |
| [opencode-session-recall](https://github.com/rmk40/opencode-session-recall/tree/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2) | `8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2` | SDK/plugin 路线；较完整的增量派生索引和恢复机制 |

**版本结论必须收窄。** 三个直读样本实际查询 `session`、`message`、`part`，没有读取 `session_message` 或 `event_sequence` 的实现。它们的 README “支持 OpenCode”不能当作所有新数据路径的兼容保证；但也不能仅因上游出现新表，就断言这些 reader 已失效。应分别验证上游生产路径是否仍维护这些表、目标版本如何选择路径，以及历史迁移状态。[CCHV 消息读取][cchv-messages]、[Agent Sessions 消息读取][as-messages]、[history-search 消息读取][hs-sqlite]。

对照官方 OpenCode 固定 commit `3104c1428ec91f809e5ab86631300de41eb6952e`，普通 CLI `run` 和 TUI 仍调用 `client.session.prompt`；SDK `src/v2` 的 `session.messages` 仍发往 `/session/{sessionID}/message`，其 `MessageV2.page` 从 `MessageTable` 分页。因此三个 reader 选取的表与普通会话路径相关，不能笼统判为过时。另一方面，服务器还挂载 SessionV2，存在 `/api/session` 和另外的 `session_message` 模型；本次样本没有提供这些额外数据路径的读取证据。session-recall 的 `@opencode-ai/sdk/v2` import **本身不是新 session 数据模型支持的证据**。目标版本和启用路径仍需单独验收。[CLI 调用][official-cli]、[TUI 调用][official-tui]、[官方 SDK 方法][official-sdk]、[官方 MessageV2 分页][official-page]、[服务器组装][official-server]、[额外 session API][official-v2-api]、[session_message schema][official-v2-table]。

## 1. Claude Code History Viewer：合并旧数据，刷新当前视图

README 把 OpenCode 描述为本地会话和工具结果源；实现确实存在独立 provider，而非只列出名称。数据根优先 `OPENCODE_HOME`，再 `XDG_DATA_HOME/opencode`，最后 `~/.local/share/opencode`；检测 storage 目录或 `opencode.db`。这里的 `OPENCODE_HOME` 是这个 reader 的约定，不能推定为官方配置变量。[README][cchv-readme]、[检测与数据根][cchv-path]。

- **SQLite/JSON 共存：** 先读 DB，再补 JSON-only session，重复 session ID 由 DB 优先。项目扫描预先构造 DB session ID 集合补会话数；会话加载再次按 ID 去重。这适合迁移后仍有 JSON-only 历史的 viewer；但“DB 删除过的会话仍留在旧 JSON”也可能再次出现，源码中这个合并分支没有墓碑对账。后一项是从合并规则得出的风险，不是已复现 bug。[项目合并][cchv-merge-project]、[会话合并][cchv-merge-session]。
- **Project：** 使用 OpenCode project ID 与 worktree/name；对无名字的 `global` 项目按 session directory 建虚拟项目，避免无 Git 的多个目录挤到同一组。目录规范化/hash 是展示分组，不包含 ATape server repository identity、远端 alias 或历史 attribution evidence。[global 身份][cchv-global]、[directory 分组查询][cchv-global-query]。
- **子会话：** 专门查询 `session.parent_id`，同时限制 `project_id`，供 SubAgent 面板列直接孩子；文件后端此函数返回空。这是可借鉴的拓扑来源，但没有证明“所有 OpenCode 分叉等于 ATape child Thread”，也不是一次 observation 的完整拓扑快照。[子会话实现][cchv-child]。
- **并发与刷新：** 数据库使用 `READ_ONLY | NO_MUTEX` 和一秒 busy timeout；watcher 识别 `.db`、`.db-wal`，广播 `opencode://*` 触发广泛刷新，无法由文件事件识别哪一行变化。DB 已存在时监视其父目录。这里有 WAL 感知，没有可持久恢复的变更游标。[只读打开][cchv-open]、[watcher 识别][cchv-watch]、[watcher 注册][cchv-watch-root]。
- **读取成本与错误：** 单会话 message 按 `time_created,id` 排序，复用 part statement，最后收集为完整 `Vec`；无 ATape 页大小上限。坏 JSON 跳过，多处 DB 错误转 `None` 或空值。源码足以支持“可浏览”，不足以支持“未知读取错误不丢数据并能远端重试”。[消息 Implementation][cchv-messages]。

**可迁移：** 独立 provider Module、ID 去重、目录型 global 分组、只读访问、WAL 提示。**不宜照搬：** 静默漏过错误、无墓碑的双源合并、整会话加载、将广泛刷新当增量 capture checkpoint。

## 2. Agent Sessions：整源切换，按会话身份管理索引

该项目的第一方指南明确说读 SQLite session/message/part 和 legacy JSON；实际 detector 在 `opencode.db` 存在且含 session 表时选 SQLite，否则选 JSON。它不是 CCHV 的双源合并。支持自定义 root、直接 DB 路径、storage/session 路径上溯；默认 home 路径解析本身没有读取 XDG 环境变量。[指南][as-guide]、[后端检测][as-detect]。

- **迁移与来源：** `OpenCodeSessionIndexer.refresh` 是 SQLite/JSON 互斥分支；SQLite 分支合并的是用户 pinned archive fallback，不能把这理解成合并所有旧 JSON。共享 DB 中每个 Session 保留自己的 `id`，`filePath` 才是共享 DB 路径。[刷新分支][as-refresh]、[会话读取][as-list]。
- **Project 与拓扑：** 读取 `directory` 为 cwd，读取可选 `parent_id` 为 parentSessionID；先检查列存在，兼容没有该列的 schema。它没有在这个 reader 中建立 ATape 风格 Git remote attribution。列表明确 `time_archived IS NULL`，所以“可浏览范围”与 ATape 希望捕获全部保留历史的范围可能不同。[会话读取][as-list]。
- **修改与缓存：** 活跃会话已经 hydrated 后，先查询 `session.time_updated`，只有严格更新才重载；手动刷新可跳过该 gate。搜索层另有 `{updatedMillis, extent}`，extent 用来捕捉同时间戳的 message-count 变化。相同时间、相同 count 的 part 内容改动是否总能被发现，本次代码证据不足。[hydration freshness][as-fresh]、[搜索身份和 revision][as-identity]。
- **删除与读取失败：** `listSessionsIfReadable` 返回 optional，把打开/prepare/step 失败与真实空集区分。成功扫描才生成 IdentitySnapshot；搜索 ingest 按明确拥有的 storage path 对账，失败扫描不能授权删除索引。数据库消失时还检查父目录存在，防止卸载磁盘/权限丢失被误判删除。这是四个样本中很值得 ATape 借鉴的失败语义，但索引清理仍不同于删除已归档 Canonical。[列表失败语义][as-list]、[身份快照][as-identity]、[搜索对账][as-reconcile]。
- **只读/WAL/大历史：** 每次使用 `SQLITE_OPEN_READONLY`，监控签名合并 `-wal` 与 `-shm` mtime，解决仅看主 DB 文件遗漏写入。列表先加载元数据，再按需读取完整 transcript；不过仍列出全部未归档 sessions，列表中每个 session 有额外 message 查询，完整加载按 message 再查 parts，不能当作有界 collector 的现成分页设计。[只读列表][as-list]、[WAL 签名][as-wal]、[完整 transcript][as-messages]。

**可迁移：** provider ID 与物理 source path 分离、失败不等于空集、来源范围明确的索引对账、metadata-first discovery。**不宜照搬：** 默认忽略 archived、以 viewer 当前列表作为捕获历史全集、以 mtime/count 作为所有变更的强 revision。

## 3. opencode-history-search：plugin/tool 包装不等于 SDK 采集

README 推荐 OpenCode plugin 配置，也保留复制 custom tool 的安装方法；实际 storage-provider 直接调用本地 reader，没有通过 SDK 请求历史。README 的“SQLite preferred、否则 JSON”与源码一致，而且 `const useSqlite = dbExists()` 在模块初始化时固定，运行期间新出现 DB 不会在该 Module 内重新检测。存在性只检查文件非空，未先验证 schema。[README][hs-readme]、[后端选择][hs-provider]、[数据库读取][hs-sqlite]。

- **数据路径/Project：** 尊重 `XDG_DATA_HOME`，默认 `.local/share`；当前 project ID 是 `git rev-list --max-parents=0 --all` 输出排序后的第一个 commit，没有结果则 `global`。这是跟随 provider 本地组织方式，不是团队 Git repository identity；浅克隆、非 Git、独立目录等情形应由官方调查和 ATape attribution 决策验证。[路径与 project ID][hs-json]。
- **消息覆盖：** Session 类型没有 parent 字段；part 映射仅保留 text/tool/file/patch，显式跳过 reasoning、compaction、agent、step 类型。适合限定搜索语料，不是完整 Canonical/Raw 采集。[SQLite 映射][hs-sqlite]。
- **读取/错误/变更：** SQLite `{readonly:true}`；session/message/part 查询使用 `.all()` 后才由 generator yield，每类调用分别开连接。没有跨层 snapshot transaction、持久 checkpoint 或删除日志。普通搜索读取的是查询时状态；JSON 和 fuzzy 路径 catch 后跳过坏文件/缺目录，结果不代表完整覆盖。[SQLite reader][hs-sqlite]、[JSON reader][hs-json]、[fuzzy reader][hs-fuzzy]。
- **大历史：** fuzzy 每次构造全部 `SearchableItem[]` 再建 Fuse index，没有持久增量索引；多词 SQL 路线则推下查询与 LIMIT。README 的百毫秒/一秒性能数字未由本次验证，且不能外推至全量 fuzzy 或 Raw 归档。[fuzzy Implementation][hs-fuzzy]、[多词 SQL][hs-multi]、[README][hs-readme]。

**可迁移：** 小 storage Interface 隐藏两种读法、尽可能将过滤推给 SQLite。**不宜照搬：** 进程寿命内固定后端、坏源静默跳过、Git 根 commit 直接充当 ATape 项目权限、每次全历史内存建索引。

## 4. opencode-session-recall：SDK 读取与可重建派生索引

README 首句“straight from database”容易被误读为直接开 OpenCode DB；同一 README 后文实际解释了 SDK 路线。源码通过插件 `ctx.client._client.getConfig()` 取得内部 fetch，构造 scoped 与 unscoped SDK clients。跨项目用 `experimental.session.list`，普通项目用 `session.list`。这是运行在 OpenCode 宿主中的 plugin，需要宿主 client；不能原封不动成为独立 Node Collector 的离线 reader。内部 `_client` 还构成额外兼容风险。[README][recall-readme]、[SDK client 构造][recall-client]、[discovery][recall-discovery]。

- **发现范围：** discovery 一次显式请求 `limit=10,000`；此函数没有遍历 session-list cursor。消息则明确传 limit/before，并从 `X-Next-Cursor` 获取下一页。源码注释记录了无 limit 会走完整会话读取的历史问题；默认每页 50 messages，FTS 每 session 默认最多 5,000 行。这解决查询成本，不证明所有历史被无损扫描。[discovery][recall-discovery]、[发现上限][recall-limits]、[分页与 caps][recall-distill-head]、[消息页][recall-page]、[有界读取][recall-fetch]。
- **Project/子树：** 卡片保留 directory/projectId/parentId/rootId；直接子会话查询调用 `client.session.children` 并核验 parentID。项目过滤使用目录及其 descendants，当前 Session 的孩子存在跨 worktree 豁免。这个本地召回体验不能充当 ATape 远端项目授权或完整 Thread topology 的规则。[Session 过滤与 children][recall-children]、[卡片元数据][recall-distill-head]。
- **增量与恢复：** cold pass 逐卡比较 `distillState=full` 与 `timeUpdated`，不使用全局时间水位快跳，避免并发中较新失败被较旧成功越过；损坏会话进入 bounded quarantine，更新时间变化可重试。后台 lease 有 heartbeat、丢失后停写与重试。值得迁移的是每来源确认进度和显式失败隔离，而非照搬另一个 durable store。[cold pass][recall-cold]、[quarantine/retry][recall-retry]、[lease][recall-lease]。
- **更新/删除：** `session.idle` 调度重建；compacted、message removed、part removed 和 removal-shaped part update 强制 full 路线；session.deleted 删除派生索引。普通 session.updated 被忽略。大 session 可 append 到已知 message checkpoint，找不到 checkpoint 会退 full。由此只能证明它对这些触发器有恢复策略，不能证明漏掉事件后同时间戳修改、历史原地修改或所有删除都被持续对账。[事件处理][recall-events]、[增量/full 决策][recall-update]、[寻找 checkpoint][recall-fetch]。
- **自有 SQLite：** 该 DB 在 `.cache/opencode-session-recall/store-v1.db`，不是 OpenCode source DB。自身开启 WAL/busy timeout；每 session transactional delete-and-insert 同步 FTS；旧 schema 有 additive migration，未知/过旧布局可重建，新于当前代码的 schema 则降级，不能写坏新版。README“索引可删除”与这种派生状态模型一致。[store 语义与 WAL][recall-store-head]、[schema recovery][recall-store-open]、[事务替换][recall-store-write]、[store 路径][recall-store-path]。

**可迁移：** 所有读取显式分页、单 source 成功状态、损坏隔离、重建与 append 分路、后台任务取消与所有权。**不宜照搬：** plugin 内部 fetch 提取、experimental list 即全历史假设、idle-only 更新策略、可丢弃搜索卡片代替 Canonical/Raw、源删除时删除远端归档。

## ATape 下一步应解决的决定

以下是本调查提出的决策输入，不是已经批准的实现：

1. **来源选择：** 直接读当前生产 SQLite 路径，还是依赖运行中的 OpenCode SDK？前者需维护 schema 兼容，后者需明确宿主生命周期、endpoint 版本、全历史分页和离线可用性。plugin、SDK 版本、session 数据模型必须分别命名。
2. **旧 JSON 边界：** SQLite 优先整源切换或双源合并都已有先例，但应显式决策 JSON-only 会话、冲突优先级、DB 删除后的旧副本，不能把其中一种当作公认正确答案。
3. **变更与回放：** 文件 watcher/`time_updated`/message count 只能提供发现提示。ATape 仍需自己的稳定 observation identity、单调 source revision、跨页固定内容与 Raw generation 设计；需要受控 fixtures 验证同时间戳更新、part 原地变更、compaction、分页中改写、source 丢失及重试。
4. **项目与拓扑：** provider project ID、session.directory、parentID 是来源事实；通过 Host Git attribution 再判断范围，单独决定 fork/child Session 如何映射 Canonical。viewer 的按目录分组和“当前 Session 的孩子豁免”不可直接继承。
5. **失败与规模：** 继承失败≠空集、source 隔离、bounded traversal 的思路；避免为接入先另建一个可丢弃搜索数据库。ATape 的 Search 保持 Canonical-derived，与 Raw source archive 分离。

本票可以回答“竞品实际怎么接、哪些设计值得借鉴”；它没有证明目标 OpenCode 版本的完整兼容性，也没有确定第一版交付范围。决定这些内容仍需结合官方存储/API 调查与用户讨论。

[cchv-readme]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/README.md#L73-L87
[cchv-path]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/src-tauri/src/providers/opencode.rs#L139-L179
[cchv-merge-project]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/src-tauri/src/providers/opencode.rs#L195-L265
[cchv-merge-session]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/src-tauri/src/providers/opencode.rs#L327-L397
[cchv-global]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/src-tauri/src/providers/opencode.rs#L25-L137
[cchv-global-query]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/src-tauri/src/providers/opencode.rs#L903-L959
[cchv-child]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/src-tauri/src/providers/opencode.rs#L450-L503
[cchv-open]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/src-tauri/src/providers/opencode.rs#L830-L840
[cchv-watch]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/src-tauri/src/commands/watcher.rs#L291-L298
[cchv-watch-root]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/src-tauri/src/lib.rs#L1066-L1082
[cchv-messages]: https://github.com/jhlee0409/claude-code-history-viewer/blob/fdfc766ce7f0d76dceb03087aedac47add33d61b/src-tauri/src/providers/opencode.rs#L1028-L1155
[as-guide]: https://github.com/jazzyalex/agent-sessions/blob/6f9b6c72d0512bb01881f0b66120816db9e89f2f/docs/guides/opencode-sqlite-history.html#L102-L124
[as-detect]: https://github.com/jazzyalex/agent-sessions/blob/6f9b6c72d0512bb01881f0b66120816db9e89f2f/AgentSessions/OpenCode/OpenCodeBackendDetector.swift#L18-L108
[as-refresh]: https://github.com/jazzyalex/agent-sessions/blob/6f9b6c72d0512bb01881f0b66120816db9e89f2f/AgentSessions/Services/OpenCodeSessionIndexer.swift#L134-L163
[as-list]: https://github.com/jazzyalex/agent-sessions/blob/6f9b6c72d0512bb01881f0b66120816db9e89f2f/AgentSessions/OpenCode/OpenCodeSqliteReader.swift#L13-L161
[as-fresh]: https://github.com/jazzyalex/agent-sessions/blob/6f9b6c72d0512bb01881f0b66120816db9e89f2f/AgentSessions/Services/OpenCodeSessionIndexer.swift#L289-L312
[as-identity]: https://github.com/jazzyalex/agent-sessions/blob/6f9b6c72d0512bb01881f0b66120816db9e89f2f/AgentSessions/Search/SearchIngestService.swift#L16-L54
[as-reconcile]: https://github.com/jazzyalex/agent-sessions/blob/6f9b6c72d0512bb01881f0b66120816db9e89f2f/AgentSessions/Search/SearchIngestService.swift#L440-L466
[as-wal]: https://github.com/jazzyalex/agent-sessions/blob/6f9b6c72d0512bb01881f0b66120816db9e89f2f/AgentSessions/Services/UnifiedSessionIndexer.swift#L1288-L1306
[as-messages]: https://github.com/jazzyalex/agent-sessions/blob/6f9b6c72d0512bb01881f0b66120816db9e89f2f/AgentSessions/OpenCode/OpenCodeSqliteReader.swift#L164-L334
[hs-readme]: https://github.com/joeyism/opencode-history-search/blob/bf191ae22f2b35ecb5110b5fe18b72fd5423b6a0/README.md#L1-L60
[hs-provider]: https://github.com/joeyism/opencode-history-search/blob/bf191ae22f2b35ecb5110b5fe18b72fd5423b6a0/src/storage-provider.ts#L1-L48
[hs-sqlite]: https://github.com/joeyism/opencode-history-search/blob/bf191ae22f2b35ecb5110b5fe18b72fd5423b6a0/src/storage-sqlite.ts#L6-L160
[hs-json]: https://github.com/joeyism/opencode-history-search/blob/bf191ae22f2b35ecb5110b5fe18b72fd5423b6a0/src/storage.ts#L6-L105
[hs-fuzzy]: https://github.com/joeyism/opencode-history-search/blob/bf191ae22f2b35ecb5110b5fe18b72fd5423b6a0/src/search/fuzzy.ts#L15-L125
[hs-multi]: https://github.com/joeyism/opencode-history-search/blob/bf191ae22f2b35ecb5110b5fe18b72fd5423b6a0/src/search/multiterm-sql.ts#L1-L116
[recall-readme]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/README.md#L8-L12
[recall-client]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/opencode-session-recall.ts#L190-L214
[recall-discovery]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/opencode-session-recall.ts#L245-L262
[recall-limits]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/types.ts#L79
[recall-distill-head]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/distill.ts#L24-L112
[recall-page]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/distill.ts#L568-L598
[recall-fetch]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/distill.ts#L787-L867
[recall-children]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/sessions.ts#L51-L229
[recall-cold]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/distill.ts#L1062-L1101
[recall-retry]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/distill.ts#L1172-L1204
[recall-lease]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/distill.ts#L1305-L1339
[recall-events]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/distill.ts#L1428-L1451
[recall-update]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/distill.ts#L1250-L1303
[recall-store-head]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/store.ts#L4-L51
[recall-store-open]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/store.ts#L564-L595
[recall-store-write]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/store.ts#L702-L716
[recall-store-path]: https://github.com/rmk40/opencode-session-recall/blob/8a5ccd63a62e7af1de65fb70f43b6a66b2d485d2/src/store.ts#L925-L941
[official-sdk]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/sdk/js/src/v2/gen/sdk.gen.ts#L3701-L3736
[official-page]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/message-v2.ts#L425-L465
[official-cli]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/cli/cmd/run.ts#L863-L870
[official-tui]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/tui/src/component/prompt/index.tsx#L1092-L1112
[official-server]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/server/routes/instance/httpapi/server.ts#L276-L306
[official-v2-api]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/protocol/src/groups/session.ts#L129-L142
[official-v2-table]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/sql.ts#L119-L138
