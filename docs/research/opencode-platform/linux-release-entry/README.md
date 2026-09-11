# Linux arm64 正式入口候选原生验收

2026-09-11，**PASS**。验收对象是 PR #148 的候选 `df5fcbbcf2f8cb4ba6c79929d450b2e9160c2412` 实际 tarball；本次没有构建、重新 pack、发布或部署。

- 包：`@atape/adapter-opencode@0.4.8`；tarball SHA256 `57e02deb5cb44654e76f0cdfafc5ca957c50065ee029252cfd82a8b714b9ac54`。
- 安装后入口 SHA256：`db6ffd14179a26e38fff2dbfae0df18863fb1d6f2e619cf311c1421a7eb62323`；通过 `npm install --offline --ignore-scripts --no-audit --no-fund` 安装精确候选，没有执行 package lifecycle。
- 平台：Linux aarch64、glibc 2.36、Node v24.20.0；固定镜像 multiarch index `node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2`。
- 官方 OpenCode v1.18.30 / 源码 commit `3104c1428ec91f809e5ab86631300de41eb6952e`；官方 linux-arm64 archive SHA256 `4111a55c2a02c0fac314bd51e9a2330280e6d29d2b85b9554fff6d62612566ed`，binary SHA256 `01edb5839aa10d5b09133fedcb335a062ecad6e82552933bb14f71756f2b296b`。

## 验证结果

通过官方本机 API/CLI 生成 root、child、fork、可变 text part、实际 shell tool、revert/unrevert、受控本地模型 stub 的 compaction；没有付费模型或私人历史。该次生成耗时 46.735 秒。原生 v1 表为 3 sessions、9 messages、11 parts、37 events，`session_message=0`，journal mode 为 WAL。

实际安装包的 manifest 版本、Adapter protocol、SourceCapture 与 gitAttribution 声明均有断言；factory context 从安装后 manifest 读取实际 `0.4.8`，没有继续使用历史 harness 的 `0.0.0`。生产读取/语义未修改；原 linux-native 脚本和实验结果未覆盖。

- discovery 使用每页 1 row，4 页完成；只发现 root 与 fork，child 作为 root 家族中的 thread。
- root：2 threads、6 Events、1 usage，Raw-on 16 frames；fork：1 thread、4 Events、0 usage，Raw-on 7 frames。
- 每页最多 2 frames 且不超过 262,144 bytes；源限制 row 65,536 bytes / page 262,144 bytes / 1 row / 1,000 records / 20 threads / 10 秒。目标最多 1,000 Events、1,000 usage。
- Raw-off/on 的 Canonical Events 与 usage 完全相同。root/child/fork 的 Adapter Raw message/part 重新 hydrate 后逐项等于官方 export；export 本身也等于原生 API 与 SQLite。
- 实际 tool output、derived compaction summary、本地 stub 调用、开放 metadata 中 unknown sentinel 的保留均通过。顶层未知扩展被官方 API 丢弃，未把它伪报为保留。
- Source DB 与 WAL 在 Adapter 前后的 size、mtime、SHA256 均相同；SHM bytes/hash 相同，**SHM mtime 改变**，不宣称所有文件元数据完全不变。

## 隔离与证据边界

runner 创建唯一 Docker 容器，`--platform linux/arm64 --network none --memory 2g --cpus 2 --cap-drop ALL --security-opt no-new-privileges`，没有 host mounts；只 `docker cp` 受控脚本、指定 tarball 与已校验官方 binary。HOME/XDG/auth/config/临时目录全部隔离；仅容器 loopback 承载 OpenCode API 与模型 stub。容器已由 finally 清理。尝试事后额外 docker inspect 时容器已不存在；本次隔离配置证据来自已执行 runner 参数与 provenance，不额外宣称保留了运行中 inspect 快照。

这是 **Adapter 导出 factory + SourceCapture public Interface** 验收；通过显式 `OPENCODE_DB` 指向受控来源。不是 CLI 工具命令注册、默认路径发现、Git 归属或 ATape Server HTTP/真实 ACK 的端到端验收；gitAttribution 在这里仅验证 manifest 声明。fixture 的 root/child/fork 路径使用 directory project。其他平台、musl、其他 OpenCode 版本、v2 session_message 不在本次范围。

`maxChildRSSNativeUnits=539396` 是 Linux KiB，表示 version/server/export 子进程峰值的最大值；不是 Adapter 自身增量内存，也不是该次整个流程的内存之和。没有新增性能或吞吐结论。

## 复现

下列命令需已有精确候选 tarball、缓存官方 archive、Docker 和固定镜像；输出目录必须尚不存在且位于仓库外。无需 build 或 pack：

```sh
rtk proxy python3 docs/research/opencode-platform/linux-release-entry/run.py \
  --tarball /absolute/path/atape-adapter-opencode-0.4.8.tgz \
  --expected-tarball-sha256 57e02deb5cb44654e76f0cdfafc5ca957c50065ee029252cfd82a8b714b9ac54 \
  --archive /absolute/path/opencode-linux-arm64.tar.gz \
  --output /tmp/atape-linux-release-entry-new-run
```

runner 容器总等待最多 600 秒，容器内每个 generation/install/verification 子进程最多 180 秒，结束必清理自身容器。不得用同一 output 覆盖本次证据。

本次完整本地产物保存在 `/tmp/atape-linux-release-entry-df5fcbb`；这里只归档脚本和小型 JSON/text 证据，不提交二进制、tarball 或 SQLite。`results.json` 保留完整 public Interface 观测与文件指纹；`native-manifest.json` 保留原生生成/API/export/SQLite 结论；`platform.json`、`provenance.json` 绑定平台与 artifact；`verification.stdout.txt` 是原始紧凑 PASS 输出。
