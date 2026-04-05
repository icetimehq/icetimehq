// api/schedule.js
// DaySmart API proxy — handles DS1 (single facility) and DS2 (The Rinks multi-facility)
// Reads config from data/rinks.json
// CommonJS (module.exports) — required for Vercel without "type":"module"

const path = require('path');
const fs   = require('fs');

// ── Load rink config ──────────────────────────────────────────────────────────
function loadRinks() {
  const filePath = path.join(__dirname, '../data/rinks.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  // rinks.json is a flat object keyed by rink_id
  return Object.values(data).filter(r =>
    r.platform === 'daysmart' &&
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

// ── Clean session name ────────────────────────────────────────────────────────
function cleanName(name) {
  return name
    .replace(/\(\d{1,2}\/\d{1,2}-\d{1,2}\/\d{1,2}\)/g, '')  // strip date ranges like (3/23-3/29)
    .replace(/^[A-Z]{2,4}\s*[–-]\s*/g, '')                    // strip facility prefix like "PI –"
    .trim();
}

// ── DaySmart API fetch ────────────────────────────────────────────────────────
// CRITICAL: Build query strings manually — URLSearchParams encodes brackets
// and breaks the DaySmart API.
async function fetchDaySmart(company, date, facilityId) {
  const strategies = [
    // Strategy 1: JSON API with summary+resource includes
    () => {
      let url = `https://apps.daysmartrecreation.com/dash/jsonapi/api/v1/events`;
      url += `?company=${company}`;
      url += `&filter[start_date__gte]=${date}&filter[start_date__lte]=${date}`;
      url += `&include[]=summary&include[]=resource`;
      url += `&filter[unconstrained]=1`;
      if (facilityId) url += `&filter[facility_ids][]=${facilityId}`;
      return url;
    },
    // Strategy 2: summary only (fallback if resource include fails)
    () => {
      let url = `https://apps.daysmartrecreation.com/dash/jsonapi/api/v1/events`;
      url += `?company=${company}`;
      url += `&filter[start_date__gte]=${date}&filter[start_date__lte]=${date}`;
      url += `&include[]=summary`;
      url += `&filter[unconstrained]=1`;
      if (facilityId) url += `&filter[facility_ids][]=${facilityId}`;
      return url;
    },
    // Strategy 3: no include params
    () => {
      let url = `https://apps.daysmartrecreation.com/dash/jsonapi/api/v1/events`;
      url += `?company=${company}`;
      url += `&filter[start_date__gte]=${date}&filter[start_date__lte]=${date}`;
      url += `&filter[unconstrained]=1`;
      if (facilityId) url += `&filter[facility_ids][]=${facilityId}`;
      return url;
    },
  ];

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; IceTimeHQ/1.0)',
  };

  for (const buildUrl of strategies) {
    const url = buildUrl();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || text.trim() === '') continue;
      let data;
      try { data = JSON.parse(text); } catch (_) { continue; }
      if (data && (data.data || data.events)) return data;
    } catch (_) { continue; }
  }
  return { data: [], included: [] };
}

// ── Build resource map from included array ────────────────────────────────────
function buildResourceMap(included = []) {
  const map = {};
  for (const item of included) {
    if (item.type === 'resource') {
      map[item.id] = item.attributes?.name || '';
    }
  }
  return map;
}

// ── Normalize a DaySmart event ────────────────────────────────────────────────
function normalizeEvent(ev, rink, resourceMap) {
  const attrs = ev.attributes || ev;
  const rawName = attrs.desc || attrs.name || attrs.eventName || attrs.title || '';
  if (!rawName || EXCLUDE.test(rawName)) return null;

  const name = cleanName(rawName);
  const type = classifyType(name);
  if (!type) return null;

  // Resolve resource (surface) name
  const resourceId = ev.relationships?.resource?.data?.id;
  const resourceName = resourceId ? (resourceMap[resourceId] || '') : '';

  // Apply facilityFilter if present (post-response filter for DS2)
  if (rink.facility_filter && resourceName) {
    if (!resourceName.toLowerCase().includes(rink.facility_filter.toLowerCase())) {
      return null;
    }
  }

  const start = (attrs.start || attrs.startDateTime || '').replace(' ', 'T');
  const end   = (attrs.end   || attrs.endDateTime   || '').replace(' ', 'T');
  if (!start) return null;

  // Build registration URL
  const regBase = `https://apps.daysmartrecreation.com/dash/x/#/online/${rink.company}`;
  const registrationUrl = rink.facility_id
    ? `${regBase}/calendar?start=${start.slice(0,10)}&end=${start.slice(0,10)}&location=${rink.facility_id}`
    : `${regBase}/event-registration/${ev.id || ''}`;

  return {
    name,
    type,
    start,
    end,
    price:           attrs.price ?? attrs.cost ?? null,
    openSlots:       attrs.spotsAvailable ?? attrs.spots_available ?? null,
    status:          (attrs.status === 'cancelled' || attrs.cancelled) ? 'cancelled' : 'available',
    surface:         resourceName || 'Ice',
    registrationUrl,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { company, facility_id, facility_filter, date, debug } = req.query;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ sessions: [], error: 'date param required: YYYY-MM-DD' });
  }
  if (!company) {
    return res.status(400).json({ sessions: [], error: 'company param required' });
  }

  const cacheKey = `schedule:${company}:${facility_id || 'all'}:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL && !debug) {
    return res.status(200).json(cached.data);
  }

  // Build rink config from query params (index.html passes these directly)
  const rink = {
    company,
    facility_id:     facility_id ? parseInt(facility_id) : null,
    facility_filter: facility_filter || null,
  };

  try {
    const apiResponse = await fetchDaySmart(company, date, rink.facility_id);
    const events      = apiResponse.data || apiResponse.events || [];
    const included    = apiResponse.included || [];
    const resourceMap = buildResourceMap(included);

    if (debug) {
      const allSurfaces = [...new Set(Object.values(resourceMap))];
      return res.status(200).json({ allSurfaces, resourceMap, eventCount: events.length });
    }

    const sessions = [];
    for (const ev of events) {
      const session = normalizeEvent(ev, rink, resourceMap);
      if (session) sessions.push(session);
    }

    sessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    const result = { sessions, source: 'live', date };
    cache.set(cacheKey, { ts: Date.now(), data: result });
    return res.status(200).json(result);

  } catch (err) {
    console.error('[schedule.js] error:', err.message);
    return res.status(500).json({ sessions: [], error: err.message });
  }
};
