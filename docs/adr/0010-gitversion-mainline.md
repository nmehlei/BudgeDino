# ADR 0010: Every commit gets its own version (GitVersion 5.x, Mainline)

- Status: accepted, 2026-11-10

## Context

The app and the server need a version a person can read in the app (About, `/health`) and that
identifies exactly which commit is running. Android also needs a `versionCode` that grows with every
release. Hand-maintained version numbers drift and are forgotten.

## Decision

- GitVersion 5.x in Mainline mode (`GitVersion.yml`) computes the version from git history: every merge
  to `main` increments the patch, branches get a pre-release tag with a commit counter
  (`0.1.2-feat-x.92`). Minor and major bumps use `+semver: minor|major` in a commit message or a tag.
- `scripts/version.cjs` is the single source for builds: `BUDGEDINO_VERSION` /
  `BUDGEDINO_VERSION_CODE` / `BUDGEDINO_COMMIT` (set by CI), else `dotnet-gitversion`, else a
  `0.0.0-local+<sha>` fallback so a machine without GitVersion still builds.
- The Expo config (`app.config.ts`) uses it for `version`, `android.versionCode` and `extra.commit`; the
  server bundle (`scripts/build.mjs`) embeds it, and `/health` reports it.
- `versionCode` = `git rev-list --count HEAD`: monotonic along `main`.
- CI installs GitVersion.Tool 5.12.0, checks out the full history and fails if GitVersion did not run.

## Consequences

- No manual version bumps; the About screen and `/health` always name the exact build.
- A branch build can have a higher `versionCode` than the next `main` build (branch commits count too);
  installing the `main` build over it then needs an uninstall. Development builds only, acceptable.
- The OpenAPI document keeps the static API version (`@budgedino/shared` `VERSION`), so it does not
  drift per commit.
- The persisted query cache is keyed by app version, so every new build starts with an empty cache.
