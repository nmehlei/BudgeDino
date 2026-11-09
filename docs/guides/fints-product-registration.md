# FinTS product registration — guided checklist

Since 1 Aug 2019 German banks only accept FinTS clients that send a product registration number
issued by the Deutsche Kreditwirtschaft (DK). BudgeDino's `fints` connector (DKB, Comdirect) needs one.
This guide walks the owner through registering **BudgeDino** as a product. Work top to bottom; each
checkpoint says what "done" looks like.

Sources (checked 2026-11-09): [Produktregistrierung](https://www.fints.org/de/hersteller/produktregistrierung),
[FAQ Produktregistrierung](https://www.fints.org/de/hersteller/faq-produktregistrierung),
[python-fints quickstart](https://python-fints.readthedocs.io/en/latest/quickstart.html),
[fints (Dart) package notes](https://pub.dev/packages/fints).

## What we know

| Topic | Fact | Source |
|---|---|---|
| Cost | Free ("momentan kostenfrei") | FAQ 1 |
| What gets registered | The *application* a user recognises by name — i.e. "BudgeDino", not lib-fints | FAQ 4 |
| Libraries | A registered library/kernel ID may only be used internally for testing — so we must not reuse lib-fints' or anyone else's ID | FAQ 4 |
| Categories | PC/macOS software · Banking-App · Web-Client · **Web-Server** · FinTS library/kernel | FAQ 3 |
| Versions | Register once per product, not per version; the version is still sent on every dialog | FAQ 6 |
| How it's used | The number goes into the `Produktbezeichnung` element of every dialog initialisation | Registration page |
| Form | PDF form on the registration page, filled completely, sent "im Original" to `registrierung@hbci-zka.de` | Registration page |
| E-mail | Usually only **one** e-mail address per manufacturer; a generic/role address is recommended | FAQ 8 |
| Turnaround | Typically 10–15 working days; can be longer | FAQ 10 |
| Bank rollout | Reports of 0–8+ weeks until all bank servers know a new ID | fints (Dart) notes |
| Sharing | Using or passing on someone else's ID is reported to violate the terms | community issues |

**Open question for the DK** (ask in the cover e-mail, see below): may self-hosted installations of an
open-source product run by other people use the manufacturer's registration number, and may it appear
in public source code? Until answered, BudgeDino keeps the ID **out of the repository** and reads it from
`BUDGEDINO_FINTS_PRODUCT_ID`; every self-hoster supplies their own (already how the code works).

## Checkpoint 1 — Decide the manufacturer identity

- [ ] Manufacturer = you personally, or a company (e.g. one of your businesses). This name is what the
      DK records as "Hersteller"; pick what you're happy to have attached to an open-source finance app.
- [ ] Choose **one** contact e-mail for all future registrations by this manufacturer — ideally a role
      address you won't abandon (e.g. `fints@<your-domain>`), not a personal inbox.

Done when: you can fill "Hersteller" name, postal address and contact e-mail without hesitation.

## Checkpoint 2 — Collect the product data

Suggested values (adjust freely):

| Field (as expected on the form) | Value |
|---|---|
| Produktname | BudgeDino |
| Produktkategorie | **Web-Server** (the server talks to the banks on the users' behalf; the Android app only talks to the server) |
| Kurzbeschreibung | Open-source, self-hostable household finance manager; read-only account information (balances, transactions) via FinTS PIN/TAN incl. decoupled TAN; no payments. |
| Unterstützte Geschäftsvorfälle | Kontoumsätze (HKKAZ/HKCAZ), Kreditkartenumsätze (DKKKU), Saldo (via Umsätze), Synchronisation (HKSYN), TAN (HKTAN, inkl. decoupled); **keine Zahlungsaufträge** |
| Sicherheitsverfahren | PIN/TAN (PSD2-konform, inkl. Decoupled) |
| FinTS-Version | 3.0 |
| Verwendete Bibliothek | lib-fints (LGPL-2.1-or-later) |
| Produktversion (sent at runtime, not registered) | `1.0` → env `BUDGEDINO_FINTS_PRODUCT_VERSION` |
| Website / Repository | the GitHub repo URL once public (private for now — give the project homepage if you have one, or leave blank) |

Done when: every field on the PDF has a value or a deliberate "n/a".

## Checkpoint 3 — Fill and send the form

- [ ] Download the current PDF from the [registration page](https://www.fints.org/de/hersteller/produktregistrierung)
      (the form changes occasionally — always use the current one).
- [ ] Leave the *Produktregistrierungsnummer* field **empty** (new application; FAQ 5).
- [ ] Fill every field; sign if the form asks for a signature ("im Original").
- [ ] Send it to `registrierung@hbci-zka.de` with the cover e-mail below.
- [ ] Add a reminder for **+15 working days** to follow up if nothing arrived.

Cover e-mail (German, ready to send — fill the brackets):

> Betreff: Neuregistrierung FinTS-Produkt „BudgeDino“
>
> Sehr geehrte Damen und Herren,
>
> anbei erhalten Sie das ausgefüllte Formular zur Registrierung unseres FinTS-Produkts „BudgeDino“
> (Kategorie Web-Server). BudgeDino ist eine quelloffene, selbst betreibbare Haushaltsbuch-Anwendung,
> die ausschließlich Kontoinformationen (Umsätze, Salden) per PIN/TAN abruft; Zahlungsaufträge werden
> nicht unterstützt.
>
> Eine Rückfrage zur Nutzung: Da BudgeDino Open Source ist und von Dritten selbst betrieben werden kann —
> dürfen solche Installationen die für BudgeDino vergebene Registrierungsnummer verwenden, und darf die
> Nummer im öffentlichen Quellcode stehen? Oder muss jeder Betreiber eine eigene Registrierung beantragen?
>
> Vielen Dank und freundliche Grüße
> [Name], [Hersteller], [Anschrift], [E-Mail]

Done when: the e-mail is sent and the follow-up reminder exists.

## Checkpoint 4 — Receive and store the number

- [ ] The DK replies with the registration number.
- [ ] Store it in your password manager / secrets store (treat it as configuration, not a secret, but
      don't paste it into issues or chats until the DK answered the sharing question).
- [ ] Locally: add `BUDGEDINO_FINTS_PRODUCT_ID=<number>` to your untracked `.env` (never commit it).
- [ ] Horus deployment: add it to the NME-IaC secret/config for BudgeDino when the deploy plan (P6) lands.
- [ ] Record the DK's answer to the sharing question in `docs/adr/` (new ADR) so the self-hosting docs
      can say definitively whether self-hosters need their own number.

Done when: `BUDGEDINO_CONNECTORS=fints` + the env var start the server without a config error.

## Checkpoint 5 — Verify against DKB (opt-in live test)

Banks may need days to weeks to accept a new number. If DKB answers with an "unknown product" /
"Produkt nicht registriert" style message, wait and retry later — nothing is wrong on our side.

- [ ] `FINTS_LIVE_BANK=dkb FINTS_LIVE_USER=… FINTS_LIVE_PIN=… BUDGEDINO_FINTS_PRODUCT_ID=… pnpm test:live`
      (the test prints only the challenge text, account counts/kinds and a date range — never amounts or names).
- [ ] Approve the request in the DKB app when prompted.
- [ ] Repeat once for Comdirect if you have an account there.

Done when: the live test reports a successful sync for DKB.
