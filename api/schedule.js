// api/schedule.js
// DaySmart API scraper — handles DS1 (single facility) and DS2 (The Rinks multi-facility)
// Config is read from data/rinks.json at startup.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs   = require('fs');

// ── Load rink config from data/rinks.json ────────────────────────────────────
function loadRinks() {
  const filePath = path.join(__dirname, '../data/rinks.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  // Return only DS1/DS2 rinks that are live or planned
  return data.rinks.filter(r =>
    (r.platform_code === 'DS1' || r.platform_code === 'DS2') &&
    (r.status === 'live' || r.status === 'planned')
  );
}

// ── In-memory cache (4-hour TTL) ─────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Session type classifier ───────────────────────────────────────────────────
function classifyType(name = '') {
  const n = name.toLowerCase();
  if (/freestyle|freeskate|figure/.test(n))  return 'freestyle';
  if (/stick|shoot|puck/.test(n))            return 'stick';
  if (/pickup|pick.?up|drop.?in/.test(n))    return 'pickup';
  if (/public|open skat|adult skat/.test(n)) return 'public';
  return null;
}

const EXCLUDE = /\bgame\b|league|learn.to.sk|lts|\bduck\b|goalie.only|private|tournament|birthday|party|lesson|class|clinic|camp|practice|tryout|scrimmage/i;

// ── DaySmart API fetch ────────────────────────────────────────────────────────
// DaySmart requires query strings built manually (not URLSearchParams).
async function fetchDaySmart(company, startDate, endDate) {
  const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

  const strategies = [
    // Strategy 1: new /x/api endpoint
    `https://apps.daysmartrecreation.com/dash/x/api/v1/public/events?company=${company}&startDate=${startDate}&endDate=${endDate}`,
    // Strategy 2: legacy dash endpoint
    `https://apps.daysmartrecreation.com/dash/index.php?action=PublicEvent/getEvents&company=${company}&startDate=${startDate}&endDate=${endDate}&format=json`,
    // Strategy 3: lts subdomain
    `https://lts.daysmartrecreation.com/dash/x/api/v1/public/events?company=${company}&startDate=${startDate}&endDate=${endDate}`,
  ];

  for (const url of strategies) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; IceTimeHQ/1.0)',
          'Origin': `https://apps.daysmartrecreation.com`,
        },
        timeout: 10000,
      });

      if (!res.ok) continue;

      const text = await res.text();
      if (!text || text.trim() === '') continue;

      let data;
      try { data = JSON.parse(text); } catch (_) { continue; }

      // Normalize response shape
      const events = Array.isArray(data)
        ? data
        : (data.data || data.events || data.items || data.results || []);

      if (Array.isArray(events)) return events;
    } catch (_) {
      continue;
    }
  }

  return [];
}

// ── Normalize a DaySmart event to IceTimeHQ session format ───────────────────
function normalizeEvent(ev, rink) {
  const name = ev.name || ev.eventName || ev.title || ev.event_name || '';
  if (!name || EXCLUDE.test(name)) return null;

  const type = classifyType(name);
  if (!type) return null;

  // Start/end can be ISO strings or separate date+time fields
  let start = ev.startDateTime || ev.start_datetime || ev.start || ev.startTime || '';
  let end   = ev.endDateTime   || ev.end_datetime   || ev.end   || ev.endTime   || '';

  // Normalize to ISO format (replace space with T if needed)
  start = start.replace(' ', 'T');
  end   = end.replace(' ', 'T');

  if (!start) return null;

  return {
    name:            name.trim(),
    type,
    start,
    end,
    price:           ev.price ?? ev.cost ?? null,
    openSlots:       ev.spotsAvailable ?? ev.spots_available ?? ev.openSlots ?? null,
    status:          (ev.status === 'cancelled' || ev.cancelled) ? 'cancelled' : 'available',
    surface:         'Ice',
    registrationUrl: ev.registrationUrl || ev.register_url ||
                     `https://apps.daysmartrecreation.com/dash/x/#/online/${rink.company}/event-registration`,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { rink: rinkKey, date } = req.query;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date param required: YYYY-MM-DD' });
  }

  // Load config fresh on each cold start (Vercel caches the module)
  let rinks;
  try { rinks = loadRinks(); } catch (e) {
    return res.status(500).json({ error: 'Failed to load rinks.json', details: e.message });
  }

  // If a specific rink is requested, filter to just that one
  const targetRinks = rinkKey
    ? rinks.filter(r => r.rink_id === rinkKey || r.company === rinkKey)
    : rinks;

  if (rinkKey && targetRinks.length === 0) {
    return res.status(404).json({ error: `Rink not found: ${rinkKey}` });
  }

  // For single-rink requests, use cache
  const cacheKey = `schedule:${rinkKey || 'all'}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  try {
    // Group rinks by company to minimize API calls
    // DS2 rinks share company='rinks', so one API call covers all of them
    const byCompany = {};
    for (const rink of targetRinks) {
      if (!byCompany[rink.company]) byCompany[rink.company] = [];
      byCompany[rink.company].push(rink);
    }

    const allSessions = [];

    for (const [company, companyRinks] of Object.entries(byCompany)) {
      const events = await fetchDaySmart(company, date, date);

      for (const ev of events) {
        // Determine which rink this event belongs to
        let matchedRink = companyRinks[0]; // default for DS1 (single rink per company)

        if (companyRinks.length > 1) {
          // DS2: filter by facility_id or facility_filter string in event name
          const evName    = (ev.name || ev.eventName || '').toLowerCase();
          const evFacility = ev.facilityId || ev.facility_id || ev.facilityID;

          matchedRink = companyRinks.find(r => {
            if (evFacility && r.facility_id) return String(evFacility) === String(r.facility_id);
            if (r.facility_filter) return evName.includes(r.facility_filter.toLowerCase());
            return false;
          }) || null;

          if (!matchedRink) continue; // Skip if can't match to a specific rink
        }

        // If a specific rink was requested, only include events for that rink
        if (rinkKey && matchedRink.rink_id !== rinkKey && matchedRink.company !== rinkKey) continue;

        const session = normalizeEvent(ev, matchedRink);
        if (session) {
          allSessions.push({
            ...session,
            rink_id:   matchedRink.rink_id,
            rink_name: matchedRink.name,
            region:    matchedRink.region,
          });
        }
      }
    }

    allSessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    const response = { sessions: allSessions, source: 'live', date };
    cache.set(cacheKey, { ts: Date.now(), data: response });
    return res.status(200).json(response);

  } catch (err) {
    console.error('schedule.js error:', err.message);
    return res.status(500).json({ error: 'Scraper failed', details: err.message });
  }
};
