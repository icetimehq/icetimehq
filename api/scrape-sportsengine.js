// api/scrape-sportsengine.js
// SportsEngine calendar scraper — config-driven, covers all SE1 rinks
// ─────────────────────────────────────────────────────────────────────────────
// SportsEngine does NOT expose a public JSON API without auth.
// We fetch the rink's SportsEngine calendar HTML page and parse it with Cheerio.
//
// SportsEngine calendar pages render events in one of two ways:
//   1. Full HTML calendar (older SE sites) — parse <table> or <ul> event lists
//   2. JS-rendered (newer SE HQ) — initial HTML contains JSON in <script> tags
//
// Both approaches are handled below. The scraper tries the JSON-in-script
// approach first (faster, more reliable), then falls back to HTML parsing.
//
// ADDING A NEW SE1 RINK:
//   1. Find the rink's SportsEngine calendar URL
//   2. Add one entry to the RINKS object below
//   3. Deploy — no other code changes needed
// ─────────────────────────────────────────────────────────────────────────────

const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const cheerio = await import('cheerio').then(m => m.default ?? m);

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Session type classification ───────────────────────────────────────────────
function classifyType(name = '') {
  const n = name.toLowerCase();
  if (/freestyle|freeskate|figure/.test(n))    return 'freestyle';
  if (/stick|shoot|puck/.test(n))              return 'stick';
  if (/pickup|pick.?up|drop.?in/.test(n))      return 'pickup';
  if (/public|open skat|adult skat/.test(n))   return 'public';
  return null;
}

const EXCLUDE = /game|\bleague\b|learn.to.sk|lts|duck shinny|goalie.only|private|tournament|birthday|party|lesson|class|clinic|camp|practice|tryout|scrimmage/i;

// ── Config ────────────────────────────────────────────────────────────────────
const RINKS = {

  haymarket: {
    name:    'Haymarket Iceplex',
    // Main calendar URL — SportsEngine site
    calendarUrl: 'https://www.haymarketiceplex.com/calendar',
    // Public skate specific page (more targeted)
    publicSkateUrl: 'https://www.haymarketiceplex.com/page/show/8615506-public-skate-schedule',
    website: 'https://www.haymarketiceplex.com',
    surface: 'Ice',
    timezone: 'America/New_York',
    price:    10.00,
    // Note: Haymarket was migrating to DaySmart as of June 2025.
    // If this scraper returns 0 results, check whether company=haymarket
    // exists in DaySmart and switch this rink to DS1.
    daysmartFallback: 'haymarket', // try this if SE calendar fails
  },

  princeWilliam: {
    name:    'Prince William Ice Center',
    calendarUrl: 'https://www.innovativesportsva.com/page/show/357110-schedule',
    publicSkateUrl: 'https://www.innovativesportsva.com/page/show/357110-schedule',
    website: 'https://www.innovativesportsva.com',
    surface: 'Ice',
    timezone: 'America/New_York',
    price:    null,
  },

  rockville: {
    name:    'Rockville Ice Arena',
    calendarUrl: 'https://www.rockvilleicearena.com/page/show/2944804-public-and-stick-time-ice-schedules',
    publicSkateUrl: 'https://www.rockvilleicearena.com/page/show/2944804-public-and-stick-time-ice-schedules',
    website: 'https://www.rockvilleicearena.com',
    surface: 'Ice',
    timezone: 'America/New_York',
    price:    null,
    stickPrice: 18.00, // Stick Time $18; goalies free
  },

  breakaway: {
    name:    'Breakaway Ice Center',
    calendarUrl: 'https://www.breakawayicecenter.com/schedule/',
    publicSkateUrl: 'https://www.breakawayicecenter.com/schedule/',
    website: 'https://www.breakawayicecenter.com',
    surface: 'Ice',
    timezone: 'America/New_York',
    price:    null,
  },

};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function to24h(h, m, period) {
  let hr = parseInt(h, 10);
  const min = String(m || '00').padStart(2, '0');
  if (period.toUpperCase() === 'PM' && hr !== 12) hr += 12;
  if (period.toUpperCase() === 'AM' && hr === 12) hr = 0;
  return `${String(hr).padStart(2, '0')}:${min}`;
}

function parseTimeRange(text) {
  // Matches: "10:00 AM - 12:00 PM", "10AM-12PM", "10:00am – 12:00pm", "10-12pm"
  const full  = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (full) {
    return {
      start: to24h(full[1], full[2], full[3]),
      end:   to24h(full[4], full[5], full[6]),
    };
  }
  return null;
}

function buildSession(name, times, date, rink) {
  const type = classifyType(name);
  if (!type) return null;
  if (EXCLUDE.test(name)) return null;
  return {
    name:            name.trim().substring(0, 60),
    type,
    start:           `${date}T${times.start}:00`,
    end:             `${date}T${times.end}:00`,
    price:           type === 'stick' ? (rink.stickPrice ?? rink.price) : rink.price,
    openSlots:       null,
    status:          'available',
    surface:         rink.surface,
    registrationUrl: rink.website,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Approach 1: Extract JSON from <script> tags (SportsEngine embeds schedule data)
// ─────────────────────────────────────────────────────────────────────────────
function extractFromScripts(html, date, rink) {
  const sessions = [];

  // SportsEngine sometimes embeds schedule JSON in window.__se_data or similar
  const jsonPatterns = [
    /window\.__se_data\s*=\s*({.+?});/s,
    /window\.seScheduleData\s*=\s*(\[.+?\]);/s,
    /"events"\s*:\s*(\[.+?\])/s,
  ];

  for (const pattern of jsonPatterns) {
    const match = html.match(pattern);
    if (!match) continue;
    try {
      const data = JSON.parse(match[1]);
      const events = Array.isArray(data) ? data : (data.events || data.schedule || []);
      for (const ev of events) {
        const evDate = ev.date || ev.startDate || ev.start_date || '';
        if (!evDate.startsWith(date)) continue;
        const name = ev.title || ev.name || ev.event_title || '';
        const startStr = ev.startTime || ev.start_time || ev.start || '';
        const endStr   = ev.endTime   || ev.end_time   || ev.end   || '';
        if (!startStr) continue;

        const startFmt = startStr.length === 5 ? startStr : startStr.slice(11, 16);
        const endFmt   = endStr.length === 5   ? endStr   : endStr.slice(11, 16);

        const type = classifyType(name);
        if (!type || EXCLUDE.test(name)) continue;
        sessions.push({
          name:            name.trim(),
          type,
          start:           `${date}T${startFmt}:00`,
          end:             `${date}T${endFmt}:00`,
          price:           rink.price,
          openSlots:       null,
          status:          'available',
          surface:         rink.surface,
          registrationUrl: rink.website,
        });
      }
      if (sessions.length > 0) return sessions;
    } catch (_) {}
  }

  return sessions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approach 2: HTML parsing with Cheerio
// SportsEngine calendar pages have a few different layouts:
//   - Older: <ul class="se-events-list"> with <li> per event
//   - Older: <table class="se-calendar-table"> with date cells
//   - Page-based schedule: recurring table or text listing times by day
// ─────────────────────────────────────────────────────────────────────────────
function extractFromHTML(html, date, rink) {
  const $ = cheerio.load(html);
  const sessions = [];

  const [yyyy, mm, dd] = date.split('-').map(Number);
  const targetDateStr  = date; // YYYY-MM-DD
  const dayOfWeek      = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });

  // ── Try 1: Look for event elements with matching date ──
  const dateSelectors = [
    `[data-date="${targetDateStr}"]`,
    `[data-day="${dd}"]`,
    `.se-calendar-day-${dd}`,
    `#se-calendar-${dd}`,
    `.fc-day[data-date="${targetDateStr}"]`,
  ];

  for (const sel of dateSelectors) {
    $(sel).each((_, el) => {
      const text = $(el).text();
      const items = text.split(/\n/).filter(l => l.trim());
      for (const item of items) {
        if (EXCLUDE.test(item)) continue;
        const type = classifyType(item);
        if (!type) continue;
        const times = parseTimeRange(item);
        if (!times) continue;
        const s = buildSession(item, times, date, rink);
        if (s) sessions.push(s);
      }
    });
    if (sessions.length > 0) return sessions;
  }

  // ── Try 2: Parse schedule listed by day of week (common on SE info pages) ──
  // e.g. "Public Skating\nMondays: 12:00 PM - 1:30 PM\nFridays: 12:00 PM - 1:30 PM"
  const fullText = $('body').text();
  const lines = fullText.split(/\n|\r/).map(l => l.trim()).filter(Boolean);

  let currentSessionName = '';
  for (const line of lines) {
    // Check if line looks like a session name
    if (!line.match(/\d{1,2}:\d{2}/) && classifyType(line) && !EXCLUDE.test(line)) {
      currentSessionName = line;
      continue;
    }

    // Check if line mentions the target day of week and a time
    if (!line.toLowerCase().includes(dayOfWeek.toLowerCase()) &&
        !line.toLowerCase().includes(dayOfWeek.slice(0, 3).toLowerCase())) continue;

    const times = parseTimeRange(line);
    if (!times) continue;

    const name = currentSessionName || line;
    if (EXCLUDE.test(name)) continue;
    const s = buildSession(name, times, date, rink);
    if (s) sessions.push(s);
  }

  if (sessions.length > 0) return sessions;

  // ── Try 3: Any time range on page that matches reasonable session keywords ──
  const timePattern = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi;
  let m;
  while ((m = timePattern.exec(fullText)) !== null) {
    // Get surrounding context (100 chars before)
    const ctxStart = Math.max(0, m.index - 100);
    const ctx = fullText.slice(ctxStart, m.index + m[0].length + 20);

    if (!classifyType(ctx) || EXCLUDE.test(ctx)) continue;

    // Only include if context mentions our target day
    if (!ctx.toLowerCase().includes(dayOfWeek.toLowerCase()) &&
        !ctx.toLowerCase().includes(dayOfWeek.slice(0, 3).toLowerCase())) continue;

    const times = { start: to24h(m[1], m[2], m[3]), end: to24h(m[4], m[5], m[6]) };
    const name = ctx.replace(m[0], '').replace(/\s+/g, ' ').trim().substring(0, 50) || 'Public Skate';
    const s = buildSession(name, times, date, rink);
    if (s) sessions.push(s);
  }

  return sessions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main fetch for a single rink
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSESchedule(rink, date) {
  const url = rink.publicSkateUrl || rink.calendarUrl;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) throw new Error(`SE fetch failed: ${res.status} for ${url}`);

  const html = await res.text();

  // Try JSON first, then HTML
  let sessions = extractFromScripts(html, date, rink);
  if (sessions.length === 0) {
    sessions = extractFromHTML(html, date, rink);
  }

  // If rink is Haymarket and SE returns nothing, try DaySmart fallback
  if (sessions.length === 0 && rink.daysmartFallback) {
    try {
      const dsUrl = `https://api.daysmartrecreation.com/dash/x/api/v1/public/events?` +
        `company=${rink.daysmartFallback}&startDate=${date}&endDate=${date}`;
      const dsRes = await fetch(dsUrl, {
        headers: { 'Accept': 'application/json' },
      });
      if (dsRes.ok) {
        const dsData = await dsRes.json();
        // Use same normalization as schedule.js
        const events = dsData.data || dsData.events || dsData || [];
        for (const ev of events) {
          const name = ev.name || ev.eventName || '';
          if (EXCLUDE.test(name)) continue;
          const type = classifyType(name);
          if (!type) continue;
          const start = (ev.startDateTime || ev.start || '').replace(' ', 'T').slice(0, 19);
          const end   = (ev.endDateTime   || ev.end   || '').replace(' ', 'T').slice(0, 19);
          if (!start.startsWith(date)) continue;
          sessions.push({
            name, type, start, end,
            price:           ev.price ?? rink.price,
            openSlots:       ev.spotsAvailable ?? null,
            status:          'available',
            surface:         rink.surface,
            registrationUrl: rink.website,
          });
        }
      }
    } catch (_) {}
  }

  return sessions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
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

  const cacheKey = `sportsengine:${rinkKey}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  const rink = RINKS[rinkKey];

  try {
    const sessions = await fetchSESchedule(rink, date);
    sessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    cache.set(cacheKey, { ts: Date.now(), data: sessions });
    return res.status(200).json(sessions);
  } catch (err) {
    console.error(`scrape-sportsengine [${rinkKey}] error:`, err.message);
    // Return empty rather than 500 — front-end shows "no sessions found"
    cache.set(cacheKey, { ts: Date.now(), data: [] });
    return res.status(200).json([]);
  }
}
