# 有限规模 OpenCode source + Host 冻结准备容量原型

日期：2026-09-11。此目录为独立 `/tmp` 原型；不修改生产工作树，不选择发布默认值，不发布或部署。

## 环境、范围与测量口径

- 源码：`/Users/liying/.codex/worktrees/1199/ATape-opencode-daemon`，main `50c52c57141037f403e1a553db164c3339a94401`。
- macOS 26.3.2、Apple M5 Pro、24 GiB RAM、arm64，Node v24.18.0，esbuild 0.28.2。
- bundle SHA-256：7b2f961072866a79f88b11f223275eb2270dba140d19dee8f787af7a223d2b27。
- 每 case 独立 Node 进程，串行运行；每 case 仅一次；控制器以进程组设置 120 秒硬超时，五个 case 均未触发。
- `preparationMs` 从调用实际 `preparePublicationCanonical` 到返回/typed failure，包含其内部实际 OpenCode source 开启、完整规划/读取、Host 变换、逐记录版本/绑定、最终 wire units 冻结、来源关闭和本机 seal。
- 不包含合成 SQLite 建库、journal bootstrap、Begin；这些计入 `processWallMs`。
- maxRSS 取 macOS `/usr/bin/time -l` 的 `maximum resident set size`，单位 bytes，覆盖整个独立进程（含 fixture 构造）；不是某一次 prepare 的 heap，也不是累积 children max。保留逐 case `.time.txt`。
- DB/WAL/SHM 在 journal connection 尚打开且完成准备时测量一次，另记录关闭后的大小。不是全程 peak disk sampling。四个正常 case 关闭后 WAL/SHM 均为 0。
- 所有 source DB 和 journal 位于每 case 的独立临时目录，结束即删除；只保留脚本和结果。没有读取私人 OpenCode history。

## 受控输入和真实 Interface

从仓库固定 `native-v1.json` 取官方 OpenCode v1.18.30 原型记录的 v1 DDL、root Session 和 root Created Origin 证据，再合成该 root 下的 message/part 行。
这是合成负载，不宣称这些批量行曾由 OpenCode native API 写入；原始 fixture 副本保留为 `native-fixture.json`；它仅含先前受控原型数据，没有用户历史。
每例一个 Thread，恰好 1,000 或 10,000 个 user message，各一个 text part；每条文本 UTF-8 精确 1,024 bytes，包含中文、emoji、递增编号及 ASCII 填充。
Raw-on 读取 1 个 Session + N 个 message + N 个 part，共 2N+1 个 Raw records。没有 tool、usage、图片、复杂嵌套或 child/fork 负载。

调用真正的 `openOpenCodeCapture` 与 `preparePublicationCanonical`，本机存储为真实 `CaptureJournal` Node SQLite Implementation，masking 使用真实 `makeSecretRedactorLayer`。
全部打入一个 ESM bundle，Effect 与 Module 服务身份共用同一实例。
测试 Adapter 只通过既有 PublicationTransport Seam 提供 control Begin/capabilities/status。
正常四例均未调用内容 put/seal/validate/activate，`contentTransportCalls=0`；没有模拟或真实 HTTP ACK，Canonical checkpoint 与 activation receipt 保持 null，完成状态只指本机 sealed。
Raw-on 原始 authority 为明确 TestAdapter 值，本阶段不上传 Raw、也不接受 Raw receipt。

## 明确的实验限额（不是默认值）

- Source：rowBytes 1 MiB；pageBytes 4 MiB；pageRows 100；records 100,000；threads 20；duration 115 秒。
- Projection：events/usage 各 20,000；pageItems 100；pageBytes 4 MiB。
- Journal：unitBytes 5 MiB；targetBytes 128 MiB；pendingBytes 256 MiB；unitsPerTarget 4096；recordsPerTarget 100,000；metadataEntries 1,000,000。
- Negotiated Canonical：partBytes 4 MiB；targetBytes 128 MiB；userPendingBytes 256 MiB；parts 4096；reservations 10；reservation/lease 60 秒。
- Raw：objectBytes 3 MiB；wireBytes 5 MiB；targetBytes 96 MiB；units 4096。
- 拒绝 case 只将新候选 negotiated Canonical targetBytes 改为 1 MiB；其他相同。完整配置见 `results.json`。

## 正常 case 结果

所有大小列用 MiB（1,048,576 bytes）；精确字节在 `compact-results.json`。Canonical bytes 为最终本机冻结的 transport envelope；Raw bytes 同样包含 Base64 和 wire metadata，并非原始 source JSON 字节。

| Events | Raw | 准备秒 | 进程峰值 RSS MiB | Canonical MiB | Raw wire MiB | metadata entries | DB MiB | WAL MiB |
| ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | off | 2.056 | 212.2 | 1.361 | 0.000 | 2,008 | 2.512 | 1.638 |
| 1,000 | on | 2.991 | 202.0 | 1.491 | 2.234 | 6,031 | 7.062 | 1.238 |
| 10,000 | off | 21.726 | 315.7 | 13.634 | 0.000 | 20,026 | 23.973 | 1.701 |
| 10,000 | on | 31.893 | 354.2 | 14.931 | 22.323 | 60,229 | 70.203 | 1.709 |

- 1,000/10,000 Raw-off 分别生成 2/20 个 Canonical units；Raw-on 同样 2/20 个 Canonical units，额外 21/201 个 Raw units，全部 0 gaps。
- Source SQLite 分别 1,884,160 / 18,255,872 bytes。
- 10,000 Raw-on 账户 retained prepared bytes 为 39,063,234，DB 为 73,613,312，说明 payload budget 不等于 filesystem 文件大小。
- metadata 行组成：Raw-off 的 K=R=N+2；Raw-on 的 K=R=3N+3；再加 scope、capture、units。四例分别 2,008、6,031、20,026、60,229 entries。
- 10,000 Event 的 Host Canonical materialization upper bound 分别为 35,973,590 / 37,333,590 bytes；它与 wire bytes 是不同容量口径。
- 一次 Raw-on 的 RSS 低于对应 1,000 off case 不能证明 Raw-on 更省内存；每例仅一次，GC、系统负载均可能影响。

## 超 target 的拒绝案例

先用 1 个 Event 建立受控 baseline，经真实 `deliverPublicationCapture` 验证 TestAdapter 返回的模拟 receipt 并更新本机基线。
这一步有 4 次 TestAdapter 内容操作，不是真实 HTTP/PostgreSQL ACK，也不能充当服务端验收。
随后将 source 替换为 1,000 Events，给新 Begin 的 negotiated targetBytes=1 MiB，调用实际准备 Interface。

- 约 1.020 秒返回 `PublicationPreparationError` / `reason=capacity` / `Canonical target exceeds negotiated publication capacity.`。
- 新候选 `preparing`、`seal=null`、没有新 unit；journal 唯一 unit 为 baseline 已有的 2,337 bytes。
- baseline checkpoint `baseline-head` 不变；published/observed Canonical coverage 均仍为 `baseline`。
- 失败前已分配的观察 metadata 仍保留，共 1,013 entries；不能把准备失败理解为整个观察的所有版本分配回滚。这符合 unsealed recovery 后丢弃候选、版本不倒退的既有契约。
- 未另做巨大单行 case；本轮明确覆盖的是 target admission 拒绝。

## 可重复命令

无需 Docker 或 HTTP。归档脚本用显式 checkout 参数解析生产源码，用 bundle 相邻的受控 fixture 文件取代机器绝对路径。`CHECKOUT` 应固定在上面的 main commit 且已准备构建依赖；输出必须是新的仓库外目录。

```sh
rtk proxy node docs/research/opencode-platform/capacity/build-probe.mjs "$CHECKOUT" "$NEW_BUILD_OUTPUT"
rtk proxy python3 docs/research/opencode-platform/capacity/run.py --bundle "$NEW_BUILD_OUTPUT/capacity.mjs" --output "$NEW_RESULT_OUTPUT"
# 可选 --case 1000-off-normal 仅做单例 smoke；--node 可指定 Node 24 可执行文件。
```

构建记录包含实际 commit/dirty/esbuild/bundle SHA，并将受控 fixture 复制到 bundle 相邻目录；不需要修改生产 checkout。
控制器只在 macOS 运行，以保留 `/usr/bin/time -l` RSS 字节口径；每例进程组硬超时 120 秒，拒绝覆盖结果，并检查公开状态/typed failure，不能只根据 exit code 判定成功。
本归档保留原始五例结果，重跑应另存并标注新 commit/bundle SHA，不与本次性能数字混用。
原作者绝对路径仅作为历史来源标识保留在本报告与 provenance，运行脚本没有该依赖。

## 局限

这是单平台、单次、单 Thread、纯文本的新 capture 准备成本；不包括归属判定、unchanged preflight、多会话并发、HTTP/Raw 上传、服务端验证/Search、daemon常驻或长期metadata保留。
来源使用规则的 1 KiB 文本，不能代替多MiB tool输出、复杂JSON脱敏或所有native schema分支。
没有主张 Linux/Windows 或生产硬件相同性能，没有据此选择发布默认值；这些数据仅供 HITL 讨论首版范围及容量。

完整机器数据：`results.json`；紧凑摘要：`compact-results.json`；源码：`capacity.ts`；构建入口：`build-probe.mjs`；120s控制器：`run.py`。bundle/SQLite 不归档，运行时仅生成于仓库外目录。

## 归档入口检查（不替换原始五例）

参数化构建与单个 `1000-off-normal` smoke 已实际运行通过，证据为 [archive-smoke.json](archive-smoke.json)。
归档时提供的 checkout 已前进至 `c6b8dcafbf43d9841f82f1dc7490296465348313`（clean）；此 smoke 只检查新的路径参数/fixture 布置/控制器可运行，不能与原始 main `50c52c5` 五例合并或据此更新性能结论。
原始 `results.json`、`compact-results.json` 与 `native-fixture.json` 已逐字节比对，没有改变；本次没有重跑全部五例。
