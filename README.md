# Rancune Counter

Android-app (PWA) voor Magic: Commander. Je tikt de schade aan die je ontvangt van elke tegenstander, en de app houdt bij wie jou het meest haat.

## Wat wordt bijgehouden

- Type schade per tegenstander: **gewoon**, **commander** (rood vanaf 21) en **toxic** (rood vanaf 10)
- Wie jou als **eerste** schade deed in een potje
- Wie jou als **laatste** schade deed in een potje
- Alle potjes met tijdlijn, uitslag (gewonnen / verloren / gestopt) en historie
- Alles staat lokaal op de telefoon; met *Meer → Back-up opslaan* maak je een JSON-bestand

## Rancune-score

Per potje dat je samen speelde krijgt een tegenstander punten:

| Onderdeel | Punten |
|---|---|
| Gewone schade | ×1 |
| Commander-schade | ×2 |
| Toxic-teller | ×3 |
| Eerste klap in het potje | +10 |
| Laatste klap in het potje | +15 |

De **rancune-score** is het gemiddelde aantal punten per potje. De gewichten staan bovenin `app.js` (`WEIGHT`, `LEVELS`) en zijn eenvoudig aan te passen.

## Lokaal draaien

Geen build-stap nodig, het zijn losse statische bestanden. Bijvoorbeeld:

```bash
php -S localhost:8765 -t .
```

en open <http://localhost:8765>.

## Op de telefoon installeren

Een PWA kan alleen echt geïnstalleerd worden (en offline werken) als hij via **https** wordt aangeboden, bijvoorbeeld via GitHub Pages of Netlify. Open daarna de link in Chrome op Android en kies **⋮ → App installeren** (of *Toevoegen aan startscherm*).

## Bestanden

- `index.html`, `style.css`, `app.js` – de app
- `manifest.webmanifest`, `icons/` – installeerbaarheid
- `sw.js` – service worker voor offline gebruik
