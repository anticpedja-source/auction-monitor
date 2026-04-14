const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const config = require('./config');

const DB_FILE = path.join(__dirname, 'auctions.json');

// --- Database helpers ---
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// --- Telegram ---
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: config.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });
    console.log('Telegram poruka poslata.');
  } catch (err) {
    console.error('Greška pri slanju Telegram poruke:', err.message);
  }
}

// --- Firecrawl scrape ---
async function scrapeAuctions() {
  console.log(`[${new Date().toISOString()}] Čitam aukcije...`);
  try {
    const response = await axios.post(
      'https://api.firecrawl.dev/v1/scrape',
      {
        url: config.SEARCH_URL,
        formats: ['markdown'],
        onlyMainContent: true,
      },
      {
        headers: {
          Authorization: `Bearer ${config.FIRECRAWL_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const markdown = response.data?.data?.markdown || '';
    return parseAuctions(markdown);
  } catch (err) {
    console.error('Greška pri čitanju sajta:', err.message);
    return [];
  }
}

// --- Parse auctions from markdown ---
function parseAuctions(markdown) {
  const auctions = [];
  const lines = markdown.split('\n');

  let current = null;

  for (const line of lines) {
    // Detect auction title/link (markdown links like [Title](url))
    const linkMatch = line.match(/\[([^\]]+)\]\((https:\/\/www\.auksjonen\.no\/[^\)]+)\)/);
    if (linkMatch) {
      if (current) auctions.push(current);
      current = {
        id: linkMatch[2].split('/').pop().split('?')[0],
        title: linkMatch[1].trim(),
        url: linkMatch[2],
        endTime: null,
        currentBid: null,
        rawText: line,
      };
    }

    if (!current) continue;

    // Try to find end time (Norwegian: "Avsluttes", "Slutter", "Tid igjen")
    const timePatterns = [
      /avsluttes[:\s]+([^\n]+)/i,
      /slutter[:\s]+([^\n]+)/i,
      /tid igjen[:\s]+([^\n]+)/i,
      /(\d{1,2}\.\d{1,2}\.\d{4}[^\n]*\d{2}:\d{2})/,
    ];
    for (const pat of timePatterns) {
      const m = line.match(pat);
      if (m && !current.endTime) {
        current.endTime = m[1].trim();
      }
    }

    // Try to find current bid
    const bidMatch = line.match(/(\d[\d\s,.]+)\s*(kr|nok)/i);
    if (bidMatch && !current.currentBid) {
      current.currentBid = bidMatch[0].trim();
    }
  }

  if (current) auctions.push(current);

  console.log(`Pronađeno ${auctions.length} aukcija.`);
  return auctions;
}

// --- Parse Norwegian date strings to JS Date ---
function parseNorwegianDate(str) {
  if (!str) return null;
  // Format: "12.05.2025 14:30" or similar
  const m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})[^\d]*(\d{2}):(\d{2})/);
  if (m) {
    return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${m[4]}:${m[5]}:00`);
  }
  return null;
}

// --- Main check function ---
async function checkAuctions() {
  const db = loadDB();
  const auctions = await scrapeAuctions();

  if (auctions.length === 0) {
    console.log('Nema aukcija ili greška pri čitanju.');
    return;
  }

  const now = new Date();
  const newItems = [];
  const soonItems = [];

  for (const auction of auctions) {
    const isNew = !db[auction.id];

    // Save/update in DB
    db[auction.id] = {
      ...auction,
      firstSeen: db[auction.id]?.firstSeen || now.toISOString(),
      lastSeen: now.toISOString(),
      notifiedNew: db[auction.id]?.notifiedNew || false,
      notifiedSoon: db[auction.id]?.notifiedSoon || false,
    };

    // New auction notification
    if (isNew && !db[auction.id].notifiedNew) {
      newItems.push(auction);
      db[auction.id].notifiedNew = true;
    }

    // 2 hours before end notification
    const endDate = parseNorwegianDate(auction.endTime);
    if (endDate) {
      const hoursLeft = (endDate - now) / (1000 * 60 * 60);
      if (hoursLeft > 0 && hoursLeft <= config.NOTIFY_HOURS_BEFORE && !db[auction.id].notifiedSoon) {
        soonItems.push({ ...auction, hoursLeft: hoursLeft.toFixed(1) });
        db[auction.id].notifiedSoon = true;
      }
    }
  }

  saveDB(db);

  // Send summary
  const totalActive = auctions.length;
  let summaryMsg = `🔍 <b>Pregled aukcija</b> — ${new Date().toLocaleString('sr-Latn')}\n`;
  summaryMsg += `Ukupno aktivnih: <b>${totalActive}</b>\n`;

  if (newItems.length > 0) {
    summaryMsg += `\n🆕 <b>Novi oglasi (${newItems.length}):</b>\n`;
    for (const a of newItems) {
      summaryMsg += `• <a href="${a.url}">${a.title}</a>`;
      if (a.currentBid) summaryMsg += ` — ${a.currentBid}`;
      if (a.endTime) summaryMsg += `\n  ⏰ Ističe: ${a.endTime}`;
      summaryMsg += '\n';
    }
  }

  if (soonItems.length > 0) {
    summaryMsg += `\n⚠️ <b>Uskoro ističu:</b>\n`;
    for (const a of soonItems) {
      summaryMsg += `• <a href="${a.url}">${a.title}</a>`;
      if (a.currentBid) summaryMsg += ` — ${a.currentBid}`;
      summaryMsg += `\n  ⏰ Još ~${a.hoursLeft}h (${a.endTime})\n`;
    }
  }

  if (newItems.length === 0 && soonItems.length === 0) {
    summaryMsg += `\nNema novih oglasa ni skorih isteka.`;
  }

  await sendTelegram(summaryMsg);
}

// --- Scheduler ---
console.log('Tesla aukcija monitor pokrenut.');
console.log(`Pretraga: ${config.SEARCH_URL}`);
console.log('Raspored: 08:00, 14:00, 20:00 (po Beogradu)');

// Run at 08:00, 14:00, 20:00 Belgrade time (UTC+1/+2)
cron.schedule('0 7,13,19 * * *', checkAuctions, { timezone: 'Europe/Belgrade' });

// Also run immediately on startup
checkAuctions();
