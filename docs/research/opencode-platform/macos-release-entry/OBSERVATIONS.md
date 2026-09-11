# 正式 release contract 候选：macOS 原生读取验收

2026-09-11，PASS。候选 `df5fcbbcf2f8cb4ba6c79929d450b2e9160c2412` 的实际 `@atape/adapter-opencode@0.4.8` tarball，在新生成的官方 OpenCode 1.18.30 原生数据库上通过安装后公开 Interface 验收。本研究没有 build/pack、包发布、生产部署或改动生产工作树。

## 固定输入

- 实际 tarball SHA256：`57e02deb5cb44654e76f0cdfafc5ca957c50065ee029252cfd82a8b714b9ac54`，运行前、复制后及运行后核验；安装后的 bundle SHA256：`db6ffd14179a26e38fff2dbfae0df18863fb1d6f2e619cf311c1421a7eb62323`。
- 已安装 manifest 的 name/version 为 `@atape/adapter-opencode` / `0.4.8`，非 private；声明 `atape.source-capture.v1` 及 `atape.git-attribution.v1`。这只是候选 manifest，不表示已经发布 npm。
- [官方 1.18.30 macOS arm64 zip](https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-darwin-arm64.zip)：SHA256 `a5e43d6887386efc7d68ce49ae28e3bbdfdee3dfd1d7169b612c3ce67e53b1e8`；binary SHA256 `2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`，与先前研究缓存重新比对一致。
- 官方 tag 源码 `3104c1428ec91f809e5ab86631300de41eb6952e`；实际 binary 自报版本为 1.18.30。不宣称验证了上游 binary 与 tag 的可复现构建关系。
- 实际宿主 macOS 26.3.2 arm64、Node v24.18.0；本次只增加这一已选组合的候选绑定证据，不扩展平台/版本支持。

## 原生生成、实际安装与断言

新独立 scratch 中的 HOME/XDG/TMPDIR、OpenCode auth/config 从白名单构造，不读取用户历史、账户或配置。模型仅配置固定 loopback stub，compaction 实际发出一次 stub 请求；没有付费模型。macOS 本轮没有 OS 网络阻断或全机抓包，不把配置隔离称为断网证明。

复用 [6d1c082 的受控生成方式](https://github.com/SingleMai/ATape/blob/6d1c082db48793dff8a48050552b2a7fc586be14/packages/application/prototypes/opencode-native/OBSERVATIONS.md)：官方 public API 创建 root/noReply/child，修改文本及开放 metadata，执行固定 printf shell，fork，revert/unrevert，loopback compaction。官方进程自行建库、写入；实验 Python SQLite 仅读取，没有 SQL 重建 fixture。

官方 server 正常停止后，由新的官方 CLI export 进程导出三会话。API messages = CLI export messages = 实际 SQLite 主键/外键复原消息，逐对象完全相同。
实际计数为 3 Sessions / 9 messages / 11 parts / 37 events / 3 event_sequence / 0 session_message，WAL 模式。

实际 tarball 在仓库外以 `npm install --offline --ignore-scripts` 安装，独立空 npm user/global config 和 cache；验收 Node 程序只依赖该安装包与 Node 内置库。Adapter context 的版本来自实际 manifest，没有沿用旧的 0.0.0 常量。

| Source | Raw on frames | Threads | Canonical Events | Usage |
| --- | ---: | ---: | ---: | ---: |
| root family | 16 | 2 | 6 | 1 |
| fork | 7 | 1 | 4 | 0 |

- Discovery pageRows=1，4 页完成（包含 child-only 页推进），仅返回 root/fork；child Thread parent 为 root，Origin 为官方创建目录。
- Projection 每页 ≤2 frames、JSON ≤262144 bytes，完整输出计数与 target 一致。
- Raw on 三会话的原始 message/part JSON TEXT 复原后逐消息精确匹配官方 export，开放 metadata sentinel 保留。Raw off 每帧均无 raw；两种模式 Canonical Events/Usage 完全相同。
- 完成态工具输出、derived 摘要可见。这里使用显式 child API，不代表真实模型执行 task subagent。

## 源数据只读与失败记录

Adapter 读取前后，DB/WAL 的字节数、SHA256、mtime 完全相同；SHM 字节与 SHA256 相同，mtime 单独记录在 [results.json](results.json)。本次不承诺所有 SQLite 共享内存元数据不变，也未在 Adapter 读取期间保留官方 writer。

第一次 harness 在 native 生成成功后、npm 安装前失败：user/global config 同指 `/dev/null` 导致 npm 拒绝重复加载。原输出保留为 [initial-harness-failure.txt](initial-harness-failure.txt)。修正为 scratch 内两个独立空配置文件后，在全新目录完整重跑成功；未改 Adapter、tarball 或数据库来通过断言。

## 复现与证据范围

```sh
rtk proxy python3 docs/research/opencode-platform/macos-release-entry/run.py --binary "$OFFICIAL_MAC_BINARY" --tarball "$EXACT_TARBALL" --output "$NEW_SCRATCH" --sha256 57e02deb5cb44654e76f0cdfafc5ca957c50065ee029252cfd82a8b714b9ac54 --candidate df5fcbbcf2f8cb4ba6c79929d450b2e9160c2412 --version 0.4.8
```

输出目录必须是新的仓库外目录，控制器每一步 180 秒硬超时并处理整个子进程组。官方生成与 export 的 HOME/XDG 始终隔离；正常运行后官方 server 已退出。
[provenance.json](provenance.json) 记录候选、官方 asset、脚本 hash、完整原始 scratch；[results.json](results.json) 是紧凑机器结果，[verification.stdout.txt](verification.stdout.txt) 保留 PASS 输出。原生 DB/WAL/SHM、API/CLI exports、安装产物仅留在 scratch，不提交仓库。

这项证据验证实际 Adapter 包对新鲜原生 v1 SQLite 的读取和投影，不覆盖 CLI 常驻调度、真实 Server HTTP ACK、Search、Git 归属、Raw 远端可读性、长会话性能、并发 writer、SIGKILL/掉电或其他版本/平台。它不重跑容量实验，也不自动关闭原型/HITL 或授权发布。
