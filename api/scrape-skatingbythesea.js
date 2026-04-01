// api/scrape-skatingbythesea.js
// Skating by the Sea — Hotel del Coronado, Coronado CA
// SEASONAL ONLY: runs Nov 21 – Jan 4 each year (outdoor beachfront rink).
// No API. Schedule hardcoded from hoteldel.com each season.
// Returns [] for any date outside the season window.
// CommonJS (module.exports) — required for Vercel without "type":"module"
//
// Update SEASON each October when Hotel del Coronado announces next season dates.

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ── Season definition ─────────────────────────────────────────────────────────
// 2025-26 season: Nov 21, 2025 – Jan 4, 2026
// Source: https://www.hoteldel.com/events/skating-by-the-sea/
const SEASONS = [
  {
    start: '2025-11-21',
    end:   '2026-01-04',
    price: 40.00,
    registrationUrl: 'https://www.hoteldel.com/events/skating-by-the-sea/',
    getSlots(dateStr) {
      const d   = new Date(dateStr + 'T12:00:00');
      const dow = d.getDay(); // 0=Sun … 6=Sat
      const [y, m, day] = dateStr.split('-').map(Number);

      // Phase 1: Nov 21–30 2025 (Thanksgiving week, daily)
      if (y === 2025 && m === 11 && day >= 21 && day <= 30) {
        if (day === 21) return [['14:00', '22:00']]; // Opening Fri: 2pm–10pm
        return [['10:00', '22:00']];                  // Daily 10am–10pm
      }

      // Phase 2: Dec 1–18 2025
      if (y === 2025 && m === 12 && day >= 1 && day <= 18) {
        if (day === 1) return [['18:00', '22:00']];           // Dec 1 opens 6pm
        if (dow === 5) return [['14:00', '22:00']];           // Fri: 2pm–10pm
        if (dow === 0 || dow === 6) return [['10:00', '22:00']]; // Sat/Sun
        return [['16:00', '22:00']];                           // Mon–Thu: 4pm–10pm
      }

      // Phase 3: Dec 19 2025 – Jan 4 2026
      if ((y === 2025 && m === 12 && day >= 19) ||
          (y === 2026 && m === 1  && day <= 4)) {
        return [['10:00', '22:00']]; // Daily 10am–10pm
      }

      return [];
    },
  },
  // Add 2026-27 season here each October when dates are announced:
  // { start: '2026-11-XX', end: '2027-01-XX', price: XX, getSlots(dateStr) { ... } }
];

// ── Find matching season ──────────────────────────────────────────────────────
function findSeason(date) {
  return SEASONS.find(s => date >= s.start && date <= s.end) || null;
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

  const cacheKey = `skatingbythesea:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ sessions: cached.data, source: 'cache' });
  }

  const season = findSeason(date);

  if (!season) {
    // Off-season: return empty (rink doesn't exist Nov–Jan is the only time)
    cache.set(cacheKey, { ts: Date.now(), data: [] });
    return res.status(200).json({ sessions: [], source: 'off-season' });
  }

  const slots = season.getSlots(date);
  const sessions = slots.map(([startT, endT]) => ({
    name:            'Public Skate',
    type:            'public',
    label:           'Public Skate',
    start:           startT,
    end:             endT,
    price:           season.price,
    openSlots:       null,
    status:          'available',
    surface:         'Ice (Outdoor)',
    registrationUrl: season.registrationUrl,
  }));

  cache.set(cacheKey, { ts: Date.now(), data: sessions });
  return res.status(200).json({ sessions, source: 'static' });
};
