module.exports = {
  SEARCH_URL: 'https://www.auksjonen.no/auksjoner/alle?q=Tesla',
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  NOTIFY_HOURS_BEFORE: 2,
  DATA_DIR: process.env.DATA_DIR || __dirname,
};
