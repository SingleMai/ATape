# OpenCode 原生来源与恢复实验记录

日期：2026-09-10。回答[验证 OpenCode 有界采集在改写与重启后的可重放性](https://github.com/SingleMai/ATape/issues/115)中的来源、公开 Interface 与 PostgreSQL 局部问题。只读 SQLite、有界待确认内容和首版原子发布已获接受；本报告不重新选型。

结论：原生 SQLite 路线有实际内容对照依据，现有 Collector 可以消费基础投影；真实故障验证同时确认，**现有 Collector 仍不能满足来源改写后的固定重放**。PostgreSQL 原子切换原型可行，但尚未接入生产 Interface。不能将这些局部通过合并成“OpenCode Adapter 已完成”。

## 三层证据

| 实验 | 真正运行了什么 | 结果与解释 |
| --- | --- | --- |
| [原生来源](../../packages/application/prototypes/opencode-native/OBSERVATIONS.md) | 官方 OpenCode v1.18.30 Darwin arm64；独立 HOME/XDG/config；官方 API 与 CLI export；只读 SQLite | 三个会话的全部 hydrated message/part 在 SQLite/API/export 中逐值相同；不是手造表 |
| [现有 Collector](../../packages/application/prototypes/opencode-collector/README.md) | Node 24、实际 Collector/Schema/checkpoint/redactor/wire；受控 native DB 副本与 loopback receiver；真实 SIGKILL | 四页基础投影和 Raw-off 通过；A 已 Canonical ACK、Raw 未 ACK 后 source A→B，重启改发 B，确认旧 A 无法补回 |
| [发布原型](../../packages/application/prototypes/opencode-postgres/README.md) | PostgreSQL 17.11、READ COMMITTED、真实 HTTP、不同 backend 连接竞争、终止数据库连接及丢弃响应 | 七组场景通过：候选隔离、原子提交/回滚、确认重试不倒退、Search eligibility、旧 capture 的独立 Raw 授权 |

这三条链路使用不同接收方：Collector 接收方生成受控 receipt；PostgreSQL 使用独立原型协议；没有真实 ATape Server 的 publication 接口。源码基线为 `cac0467f72eb086de9d049cd3d242af19493e8ac`，实验都在独立原型目录，生产文件未修改。

## 来源事实对实现的影响

- root 和 child 有不同原生 Session ID，由 parent 元数据建立 family；fork 有独立 IDs、复制前缀，但没有 parentID，不能当成 child。
- 官方 root export 不递归导出 child。SQLite reader 需要显式收集可证明的 family，不能拿单次 root export 当完整子会话覆盖。
- 已完成的 shell assistant 有 `time.completed` 和 completed tool，却没有 `finish`。完成判定不能只检查 finish。
- compaction 在原 Thread 中增加 compaction user part 和 summary assistant；原文工具仍在源库。本次运行的是官方编排，摘要由 loopback stub 提供。
- 另一个独立原生 fixture 实测了 **revert 后继续**：标记时旧 5 messages / 7 parts 全在；从第一条消息撤回后发送新 `noReply` prompt，旧 root 投影被 cleanup 移除，只剩新 ID 的 1 message / 1 part，child/fork 不变，原生 event 增加五条 message.removed。详见[原生结果](../../packages/application/prototypes/opencode-native/revert-continuation-results.json)。旧 export 对照文件仍保留，这不等于 ATape 已完成 Raw 归档。
- 顶级未知 part 字段被原生 schema 丢弃；开放 `metadata` 的未知嵌套内容被保留。Raw 保真样本应针对实际存储字段，不能把从未存入的字段算作丢失。
- `/var` 与 `/private/var` 路径别名会规范化；非 Git 项目 assistant.path.root 可以是 `/`，不能用它代替 Origin CWD。

固定源码、release asset/binary hash、API 操作与证据边界均在原生来源报告。未读取用户历史、凭据或调用付费模型。

## 小样本路线成本

同一份 274432-byte DB 的 root/child/fork，共 9 messages、11 parts，统一编码后的 hydrated messages 均为 6021 UTF-8 bytes，三轮逐值相同。

| 路线 | 三轮总 wall | 独立子进程峰值 RSS |
| --- | --- | --- |
| SQLite 完整 hydrate 三会话 | 41.7–124.7 ms | 15.6–22.4 MB |
| 官方 export 三会话（三次 CLI 启动） | 1.30–1.75 s | 331.4–339.1 MB（顺序进程取最大值） |

数字见[机器可读 benchmark](../../packages/application/prototypes/opencode-native/benchmark-results.json)。直接读取使用 Python，export 包含原生 CLI bootstrap 与额外 Session info 输出；两者不同 runtime、不同启动次数，没有冷缓存或大库测试。此结果支持减少轮询中的 CLI 启动成本这一判断，不能外推生产 Node Collector 的内存上界或收益比例。逻辑 JSON 字节数也不是物理磁盘读取量。

## 尚未通过的交付门槛

| 边界 | 当前证据 | 仍需要的工作 |
| --- | --- | --- |
| 来源矩阵 | 一个当前 release 的 v1 fixture；v2-only 有合成拒绝验证 | legacy、v2-only、混合/迁移历史、schema 探测、真实来源缺证据诊断 |
| 完整投影 | 原生 tool、child、fork、compaction 内容已取得；基础 Collector 投影可用 | Active Path、usage/media、task 关系、同毫秒严格排序、Session/message/part 完整 Raw |
| 改写后重放 | 已通过生产 Collector 复现缺口；早期 SQLite 小模型演示选定恢复方向 | Collector final-wire journal、完整 target manifest、本机事务/容量/回收与升级路径 |
| 发布切换 | 真实 PG/HTTP 原型七场景通过 | 生产 Server Interface、授权与旧写模式共存、真实 reader/Search 集成 |
| 长时间恢复 | 事务中断与丢响应已测 | reservation/lease/receipt 过期、unknown reconciliation、并发 ownership、实际 Raw store、policy 中途取消/重开 |
| 上界与平台 | 小 fixture、macOS arm64、Node 24；容器 PG 17 | 大 Session/part、WAL/磁盘满/损坏/GC、取消与压力、Linux/Windows 支持及具体 release 配额 |

这份报告提供实现与下一轮验收的输入，不自行关闭原型验收票，也不代替[确定 OpenCode 首个可用增量与验收证据](https://github.com/SingleMai/ATape/issues/114)。既定范围继续有效；未验证项需要工程实现/实验来解决，不能通过重复批准暂存或原子发布来消除。
