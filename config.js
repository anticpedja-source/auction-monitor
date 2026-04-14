module.exports = {

  // --- Pretraga ---
  // Promeni q= parametar za drugi model ili marku
  // Primeri:
  //   Tesla Model 3: 'https://www.auksjonen.no/auksjoner/alle?q=Tesla+Model+3'
  //   BMW:           'https://www.auksjonen.no/auksjoner/alle?q=BMW'
  SEARCH_URL: 'https://www.auksjonen.no/auksjoner/alle?q=Tesla',

  // --- Firecrawl API ključ ---
  // Dobijen na firecrawl.dev/dashboard
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,

  // --- Telegram ---
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // --- Obaveštenja ---
  // Koliko sati pre isteka aukcije da pošalje upozorenje
  NOTIFY_HOURS_BEFORE: 2,

  // --- Raspored (samo informativno, menja se u index.js) ---
  // Trenutno: 08:00, 14:00, 20:00 po beogradskom vremenu

};
