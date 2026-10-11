# AWS dogfood deployment

This profile runs the complete ATape Compose topology on one low-cost EC2 host.
It is for disposable product validation, not the production release gate. In
particular, it does not schedule the paired PostgreSQL and Raw backup required
by [Backup and restore](backup-and-restore.md).

## Fixed profile

- Region: `ap-southeast-1` (Singapore)
- Instance: `t4g.small`, standard CPU credits, no detailed monitoring
- Storage: one encrypted 60 GiB `gp3` root volume
- Access: Systems Manager only; the security group has no inbound rules
- Edge: Cloudflare Tunnel to the loopback Compose listener
- Runtime: Amazon Linux 2023 ARM64, Docker Engine, Docker Compose, Docker Buildx, and 2 GiB swap

Outbound traffic is restricted to HTTPS plus Cloudflare Tunnel's TCP/UDP 7844
transport. The public-CIDR exception and its review date are recorded in
[ADR-0019](../architecture/adr/0019-low-cost-dogfood-egress.md).

The root volume deliberately has `DeleteOnTermination=false`. This reduces the
chance that an accidental instance or stack deletion destroys the experiment's
data, but it is not a backup. A retained orphan volume keeps accruing EBS cost
until it is explicitly deleted.

`t4g` runs in standard rather than unlimited mode so a sustained build or
import can become slower after exhausting CPU credits but cannot add surplus
CPU-credit charges. Stop the instance and change its type to `t4g.medium` for a
memory-heavy import; return it to `t4g.small` after the operation.

## Provision the host

Use a default public subnet. The stack creates no SSH key or inbound rule and
does not contain application or Cloudflare secrets.

```sh
export ATAPE_AWS_PROFILE=admin
export ATAPE_AWS_REGION=ap-southeast-1

ATAPE_VPC_ID=$(aws ec2 describe-vpcs \
  --profile "$ATAPE_AWS_PROFILE" \
  --region "$ATAPE_AWS_REGION" \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)

ATAPE_SUBNET_ID=$(aws ec2 describe-subnets \
  --profile "$ATAPE_AWS_PROFILE" \
  --region "$ATAPE_AWS_REGION" \
  --filters Name=vpc-id,Values="$ATAPE_VPC_ID" \
            Name=default-for-az,Values=true \
            Name=state,Values=available \
  --query 'sort_by(Subnets,&AvailabilityZone)[0].SubnetId' \
  --output text)

aws cloudformation deploy \
  --profile "$ATAPE_AWS_PROFILE" \
  --region "$ATAPE_AWS_REGION" \
  --stack-name atape-dogfood \
  --template-file deploy/aws/dogfood-ec2.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId="$ATAPE_VPC_ID" \
    SubnetId="$ATAPE_SUBNET_ID"
```

Wait for `/opt/atape/.base-ready` through Systems Manager before installing the
application. A missing marker means the EC2 user-data bootstrap failed; inspect
`/var/log/cloud-init-output.log` rather than opening SSH.

## Application and edge boundary

The host runs the repository's normal same-origin Compose topology with:

```dotenv
ATAPE_PUBLIC_URL=https://atape.net
ATAPE_API_PUBLIC_URL=
ATAPE_COOKIE_DOMAIN=
ATAPE_DEVELOPMENT_ALLOW_HTTP=false
```

Cloudflare Tunnel forwards only `https://atape.net` to
`http://127.0.0.1:8080`. PostgreSQL, the Go listener, and the Compose network
remain private. The GitHub OAuth App callback must exactly equal:

```text
https://atape.net/api/v1/auth/github/callback
```

Store the GitHub client secret and the remotely managed Tunnel token as
`SecureString` parameters below `/atape/dogfood/`. The instance role can read
only that path. Do not place either value in CloudFormation parameters, EC2
user data, `.env`, shell history, or command output.

Do not enable an ALB, NAT Gateway, RDS, EKS, CloudWatch agent, Container
Insights, Managed Prometheus, or Managed Grafana for this profile. Docker uses
bounded local logs; basic EC2 status checks and an account-level billing budget
are sufficient for the experiment.

## Storage guardrail

The 60 GiB volume contains the operating system, Docker images, PostgreSQL,
Raw chunks, and temporary build data. Treat 70% usage as the expansion point.
EBS can grow online, but it cannot shrink. Check the three independent sources
of pressure:

```sh
cd /opt/atape/app
export COMPOSE_FILE=/opt/atape/app/compose.yaml:/opt/atape/app/compose.publication.yaml:/opt/atape/app/compose.server-release.yaml:/opt/atape/app/compose.web-release.yaml
df -h /
docker system df
docker compose --env-file /opt/atape/app/.env exec -T database \
  psql -U atape -d atape -Atc "select pg_size_pretty(pg_database_size('atape'));"
```

Skipping scheduled backup is acceptable only while dogfood data is explicitly
disposable. The automated isolated paired-restore gate remains mandatory for a
package release. [ADR-0048](../architecture/adr/0048-release-request-manual-acceptance.md)
permits an explicitly authorized candidate-bound waiver of incomplete manual
staging checks, including operational backup/restore. That waiver does not
complete staging or establish that a production restore happened.

## Server image updates

Server maintenance is separately authorized. Retain the current image and a fresh
consistent PostgreSQL/Raw recovery point before changing it. Hold
`/opt/atape/.web-deploy.lock`, shared with automatic Web deployment, while
resolving the independently serving Web image/revision and changing Server pins.
The host persists the same verified image for `server` and `server-init` in
`compose.server-release.yaml`, plus a matching `ATAPE_SERVER_IMAGE` in `.env`.
Change and verify both pins together. The `.env` pin also protects the base image
selection during the existing automatic Web-only rollout.

Manual Compose operations must retain the base, publication, Server and Web
overrides, including backup and restore. Preserve this topology when using
[the backup/restore scripts](backup-and-restore.md), with
`ATAPE_COMPOSE_ENV_FILE=/opt/atape/app/.env`. Keep database services running as
required by those scripts; stop all application writers for the PostgreSQL/Raw
pair. The ordinary backup script temporarily stops Server/Web and restores their
previous running state. A maintenance workflow that needs writers to remain
stopped must retain that boundary through backup and subsequent verification.
Taking a backup does not prove that restore has been exercised.

V4 adds no database schema migration for 0.5.9. After current readable v4 data is
accepted, an image-only rollback to a pre-v4 Server cannot promise Reader
compatibility. A deliberate incompatible rollback needs the matching paired
PostgreSQL/Raw restore and old image/environment pin; that restore withdraws later
writes. Readiness failure alone must not trigger a blind data restore. Keep
writers stopped while the durable-data boundary is uncertain, retain evidence and
choose a compatible recovery path. An encrypted root-volume snapshot is an
additional recovery point, not a replacement for the paired-data contract.

[The 0.5.9 delivery record](../releases/evidence/v0.5.9-delivery.json) records the
actual Server, recovery-point, API smoke and package-distribution outcomes;
manual staging acceptance remains separately pending.

## Automatic Web deployment

`Deploy Web` runs after CI or Security completes on `main`. It deploys only when
both workflows passed on the same, still-current main SHA. Manual dispatch is
also supported on main and uses the same checks. A newer failing commit is never
replaced by silently deploying an older successful commit.

Provision the deployment boundary once, using the existing GitHub OIDC provider:

```sh
aws cloudformation deploy --profile admin --region ap-southeast-1 \
  --stack-name atape-web-deployment \
  --template-file deploy/aws/web-deployment.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides InstanceId=<dogfood-instance-id>
```

Set these GitHub Actions **variables** from the stack outputs (no secrets):

| Variable | Stack output |
| --- | --- |
| `ATAPE_WEB_DEPLOY_ROLE_ARN` | `RoleArn` |
| `ATAPE_WEB_DEPLOY_DOCUMENT_NAME` | `DocumentName` |
| `ATAPE_WEB_DEPLOY_INSTANCE_ID` | `InstanceId` |

The workflow exchanges GitHub OIDC for temporary AWS credentials, sends the
verified SHA to the fixed SSM document, waits for its result, then checks
`https://atape.net/__web-release.json`. That endpoint contains the deployed Web
commit, independently of the Server's release/version information.

The host builds the canonical Web Dockerfile natively while the old container
continues serving. Only Web is recreated, using `--no-deps --no-build`; Server,
PostgreSQL, secrets, and durable volumes are not restarted or migrated. Old
hashed asset files are retained for seven days so already-open pages can still
load their code chunks. Build failure leaves Web untouched; rollout or local
revision-check failure restores the previous image. A public-edge failure marks
the workflow failed for investigation rather than repeatedly restarting Web.

Subsequent manual Compose operations must include all persisted overrides:

```sh
cd /opt/atape/app
export COMPOSE_FILE=/opt/atape/app/compose.yaml:/opt/atape/app/compose.publication.yaml:/opt/atape/app/compose.server-release.yaml:/opt/atape/app/compose.web-release.yaml
docker compose --env-file /opt/atape/app/.env config --quiet
docker compose --env-file /opt/atape/app/.env config --images
docker compose --env-file /opt/atape/app/.env ps
```

Verify that `server` and `server-init` resolve to the same reviewed image and that
the running Server has that image identity. These are host-maintained image pins;
do not infer their value from a release tag or replace them during Web-only work.

The host records `.last-web-release` and `.previous-web-release` under
`/opt/atape/`. Images use `atape-web:<sha>`; each attempt retains the prior image
as `atape-web:rollback-<attempted-sha>`. For a compatible Web-only rollback, hold
the same deployment lock, preserve the complete `COMPOSE_FILE` above and set only
the Web image in `compose.web-release.yaml` to the retained reviewed tag. Run:

```sh
docker compose --env-file /opt/atape/app/.env \
  up -d --no-deps --no-build --wait --wait-timeout 120 web
curl -fsS http://127.0.0.1:8080/__web-release.json
```

This recreates only Web. It does not run init, restart Server, migrate or restore
data, and it is not a Server rollback procedure.

Automatic rollout does not delete Docker images. Use the storage guardrail above
and retain the active and rollback images when reclaiming old build cache/images.
Validate a Server/API contract change with the Server deployment process before
depending on it in an automatically deployed Web change.
