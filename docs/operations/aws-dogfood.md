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
- Runtime: Amazon Linux 2023 ARM64, Docker Engine, Docker Compose v2, and 2 GiB swap

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
