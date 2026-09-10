# OpenCode 1.18.30 受控原生 fixture 观察

核验日期：2026-09-10。此目录是[验证 OpenCode 有界采集在改写与重启后的可重放性](https://github.com/SingleMai/ATape/issues/115)的独立研究原型，不是生产 Adapter，不使用测试框架。

## 复现与产物

在本 worktree 执行：

```sh
rtk proxy python3 packages/application/prototypes/opencode-native/download.py
rtk proxy python3 packages/application/prototypes/opencode-native/generate.py --binary /上一步输出的临时目录/opencode
```

`download.py` 仅支持本次验证的 Darwin arm64，下载固定官方 zip，核验 SHA256 后解压到新 scratch；不改安装。
`generate.py` 使用 Python 标准库，参数指定 binary，先断言 `--version` 为 `1.18.30`，每次另建私有 scratch。
运行生成的 ID、时间、slug 和目录随机，复现承诺的是工作流、字段结构和验证断言，不是逐字节相同的 DB。

本次最终成功运行的 scratch：

`/var/folders/xw/9981n9gn1tdb6t730q926xcc0000gn/T/atape-opencode-native-11830-sidb0u9u`

| 产物 | 内容 |
| --- | --- |
| `manifest.json` | 精确版本、平台、dbPath、规范化 projectPath、rootID、childID、forkID、mutableMessageID、mutablePartID、计数和资源观察 |
| `source/data/opencode/opencode.db` | 官方 binary 自行迁移建表，经官方 HTTP API 写入的原生 DB；生成脚本不执行 SQL 写入 |
| `api-evidence.json` | 本次 API 请求、响应、状态；均为明确构造的公开测试文本，不含私人历史 |
| `exports/{root,child,fork}-api.json` | 最终官方消息 API 返回值 |
| `exports/{root,child,fork}-export.json` | 关闭 server 后，由新的官方 `opencode export <ID>` 进程导出 |
| `exports/*-export.stderr`、`server.log` | 官方运行输出；未把这些运行日志当作会话 Raw |

早期成功 scratch `.../atape-opencode-native-11830-tnzui_tb` 也保留供已经开始工作的读取者使用；最终这份增加了开放 metadata sentinel 和内置 SQLite/export 对照。
两份 DB 均已关闭原生 server；不删除 scratch。下游需要改变数据时另复制并明确标记“合成 mutation”，不得称为此次原生 API 产物。

## 固定版本与隔离

- 平台：`macOS-26.3.2-arm64-arm-64bit`。
- [官方 v1.18.30 release](https://github.com/anomalyco/opencode/releases/tag/v1.18.30)，[固定 tag 源码](https://github.com/anomalyco/opencode/tree/3104c1428ec91f809e5ab86631300de41eb6952e)。缓存源码 HEAD 也是这个 commit。
- 官方 `opencode-darwin-arm64.zip` SHA256：`a5e43d6887386efc7d68ce49ae28e3bbdfdee3dfd1d7169b612c3ce67e53b1e8`；解压 binary SHA256：`2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`。
- 此证据固定了 release asset、tag 源码和 binary 自报版本；没有自行重建或证明上游 release binary 与 tag 的可复现构建关系。release API 的 `target_commitish` 与 tag commit 不同，不把它误作 tag SHA。
- 子进程环境从白名单新建，不继承 provider keys、用户 auth/config、代理；HOME、OPENCODE_TEST_HOME、全部 XDG、TMPDIR 均指向 scratch。未更改父进程环境或用户安装。
- 关闭项目配置、默认插件、自动更新、远程模型列表、自动 compaction、文件 watcher；只启用 `fixture` provider，baseURL 为 loopback。
- compaction 唯一模型请求是本机 HTTP stub 的固定响应，不调用真实/付费模型。该事实由配置和 stub 请求记录支持；未做全机网络抓包证明。
- 普通配置隔离方式参照[上游 CLI 测试 helper](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/test/lib/cli-process.ts#L64-L79)。

## 原生操作与结果

| 操作 | 实际路径与结果 | 证据边界 |
| --- | --- | --- |
| Root、child | `POST /session`，child 显式 `parentID` 指 root；child 有自己的原生 user message | 验证 parent 元数据，不代表模型真的执行了 task/subagent tool |
| User message | `POST /session/:id/message`，`noReply:true`、中文/emoji/换行 | 真正原生 prompt 写入，不请求模型 |
| 可变 text part | 同 part ID `PATCH` 从文本 A 改为 B | 当前 part 只剩 B；官方 `event` 中 seq 3/5 分别保留 A/B，证明此次路径有持久更新事件 |
| 未知字段 | PATCH 顶级 `atapeFixtureUnknown` 被 schema 丢弃；`metadata.atapeFixtureUnknown` 完整保留嵌套数组、布尔和 null | 只能验证 schema 允许的开放 metadata，不能把被丢字段当作 Raw 保真通过 |
| Tool | `POST /session/:id/shell` 只执行受控 `printf`；官方生成 user、assistant、bash tool，并完成 running→completed | 没有任意工程命令；不是模型选择 tool 的验证 |
| Fork | `POST /session/:id/fork` 在 compaction 前复制已有 3 messages，产生新 message/part IDs | fork 的 `parentID` 缺失；不能凭 “fork” 名称将其当 child |
| Revert/unrevert | 原生 revert 设置 session.revert；GET messages 前后均为 3 条，之后 unrevert 清除标记 | 本 fixture 没有真实文件 diff，不能证明磁盘文件回滚效果；未执行 revert 后 prompt 的 cleanup 删除路径 |
| Compaction | 原生 `/summarize` 返回 true，本地 stub 接到 1 次 `/v1/chat/completions` 流请求 | 真正运行官方 compaction 编排，但摘要文本是受控固定值，不验证摘要质量 |
| Restart/export | 终止原生 server 后，新 CLI export 进程重新打开 DB 并成功导出三个 session | 验证正常进程切换后的持久化；没有 SIGKILL、掉电或 WAL 损坏试验 |

TextPart 的开放 metadata 见[官方 schema](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/schema/src/v1/session.ts#L102-L115)。
无模型 user 写入由 [noReply 分支](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/prompt.ts#L1069)支持。
shell 原生写入逻辑见[用户、assistant、running tool 的创建](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/prompt.ts#L451-L522)。

## SQLite / API / export 三方对照

脚本通过 `sqlite3.connect(file:...?mode=ro)` 读取官方 DB，按 `(time_created,id)` 排 message、按 id 排 part，将主键/外键列注回 JSON。逐对象断言其结果与官方 export 的 `messages` 完全相同，同时断言 API 与 export 相同。三会话全部通过，未使用自行造表的替身。

最终计数：session **3**、message **9**、part **11**、event **37**、event_sequence **3**、session_message **0**，journal_mode **wal**。
`event` 类型计数：`message.part.updated.1=15`、`message.updated.1=12`、`session.created.1=3`、`session.updated.1=7`。
这验证本次普通 CLI/API 运行的 legacy message/part 投影和持久 event 同时活跃，不能外推所有历史 import/migration 的 event 都完整。

root 最终 5 messages：原始 user、shell 合成 user、shell assistant、compaction user、summary assistant。
summary assistant 有 `summary:true`、`finish:"stop"`，其 parts 为 step-start、text、step-finish；compaction 标记是单独 user message 的 compaction part。
**shell assistant 已有 `time.completed` 且 tool completed，却没有 `finish` 字段**；不能把 `finish` 当作所有 assistant 完成的必要条件。
child 1 message；fork 3 messages。官方 root export 不递归包含 child，脚本显式分别导出。

macOS 将 `/var/...` 规范化为 `/private/var/...`；最终 manifest 的 `projectPath` 取原生 session.directory，另保留 requestedProjectPath。
scratch 不在 Git repo，`projectID="global"`，assistant.path.root 为 `/`；实际 CWD 仍是隔离 project。匹配项目时不可用 root 代替 cwd。

## 资源与验收范围

最终 DB 主文件 **274432 bytes**；本次生成阶段 **2.221 s**（server 启动到关闭，另计 export）。子进程最大 RSS 记录 **571211776 bytes**，为 macOS getrusage 子进程峰值，覆盖 version/server/export；不是 Collector 内存，也不是跨平台性能基准。
输入很小，此运行不证明巨型 part、海量会话、有界分页、spool 配额、发送失败/政策切换或原子发布等 Collector 性能和一致性契约。
本子任务不修改生产文件、不提交 Git；后续父任务可用这份原生 DB 检验公开 Collector Interface，并把故障注入/直接 SQLite mutation 与本报告的原生创建事实明确区分。

## 同一 fixture 的有限路线成本比较

新增 `benchmark.py` 与机器可读 `benchmark-results.json`（约 7.5 KB，含每个进程的 wall、RSS、stdout、系统块操作计数）。复现：

```sh
rtk proxy python3 packages/application/prototypes/opencode-native/benchmark.py --manifest /var/folders/xw/9981n9gn1tdb6t730q926xcc0000gn/T/atape-opencode-native-11830-sidb0u9u/manifest.json --binary /tmp/atape-opencode-native-11830-bin/opencode
```

每轮 SQLite 路线启动一个独立 Python 进程，在一个只读事务中完整 hydrate 三个会话的全部 message/part；export 路线依次启动三个独立官方 binary 进程，每个导出一个会话。共三轮，第二轮交换路线顺序。没有清空 OS 文件缓存，两路线都读取已经生成并核验过的小 fixture；没有执行 SQL 写入、调用模型或读取私人历史。

每个被测进程都单独由 macOS `/usr/bin/time -l` 测峰值 RSS，原始 `.time` 留在 manifest scratch 下 `benchmark-*` 目录；不使用累积 `RUSAGE_CHILDREN`。wall 用父进程单调时钟，包含启动和读取输出。路线 wall 还包含本路线结果解码、规范化及少量计量开销；路线 RSS 是顺序运行子进程峰值的最大值，不是相加，也不是父进程的峰值。

| 轮次 | SQLite 三会话 wall / ms | SQLite peak RSS / bytes | export 三会话 wall / ms | export 最大单进程 RSS / bytes |
| --- | ---: | ---: | ---: | ---: |
| 1 | 124.740 | 22380544 | 1516.433 | 339099648 |
| 2（先 export） | 50.007 | 15613952 | 1302.645 | 331415552 |
| 3 | 41.728 | 15613952 | 1748.908 | 331710464 |

每轮 export root/child/fork 的单进程 wall 分别为：第一轮 **460.850 / 591.374 / 462.377 ms**，第二轮 **452.085 / 407.121 / 442.313 ms**，第三轮 **646.101 / 649.417 / 451.636 ms**。每个进程的独立 RSS 详见 JSON，避免把三次启动误作单次启动。

每轮逻辑读取/输出量均相同：

- SQLite 读取 **9 message rows + 11 part rows**，其中 `data` JSON 列合计 **3646 UTF-8 bytes**；此数不含 ID/外键列、数据库索引、页或 WAL，不能称为磁盘读取字节。
- SQLite 进程 stdout **6090 bytes**（包含少量计数包装）；官方 export stdout 合计 **12215 bytes**（包含 Session info 和缩进格式）。原始输出量不同不表示来源内容不同。
- 对两路线统一抽取并编码完整 hydrated messages（同样含主键/外键和所有 part 字段），均为 **6021 bytes**，每轮逐对象相等且 SHA256 相同。
- OS block input operations 本次各进程都是 **0**；这与缓存小样本一致，不能据此宣称物理 I/O 为零或估算冷盘读取量。

有限结论：在这份 274432-byte 原生 DB 上，直接读取消息/part 的轻量 Python 路线耗时和进程内存低于三次官方 CLI export。它包含不同 runtime、启动次数、CLI bootstrap 和 export 额外输出 Session info 的成本，**不是同 runtime 的纯查询算法比较，也不是生产 Node Collector 的性能数据**。父进程归一化/断言的内存两路线均未计入；没有常驻 server/SDK、巨型 part、海量 session、冷缓存或并发 writer 的比较。三次运行只验证测量可重复与数据一致，不能推出生产规模收益比例。

## Revert 后继续消息：原生 cleanup 边界

新增 `revert-continuation.py` 与约 4.4 KB 的 `revert-continuation-results.json`。脚本先调用 `generate.py` **另建独立 fixture**，没有修改上面 benchmark/Collector 使用的 sidb 数据。复现：

```sh
rtk proxy python3 packages/application/prototypes/opencode-native/revert-continuation.py --binary /tmp/atape-opencode-native-11830-bin/opencode
```

本次新 scratch 为 `/var/folders/xw/9981n9gn1tdb6t730q926xcc0000gn/T/atape-opencode-native-11830-5v4cf6q9`。完整原生请求/响应保存在其 `continuation-api-evidence.json`；生成阶段、继续阶段的服务进程均已退出，scratch 保留。

| 阶段 | 官方 API | 当前 root SQLite 投影 / API 观察 |
| --- | --- | --- |
| 初始 | 已完成原生 fixture 并官方 export | 5 messages、7 parts；包括文本 B、shell tool、compaction 与 summary |
| Revert 标记 | `POST /session/:id/revert`，messageID 为首条 user | session.revert 存在；原 5 message IDs 和 7 part IDs 全部仍在；GET messages 与旧 export 完全相同 |
| 继续 | `POST /session/:id/message`，`noReply:true`，受控新文本 | 原 5 messages、7 parts 全部从当前 root 投影移除；只剩新 ID 的 1 message、1 text part；revert 标记清除 |
| 重新导出 | 停服务后 `opencode export <rootID>` | 新 export 仅有新消息，与继续后的 API 完全相同 |

child/fork 的 message/part ID 集合在此过程中不变。本次是从**首条消息** revert，删除了整个旧 root 消息后缀；未运行指定 partID 的部分消息清理分支，也没有真实文件 diff 回滚试验。
原生 root `event` 新增了 **5 条 `message.removed.1`**，已有更新事件的计数保留并随新消息增加；当前表删除不等同于整个来源 event log 在此路径被删除。事件历史完整性仍不能外推到 import、迁移或删除 session。

旧 `exports/root-export.json` 的 SHA256 和文件字节始终不变，仍含旧的 5 messages；新结果另存 `exports/root-continued-export.json`，没有覆盖旧文件。
**旧 export 是研究脚本保留的对照文件，不是 ATape Raw object，也没有证明 ATape 已完成任何归档。** 它只具体展示：来源当前投影已移除旧内容，而先前独立保存的导出文件仍可保留该内容。

此行为对应[官方 prompt 在新消息创建前调用 cleanup](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/prompt.ts#L1056)，以及[cleanup 按 revert 点移除消息/part 并清标记](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/revert.ts#L102-L125)。继续阶段仅使用 noReply，没有启动模型 stub，唯一配置的 provider 指向未运行的 loopback 端口，不调用真实模型。
