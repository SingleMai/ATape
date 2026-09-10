# Entire 的 OpenCode 采集架构与修复经验

## 判断

Entire 已将 OpenCode 接入交付为一个持续维护的 **preview**：项目级 TypeScript plugin 负责告诉 Entire“何时采集”，Go Adapter 通过官方 `opencode export` 获取会话快照，先物化本地文件，再在 Git 提交边界形成 checkpoint。它没有选择读取 OpenCode SQLite，也没有通过 SDK messages API 流式收集内容。[^1][^2]

这套实现对 ATape 最有价值的是**触发与内容分离、失败不破坏旧副本、把本地写入与上传分开恢复**；它不能直接证明“旧历史批量补录＋每 30 秒持续同步＋Raw 完整保留＋subagent Thread”的可行性。Entire 的目标是代码提交及其上下文的 checkpoint，持续归档所需的边界明显更严格。

## 项目身份与版本

研究对象是 Entire Inc. 的官方仓库 `entireio/cli`，MIT License；不是 `zchee/entireio-cli` fork。2026-09-10 仓库公开 API 返回约 5,082 stars、467 forks，创建于 2026-01-02，未归档。这些是活跃度背景，不能替代接入质量证据。[^3][^38]

| 基线 | 核验结果 |
| --- | --- |
| 最新非 prerelease | `v0.10.6`，2026-09-07 18:30:43 UTC 发布；tag 指向 `c3e67e0d77dd37fd35ebeb39c7313df6cc2894cd`。[^4] |
| 固定 main | `0138471ae764ca9b846ed21ce0a9ff917724d0bf`，提交时间 2026-09-09 21:38:59 UTC。[^5] |
| 发布与 main 差别 | 两者间 OpenCode Adapter 整个目录无差异；本文核验的 pushqueue、refs_store、manual_commit_push、common、OpenCode compact 文件也无差异。因此这里的核心做法已进入发布版，不是未发布分支愿景。 |
| 接入成熟度 | `IsPreview()` 明确返回 true；官方专页也标 preview。已有数月真实 issue、修复 PR、单元和集成测试，另有真实 OpenCode E2E harness。应评价为“有运行反馈的 preview”，不能写成完整、无缺口的 OpenCode 历史平台。[^1][^6][^7] |

源码引用统一锁定上述 main SHA。仓库整体不等同于发布版：main 的 persistent.go 还有 v0.10.6 之后的 transcript 读取分配优化和 redaction-incomplete 错误处理变化，本文不将这些新修复计作 v0.10.6 已交付保证。测试存在、PR 作者报告测试通过、现场验证报告是不同级别的证据；本文不把任何一个等级升级为全部环境可靠性保证。[^39]

## 已实现的数据路径

```text
.opencode/plugins/entire.ts
    Session / message / idle / compaction / disposal events
        ↓ JSON stdin
entire hooks opencode <lifecycle>
        ↓ 按需准备或刷新
opencode export <sessionID> → 已打开的临时文件 stdout
        ↓ JSON 校验 + 原子安装
.entire/tmp/<sessionID>.json
        ↓ 文件变化 / turn 记录 / Git commit condensation
checkpoint: full.jsonl + compact transcript.jsonl + metadata
        ↓ 本地 Git ref + push queue
Git pre-push → checkpoint remote → 成功后移除已确认队列项
```

Plugin 只传 `session_id`、prompt、model 等小 payload；并未在 JS 里累计整份会话作为持久源。其主要时机如下。[^2][^8]

| 触发 | 插件动作与意图 |
| --- | --- |
| session.created | 切换/重置内存中的 Session 跟踪后发 session-start；先改状态再 await，避免同 Session 的重复 created 重入。 |
| message.updated | 缓存 role/model；未知 Session 先同步 session-start；user message 可同步 turn-start，prompt 暂为空，以保证紧接着的 Git commit 能看见 ACTIVE Session。 |
| message.part.updated | 如果该 user message 尚未开始过 turn，取 text 发 turn-start。 |
| session.status=idle | 同步 turn-end；使用 status 而非只依赖旧 session.idle，兼顾 `opencode run` 的退出时序。 |
| session.compacted | 异步 compaction 生命周期事件。 |
| session.deleted / server.instance.disposed | 同步 session-end；区分主动删 Session 和普通进程退出。 |

`PrepareTranscript` 总是重新 export，即使 `.entire/tmp/<id>.json` 已存在；用途正是 mid-turn commit 与 resumed session，不能因“文件存在”就认为数据已新鲜。`FetchTranscript` 是另一个能力：给定源 Session ID，即使从未被 hook 追踪，也可物化文件，服务显式 attach。[^9]

Go 使用 `exec.CommandContext(ctx, "opencode", "export", sessionID)`，将 stdout 设为已打开的文件，30 秒超时；这里没有启动长期 SDK 服务、独立 SQLite reader 或 WAL watcher。SQLite schema、锁和 export 的一致性由上游 CLI 承担，Entire 承担可执行程序可用性、进程开销、超时和输出完整性。[^10]

当前物化不是直接覆盖旧缓存：创建随机 `.export-...` staging 文件，导出成功后读取并校验 JSON，再 rename 到固定会话文件。进程成功不等于内容成功，空输出/截断 JSON 也会被拒绝。文件 `Sync` 先于 rename；目录 `Sync` 是 best-effort；Windows sharing violation 有 5 次、每次 40ms 的有限重试，仍不能安装时保留已验证 staging 并在错误中给出恢复位置。[^9][^10][^11]

这保护了 Entire 已拥有的最后一个本地导出副本，不代表保住源数据库里每一个 token 或每一次修订。Plugin 的 seen-message 和 session 跟踪是内存状态，也不是断电可恢复的源事件 journal。[^2]

## 覆盖范围与已接受的取舍

| 能力 | 实际覆盖与限制 |
| --- | --- |
| 运行中 Session | 配置插件后的活动 Session 是主路径。退出/turn-end 同步等待，以换取 checkpoint 在进程结束前完成的机会。 |
| 旧历史补录 | 官方文档明确 `entire import` 不支持 OpenCode；但从已发布的“按需抓取未跟踪会话”修复起，显式 `session attach <id> --agent opencode` 可调用 export。按 ID 补抓不等于自动枚举/批量导入；枚举仍有开放请求。[^1][^12][^13] |
| 子会话 | 官方专页声明只捕获主 Session，并把缺少 subagent lifecycle hooks 列为限制。这里应理解为 Entire 当前集成覆盖，而非证明 OpenCode 原始数据没有 parentID 或 task 关系。[^1] |
| fork、revert、原始 CWD | Entire typed SessionInfo 只有 ID/title/createdAt/updatedAt，没有 parentID/directory/revert；没有找到对应 ATape 式 fork/Active Path/immutable Origin 归属契约。不能凭“完整 export”认定这些语义都进入其读模型。[^14] |
| compaction | 接收到 compaction 后经通用生命周期 transition，保持 ACTIVE。已读 handler 将动作交给 NoOpActionHandler，未在此调用 export；其注释提 offset reset，不应扩大解释成完整 Historical Branch 归档或压缩前 durable capture。[^15] |
| 更新发现 | 每次需要时全量 refresh；transcript position/slice 使用 messages 数量和 message index，不是 per-part revision、delete token 或 durable event seq。原地修改既有 message 而数量不变，不能从其 offset 算法推断有 ATape 所需的更新覆盖。[^16] |
| 文件/工作区边界 | 插件按 worktree 写入 `.opencode/plugins/entire.ts`，受 `os.Root` 约束；排除 `.opencode` 与 `opencode.json` 自身配置变化。历史归属依赖 Entire 当前 repo/worktree 工作流。[^6][^17] |
| 隐私 | `.entire/tmp` 导出是 0600 原始缓存；持久 checkpoint 写入前做 sanitize/redaction。应区分本机未脱敏快照与推送后的文件，不能宣称所有中间数据均脱敏。[^9][^18] |
| 上传 | checkpoint Git refs 本地先写，后随 Git pre-push 同步；不是固定周期向远端报告最新 Session 状态。[^19][^20] |

### 导出与“无损 Raw”的距离

本地刚物化的 export 保持 CLI 返回的 JSON 字节，但之后的 typed processing 不是全字段透明透传。`ChunkTranscript` 和 `SliceFromMessage` 都 unmarshal 到 `ExportSession` 再 marshal；该类型缺少 Session CWD/parent/revert、assistant.parentID/agent/path、part.reasoning metadata、tool.error/attachments 等字段，未知字段会在这些路径丢失。[^14][^16][^21]

`full.jsonl` 是 Entire 的文件命名和恢复路径，不应机械等同于 ATape 的 Raw Source Data 保真契约。另存的 `transcript.jsonl` 更是有意压缩：OpenCode compact emitter 仅提取 text/tool，用户非 text parts 被跳过，assistant reasoning 不进入正文；工具只归一成 output 和 success/error，pending/running 也进入非完成状态分支。[^18][^22]

因此可以借鉴它“源格式副本＋独立读模型”的分层；不能照抄其 Go DTO 或 compact 输出作为 ATape lossless Raw，也不能把 callID 同一性当作完整子线程谱系。

## 三条问题—修复—测试证据链

### 1. 大导出被截断，再到失败覆盖旧副本

**报告的问题。** 2026-04-02 合并的“OpenCode transcript export resilient to stdout truncation”描述 subprocess stdout capture 偶发截断，常见截断点约 65,536 bytes；JSON 校验失败导致 condensation 无法挂上/更新 transcript。PR 指向上游 OpenCode issue，并将其称为“checkpoint 无 linkage”问题的潜在修复，而不是确认解决所有同类症状。[^23]

**修复。** 原来的 `cmd.Output` 改为 stdout 直接写文件，并仍做 JSON 校验。之后“按需抓取未跟踪会话”PR 内的 `f84eb80ab` 又解决更深一层故障：即使有旧导出，缺 binary、超时、部分写失败或退出 0 但输出损坏，重新 export 也可能先截断最后好副本。改为 staging→validate→install，Windows 冲突保留 staging。两层修复均已包含在 v0.10.6。[^12][^24]

**测试证据。** 当前 `lifecycle_test.go` 有直接写文件/JSON 校验测试，还有 partial-failure、truncated-zero-exit、empty-zero-exit 不破坏缓存、有效导出替换缓存的测试。它们通过替代 export 函数构造故障，证明 Entire 缓存安装行为；并非证明任意 OpenCode 版本真实 export 永不截断。早期 PR 作者另报告 OpenCode E2E 49 passed、1 expected skip，这是当时运行声明。[^25][^23]

**可迁移经验。** 子进程返回成功、JSON 可解析、源快照完整、远端已确认是四件事。ATape 若采用 export，也应先稳定本地候选，再转换/分段/发布；不能覆写上次已承诺给 cursor 的字节。Entire 的 JSON 校验仅证明语法，不证明 Session ID 正确、messages 没缺页或跨表一致。

### 2. 重复 Session 创建与过快的 mid-turn commit

**报告的问题。** “session-start race when session.created fires twice”指出 `currentSessionID` 在 await 子进程之后才设置，第二个 created 可穿透 guard，导致重复 session-start。维护者评论链接到修复 PR，并明确宣布已进入 v0.5.6。[^26]

**修复。** “Make OpenCode E2E green again”集中处理相邻时序问题：同步 turn-start；先 reset/认领 Session 再 await；message.updated 做提前启动 fallback，避免 user text part 到达前 agent 已经 commit；turn-end 从导出补回空 prompt。它选择等待关键 hook 完成，以防丢失提交归属，而非将所有 hook 完全放后台。[^27]

**测试证据。** 现有 hooks 测试检查生成插件的 guard 顺序、sync 调用和 fallback 文本；通用 lifecycle 有 `BackfillsPromptFromOpenCodeTranscript` 的行为测试。前一类大量是模板静态检查，不等于真实事件重入模拟；原 PR 的 `mise run check` checklist 未勾选，不能据 PR 标題推断完整 E2E 全绿。[^28][^29][^27]

**尚未消失的边缘。** 2026-09-10 “Preserve user prompts when message events arrive in sequence”仍开放，报告 Entire 0.10.0/OpenCode 1.18.18 下 fallback 先标 seen 并送空 prompt，后续 text part 被 guard 跳过。当前源码确实保留这条顺序；turn-end backfill 能补部分元数据，但不能将开放报告改写成“已完整解决”。[^30]

**可迁移经验。** ATape 若要近实时同步，hook 可用作“需要刷新”的信号；完整源文本应从稳定快照读取。不要为了及时触发，把空 prompt 这种临时信号当成最终 Canonical 内容。若设计只靠异步 hook，必须针对 `opencode run` 同步 idle/退出验证生命周期，而不能只测交互 TUI。

### 3. CLI 能工作，Desktop hook 全部静默失效

**报告的问题。** “OpenCode hooks never fire in the OpenCode Desktop app”定位到插件使用 Bun globals，但 Desktop 的 Electron sidecar 是 Node；异常在 catch 内吞掉，表面上 OpenCode 正常，Entire 却没有触发。[^31]

**修复。** 2026-08-20 “spawn hooks via node:child_process for Desktop”统一使用 Node `spawn`/`spawnSync`，同时更新 repo 内 dogfood 模板，保留“插件不能让 OpenCode 崩溃”的策略。当前 template 对找不到 `entire` 直接 exit 0，stderr 也忽略。[^32][^2]

**测试证据。** 新增 Node canary 实际加载生成插件，用替代可执行程序 marker 验证异步 session-start、同步 turn-end 确实 spawn；缺 Node 会 skip。PR 勾选 unit/lint，通过完整 Desktop“prompt+edit+commit”的手工验收则未勾选。这是比字符串断言更强的 runtime 证据，仍不等于完整 Desktop 端到端认证。[^33][^32]

**可迁移经验。** 失败隔离应配套可观察性。吞异常能保护 coding agent，却把兼容性故障藏成采集空窗；ATape 已有 Collector Health/sourceFailures，值得明确区分“未安装”“导出失败”“旧缓存继续可读”“已确认最新版本”，不要只复用插件的静默策略。

## 持久化、重启与上传边界

Checkpoint 的存储单位是 Git tree/commit；当前 refs backend 为每个 checkpoint 使用独立 ref，避免共享 metadata branch tip 的常规竞争。写出的 checkpoint 同时有处理后的 full transcript、供展示的 compact transcript 和 metadata；Git commit trailer 是代码与上下文的关联点。[^18][^19]

上送队列存于 Git common dir，跨 worktree 共用，flock 下追加 JSONL；Drain 返回去重列表而不删除，只有 confirmed push 后 Remove。batch push 失败时逐 ref 恢复，不能成功的 ref 留在队列；非 fast-forward 使用 fetch/replay，不强推覆盖远端。其测试覆盖入队/去重、malformed 行以及 Remove 保留后到条目；并发安全由实际 flock 路径提供，但不把这里的顺序测试当作并发竞态证明。[^20][^34]

不过它不是一个跨“checkpoint ref 写入＋queue enqueue”的事务：`updateCheckpointRef` 先落 ref，再入队；入队失败只 warn。源码明确队列是唯一 push discovery，漏入队可能使本地 ref 长期不被同步。取消 context 被移除来缩小窗口，但断电、磁盘失败等不能靠这个手法消除；queue append 代码也没有逐次 `Sync`。[^35]

这是一项应披露的具体取舍：本地记录优先，push bookkeeping 失败不让本地 checkpoint 写失败。ATape 的 durable checkpoint/outbox 若承诺 at-least-once delivery，需保持自身“承诺进度与可重放源内容”原子边界；不能因 Entire 有 JSONL queue 就假定投递缺口已解决。

刷新失败同样是 best-effort：通用 hook 准备函数忽略 `PrepareTranscript` 错误；turn-end 路径会 warn，再检查文件是否存在。结合“失败保留旧缓存”，旧导出有机会继续被使用。保护最后好副本是正确的恢复资产，但不代表最新内容已被捕获；这与 ATape 同 cursor 必须重现相同观察/字节的契约不同。[^36]

## 成本与对 ATape 的操作性建议

每次 refresh 是新 CLI 子进程和全 Session export，再全文件读入做 JSON 校验；按 message chunk 也先 unmarshal 完整 export。其触发频率由 turn/commit 驱动，不是常驻每 30 秒扫全部历史。没有公开的这个路径 CPU/IO 定量保证，不能将“避免 SQLite 实现”写成“低开销已证明”。[^9][^10][^21]

E2E harness 还记录另一类实际成本：每个 repo 的 `.opencode` 可能使上游重新安装版本绑定的 plugin 依赖，曾导致大量测试超时；“stop paying per-directory plugin install”在测试准备里按 OpenCode 版本预建并共享依赖。它是 E2E 优化，不能宣称用户生产安装已获得同样缓存。[^7][^37]

| 借鉴程度 | ATape 的下一步 |
| --- | --- |
| 直接采用的原则 | 将 plugin/hook 触发、source acquisition、本地持久快照、Canonical projection、上传确认拆清职责；生成插件做漂移检测；任何导出先 staging/validate，再改变可见版本。 |
| 需要独立验证 | 在同一 OpenCode 版本上比较 `export→稳定快照` 与只读 SQLite 的一致性、耗时、峰值内存、重启/超时；用大 Session、原地更新、revert、fork、move 的 fixture 验证，不能只跑普通 text+commit。 |
| 不能照搬 | 静默 hook failure、message-count cursor、typed export 重编码当 lossless Raw、主 Session 限制，以及靠下次 Git push 实现远端新鲜度。 |
| 推荐的原型顺序 | 先验证“官方 export 获取一份可恢复、可重复消费的本地快照”；同时把它当基线和 SQLite 方案比较。hook 只做可选低延迟唤醒，历史发现与定期校验仍由 Collector 独立负责。 |

Entire 支持把 export 作为可信的**工程候选**，尤其适合避开私有 DB 实现细节；它的实际故障也说明 CLI 不是免费的稳定性抽象。决定 ATape 最终采集源之前，必须补齐历史枚举、子线程关系、源修订/删除、Raw 保真和固定 cursor 重放证据，而不是从成熟产品的采用直接跳到结论。

## 来源

所有源码链接固定到 `0138471ae764ca9b846ed21ce0a9ff917724d0bf`；GitHub issue 状态、release、官方文档于 2026-09-10 核验。以下均为 Entire 官方仓库、维护者公开记录或官方文档。

[^1]: Entire，OpenCode 官方接入页（preview、范围）。[来源](https://docs.entire.io/agents/opencode)。
[^2]: Entire，生成的 OpenCode plugin。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/entire_plugin.ts#L1-L269)。
[^3]: Entire，MIT License。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/LICENSE#L1-L21)。
[^4]: Entire，Release v0.10.6，2026-09-07。[来源](https://github.com/entireio/cli/releases/tag/v0.10.6)。
[^5]: Entire，固定 main 提交，2026-09-09。[来源](https://github.com/entireio/cli/commit/0138471ae764ca9b846ed21ce0a9ff917724d0bf)。
[^6]: Entire，OpenCode identity / preview / protected paths。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/opencode.go#L34-L56)。
[^7]: Entire，OpenCode E2E runner 的版本依赖与准备。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/e2e/agents/opencode.go#L147-L198)。
[^8]: Entire，Hook payload 和生命周期翻译。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/lifecycle.go#L47-L146)。
[^9]: Entire，PrepareTranscript / FetchTranscript / cache installation。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/lifecycle.go#L148-L296)。
[^10]: Entire，export 子进程、文件 stdout、超时与 fsync。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/cli_commands.go#L19-L76)。
[^11]: Entire，staging 与跨平台 rename。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/stage_export.go#L14-L97)。
[^12]: Entire，“fetch on-demand transcripts for untracked sessions”，2026-08-24。[来源](https://github.com/entireio/cli/pull/1877)。
[^13]: Entire，“discover untracked OpenCode sessions during session attach”，开放请求。[来源](https://github.com/entireio/cli/issues/1992)。
[^14]: Entire，typed ExportSession/Message/Part schema。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/types.go#L23-L111)。
[^15]: Entire，compaction handler。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/lifecycle.go#L1091-L1119)。
[^16]: Entire，message-index slice 与 position。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/transcript.go#L44-L90)。
[^17]: Entire，插件安装、漂移检测与 os.Root。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/hooks.go#L31-L154)。
[^18]: Entire，persistent transcript 写入、sanitize/redaction 与 compact。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/checkpoint/persistent.go#L988-L1088)。
[^19]: Entire，README checkpoint Git refs 与关联模型。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/README.md)。
[^20]: Entire，Git pre-push 的 batch/逐 ref 确认。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/strategy/manual_commit_push.go#L499-L599)。
[^21]: Entire，导出 JSON 分块与重编码。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/opencode.go#L75-L145)。
[^22]: Entire，OpenCode compact emitter。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/transcript/compact/opencode.go#L63-L220)。
[^23]: Entire，“make OpenCode transcript export resilient to stdout truncation”，2026-04-02。[来源](https://github.com/entireio/cli/pull/832)。
[^24]: Entire，“validate the export before installing it, not after” 修复提交。[来源](https://github.com/entireio/cli/commit/f84eb80ab)。
[^25]: Entire，export cache 故障回归测试。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/lifecycle_test.go#L369-L543)。
[^26]: Entire，“session-start race when session.created fires twice”及维护者发布确认。[来源](https://github.com/entireio/cli/issues/883)。
[^27]: Entire，“Make OpenCode E2E green again”，2026-04-17。[来源](https://github.com/entireio/cli/pull/967)。
[^28]: Entire，插件 guard/sync/fallback 测试。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/hooks_test.go#L81-L246)。
[^29]: Entire，OpenCode prompt backfill 测试。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/lifecycle_test.go#L1878-L1926)。
[^30]: Entire，“Preserve user prompts when message events arrive in sequence”，开放报告。[来源](https://github.com/entireio/cli/issues/2001)。
[^31]: Entire，“OpenCode hooks never fire in the OpenCode Desktop app”。[来源](https://github.com/entireio/cli/issues/2014)。
[^32]: Entire，“spawn hooks via node:child_process for Desktop”，2026-08-20。[来源](https://github.com/entireio/cli/pull/2018)。
[^33]: Entire，实际 Node runtime hook canary。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/agent/opencode/hooks_test.go#L442-L522)。
[^34]: Entire，push queue 恢复和并发测试。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/checkpoint/pushqueue_test.go#L14-L198)。
[^35]: Entire，ref 写入后的 best-effort enqueue。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/checkpoint/refs_store.go#L199-L246)。
[^36]: Entire，hook prepare 的 best-effort 行为。[来源](https://github.com/entireio/cli/blob/0138471ae764ca9b846ed21ce0a9ff917724d0bf/cmd/entire/cli/strategy/common.go#L1797-L1809)。
[^37]: Entire，“stop paying opencode per-directory plugin install”，2026-09-04。[来源](https://github.com/entireio/cli/pull/2270)。
[^38]: GitHub，entireio/cli 官方仓库元数据，2026-09-10 检索。[仓库 API](https://api.github.com/repos/entireio/cli)。
[^39]: Entire，v0.10.6 与固定 main 的比较。[发布后差异](https://github.com/entireio/cli/compare/v0.10.6...0138471ae764ca9b846ed21ce0a9ff917724d0bf)。
