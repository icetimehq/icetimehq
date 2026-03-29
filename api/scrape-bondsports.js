// api/scrape-bondsports.js
// BondSports platform scraper — config-driven
// CommonJS (module.exports) — required for Vercel without "type":"module"
//
// UTC Ice purchase URL structure:
//   bondsports.co/activity/programs/CO_ED-adult-ICE_SKATING/6884/season/Public%20Session/68912
//   → orgId: 6884, seasonId: 68912
//
// Called with: /api/scrape-bondsports?date=YYYY-MM-DD&rink=utcice

const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Rink config ───────────────────────────────────────────────────────────────
const RINKS = {
  utcice: {
    name:     'UTC Ice Sports Center',
    orgId:    6884,
    seasonId: 68912,
    surface:  'Ice',
    timezone: 'America/Los_Angeles',
  },
};

const BONDSPORTS_API_BASE = 'https://app.bondsports.co/api/v3';

// ── Classify session type ─────────────────────────────────────────────────────
function classifyType(name) {
  const n = (name || '').toLowerCase();
  if (/freestyle|freeskate|figure/.test(n))        return 'freestyle';
  if (/stick|shoot|puck/.test(n))                   return 'stick';
  if (/pickup|pick.?up|drop.?in/.test(n))           return 'pickup';
  if (/public|open skate|adult skate/.test(n))      return 'public';
  return null;
}

const EXCLUDE = /game|learn.to.skate|lts|duck shinny|goalie|camp|clinic|private|tournament|lesson|class/i;

// ── Fetch from BondSports — tries 3 endpoint strategies ──────────────────────
async function fetchSchedule(rink, date) {
  const { orgId, seasonId } = rink;
  const headers = {
    'Accept':  'application/json',
    'Origin':  'https://bondsports.co',
    'Referer': 'https://bondsports.co/',
  };

  const endpoints = [
    `${BONDSPORTS_API_BASE}/organizations/${orgId}/slots?startDate=${date}&endDate=${date}&type=activity`,
    `${BONDSPORTS_API_BASE}/organizations/${orgId}/seasons/${seasonId}/slots?startDate=${date}&endDate=${date}`,
    `${BONDSPORTS_API_BASE}/organizations/${orgId}/activities?startDate=${date}&endDate=${date}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        const items = Array.isArray(data) ? data
          : (data.data ?? data.slots ?? data.activities ?? []);
        return items;
      }
    } catch (_) { /* try next */ }
  }
  return [];
}

// ── Normalize BondSports item → IceTimeHQ session ────────────────────────────
function normalize(item, rink, date) {
  const name = item.name || item.title || item.activityName || item.programName || '';
  if (EXCLUDE.test(name)) return null;

  const type = classifyType(name);
  if (!type) return null;

  let start = item.startDate || item.startTime || item.start || null;
  let end   = item.endDate   || item.endTime   || item.end   || null;

  // Combine bare HH:MM with date
  if (start && !start.includes('T') && start.length <= 8) start = `${date}T${start.padStart(5,'0')}:00`;
  if (end   && !end.includes('T')   && end.length <= 8)   end   = `${date}T${end.padStart(5,'0')}:00`;
  if (start && start.includes('T') && start.length === 16) start += ':00';
  if (end   && end.includes('T')   && end.length === 16)   end   += ':00';

  // Extract HH:MM for frontend display
  const startTime = start ? (start.match(/T(\d{2}:\d{2})/) || [])[1] : null;
  const endTime   = end   ? (end.match(/T(\d{2}:\d{2})/)   || [])[1] : null;
  if (!startTime || !endTime) return null;

  const price     = item.price ?? item.cost ?? item.amount ?? null;
  const openSlots = item.spotsLeft ?? item.availableSpots ?? item.openSlots ?? null;
  const regUrl    = item.registrationUrl || item.bookingUrl || item.url
    || `https://bondsports.co/activity/programs/CO_ED-adult-ICE_SKATING/${rink.orgId}/season/Public%20Session/${rink.seasonId}`;

  return {
    name:            name.trim(),
    type,
    label:           name.trim(),
    start:           startTime,
    end:             endTime,
    price:           price !== null ? parseFloat(price) : null,
    openSlots,
    status:          openSlots === 0 ? 'full' : 'available',
    surface:         rink.surface,
    registrationUrl: regUrl,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { rink: rinkKey, date } = req.query;

  if (!rinkKey || !RINKS[rinkKey]) {
    return res.status(400).json({ error: `rink param required. Valid: ${Object.keys(RINKS).join(', ')}`, sessions: [] });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date param required: YYYY-MM-DD', sessions: [] });
  }

  const cacheKey = `bondsports:${rinkKey}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  const rink = RINKS[rinkKey];

  try {
    const items = await fetchSchedule(rink, date);
    const sessions = items.map(item => normalize(item, rink, date)).filter(Boolean);
    sessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    cache.set(cacheKey, { ts: Date.now(), data: sessions });
    return res.status(200).json(sessions);

  } catch (err) {
    console.error('scrape-bondsports error:', err.message);
    return res.status(200).json([]);
  }
};
