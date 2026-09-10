# PostgreSQL + HTTP publication probe

一次性、合成数据的 ADR-0025 / ADR-0059 行为实验。它运行真实 PostgreSQL 与 loopback HTTP，**不是生产 Server / Collector Interface 验收**，不访问生产数据库、用户历史或 OpenCode 安装。

依据：[ADR-0059 与详细契约的固定版本](https://github.com/SingleMai/ATape/blob/2989ab656f4720fa7cb0e0e02cb3037df4a63350/docs/architecture/adr/0059-opencode-publication-and-recovery.md)。实现仅用于显式 replacement target。

## 复现

需要可用 Docker、Python 3.9+ 与安装 Python wheels 的网络连接。仓库根目录执行：

```sh
rtk proxy python3 packages/application/prototypes/opencode-postgres/run.py
```

`run.py` 使用固定 PostgreSQL image digest，创建唯一名称的 `--rm` 容器；数据库位于容器 tmpfs，无宿主目录挂载，随机端口仅绑定 `127.0.0.1`。Python 依赖 `psycopg[binary]==3.2.10` 与 `typing_extensions==4.15.0` 安装到临时 venv。结束时清理容器与临时目录，不修改系统 Python 或生产代码。仅在本目录写 `results.json`；可用 `--results /absolute/path.json` 改变输出位置。

`probe.py` 只由 runner 设置的 scratch DSN 启动，并要求数据库名称是 `atape_publication_probe`、public schema 没有表。不要提供现有数据库的 DSN。

## 已覆盖行为

1. 第一份 target 激活前不可见；旧 A/B/C 在 A/D 上传、seal、validation 期间保持可见。缺少 part、未验证 target 返回 HTTP 409。
2. 在同一事务写 head、可见计数、receipt、Search outbox 后，用另一 PostgreSQL 连接调用 `pg_terminate_backend`。事务提交前独立读仍见旧视图；连接终止后上述写入全部回滚，HTTP 返回 503。
3. 完成事务后关闭 HTTP socket，不返回任何响应。客户端观察 `RemoteDisconnected`；同一 activate 重试取得原 receipt，pointer、receipt 与 Search work 已提交且无重复。
4. 激活更晚 A/E 后重放 A/D activate，仅返回旧 receipt，不重写 current head。携带旧 head 的 reader 返回 refresh-required。
5. 两个 HTTP 请求先分别建立 PostgreSQL 连接、记录不同 backend PID，在 barrier 后竞争同一 Session row lock。新 fence 的 attempt 成功，旧 attempt 被拒绝；另外独立断言 stale fence 与 stale base。
6. Search SQL 同时匹配 current-head membership 与 descriptor。B/C 立即退出，D 索引稍后加入；相同 Event 的 v1 索引不能命中 v2，旧 worker 补写索引也不能恢复旧成员或 descriptor。
7. 当前 head 更新之后，旧 capture 的真实 activation receipt 仍可通过独立 Raw fence/lifecycle 校验；未激活 capture 与失效 Raw fence 被拒绝。这里只保存授权 receipt，不模拟 object store 或声称上传正文已持久化。

`results.json` 记录实际 PostgreSQL/Python/psycopg 版本、隔离级别、各场景证据、不同竞争 backend PID、容器清理结果，以及失败时的 traceback。全部断言通过才返回退出码 0。

## 有意未覆盖

- ATape 生产 HTTP Interface、授权、团队/Project隔离、旧 ingest mode 共存，以及真实 Collector/OpenCode 数据映射。
- reservation/Begin 幂等有效期、租约续期、receipt 过期与 unknown reconciliation。此实验的 Begin 是简化控制操作，不是最终协议。
- quotas、bounded/resumable validation、拓扑/引用/usage 的完整校验、元数据分页与大型 target 性能。
- PostgreSQL 容器/主机重启、磁盘丢失或掉电；`pg_terminate_backend` 只验证数据库事务在客户端会话消失时回滚。
- Raw bytes、object store、offset ACK、政策取消/重开与恢复；没有把授权 receipt 当真实 Raw 上传 ACK。
- 完整 Search worker 进度、outbox 区间和重试协议；当前仅验证 durable work 与查询 eligibility。
- patch 优化、GC、历史 head 清理、全部受支持运行时/OS。

这些结果可作为[验证 OpenCode 有界采集在改写与重启后的可重放性](https://github.com/SingleMai/ATape/issues/115)的 PostgreSQL/HTTP 局部证据，不能单独关闭该验收，也不是生产发布或部署依据。
