# Tesla Aukcija Monitor

Automatski prati aukcije na auksjonen.no i šalje Telegram obaveštenja.

## Šta radi
- Proverava aukcije 3x dnevno: 08:00, 14:00, 20:00 (Beograd)
- Obaveštava kad se pojavi novi oglas
- Obaveštava 2 sata pre isteka aukcije
- Čuva bazu oglasa u `auctions.json`

## Podešavanja
Sve se menja u fajlu `config.js`:
- `SEARCH_URL` — kriterijumi pretrage (model, marka...)
- `NOTIFY_HOURS_BEFORE` — koliko sati pre isteka da pošalje upozorenje

## Pokretanje lokalno
```bash
npm install
node index.js
```

## Railway deployment
Projekat se automatski pokreće na Railway platformi.
Environment varijable se podešavaju u Railway dashboard-u:
- `FIRECRAWL_API_KEY`
- `TELEGRAM_TOKEN`
- `TELEGRAM_CHAT_ID`
