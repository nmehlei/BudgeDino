# ADR 0001: TypeScript throughout

- Status: accepted (owner decision), 2026-11-09

## Context

BudgeDino needs a server and an Android app (iOS later), shared money/date logic and API types, and
must be approachable for open-source contributors and self-hosters.

## Decision

Use TypeScript for everything: server (Node.js LTS, Fastify, Drizzle, PostgreSQL, pg-boss), mobile
(Expo / React Native, development builds, not Expo Go) and a shared package (types, zod schemas,
money/date logic) in a pnpm monorepo. **[owner]**

## Consequences

- One language and one toolchain; types and validation schemas are shared between server and app.
- Connector libraries must exist in or be ported to TypeScript (e.g. `lib-fints`, a TS port of the
  Trade Republic protocol).
- Strict mode and no `any` in domain code keep the single-language benefit from turning into drift.
