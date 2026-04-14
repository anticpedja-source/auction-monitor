const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const config = require('./config');

const DB_FILE = path.join(config.DATA_DIR, 'auctions.json');
const SITE_ORIGIN = 'https://www.auksjonen.no';
const MAX_AUCTIONS_PER_MESSAGE = 6;
const MAX_SEARCH_PAGES = 5;

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

async function scrapePage(url) {
  try {
    const res = await axios.post(
      'https://api.firecrawl.dev/v1/scrape',
      {
        url,
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

    const md = res.data?.data?.markdown || '';
    console.log(`Scrape OK: ${url} | dužina markdown-a: ${md.length}`);
    return md;
  } catch (e) {
    console.error(`Firecrawl greška za ${url}:`, e.response?.data || e.message);
    return '';
  }
}

function normalizeUrl(url) {
  if (!url) return null;

  const trimmed = url.trim();

  if (trimmed.startsWith('http://')) return null;
  if (trimmed.startsWith(SITE_ORIGIN)) return trimmed;
  if (trimmed.startsWith('/')) return `${SITE_ORIGIN}${trimmed}`;

  return null;
}

function normalizeAuctionUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  if (!normalized.includes('/auksjon/')) return null;
  if (normalized.includes('/api/')) return null;
  if (normalized.includes('/registrer')) return null;
  return normalized;
}

function normalizeSearchUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  if (!normalized.includes('/auksjoner/alle')) return null;
  return normalized;
}

function parseAuctions(md) {
  const lines = md.split('\n');
  const items = [];
  let cur = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const match = line.match(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      const title = match[1].trim();
      const auctionUrl = normalizeAuctionUrl(match[2]);

      if (auctionUrl) {
        if (cur) items.push(cur);

        cur = {
          id: auctionUrl.split('/').pop().split('?')[0],
          title,
          url: auctionUrl,
          endTime: null,
          currentBid: null
        };

        continue;
      }
    }

    if (!cur) continue;

    const timePatterns = [
      /avsluttes[:\s]+([^\n]+)/i,
      /slutter[:\s]+([^\n]+)/i,
      /tid igjen[:\s]+([^\n]+)/i,
      /(\d{1,2}\.\d{1,2}\.\d{4}[^\n]*\d{2}:\d{2})/
    ];

    for (const pat of timePatterns) {
      const tm = line.match(pat);
      if (tm && !cur.endTime) {
        cur.endTime = tm[1].trim();
      }
    }

    const bidMatch = line.match(/(\d[\d\s,.]+)\s*(kr|nok)/i);
    if (bidMatch && !cur.currentBid) {
      cur.currentBid = bidMatch[0].trim();
    }
  }

  if (cur) items.push(cur);

  const deduped = [];
  const seen = new Set();

  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  return deduped;
}

function extractSearchPages(md) {
  const pages = [];
  const seen = new Set();

  const regex = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  let match;

  while ((match = regex.exec(md)) !== null) {
    const url = normalizeSearchUrl(match[1]);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push(url);
  }

  return pages;
}

async function scrapeAllSearchPages() {
  const queue = [config.SEARCH_URL];
  const visited = new Set();
  const allItems = [];
  const seenAuctionIds = new Set();

  while (queue.length > 0 && visited.size < MAX_SEARCH_PAGES) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;

    visited.add(url);
    console.log(`Obrada search stranice ${visited.size}/${MAX_SEARCH_PAGES}: ${url}`);

    const md = await scrapePage(url);
    if (!md) continue;

    const items = parseAuctions(md);
    console.log(`Na stranici pronađeno oglasa: ${items.length}`);

    for (const item of items) {
      if (!item.id || seenAuctionIds.has(item.id)) continue;
      seenAuctionIds.add(item.id);
      allItems.push(item);
    }

    const searchPages = extractSearchPages(md);
    for (const page of searchPages) {
      if (!visited.has(page) && !queue.includes(page) && queue.length + visited.size < MAX_SEARCH_PAGES) {
        queue.push(page);
      }
    }
  }

  console.log(`Ukupno jedinstvenih oglasa: ${allItems.length}`);
  return allItems;
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
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function buildSectionMessages(title, items) {
  if (!items.length) return [];

  const chunks = chunkArray(items, MAX_AUCTIONS_PER_MESSAGE);

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

function todayKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

async function run() {
  const db = loadDB();
  const now = new Date();
  const today = todayKey(now);

  const items = await scrapeAllSearchPages();

  if (!items.length) {
    console.log('Nema pronađenih oglasa.');
    return;
  }

  const newItems = [];
  const endingToday = [];

  for (const item of items) {
    const existing = db[item.id];

    db[item.id] = {
      ...existing,
      ...item,
      firstSeen: existing?.firstSeen || now.toISOString(),
      lastSeen: now.toISOString(),
      notifiedNew: existing?.notifiedNew || false,
      notifiedEndingTodayOn: existing?.notifiedEndingTodayOn || null
    };

    if (!existing || !existing.notifiedNew) {
      newItems.push(db[item.id]);
      db[item.id].notifiedNew = true;
    }

    const endDate = parseNorwegianDate(db[item.id].endTime);
    if (
      endDate &&
      isSameLocalDay(endDate, now) &&
      db[item.id].notifiedEndingTodayOn !== today
    ) {
      endingToday.push(db[item.id]);
      db[item.id].notifiedEndingTodayOn = today;
    }
  }

  saveDB(db);

  const messages = [
    ...buildSectionMessages('Novi oglasi', newItems),
    ...buildSectionMessages('Ističu danas', endingToday)
  ];

  if (!messages.length) {
    console.log('Nema novih oglasa niti novih unosa za "Ističu danas".');
    return;
  }

  for (const message of messages) {
    await sendTelegram(message);
  }
}

ensureDir();

cron.schedule('0 8,14,20 * * *', run, {
  timezone: 'Europe/Belgrade'
});

run();
