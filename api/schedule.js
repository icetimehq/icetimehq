// /api/schedule.js — IceTimeHQ DaySmart Proxy
// Uses module.exports (CommonJS) — required for Vercel Node.js functions
// without "type":"module" in package.json

const DAYSMART_BASE = 'https://apps.daysmartrecreation.com/dash/jsonapi/api/v1/events';

// ─── CACHE (60 min) ──────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ─── CLASSIFY by session name keywords ───────────────────────────────────────
function classifySession(name) {
  const n = (name || '').toLowerCase();
  if (/freestyle|freeskate|free skate|figure|fs session|patch/.test(n))          return 'freestyle';
  if (/pickup|pick[\s-]up|drop[\s-]in|adult hock|shinny|open hock/.test(n))      return 'pickup';
  if (/stick|shoot|puck/.test(n))                                                  return 'stick';
  if (/public|open skat|general skat|family skat|adult skat|playground on ice|tot|learn to skat|recreational/.test(n)) return 'public';
  return 'other';
}

// ─── SHOULD EXCLUDE? ──────────────────────────────────────────────────────────
function shouldExclude(name, resourceId) {
  if (resourceId === 21) return true;
  const n = (name || '').toLowerCase();
  if (/\bcoach\b|private lesson|inside edge|strength and cond|staff|maintenance|resurfac|rental setup|admin|test event/.test(n)) return true;
  if (/\bleague\b|\btournament\b/.test(n)) return true;
  return false;
}

// ─── PARSE HH:MM from ISO string ─────────────────────────────────────────────
function parseTime(iso) {
  const m = (iso || '').match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

// ─── BUILD REG URL ────────────────────────────────────────────────────────────
function buildRegUrl(company, date, facilityId) {
  let url = `https://apps.daysmartrecreation.com/dash/x/#/online/${company}/event-registration?date=${date}`;
  if (facilityId) url += `&facility_ids=${facilityId}`;
  return url;
}

// ─── BUILD DAYSMART URL ───────────────────────────────────────────────────────
// CRITICAL: do NOT use URLSearchParams — it encodes brackets as %5B%5D
// which DaySmart doesn't recognise. Build the string manually.
function buildUrl(company, date, endDate, facilityId, includeStr) {
  const parts = [
    'cache[save]=false',
    'page[size]=50',
    'sort=end,start',
    `filter[start_date__gte]=${date}`,
    `filter[start_date__lte]=${endDate}`,
    'filter[unconstrained]=1',
    `company=${encodeURIComponent(company)}`,
  ];
  if (includeStr) parts.push(`include=${encodeURIComponent(includeStr)}`);
  if (facilityId) parts.push(`filter[facility_id]=${encodeURIComponent(facilityId)}`);
  return `${DAYSMART_BASE}?${parts.join('&')}`;
}

// ─── NEXT DAY string ─────────────────────────────────────────────────────────
function nextDateStr(date) {
  const [y, m, d] = date.split('-').map(Number);
  const nd = new Date(y, m - 1, d + 1);
  return [nd.getFullYear(), String(nd.getMonth()+1).padStart(2,'0'), String(nd.getDate()).padStart(2,'0')].join('-');
}

// ─── NORMALIZE response JSON → session array ─────────────────────────────────
function normalize(json, company, date, facilityId) {
  const events   = json.data     || [];
  const included = json.included || [];

  // Index included by type::id
  const idx = {};
  for (const item of included) idx[`${item.type}::${item.id}`] = item;

  const sessions = [];

  for (const ev of events) {
    const attrs = ev.attributes || {};
    const rels  = ev.relationships || {};

    // ── Session name: try summary relationship first, then direct attrs ────
    let name = '';
    let openSlots = null;
    let status = 'unknown';

    const sumRel = rels.summary?.data;
    if (sumRel) {
      const sum = idx[`${sumRel.type}::${sumRel.id}`];
      if (sum) {
        const sa = sum.attributes || {};
        name      = sa.name || sa.desc || sa.title || '';
        openSlots = sa.open_slots ?? null;
        status    = sa.registration_status || 'unknown';
      }
    }
    if (!name) name = attrs.desc || attrs.name || attrs.title || '';

    // ── Resource / surface ─────────────────────────────────────────────────
    let surface = null, resourceId = null;
    const resRel = rels.resource?.data;
    if (resRel) {
      resourceId = Number(resRel.id);
      const res  = idx[`${resRel.type}::${resRel.id}`];
      if (res) surface = res.attributes?.name || null;
    }

    // ── Price ──────────────────────────────────────────────────────────────
    let price = null;
    const prodRel = rels['homeTeam.product']?.data || rels.product?.data;
    if (prodRel) {
      const prod = idx[`${prodRel.type}::${prodRel.id}`];
      if (prod) price = prod.attributes?.price ?? null;
    }

    // ── Filter & classify ──────────────────────────────────────────────────
    if (shouldExclude(name, resourceId)) continue;
    const type  = classifySession(name);
    const start = parseTime(attrs.start);
    const end   = parseTime(attrs.end);
    if (!start || !end) continue;

    sessions.push({
      id: ev.id, name, type, label: name,
      start, end,
      price:           price !== null ? Number(price) : null,
      openSlots, status, surface,
      registrationUrl: buildRegUrl(company, date, facilityId),
    });
  }

  sessions.sort((a, b) => a.start.localeCompare(b.start));
  return sessions;
}

// ─── FETCH with retried include strategy ─────────────────────────────────────
// Some DaySmart installs 500 on certain `include` values.
// Strategy: try full include → then minimal include → then no include.
const INCLUDE_STRATEGIES = [
  'summary,resource,homeTeam.league,homeTeam.product,facility.address',
  'summary,resource',
  '',
];

async function fetchDaySmart(company, date, facilityId) {
  const endDate = nextDateStr(date);
  const headers = {
    'Accept': 'application/vnd.api+json, application/json',
    'User-Agent': 'IceTimeHQ/1.0 (+https://icetimehq.com)',
  };

  for (const includeStr of INCLUDE_STRATEGIES) {
    const url = buildUrl(company, date, endDate, facilityId, includeStr);
    console.log(`[schedule] Trying include="${includeStr || 'none'}" → ${url}`);

    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    } catch (err) {
      console.error(`[schedule] Fetch threw: ${err.message}`);
      continue; // try next strategy
    }

    console.log(`[schedule] Status ${res.status} for company=${company} include="${includeStr || 'none'}"`);

    if (res.ok) {
      const json = await res.json();
      const eventCount = (json.data || []).length;
      console.log(`[schedule] Got ${eventCount} events`);
      return { json, includeStr };
    }

    // 500 → try next include strategy
    // 4xx → no point retrying
    if (res.status >= 400 && res.status < 500) {
      const body = await res.text().catch(() => '');
      console.error(`[schedule] ${res.status} error: ${body.slice(0, 200)}`);
      return null;
    }

    // 500 — log and try simpler include
    const errBody = await res.text().catch(() => '');
    console.warn(`[schedule] 500 with include="${includeStr}", trying simpler. Body: ${errBody.slice(0, 150)}`);
  }

  return null; // all strategies failed
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { company, date, facility_id, debug } = req.query;

  if (!company || !date) {
    return res.status(400).json({ error: 'Missing: company, date', sessions: [] });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD', sessions: [] });
  }

  const cacheKey = `${company}::${date}::${facility_id || ''}`;

  // Skip cache in debug mode
  if (!debug) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json({ sessions: hit, source: 'cache' });
    }
  }

  const result = await fetchDaySmart(company, date, facility_id || null);

  if (!result) {
    return res.status(200).json({ sessions: [], error: 'All DaySmart request strategies failed — check Vercel logs' });
  }

  const { json, includeStr } = result;

  // Debug mode: return raw response for inspection
  if (debug === '1') {
    return res.status(200).json({
      _debug: true,
      includeStrategyUsed: includeStr,
      rawEventCount:       (json.data || []).length,
      rawIncludedCount:    (json.included || []).length,
      allIncludedTypes:    [...new Set((json.included || []).map(i => i.type))],
      sampleSummaryNames:  (json.included || [])
        .filter(i => i.type === 'event-summaries')
        .slice(0, 15)
        .map(i => i.attributes?.name || i.attributes?.desc || '(empty)'),
      sampleEvents:        (json.data || []).slice(0, 3),
    });
  }

  const sessions = normalize(json, company, date, facility_id || null);
  console.log(`[schedule] Normalized ${sessions.length} sessions for ${company} on ${date} (include="${includeStr}")`);

  cacheSet(cacheKey, sessions);
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json({ sessions, source: 'live' });
};
