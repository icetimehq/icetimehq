// api/scrape-kroc.js
// Kroc Center Ice — San Diego (Salvation Army)
// Platform: Salesforce Community Cloud (sd.kroccommunity.org)
// CommonJS (module.exports) — required for Vercel without "type":"module"
//
// Strategy: Attempt live fetch from Salesforce Community page.
// If blocked (React/LWC rendered, XHR-only data), falls back to
// static weekly schedule hardcoded from the website.
//
// Developer note: If live fetch consistently returns null, open DevTools on
// sd.kroccommunity.org/s/registration?program=Public%20Ice%20Skating,
// find XHR calls to sd.kroccommunity.org/s/sfsites/aura or similar,
// and update fetchSalesforceSchedule() accordingly.

// Uses native fetch (Node.js 18+ / Vercel runtime)

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Static fallback schedule ──────────────────────────────────────────────────
// Source: sd.kroccenter.org/kroc-san-diego/public-skate/ (March 2026)
// Public skate: $24 general ($20 members). Skate rental included.
// Times are approximate recurring patterns — actual schedule varies week to week.
const FALLBACK_SCHEDULE = {
  0: [['13:00','15:00']],                              // Sun
  1: [['15:00','17:00']],                              // Mon
  2: [],                                               // Tue
  3: [['15:00','17:00']],                              // Wed
  4: [],                                               // Thu
  5: [['15:00','17:00']],                              // Fri
  6: [['12:00','14:00'], ['15:00','17:00']],           // Sat
};

// ── Live Salesforce fetch attempt ─────────────────────────────────────────────
async function fetchSalesforceSchedule(date) {
  const url = `https://sd.kroccommunity.org/s/registration?` +
    `program=Public%20Ice%20Skating&date=${date}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; IceTimeHQ/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return null;

  const html = await res.text();

  // Look for time ranges in HTML: "10:00 AM – 12:00 PM" etc.
  const timePattern = /(\d{1,2}:\d{2}\s?(?:AM|PM))\s*[–\-]\s*(\d{1,2}:\d{2}\s?(?:AM|PM))/gi;
  const matches = [...html.matchAll(timePattern)];
  if (matches.length === 0) return null;

  function to24h(t) {
    const [time, period] = t.trim().split(/\s+/);
    let [h, m] = time.split(':').map(Number);
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  return matches.map(([, start, end]) => [to24h(start), to24h(end)]);
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

  const cacheKey = `kroc:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ sessions: cached.data, source: 'cache' });
  }

  const dow = new Date(date + 'T12:00:00').getDay();

  let slots = null;
  try {
    slots = await fetchSalesforceSchedule(date);
  } catch (_) {
    // Salesforce blocked or timed out — use fallback
  }

  if (!slots || slots.length === 0) {
    slots = FALLBACK_SCHEDULE[dow] || [];
  }

  const sessions = slots.map(([startT, endT]) => ({
    name:            'Public Skate',
    type:            'public',
    label:           'Public Skate',
    start:           startT,
    end:             endT,
    price:           24.00,
    openSlots:       null,
    status:          'available',
    surface:         'Ice',
    registrationUrl: 'https://sd.kroccommunity.org/s/registration?program=Public%20Ice%20Skating',
  }));

  cache.set(cacheKey, { ts: Date.now(), data: sessions });
  return res.status(200).json({ sessions, source: slots === (FALLBACK_SCHEDULE[dow] || []) ? 'fallback' : 'live' });
};
