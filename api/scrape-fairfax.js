// api/scrape-fairfax.js
// Fairfax Ice Arena – static schedule scraper
// Source: fairfaxicearena.com/public-skate-hours.html
// CommonJS (module.exports) — required for Vercel without "type":"module"

const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000;

// ─── Seasonal schedules (last verified 2026-03) ───────────────────────────────
// 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
const SEASONS = [
  {
    name: 'winter',
    applies: (m, d) => m >= 11 || m <= 3,
    schedule: {
      1: [['11:15','13:15']],
      2: [['11:15','13:15'],['17:15','18:30'],['20:30','21:45']],
      3: [['11:15','13:15'],['17:15','18:30'],['20:30','21:45']],
      4: [['11:15','13:15'],['17:15','18:30'],['20:30','21:45']],
      5: [['11:15','13:15'],['17:15','18:30'],['20:30','22:00']],
      6: [['12:00','15:00'],['20:30','22:00']],
      0: [['12:00','15:00']],
    },
    weekendStart: { day: 5, hour: 20, min: 30 },
  },
  {
    name: 'spring',
    applies: (m, d) => (m === 4) || (m === 5) || (m === 6 && d <= 19),
    schedule: {
      1: [['11:15','13:15']],
      2: [['11:15','13:15'],['17:15','18:30'],['20:30','21:45']],
      3: [['11:15','13:15'],['17:15','18:30'],['20:30','21:45']],
      4: [['11:15','13:15'],['17:15','18:30'],['20:30','21:45']],
      5: [['11:15','13:15'],['17:15','18:30'],['20:30','22:30']],
      6: [['12:00','15:45'],['20:30','22:30']],
      0: [['12:00','15:45']],
    },
    weekendStart: { day: 5, hour: 20, min: 30 },
  },
  {
    name: 'summer',
    applies: (m, d) => (m === 6 && d >= 22) || (m >= 7 && m <= 10),
    schedule: {
      1: [['11:15','13:15']],
      2: [['11:15','13:15'],['17:15','18:30'],['20:30','21:45']],
      3: [['11:15','13:15'],['17:15','18:30'],['20:30','21:45']],
      4: [['11:15','13:15'],['17:15','18:30'],['20:30','21:45']],
      5: [['11:15','13:15'],['17:15','18:30'],['20:30','22:00']],
      6: [['12:00','15:00'],['20:30','22:00']],
      0: [['12:00','15:00']],
    },
    weekendStart: { day: 5, hour: 20, min: 30 },
  },
];

// Holiday overrides (2026). null = no session that day.
const HOLIDAY_OVERRIDES = {
  '2026-05-02': [['20:30','22:00']],
  '2026-05-03': null,
  '2026-05-25': [['11:15','13:15']],
  '2026-07-04': [['12:00','15:00']],
};

function isWeekendSession(season, dow, startHour, startMin) {
  const ws = season.weekendStart;
  if (dow === 0 || dow === 6) return true;
  if (dow === ws.day) {
    return startHour > ws.hour || (startHour === ws.hour && startMin >= ws.min);
  }
  return false;
}

function buildSessions(dateStr, slots, season, dow) {
  return slots.map(([s, e]) => {
    const [sh, sm] = s.split(':').map(Number);
    const weekend = isWeekendSession(season, dow, sh, sm);
    return {
      name:            'Public Skate',
      type:            'public',
      label:           'Public Skate',
      start:           s,
      end:             e,
      price:           weekend ? 11.00 : 10.00,
      openSlots:       null,
      status:          'available',
      surface:         'Ice',
      registrationUrl: 'https://www.fairfaxicearena.com/public-skate-hours.html',
    };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date param required: YYYY-MM-DD', sessions: [] });
  }

  const cacheKey = `fairfax:${date}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  try {
    const [year, month, day] = date.split('-').map(Number);
    const dow = new Date(year, month - 1, day).getDay();

    // Holiday override
    if (Object.prototype.hasOwnProperty.call(HOLIDAY_OVERRIDES, date)) {
      const slots = HOLIDAY_OVERRIDES[date];
      if (!slots) {
        cache.set(cacheKey, { ts: Date.now(), data: [] });
        return res.status(200).json([]);
      }
      const season = SEASONS.find(s => s.applies(month, day)) || SEASONS[0];
      const result = buildSessions(date, slots, season, dow);
      cache.set(cacheKey, { ts: Date.now(), data: result });
      return res.status(200).json(result);
    }

    const season = SEASONS.find(s => s.applies(month, day));
    if (!season) {
      return res.status(200).json([]);
    }

    const slots = season.schedule[dow];
    if (!slots || slots.length === 0) {
      cache.set(cacheKey, { ts: Date.now(), data: [] });
      return res.status(200).json([]);
    }

    const result = buildSessions(date, slots, season, dow);
    cache.set(cacheKey, { ts: Date.now(), data: result });
    return res.status(200).json(result);

  } catch (err) {
    console.error('scrape-fairfax error:', err);
    return res.status(500).json({ error: 'Failed to build Fairfax schedule', sessions: [] });
  }
};
