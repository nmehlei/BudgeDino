# ADR 0006: No push service in v1

- Status: accepted (owner decision), 2026-11-09

## Context

Push notifications on Android go through FCM, a third party, and any project-run relay is an operated,
paid central component. Notification payloads must never contain financial data.

## Decision

v1 has no push service. The app checks the owner's server in the background (Android-permitted
interval, about 15–60 minutes), fetches pending notifications over TLS and shows them as local
notifications. Notification delivery sits behind an interface so an opt-in relay sending content-free
"wake up" pings via FCM can be added later without changing callers.

## Consequences

- No third party is involved; notifications can be delayed by up to the background interval.
- No central component to operate or pay for.
- A later relay is an explicit, opt-in extension.
