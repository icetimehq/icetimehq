// api/scrape-frontline.js
// Frontline Solutions scraper — config-driven, covers all FL1 rinks.
// Frontline Connect is a ColdFusion-based scheduling system used by several
// DCR and private rinks. The schedule page is HTML-rendered (no JSON API).
//
// ADDING A NEW FL1 RINK:
//   Add one entry to RINKS below with the correct fac and facid values.
//   Deploy — no other code changes needed.
//
// ─────────────────────────────────────────────────────────────────────────────

const path    = require('path');
const cheerio = require('cheerio');

// ── In-memory cache (4-hour TTL) ─────────────────────────────────────────────
const cache   = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Config ────────────────────────────────────────────────────────────────────
const RINKS = {
  flynn: {
    name:     'Flynn Rink',
    rink_id:  'ma_flynn',
    region:   'Boston',
    fac:      'flynn',
    facid:    null,
    website:  'https://www.frontline-connect.com/scheduleselect.cfm?fac=flynn',
    surface:  'Ice',
    timezone: 'America/New_York',
    // Seasonal Oct–April — returns [] outside season
    season_start: { month: 10, day: 1 },
    season_end:   { month: 4,  day: 30 },
  },
  pwice: {
    name:     'Prince William Ice Center',
    rink_id:  'dc_princeWilliam',
    region:   'DC Metro',
    fac:      'pwice',
    facid:    '1',
    website:  'https://www.frontline-connect.com/scheduleselect.cfm?fac=pwice&facid=1',
    surface:  'Ice',
    timezone: 'America/New_York',
  },
};

// ── Session type classifier ───────────────────────────────────────────────────
function classifyType(name = '') {
  const n = name.toLowerCase();
  if (/freestyle|freeskate|figure/.test(n))  return 'freestyle';
  if (/stick|shoot|puck/.test(n))            return 'stick';
  if (/pickup|pick.?up|drop.?in/.test(n))    return 'pickup';
  if (/public|open skat|adult skat/.test(n)) return 'public';
  return null;
}

const EXCLUDE = /\bgame\b|league|learn.to.sk|lts|goalie.only|private|tournament|birthday|party|lesson|class|clinic|camp|practice|tryout|scrimmage/i;

// ── Time helpers ──────────────────────────────────────────────────────────────
function to24h(h, m, period) {
  let hr  = parseInt(h, 10);
  const min = String(m || '00').padStart(2, '0');
  if (period.toUpperCase() === 'PM' && hr !== 12) hr += 12;
  if (period.toUpperCase() === 'AM' && hr === 12)  hr = 0;
  return `${String(hr).padStart(2, '0')}:${min}`;
}

function parseTimeRange(text) {
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  return {
    start: to24h(m[1], m[2], m[3]),
    end:   to24h(m[4], m[5], m[6]),
  };
}

// ── Fetch and parse Frontline schedule page ───────────────────────────────────
async function fetchFrontline(rink, date) {
  const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

  // Check season
  if (rink.season_start && rink.season_end) {
    const [, mm, dd] = date.split('-').map(Number);
    const { season_start: ss, season_end: se } = rink;
    const inSeason = (mm > ss.month || (mm === ss.month && dd >= ss.day)) &&
                     (mm < se.month  || (mm === se.month  && dd <= se.day));
    if (!inSeason) return [];
  }

  // Frontline scheduleselect.cfm returns a month calendar HTML page.
  // We then need to look at the specific date's sessions.
  const [yyyy, mm] = date.split('-');
  const params = `fac=${rink.fac}${rink.facid ? `&facid=${rink.facid}` : ''}&month=${parseInt(mm, 10)}&year=${yyyy}`;
  const url = `https://www.frontline-connect.com/scheduleselect.cfm?${params}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; IceTimeHQ/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Referer': rink.website,
    },
    timeout: 12000,
  });

  if (!res.ok) throw new Error(`Frontline fetch failed: ${res.status} for ${url}`);

  const html  = await res.text();
  const $     = cheerio.load(html);
  const sessions = [];

  // Frontline renders days as table cells or div blocks containing date number
  // and session links below. We look for the cell matching our target day.
  const targetDay = parseInt(date.split('-')[2], 10);

  // Strategy 1: Find table cells containing the target day number
  // Frontline typically uses <td> with class "day" containing date + events
  $('td.day, td.calday, div.day').each((_, el) => {
    const dayText = $(el).find('.daynum, .daynumber, b, strong').first().text().trim();
    if (parseInt(dayText, 10) !== targetDay) return;

    // Found the cell — extract sessions from links/text within
    $(el).find('a, .session, .event, p').each((_, item) => {
      const text = $(item).text().trim();
      if (!text || EXCLUDE.test(text)) return;
      const type = classifyType(text);
      if (!type) return;
      const times = parseTimeRange(text);
      if (!times) return;

      sessions.push({
        name:            text.replace(/\d{1,2}(?::\d{2})?\s*(?:am|pm).*$/i, '').trim() || 'Public Skate',
        type,
        start:           `${date}T${times.start}:00`,
        end:             `${date}T${times.end}:00`,
        price:           null,
        openSlots:       null,
        status:          'available',
        surface:         rink.surface,
        registrationUrl: rink.website,
      });
    });
  });

  // Strategy 2: Text scan for the date + time patterns
  // Frontline sometimes uses a list format with "MM/DD - Session Name - Time"
  if (sessions.length === 0) {
    const [, m2, d2] = date.split('-');
    const dateShort = `${parseInt(m2, 10)}/${parseInt(d2, 10)}`; // e.g. "4/8"

    const fullText = $('body').text();
    const lines = fullText.split(/\n|\r/).map(l => l.trim()).filter(Boolean);

    let inTargetDay = false;
    for (const line of lines) {
      if (line.includes(dateShort) || line.includes(date)) inTargetDay = true;
      if (!inTargetDay) continue;

      // Stop if we hit the next date
      if (inTargetDay && line.match(/^\d{1,2}\/\d{1,2}/) && !line.includes(dateShort)) break;

      if (EXCLUDE.test(line)) continue;
      const type = classifyType(line);
      if (!type) continue;
      const times = parseTimeRange(line);
      if (!times) continue;

      sessions.push({
        name:            line.replace(/\d{1,2}(?::\d{2})?\s*(?:am|pm).*$/i, '').trim() || 'Public Skate',
        type,
        start:           `${date}T${times.start}:00`,
        end:             `${date}T${times.end}:00`,
        price:           null,
        openSlots:       null,
        status:          'available',
        surface:         rink.surface,
        registrationUrl: rink.website,
      });
    }
  }

  return sessions;
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { rink: rinkKey, date } = req.query;

  if (!rinkKey || !RINKS[rinkKey]) {
    return res.status(400).json({
      error: `rink param required. Valid: ${Object.keys(RINKS).join(', ')}`,
    });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date param required: YYYY-MM-DD' });
  }

  const cacheKey = `frontline:${rinkKey}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  const rink = RINKS[rinkKey];

  try {
    const sessions = await fetchFrontline(rink, date);
    sessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    const response = { sessions, source: 'live', date, rink: rink.name };
    cache.set(cacheKey, { ts: Date.now(), data: response });
    return res.status(200).json(response);

  } catch (err) {
    console.error(`scrape-frontline [${rinkKey}] error:`, err.message);
    // Return empty rather than 500 so the site shows "no sessions" gracefully
    const response = { sessions: [], source: 'error', date, error: err.message };
    cache.set(cacheKey, { ts: Date.now(), data: response });
    return res.status(200).json(response);
  }
};
