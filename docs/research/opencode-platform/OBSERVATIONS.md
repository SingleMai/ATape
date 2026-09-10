# OpenCode 支持平台与 CaptureJournal 磁盘满研究证据

检查日期：2026-09-11（Asia/Singapore）。本分支只归档研究产物，不含生产实现、包发布或部署。
研究基线 `cdaad4a94f3b209681257972ba15c8c3705efde6`；两个原始实验实际检查的候选均为 `000668f83864fbebaae0fa384d9f2a3eb5fe4c6f`。

| 实验 | 实际执行组合 | 结论 |
| --- | --- | --- |
| 官方 OpenCode 原生生成 → 私有 Adapter | Linux arm64，glibc 2.36，Node 24.20.0，OpenCode 1.18.30 | 原生运行、Raw/export 比对及只读源数据检查通过 |
| CaptureJournal 真实 ENOSPC | Linux arm64，Node 24.20.0，16 MiB tmpfs | 原有数据保留、释放空间后恢复；发现错误分类为 `io` 的缺陷 |
| max_page_count 替代探针 | macOS arm64，Node 24.18.0 | 外部连接的限制不影响 Journal 连接，不能代替真实 SQLITE_FULL 验收 |

这些是有限组合的执行证据，不足以宣称 amd64、musl、Windows、其它 Node/OpenCode 版本或完整 Collector 后台链路受支持。

## Linux 原生运行

来源固定为官方 [v1.18.30 release](https://github.com/anomalyco/opencode/releases/tag/v1.18.30)，发布时间 `2026-09-09T03:34:27Z`，tag commit `3104c1428ec91f809e5ab86631300de41eb6952e`。
[Linux arm64 glibc 下载包](https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-linux-arm64.tar.gz)的 release API digest 与下载 SHA256 相等：
`4111a55c2a02c0fac314bd51e9a2330280e6d29d2b85b9554fff6d62612566ed`。
解压后可执行文件 SHA256 为 `01edb5839aa10d5b09133fedcb335a062ecad6e82552933bb14f71756f2b296b`；容器内真实 `--version` 为 `1.18.30`。

候选私有包 `@atape/adapter-opencode@0.0.0` 来自既有 dist，经 `npm pack --ignore-scripts` 打包，未修改生产工作树。
tarball SHA256 为 `2ee430414ff0f90bc3ba0460bbc27b1fd5fb37af9a01743cb652516becb426fd`，已安装 bundle SHA256 为 `1536a25a62c4c5f188eab54145b4a4a30e5425e5ee880d72b33779ab2bc7450f`。
容器 `npm install --offline --ignore-scripts` 后，验收程序仅使用 Node 内置库及包公开 `createAtapeAdapter` Interface。

原生 generator 基于研究提交 [6d1c082 的 generate.py](https://github.com/SingleMai/ATape/blob/6d1c082db48793dff8a48050552b2a7fc586be14/packages/application/prototypes/opencode-native/generate.py)，Linux 副本仅更正 RSS 单位注释。
所有源写入来自官方 public HTTP API / CLI；Python SQLite 仅以 `mode=ro` 查询，没有手写 SQL 插入或重建 fixture。

- 创建 root 与 noReply 文本，PATCH 文本与开放 metadata 中的未知字段；创建显式 `parentID` child 及 noReply 文本。
- 官方 shell API 执行固定 `printf`；fork API 复制当时消息，形成独立 root。
- revert 后消息数保持 3；unrevert 后继续 summarize。压缩实际调用一次容器 loopback 固定 stream 响应，未调用付费模型。
- 官方 CLI export 的 root/child/fork messages 完整等于对应 HTTP API，也等于实际 SQLite 行按官方 identity 复原的数据。
- 真实数据库含 3 sessions、9 messages、11 parts、37 events、3 event_sequence、0 session_message，WAL 模式；证实该受控普通 API 流程使用 v1 表，不把空 v2 表存在视为已支持 v2。
- Adapter Discovery pageRows=1，4 页完成（包括 child-only 页推进），仅发现 root/fork；Origin CWD 为官方创建目录。
- root family：16 frames、6 Events、1 Usage、2 Threads；fork：7 frames、4 Events、0 Usage、1 Thread。child 的 Thread parent 为 root。
- 每页最多 2 frames、262144 字节；Raw on 原始行复原的每个消息精确等于三份官方 export，未知 metadata 保留；Raw off 无 raw，两种模式的 Canonical Events/Usage 相同。
- 完成态工具输出可见，摘要输出为 derived Event。直接 child API 并非真实 task subagent 模型运行。

读取发生在官方 server 停止、CLI export 完成后，数据库/WAL 仍为原生文件，未执行 checkpoint。此实验不新增并发源写入或 SIGKILL 恢复保证。

### 原始 SHM 断言及精确只读范围

初次断言“DB/WAL/SHM 全部 hash 和 mtime 均不变”失败，原始输出保留在 [original-shm-assertion.txt](linux-native/original-shm-assertion.txt)。
DB 与 WAL 的字节数、SHA256、mtime 均不变；SHM 字节数与 SHA256 不变，但 mtime 改变。SQLite 只读连接仍可能维护共享内存读锁/read-mark，不能承诺所有 sidecar 元数据不变。
修正验收分别记录上述字段，没有更改 Adapter 或源数据库。[results.json](linux-native/results.json) 保留通过结果；两次原始快照的区别仍可审计。

## 真实 ENOSPC 与尚未合入的修复

16 MiB tmpfs 被填至 `availableBytes=0`，真实 Node `writeSync` 抛 ENOSPC；没有 Mock，也不是 Journal 逻辑预算触发。
7 个独立 Node 子进程依次 seed、physical、fill-write、reopen-full、free、recover、physical；不共享连接或 JS 对象。
原有已封存未确认的 512 KiB unit、session/thread revision 1，在失败、重开及恢复后完全相同；checkpoint、activation receipt 均为 null，unit 仍 pending，receiptJson 为 null。
失败的 2 MiB append 不遗留部分 unit；释放空间后同一 identity 可追加、封存、读回。前后 integrity_check 均为 ok。

失败链清楚指向 [000668f 的 transaction catch](https://github.com/SingleMai/ATape/blob/000668f83864fbebaae0fa384d9f2a3eb5fe4c6f/apps/cli/src/runtime/captureJournal.ts#L179-L183)：
SQLITE_FULL `errcode=13` 后 SQLite 已自动结束事务，无条件 ROLLBACK 再抛 `errcode=1`，覆盖原错误。
公开 Interface 因而返回 `CaptureJournalError(reason="io")`，未保留应有的 capacity 分类。未观察到数据丢失或虚假 ACK，但分类缺陷是原始候选的实际失败。

归档时修复正在 `ATape-capture-disk-full` 独立工作树推进，尚未 merge/release；本报告不把修复候选、后续提交或通过测试自动等同已发布。
[compact-results.json](enospc/compact-results.json) 永久记录原候选失败，不随复跑改写。

`prototype.ts` 对真实 SQLite exec/run 仅包裹错误记录，不替换 SQL、结果或注入故障。payload 是合成 bytes，不是有效 Canonical HTTP wire manifest，也无远端 ACK。
关闭 SQLite 可能 checkpoint 并释放 WAL/SHM 空间；free 前可用空间已回到 45056 字节。因此“新进程重开成功”不代表严格零剩余空间时总能重开。
仅单一 tmpfs 场景，无 power-loss、SIGKILL、inode exhaustion、APFS、Windows 或 amd64 执行证据。

`max-pages.ts` 另证：一个连接设置 max_page_count=20，另一个与重开连接仍为 4294967294；Journal 公开 append 2 MiB 成功，page_count 从 20 增至 532。
外部连接无法据此限制封装内 Journal，不应为这个测试新增生产 Seam 或暴露数据库连接。

## 固定环境、隔离及复现

两个 Linux 原始实验均在 Colima 实际 arm64 Linux 中执行，无跨架构模拟。固定 Node **OCI index**：
`node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2`。
[image-manifest.json](enospc/image-manifest.json) 保留原始 multiarch index；arm64/v8 manifest 为 `sha256:78b162211207872503ea9245188122b815150b9b4380e47a7c4a447332c01660`。
amd64 manifest 可用只说明可下载，不等于执行验收。

所有容器 `--network none`，通过 docker cp 复制受控文件，不挂载宿主目录、Docker socket 或用户配置。OpenCode 子进程使用从零构造的 HOME/XDG/TMPDIR 与无凭据环境，只访问 loopback stub。
原生实验为 2 GiB / 2 CPU / cap-drop ALL / no-new-privileges；ENOSPC 为 256 MiB、16 MiB tmpfs。已删除各自临时容器，没有启动宿主 OpenCode、读取用户历史或耗尽宿主磁盘。

复现输出必须放到新的仓库外目录。下例变量由操作者填写；脚本不依赖原作者宿主路径。固定旧候选的 dependencies/bundle 应先准备好；不提交生成物。

```sh
# TARBALL 指向已构建候选；默认校验原始 tarball SHA256。另一个候选必须显式指定新 hash。
rtk proxy python3 docs/research/opencode-platform/linux-native/run.py --tarball "$TARBALL" --output "$NEW_LINUX_OUTPUT"
# 可选 --archive "$OFFICIAL_ARCHIVE" 复用下载，但仍核对固定官方 SHA256。

# CHECKOUT 选择待查提交且已安装构建依赖；build-provenance 记录 commit/dirty/esbuild/bundle hash。
rtk proxy node docs/research/opencode-platform/enospc/build-probes.mjs "$CHECKOUT" "$NEW_BUILD_OUTPUT"
rtk proxy python3 docs/research/opencode-platform/enospc/run.py --bundle "$NEW_BUILD_OUTPUT/prototype.mjs" --output "$NEW_ENOSPC_RESULT"
# 默认 expected-reason=io 重现原始缺陷；另行验收修复时显式加 --expected-reason capacity。
rtk proxy node "$NEW_BUILD_OUTPUT/max-pages.mjs"
```

原始 prototype 仅收集诊断，子进程错误可能不影响控制进程 exit code；归档 runner 因而检查每阶段状态、真实 ENOSPC、公开错误分类、原快照、pending/receipt、无部分 unit、恢复与 integrity。
归档时实际重新运行了 Linux 新 runner、ENOSPC 原 bundle、新参数化脚本重建的 bundle，全部符合各自期望；没有用新结果覆盖旧失败。[replay-validation.json](replay-validation.json) 记录这一检查。

[Linux provenance](linux-native/provenance.json)、[ENOSPC provenance](enospc/provenance.json) 中的绝对路径仅标识原始研究目录。归档仅含脚本、摘要及 hash，不提交 binary、tarball、bundle、数据库或大段模型/用户数据。
此证据供 issue 115/114 链接；不是安装版 CLI 注册、后台同步、Canonical/Raw HTTP delivery、Server 或产品发布验收。
