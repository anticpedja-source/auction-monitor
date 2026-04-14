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
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '{}');
  } catch (e) {
    console.error('Greška pri učitavanju baze:', e.message);
    return {};
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: config.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false
    });
    console.log('Telegram poruka poslata.');
  } catch (e) {
    console.error('Telegram greška:', e.response?.data || e.message);
  }
}

async function scrape() {
  try {
    const res = await axios.post(
      'https://api.firecrawl.dev/v1/scrape',
      {
        url: config.SEARCH_URL,
        formats: ['markdown'],
        onlyMainContent: true
      },
      {
        headers: {
          Authorization: `Bearer ${config.FIRECRAWL_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.data?.data?.markdown || '';
  } catch (e) {
    console.error('Firecrawl greška:', e.response?.data || e.message);
    return '';
  }
}

function parse(md) {
  const lines = md.split('\n');
  const items = [];
  let cur = null;

  for (const rawLine of lines) {
    const l = rawLine.trim();

    // Hvata samo obične markdown linkove ka pojedinačnim oglasima, ne slike i ne ostale linkove
    const m = l.match(/(?<!!)\[([^\]]+)\]\((https:\/\/www\.auksjonen\.no\/auksjon\/[^\)]+)\)/);

    if (m) {
      if (cur) items.push(cur);

      const url = m[2];
      cur = {
        id: url.split('/').pop().split('?')[0],
        title: m[1].trim(),
        url,
        endTime: null,
        currentBid: null
      };

      continue;
    }

    if (!cur) continue;

    // vreme isteka
    const timePatterns = [
      /avsluttes[:\s]+([^\n]+)/i,
      /slutter[:\s]+([^\n]+)/i,
      /tid igjen[:\s]+([^\n]+)/i,
      /(\d{1,2}\.\d{1,2}\.\d{4}[^\n]*\d{2}:\d{2})/
    ];

    for (const pat of timePatterns) {
      const tm = l.match(pat);
      if (tm && !cur.endTime) {
        cur.endTime = tm[1].trim();
      }
    }

    // trenutna cena
    const bidMatch = l.match(/(\d[\d\s,.]+)\s*(kr|nok)/i);
    if (bidMatch && !cur.currentBid) {
      cur.currentBid = bidMatch[0].trim();
    }
  }

  if (cur) items.push(cur);

  console.log(`Pronađeno ${items.length} oglasa.`);
  return items;
}

function parseNorwegianDate(str) {
  if (!str) return null;

  const m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})[^\d]*(\d{2}):(\d{2})/);
  if (!m) return null;

  return new Date(
    `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4]}:${m[5]}:00`
  );
}

function isSameLocalDay(dateA, dateB) {
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

function formatAuctionBlock(item) {
  return [
    item.title || '-',
    `Ističe: ${item.endTime || 'N/A'}`,
    `Cena: ${item.currentBid || 'N/A'}`,
    item.url || '-'
  ].join('\n');
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function buildSectionMessages(title, items) {
  if (!items.length) return [];

  const chunks = chunkArray(items, 6);

  return chunks.map((chunk, index) => {
    let msg = title;
    if (chunks.length > 1) {
      msg += ` (${index + 1}/${chunks.length})`;
    }
    msg += '\n\n';

    msg += chunk.map(formatAuctionBlock).join('\n\n');
    return msg;
  });
}

async function run() {
  const db = loadDB();
  const md = await scrape();

  if (!md) {
    console.log('Nema markdown sadržaja.');
    return;
  }

  const items = parse(md);
  if (!items.length) {
    console.log('Nema pronađenih oglasa.');
    return;
  }

  const now = new Date();
  const newItems = [];
  const endingToday = [];

  for (const item of items) {
    const existing = db[item.id];

    db[item.id] = {
      ...existing,
      ...item,
      firstSeen: existing?.firstSeen || now.toISOString(),
      lastSeen: now.toISOString(),
      notifiedNew: existing?.notifiedNew || false
    };

    if (!existing || !existing.notifiedNew) {
      newItems.push(db[item.id]);
      db[item.id].notifiedNew = true;
    }

    const endDate = parseNorwegianDate(db[item.id].endTime);
    if (endDate && isSameLocalDay(endDate, now)) {
      endingToday.push(db[item.id]);
    }
  }

  saveDB(db);

  const messages = [
    ...buildSectionMessages('Novi oglasi', newItems),
    ...buildSectionMessages('Ističu danas', endingToday)
  ];

  if (!messages.length) {
    console.log('Nema novih oglasa niti oglasa koji ističu danas.');
    return;
  }

  for (const message of messages) {
    await sendTelegram(message);
  }
}

ensureDir();

cron.schedule('0 8,14,20 * * *', run, { timezone: 'Europe/Belgrade' });

run();
