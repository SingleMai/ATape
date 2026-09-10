# Native SQLite → existing Collector probe

一次性 Interface 实验；运行真实 `runCollectionCycle`、Node checkpoint、SecretRedactor、Canonical/Raw wire 转换和 loopback HTTP。只替换来源 reader 与远端接收方，不复制 Collector 私有编排。

它有意验证现有 Interface 的能力和缺口，**没有实现或证明 ADR-0059 的最终待发送内容与原子发布协议**。原型不进入生产代码。

## 复现

在仓库根目录先执行 `rtk proxy pnpm install --frozen-lockfile`，然后用[原生 fixture 生成器](../opencode-native/OBSERVATIONS.md)创建独立数据。将生成的 manifest 路径传入：

```sh
rtk proxy node packages/application/prototypes/opencode-collector/probe.ts /absolute/path/to/manifest.json
```

可通过 `ATAPE_PROTOTYPE_RESULT=/absolute/path/results.json` 保存机器可读输出。本目录 [results.json](results.json) 是本次实际运行结果。脚本用 SQLite backup 将受控 native DB 复制到新 scratch，故障和数据变更只发生在副本。父进程结束时清理副本、ledger、checkpoint、子进程与 HTTP receiver。

## 实际覆盖

- `AdapterRuntimes` 装配原型 reader；复用真正的 `AdapterCollectionPage` Schema 与 Collector 语义/容量检查。
- `readNativePage` 每页打开只读 SQLite 事务，使用 keyset 读取有限 part，返回完整且有界的 root/child topology；source 从不作为 ledger 使用。
- `makeCollectorStateLayer` 保存真实 JSON checkpoint，按原有 CAS 规则提交；使用新 Node 进程恢复。
- `makeSecretRedactorLayer` 处理中文、emoji、合成 secret；`makeCollectorTransportLayer` 生成真实 wire body、batch ID、Raw Base64/sha256，随后通过 loopback HTTP 发送。
- 第一轮在 receiver 收到首个 Raw 请求时关闭全部 Raw 接受入口并 SIGKILL Collector。此时之前的 Canonical 已实际得到 HTTP 确认；checkpoint 尚无提交，Raw 无确认。每次子进程携带独立实验 epoch，旧进程残留请求不能混入下一轮。
- 在副本中将同一个 part 从 A 改为 B，保留 row timestamp。新进程从旧 cursor 读到 B；稳定 Event ID/occurredAt 不变，revision 增加，wire 和 Raw 变为 B，**无法恢复旧 A 的 Raw**。这是已复现的现有 Interface 缺口，脚本成功代表该反例成立，不代表恢复契约通过。
- 全新 Raw-off capture：四页 Canonical 正常发送，没有 Raw 请求、Raw-only sentinel wire 或伪造 Raw receipt；每页 reader 指标 `wholeDataReads=0`。SQLite 内部仍解析 JSON 并做大小预检，指标不表示零数据库 I/O。
- 直接调用 reader 的补充断言：A→B→A 的 revision 递增；缺 Origin 返回 attribution；超过本次人为设置的记录上限返回 limit。

receiver 在内存里记录收到的请求和生成受控 receipt，没有 production Server 或数据库幂等实现。`AuthenticatedHTTPClient` 被 loopback Adapter 替换，没有使用真实凭据，也未验证认证。真实 PostgreSQL 事务与 HTTP 丢响应由[独立发布实验](../opencode-postgres/README.md)验证，两套证据不能合称一条完整生产链路。

## Reader 的刻意限制

- 仅 v1 `session/message/part` 形状；没有完整 discovery、source format/version negotiation、legacy/v2 路线。
- 来源 Origin 由受控创建证据提供；不是从任意历史的最新 CWD 猜测，也没有覆盖生产 Git attribution。
- Canonical 只做 text/reasoning/tool 的局部投影；没有 Active Path withdrawal、完整 usage/media 和所有 task 关联。
- 每次 collect 是新 SQLite view，不固定跨页 target；没有 final-wire pending、Begin/seal/activate、lease/receipt expiry 或 GC。
- Raw 仅是完整 **part row** 的观察 envelope，不是完整 Session/message 归档或 OpenCode 原生 event journal。每 row 独立对象只是原型方便，不是生产 packing 决策。
- scratch ledger 保存版本 digest/revision/ref metadata；不保存待发送正文。Raw-off 首次版本的 unavailable ref 固定，重新开启不会改该版本；Raw-only 改变不产生虚假 Canonical revision。
- 同毫秒下数值排序只是 derived，不能证明与 native part ID 顺序完全相同；生产实现需要明确稳定 source-order tuple/ordinal。
- 上限是原型约束：100 Threads、每页最多 8 parts、每记录最多 64 KiB；不是产品支持承诺。没有大库内存、WAL、取消时延、磁盘满、journal 损坏或并发 writer 压测。

## 本次观测

Node v24.18.0，内置 SQLite 3.53.1，macOS arm64；原生 fixture 为 OpenCode 1.18.30。重启正常轮与 Raw-off 轮均为四页、六个 Canonical Events。前者八个 Raw chunks、4379 bytes，后者 Raw 为零。运行时间、每页读取计数和进程 RSS 详见结果文件；这是小 fixture 的实例观察，不是资源上界或 release 参数。

`probe.ts` 与 `reader.ts` 已通过独立 TypeScript 检查。已对 SIGKILL/并行 Raw 故障窗口做独立审阅，并修正 stdout drain 与旧请求混入的实验风险。没有启动生产数据库或上传私人历史。
