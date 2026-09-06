# ADR-0019: Low-Cost Dogfood Host Egress

- Status: Accepted
- Date: 2026-09-06
- Review by: 2026-12-31

## Context

The AWS dogfood profile runs one disposable ATape Compose installation behind
Cloudflare Tunnel. The host needs outbound access to Systems Manager, operating
system and container package sources, GitHub, and Cloudflare's Tunnel edge. The
first three use globally distributed HTTPS endpoints, while Tunnel prefers QUIC
or HTTP/2 on port 7844. Their address sets are not stable enough to encode as
security-group CIDRs.

PrivateLink endpoints plus controlled NAT egress would avoid public CIDRs, but
their fixed monthly cost would be disproportionate to the short-lived personal
experiment. Removing public egress would also prevent bootstrap and management.

## Decision

The dogfood security group has no inbound rules and permits outbound traffic
only on TCP 443 and TCP/UDP 7844. The public-CIDR findings for those three rules
are suppressed through 2026-12-31. The exception applies only to the disposable
`atape-dogfood` profile and does not establish a production hosting baseline.

The application still listens only on loopback. Cloudflare Tunnel is the only
public request path, and Systems Manager is the only administrative access path.

## Consequences

- The host can bootstrap, receive Systems Manager commands, and maintain its
  Cloudflare Tunnel without an ALB, NAT Gateway, or PrivateLink endpoints.
- Arbitrary outbound HTTPS remains possible from a compromised host. Port
  restriction reduces the surface but does not provide destination control.
- Continuing this profile after the review date requires an explicit decision:
  renew the bounded dogfood exception, introduce controlled egress, or retire
  the host.
- A production deployment must make its own egress and network-isolation
  decision rather than inheriting this exception.
