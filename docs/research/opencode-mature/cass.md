# CASS 的 OpenCode 接入与故障修复证据

## 结论

CASS 为本地历史索引选择直接读取 SQLite、兼容旧 JSON，再写入自有规范化数据库和搜索索引。它能提供有价值的规模与兼容教训，但不是远端团队归档协议的现成实现。当前公开修复记录支持三个重点：检测必须与真实 ingest 对齐；增量过滤必须发生在大字段解码之前；保存可变大文件必须控制重复占用。[Connector 包装与版本][wrapper] [schema 故障][schema-issue] [性能故障][perf-issue] [Raw 放大][raw-issue]

## 发布和维护边界

2026-09-10 GitHub API 快照：1,121 stars、138 forks；最新 GitHub release 为 2026-08-31 的 `v0.7.1`，tag commit `19336ea7e992fe7e28cf070b5df4775203f986dc`。main 固定为 `2110e4b21067d569a1d29e0c20dfdf6181242a3d`。这些是公开关注度与维护信号，不是安装量或可靠性统计。[仓库 API](https://api.github.com/repos/Dicklesworthstone/coding_agent_session_search) [release](https://github.com/Dicklesworthstone/coding_agent_session_search/releases/tag/v0.7.1)

Connector Implementation 已迁到 `franken-agent-detection`。main 固定 crates.io `=0.2.3`，发布包 `.cargo_vcs_info.json` 指向 `0feebc55fed8db4d596f330742fe11ca4cb70764`；CASS v0.7.1 固定 `=0.2.1`。因此不能把当前 main 的全部依赖修复当作已发布行为。下文 raw chunking 和 mirror fingerprint 已逐项在 v0.7.1 中核实；FAD 0.2.3 的细节只作为当前 main 证据。[main dependency][dependency] [release dependency][release-dependency]

CASS 当前 LICENSE 标题为 MIT with OpenAI/Anthropic Rider，GitHub SPDX 标为 NOASSERTION，不能写成无附加条件的 MIT。此处比较架构与公开故障，不推荐直接纳入 CASS 代码依赖。FAD 0.2.3 发布包自身 LICENSE 为普通 MIT，应分别核验。[CASS LICENSE][license] [FAD 发布包](https://crates.io/crates/franken-agent-detection/0.2.3)

## 实际采集链

当前 main 的 FAD Connector 先尝试多个 SQLite 候选，再扫描 JSON，按 session ID 去重。SQLite reader 以 read-only 打开，并设 busy_timeout；查询 session 元数据，再筛可能变化的 Session，批量读取相应 messages 与 parts。它输出搜索用 `NormalizedConversation`；物理 source_path 后拼 session ID 区分共享同一 DB 的会话。[读取][reader] [发现与去重][scan]

它不是仅判断 DB 存在就彻底丢掉 JSON，也不是通过 OpenCode SDK 或 CLI export 获取内容。与 CCHV 一样存在补充 JSON-only 历史的路径；具体冲突策略取决于候选顺序和已产生的 SQLite 会话 ID。数据库读取失败会 warn 并继续其他来源，坏 JSON part 可以跳过；因此不能把搜索有结果等同于完整 capture。[scan] [parts]

本地增量以 Session 时间判定候选，未知时间保留，当前 main 加一秒窗口余量。它将过滤推到 message/part 查询之前，而非加载所有大 JSON 后再丢弃。这个优化仍依赖所选更新时间语义，不能证明发现所有来源外部 SQL 改写、同水位后任意变更或 ATape 相同 cursor 的重放。[reader]

CASS 的 Raw mirror 是另一条保存源文件内容的路径，非 Connector 自身 cursor。大文件采用 descriptor 加 content-addressed chunks，规范化数据库与搜索索引再引用其证据。字节级可重建不自动证明活跃 SQLite 多文件的一致事务快照；也不能把包含其他表的 DB binary 直接当 ATape 文本 Raw。[raw-source]

## 修复链一：发现正确，采集却为零

公开问题“OpenCode connector fails to index sessions: schema mismatch with current Drizzle ORM format (opencode v1.14.x)”报告 CASS 0.4.2 检测到 `opencode.db`，但未索引库内 4,323 Sessions / 144,239 messages。数字来自报告者，不是独立 benchmark。[schema-issue]

维护者确认 discovery 接受 DB 路径，ingest 却仅扫描旧 sidecar；修复下沉到 FAD 的 SQLite reader，再由 CASS pin 依赖。关闭说明明确标注 v0.4.4 tag 已推送、GitHub release 当时仍排队，并列出 `opencode_parses_drizzle_sqlite_schema` 和 connector inventory 检查。[schema-fix]

当前 CASS 测试仍创建真实 `session/message/part` SQLite schema，写入 Drizzle 风格 JSON，再走公开 Connector.scan 检查输出。证据链完整到 fixture 和代码；不能从历史单测进一步声称已运行最新 OpenCode v1.18.30。[schema-test]

**ATape 可直接吸收的验收原则**：probe 不仅检查路径存在，还检查来源格式和能否读取一条受控 Session；未知 schema 应进入明确 unsupported/partial，不能显示“已同步、零历史”。

## 修复链二：整库解码和无变化重复扫描

“opencode connector scans large opencode.db at ~10 msgs/s”报告 CASS 0.6.23 扫描约 2.67 GB mirror 用时 2.91 小时。维护者区分两件事：远端镜像内容时间不等于到达时间，直接恢复 since_ts 会漏掉新同步的旧历史；大表先全量读取、排序和 JSON decode 再过滤，又让增量付出近似全量成本。[perf-issue]

CASS 提交 `b14d0eeb` 保存 mirror 文件集合的 path/size/mtime 指纹，只有上次无错误扫描才记住它；未知、stat 失败、强制 full 或指纹变化都重新扫描。v0.7.1 中已经存在对应 gate 和测试，不能把“已检测过文件”当成“已完整摄取”。[mirror-release]

FAD 后续按 Session keep-set 分批查询 message，再按 message 集合查询 part，去掉冗余 SQL ORDER BY。问题关闭时该性能改动仍只在 FAD hotfix branch、未重新 pin CASS；当前 main 的 0.2.3 发布包已含该逻辑和 incremental/full 内容一致测试。这是“上游修复”“依赖 pin”“产品 release”必须分开判断的例子。[perf-fix] [reader] [parts] [perf-test]

**ATape 可直接吸收的原则**：先小元数据筛选，再有界读取正文；仅在成功确认后保存跳过依据；不要用 source mtime 与本机时钟简单比较来判断复制来的历史是否已经摄取。

## 修复链三：为每次变化保存整库导致存储放大

“Raw mirror stores full copies of growing JSONL and SQLite sources on every change”最初报告两个文件占用了 31.93 GB 的 mirror。另一条公开评论随后报告 OpenCode 多次完整 DB 副本造成约 381.8 GB 占用，并触发磁盘耗尽。上述规模是用户报告，不能当成所有安装的常见情况。[raw-issue] [raw-user-report]

维护者在 `402515f893de3a166b029f222bc2be2c257316f9` 将超过 8 MiB 的源改成 4 MiB 固定块，复用未变 chunk，每个 snapshot 保留完整内容 identity；prune 按跨 manifest 引用保留共享块。修复说明当时明确区分已合并与尚未发布。[raw-fix]

v0.7.1 源码已核实包含阈值、chunking、append/partial tail/sparse mutation、重建与共享块清理测试。因此本次可把这个修复标为“已进入该 release 的源码”，仍不声称实测了所有 DB/WAL 模式。[raw-release] [raw-test-release]

**ATape 可直接吸收的原则**：即使为可重放性引入本地持久捕获，也应限定为所选 Session 的必要文本记录或有界 snapshot；禁止每轮复制整个 OpenCode DB。当实现确需保留多个大版本，必须同时设计共享、清理、配额与中断暂存回收。

## 修复链四：自动发现突破明确来源范围

“OpenCode connector double-tags local opencode.db sessions under configured remote SSH sources”来自本地默认路径被带入远程 source 的 fallback。维护者给出 upstream FAD `f7f38440` 与 CASS pin `e2151f95`；当前 main FAD 的 origin-aware predicate 与 scan/discovery 双路径回归测试均存在。[scope-issue] [scope-source]

虽然 ATape 首版不做远程 OpenCode，这个失败模型仍适用于授权范围：明确传入的 Project/source 不应触发另一个默认来源的意外摄取。路径发现的便利性不能改变 provenance 与采集权限。

## 对 ATape 的使用边界

CASS 最适合提供有规模的扫描、兼容、存储和诊断经验；不适合作为 Thread topology、原始 CWD 归属、源撤回后的 Canonical 可见性、Raw 跨远端失败重放的完整模板。它的时间窗口和“跳过坏 part”服务于本地搜索，需要保留 ATape 现有更严格的数据契约。引用源码和测试表示行为可检查，本次没有执行第三方程序或对真实用户语料做 benchmark。

[wrapper]: https://github.com/Dicklesworthstone/coding_agent_session_search/blob/2110e4b21067d569a1d29e0c20dfdf6181242a3d/src/connectors/opencode.rs#L1-L5
[dependency]: https://github.com/Dicklesworthstone/coding_agent_session_search/blob/2110e4b21067d569a1d29e0c20dfdf6181242a3d/Cargo.toml#L155
[release-dependency]: https://github.com/Dicklesworthstone/coding_agent_session_search/blob/19336ea7e992fe7e28cf070b5df4775203f986dc/Cargo.toml#L127
[license]: https://github.com/Dicklesworthstone/coding_agent_session_search/blob/2110e4b21067d569a1d29e0c20dfdf6181242a3d/LICENSE
[reader]: https://github.com/Dicklesworthstone/franken_agent_detection/blob/0feebc55fed8db4d596f330742fe11ca4cb70764/src/connectors/opencode.rs#L475-L607
[scan]: https://github.com/Dicklesworthstone/franken_agent_detection/blob/0feebc55fed8db4d596f330742fe11ca4cb70764/src/connectors/opencode.rs#L943-L1065
[parts]: https://github.com/Dicklesworthstone/franken_agent_detection/blob/0feebc55fed8db4d596f330742fe11ca4cb70764/src/connectors/opencode.rs#L747-L808
[schema-issue]: https://github.com/Dicklesworthstone/coding_agent_session_search/issues/227
[schema-fix]: https://github.com/Dicklesworthstone/coding_agent_session_search/issues/227#issuecomment-4445898640
[schema-test]: https://github.com/Dicklesworthstone/coding_agent_session_search/blob/2110e4b21067d569a1d29e0c20dfdf6181242a3d/tests/connector_opencode.rs#L109-L229
[perf-issue]: https://github.com/Dicklesworthstone/coding_agent_session_search/issues/372
[perf-fix]: https://github.com/Dicklesworthstone/coding_agent_session_search/issues/372#issuecomment-5157676545
[perf-test]: https://github.com/Dicklesworthstone/franken_agent_detection/blob/0feebc55fed8db4d596f330742fe11ca4cb70764/src/connectors/opencode.rs#L3189-L3282
[mirror-release]: https://github.com/Dicklesworthstone/coding_agent_session_search/blob/19336ea7e992fe7e28cf070b5df4775203f986dc/src/indexer/mod.rs#L15277-L15291
[raw-issue]: https://github.com/Dicklesworthstone/coding_agent_session_search/issues/430
[raw-user-report]: https://github.com/Dicklesworthstone/coding_agent_session_search/issues/430#issuecomment-5471241760
[raw-fix]: https://github.com/Dicklesworthstone/coding_agent_session_search/commit/402515f893de3a166b029f222bc2be2c257316f9
[raw-source]: https://github.com/Dicklesworthstone/coding_agent_session_search/blob/2110e4b21067d569a1d29e0c20dfdf6181242a3d/src/raw_mirror.rs#L1410-L1645
[raw-release]: https://github.com/Dicklesworthstone/coding_agent_session_search/blob/19336ea7e992fe7e28cf070b5df4775203f986dc/src/raw_mirror.rs#L19-L20
[raw-test-release]: https://github.com/Dicklesworthstone/coding_agent_session_search/blob/19336ea7e992fe7e28cf070b5df4775203f986dc/src/raw_mirror.rs#L3452-L3856
[scope-issue]: https://github.com/Dicklesworthstone/coding_agent_session_search/issues/357
[scope-source]: https://github.com/Dicklesworthstone/franken_agent_detection/blob/0feebc55fed8db4d596f330742fe11ca4cb70764/src/connectors/opencode.rs#L3987-L4101
