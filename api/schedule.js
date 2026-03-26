// /api/schedule.js — IceTimeHQ DaySmart Proxy
// v5 — noise filtering, name cleanup, deduplication
// CommonJS (module.exports) — required for Vercel without "type":"module"

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

// ─── CLEAN SESSION NAME ───────────────────────────────────────────────────────
// 1. Strip trailing date ranges:  "PI – Stick Time (3/23-3/29)" → "PI – Stick Time"
// 2. Strip facility prefix codes: "PI – Stick Time" → "Stick Time"
function cleanName(raw) {
  let n = (raw || '').trim();
  n = n.replace(/\s*\(\d{1,2}\/\d{1,2}[-–]\d{1,2}\/\d{1,2}\)\s*$/, '').trim();  // strip (3/23-3/29)
  n = n.replace(/^[A-Z]{2,5}\s*[-–]\s*/, '').trim();                               // strip "PI – " / "KHS – "
  return n;
}

// ─── CLASSIFY by cleaned session name ────────────────────────────────────────
function classifySession(name) {
  const n = name.toLowerCase();
  if (/freestyle|freeskate|free skate|figure|fs session|patch/.test(n))                             return 'freestyle';
  if (/pick[\s-]?up|drop[\s-]in|adult hock|open hock/.test(n))                                      return 'pickup';
  if (/stick|shoot|puck|stick time|sticktime/.test(n))                                              return 'stick';
  if (/public|open skat|general skat|family skat|adult skat|playground on ice|recreational/.test(n)) return 'public';
  return 'other';
}

// ─── EXCLUSION LIST ───────────────────────────────────────────────────────────
// All keyword checks run on the CLEANED name (lowercase).
const EXCLUDE_KEYWORDS = [
  // Lesson programs
  'learn to skate', 'lts', 'learn-to-skate',
  // Games / league
  ' vs ', 'league game', 'tournament',
  // Team practices / shinny
  'duck shin', 'shinny',
  // Goalie-only
  'goalie',
  // Programs / camps
  'camp', 'clinic',
  // Private / internal
  'private', 'rental', 'staff', 'maintenance', 'resurfac', 'admin', 'test event',
  // Coaching
  'coach', 'private lesson', 'inside edge', 'strength and cond',
];

function shouldExclude(cleanedName, resourceId) {
  // Ashburn private coach resource
  if (resourceId === 21) return true;

  const n = cleanedName.toLowerCase();
  if (EXCLUDE_KEYWORDS.some(kw => n.includes(kw))) return true;

  return false;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function parseTime(iso) {
  const m = (iso || '').match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function buildRegUrl(company, date, facilityId) {
  let url = `https://apps.daysmartrecreation.com/dash/x/#/online/${company}/event-registration?date=${date}`;
  if (facilityId) url += `&facility_ids=${facilityId}`;
  return url;
}

function nextDateStr(date) {
  const [y, m, d] = date.split('-').map(Number);
  const nd = new Date(y, m - 1, d + 1);
  return [
    nd.getFullYear(),
    String(nd.getMonth() + 1).padStart(2, '0'),
    String(nd.getDate()).padStart(2, '0'),
  ].join('-');
}

// ─── BUILD URL (manual — never use URLSearchParams, it encodes brackets) ─────
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

// ─── NORMALIZE ───────────────────────────────────────────────────────────────
function normalize(json, company, date, facilityId) {
  const events   = json.data     || [];
  const included = json.included || [];

  const idx = {};
  for (const item of included) idx[`${item.type}::${item.id}`] = item;

  const sessions = [];

  for (const ev of events) {
    const attrs = ev.attributes || {};
    const rels  = ev.relationships || {};

    // ── Raw session name ──────────────────────────────────────────────────
    let rawName = '';
    let openSlots = null;
    let status = 'unknown';

    const sumRel = rels.summary?.data;
    if (sumRel) {
      const sum = idx[`${sumRel.type}::${sumRel.id}`];
      if (sum) {
        const sa  = sum.attributes || {};
        rawName   = sa.name || sa.desc || sa.title || '';
        openSlots = sa.open_slots ?? null;
        status    = sa.registration_status || 'unknown';
      }
    }
    if (!rawName) rawName = attrs.desc || attrs.name || attrs.title || '';

    // ── Clean the name ────────────────────────────────────────────────────
    const name = cleanName(rawName);

    // ── Resource / surface ────────────────────────────────────────────────
    let surface = null, resourceId = null;
    const resRel = rels.resource?.data;
    if (resRel) {
      resourceId = Number(resRel.id);
      const res  = idx[`${resRel.type}::${resRel.id}`];
      if (res) surface = res.attributes?.name || null;
    }

    // ── Price ─────────────────────────────────────────────────────────────
    let price = null;
    const prodRel = rels['homeTeam.product']?.data || rels.product?.data;
    if (prodRel) {
      const prod = idx[`${prodRel.type}::${prodRel.id}`];
      if (prod) price = prod.attributes?.price ?? null;
    }

    // ── Exclude & classify ────────────────────────────────────────────────
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

  // Sort by start time
  sessions.sort((a, b) => a.start.localeCompare(b.start));

  // ── Deduplicate same-time/surface/type (Part 3 Fix 3) ────────────────────
  const seen = new Set();
  const deduped = sessions.filter(s => {
    const key = `${s.start}::${s.end}::${s.surface || ''}::${s.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[schedule] ${company} ${date}: raw=${events.length} kept=${deduped.length}`);
  return deduped;
}

// ─── FETCH (tries include strategies until one works) ─────────────────────────
const INCLUDE_STRATEGIES = [
  'summary,resource,homeTeam.league,homeTeam.product,facility.address',
  'summary,resource',
  '',
];

async function fetchDaySmart(company, date, facilityId) {
  const endDate = nextDateStr(date);
  const headers = {
    'Accept':     'application/vnd.api+json, application/json',
    'User-Agent': 'IceTimeHQ/1.0 (+https://icetimehq.com)',
  };

  for (const includeStr of INCLUDE_STRATEGIES) {
    const url = buildUrl(company, date, endDate, facilityId, includeStr);
    console.log(`[schedule] Fetching company=${company} include="${includeStr || 'none'}"`);

    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    } catch (err) {
      console.error(`[schedule] Fetch error: ${err.message}`);
      continue;
    }

    console.log(`[schedule] Status ${res.status} company=${company}`);

    if (res.ok) {
      const json = await res.json();
      console.log(`[schedule] Raw events: ${(json.data || []).length}`);
      return { json, includeStr };
    }

    if (res.status >= 400 && res.status < 500) {
      const body = await res.text().catch(() => '');
      console.error(`[schedule] ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const errBody = await res.text().catch(() => '');
    console.warn(`[schedule] 500 with include="${includeStr}" — trying simpler. ${errBody.slice(0, 100)}`);
  }

  return null;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
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

  if (!debug) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json({ sessions: hit, source: 'cache' });
    }
  }

  const result = await fetchDaySmart(company, date, facility_id || null);

  if (!result) {
    return res.status(200).json({
      sessions: [],
      error: 'All DaySmart strategies failed — check Vercel logs',
    });
  }

  const { json, includeStr } = result;

  // Debug mode — inspect raw DaySmart response
  if (debug === '1') {
    return res.status(200).json({
      _debug: true,
      includeStrategyUsed: includeStr,
      rawEventCount:       (json.data || []).length,
      allIncludedTypes:    [...new Set((json.included || []).map(i => i.type))],
      sampleSummaryNames:  (json.included || [])
        .filter(i => i.type === 'event-summaries')
        .slice(0, 20)
        .map(i => ({
          raw:     i.attributes?.name || i.attributes?.desc || '(empty)',
          cleaned: cleanName(i.attributes?.name || i.attributes?.desc || ''),
          type:    classifySession(cleanName(i.attributes?.name || i.attributes?.desc || '')),
        })),
      sampleEvents: (json.data || []).slice(0, 3),
    });
  }

  const sessions = normalize(json, company, date, facility_id || null);
  cacheSet(cacheKey, sessions);
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json({ sessions, source: 'live' });
};
