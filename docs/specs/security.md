# Spec: Security and encryption

- Status: living spec (source of truth for behaviour)
- Origin: [founding design](2026-11-08-budgedino-design.md) §10. **[owner]** = decided by the owner,
  **[call]** = AI's call, may be challenged.

Threat model **[owner]**: the server operator is trusted (self-hosting). Protect against: stolen server
disk, database dumps or backups, curious hosting provider, network attackers, lost/stolen phones,
leakage via logs and telemetry, and other household members for `owner-only` accounts.

Measures **[call]**:
- **Application-level envelope encryption** of sensitive fields: bank credentials and PINs, aggregator
  keys and tokens, broker sessions, transaction details (counterparty, purpose, amounts), balances and
  holdings. A per-household data key encrypts the data; a master key (env var / file / Docker secret,
  never in the database) wraps the data keys. Key rotation supported.
  See [ADR 0004](../adr/0004-envelope-encryption.md).
- Consequence: searching and aggregation over encrypted fields happen in the application layer;
  acceptable at household scale.
- Encrypted backups (same key hierarchy); setup forces saving a recovery copy of the master key.
  ⚠️ Lost key = lost data, documented prominently.
- TLS everywhere (the owner's instance is exposed over the internet via their ingress **[owner]**).
- **Auth (internet-facing):** passkeys, or password + mandatory TOTP; device-bound sessions revocable
  per device; rate limiting and lockout; invite-only.
- **Phone:** local cache encrypted with a key in Android Keystore; biometric/PIN app lock; no
  screenshots in the recents switcher.
- **Notifications (v1): no push service.** The app checks the owner's server in the background
  (Android-permitted interval, ~15–60 min), fetches pending notifications over TLS and shows them as
  local notifications. No third party is involved. **[owner]**
  See [ADR 0006](../adr/0006-no-push-service-v1.md).
- **Extension point (later, opt-in): instant content-free pings** via a small project-run relay on
  FCM. A ping carries no data, only "wake up"; the app then fetches the content from its own server.
  The notification delivery is behind an interface so this can be added without changing callers.
  ⚠️ The relay is an operated, paid central component. **[owner]**
- Logs and traces never contain amounts, payees, IBANs, credentials (enforced by a redaction layer
  and tests).
- Visibility enforcement is a security property: see [household-and-access.md](household-and-access.md).
