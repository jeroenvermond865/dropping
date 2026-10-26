# Dropping familieweekend

Mobiele webapp voor een dropping/speurtocht: teams krijgen steeds één nieuw punt, lopen er met gps heen, checken in, beantwoorden een vraag of doen een opdracht en krijgen dan het volgende punt. Met live scorebord en een beheerscherm om samen de route op de kaart te zetten.

## Pagina's

- `/` inloggen per team (teamnaam + pincode), met 3D-achtergrond
- `/spel` kaart, kompaspijl, afstand, inchecken, vragen, letters voor het codewoord, mist-jokers
- `/scorebord` live podium en tabel (punten, opgelost, eerste bij punt, snelste antwoord)
- `/beheer` punten op de kaart klikken en slepen, volgorde, vragen, teams, verboden zones (bos, vorm aanpasbaar), looproutes, verborgen schatten, foto's beoordelen, live volgen
- `/tv` groot scherm met gekantelde live kaart, stand, nieuws, foto's en een replay van alle routes (beheerpincode nodig)
- `/album` goedgekeurde foto's

## Lokaal draaien

```
npm install
npm start
```

Open http://localhost:3000. Zonder database wordt alles opgeslagen in `data/state.json`.

## Omgevingsvariabelen

| Naam | Betekenis |
|---|---|
| `ADMIN_PIN` | pincode voor het beheerscherm (standaard `beheer`, zet zelf een eigen code!) |
| `DATABASE_URL` | Postgres-verbinding (Render). Zonder deze variabele wordt een bestand gebruikt |
| `PORT` | poort, Render zet deze zelf |

## Spelregels en punten

- Als eerste bij een punt: 50 pt, als tweede 30, daarna 20. Wie als eerste aankomt krijgt een mist-joker (alleen met meer teams).
- Goed antwoord: de punten van het punt, min 25 per extra poging en min de hintkosten. Na 3 foute pogingen door naar het volgende punt.
- Snelste goede antwoord op een punt: +25. Finish: 100 / 60 / 30 pt.
- Verborgen schat: zichtbaar binnen 100 m, oppakken binnen 25 m. Eerste vinder krijgt alle punten, de rest de helft.
- Foto-opdracht: het team kan meteen door, de punten komen na goedkeuring in het beheer.
- Testmodus (in instellingen): inchecken kan overal. Zet dit uit voor het echte spel.
