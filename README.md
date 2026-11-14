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

Rancune draait in dezelfde database als de toernooisite. Vereist PHP 8.1 of nieuwer en HTTPS.

1. **Database:** open phpMyAdmin, kies de database van het toernooi en importeer `api/schema.sql`. Dat maakt vier tabellen aan die met `rancune_` beginnen; er wordt niets van het toernooi aangepast.
2. **Uploaden:** zet alle bestanden (behalve `.git`) via FTP in een map op hetzelfde domein, bijvoorbeeld `/toernooi/rancune/`.
3. **Config:** kopieer `api/config.sample.php` naar `api/config.php`. Staat de map in `/toernooi/rancune/` en het toernooi in `/toernooi/`, dan is dit genoeg:

   ```php
   'ek_config' => __DIR__ . '/../../config.php',
   ```

   Anders vul je de `db_*`-gegevens zelf in (dezelfde als in het toernooi-`config.php`).
4. **Testen:** open `https://jouwdomein.nl/toernooi/rancune/` en log in met je toernooi-account.
5. **Telefoon:** open de link in Chrome en kies **⋮ → App installeren**.

`api/config.php` staat in `.gitignore` en komt dus nooit in GitHub.

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
