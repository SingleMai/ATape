# ATape Domain Context

ATape captures coding-agent history into shared Team memory. This glossary fixes the domain language used across product decisions, Module Interfaces, and implementations.

## Identity

**User**:
A stable local human identity within one ATape instance, with an active or disabled state. Disabling a User ends local authentication but preserves historical attribution and Team Memberships.
_Avoid_: Account, Principal

**Identity Provider**:
An external authority, such as GitHub, that can verify a human identity identified by an issuer and subject.
_Avoid_: Provider

**Provider Registration**:
One ATape instance's configured login entry for an Identity Provider. A Federated Login Transaction uses a Provider Registration, but the registration is not part of an External Identity's durable identity.
_Avoid_: Provider configuration, Identity Provider

**Federated Identity Adapter**:
The provider-specific Adapter that translates an external login protocol into a Verified External Identity.
_Avoid_: Provider Adapter, Adapter

**Verified External Identity**:
The transient, verified issuer-and-subject result of completing a federated login. It is evidence used to find or establish an External Identity, not a stored account or credential.
_Avoid_: Claims, Provider User, External Identity

**External Identity**:
A durable, permanently reserved binding of one verified issuer-and-subject pair to one User. An unlinked External Identity can be reactivated only for its original User or through manual operations.
_Avoid_: Social Account, Provider Account, Verified External Identity

**Principal**:
The request-scoped result of authenticating an active User, including the authenticating Web Session or CLI Credential and authentication time. It contains no Team Membership, Role, or permission snapshot.
_Avoid_: User, Account, Member, anonymous Principal

## Authentication

**Federated Login Transaction**:
One temporary browser interaction that starts with a Provider Registration. It is pending until it completes once, fails, or expires.
_Avoid_: OAuth Session, Login Session

**Public Protocol Operation**:
An explicitly unauthenticated operation whose authority, if any, comes from protocol-specific proof such as transaction state or a Device Code. It never creates an anonymous Principal.
_Avoid_: anonymous session, anonymous Principal, optional Principal

**Web Session**:
A browser authentication relationship between ATape and a User, which is active until revoked or expired by an idle or absolute limit. It is unrelated to a captured coding-agent Session.
_Avoid_: Session, Web Token

**CLI Device Authorization**:
A temporary authorization relationship between one CLI login attempt and a User's explicit Web decision. It is pending until approved, denied, or expired, and an approval can be claimed exactly once.
_Avoid_: Device Grant, GitHub Device Flow, Login Session

**CLI Credential**:
An ATape credential held by a CLI and bound to one User without embedding Team Membership or Role. It is active until revoked.
_Avoid_: CLI Token, Access Token, Device Token

**Web Session Secret**:
The secret presented by a browser to authenticate an existing Web Session. It is not the Web Session's identity.
_Avoid_: Session ID, Web Token, Cookie ID

**CLI Credential Secret**:
The secret presented by a CLI to authenticate an existing CLI Credential. It is not the CLI Credential's identity.
_Avoid_: CLI Token, Access Token, Credential ID

**Device Code**:
The high-entropy secret through which one CLI claims an approved CLI Device Authorization.
_Avoid_: User Code, Team Join Code, Device ID

**User Code**:
The short-lived, human-verifiable code through which a User identifies and confirms one CLI Device Authorization.
_Avoid_: Device Code, Team Join Code, CLI Credential

**Authentication**:
The domain that manages User identity and authentication lifecycles and establishes a Principal.
_Avoid_: Authorization, IAM

## Teams and authorization

**Team**:
The tenant that owns Team Memberships, Projects, and their captured history.
_Avoid_: Organization, Workspace

**Team Membership**:
The unique long-lived relationship between one User and one Team, with an active or removed state and an Owner or Member Role. Rejoining reactivates the relationship as a Member; disabling the User does not remove it.
_Avoid_: Team Member, User Role, membership row

**Membership Role**:
The Owner or Member value held by an active Team Membership. It is never a global property of a User or a property of a credential.
_Avoid_: Role, User Role, Global Role

**Team Join Code**:
A Team-owned capability that allows an authenticated User to establish or reactivate a Team Membership as a Member. Reusing it never downgrades an active Membership.
_Avoid_: Invite Token, Device User Code, Authentication Token

**Authorization**:
The domain that decides whether a Principal may perform an Action on a Resource. A decision intersects the authentication medium's fixed capability ceiling, the current Team Membership Role, and server-resolved resource ownership.
_Avoid_: Authentication, permission snapshot, embedded Role

**Authorization Policy**:
The pure, centrally defined rules that produce an Authorization Decision from a Principal, Action, and authoritative Resource and Team Membership facts. It performs no data access and denies unknown Actions or Resource kinds.
_Avoid_: permission middleware, database authorization service, handler check

**Authorization Decision**:
The Allow, Conceal, or Forbid result of applying Authorization Policy. Conceal hides an existing but invisible Resource; Forbid rejects an Action on a visible Resource.
_Avoid_: boolean permission, HTTP status, authentication failure

**Action**:
A centrally defined domain capability whose meaning is independent of HTTP methods, routes, and handlers.
_Avoid_: CRUD verb, HTTP method, route name

**Resource**:
An object whose use is governed by Authorization and is classified as an Instance, User, or Team Resource.
_Avoid_: route parameter, client Team ID, copied ACL

**Instance Resource**:
The ATape instance scope against which instance-wide Actions, such as creating a Team, are decided.
_Avoid_: global ACL, admin tenant

**User Resource**:
A Resource owned directly by one User, such as that User's External Identities, Web Sessions, and CLI Credentials.
_Avoid_: Team Resource, public user data

**Team Resource**:
A Resource owned by exactly one Team, either directly or through its Project. Captured Sessions, Threads, Canonical Events, and Raw Objects inherit their Team from their Project.
_Avoid_: copied ACL, client Team ID

**Security Audit Event**:
An append-only record of a security-relevant domain action, its initiator, target, outcome, and time. The domain that owns the action produces the event; a shared audit capability persists it.
_Avoid_: access log, application log, Canonical Event

**Audit Initiator**:
The typed origin of a Security Audit Event: a Principal, Federated Login, anonymous request, or system process. It is not conversation participant metadata and never contains a raw Claim or Secret.
_Avoid_: Actor, User ID string, Canonical Actor

## Capture attribution

**Captured-by User**:
The immutable User attribution that ATape derives from the authenticated Principal when accepting captured history. The Team, not this User, owns the resulting history.
_Avoid_: Source User, Owner User, client userId

**Collector Installation**:
The stable source identity of one ATape collector installation. It is neither a User, Principal, Device, nor independent security subject.
_Avoid_: Device, Machine Account, Principal

**Canonical Actor**:
Participant metadata represented inside captured coding-agent history. It carries no ATape authentication or authorization authority.
_Avoid_: Principal, User, Captured-by User
