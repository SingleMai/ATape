# 10,000 Event 连续观察与安全 metadata 清理容量原型

验证日期：2026-09-11。生产候选固定为 `60964394cdf7413a11c5843e669f96c87467d381`，未修改仓库、共享 dist 或私人来源。

五轮全部成功，独立进程退出码 0；`/usr/bin/time -l` 总 wall 210.40 秒，controller 对整个 Node 进程组设 450 秒硬限。仅跑正例，未运行无清理对照。结果是受控实验，不是发布默认额度或多平台性能承诺。

## 输入、Interface 与结算边界

- macOS 26.3.2 arm64，Node v24.18.0；生产 Source `openOpenCodeCapture` + Host `beginPublicationCapture` / `preparePublicationCanonical`，同一个 esbuild bundle 中共用 Effect。
- 使用仓库受控 native v1 fixture 的 SQLite schema、root/session 创建上下文；10,000 message/text part 由实验脚本合成，不宣称是 OpenCode CLI 原生生成的 10,000 次交互。
- 每条正文 UTF-8 精确 1,024 字节，包含中文及 emoji。首次生成后，每轮仅改同一个 part 正文最后一个 ASCII 字符；键集合、其余行及 timestamp 保持不变。
- 五轮都 Raw-on。Canonical 通过明确的 `PublicationTransport` TestAdapter 走真实 Host delivery/activation Interface；Raw 通过公开 Journal `RawAcknowledged` 写入标明 `SIMULATED-MODULE-ACK-NOT-HTTP` 的模拟凭据。**没有 HTTP、真实 Server 或真实远端 ACK；不验证远端归档可读取。**
- 每轮模拟结算后，公开 `reclaim(owner,id,32)` 分批释放已确认 payload，再公开 `pruneRecords(owner,100)` 至返回 0。没有直接修改 Journal 表。
- 固定 `metadataEntries=110000`；沿用上轮其余实验限额：Source row 1 MiB / page 4 MiB / 100 rows / 100,000 records / 20 threads / 115 s；projection 20,000 Events、20,000 usage、100 items/4 MiB；Journal unit 5 MiB、target 128 MiB、pending 256 MiB、4,096 units、100,000 records；Raw object 3 MiB、wire 5 MiB、target 96 MiB、4,096 units。完整参数在 compact-results.json，未在运行中放宽。

## 逐轮结果

cleanup 包含模拟 Canonical delivery、Raw settlement、payload reclaim 与 membership prune；prune 是其中子区间。RSS 是轮末瞬时值，不冒充每轮峰值。

| 轮次 | prepare 秒 | cleanup 秒 | 其中 prune 秒 | metadata 清理前 → 后 | prune 行数 | 轮末 RSS bytes |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 34.880 | 0.163 | 0.000 | 60,229 → 60,229 | 0 | 309,329,920 |
| 2 | 39.082 | 1.368 | 1.320 | 90,254 → 60,251 | 30,003 | 343,736,320 |
| 3 | 38.068 | 1.314 | 1.232 | 90,276 → 60,273 | 30,003 | 342,097,920 |
| 4 | 36.544 | 1.173 | 1.092 | 90,298 → 60,295 | 30,003 | 314,097,664 |
| 5 | 51.171 | 1.296 | 1.208 | 90,320 → 60,317 | 30,003 | 294,748,160 |

每轮 Canonical 冻结 20 units / 15,656,250 bytes。首轮 Raw 201 units / 23,406,984 bytes；后四轮每轮只新增 1 unit / 2,712 bytes，复用 20,000 条 Raw records。五轮 Raw records 均 20,001，gaps 均 0。

后四轮每轮 prune 恰好 30,003 行，共 301 个非空批次，最大批次 100；总计回收 120,012 条 membership。每轮 payload 最终 retained bytes、pending units、retained units 均为 0。

每个观测点均断言 `binding.metadata_entries = scopes + captures + units + source_record_versions + capture_records` 实际行数之和，并断言各 capture 的 retained_records 合计等于 capture_records 实际行数。清理 credit 与 DELETE 行数逐轮相等。

第五轮最终实际账本：`1 scope + 5 captures + 305 units + 30,003 source_record_versions + 30,003 capture_records = 60,317`。后续每轮净增 22（1 capture + 20 Canonical units + 1 新 Raw unit），metadata 并非永久不增长。

## 保留与引用断言

每轮通过公开 `records` 每页 100 条遍历当前 Event：全部 10,000 个键存在，后四轮每轮恰好 1 个 fingerprint 改变且 revision 加 1，其他 9,999 个 Event 的 revision 与首轮 Raw object refs 均未变。三个 coverage 指针指向当轮 capture，checkpoint 逐轮推进。

Node 退出后只读复核最终文件：当前 Event 10,000 / Raw 20,001 / session 1 / thread 1，历史 capture membership 为 0；30,001 个 source keys 的 revision 为 1，另 2 个为 5。当前 Raw bindings 没有悬空 unit 引用；首轮所有 201 个 Raw unit 的 ACK disposition、原模拟 receipt JSON 和 identity 仍在，payload 均已 reclaim。历史 capture identity 与 unit receipts、每键最新 version proofs 均保留；这不承诺从已删除 membership 重建旧 Canonical 内容。

离线核对使用 Python SQLite `mode=ro&immutable=1`，只在写进程退出且 WAL/SHM 已清除后使用。首次普通 ro 方式返回 unable to open database file，因此改为上述离线模式；没有把 immutable 方式用于活动来源或生产 Journal。

## 资源观察与局限

进程峰值 RSS 493,715,456 bytes（Node maxRSS 482,144 KiB，与 /usr/bin/time -l 一致）；包括 Source、Host、SQLite、测试传输与校验所保留的 Event 映射。不是单独 Module 内存，也不是默认 daemon 并发内存预算。

DB 在首轮 cleanup 后为 75,182,080 bytes，此后五轮取样未增长或缩小；这是页复用，不是文件截断。WAL 各轮取样从 1,804,592 增至 1,854,032 bytes，SHM 32,768 bytes；这些是指定阶段瞬时值，不是磁盘峰值。退出后 DB 仍为 75,182,080 bytes、WAL/SHM 均 0；离线 page_count 18,355、freelist_count 9,537。

本例支持“旧 membership 可安全释放 metadata admission”的有限结论，不支持无限观察、断电恢复、真实远端 ACK 或旧 Canonical Raw 归档内容可重建的结论。第 5 轮 prepare 51.171 秒如实保留；没有隔离其他宿主负载、重复统计或推导跨平台吞吐。

## 复现

归档保留原始 `clean.jsonl`、`clean.time.txt`、`compact-results.json`、`controller-results.json`、`provenance.json`，没有改写原始数据。
脚本以构建参数解析 production checkout，受控 fixture 复用同一研究目录下的 `../capacity/native-fixture.json`，SHA256 为 `4034a150da542be49d8d1f0d62d6a3244d986db9abc1b886f80ab6416d037298`，与本轮实际 fixture 相同。
构建时将 fixture 与 build-provenance 复制到 bundle 相邻目录，脚本输出使用实际构建 commit。`CHECKOUT` 应固定在 `60964394cdf7413a11c5843e669f96c87467d381`，且构建依赖已准备好；所有输出必须使用仓库外的新目录/文件。

```sh
rtk proxy node docs/research/opencode-platform/retention-capacity/build-probe.mjs "$CHECKOUT" "$NEW_BUILD_OUTPUT"
rtk proxy python3 docs/research/opencode-platform/retention-capacity/run.py --bundle "$NEW_BUILD_OUTPUT/prototype.mjs" --output "$NEW_RUN_OUTPUT"
rtk proxy python3 docs/research/opencode-platform/retention-capacity/summarize.py --input "$NEW_RUN_OUTPUT" --output "$NEW_COMPACT_JSON"
```

runner 仅在 macOS 使用 `/usr/bin/time -l`，450 秒硬限会杀死实验进程组，拒绝覆盖旧结果，并检查退出状态与五轮最终断言。它生成独立 source/journal scratch，路径记录在 JSONL 的 `dir`。
summary 只读进程退出后的数据库，拒绝非空 WAL/SHM；如移动过研究数据库，可传 `--database`。immutable=1 不是运行中数据库的并发读方案，不应用到生产。
本地数据库暂时保留给离线复核，完成后可删除该次生成的独立 scratch；数据库、bundle、二进制均不归档。

归档只验证参数化构建入口、脚本语法与结果复核，没有重跑约 210 秒五轮。检查记录见 [archive-validation.json](archive-validation.json)；原始性能数字仍仅来自前述单次实验。
[archive-provenance.json](archive-provenance.json) 列出脚本参数化变更，原 [provenance.json](provenance.json) 中绝对路径只标识最初研究来源，不是归档脚本依赖。
