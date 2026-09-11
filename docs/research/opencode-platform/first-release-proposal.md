# OpenCode 首版支持范围提案

状态：供负责人讨论，尚未接受，不变更产品默认值。2026-09-11。

建议完成已接受的常规启用入口，但首版只承诺经过实际验证的本机
OpenCode 1.18.30 v1 SQLite 历史。先支持 macOS arm64 和 Linux arm64/glibc；
CLI 沿用 Node 24。其它版本和平台逐项补证据，不把表结构相似或 CI 能运行
等同原生 OpenCode 兼容验收。

## 支持与限制

| 项目 | 建议的首版边界 |
| --- | --- |
| 来源 | 本机只读 v1 SQLite；实际检查表、索引和不可变创建 Origin 证据 |
| 已验证版本 | 官方 OpenCode 1.18.30；不执行升级、迁移或 export fallback |
| 已验证原生平台 | macOS arm64 / Node 24.18；Linux arm64、glibc 2.36 / Node 24.20 |
| 正常流程 | 工具选择、检测、安装、启用；存量导入与后台持续同步；目录和 Git Project |
| 历史变化 | 完成后修改、revert/unrevert、压缩、child 与 fork；通过完整目标原子替换当前视图 |
| Canonical / Raw / Search | Canonical 成功不依赖 Raw 完成；Raw 按现有权限与政策独立恢复；Search 跟随当前视图 |
| 工具和附件 | 已支持工具调用/结果；未知 part、内联媒体和未映射附件明确标记部分保真；不抓取外部媒体 |
| 旧 JSON、所选会话家族中的非空 v2/混合历史、无法证明覆盖或 Origin | 明确不支持/来源诊断，保留已有发布视图，不猜测身份或回退到另一 reader |
| 来源删除 | 不删除已采集历史，优先恢复已冻结的待确认工作；新来源扫描按实际失败显示 |
| 暂不承诺 | Windows、macOS Intel、Linux x64/musl、其它 OpenCode 版本、远程 Server 历史 |

这里的“已验证版本”是兼容性承诺，不是运行 OpenCode CLI 探测版本的要求。
实际读取仍由来源 capability probe 决定；同形但未经验证的来源不能据此
获得首版支持承诺。检测入口不能为了展示“已安装”而读取聊天正文。

## 本地保留与容量

负责人已选择先补安全清理再进入常规启用；这项清理已合入。
只回收退出当前覆盖和恢复流程的完整观察成员，每批至多 100 条。
待确认内容、来源版本、capture/unit 身份和回执仍保留。
不按 TTL 丢弃，不重置 journal，不用旧回执推进当前视图。

一万条、每条 1 KiB 文本的五轮 Raw-on 实验中，每轮只改一条事件：
清理前最多 90,320 条元数据，清理后从 60,229 增至 60,317；
每次清理 30,003 行，耗时 1.09–1.32 秒。完整进程峰值 RSS
493,715,456 bytes，包含断言映射；第五轮准备为 51.171 秒。
数据库复用页面而没有缩小。

这些数字是单次合成负载观察，不是“任意一万条会话都能处理”的承诺，
也不是物理磁盘限额或发布默认值。该大例使用模拟 ACK；真实 HTTP
与安装后台的正确性由另一组受控 native fixture 验收。

默认资源配置应在常规启用增量中给出可复核的候选并通过实际 Collector
验收。工程候选以已经运行的 1 MiB 行、4 MiB 页、128 MiB 单目标、
256 MiB 账户待确认 payload 为起点；元数据仍单独计数，达到额度时
停止新增、保留旧视图并继续允许既有恢复。以上不自动成为已接受配置，
不保证 SQLite 文件和进程内存等于 payload 预算。

## 验收证据与接下来要做的事

- [macOS 官方原生生成](https://github.com/SingleMai/ATape/blob/6d1c082db48793dff8a48050552b2a7fc586be14/packages/application/prototypes/opencode-native/OBSERVATIONS.md)与[生产 Source 原库读取说明](https://github.com/SingleMai/ATape/blob/5ad5193b9541c97c490b6c6d4b7837c112dee085/adapters/opencode/src/fixtures/README.md)：macOS 26.3.2 arm64、Node 24.18、官方 1.18.30，API/export/SQLite 比对。
- [Linux 官方原生平台与只读边界](https://github.com/SingleMai/ATape/blob/855b9661858e67aa541d8b2e7b642d795cc99d7f/docs/research/opencode-platform/OBSERVATIONS.md)：固定 binary/hash、实际安装的候选 Adapter、官方 API/export/SQLite 比对；DB/WAL 不变与 SHM 读锁元数据分开记录。
- [五轮一万条事件与清理](https://github.com/SingleMai/ATape/blob/262508f3bd1605245f918b51f918989a24e43704/docs/research/opencode-platform/retention-capacity/OBSERVATIONS.md)：原始数据、耗时与明确模拟 ACK。
- [安装后的后台完整验收](https://github.com/SingleMai/ATape/pull/143)：实际安装的 CLI/Adapter、真实 HTTP/PostgreSQL，持续同步、重启、Raw 引用、Search 与源删除。
- [安全元数据清理](https://github.com/SingleMai/ATape/pull/144)：真实 SQLite、SIGKILL 分批恢复、旧 proof 与 Raw 引用保留，25 次 native 改写不耗尽原配额。
- [Git Project 接入](https://github.com/SingleMai/ATape/pull/145)：实际安装包和 Host、真实 worktree/clone/外部仓库、持久归属与当前授权；专门的远程 Project matching 是 TestAdapter。
- [空轮询后的已采集状态](https://github.com/SingleMai/ATape/pull/146)：本地 360 项测试和完整 HTTP 回归（31.589s）通过；四项 PR 检查通过，已合入 `623a79c588721e33a196d565fe4f8f2be1d3728f`。发现/准备/丢失确认不误报，缺失标记可从真实 journal activation 恢复。

待负责人确认的是这份有限支持范围是否足以进入首版，而不是重新批准
只读 SQLite、原子发布、待确认内容或安全清理。接受后继续补普通检测/
工具选择/升级监测/发行包契约、资源配置和对应端到端验收，仍逐增量合入。
本提案不关闭尚待人工接受的原型/首版决策，不授权 npm 发布、Server
部署或读取私人历史。

上述原生读取证据绑定各自候选。原候选到 Git 接入主线的 Adapter source
未变，但这些证据仍不能替代最终发行候选的安装和兼容验收。
