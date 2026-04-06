/**
 * Frontend routing update for Sprint 9.
 * Keep the frontend thin: send rink_id + date to /api/schedule
 * and let the backend select the correct platform from rinks.json.
 */

export const SCRAPER_MAP = {
  DS1: ({ rinkId, date }) => `/api/schedule?rink_id=${encodeURIComponent(rinkId)}&date=${encodeURIComponent(date)}`,
  DS2: ({ rinkId, date }) => `/api/schedule?rink_id=${encodeURIComponent(rinkId)}&date=${encodeURIComponent(date)}`,
  ROCKVILLE_ICAL: ({ rinkId, date }) => `/api/schedule?rink_id=${encodeURIComponent(rinkId)}&date=${encodeURIComponent(date)}`,
  FL1: ({ rinkId, date }) => `/api/schedule?rink_id=${encodeURIComponent(rinkId)}&date=${encodeURIComponent(date)}`,
};

export async function fetchRinkSchedule(rink, selectedDate) {
  const routeBuilder = SCRAPER_MAP[rink.platform];
  if (!routeBuilder) return rink.schedule || [];

  const url = routeBuilder({ rinkId: rink.rink_id, date: selectedDate });
  const res = await fetch(url);
  const payload = await res.json();

  if (!res.ok || payload.error || !Array.isArray(payload.sessions) || payload.sessions.length === 0) {
    return rink.schedule || [];
  }

  return payload.sessions;
}
