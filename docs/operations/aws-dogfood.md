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
df -h /
docker system df
docker compose exec -T database \
  psql -U atape -d atape -Atc "select pg_size_pretty(pg_database_size('atape'));"
```

Skipping automated backup is acceptable only while the dogfood data is
explicitly disposable. Do not mark the staging attestation complete or publish
a production release until the repository's paired backup and restore gate has
been exercised.

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

Subsequent Compose operations must include the persisted image override:

```sh
cd /opt/atape/app
docker compose -f compose.yaml -f compose.web-release.yaml ps
```

The host records `.last-web-release` and `.previous-web-release` under
`/opt/atape/`. Images use `atape-web:<sha>`; each attempt retains the prior image
as `atape-web:rollback-<attempted-sha>`. For an explicit rollback, set the Web image
in `compose.web-release.yaml` to that rollback tag and run:

```sh
docker compose -f compose.yaml -f compose.web-release.yaml \
  up -d --no-deps --no-build --wait --wait-timeout 120 web
curl -fsS http://127.0.0.1:8080/__web-release.json
```

Automatic rollout does not delete Docker images. Use the storage guardrail above
and retain the active and rollback images when reclaiming old build cache/images.
Validate a Server/API contract change with the Server deployment process before
depending on it in an automatically deployed Web change.
