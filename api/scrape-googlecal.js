// api/scrape-googlecal.js
// Google Calendar public feed scraper — config-driven (Type A)
// Covers: Ice Realm Carlsbad (icerealmcarlsbad.com)
// CommonJS (module.exports) — required for Vercel without "type":"module"
//
// Ice Realm Carlsbad publishes their open skate schedule to a public Google Calendar.
// Google Calendar public JSON API requires no auth key for public calendars
// when using the embed key Google exposes for calendar widgets.
// calendarId confirmed from the schedule page source.

const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

// ── Config ───────────────────────────────────────────────────────────────────
const RINKS = {
  carlsbad: {
    name:       'Ice Realm Carlsbad',
    calendarId: '07f8ijpg2mj92i9ka8dnlooctu5rqo3f@import.calendar.google.com',
    surface:    'Ice',
    timezone:   'America/Los_Angeles',
    ticketUrl:  'https://bondsports.co/activity/programs/CO_ED-adult-ICE_SKATING/11241',
  },
};

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Classify ──────────────────────────────────────────────────────────────────
function classifyType(title = '') {
  const t = title.toLowerCase();
  if (/freestyle|freeskate|figure/.test(t))          return 'freestyle';
  if (/stick|shoot|puck/.test(t))                    return 'stick';
  if (/pickup|pick.?up|drop.?in/.test(t))            return 'pickup';
  if (/public|open skat|adult skat|open skate/.test(t)) return 'public';
  return null;
}

const EXCLUDE = /game|learn.to.sk|lts|duck shinny|goalie|clinic|private|tournament|birthday|lesson|class|hockey/i;

// ── Google Calendar fetch ─────────────────────────────────────────────────────
// Uses Google's public embed key (read-only, public calendars only).
const GCAL_KEY = 'AIzaSyBNlYH01_9Hc5S1J9vuFmu2nUqBZJNAXKs';

async function fetchGCalEvents(calendarId, date) {
  const dayStart = `${date}T00:00:00-07:00`;
  const dayEnd   = `${date}T23:59:59-07:00`;
  const calEnc   = encodeURIComponent(calendarId);

  const url = `https://www.googleapis.com/calendar/v3/calendars/${calEnc}/events` +
    `?singleEvents=true&orderBy=startTime` +
    `&timeMin=${encodeURIComponent(dayStart)}` +
    `&timeMax=${encodeURIComponent(dayEnd)}` +
    `&key=${GCAL_KEY}`;

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Google Calendar API error: ${res.status}`);

  const data = await res.json();
  return data.items || [];
}

// ── Normalize ─────────────────────────────────────────────────────────────────
function normalize(event, rink) {
  const title = event.summary || '';
  if (EXCLUDE.test(title)) return null;

  const type = classifyType(title);
  if (!type) return null;

  const start = event.start?.dateTime || null;
  const end   = event.end?.dateTime   || null;

  // Skip all-day events (closures, special events — no time)
  if (!start || !end) return null;

  // Strip timezone offset, keep HH:MM for frontend
  const fmtTime = iso => {
    const m = iso.match(/T(\d{2}:\d{2})/);
    return m ? m[1] : null;
  };

  const startTime = fmtTime(start);
  const endTime   = fmtTime(end);
  if (!startTime || !endTime) return null;

  const desc = (event.description || '').toLowerCase();
  const priceMatch = desc.match(/\$(\d+(?:\.\d{2})?)/);
  const price = priceMatch ? parseFloat(priceMatch[1]) : null;

  return {
    name:            title.trim(),
    type,
    label:           title.trim(),
    start:           startTime,
    end:             endTime,
    price,
    openSlots:       null,
    status:          'available',
    surface:         rink.surface,
    registrationUrl: rink.ticketUrl,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { rink: rinkKey, date } = req.query;

  if (!rinkKey || !RINKS[rinkKey]) {
    return res.status(400).json({ sessions: [], error: `rink param required. Valid: ${Object.keys(RINKS).join(', ')}` });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ sessions: [], error: 'date param required: YYYY-MM-DD' });
  }

  const cacheKey = `gcal:${rinkKey}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ sessions: cached.data, source: 'cache' });
  }

  const rink = RINKS[rinkKey];

  try {
    const events = await fetchGCalEvents(rink.calendarId, date);
    const sessions = events
      .map(e => normalize(e, rink))
      .filter(Boolean)
      .sort((a, b) => a.start.localeCompare(b.start));

    cache.set(cacheKey, { ts: Date.now(), data: sessions });
    return res.status(200).json({ sessions, source: 'live' });

  } catch (err) {
    console.error('[scrape-googlecal] error:', err.message);
    return res.status(200).json({ sessions: [], error: err.message });
  }
};
