const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const config = require('./config');

const DB_FILE = path.join(config.DATA_DIR, 'auctions.json');

function ensureDir() {
  if (!fs.existsSync(config.DATA_DIR)) {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
  }
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '{}');
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: config.TELEGRAM_CHAT_ID,
      text
    });
  } catch (e) {
    console.error(e.response?.data || e.message);
  }
}

async function scrape() {
  const res = await axios.post('https://api.firecrawl.dev/v1/scrape', {
    url: config.SEARCH_URL,
    formats: ['markdown']
  }, {
    headers: { Authorization: `Bearer ${config.FIRECRAWL_API_KEY}` }
  });

  return res.data?.data?.markdown || '';
}

function parse(md) {
  const lines = md.split('\n');
  const items = [];
  let cur = null;

  for (const l of lines) {
    const m = l.match(/\[([^\]]+)\]\((https:\/\/www\.auksjonen\.no\/[^\)]+)\)/);
    if (m) {
      if (cur) items.push(cur);
      cur = { id: m[2].split('/').pop(), title: m[1], url: m[2] };
    }
  }
  if (cur) items.push(cur);
  return items;
}

async function run() {
  const db = loadDB();
  const had = Object.keys(db).length > 0;

  const md = await scrape();
  const items = parse(md);

  for (const i of items) {
    db[i.id] = i;
  }

  saveDB(db);

  if (!had) return;

  let msg = "Novi oglasi:\n";
  items.slice(0, 5).forEach(i => {
    msg += `${i.title}\n${i.url}\n\n`;
  });

  await sendTelegram(msg);
}

ensureDir();

cron.schedule('0 8,14,20 * * *', run, { timezone: 'Europe/Belgrade' });

run();
