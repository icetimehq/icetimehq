// api/scrape-bondsports.js
// BondSports platform scraper — config-driven (Type A)
// Covers: UTC Ice Sports Center, Ice Realm Carlsbad
// CommonJS (module.exports) — required for Vercel without "type":"module"

// ── Config ───────────────────────────────────────────────────────────────────
const RINKS = {
  utcice: {
    name:     'UTC Ice Sports Center',
    orgId:    6884,
    seasonId: 68912,
    surface:  'Ice',
    timezone: 'America/Los_Angeles',
    publicSkateUrl: 'https://utcice.com/public-session-schedule/',
  },
  carlsbad: {
    name:     'Ice Realm Carlsbad',
    orgId:    11241,
    seasonId: null, // No season ID needed — use org-level endpoints
    surface:  'Ice',
    timezone: 'America/Los_Angeles',
    publicSkateUrl: 'https://bondsports.co/activity/programs/CO_ED-adult-ICE_SKATING/11241',
  },
};

// ── Cache (4 hours) ───────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Classify ──────────────────────────────────────────────────────────────────
function classifyType(name = '') {
  const n = name.toLowerCase();
  if (/freestyle|freeskate|figure/.test(n))        return 'freestyle';
  if (/stick|shoot|puck/.test(n))                  return 'stick';
  if (/pickup|pick.?up|drop.?in/.test(n))          return 'pickup';
  if (/public|open skate|adult skate/.test(n))     return 'public';
  return null;
}

const EXCLUDE = /game|learn.to.skate|lts|duck shinny|goalie|camp|clinic|private|tournament|lesson/i;

// ── Fetch strategies ──────────────────────────────────────────────────────────
const API_BASE = 'https://app.bondsports.co/api/v3';

async function fetchSchedule(rink, date) {
  const { orgId, seasonId } = rink;
  const strategies = [
    `${API_BASE}/organizations/${orgId}/slots?startDate=${date}&endDate=${date}&type=activity`,
    `${API_BASE}/organizations/${orgId}/seasons/${seasonId}/slots?startDate=${date}&endDate=${date}`,
    `${API_BASE}/organizations/${orgId}/activities?startDate=${date}&endDate=${date}`,
  ];

  const headers = {
    'Accept': 'application/json',
    'Origin': 'https://bondsports.co',
    'Referer': 'https://bondsports.co/',
  };

  for (const url of strategies) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        const items = Array.isArray(data) ? data
          : (data.data ?? data.slots ?? data.activities ?? []);
        if (items.length > 0) return items;
      }
    } catch (_) { /* try next */ }
  }
  return [];
}

// ── Normalize ─────────────────────────────────────────────────────────────────
function normalize(item, rink, date) {
  const name = item.name || item.title || item.activityName || item.programName || '';
  if (!name || EXCLUDE.test(name)) return null;

  const type = classifyType(name);
  if (!type) return null;

  let start = item.startDate || item.startTime || item.start || null;
  let end   = item.endDate   || item.endTime   || item.end   || null;

  // Convert HH:MM → HH:MM (keep as time string for frontend)
  if (start && start.includes('T')) {
    const m = start.match(/T(\d{2}:\d{2})/);
    start = m ? m[1] : null;
  }
  if (end && end.includes('T')) {
    const m = end.match(/T(\d{2}:\d{2})/);
    end = m ? m[1] : null;
  }

  if (!start || !end) return null;

  const price = item.price ?? item.cost ?? item.amount ?? null;
  const openSlots = item.spotsLeft ?? item.availableSpots ?? item.openSlots ?? null;

  return {
    name:            name.trim(),
    type,
    label:           name.trim(),
    start,
    end,
    price:           price !== null ? parseFloat(price) : null,
    openSlots,
    status:          openSlots === 0 ? 'full' : 'available',
    surface:         rink.surface,
    registrationUrl: rink.seasonId
      ? `https://bondsports.co/activity/programs/CO_ED-adult-ICE_SKATING/${rink.orgId}/season/Public%20Session/${rink.seasonId}`
      : rink.publicSkateUrl,
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

  const cacheKey = `bondsports:${rinkKey}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ sessions: cached.data, source: 'cache' });
  }

  const rink = RINKS[rinkKey];

  try {
    const items = await fetchSchedule(rink, date);
    const sessions = items
      .map(item => normalize(item, rink, date))
      .filter(Boolean)
      .sort((a, b) => a.start.localeCompare(b.start));

    cache.set(cacheKey, { ts: Date.now(), data: sessions });
    return res.status(200).json({ sessions, source: 'live' });

  } catch (err) {
    console.error('[scrape-bondsports] error:', err.message);
    return res.status(200).json({ sessions: [], error: err.message });
  }
};
