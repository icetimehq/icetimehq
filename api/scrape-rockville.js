// api/scrape-rockville.js
// Rockville Ice Arena — SportsEngine iCal feed scraper
// CommonJS (module.exports) — required for Vercel without "type":"module"
//
// Source: https://www.rockvilleicearena.com/event/ical_feed?tags=2944793,2944804
// Tags 2944793 + 2944804 = the "Public&Stick Time" calendar on their SE site.
// This is the same data IceFinder.com uses.
//
// iCal format is plain text — no cheerio needed, just string parsing.
// Each event is a VEVENT block:
//   BEGIN:VEVENT
//   DTSTART:20260406T120000
//   DTEND:20260406T140000
//   SUMMARY:Public Skating
//   END:VEVENT
//
// NOTE: If this ever gets blocked, the fallback is to find the iCal URL
// via DevTools on the schedule page and update ICAL_URL below.
//
// FUTURE: When scrape-ical.js is built to handle all SE1 rinks generically,
// this file can be retired and replaced with a config entry in rinks.json.

const ICAL_URL = 'https://www.rockvilleicearena.com/event/ical_feed?tags=2944793,2944804';

const HEADERS = {
  'User-Agent':  'Mozilla/5.0 (compatible; IceTimeHQ/1.0; +https://icetimehq.com)',
  'Accept':      'text/calendar, text/plain, */*',
};

// ── Cache (4-hour TTL) ────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Session classifier ────────────────────────────────────────────────────────
function classifyType(summary = '') {
  const s = summary.toLowerCase();
  if (/freestyle|freeskate|figure/.test(s))         return 'freestyle';
  if (/stick|shoot|puck/.test(s))                   return 'stick';
  if (/pickup|pick.?up|drop.?in/.test(s))           return 'pickup';
  if (/public|open skat|adult skat/.test(s))        return 'public';
  return null;
}

const EXCLUDE = /\bgame\b|league|learn.to.sk|lts|goalie.only|private|tournament|birthday|party|lesson|class|clinic|camp|practice|tryout|scrimmage/i;

// ── iCal parser ───────────────────────────────────────────────────────────────
// Handles line folding (RFC 5545 — continuation lines start with space/tab)
function unfold(ical) {
  return ical.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function parseIcal(ical, targetDate) {
  const text    = unfold(ical);
  const events  = text.split('BEGIN:VEVENT').slice(1);
  const sessions = [];

  for (const block of events) {
    const get = (key) => {
      // Match key (with optional params like DTSTART;TZID=...) followed by value
      const m = block.match(new RegExp(`^${key}(?:;[^:]+)?:(.+)$`, 'm'));
      return m ? m[1].trim() : null;
    };

    const summary  = get('SUMMARY') || '';
    const dtstart  = get('DTSTART') || '';
    const dtend    = get('DTEND')   || '';

    if (!dtstart || !summary) continue;

    // Parse date from DTSTART — formats: 20260406T120000 or 20260406T120000Z
    // or with TZID param: DTSTART;TZID=America/New_York:20260406T120000
    const dateMatch = dtstart.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
    if (!dateMatch) continue;

    const [, yyyy, mm, dd, hh, min] = dateMatch;
    const eventDate = `${yyyy}-${mm}-${dd}`;

    if (eventDate !== targetDate) continue;
    if (EXCLUDE.test(summary)) continue;

    const type = classifyType(summary);
    if (!type) continue;

    // Parse end time
    const endMatch = dtend.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
    const endHH  = endMatch ? endMatch[4] : hh;
    const endMin = endMatch ? endMatch[5] : min;

    // Return HH:MM format — matches what fmt12() in index.html expects
    const startTime = `${hh}:${min}`;
    const endTime   = `${endHH}:${endMin}`;

    // Price — $10 public, $18 stick (confirmed from page + IceFinder)
    const price = type === 'stick' ? 18 : type === 'public' ? 10 : null;

    sessions.push({
      name:            summary.trim(),
      type,
      start:           startTime,
      end:             endTime,
      price,
      openSlots:       null,
      status:          'available',
      surface:         'Ice',
      registrationUrl: 'https://www.rockvilleicearena.com/page/show/2944804-public-and-stick-time-ice-schedules',
    });
  }

  // Sort by start time
  sessions.sort((a, b) => a.start.localeCompare(b.start));
  return sessions;
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ sessions: [], error: 'date param required: YYYY-MM-DD' });
  }

  const cacheKey = `rockville:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ sessions: cached.data, source: 'cache' });
  }

  try {
    const res2 = await fetch(ICAL_URL, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res2.ok) {
      throw new Error(`iCal fetch failed: HTTP ${res2.status}`);
    }

    const ical     = await res2.text();
    const sessions = parseIcal(ical, date);

    console.log(`[scrape-rockville] ${date}: ${sessions.length} sessions`);
    cache.set(cacheKey, { ts: Date.now(), data: sessions });
    return res.status(200).json({ sessions, source: 'live' });

  } catch (err) {
    console.error('[scrape-rockville] error:', err.message);
    // Return empty — front-end shows "no sessions found" gracefully
    cache.set(cacheKey, { ts: Date.now(), data: [] });
    return res.status(200).json({ sessions: [], source: 'error', error: err.message });
  }
};
