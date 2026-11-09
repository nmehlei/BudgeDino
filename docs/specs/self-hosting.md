# Spec: Self-hosting and deployment

- Status: living spec (source of truth for behaviour)
- Origin: [founding design](2026-11-08-budgedino-design.md) §12. **[owner]** = decided by the owner,
  **[call]** = AI's call, may be challenged.

- Deliverable: container image(s) + `docker compose` file bundling Postgres by default; any Postgres via
  connection string. **[call]**
- **Repo and CI:** public GitHub repository, GitHub Actions, images published to GHCR. **[owner]**
- License: AGPL-3.0 (see [ADR 0008](../adr/0008-agpl-license.md)).
- Owner's instance: runs the same docker compose setup as other self-hosters **[owner]**, deployed to
  the owner's host (probably Horus) via a setup in the owner's separate `NME-IaC` repository (separate
  PR there, not part of this repo) **[owner]**; uses the existing `nme-pgsql` server with a dedicated
  database and user **[owner]**; exposed over the internet via the owner's existing ingress **[owner]**.
  See [ADR 0007](../adr/0007-shared-nme-pgsql.md).
- **Operator tasks run through a server CLI** (`budgedino <command>` inside the container): bootstrap
  the first household and admin invite, generate and back up the master key (with forced
  confirmation of a saved copy), key rotation, and Enable Banking registration (a one-time per-server
  task: the CLI generates the key pair, prints what to paste into the Enable Banking portal, and
  verifies). Everything members do day to day happens in the app. **[call]**
- Documentation: install, Enable Banking registration, key backup/recovery, upgrade, restore.
