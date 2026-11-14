# Rancune Counter

Android-app (PWA) voor Magic: Commander. Je tikt de schade aan die je ontvangt van elke tegenstander, en de app houdt bij wie jou het meest haat. De gegevens staan online in een database; inloggen doe je met je **Exploding Kraken-account**.

## Wat wordt bijgehouden

- Type schade per tegenstander: **gewoon**, **commander** (rood vanaf 21) en **toxic** (rood vanaf 10)
- Wie jou als **eerste** en als **laatste** schade deed in een potje
- Alle potjes met tijdlijn, uitslag (gewonnen / verloren / gestopt) en historie

## Rancune-score

Per potje dat je samen speelde krijgt een tegenstander punten:

| Onderdeel | Punten |
|---|---|
| Gewone schade | ×1 |
| Commander-schade | ×2 |
| Toxic-teller | ×3 |
| Eerste klap in het potje | +10 |
| Laatste klap in het potje | +15 |

De **rancune-score** is het gemiddelde aantal punten per potje. De gewichten staan bovenin `app.js` (`WEIGHT`, `LEVELS`).

## Hoe inloggen en opslag werken

- **Accounts:** die van de toernooisite (tabel `users`). Spelers loggen in met hun e-mailadres, de beheerder ook met zijn gebruikersnaam. Er is geen eigen registratie; nieuwe mensen krijgen een account via de toernooisite.
- **24 uur:** een login is vanaf het inloggen precies 24 uur geldig en wordt niet verlengd. Daarna vraagt de app opnieuw om in te loggen. De sessie staat in een `HttpOnly`/`SameSite=Strict`-cookie en los van de sessie van de toernooisite.
- **Eigen data:** elk account ziet alleen zijn eigen spelers, potjes en statistieken.
- **Offline:** zonder verbinding werkt de app door op de kopie op de telefoon. Wijzigingen worden opgeslagen zodra je weer online bent, ook na een sessie die tussendoor verliep.
- **Beveiliging:** wachtwoorden worden alleen gecontroleerd (nooit opgeslagen of verstuurd naar derden), sessietokens staan gehasht in de database, na 5 mislukte pogingen volgt een pauze van 15 minuten, en alle queries zijn prepared statements.
- **Back-up:** niet nodig, maar *Meer → Back-up opslaan* geeft een JSON-bestand (en met *terugzetten* kun je er een inladen; dat vervangt je online gegevens).

## Installeren op STRATO

Rancune draait in dezelfde database als de toernooisite. Vereist PHP 8.1 of nieuwer en HTTPS. Updaten gaat net als bij het toernooi: een push naar `main` zet de bestanden via GitHub Actions (`.github/workflows/deploy.yml`) op STRATO.

**Eenmalig:**

1. **Map:** Rancune krijgt een eigen map op het domein, **niet** de hoofdmap van de website (daar staat de toernooisite al). Bijvoorbeeld `/toernooi/rancune/`.
2. **Secrets:** voeg in GitHub bij *Settings → Secrets and variables → Actions* van deze repo vier secrets toe: `SFTP_HOST`, `SFTP_USERNAME` en `SFTP_PASSWORD` (dezelfde als bij het toernooi) en `SFTP_PATH` (de **volledige serverpad van de Rancune-map**, dus niet dat van het toernooi).
3. **Database:** open phpMyAdmin, kies de database van het toernooi en importeer `api/schema.sql`. Dat maakt vier tabellen aan die met `rancune_` beginnen; er wordt niets van het toernooi aangepast.
4. **Config:** maak op de server `api/config.php` aan (kopie van `api/config.sample.php`). Staat de map in `/toernooi/rancune/` en het toernooi in `/toernooi/`, dan is dit genoeg:

   ```php
   'ek_config' => __DIR__ . '/../../config.php',
   ```

   Anders vul je de `db_*`-gegevens zelf in (dezelfde als in het toernooi-`config.php`). Dit bestand staat in `.gitignore`, komt dus nooit in GitHub en wordt door de deploy niet overschreven.
5. **Deployen:** merge naar `main`. Open daarna `https://jouwdomein.nl/toernooi/rancune/` en log in met je toernooi-account.
6. **Telefoon:** open de link in Chrome en kies **⋮ → App installeren**.

**Daarna:** wijzigingen naar `main` pushen is genoeg. Alleen bij nieuwe databasetabellen moet je het SQL-bestand zelf in phpMyAdmin draaien.

## Lokaal draaien

Je hebt PHP en MySQL nodig (Laragon heeft beide), met een database waarin de tabel `users` van het toernooi staat en `api/schema.sql` is geïmporteerd:

```bash
php -S localhost:8765 -t .
```

en open <http://localhost:8765>.

## Bestanden

- `index.html`, `style.css`, `app.js` – de app
- `api/` – PHP-API (`index.php`, `lib.php`), `schema.sql` en `config.sample.php`
- `manifest.webmanifest`, `icons/`, `sw.js` – installeerbaarheid en offline gebruik
