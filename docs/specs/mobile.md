# Spec: Mobile app

The Expo Android app (development build, never Expo Go) talks to one self-hosted server.

## Mobile onboarding

- **Server URL.** The user enters the server address; "Check" calls the public `GET /api/v1/health`
  before continuing. The URL is normalised: scheme and host lowercased, trailing slashes and a pasted
  `/api/v1` removed, any other path kept. Only `https://` is accepted; `http://` is accepted only in the
  development variant (`extra.allowCleartext`, which also enables Android cleartext traffic). Release
  builds reject it.
- **Registration.** Invite token, email, display name, password (minimum 12 characters, strength hint)
  and device name (prefilled from the device model) go to `POST /auth/register`. The next screen shows
  the TOTP QR code and the secret for manual entry; a 6-digit code confirms and stores the session token
  (expo-secure-store only).
- **TOTP secret handling.** The provisioning URI is held in memory only (never in route params, MMKV
  or the query cache), is shown once, and is cleared when the TOTP screen is left. "Copy secret" puts the
  secret on the clipboard and overwrites it with an empty string after about 60 seconds (best effort),
  also when the screen was already left; copying again restarts the 60 seconds. The screen says so. The password field is cleared as soon as registration or login succeeds.
- **Login.** Email, password and a 6-digit code (digits only). Every failure except rate limiting shows
  the same generic "Login failed"; the app never says which factor was wrong. A 429 shows "Too many
  attempts, try again in N minutes" from `Retry-After`.
- **Session expiry.** Any 401 on an authenticated request wipes the session (token, query cache) and
  lands on login with "Session expired, please sign in again". A 401 from the login or register
  endpoints is an ordinary failed attempt and does not touch the session.
- **Root routing.** Loading shows a splash; signed out goes to the server screen when no server URL is
  stored, otherwise to login; signed in goes home.
