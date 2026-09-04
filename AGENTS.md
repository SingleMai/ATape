# ATape Engineering Guide

Before changing production code, read [docs/architecture/README.md](docs/architecture/README.md) and the language guide for the area you are changing.

The following rules are mandatory:

- Design deep Modules: keep the Interface small and hide substantial behavior in the Implementation.
- Use the vocabulary Module, Interface, Implementation, Seam, Adapter, Depth, Leverage, and Locality as defined in the architecture manual.
- Presentation code translates input and output. It does not own business rules, persistence, retries, or distributed workflows.
- TypeScript uses Effect for side effects, dependency requirements, typed failures, resource lifetime, and asynchronous workflows.
- Go uses ordinary Go Modules. Fx is allowed only in the executable Composition Root.
- Do not introduce an Interface or Seam merely to make mocking convenient. A varying production implementation, a remote dependency, or a justified test Adapter must make the Seam real.
- Test behavior through the same Interface used by callers. Do not couple tests to private orchestration.
- Canonical conversation data, Raw source data, and the Search read model remain separate concerns even when one workflow coordinates them.

If a change needs an exception, record the reason in an ADR before implementing it.
