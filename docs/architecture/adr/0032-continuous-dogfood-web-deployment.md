# ADR-0032: Continuous dogfood Web deployment

Status: Accepted

## Decision

After both CI and Security succeed for the latest `main` commit, GitHub Actions
deploys that immutable commit's Web image to the existing dogfood host. Versioned
npm releases, the Go Server, database migrations, and durable volumes remain on
their existing release paths.

The deployment Module exposes one Interface: a full commit SHA and its extracted
source tree. Its Implementation owns serialization, native image construction,
seven-day retention of old lazy-load assets, Web-only Compose replacement,
health/revision verification, and rollback. Callers need no knowledge of the
running image or Compose override. This Depth gives the workflow Leverage while
keeping rollout knowledge and failure handling in one script for Locality.

SSM is the remote Seam. The AWS Adapter uses a fixed document with an allowlisted
SHA parameter. A GitHub OIDC role scoped to this repository's `main` branch can
invoke only that document on that instance and inspect command results. It
cannot run arbitrary SSM shell commands or read application secrets. The public
repository archive is fetched by exact SHA; no Git credential is installed on
the host. Docker/Compose are local-substitutable command Adapters. Contract tests
exercise the script Interface with executable test Adapters, including rollback.

## Alternatives

1. Build on the ARM64 host and deploy through the existing SSM boundary. Chosen:
   no new registry, bucket, public ingress, runner, or long-lived credential.
   Builds are slower on the small host, but the previous Web image serves during
   construction and the process has a bounded timeout.
2. Build ARM64 images on GitHub runners and distribute through ECR/S3. This moves
   CPU load off the host but introduces artifact storage, retention, and push/pull
   IAM boundaries. Revisit when build latency or host load warrants it.

The workflow and host both serialize deployment; a superseded SHA is skipped
before dispatch. No workflow automatically cancels a running host rollout.
Health failure restores the previous image and does not advance the deployed
revision marker. The source tree used by Server operations is not replaced.

This is continuous deployment to the existing disposable dogfood environment,
not evidence that the versioned production release checklist has been completed.
