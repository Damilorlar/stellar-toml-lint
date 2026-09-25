## Unreleased

### New

- Add a `--check-network` validator network audit so operators can confirm a
  declared `[[VALIDATORS]].PUBLIC_KEY` is actually seen by the active Stellar
  overlay consensus. The rule cross-references the declared key against
  `https://api.stellarbeat.io/v1/nodes` (or a configured `STELLARCRAWLER_URL`)
  and reports `validators/node-not-seen-on-overlay` or
  `validators/node-consensus-stalled` as warnings, never errors.
- Ship a root `.pre-commit-hooks.yaml` that defines `id: stellar-toml-lint` for
  `language: node`.
- Publish an official multi-architecture container image
  (`ghcr.io/anchor-tools/stellar-toml-lint`) built with Docker Buildx for
  `linux/amd64` and `linux/arm64`. Consumers can add the Docker hook to
  `.pre-commit-config.yaml` with `language: docker_image`.
- Distinguish the satellite-key rollover case in the node-not-seen telemetry so
  `validators/node-not-seen-on-overlay` now fires on what the crawler actually
  reports rather than always on an unreachable crawl surface.

### Docs and workflow

- Document both pre-commit consumption paths (Node and Docker) in README.
- Add `.github/workflows/docker.yml` with GitHub Container Registry
  publishing, Buildx, SBOM, provenance, and cosign verification.
- Update `docs/WAVE-ISSUES.md` with the new validator network check before/after
  behavior and its graceful-degradation constraints.

## [0.1.0] - 2026-09-25

Initial open source release.
