// api/scrape-statichtml.js
// Static HTML scraper — config-driven, covers all SH1 rinks
// ─────────────────────────────────────────────────────────────────────────────
// Each rink uses one of three sub-strategies:
//
//   STRATEGY A — "fixed-weekly"
//     The rink's schedule page has a hardcoded weekly schedule in plain text.
//     We store the schedule in the RINKS config and return it directly.
//     Best for: Smithfield, Burbank, Norfolk
//
//   STRATEGY B — "civicplus"
//     The rink posts sessions to a CivicPlus/CivicEngage government CMS.
//     We fetch /Calendar.aspx?CID=XX and parse the HTML event list.
//     Best for: Stoneham, Benny Magiera (West Warwick), Loring (Framingham)
//
//   STRATEGY C — "wordpress-mycal"
//     The rink uses a WordPress MyCal/Events plugin with a month calendar.
//     We fetch /calendar/?yr=YYYY&month=M and parse date cells.
//     Best for: Daly Rink
//
// ADDING A NEW RINK:
//   1. Identify which strategy fits (check schedule URL in browser)
//   2. Add one entry to the RINKS object below
//   3. Deploy — no other code changes needed
// ─────────────────────────────────────────────────────────────────────────────

const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const cheerio = await import('cheerio').then(m => m.default ?? m);

// ── In-memory cache (4-hour TTL) ─────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Session type classification ───────────────────────────────────────────────
function classifyType(name = '') {
  const n = name.toLowerCase();
  if (/freestyle|freeskate|figure/.test(n))  return 'freestyle';
  if (/stick|shoot|puck/.test(n))            return 'stick';
  if (/pickup|pick.?up|drop.?in/.test(n))    return 'pickup';
  if (/public|open skat|adult skat/.test(n)) return 'public';
  return 'public'; // default for these rinks — all sessions are public-facing
}

const EXCLUDE = /game|learn.to.skat|lts|duck shinny|goalie.only|private|tournament|birthday|party|lesson|class|clinic|camp/i;

// ── Config ────────────────────────────────────────────────────────────────────
const RINKS = {

  // ── STRATEGY A: Fixed weekly ──────────────────────────────────────────────

  smithfield: {
    name:     'Smithfield Municipal Ice Rink',
    strategy: 'fixed-weekly',
    website:  'https://www.smithfieldri.gov/departments/ice-rink',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    5.00,
    // Source: smithfieldri.gov/departments/ice-rink/information-and-rates
    // "Tuesdays and Fridays: 12:00pm–1:30pm" / "Mondays and Thursdays: 11:00am–12:30pm (hockey)"
    // Public skate = Tue + Fri. Public hockey = Mon + Thu (counted as pickup)
    schedule: {
      0: [],                                          // Sun
      1: [{ start: '11:00', end: '12:30', name: 'Public Hockey', type: 'pickup' }],   // Mon
      2: [{ start: '12:00', end: '13:30', name: 'Public Skate',  type: 'public' }],   // Tue
      3: [],                                          // Wed
      4: [{ start: '11:00', end: '12:30', name: 'Public Hockey', type: 'pickup' }],   // Thu
      5: [{ start: '12:00', end: '13:30', name: 'Public Skate',  type: 'public' }],   // Fri
      6: [],                                          // Sat — Sunday sessions vary, see notes
    },
    notes: 'Sunday public skate times vary; listed as "see press release". Hardcoded Mon–Fri only.',
  },

  burbank: {
    name:     'Burbank Ice Arena',
    strategy: 'fixed-weekly',
    website:  'https://www.burbankicearena.com/public-skating',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    8.00,
    // Source: burbankicearena.com/public-skating (Squarespace, verified Mar 2026)
    // SPRING schedule. SUMMER/FALL may differ — update when season changes.
    schedule: {
      0: [{ start: '18:00', end: '19:15', name: 'Public Skate', type: 'public' }],   // Sun
      1: [{ start: '11:00', end: '13:00', name: 'Public Skate', type: 'public' }],   // Mon
      2: [{ start: '12:00', end: '13:50', name: 'Public Skate', type: 'public' }],   // Tue
      3: [{ start: '12:30', end: '14:30', name: 'Public Skate', type: 'public' }],   // Wed
      4: [{ start: '11:00', end: '13:00', name: 'Public Skate', type: 'public' }],   // Thu
      5: [{ start: '12:00', end: '13:50', name: 'Public Skate', type: 'public' }],   // Fri
      6: [],                                          // Sat — no regular public skate
    },
    notes: 'Closed Easter Sunday. School vacation weeks may have extra sessions.',
  },

  norfolk: {
    name:     'Norfolk Ice Arena',
    strategy: 'fixed-weekly',
    website:  'https://norfolkarena.com/index.php/publicskating/',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    null, // not listed publicly
    // Source: norfolkarena.com parties page + public skating page (verified Mar 2026)
    // "Public skate is Saturday 7:00pm–8:50pm and Sunday 1:00pm–2:50pm"
    schedule: {
      0: [{ start: '13:00', end: '14:50', name: 'Public Skate', type: 'public' }],   // Sun
      1: [],
      2: [],
      3: [],
      4: [],
      5: [],
      6: [{ start: '19:00', end: '20:50', name: 'Public Skate', type: 'public' }],   // Sat
    },
    notes: 'Sat + Sun only. Year-round. Times confirmed from multiple pages.',
  },

  // ── STRATEGY B: CivicPlus HTML ────────────────────────────────────────────

  stoneham: {
    name:     'Stoneham Arena',
    strategy: 'civicplus',
    calendarUrl: 'https://www.stoneham-ma.gov/calendar.aspx',
    calendarCid: '26',   // CID=26 is the arena calendar
    website:  'https://www.stoneham-ma.gov/164/Stoneham-Arena',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    10.00,     // adults; kids/seniors $5
    // Public Skate: Mon–Fri 10:00–11:45am. Adult Stick Practice: Mon–Fri 12:00–1:50pm.
    // Also posts freestyle sessions on same calendar.
    sessionTypes: ['Public Skating', 'Public Stick', 'Adult Stick'],
  },

  bennymagiera: {
    name:     'Benny Magiera Rink',
    strategy: 'civicplus',
    calendarUrl: 'https://www.westwarwickri.org/calendar.aspx',
    calendarCid: null,   // No specific CID — full calendar includes rink events
    calendarKeyword: 'skate',  // filter events containing this keyword
    website:  'https://www.westwarwickri.org/index.asp?SEC=706EFDDE-B8A8-457B-8035-C96BC10019E1',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    1.00,      // public skating $1/person (very affordable community rink)
    // Schedule posted weekly — NOT fixed. Must fetch live.
    sessionTypes: ['Public Skating', 'Stick', 'Public Ice'],
  },

  loring: {
    name:     'Loring Arena',
    strategy: 'civicplus',
    calendarUrl: 'https://www.framinghamma.gov/calendar.aspx',
    calendarCid: null,
    calendarKeyword: 'skate',
    website:  'https://www.framinghamma.gov/678/Loring-Arena',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    null,
    // Stick Time Mon–Fri noon–2pm. Public skating times vary.
    sessionTypes: ['Public Skate', 'Stick Time', 'Public Skating'],
  },

  // ── STRATEGY C: WordPress MyCal ──────────────────────────────────────────

  daly: {
    name:     'Daly Rink',
    strategy: 'wordpress-mycal',
    calendarUrl: 'https://www.dalyrink.org/calendar/',
    website:  'https://www.dalyrink.org',
    surface:  'Ice',
    timezone: 'America/New_York',
    price:    8.00,    // adults; children $6
    registrationUrl: null,  // walk-in
    // Seasonal Oct–late March. Returns [] when not in season.
    seasonStart: { month: 9,  day: 1  },  // approx. Sept 1
    seasonEnd:   { month: 4,  day: 15 },  // approx. April 15
  },

};

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY A: Fixed weekly
// ─────────────────────────────────────────────────────────────────────────────
function buildFixedWeekly(rink, date) {
  const dow = new Date(date + 'T12:00:00').getDay();
  const slots = rink.schedule[dow] || [];
  return slots.map(slot => ({
    name:            slot.name || 'Public Skate',
    type:            slot.type || 'public',
    start:           `${date}T${slot.start}:00`,
    end:             `${date}T${slot.end}:00`,
    price:           rink.price,
    openSlots:       null,
    status:          'available',
    surface:         rink.surface,
    registrationUrl: rink.website,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY B: CivicPlus HTML calendar
// ─────────────────────────────────────────────────────────────────────────────
async function fetchCivicPlus(rink, date) {
  const [year, month] = date.split('-');
  const targetDay = parseInt(date.split('-')[2], 10);

  // Build URL — CivicPlus Calendar.aspx supports month/year params
  const params = new URLSearchParams({ month, year });
  if (rink.calendarCid) params.set('CID', rink.calendarCid);
  const url = `${rink.calendarUrl}?${params}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IceTimeHQ/1.0)' },
  });
  if (!res.ok) throw new Error(`CivicPlus fetch failed: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  const sessions = [];

  // CivicPlus renders events in several possible formats:
  // 1. <div class="calendar-event"> or <li class="fc-event"> (newer)
  // 2. <table> with date cells containing event links (older)
  // 3. Individual event detail pages linked from the calendar
  //
  // The most reliable approach: look for date-bearing elements and extract times.

  // Pattern 1: Look for elements with data-start or datetime attributes
  $('[data-start], [datetime]').each((_, el) => {
    const dtStr = $(el).attr('data-start') || $(el).attr('datetime') || '';
    if (!dtStr.startsWith(date)) return;
    const title = $(el).text().trim() || $(el).attr('title') || '';
    if (shouldKeep(title, rink)) {
      const session = parseEventTitle(title, date, rink);
      if (session) sessions.push(session);
    }
  });

  // Pattern 2: Text scan — look for "H:MM AM/PM – H:MM AM/PM" on the target date
  // CivicPlus often embeds ISO date strings like "2026-03-31T10:00:00" inline
  const isoPattern = new RegExp(
    `${date}T(\\d{2}:\\d{2}):\\d{2}[^"]*?(?:[^"]*?${date}T(\\d{2}:\\d{2}))?`, 'g'
  );
  const timePattern = /(\d{1,2}:\d{2})\s*(AM|PM)\s*[-–to]+\s*(\d{1,2}:\d{2})\s*(AM|PM)/gi;

  // Look for inline ISO times near event names
  const pageText = $('body').text();

  // Find lines containing target date
  const lines = pageText.split('\n');
  for (const line of lines) {
    if (!line.includes(date) && !line.match(/\d{1,2}:\d{2}\s*(?:AM|PM)/i)) continue;
    if (!shouldKeep(line, rink)) continue;
    const timeMatch = line.match(timePattern);
    if (timeMatch) {
      const session = parseTimeMatch(timeMatch[0], line, date, rink);
      if (session) sessions.push(session);
    }
  }

  // If still empty, try fetching the list view which is more parseable
  if (sessions.length === 0) {
    const listUrl = `${rink.calendarUrl}?${params}&format=list`;
    try {
      const listRes = await fetch(listUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IceTimeHQ/1.0)' },
      });
      if (listRes.ok) {
        const listHtml = await listRes.text();
        const $l = cheerio.load(listHtml);
        // List view: each event is a row with date and time
        $l('.events-list-item, .calendar-listing, .fc-list-item').each((_, el) => {
          const text = $l(el).text();
          if (!text.includes(date.replace(/-/g, '/')) &&
              !text.includes(`${parseInt(date.split('-')[2])} `)) return;
          if (!shouldKeep(text, rink)) return;
          const timeMatch = text.match(timePattern);
          if (timeMatch) {
            const s = parseTimeMatch(timeMatch[0], text, date, rink);
            if (s) sessions.push(s);
          }
        });
      }
    } catch (_) {}
  }

  return sessions;
}

function shouldKeep(text, rink) {
  if (EXCLUDE.test(text)) return false;
  if (!rink.sessionTypes) return true;
  return rink.sessionTypes.some(t => text.toLowerCase().includes(t.toLowerCase()));
}

function to24h(h, m, period) {
  let hr = parseInt(h, 10);
  const min = m || '00';
  if (period.toUpperCase() === 'PM' && hr !== 12) hr += 12;
  if (period.toUpperCase() === 'AM' && hr === 12) hr = 0;
  return `${String(hr).padStart(2, '0')}:${min}`;
}

function parseTimeMatch(timeStr, context, date, rink) {
  // e.g. "10:00 AM - 11:45 AM" or "10:00AM–11:45AM"
  const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–to]+\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const start = to24h(m[1], m[2], m[3]);
  const end   = to24h(m[4], m[5], m[6]);

  // Extract session name from context
  const nameLine = context.replace(timeStr, '').replace(/\s+/g, ' ').trim().substring(0, 60);
  const name = nameLine || 'Public Skate';
  const type = classifyType(name);

  return {
    name:            name.substring(0, 50),
    type,
    start:           `${date}T${start}:00`,
    end:             `${date}T${end}:00`,
    price:           rink.price,
    openSlots:       null,
    status:          'available',
    surface:         rink.surface,
    registrationUrl: rink.website,
  };
}

function parseEventTitle(title, date, rink) {
  const timePattern = /(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–to]+\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i;
  const m = title.match(timePattern);
  if (!m) return null;
  return parseTimeMatch(m[0], title, date, rink);
}

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY C: WordPress MyCal
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWordPressMyCal(rink, date) {
  const [year, month, day] = date.split('-').map(Number);

  // Check season for Daly (seasonal rink)
  if (rink.seasonStart && rink.seasonEnd) {
    const { seasonStart: ss, seasonEnd: se } = rink;
    const inSeason = (month > ss.month || (month === ss.month && day >= ss.day)) &&
                     (month < se.month  || (month === se.month  && day <= se.day));
    if (!inSeason) return [];
  }

  const url = `${rink.calendarUrl}?yr=${year}&month=${month}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IceTimeHQ/1.0)' },
  });
  if (!res.ok) throw new Error(`WordPress calendar fetch failed: ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  const sessions = [];

  // MyCal renders the calendar as a <table>. Each <td> has an ID like mc_calendar_DD_NNNN.
  // Inside the td: date number + event title with time in format "H:MM am – H:MM pm"
  // We look for the td matching our target day.

  $('td').each((_, td) => {
    const tdId = $(td).attr('id') || '';
    // IDs like: mc_calendar_29_15729-calendar-details-...
    const dayMatch = tdId.match(/^mc_calendar_(\d{1,2})_/);
    if (!dayMatch) return;
    if (parseInt(dayMatch[1], 10) !== day) return;

    // Found the day cell — extract event text
    const cellText = $(td).text();
    // Pattern: "Event Title H:MM am – H:MM pm Day, Month DD"
    // From actual HTML: "Public Skating 3:00 pm  –   5:45 pm Sunday, March 29"
    const timePattern = /(\d{1,2}:\d{2})\s*(am|pm)\s*[-–]+\s*(\d{1,2}:\d{2})\s*(am|pm)/gi;
    let match;
    while ((match = timePattern.exec(cellText)) !== null) {
      // Get the event name — text before the time
      const beforeTime = cellText.slice(0, match.index).replace(/\d+\s*$/, '').trim();
      const eventName = beforeTime.split(/\n/).filter(Boolean).pop()?.trim() || 'Public Skate';

      if (EXCLUDE.test(eventName)) continue;

      const start = to24h(...match[1].split(':'), match[2]);
      const end   = to24h(...match[3].split(':'), match[4]);

      sessions.push({
        name:            eventName || 'Public Skate',
        type:            classifyType(eventName),
        start:           `${date}T${start}:00`,
        end:             `${date}T${end}:00`,
        price:           rink.price,
        openSlots:       null,
        status:          'available',
        surface:         rink.surface,
        registrationUrl: rink.website,
      });
    }
  });

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

  const cacheKey = `statichtml:${rinkKey}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  const rink = RINKS[rinkKey];

  try {
    let sessions = [];

    switch (rink.strategy) {
      case 'fixed-weekly':
        sessions = buildFixedWeekly(rink, date);
        break;
      case 'civicplus':
        sessions = await fetchCivicPlus(rink, date);
        break;
      case 'wordpress-mycal':
        sessions = await fetchWordPressMyCal(rink, date);
        break;
      default:
        return res.status(400).json({ error: `Unknown strategy: ${rink.strategy}` });
    }

    sessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    cache.set(cacheKey, { ts: Date.now(), data: sessions });
    return res.status(200).json(sessions);

  } catch (err) {
    console.error(`scrape-statichtml [${rinkKey}] error:`, err.message);

    // Fallback for CivicPlus / WordPress: return empty array rather than 500
    // so the site shows "no sessions found" rather than an error state
    if (rink.strategy !== 'fixed-weekly') {
      const fallback = [];
      cache.set(cacheKey, { ts: Date.now(), data: fallback });
      return res.status(200).json(fallback);
    }

    return res.status(500).json({ error: 'Scraper failed', rink: rinkKey, details: err.message });
  }
}
