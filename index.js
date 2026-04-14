const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const config = require('./config');

const DB_FILE = path.join(config.DATA_DIR, 'auctions.json');
const SITE_ORIGIN = 'https://www.auksjonen.no';
const MAX_AUCTIONS_PER_MESSAGE = 6;

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

function normalizeAuctionUrl(url) {
  if (!url) return null;

  const trimmed = url.trim();

  if (trimmed.startsWith('/auksjon/')) {
    return `${SITE_ORIGIN}${trimmed}`;
  }

  if (trimmed.startsWith(`${SITE_ORIGIN}/auksjon/`)) {
    return trimmed;
  }

  return null;
}

function parseRemainingText(block) {
  const m = block.match(/((?:\d+\s*d\s*)?(?:\d+\s*t\s*)?(?:\d+\s*min\s*)?(?:\d+\s*sek\s*)?)\s*Gjenstår/i);
  if (!m) return null;

  return m[1]
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRemainingToDate(remainingText, now = new Date()) {
  if (!remainingText) return null;

  const days = Number((remainingText.match(/(\d+)\s*d/i) || [])[1] || 0);
  const hours = Number((remainingText.match(/(\d+)\s*t/i) || [])[1] || 0);
  const mins = Number((remainingText.match(/(\d+)\s*min/i) || [])[1] || 0);
  const secs = Number((remainingText.match(/(\d+)\s*sek/i) || [])[1] || 0);

  const endDate = new Date(now.getTime());
  endDate.setDate(endDate.getDate() + days);
  endDate.setHours(endDate.getHours() + hours);
  endDate.setMinutes(endDate.getMinutes() + mins);
  endDate.setSeconds(endDate.getSeconds() + secs);

  return endDate;
}

function formatDateTime(date) {
  if (!date) return 'N/A';

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');

  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

function extractPrice(block) {
  if (/Ingen bud/i.test(block)) {
    return 'Ingen bud';
  }

  const priceMatches = [...block.matchAll(/(\d[\d\s.]*)\s*,-\s*(?:Høyeste bud|Bud)/gi)];
  if (!priceMatches.length) return null;

  const raw = priceMatches[0][1]
    .replace(/\s+/g, ' ')
    .trim();

  return `${raw},-`;
}

function parseAuctions(md) {
  const normalized = md.replace(/\r/g, '');

  const blockRegex = /-\s*\[\!\[[\s\S]*?\]\((https:\/\/www\.auksjonen\.no\/auksjon\/[^\)]+)\)/g;
  const blocks = [...normalized.matchAll(blockRegex)];

  const items = [];
  const seen = new Set();

  for (const match of blocks) {
    const block = match[0];
    const rawUrl = match[1];
    const url = normalizeAuctionUrl(rawUrl);

    if (!url) continue;

    const id = url.split('/').pop().split('?')[0];
    if (!id || seen.has(id)) continue;

    const titleMatch = block.match(/\*\*([^*]+)\*\*/);
    const title = titleMatch ? titleMatch[1].replace(/\\\|/g, '|').trim() : null;

    const remainingText = parseRemainingText(block);
    const endDate = parseRemainingToDate(remainingText);
    const endTime = endDate ? formatDateTime(endDate) : null;
    const currentBid = extractPrice(block);

    items.push({
      id,
      title: title || `Tesla oglas ${id}`,
      url,
      endTime,
      currentBid: currentBid || 'N/A'
    });

    seen.add(id);
  }

  console.log(`Pronađeno ${items.length} oglasa.`);
  return items;
}

function parseLocalDateTime(str) {
  if (!str) return null;

  const m = str.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;

  return new Date(
    Number(m[3]),
    Number(m[2]) - 1,
    Number(m[1]),
    Number(m[4]),
    Number(m[5]),
    0
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

  const md = await scrapePage(config.SEARCH_URL);
  if (!md) {
    console.log('Nema markdown sadržaja.');
    return;
  }

  const items = parseAuctions(md);
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

    const endDate = parseLocalDateTime(db[item.id].endTime);
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
