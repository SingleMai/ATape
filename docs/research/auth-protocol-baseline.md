# ATape 认证协议与安全基线

核验日期：2026-09-05

## 目的与结论

本文为 ATape 登录体系后续设计提供事实基线，不直接定义最终 HTTP 路径、数据表或代码 Interface。它将内容明确区分为三类：

- **标准要求**：来自 OAuth、OIDC、Cookie、Fetch 等规范的互操作或安全要求。
- **GitHub 当前能力**：GitHub OAuth App 公开文档所承诺的行为。
- **ATape 已定选择 / 工程推论**：产品契约已经选定的行为，或为安全实现这些行为必须补上的约束。

结论是：一期采用 GitHub OAuth App 完成 Web 登录，同时由 ATape 自己实现面向 CLI 的 Device Authorization，没有致命的协议冲突。CLI 不需要也不应直接执行 GitHub Device Flow；GitHub 凭据只在服务端短暂存在，CLI 最终取得的是 ATape 自己签发的用户凭据。

需要在设计票中显式消化三项偏差或风险：

1. `/.well-known/atape` 目前不是 IANA 注册的 well-known URI suffix，不能在未注册的情况下宣称为标准化公共发现协议。
2. `Domain=atape.dev` 的共享 Session Cookie 存在同站子域覆盖 Cookie 的固有完整性风险，只能建立在所有 `*.atape.dev` 子域都被同等信任的前提上。
3. 已选定的 Web Session 180 天绝对期限长于 NIST SP 800-63B-4 对 AAL1 总体重认证期限“不应超过 30 天”的建议；这不是 OAuth 互操作错误，但必须作为有意识接受的安全偏差记录。

## 一期信任边界

一期包含三条不同但衔接的协议链，不能把它们揉成一个“OAuth 登录”：

1. **浏览器与 GitHub**：ATape 后端作为 GitHub OAuth App 的 confidential client，执行 Authorization Code Flow。
2. **浏览器与 ATape**：GitHub 身份验证完成后，ATape 建立自己的服务端 Web Session；GitHub access token 不是 ATape Session。
3. **CLI 与 ATape**：CLI 发起并轮询 ATape-owned Device Authorization；浏览器中的已登录用户明确批准后，ATape 向持有高熵 `device_code` 的 CLI 一次性交付 ATape CLI credential。

因此，Provider Adapter 的产物只能是经过验证的外部身份，不能把第三方 token、Team 成员关系、Web Session 或 CLI credential 泄漏到 Adapter Interface 中。外部身份推荐规范化为：

```text
VerifiedExternalIdentity {
  issuer: ProviderIssuer
  subject: string
  display?: ProviderDisplayMetadata
}
```

对 GitHub OAuth Adapter，`issuer` 是 ATape 定义并固定的 GitHub Provider 标识，`subject` 是 GitHub 返回的十进制用户 `id` 字符串。这里的 `issuer` / `subject` 是 ATape 领域中的规范化键，不表示 GitHub OAuth 响应是 OIDC ID Token。

## GitHub Web OAuth 基线

### 标准要求

[OAuth 2.0 Security Best Current Practice（RFC 9700）](https://www.rfc-editor.org/rfc/rfc9700.html)要求授权服务器对预注册 redirect URI 做精确字符串匹配，禁止开放重定向；推荐 confidential client 也使用 PKCE，并要求防御 CSRF 和多授权服务器场景的 mix-up attack。Access token 不应出现在 URI query 中。

[OAuth 2.0（RFC 6749）](https://www.rfc-editor.org/rfc/rfc6749.html)规定 token endpoint 的成功响应必须带 `Cache-Control: no-store`，并要求兼容 HTTP/1.1 的响应带 `Pragma: no-cache`。ATape 对承载任何登录完成凭据的自有响应也采用同等缓存约束。

ATape 的 GitHub Web Flow 必须同时使用：

- 每次请求唯一、不可预测且绑定当前浏览器登录事务的 `state`；回调不匹配、缺失、过期或已消费时立即失败。
- PKCE `S256`，`code_verifier` 仅保存在服务端登录事务中。
- 精确、预注册、Provider 专用的 callback URI；即使 GitHub 平台允许更宽松的配置，ATape 也不使用 wildcard callback。
- 登录事务与期望 Provider、callback URI、PKCE verifier 绑定，且一次消费。

多入口 Provider 会引入 mix-up 风险。GitHub 的文档化 callback 没有返回可验证的 issuer，因此一期应使用 Provider 专用 callback URI，或具有等价强度的服务端事务绑定；不能只相信 callback 参数或前端提交的 Provider 名称。

### GitHub 当前能力

[GitHub：Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)记录了 Authorization Code Flow：浏览器进入 `/login/oauth/authorize`，GitHub 将短期 `code` 返回 callback，服务端再向 access-token endpoint 交换 token。文档说明：

- `state` 被强烈建议用于防御 CSRF；
- 支持 PKCE，且 `code_challenge_method` 只支持 `S256`；
- authorization code 在 10 分钟后过期；
- token 响应返回 access token、token type 和 scope，而不是文档化的 OIDC ID Token；
- 获得 access token 后应调用 `GET /user` 取得并重新确认当前资源所有者身份。

[GitHub：Best practices for creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app)要求持久化用户的数值 `id`，因为它不会随用户名变化，也不会被重新分配；用户名、显示名和 email 都不能作为稳定账号键。该文档同时要求只申请完成任务所需的最小 scope。

ATape 只需要识别用户，不需要读取私有邮箱或仓库。一期应首先以无额外 scope / 最小 scope 完成 `GET /user`；只有出现经过产品决策的新能力时才增加 scope。GitHub access token 只用于本次回调内读取身份，随后立即丢弃，不写数据库、不写日志、不下发浏览器或 CLI。

### GitHub OAuth 不是 OIDC

[OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)定义：OIDC 请求包含 `openid` scope，并通过 ID Token 断言认证结果；RP 必须验证 `iss`、`sub`、`aud`、签名、有效期，并在使用 `nonce` 时验证其匹配。

GitHub OAuth App 文档化的 code exchange 响应没有 `id_token`，所以 ATape 不能把 GitHub OAuth 登录实现成“解析 GitHub ID Token”，也不能声称 GitHub 数值 `id` 就是某个 OIDC issuer 下的 `sub`。这是根据 GitHub 文档化响应做出的协议推论。

未来若增加真正的 OIDC Provider，OIDC Adapter 才负责：发现并固定 issuer、校验签名和算法策略、精确匹配 `iss`、校验 `sub` / `aud` / `exp`，以及在请求使用 `nonce` 时校验 `nonce`。这些逻辑属于 OIDC Adapter Implementation，不进入 GitHub OAuth Adapter，也不进入账号领域。

## CLI Device Authorization 基线

### 两种 Device Flow 必须分离

[GitHub OAuth 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)也提供 GitHub Device Flow：OAuth App 需在设置中启用，客户端从 GitHub 获取 `device_code` / `user_code`，并直接轮询 GitHub token endpoint。GitHub 当前示例包括 40 字符 `device_code`、带连字符的 8 字符 `user_code`、900 秒有效期，以及 polling interval 和 `slow_down` 语义。

**ATape 已定选择**不是直接采用该流程。ATape CLI 只与 ATape 实例通信：

```text
CLI --begin--> ATape --device_code/user_code/URL--> CLI
CLI --poll-->  ATape
                     Browser --GitHub Web OAuth--> GitHub
                     Browser --explicit approve--> ATape
CLI <--ATape CLI credential-- ATape
```

GitHub 只验证浏览器中的用户。GitHub access token 不会到达 CLI；最终 CLI credential 由 ATape 签发，并绑定 ATape 本地 User。GitHub Device Flow 的具体 code 长度、900 秒 TTL 和轮询地址不构成 ATape 自有协议的强制参数。

### RFC 8628 约束

[OAuth 2.0 Device Authorization Grant（RFC 8628）](https://www.rfc-editor.org/rfc/rfc8628.html)提供 ATape 自有 Device Authorization 应遵循的模型：

- 所有请求使用 TLS；设备授权只能在用户明确发起时开始，不能后台自动弹出。
- begin 响应包含 `device_code`、`user_code`、`verification_uri`、`expires_in`；可包含 `verification_uri_complete` 和 `interval`。
- `interval` 缺失时客户端默认至少等待 5 秒；收到 `slow_down` 后，后续所有轮询间隔都至少再增加 5 秒。
- `authorization_pending` 继续轮询；`slow_down` 降速；`access_denied`、`expired_token` 以及其他终止错误停止轮询。
- 网络超时应使用退避，而不是把瞬时失败变成紧密轮询。
- `device_code` 必须高熵且不可预测；`user_code` 可以更短、更便于人工输入，但必须结合短有效期和服务端尝试次数限制。
- 即使使用带预填 code 的 `verification_uri_complete`，CLI 仍展示 `user_code`，Web 批准页仍展示并要求用户核对 code。
- 批准页必须清楚说明正在授权一个 CLI / 设备、展示足以识别本次请求的上下文，并提供明确批准和拒绝动作，降低 remote phishing 风险。

ATape 在此基础上增加以下工程不变量：

- `device_code`、`user_code`、登录事务和批准动作均有服务端过期时间；服务端时钟是权威。
- 一个 Device Authorization 只能从 pending 转到 approved、denied 或 expired 中的一个终态。
- CLI credential 只能由 `device_code` 持有者通过轮询响应领取一次；浏览器批准响应、redirect URI 和 URL query 都不得携带该凭据。
- 轮询间隔由服务端强制执行，违规时返回稳定的 `slow_down` 语义；不能只依赖网关限流。
- 存储层只保存可用于比对的 code / credential 摘要，不保存可直接使用的明文 secret；领取后原子地标记为已消费。
- 批准瞬间绑定批准者当前的 ATape User，不缓存 Team 权限；后续 API 调用实时执行授权判断。
- 所有 Device Authorization 响应和最终 credential 响应使用 `Cache-Control: no-store`；最终凭据不进入日志、埋点或错误对象。

产品已选定的 **Team 六位、不区分大小写、默认大写展示的加入码** 是可复用、可轮换、可停用的 Team 邀请能力，不是 RFC 8628 的一次性 `user_code`。二者必须使用不同领域类型、存储命名、路由和限流预算，不能共享实现或安全参数。

## 浏览器 Session、Cookie、CORS 与 CSRF

### Cookie 属性与子域风险

[HTTP State Management Mechanism（RFC 6265bis 草案）](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html)定义了 Cookie 的关键语义：

- `Secure` 限制 Cookie 只经安全传输发送；`HttpOnly` 防止非 HTTP API 读取 Cookie。
- `SameSite=Lax` 允许 same-site 请求以及部分跨站顶层安全导航，但它不把 sibling subdomain 视为 cross-site。
- `Domain=atape.dev` 会把 Cookie 的作用域扩展到父域及其匹配子域。
- `__Host-` 前缀要求 `Secure`、`Path=/` 且禁止 `Domain`，因此只能用于 host-only Cookie；它与跨子域共享 Cookie 的选择不兼容。

ATape 已接受官方 Web 与 API sibling subdomain 共享 `Domain=atape.dev; Secure; HttpOnly; SameSite=Lax` Session Cookie。该方案能工作，但 Cookie 模型无法在 sibling subdomain 之间提供完整性隔离：任一被接管或不可信的 sibling 都可能设置同名父域 Cookie。实施时必须：

- 把“所有能位于 `*.atape.dev` 的服务都同等可信”作为部署不变量；第三方托管内容不得进入该命名空间。
- 固定 Cookie 名称、`Path=/` 和冲突处理策略；认证服务不得接受攻击者通过重复同名 Cookie 制造的歧义。
- Session ID 使用高熵随机值，服务端只保存其摘要；登录成功和权限边界变化时轮换 Session ID，避免 session fixation。
- 登出、撤销和过期都在服务端立即失效 Session，并同时返回清除 Cookie 的响应；客户端删除不是安全边界。

如果未来不能继续信任所有 sibling，必须迁移到 host-only Cookie（可使用 `__Host-`）及相应的 API/BFF 拓扑，而不是继续扩大 `Domain` allowlist。

### CORS 与凭据请求

[Fetch Standard](https://fetch.spec.whatwg.org/)明确区分 same-site 与 same-origin。`https://atape.dev` 和 `https://api.atape.dev` 是不同 origin，因此浏览器访问 API 时必须按 credentialed CORS 处理：

- 前端显式使用 credentials mode `include`。
- API 返回精确的 `Access-Control-Allow-Origin: https://atape.dev`，不能用 `*`。
- API 返回 `Access-Control-Allow-Credentials: true`。
- 对动态生成的允许 origin 响应返回 `Vary: Origin`，防止共享缓存串用。
- 预检请求本身不携带凭据，但预检响应必须允许实际请求所用 method 和 headers；`Authorization` 不能依赖 wildcard request-header 规则。
- 只允许规范化后的精确 origin 集合，不能用宽泛的 `*.atape.dev` 正则替代部署清单。

CORS 只决定浏览器是否允许前端读取响应，不是认证机制，也不能单独防御 CSRF。

### CSRF 与 Session 生命周期

[OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)把 SameSite 视为纵深防御，而不是 CSRF 的唯一控制。ATape 对所有使用 Cookie 认证的 unsafe method 必须：

- 精确校验 `Origin`；必要时只把精确 `Referer` origin 作为受控回退，缺失或不匹配默认拒绝并审计。
- 要求攻击者无法通过普通跨站表单构造的 CSRF token 或自定义请求头，并把它绑定到当前 Session。
- 不因为请求来自 same-site sibling 就跳过 CSRF 校验。

GitHub OAuth callback 是跨站顶层导航，它使用一次性且绑定登录事务的 `state` 防护，不套用普通业务 API 的自定义 CSRF header。批准 CLI Device Authorization 的 Web POST 则属于普通 Cookie-authenticated unsafe request，必须通过 Origin 与 CSRF 双重校验。

[OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)要求服务器控制 idle / absolute timeout、撤销和 Session ID 轮换。ATape 已选择 idle 30 天、absolute 180 天、多 Session 并存且可单独撤销；数据库中的状态和时间戳是唯一权威，Cookie 的 `Expires` / `Max-Age` 不能替代服务端判断。

[NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)对 AAL1 给出的总体重认证期限建议是不超过 30 天。ATape 的 180 天 absolute timeout 明显更长。ATape 当前未声明满足 NIST AAL1，因此这不是协议阻塞项；但“威胁验收与实施交接”必须在上线前选择缩短期限，或记录为什么接受该偏差以及哪些补偿控制存在，例如服务端撤销、敏感操作重新认证、账号异常检测和密钥轮换。

## 实例发现与自托管

### Well-known URI 的标准边界

[Well-Known URIs（RFC 8615）](https://www.rfc-editor.org/rfc/rfc8615.html)规定，定义新的 `/.well-known/<suffix>` 的应用必须注册其 suffix。[IANA Well-Known URIs Registry](https://www.iana.org/assignments/well-known-uris/well-known-uris.xhtml)截至本文核验时没有 `atape` 条目。

因此，已讨论的 `/.well-known/atape` 可以作为原型期的私有约定，但在完成注册和发布稳定规范之前，不能作为标准化公共发现契约。实例发现设计必须在下列方向中明确选择：

1. 发布稳定的 ATape discovery profile 并申请注册 `atape` suffix；或
2. 将自定义文档移到普通应用路径，不使用 `/.well-known/`；同时尽可能复用已有标准元数据。

[OAuth 2.0 Authorization Server Metadata（RFC 8414）](https://www.rfc-editor.org/rfc/rfc8414.html)规定元数据中的 `issuer` 必须与构造元数据请求时使用的 issuer 标识精确一致。若 ATape 将自己的 Device Authorization / CLI credential profile 表达为 OAuth Authorization Server，必须遵守这一自洽约束，且不得用请求的 `Host` 或 `Forwarded` 头动态推断 issuer。

[OAuth 2.0 Protected Resource Metadata（RFC 9728）](https://www.rfc-editor.org/rfc/rfc9728.html)定义了 `/.well-known/oauth-protected-resource`，用于 API 资源公布其资源标识和授权服务器信息。若 ATape API 作为 OAuth protected resource 对外暴露，可复用它表达资源与授权服务器关系；ATape 专属的 Web URL、API URL 或产品能力字段仍需要一个明确版本化的 ATape profile，不能随意塞入标准字段。

### ATape 的安全发现规则

以下是从上述标准和 bearer credential 风险推导出的 ATape 实施约束：

- CLI 的初始实例输入必须规范化为 origin；生产默认只允许 HTTPS。HTTP 只能作为显式的 loopback 开发模式，不能静默降级。
- origin 不允许 userinfo、query 或 fragment；默认端口和尾部斜杠应采用唯一规范形式。
- 元数据必须声明自身稳定的 instance / issuer 标识，并与请求目标精确匹配；Web origin、API resource origin 和 identity issuer 是不同概念，不得混用。
- endpoint 必须是绝对 URL，并通过预先定义的同实例 / 允许跨 origin 规则验证；遇到重定向时重新验证目标。
- CLI credential 按精确 API origin 分区存储到 `~/.atape`，绝不把一个实例的 credential 转发给另一个未验证 origin。
- 生产公共 URL 只能来自显式配置，不能从可伪造的 `Host`、`X-Forwarded-Host` 或请求路径反推 callback、issuer、Cookie Domain 或 credential audience。
- 官方服务的 canonical Web origin 是 `https://atape.dev`，canonical API origin 是 `https://api.atape.dev`；自托管实例完全拥有自己的 Provider registration、密钥和 public URL 配置，不依赖 ATape 官方基础设施。

## 协议状态与失败语义

后续 HTTP Interface 至少要使下列状态可区分、可幂等处理，并使用稳定的机器可读错误码：

| 模块 | 成功 / 等待状态 | 终止状态 | 必须拒绝的情况 |
| --- | --- | --- | --- |
| Provider 登录事务 | started, callback-completed | expired, consumed, failed | state / PKCE / provider / callback 不匹配，重复 callback |
| Web Session | active | idle-expired, absolute-expired, revoked | 服务端无记录、摘要不匹配、已轮换的旧 ID |
| Device Authorization | pending, approved-but-unclaimed, claimed | denied, expired | 过快轮询、错误 code、重复批准、重复领取 |
| CLI credential | active | revoked | 错误实例、摘要不匹配、已撤销 |

认证失败返回 `401`；身份已确认但无权访问已知资源返回 `403`；为了防止资源枚举而采用的隐藏语义返回 `404`。具体选择必须由授权策略统一定义，Presentation 层只翻译领域失败，不能自己猜测或复刻规则。

## 面向后续决策票的实施清单

### [选择 Federated Identity Provider Seam 的 Interface 形状](https://github.com/SingleMai/ATape/issues/19)

- Provider Adapter 只暴露 begin / complete 登录能力，产出 `VerifiedExternalIdentity`。
- GitHub Adapter 固定 Provider 标识，使用 Authorization Code + state + PKCE S256，回调后调用 `GET /user`，只使用数值 `id`。
- GitHub token 不越过 Adapter Implementation；最小 scope 是默认策略。
- 为未来 OIDC Adapter 单独定义验证 Implementation，不能让 GitHub 的特例污染通用 Interface。
- Provider 专用 callback 或强事务绑定必须纳入 mix-up 防御。

### [设计 CLI Device Authorization 与本地凭据协议](https://github.com/SingleMai/ATape/issues/20)

- 以 RFC 8628 状态机为模型，但 endpoint、TTL、code 格式和最终凭据均属于 ATape。
- 定义 `interval` / `slow_down` / expiry / deny / one-time claim 的精确语义和并发事务边界。
- 浏览器批准页显示用户码及请求上下文；CLI 只轮询 ATape。
- 最终 credential 仅经轮询响应返回，使用 no-store，并按实例 origin 存储。
- Device `user_code` 与 Team 六位加入码使用完全不同的领域类型和安全预算。

### [设计 Web Session 与跨子域浏览器安全协议](https://github.com/SingleMai/ATape/issues/21)

- 固定 Cookie 名称、Domain、Path、Secure、HttpOnly、SameSite 和清除规则。
- 将所有官方 sibling 同等可信写成部署不变量，并设计重复同名 Cookie 的拒绝策略。
- CORS 使用 exact origin + credentials + `Vary: Origin`；unsafe method 同时校验 Origin 与 CSRF token / header。
- Session 在服务端执行 idle / absolute expiry、轮换与单独撤销。
- 明确处理 180 天期限相对 NIST 建议的偏差。

### [确定实例发现、自托管配置与 atape.dev 部署契约](https://github.com/SingleMai/ATape/issues/25)

- 不把未注册的 `/.well-known/atape` 宣称为标准；决定注册 suffix 或迁移到普通应用路径。
- 评估 RFC 8414 与 RFC 9728 能覆盖的标准字段，并对 ATape 扩展做独立版本化。
- 定义 origin 规范化、HTTPS / loopback 规则、元数据自洽、endpoint 重定向和跨 origin 验证。
- public URL 来自显式配置，不从 Host headers 推断。

### [确定认证切换、威胁验收与实施交接边界](https://github.com/SingleMai/ATape/issues/26)

- 把 Domain Cookie sibling 风险、180 天 Session 偏差、bearer CLI credential 和 remote phishing 纳入 threat acceptance。
- 验收 exact callback、无 wildcard、Provider mix-up 防御、token 不落库 / 不落日志和实例隔离。
- 明确哪些通用流量攻击交给 Gateway / WAF，哪些协议不变量仍必须由应用强制。

### [设计认证持久化、事务、摘要与密钥生命周期](https://github.com/SingleMai/ATape/issues/27)

- 为 OAuth transaction、Web Session、Device Authorization、CLI credential 分别建模，不复用 secret 类型。
- secret 只存摘要；消费、批准、轮换、撤销和过期迁移必须具备原子性。
- Provider token 不持久化；应用密钥、摘要 pepper 和 Cookie / credential 生命周期可独立轮换。
- 审计记录事件和主体，不记录 code、token、Cookie 或可重放数据。

### [定义认证 HTTP Interface、错误协议与版本边界](https://github.com/SingleMai/ATape/issues/30)

- 为 OAuth callback、Session、Device begin / poll / approve / deny、credential revoke 定义版本化请求响应。
- 所有 secret-bearing 响应使用 no-store；token 不进入 query。
- 为 pending、slow-down、denied、expired、consumed、unauthenticated 和 forbidden 定义稳定错误码。
- Presentation 只处理 HTTP、Cookie、redirect 和错误翻译；业务状态机、持久化、重试与授权留在深层 Module 中。

## 一手来源

- [GitHub — Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitHub — Best practices for creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app)
- [RFC 6749 — The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.html)
- [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628.html)
- [RFC 9700 — Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700.html)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [HTTP State Management Mechanism — RFC 6265bis draft](https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html)
- [Fetch Standard](https://fetch.spec.whatwg.org/)
- [OWASP — Cross-Site Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP — Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)
- [RFC 8615 — Well-Known Uniform Resource Identifiers](https://www.rfc-editor.org/rfc/rfc8615.html)
- [IANA — Well-Known URIs Registry](https://www.iana.org/assignments/well-known-uris/well-known-uris.xhtml)
- [RFC 8414 — OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414.html)
- [RFC 9728 — OAuth 2.0 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728.html)
