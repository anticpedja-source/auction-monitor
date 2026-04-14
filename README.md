# Tesla Aukcija Monitor

Automatski prati aukcije na auksjonen.no i šalje Telegram obaveštenja.

## Šta radi
- Proverava aukcije 3x dnevno: 08:00, 14:00, 20:00 (Beograd)
- Obaveštava kad se pojavi novi oglas
- Obaveštava 2 sata pre isteka aukcije
- Čuva bazu oglasa u `auctions.json`

## Environment varijable
- FIRECRAWL_API_KEY
- TELEGRAM_TOKEN
- TELEGRAM_CHAT_ID
- DATA_DIR=/data (preporučeno za Railway)

## Pokretanje
npm install
node index.js
