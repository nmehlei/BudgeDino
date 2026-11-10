# Run BudgeDino on your Android phone (dev loop)

Checklist for the local dev loop on a physical phone (for example a Samsung S22) over USB. The server
runs on your Mac, the phone reaches it over Wi-Fi. No emulator: use the real device.

## One-time setup

- [ ] Install JDK 17 (Temurin) and the Android SDK; set `ANDROID_HOME` (platform-tools on `PATH` for `adb`).
- [ ] `mise trust` once in the repo so `.mise.toml` (java 17) is honoured. Without mise:
      `export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home`.
- [ ] `pnpm install`
- [ ] Phone: Settings > About phone > Software information, tap **Build number** seven times, then
      Settings > Developer options > turn on **USB debugging**.
- [ ] Connect the phone by USB, accept the "Allow USB debugging" prompt on the phone.
- [ ] `adb devices` lists the phone with state `device` (not `unauthorized`).

## Every session

- [ ] `pnpm dev:db` starts Postgres on port 5433 (needs Docker).
- [ ] `pnpm dev:seed -- --with-data` creates the demo household, a demo member, a connected demo bank
      with ~60 days of transactions and two budgets. It prints a one-time admin invite (`invite_token`).
      The values it prints (invite, demo password, TOTP secret) are dev-only.
- [ ] `pnpm dev:server` starts the API on `0.0.0.0:8080` with the demo bank (`fake` connector) enabled.
      The first start generates the dev master key in `.dev/master.key`; keep that file.
- [ ] Find your Mac's LAN IP: `ipconfig getifaddr en0` (Wi-Fi). Phone and Mac must be on the same Wi-Fi.
- [ ] Check from the phone's browser: `http://<lan-ip>:8080/api/v1/health` shows `{"ok":true,...}`.
- [ ] `pnpm mobile:android` regenerates the native project (`expo prebuild --clean`) and installs the
      development build on the phone. **The first build takes 5 to 10 minutes.** Later runs are faster.
- [ ] In the app enter `http://<lan-ip>:8080` as the server address and tap **Check**.
- [ ] Either **sign in** as `demo@budgedino.test` with the demo password and the code from the seed's
      `dev_totp_secret`, or **register** with the `invite_token` from the seed and add the TOTP secret
      shown in the app to your authenticator app, then confirm with its code.
- [ ] Home shows the Groceries and Eating out budgets with real numbers. Under Connections, "Add bank"
      offers **Demo bank**; connecting it shows a challenge you confirm.

Re-running `pnpm dev:seed -- --with-data` is safe: it creates nothing twice and prints a fresh invite.

## Maestro flows (optional)

Opt-in, never part of CI. With the server running, the seed done, the app installed and the phone attached:

```sh
brew install maestro        # once
pnpm maestro:device
```

It runs `login`, `home` and `connect-demo-bank` from `src/mobile/maestro` on the physical phone, deriving the
login code from `BUDGEDINO_DEV_TOTP_SECRET` (see `.env.dev.example`). Run it at most once per 30 seconds: a
TOTP code can only be used once.

## Troubleshooting

- **`adb devices` shows `unauthorized`:** unlock the phone, accept the USB debugging prompt (tick "always
  allow"); if it never appears, revoke USB debugging authorisations in Developer options and replug.
- **Phone cannot reach the server:** the Mac firewall may block Node on port 8080 (System Settings >
  Network > Firewall: allow incoming connections for Node), Wi-Fi may isolate clients (guest networks), or
  the IP changed (re-check `ipconfig getifaddr en0`).
- **App says the server is unreachable although the browser works:** use `http://` (not `https://`) and
  no trailing path; the development build allows cleartext, release builds do not.
- **Metro / app does not load JavaScript:** the phone must be on the same Wi-Fi as the Mac; `pnpm
mobile:android` starts Metro, so keep that terminal open. `adb reverse tcp:8081 tcp:8081` also works over USB.
- **Build fails with a Java error:** `java -version` must report 17; run `mise trust` or set `JAVA_HOME`.
- **`dev:server` says the master key or database is wrong:** the dev database was created with another
  `.dev/master.key`. Wipe it: `docker compose -f docker-compose.dev.yml down -v`, then `pnpm dev:db`.
- **Login with the demo account fails with an invalid code:** the TOTP secret is fixed when the seed first
  creates the member. If you changed `BUDGEDINO_DEV_TOTP_SECRET` afterwards, wipe the database (see above).
