# OpenCode 本机历史采集 Interface 与一致性边界研究

研究日期：2026-09-10（Asia/Singapore）。研究票：[核验 OpenCode 本机历史的采集 Interface 与一致性边界](https://github.com/SingleMai/ATape/issues/109)。本文是决策证据，不是已接受的路线或生产 Implementation。

## 结论及可信范围

1. **当前 stable 的普通会话既有可变 `session/message/part` 投影，也实际写入 durable `event` 日志。** 因而“所有 SQLite 读取都无法重放”不成立：完整且仍保留的 provider event prefix 可以作为重建固定历史状态的来源。反过来，“有 event 表就能覆盖所有历史”也不成立：现行 import 绕过日志，迁移曾整体清空日志，删除 Session 会删除 aggregate 日志。[普通写入][session-write]、[durable 声明][v1-durable]、[实际运行时装配][app-runtime]、[import][import]、[重置迁移][reset]、[删除][session-delete]。
2. **直接重查可变行、重新运行 export、重新请求普通消息 API，均不提供跨进程重启的同 cursor 成功重放保证。** SQLite read transaction 只固定连接存续期间的视图；hash、mtime、revision、WAL 偏移都不是已消失内容的备份。完整 retained event prefix 与持久不可变内容副本是不同的补救路线。[SQLite isolation](https://sqlite.org/isolation.html)、[投影更新][projector-mutations]。
3. **来源消失或变化时停止该来源、不确认进度，是合法的独立选项。** ATape 当前 Interface 已有 `changed/io/unsupported` source failure，并不要求恢复用户删除的历史。要证明 fail-closed 有效，必须先持久 pin 本次拟发送的边界和重读摘要，再在每次发送前验证；不能把只存在未提交 `nextCursor` 的摘要当成已保存证据。[ATape Interface][atape-contract]。本文不把“不能保证成功恢复”误写成“必须新增内容队列”。
4. **SQLite＋只读 Node Adapter 技术上可行，真正的决策在兼容覆盖与失败策略。** ATape 已要求 Node >=24；该最低版本有内置 `node:sqlite` 的 readOnly、timeout、statement iterate，无需为了读 SQLite 依赖 Bun 或另带原生 addon。但同步 I/O、字节上界、取消响应、受支持 OS 与最低 Node 版本仍需实现前验证。[ATape Node][atape-node]、[Node 24.0.0 SQLite](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html#new-databasesyncpath-options)。

以上源码事实可信度高；“如何在 ATape 既有大小上界内冻结整个 Session/子会话图并重放”仍是待原型验证的推论，不宣称已实现。

## 固定版本与研究方法

GitHub `releases/latest` 在本次查询返回 `v1.18.30`，发布时间 `2026-09-09T03:34:27Z`。release 的 `target_commitish=5cd8e68fdd72b27818d26d168b9c7a06b359567e` **不是 tag 实际指向**；`git/ref/tags/v1.18.30` 与浅 clone HEAD 均是 **`3104c1428ec91f809e5ab86631300de41eb6952e`**，本文源码永久链接固定后者。[发布](https://github.com/anomalyco/opencode/releases/tag/v1.18.30)、[tag API](https://api.github.com/repos/anomalyco/opencode/git/ref/tags/v1.18.30)。ATape 基线是 `242b2f2a90c405528d8c70880ad0b3bad7d9d00f`。

已查官方 CLI、Server、SDK、存储说明，并逐项追到实际写入、读出、迁移、运行时装配源码。上游仓库只在独立 `/tmp` 目录静态阅读；未安装或执行 OpenCode，未读取用户历史、认证文件或环境凭据。只运行一个自行编写、仅含 `old/new` 文本的合成 SQLite 实验。网页文档会滚动更新；与固定源码不一致处以该 release 源码说明版本行为。

## 数据定位、进程来源与迁移

### 定位规则

| 情况 | 固定版本源码行为 | 对 Adapter 的含义 |
| --- | --- | --- |
| 普通 stable | `Global.Path.data = join(xdgData, "opencode")`，默认数据库 `opencode.db` | 通常是 macOS/Linux `~/.local/share/opencode/opencode.db`，Windows 官方说明是 `%USERPROFILE%\.local\share\opencode` 下数据；不要误用 macOS `Application Support` 作历史默认目录 |
| XDG | `xdg-basedir` 计算 data/cache/config/state | 必须考虑 `XDG_DATA_HOME`；Collector 环境可能不同于产生历史的终端/桌面环境 |
| `OPENCODE_DB` | `:memory:` 原样；绝对路径原样；相对路径相对 `Global.Path.data` | 应支持显式源定位；`:memory:` 没有可扫描的本机历史文件 |
| channel | latest/beta/prod 共享 `opencode.db`；其余 channel 使用清洗后的 `opencode-<channel>.db`；disable-channel flag 可覆盖 | 不应无选择地扫描所有 `.db` 后合并身份，也不能仅凭包版本推断数据库 |
| config | `OPENCODE_CONFIG_DIR` 改 config，`OPENCODE_TEST_HOME` 改 home getter | 它们并不在此源码中直接重定向 `Global.Path.data` |

依据：[Global][global]、[Database.path][db-path]、[官方排障存储说明](https://opencode.ai/docs/troubleshooting/#storage)。官方排障页面仍介绍旧 `project/.../storage`，因此可用于默认数据根提示，不能作为当前 schema 权威。

Desktop 当前是 Electron utility-process sidecar，继承 shell/process 环境，只明确将 `XDG_STATE_HOME` 缺省值设为 app userData；没有在这里强制另设 data 根。VS Code 扩展在终端运行 `opencode --port <随机端口>`。在相同用户、XDG/channel/DB 配置下，它们有共享同一个本地数据库的可能；这不是三个必须分别建 Adapter 的格式。[Desktop env][desktop]、[VS Code][vscode]。Desktop 也可以选用别的 server；这类历史可能不在本机，不能把桌面可见内容等同于本机磁盘覆盖。WSL、容器与远程机器应作为明确的另一个文件系统/进程来源，本文不宣称自动发现它们。

数据库还包含认证/账号等无关表。ATape 需要限定读出的表和字段，不把整个 OpenCode 数据目录或数据库文件作为 Raw 上传。[schema exports][storage-schema]。

### 三代来源必须区别处理

- **更旧项目 JSON**：`project/<project>/storage/session/info/*.json`、`.../message/<session>/*.json`、`.../part/<session>/<message>/*.json`。仍保留的 Storage migration 可把这些布局复制到全局 `storage/session/...` 等路径。[Storage 旧布局][storage-legacy]。
- **全局 JSON**：`storage/project/*.json`、`storage/session/<project>/<session>.json`、`storage/message/<session>/<message>.json`、`storage/part/<message>/<part>.json`。历史 JSON→SQLite migrator 使用这些 glob，并直接 insert 对应表。它是可变 JSON 对象文件，不是 append-only JSONL。[移除前固定源码][json-migration]。
- **SQLite**：当前 Database 开启 WAL，应用 SQL/TS migrations。schema 包含 legacy v1 `message/part` 与另一个 v2 `session_message` 投影，不意味着每个 Session 同时拥有两个模型的数据。[数据库初始化][db-init]、[会话 SQL][sql]。

**当前 v1.18.30 不再自动把遗留 JSON 迁入 SQLite。** 2026-06-02 的 [remove JSON storage migration commit](https://github.com/anomalyco/opencode/commit/ca2acc4f8d551a8055f17ad31684c8639289a531) 删除 migrator 与 CLI/Desktop 启动调用；当前残留 Storage migration 是 JSON→JSON 的另一件事。不能以“替用户运行最新版 CLI”替代 legacy 支持决策。

当前 migration journal 是 `migration(id,time_completed)`；升级路径会识别旧 `__drizzle_migrations` 的 named/timestamp 格式并播种新 journal，然后逐迁移事务执行；空数据库直接建最新 schema 并登记全部迁移。[Migration runner][migration]。`session.version` 是 Session 元数据，不是可靠的全库 schema 版本或逐事件变更序列。兼容探测至少应查看必需表/列/索引、journal，以及具体 Session 的日志覆盖；不能只查 OpenCode 可执行文件版本。

## 实际的读写 Interface

### 普通 v1 会话仍是当前明确使用的路径

不要混淆四个名字：源码 `MessageV2` 读取的是 **v1 `message/part`**；SDK 的 `/v2` 包目录仍有普通 `/session/{sessionID}/message`；`EventV2` 是现在 v1 也使用的事件持久化 Module；SQL `session_message` 才是另一套 core 会话投影。

普通 AppRuntime 装配 `Session`、`SessionProcessor`、`SessionPrompt`、`SessionProjector` 与 `EventV2Bridge`；processor 工具更新调用 `Session.updatePart`，后者 publish durable `message.part.updated`。这条链路有实际入口，不是根据“文件存在”推断默认写入。[AppRuntime][app-runtime]、[processor][processor]、[Session writes][session-write]、[event schema][v1-durable]。普通导出和 SDK 读出的 legacy payload 格式仍需独立解码，不能因为共享 SQLite 就自动支持 v2 `session_message`；v2 的语义、开关与显示策略由并行语义研究单独确认。

### 存储结构与可变性

| 表/字段 | 已核验行为 | 对增量采集的影响 |
| --- | --- | --- |
| `project` / `project_directory` | worktree、额外目录、VCS 与展示信息；没有可直接替代 ATape attribution 的 repositoryRemote 字段 | 项目名/路径是来源线索，不是 Git 身份结论 |
| `session` | id、project_id、workspace_id、parent_id、directory/path、title、version、摘要、usage、revert、permission、timestamps | title/path/topology/metadata 与消息变化必须分别考虑 |
| `message` | PK id、FK session_id、timestamps、JSON data；更新 conflict 改 data | 同 message ID 的内容可改；`time_created` 不是 revision |
| `part` | PK id、FK message_id、session_id、timestamps、JSON data；更新 conflict 改 data | 工具生命周期和文本内容可改；Raw 不能盲目当 append 文件 |
| `event` | id、aggregate_id、seq、versioned type、JSON data；aggregate/seq 唯一 | 有条件提供可保留的旧状态来源；seq 是每 aggregate 序列，不是全库递增水位 |
| `session_message` | session 内 seq 唯一，另有 type、JSON data | 与 `message/part` 不可无差别拼接，存在重置迁移 |

依据：[SQL][sql]、[project schema][project]、[projector][projector-mutations]、[event table][event-sql]。message/part/session FK 有 cascade 删除。`time_updated` 的默认更新行为来自 Drizzle `$onUpdate(Date.now)`，不是数据库 trigger，因此无法代表任意外部 SQL 写入；title 的 `patch` 还会带回原 Session time。仅用 `session.time_updated > cursor` 既不能证明包含所有子表变更，也不能证明全局严格顺序。[timestamps][timestamps]、[patch/title][patch]。

原始 CWD 不能直接取最新 `session.directory`：`SessionEvent.Moved` 改写 directory/path/workspace。若保有创建事件，其 info.directory 有机会提供创建时来源；若来自 import，import 会重写 project/directory 且不产生 Created，不得伪造原始 CWD。[Moved][moved]、[import][import]。

### 普通 Server／SDK／CLI

| 入口 | 覆盖与分页 | 一致性/运行成本 |
| --- | --- | --- |
| `GET /session` | 当前 project，可筛 roots/start/directory/path/search；默认 limit 100；排序 time_updated desc，无稳定 tie cursor | 不是天然的全库历史遍历或 change feed |
| experimental global session list | 默认不含 archived；默认 limit 100；order updated desc,id desc；cursor 只过滤 `time_updated < cursor` | 同毫秒跨页可能漏掉尾部同 timestamp；活跃更新可跨越页边界 |
| `GET /session/:id/children` | 查询 parent_id 返回全部 | 无分页且无排序；跨调用没有共同 snapshot |
| `GET /session/:id/message?limit=&before=` | cursor 是 base64url `{time,id}`，按 created desc,id desc 取页，再返回正向 items；next cursor 在响应 header | message SELECT 与 part hydration 是分开的查询，无包围事务；跨页也未 pin snapshot |
| SDK `client.session.messages` | `/v2` SDK 的普通请求实际到上述 `/session/.../message` | SDK 提供类型和传输封装，不增加不可变历史保证 |
| `opencode export <id>` | `{info,messages:[{info,parts}]}`，单会话；不递归导出 children；先 get info 再读取消息，每批 50，但最后全集数组＋JSON.stringify | 不满足 ATape bounded bytes；两次 export 可不同；启动走默认 InstanceBootstrap |
| `POST /sync/history` | experimental，payload 为 aggregate→last seq；未列出的 aggregate 返回全部；SQL `.all()`、无 limit，仅 order seq | 能读持久事件，但跨 aggregate order 非全序、传输无界；不适合直接当 bounded pull |
| `/event`、`/global/event` SSE | 订阅当前内存 GlobalBus | 本身不提供重启历史补读保证；与 EventV2 durable stream 是不同 Interface |

依据：[Session list][list]、[global list][global-list]、[children][children]、[message pagination][page]、[hydrate][hydrate]、[HTTP headers][http-messages]、[SDK URL][sdk-messages]、[export][export]、[Session.messages][messages]、[sync API][sync-api]、[sync read][sync-read]、[global SSE][sse]。示例反例：全局页尾 timestamp=100，尚有一个 id 更小且 timestamp=100 的 Session，下一页 `<100` 永远越过该记录。普通 message `(created,id)` keyset 解决同时间分页顺序，但不固定 message/part 的值。

官方 [Server 文档](https://opencode.ai/docs/server/) 推荐 `serve` 和 OpenAPI，默认 localhost:4096；[SDK 文档](https://opencode.ai/docs/sdk/) 区分连接已有 server 的 `createOpencodeClient` 与创建 server/client 的 `createOpencode`。源码后者 spawn `opencode serve`，继承环境并覆盖 `OPENCODE_CONFIG_CONTENT`。[SDK process][sdk-server]。这会引入二进制发现、版本匹配、端口、鉴权、进程退出/取消责任。

**export 与 `opencode db SELECT...` 不等于无副作用的文件读取。** Database Layer 开库后会设置 WAL/synchronous、执行 PASSIVE checkpoint 和 migrations；export 默认 `instance:true`，加载项目 config/plugin 与初始化工作。`db` 虽跳过 instance，查询仍用该 Database Service；无 query 时还启动外部 sqlite3。[数据库初始化][db-init]、[effectCmd][effect-cmd]、[db CLI][db-cli]。Adapter 自己持只读连接可避开这些 OpenCode 启动行为；直接 import 上游实现则会重新引入。

## durable event 能否解决旧字节重读

### 能证明的部分

v1 的 Created/Updated/Deleted/MessageUpdated/MessageRemoved/PartUpdated/PartRemoved 都声明 `{aggregate:"sessionID",version:1}`；PartDelta 没有 durable 声明。[event schema][v1-durable]。EventV2 在同一 immediate transaction 中运行 projectors、推进 aggregate seq、insert encoded event。远程 replay 旧 seq 必须匹配 event id/type/data，否则失败；正常更新没有 overwrite 已存 event 的路径。[commitDurableEvent][event-commit]。

因此，在**完整 prefix 尚保留、所需事件 schema 已知、读取者选择稳定边界与固定序列化**的前提下：part 最新值从 A 变 B，并不妨碍重读早先 `message.part.updated` 的 A。可从 prefix 重建截至 seq=N 的 v1 projection，或把事件坐标定义为 Raw 来源。必须明确 Raw 是对原始 JSON 字段/事件的版本化 textual encoding，而不是“数据库文件的原始 byte offset”；不能上传 SQLite binary 满足当前文本 Raw Interface。[ATape Raw][atape-contract]。

普通 prune 当前仅设置 tool `time.compacted` 后调用 updatePart；该路径没有清除 event，旧 durable payload 仍是潜在证据。[prune][prune]。这不意味着所有未来 compaction/migration 都永远保留日志。

### 明确的覆盖缺口

| 触发 | 源码证据 | 结果 |
| --- | --- | --- |
| 初次引入 event schema | migration 20260323234822 仅 CREATE tables | 原有投影不因此获得历史 baseline |
| 20260622170816 reset | DELETE event/event_sequence/session_message 等，保留 session/message/part | 旧 Session 可存在且日志为空；重置后 seq 可以重新开始 |
| 当前 `opencode import` | 直接 insert/upsert session/message/part；还重写归属和目录 | 即使用户装最新版，新导入 Session 也可能无完整 event prefix |
| 删除 Session | 发布 Deleted 后调用 events.remove，递归处理 child | 连同删除事件本身在内的 aggregate 日志会被删除 |

依据：[建表迁移][events-migration]、[reset][reset]、[import][import]、[session remove][session-delete]、[events remove][event-remove]。本次所查路径没有证明一个会把这些缺口全部自动补成完整 baseline 的机制，因此不能以表存在或 `seq>=0` 作为完整性判断。

**原型需要验证的是覆盖证明，而不只是读 SQL：** 是否存在合法 Created；首条/边界 event 身份；连续 seq；version/type 清单；截至固定 head 重建结果能否与同事务读取的 v1 projection 对齐。即使 Created 存在，后来 import 也能绕过日志，因此“有 Created”单项不足以证明完整。原型还需区分 baseline 已建立但后来改写失配、真正新增、日志删除与 schema 迁移；不能因 inode、mtime、seq 看起来合理就沿用旧 generation。

没有一个已核验的官方数据库 incarnation UUID 可直接充当 ATape sourceGeneration。可考虑 aggregate ID、创建 event ID、固定边界 event ID、prefix 内容摘要与 schema/encoder identity 的组合，但其上界、碰撞/重建语义与失配策略是设计问题。hash 能验证重读值，不能补回被删除值。

## SQLite 只读、WAL 与 snapshot 的准确边界

- OpenCode 明确使用 WAL。SQLite 正常 read transaction 可保持固定视图，writer 能继续提交；长读事务可能阻碍 checkpoint 推进，造成 WAL 增长。因此读事务应有生命周期/超时，不能跨远程上传任意长期持有。[初始化][db-init]、[SQLite WAL](https://sqlite.org/wal.html)、[Isolation](https://sqlite.org/isolation.html)。
- SQLite 3.22+ 支持某些只读 WAL 场景：需要已有可读的 WAL/SHM、能创建它们，或真正 immutable 数据库。`readOnly` 是数据库逻辑只读，不保证进程绝不触及共享内存/辅助文件；应在所支持 OS/权限组合实测。活跃 DB 不可谎报 `immutable=1`：该参数会跳过锁和变化检测，源仍变化时可能错误读数或损坏报错。[WAL](https://sqlite.org/wal.html#read_only_databases)、[URI](https://sqlite.org/uri.html#uriimmutable)。
- 不能只 `cp opencode.db`：最新已提交内容可能仍在 `-wal`；分别拷贝 DB/WAL/SHM 也不自动组成原子视图。SQLite backup 能生成一致副本，但持久保存该副本就是保存内容，涉及 ATape 目前拒绝的内容队列/缓存边界，不能把它命名“snapshot metadata”绕开。[SQLite backup](https://sqlite.org/backup.html)。
- SQLite snapshot API 是 WAL/编译选项相关的 C API，handle 不提供永久历史内容；对应 WAL 被回收后可能失效。Node 24 公共 API 没有暴露 snapshot_get/open。不能把进程内 snapshot handle 塞进 opaque cursor 当重启保证。[snapshot_get](https://sqlite.org/c3ref/snapshot_get.html)、[snapshot_open](https://sqlite.org/c3ref/snapshot_open.html)、[Node 24 API](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html)。

### 受控实验（不是生产兼容测试）

在临时数据库用 Python sqlite3 3.51.0，创建 `part(id,data)` 和 `event(seq,data)`，全部数据只有 `old/new`。只读连接开启 BEGIN 后读取 part；独立 writer 改 part 并 append event；关闭并重新打开 reader，再删除 event。输出如下：

```json
{"sqlite_version":"3.51.0","read_transaction_before":"old","same_transaction_after_writer_commit":"old","after_reader_reopen":"new","retained_event_prefix":"old","after_event_removal_count":0}
```

实验验证的是 SQLite 一般行为：事务存续时 stable、重启后 mutable projection 改变、保留事件仍能还原旧值、事件消失后不能成功恢复。未验证 OpenCode packaged runtime、ATape upload crash recovery 或跨 OS WAL 权限。

## 同 committed cursor 的反例与可选补救

现行 Host 在 Canonical/Raw 确认前不推进 cursor；失败后从旧 committed cursor 重放。[ATape ADR-0009][atape-checkpoint]。设旧 cursor C 选择 part P：

1. 第一次读取 P=A，返回 page(A)、nextCursor=C1；远端可能已经接受 Canonical 或部分 Raw。
2. Host 尚未持久 C1 就崩溃；OpenCode 把 P 更新为 B。
3. 重启重读 C，只查最新 row/API/export 得 B。

即便 P 的 ID 不变，A/B 字节、摘要、事件 revision、页分段都有可能不同。使用新 hash 作 revision 避免某个去重冲突，仍没有满足“相同 C 重放相同 page”的 Interface。把边界摘要仅放 C1 也没有解决，因为此时持久状态仍是 C。

| 方案形状（均未接受） | 同 C 成功重放能力 | 原始历史覆盖 | 代价/待验证 |
| --- | --- | --- | --- |
| 最新 rows＋时间水位 | 不能证明；变化可能直接换 payload | 当前投影广 | 不可宣称现成满足契约 |
| 预先 pin metadata，再重读摘要校验 | 来源未变时可以；变了显式失败 | 可尝试当前投影；在途变化会暂停 | 利用零 observation 的 traversal page 先提交 pin 是否可行；整 Session/子图边界、摘要、cursor 上界和失败后推进必须原型验证 |
| 完整 retained event prefix | 在所需事件仍在、边界/编码固定时可恢复旧值 | 条件性：legacy/import/reset 有缺口 | per-session coverage probe、fixed head、未知 event 拒绝、重建资源上界；源消失/重置 fail-closed |
| 用户提供的不可变 export/快照文件 | 文件保留且验证相同则可 | 文件所包含历史 | 不自动构成持续同步；“用户提供来源”与“Adapter 自动保存副本”责任不同 |
| Adapter/Host 持久 payload spool/backup | 副本持久与回收正确则可 | 能覆盖读取时的投影 | 新的内容持久化、隐私、空间、清理、事务与 ADR 例外；本文无权默认引入 |
| 已有 server＋普通 SDK | 同 mutable rows | Server 可见当前历史 | 多一层依赖，不解决不可变性；只可作为读取渠道而非恢复证明 |

ATape [ADR-0027](https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/architecture/adr/0027-transactional-capture-checkpoints.md) 仍标注 Accepted design; Implementation pending，明确 metadata journal 不恢复消失的 payload，payload spool 不在范围内。不能把这个待实现 journal 当作当前 Host 已提供的能力。

**fail-closed 与永久停滞的产品成本要一起讨论。** 源变化的合法诊断应保留已确认历史、不上传假定的新旧混合页、不假装完成；但频繁活跃会话若总是触发失配，首版可能很难完成。需要选择允许的历史/持续同步保证，而不是把一个 technically safe 但总失败的实现称为可用。

Raw/Canonical 的共同来源不能随意切换：本次以 mutable snapshot，重试改成 event JSON，虽然语义类似，source bytes 和 generation 已变。若采用 source encoding，应把排序、JSON key 编码、换行、UTF-8、未知字段保留、encoder version 都固定；非 final Raw segment 还需完整记录及 newline。一条巨大 row/event JSON 也可能超过限额，`LIMIT 100` 不等于 bounded bytes。[ATape Raw Interface][atape-contract]。

## Node 包装与 Module 边界

当前 Node >=24 baseline 可以在 Adapter 的外部来源 Seam 中封装 `DatabaseSync(path,{readOnly:true,timeout:...})` 与 scope close；数据库查询/异常/生命周期通过 Effect。Node 24.0 的 SQLite API 仍属 Active development；后续 24.x 的 defensive 等新增选项不能未抬高最低版本就调用。同步查询超时/大 JSON parse 会阻塞事件循环，AbortSignal 不自动中断任意同步 SQLite 调用。要用有界 query、显式字节检查和资源 scope；必要时 worker 是待性能验证的 Implementation 选择。[Node 24.0](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html)、[ATape TypeScript guide][atape-effect]。

从 Leverage 看，内置 SQLite 避免安装编译链和 Bun 运行时；从 Locality 看，schema probe、source snapshot/retained-prefix reader 应留在 OpenCode Adapter Implementation，Host 不应理解 `message.part.updated` 或迁移编号。深 Module 的 Interface 应暴露稳定 page 与明确 source failures，而不是要求 Presentation 管理 WAL 或补偿重试。选择哪个真实来源 Seam、是否增加持久内容，是独立架构决策。[ATape architecture][atape-architecture]。

## 下一轮讨论应明确的问题

1. 首版兼容承诺是“读取当前 v1 投影并在来源变化时明确暂停”，还是“仅完整 event-covered Session 支持稳定连续重放”，或二者分 capability？不应仅用最低 OpenCode 版本表达覆盖。
2. 无 Created 或日志失配的 legacy/import Session 如何给原始 CWD、Raw generation、attribution 证据？应拒绝、单独导入模式，还是另立存储政策？
3. 首次读取的稳定选择如何在产生远程 side effect 前持久 pin？零 observation metadata page 是否能在当前 Host 下闭合 crash window？边界覆盖 parent/child membership、title 和每个来源内容吗？
4. 如何定义当前投影与事件来源的 Raw，何时开启新 generation，怎样展示“已捕获但源后来失配/删除”且不删除 ATape 已确认历史？
5. 如果来源持续活跃且超出一页，acceptable freshness/暂停率是什么？必须测试真实 WAL reader/writer、同 timestamp 大批 Session、巨大单条 part、失败在 Canonical 与 Raw 间、重启、源替换和 migrations。

这些是路线与数据契约的决策输入。本文没有修改生产代码、开启 OpenCode 服务、迁移用户数据库或选择产品路线。

[global]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/global.ts#L10-L43
[db-path]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/database.ts#L43-L57
[db-init]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/database.ts#L22-L40
[desktop]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/desktop/src/main/server.ts#L44-L69
[vscode]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/sdks/vscode/src/extension.ts#L47-L65
[storage-schema]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/storage/schema.ts#L1-L5
[storage-legacy]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/storage/storage.ts#L79-L242
[json-migration]: https://github.com/anomalyco/opencode/blob/113e7be5ac73b6f6de0b7183c05405852b7b6113/packages/opencode/src/storage/json-migration.ts#L98-L119
[migration]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/migration.ts#L18-L106
[sql]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/sql.ts#L22-L138
[project]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/project/sql.ts#L6-L35
[timestamps]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/schema.sql.ts#L1-L10
[projector-mutations]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/projector.ts#L234-L327
[event-sql]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/event/sql.ts#L4-L24
[session-write]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L629-L643
[session-delete]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L606-L626
[patch]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L734-L758
[moved]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/projector.ts#L242-L255
[v1-durable]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/schema/src/v1/session.ts#L502-L641
[app-runtime]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/effect/app-runtime.ts#L58-L90
[processor]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/processor.ts#L123-L157
[list]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L955-L1007
[global-list]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L555-L594
[children]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L596-L604
[page]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/message-v2.ts#L425-L466
[hydrate]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/message-v2.ts#L63-L123
[http-messages]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L106-L145
[sdk-messages]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/sdk/js/src/v2/gen/sdk.gen.ts#L3701-L3740
[messages]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/session.ts#L828-L851
[export]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/cli/cmd/export.ts#L222-L292
[import]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/cli/cmd/import.ts#L179-L226
[sync-api]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/server/routes/instance/httpapi/groups/sync.ts#L29-L105
[sync-read]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts#L72-L85
[sse]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts#L25-L51
[sdk-server]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/sdk/js/src/v2/server.ts#L22-L103
[effect-cmd]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/cli/effect-cmd.ts#L25-L44
[db-cli]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/cli/cmd/db.ts#L8-L51
[event-commit]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/event.ts#L205-L360
[event-remove]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/event.ts#L514-L522
[events-migration]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/migration/20260323234822_events.ts#L5-L25
[reset]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts#L5-L16
[prune]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/compaction.ts#L273-L316
[atape-contract]: https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/adapters/package-manifest.md#L73-L119
[atape-checkpoint]: https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/architecture/adr/0009-pull-adapter-runtime-and-checkpointed-collector.md#L11-L59
[atape-node]: https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/adapters/codex/package.json#L27-L29
[atape-effect]: https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/architecture/typescript-effect.md#L19-L28
[atape-architecture]: https://github.com/SingleMai/ATape/blob/242b2f2a90c405528d8c70880ad0b3bad7d9d00f/docs/architecture/codebase-design.md#L5-L67
