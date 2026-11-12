const DAY_MS = 24 * 60 * 60 * 1000;

/** A session unused (by `last_seen_at`) for longer than this is expired. */
export const IDLE_SESSION_TIMEOUT_MS = 90 * DAY_MS;

/** A session older than this (by `created_at`) is expired however actively it is used. */
export const ABSOLUTE_SESSION_LIFETIME_MS = 365 * DAY_MS;
