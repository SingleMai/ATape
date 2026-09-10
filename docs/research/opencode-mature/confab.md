# Confab 的 OpenCode 接入、故障修复与可迁移边界

## 核心判断

Confab 提供了一条已经发布、具备真实缺陷修复记录的路线：**OpenCode 插件只负责唤起 daemon，daemon 只读 SQLite，把首次达到完成条件的消息固化成本机 append-only JSONL，再交给已有脱敏和按行上传模块。** 它的主要经验是复用一个已有稳定文件 Interface，把异构来源的复杂性放在 producer；并非证明 SQLite 最新投影本身满足任意可变历史的确定性重放。[^1][^2][^3]

这条路线的关键成本是本地内容副本，以及“不再追踪已经发出消息的后续修改”的语义限制。当前 collector 用 message ID 高水位排除旧行，没有面向改写、删除或 revision 的再发布路径。ATape 如原样移植，会引入现有无内容队列契约之外的持久内容存储，并削弱 Canonical 修订语义。[^1][^4]

Confab 值得作为有修复证据的工程案例，**不足以作为被广泛采用的成熟事实标准**。截至 2026-09-10，公开仓库为 8 stars、4 forks，最近 push 是 2026-06-17；最近 release 有构建和 CI 成功记录，但无法由此推出大规模部署、长期兼容或完整故障恢复已经得到证明。[^5][^6]

## 版本、发布与文档冲突

| 核验项 | 已核验结果 | 解释 |
| --- | --- | --- |
| 默认分支 HEAD | `6ea943ce8ee3328162909e16f3444fbd247f3094` | 后文 Confab 源码链接固定此 commit |
| 最新 release | `v0.17.3`，2026-06-17 16:58:28 UTC | tag 同样指向上述 SHA；此次不是“main 有、release 没有” |
| release CI | CI 和 Release workflow 均 success | 证明该 commit 的公开工作流结果，不代表重新运行全部生产矩阵 |
| 构建目标 | Linux/macOS，amd64/arm64，`CGO_ENABLED=0` | SQLite driver 为纯 Go `modernc.org/sqlite`；没有发布 Windows 目标 |
| 上一个 release | `v0.17.2` | 到 v0.17.3 的增量包含 OpenCode offline list/save；因此旧版本 live-only 描述有历史背景 |
| 根 README | 仍称 live-only、root-only | 与同一发布 commit 的源码和合并 PR 冲突，不能据此判断当前能力 |

发布/tag、workflow 与构建依据见来源。[^6][^7] 根 README 的旧限制位于 133–136 行；当前 `Opencode.ScanSessions/FindSessionByID` 已实现离线 list/save，子会话已通过 root daemon 的 sidechain collectors 采集。README 的“root-only”只能与“只有 root 启动独立 daemon”部分吻合，不能解读成“不保存 children”。[^8][^9][^10]

这是一条影响选型的证据：只读产品主页会同时低估已有能力、漏掉实际约束。更可靠的比较单位是固定发布源码、对应修复 PR 和可阅读的测试断言。

## 实际管线

```text
OpenCode 生命周期事件
  → confab-sync.ts 插件
  → confab hook session-start --provider opencode
  → root daemon / root 与 child collectors
  → SQLite message LEFT JOIN part
  → ~/.confab/opencode/<root>/messages.jsonl
  → FileTracker.ReadChunk 脱敏
  → UploadChunk(file_name, first_line, lines)
  → backend last_synced_line receipt
```

### 插件与 daemon

插件监听 `session.created` 的快速路径，用 inline directory/parentID 启动；恢复会话则依靠 `session.status/updated/compacted/error` 白名单信号，把空 CWD 留给 Go 侧从 DB 查询。它在内存中保存 `running` Set，传 `process.pid`，每个插件进程最多记住 32 个 daemon；dispose 对已知会话发 session-end。`session.idle` 不结束 daemon，因为它在一次回答后就会发生。[^11]

Go 侧只为 root 启动独立 daemon；child 通过 `session.parent_id` 递归发现，注册为 `file_type=agent`、`file_name=opencode/<child>/messages.jsonl`，复用 root 的后端 Session。能力由后端 `opencode_subagent_files` 控制；能力未开放时跳过 child 注册和 collector。[^10]

root/child collector 默认每 30 秒读取一次；daemon 拥有它们的取消与等待。parent liveness 有独立检测 goroutine，收尾取消 collectors，再执行最终后端同步。必须区分“能并发检测 parent 死亡”与“任意阻塞请求下固定 5 秒完成 shutdown”：当前主循环内 `SyncAll()` 仍是同步调用，检测信号的处理要等主循环回到 select；PR 的目标描述不是更强的超时证明。[^12]

### 数据读取

`OpenCodeDBReader.ReadSession` 每次开库、单条 LEFT JOIN、关闭；DSN 使用 `mode=ro` 和 5000ms busy_timeout。单条 query 把 message/part 读成同一 SQLite 语句视图，比跨 API 请求分别拉 message/part 少一个混合版本窗口，但不保证 provider 的一个完整业务消息已经写完。[^2]

查询限定 `session_id` 和 `m.id > highWaterMark`，按 `message.time_created,message.id,part.id` 排序；collector 随后再按 message ID 排序。读取没有 SQL LIMIT，结果先组装进 slice，再序列化整个待追加 batch。因此上传是分块的，**初次物化并不具备 ATape 式 bounded pull 内存/字节上界**。代码注释把 ID lexical order 当时间顺序；这是一项来源假设，不能外推成任意 import/改写均严格单调。[^1][^2]

它将 row columns 的 id/sessionID/messageID 注入 JSON，保留其它 JSON 字段；这是一种 provider transcript 编码，不是数据库文件的原始 bytes。它读取 `message/part`，没有读取 OpenCode durable `event` 或 `session_message` 的路径，也没有启动官方 Server/SDK。[^2]

定位顺序是 `CONFAB_OPENCODE_DB`、`XDG_DATA_HOME/opencode/opencode.db`、用户默认数据目录。它没有原样实现 OpenCode 自身 `OPENCODE_DB` 或 channel DB 命名规则；其它来源可由 Confab 显式 override 指定。[^13]

## 可变消息如何被转成 append-only 文件

完成判定是：非 assistant 立即可发；assistant 在 `finish != nil` 或有非 null error 时可发。tool part 只保留 completed/error，其余类型按 JSON 保留。遇到第一个未完成 message 停止本轮，即使后面已经有完成消息也不越过。[^3]

collector 把每个可发 message 写成一行，使用 `O_APPEND|O_CREATE|O_WRONLY`，目录权限 0700，文件权限 0600；成功 `Write` 后将 ID 记入 emitted Set 并推进 HWM。启动 seed 从现存 JSONL 重建 Set 和最大 ID。因此文件本身同时承担内容副本与恢复索引来源；不是只有一个 metadata checkpoint。[^1]

| 场景 | 已实现行为 | 不能由此承诺的行为 |
| --- | --- | --- |
| assistant 正在流式生成 | 暂停于该 ID，后续轮询等 finish/error | 不提供任意中途碎片实时回放 |
| 完成消息首次出现 | 写一次完整 envelope | finish 不等于上游永久不可变 |
| 已发 message 后来改文本或新增 part | SQL HWM 和 emitted Set 不再读取它 | 不反映后来的修订，不开启新 generation |
| 旧 ID 被回填/import | 不大于 HWM 则不会重新采集 | 不能保证离线补写的历史完整性 |
| 源 message/part 被删除 | 已物化文件不回删 | 保留曾采集历史，但不维护最新源投影 |
| 最早未完成 assistant 永不结束 | gap-stop 阻止更晚消息 | 可能永久停滞；不能称完整持续同步 |
| 本地内容副本遗失 | seed 无法恢复此前 envelope 内容 | 重新查 DB 只能得到此时值，与原已上传行未必相同 |

前三类直接来自公开 Implementation，其结果是分析推论而不是维护者明确承诺的产品行为。[^1][^2][^3] 例如：先读到 user row、尚无 part，也会被当 complete 输出；之后新增 part 使用同一 message ID，HWM 已越过该行。只读快照解决 SQL 一致性，不能解决这种业务分步提交的完整性问题。

测试确实覆盖“未完成→完成”以及 restart 不重复；但 restart 测试使用相同 envelopes，并没有把“已写完的 message 之后变内容”纳入回归。不能把这个测试解释成 arbitrary mutable snapshot 恢复证明。[^14]

## 上传失败、重启与持久性

backend Init 返回每个文件 `last_synced_line`。FileTracker 从第零 byte 重新扫描并跳过已确认行，第一次成功读后可使用本地 byte offset；UploadChunk 成功才更新 LastSyncedLine/ByteOffset。上传失败时，除 auth/not-found 类错误外，engine 刷新 backend state，以处理服务端已经存储但响应丢失的情况。[^4][^15]

所以**正常 daemon 重建后，在 materialized JSONL 完整保留的条件下**，先 seed 物化状态，再通过 backend receipt 恢复上传位置，是一条实际存在的恢复路径。子会话集成测试把 backend child last_synced_line 设为 1，检查恢复后不重复之前行。[^16]

本地 daemon State 保存 provider、session ID、path、PID/parentPID、CWD、backend session ID 等；它不保存完整 upload page，也不负责物化文件的逐行 fsync 协议。shutdown 清理的是 state/inbox，未删除 materialized transcript；因而最终同步失败后内容通常仍在本地，但需要后续 resume 或 save 再触发上传。没有证据表明 parent 结束后会有独立全局队列 worker 持续重试所有 pending 文件。[^17][^12]

当前 append 循环没有显式 `f.Sync()`，seed 遇坏 JSON 行会 continue，Run 遇 seed 错误会 warn 后继续；没有在该路径看到原子提交标记、校验尾部修复或跨电源故障的 fsync/rename 协议。**可以说有普通进程重启的文件 seed 机制，不能说已证明主机断电、半行写入、文件损坏、policy 更新后仍有严格同 payload replay。**[^1]

**磁盘生命周期：** 物化文件只追加本 Session 新完成的 envelope，不复制整个 DB，也不每次轮询重写全量快照，因此其增长模式与重复 DB snapshot 不同。但在已核验的 collector、daemon shutdown、state reaper 和安装/删除命令路径中，没有看到针对 `~/.confab/opencode/` 的大小 quota、TTL、成功上传后 trim 或保留期回收；shutdown/reaper 只删运行 state/inbox，UninstallHooks 只删插件。不能假定已上传 journal 会自动清理。实现把 child 放在 root 目录下“便于 cleanup”的注释不等于已实现 root 内容回收。[^1][^12][^25]

ReadChunk 读取时执行脱敏，而非物化时。启用默认 secret regex/字段规则不能让本地 JSONL 变成已脱敏副本；其风险模型是用本机权限保护内容，再在上传前过滤。脱敏规则可配置甚至关闭，变化后的重读也可能生成不同字节。Init 还会发送 CWD、Git 信息、hostname、username；这与上传行内 secret redaction 是不同的数据面。[^4][^15][^18]

上传默认上界 14 MiB，单行超限返回错误；读取 collector 的全 session slice 无相同上界。child 递归 discovery 有 1000 行 cap，但并非整个流水线都有统一资源界限。不要把网络 chunk limit、SQLite query bound 和 durable queue capacity 混为一谈。[^2][^10][^15]

## 公开缺陷与修复链

### CF-543：HTTP/SSE 路线改为 SQLite

**触发事实的公开载体：** [PR「Rewrite OpenCode integration to read SQLite (not HTTP)」](https://github.com/ConfabulousDev/confab/pull/62)，2026-06-06 合并，修复 commit `0042d95f10e33c73fb7530f8cf7f959a2c3c2c22`。作者报告先前 HTTP/SSE collector 对典型用户无法同步，关联内部 Linear CF-542；因此移除 server_url、SSE 和重连逻辑，改为本机 SQLite。[^19]

**证据边界：** “OpenCode v1.1.10 起本地 HTTP server 默认关闭”是该 PR 对当时故障的描述，不能当作现行 OpenCode 全版本的事实；官方当前 Server 行为须独立核验。外部不能访问的内部 issue 和作者本机 690 envelopes smoke 不构成独立复现。更有力的公开证据是实际 patch 和回归 fixture。

**修复与测试：** 单 LEFT JOIN＋identity injection＋HWM；新增真实 SQLite fixture builder、reader identity/session filter/HWM 测试，以及 daemon materialize→mock backend upload 集成测试。[固定 release reader 测试][reader-tests] 与 [daemon 实际断言][daemon-tests] 验证注入 ID、读取正确 Session 和产物被上传。它证明换来源而保留 materialized file Seam 已落地，不证明保留每一次源修改。[^19]

### CF-549：恢复旧 Session 不触发 created

**触发：** [PR「Resume OpenCode sessions via reconcile + orphan hardening」](https://github.com/ConfabulousDev/confab/pull/64)，2026-06-07 合并，修复 commit `a7fd3ac0587a009adba5636b09937fefc3590ab3`。旧逻辑只认 session.created；新 OpenCode 进程恢复已有 Session 时不再创建，因此 daemon 没启动，后续数据静默缺失。[^20]

**修复：** 插件对白名单 session 活动信号调用 spawn，running Set 去重；Go 从 SQLite 恢复 cwd/parent；plugin 传权威 parent_pid；新增 stale-state reaper、32-daemon cap、多进程 resume warning。provider-specific 变化收敛在插件、provider 和 daemon 生命周期，未改上传 file Interface。[^11][^20]

**回归断言：** 插件测试检查 `session.status` 产生一个带 session_id、空 cwd、process.pid 的 start 命令，updated/compacted/error 也触发；deleted/diff/idle/message.updated 不触发；重复/并发事件去重。DB reader 单测验证 cwd/parent/null parent/not-found；reaper 测试覆盖 dead PID 删除、live PID 保留和 5 秒保护窗。[^21]

**仍未证明：** PR 的五项人工验收（新进程 resume、真实父进程退出、多进程同会话等）复选框仍未勾选，Go/TS/static checks 已勾选。公开回归主要验证命令与 fixture，不应写成完整真实 OpenCode 版本矩阵已验收。[^20]

### CF-545：最后一次轮询到 shutdown 之间丢尾消息

**触发：** [PR「Final SQLite reconcile on OpenCode collector shutdown」](https://github.com/ConfabulousDev/confab/pull/65)，2026-06-07 合并，修复 commit `dce14067c469d00b530a1749339593cf12657f6d`。collector 收到取消立即退出，daemon 随后的最终 SyncAll 只能看到旧文件，DB 中刚完成的新消息从未物化。[^22]

**修复：** ctx.Done 路径用新的 background context 再 reconcile，然后退出；daemon 对 collectors 的等待有共同约 2 秒上界，再执行最终同步。不是将数据库与远端提交做成原子事务。[^1][^12]

**回归断言：** `TestCollectorFinalReconcileOnShutdown` 用长轮询间隔、先写 msg_1，再添加 msg_2 后取消，断言两行；`TestDaemonOpenCodeFinalReconcileCatchesLateMessages` 使用真实 SQLite fixture、mock HTTP backend，先运行、后插 msg_2、取消，断言本地两行且上传总计两行。[^23]

**限制：** 集成测试有 sleeps 和运行中的 ticker，因此不能排除 msg_2 恰好被普通 tick 捕获；长间隔单测更直接隔离了 final reconcile 行为。2 秒只是 daemon 等待上限，background reconcile 不因该超时被强制取消；DB busy timeout 是 5 秒。这是尽力收尾，不是无损停机证明。[^1][^2][^12][^23]

## 已发布支持面与验证强度

| 维度 | 当前 release 的实际选择 | 验证强度 / 局限 |
| --- | --- | --- |
| 历史导入 | v0.17.3 支持 list/save；descendant ID 上溯 root；按需物化 | PR87＋provider/cmd fixtures；已物化旧内容不刷新 |
| 子会话 | root daemon 管理 descendant collectors，能力门控 sidechains | PR66＋真实 SQLite/mock backend 集成；须后端 capability |
| 来源 schema | `session/message/part`，JSON unknown fields 尽量保留 | reader 注释只明示 query plan 验证 OpenCode v1.15.13；无完整版本支持矩阵 |
| 扫描排序 | message ID HWM；未完成 gap-stop | 有顺序/去重测试；缺已完成消息改写/后补 part 的回归 |
| retry | 稳定本地文件＋服务端行号 | 有正常 restart、上传错误后 receipt refresh；不是无内容队列方案 |
| 安全 | 0600 文件、0700 目录、上传时可配置脱敏 | 本地保存未脱敏 transcript；没有证明 at-rest encryption |
| runtime | Go binary＋TS 插件；无独立 HTTP 服务依赖 | 安装仍改变 OpenCode plugin directory，需要 provider 生命周期协作 |
| 维护 | 小型公开项目、有快速修复、CI 和 tags | README 已落后，最新代码早于 OpenCode v1.18.30，不能自动宣称兼容 |

离线和子会话的实现及测试分别来自 PR87、PR66。[^9][^10] 插件 TypeScript 编译针对仓库自写 `@opencode-ai/plugin` declaration，且 Event 联合含宽泛 fallback；CI 通过并非针对实际最新官方 Plugin SDK 的严格兼容检验。[^24]

CI workflow 在 Ubuntu 装 Go 1.26.3、Node 22，安装插件测试依赖，运行 `go test ./...` 与 staticcheck。最新 release commit 的 CI 成功，是正面工程信号；工作流没有显示 macOS/Windows/OpenCode release 版本矩阵，不能混写为全部平台测试覆盖。[^6][^24]

## 对 ATape 的可迁移结论

**可借鉴的生产经验：** 不把 lifecycle 事件当可靠唯一历史来源；恢复会话要 reconcile；只读 SQLite 将 source dependency 留在 Adapter；单语句读取避免多请求拼接；read failure 要可观察；退出前尽力 drain；child 归 root 由能力门控；上传失败向 backend 重新取 receipt。每一项都能对应公开修复或测试。[^19][^20][^22]

**不能直接继承的保证：** Confab file Interface 有本地内容副本、只发首次完成态、按行 receipt；ATape 同 committed cursor 的 source bytes、Canonical revision、Raw generation 和原始归属是另一份契约。两者都有“增量上传”不意味着重试身份、修改语义、redaction policy 固定性或源丢失行为相同。

Confab 因此支持“SQLite 是可行的现实读取渠道、materialized transcript 是有人实际采用的折衷”这两个结论；它不支持“成熟竞品已证明无需讨论就能用 SQLite 最新行适配 ATape”或“必须新增本地 payload spool”的结论。是否接受副本与首次完成态，仍需 ATape 自己明确产品与架构取舍。

## 来源

[^1]: ConfabulousDev，`opencode_collector.go`，固定 release SHA 6ea943c，2026-06-17：[seed/reconcile/append/Run](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_collector.go#L17-L203)。
[^2]: ConfabulousDev，同版本：[SQLite reader/query](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_db.go#L17-L150)、[只读打开](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_db.go#L467-L482)。
[^3]: ConfabulousDev，同版本：[完成判定、tool 筛选、排序](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_session.go#L89-L160)。
[^4]: ConfabulousDev，同版本：[上传、失败刷新、成功推进](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/sync/engine.go#L350-L423)。
[^5]: GitHub，Confab 仓库统计，2026-09-10 查询：[repository API](https://api.github.com/repos/ConfabulousDev/confab)。
[^6]: ConfabulousDev，2026-06-17：[v0.17.3 release](https://github.com/ConfabulousDev/confab/releases/tag/v0.17.3)、[tag API](https://api.github.com/repos/ConfabulousDev/confab/git/ref/tags/v0.17.3)、[CI success](https://github.com/ConfabulousDev/confab/actions/runs/27671512069)、[Release success](https://github.com/ConfabulousDev/confab/actions/runs/27705658027)。
[^7]: ConfabulousDev，同版本：[构建 targets](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/.goreleaser.yaml#L1-L22)、[v0.17.2 到 v0.17.3](https://github.com/ConfabulousDev/confab/compare/v0.17.2...v0.17.3)。
[^8]: ConfabulousDev，同版本：[仍过时的根 README 限制](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/README.md#L117-L136)。
[^9]: ConfabulousDev，2026-06-17：[PR87 离线支持](https://github.com/ConfabulousDev/confab/pull/87)、[实际 Scan/Find](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode.go#L329-L393)、[save 回归](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/cmd/save_opencode_test.go#L68-L182)。
[^10]: ConfabulousDev，2026-06-08：[PR66 subagent sidechains](https://github.com/ConfabulousDev/confab/pull/66)、[child registrar/capability](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/opencode_children.go#L66-L127)、[discovery](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode.go#L145-L211)。
[^11]: ConfabulousDev，同版本：[实际插件](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/plugins/confab-sync.ts#L1-L94)、[idle regression](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/plugins/confab-sync.test.ts#L144-L165)。
[^12]: ConfabulousDev，同版本：[parent detection](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/daemon.go#L178-L194)、[loop](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/daemon.go#L321-L370)、[shutdown](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/daemon.go#L526-L615)。
[^13]: ConfabulousDev，同版本：[DB path resolver](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_db.go#L485-L502)。
[^14]: ConfabulousDev，同版本：[gap-stop / restart 单测](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_collector_test.go#L97-L159)。
[^15]: ConfabulousDev，同版本：[Init/receipt](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/sync/engine.go#L211-L268)、[tracker receipt](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/sync/tracker.go#L72-L119)、[chunk/redaction](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/sync/tracker.go#L290-L466)。
[^16]: ConfabulousDev，同版本：[child restart resume](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/opencode_integration_test.go#L320-L370)。
[^17]: ConfabulousDev，同版本：[daemon State 字段](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/state.go#L17-L43)。
[^18]: ConfabulousDev，同版本：[redaction 用户说明](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/REDACTION.md#L1-L45)。
[^19]: ConfabulousDev，2026-06-06：[PR62](https://github.com/ConfabulousDev/confab/pull/62)、[修复 commit](https://github.com/ConfabulousDev/confab/commit/0042d95f10e33c73fb7530f8cf7f959a2c3c2c22)。
[^20]: ConfabulousDev，2026-06-07：[PR64（含未勾人工验收）](https://github.com/ConfabulousDev/confab/pull/64)、[修复 commit](https://github.com/ConfabulousDev/confab/commit/a7fd3ac0587a009adba5636b09937fefc3590ab3)。
[^21]: ConfabulousDev，同版本：[resume tests](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/plugins/confab-sync.test.ts#L220-L364)、[ReadSessionInfo tests](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_db_test.go#L679-L754)、[reaper tests](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/reaper_test.go#L40-L137)。
[^22]: ConfabulousDev，2026-06-07：[PR65](https://github.com/ConfabulousDev/confab/pull/65)、[修复 commit](https://github.com/ConfabulousDev/confab/commit/dce14067c469d00b530a1749339593cf12657f6d)。
[^23]: ConfabulousDev，同版本：[final reconcile 单测](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_collector_test.go#L255-L290)、[真实 SQLite/mock backend 集成断言](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/opencode_integration_test.go#L374-L440)。
[^24]: ConfabulousDev，同版本：[CI workflow](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/.github/workflows/ci.yaml#L1-L36)、[本地 Plugin types](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/plugins/types/opencode-plugin.d.ts#L1-L71)。

[^25]: ConfabulousDev，同版本：[root/child 内容路径](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode.go#L195-L211)、[卸载只删除插件](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode.go#L75-L85)、[state/inbox 删除](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/state.go#L168-L198)、[reaper](https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/reaper.go#L17-L45)。

[reader-tests]: https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/provider/opencode_db_test.go#L20-L235
[daemon-tests]: https://github.com/ConfabulousDev/confab/blob/6ea943ce8ee3328162909e16f3444fbd247f3094/pkg/daemon/opencode_integration_test.go#L37-L137
