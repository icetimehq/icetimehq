const fs = require("fs");
const path = require("path");

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();
const RINKS_PATH = path.join(process.cwd(), "data", "rinks.json");

function loadRinks() {
  const raw = fs.readFileSync(RINKS_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return parsed.rinks || [];
}

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(key, value) {
  cache.set(key, { ts: Date.now(), value });
}

function toHm(isoLike) {
  if (!isoLike) return "";
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(11, 16);
}

function classifySession(name = "") {
  const v = name.toLowerCase();
  if (/(public|playground on ice|adult skate)/i.test(v)) return "public";
  if (/(stick|shoot|puck)/i.test(v)) return "stick";
  if (/(pickup|pick up|drop-in hockey|adult pickup)/i.test(v)) return "pickup";
  if (/(freestyle|freeskate|figure)/i.test(v)) return "freestyle";
  return "other";
}

function shouldExcludeInternal({ name = "", resourceId, registerCapacity, hteamId }) {
  const internalKeywords = [
    "coach",
    "guest coach",
    "private lesson instructor",
    "inside edge training",
    "strength and conditioning",
  ];
  const lower = String(name).toLowerCase();

  if (String(resourceId) === "21") return true;
  if (internalKeywords.some((x) => lower.includes(x))) return true;
  if ((registerCapacity === 0 || registerCapacity === "0") && (hteamId === null || hteamId === undefined || hteamId === "")) {
    return true;
  }
  return false;
}

function buildRegistrationUrl({ company, date, facilityId }) {
  let url = `https://apps.daysmartrecreation.com/dash/x/#/online/${company}/event-registration?date=${date}`;
  if (facilityId) url += `&facility_ids=${facilityId}`;
  return url;
}

function getIncludedMap(included = [], type) {
  const map = new Map();
  included
    .filter((x) => x.type === type)
    .forEach((x) => map.set(String(x.id), x));
  return map;
}

function normalizeDaySmartEvent(event, maps, rink, date) {
  const attrs = event.attributes || {};
  const relationships = event.relationships || {};

  const resourceId = relationships.resource?.data?.id ?? attrs.resource_id ?? null;
  const summaryId = relationships.summary?.data?.id ?? null;
  const productId = relationships.homeTeam?.data?.id ?? relationships.product?.data?.id ?? null;

  const resource = maps.resources.get(String(resourceId));
  const summary = maps.summaries.get(String(summaryId));
  const product = maps.products.get(String(productId));

  const rawName =
    rink.company === "sdia"
      ? (attrs.desc || summary?.attributes?.name || "")
      : (summary?.attributes?.name || attrs.desc || attrs.name || "");

  const registerCapacity = attrs.register_capacity ?? summary?.attributes?.register_capacity ?? null;
  const hteamId = attrs.hteam_id ?? null;

  if (shouldExcludeInternal({ name: rawName, resourceId, registerCapacity, hteamId })) return null;

  return {
    eventId: String(event.id),
    resourceId: resourceId != null ? String(resourceId) : "",
    facilityId: String(attrs.facility_id ?? relationships.facility?.data?.id ?? ""),
    name: rawName,
    type: classifySession(rawName),
    start: toHm(attrs.start),
    end: toHm(attrs.end),
    price: product?.attributes?.price ?? null,
    openSlots: summary?.attributes?.open_slots ?? null,
    status: summary?.attributes?.registration_status ?? "unknown",
    surface: resource?.attributes?.name || "",
    registrationUrl: buildRegistrationUrl({
      company: rink.company,
      date,
      facilityId: rink.platform === "DS2" ? rink.facility_id : null,
    }),
  };
}

function filterDs2Event(normalized, rink) {
  const facilityOk =
    !rink.facility_id || String(normalized.facilityId) === String(rink.facility_id);

  const allowedResourceIds = (rink.allowed_resource_ids || []).map(String).filter(Boolean);
  const resourceOk =
    allowedResourceIds.length === 0
      ? true
      : allowedResourceIds.includes(String(normalized.resourceId));

  const fallbackSurfaceOk =
    resourceOk ||
    (allowedResourceIds.length === 0 &&
      rink.facility_filter &&
      String(normalized.surface || "").toLowerCase().includes(String(rink.facility_filter).toLowerCase()));

  return facilityOk && fallbackSurfaceOk;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "accept": "application/vnd.api+json, application/json, text/plain, */*",
      "user-agent": "IceTimeHQ/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Fetch failed ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "IceTimeHQ/1.0" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Fetch failed ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

async function fetchDaySmart(rink, date) {
  const params = new URLSearchParams();
  params.set("cache[save]", "false");
  params.set("page[size]", "50");
  params.set("sort", "end,start");
  params.set("include", "summary,resource,homeTeam.league,homeTeam.product,facility.address");
  params.set("filter[start_date__gte]", date);
  const nextDate = new Date(`${date}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  params.set("filter[start_date__lte]", nextDate.toISOString().slice(0, 10));
  params.set("filter[unconstrained]", "1");
  params.set("company", rink.company);

  if (rink.facility_id) {
    params.set("filter[facility_id]", String(rink.facility_id));
  }

  const url = `https://apps.daysmartrecreation.com/dash/jsonapi/api/v1/events?${params.toString()}`;
  const cacheKey = `daysmart:${rink.rink_id}:${date}:${rink.company}:${rink.facility_id || ""}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const payload = await fetchJson(url);
  const maps = {
    summaries: getIncludedMap(payload.included, "event-summaries"),
    resources: getIncludedMap(payload.included, "resources"),
    products: getIncludedMap(payload.included, "products"),
  };

  let sessions = (payload.data || [])
    .map((event) => normalizeDaySmartEvent(event, maps, rink, date))
    .filter(Boolean);

  if (rink.platform === "DS2") {
    sessions = sessions.filter((s) => filterDs2Event(s, rink));
  }

  setCache(cacheKey, sessions);
  return sessions;
}

function parseIcsDate(icsValue) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(icsValue || "");
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

function unfoldIcs(text) {
  return text.replace(/\r?\n[ \t]/g, "");
}

function parseIcsEvents(text) {
  const blocks = unfoldIcs(text).split("BEGIN:VEVENT").slice(1);
  return blocks.map((block) => {
    const event = {};
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("END:VEVENT")) break;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).split(";")[0];
      const value = line.slice(idx + 1);
      event[key] = value;
    }
    return event;
  });
}

async function fetchRockville(rink, date) {
  const cacheKey = `rockville:${rink.rink_id}:${date}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const ics = await fetchText(rink.ical_url);
  const events = parseIcsEvents(ics);
  const sessions = events
    .filter((evt) => {
      const start = parseIcsDate(evt.DTSTART);
      return start && start.toISOString().slice(0, 10) === date;
    })
    .map((evt, idx) => {
      const start = parseIcsDate(evt.DTSTART);
      const end = parseIcsDate(evt.DTEND);
      const name = evt.SUMMARY || "";
      return {
        eventId: evt.UID || String(idx),
        resourceId: "",
        facilityId: "",
        name,
        type: classifySession(name),
        start: start ? start.toISOString().slice(11, 16) : "",
        end: end ? end.toISOString().slice(11, 16) : "",
        price: null,
        openSlots: null,
        status: "unknown",
        surface: "",
        registrationUrl: rink.website || "",
      };
    });

  setCache(cacheKey, sessions);
  return sessions;
}

function stripHtml(value = "") {
  return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function to24h(value = "") {
  const m = /(\d{1,2}):?(\d{2})?\s*([AP])/i.exec(value);
  if (!m) return value;
  let hh = parseInt(m[1], 10);
  const mm = m[2] || "00";
  const ap = m[3].toUpperCase();
  if (ap === "P" && hh !== 12) hh += 12;
  if (ap === "A" && hh === 12) hh = 0;
  return `${String(hh).padStart(2, "0")}:${mm}`;
}

async function fetchFrontline(rink, date) {
  const cacheKey = `frontline:${rink.rink_id}:${date}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const html = await fetchText(rink.frontline.schedule_url);
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const sessions = [];

  for (const [_, rowHtml] of rows) {
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripHtml(m[1]));
    if (cells.length < 2) continue;

    const dateLike = cells.find((c) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(c));
    if (dateLike && !dateLike.includes(date.slice(5).replace("-", "/"))) {
      continue;
    }

    const timeCell = cells.find((c) => /\d/.test(c) && /[AP]/i.test(c));
    const nameCell = cells.find((c) => /public|pickup|pick up|stick|hockey|freestyle|figure|skate/i.test(c)) || cells[1];

    if (!timeCell || !nameCell) continue;

    const timeParts = timeCell.split(/\s*-\s*/);
    const start = to24h(timeParts[0] || "");
    const end = to24h(timeParts[1] || "");

    sessions.push({
      eventId: `${rink.rink_id}-${sessions.length + 1}`,
      resourceId: "",
      facilityId: "",
      name: nameCell,
      type: classifySession(nameCell),
      start,
      end,
      price: null,
      openSlots: null,
      status: "unknown",
      surface: "",
      registrationUrl: rink.frontline.schedule_url,
    });
  }

  setCache(cacheKey, sessions);
  return sessions;
}

async function resolveRink({ rinkId, company }) {
  const rinks = loadRinks();
  if (rinkId) return rinks.find((r) => r.rink_id === rinkId) || null;
  if (company) return rinks.find((r) => r.company === company) || null;
  return null;
}

module.exports = async function handler(req, res) {
  const date = req.query.date;
  const rinkId = req.query.rink_id || req.query.rinkId;
  const company = req.query.company;

  if (!date) {
    return res.status(400).json({ error: true, message: "date is required" });
  }

  try {
    const rink = await resolveRink({ rinkId, company });

    if (!rink) {
      return res.status(404).json({ error: true, message: "Rink not found in rinks.json" });
    }

    let sessions = [];
    if (rink.platform === "DS1" || rink.platform === "DS2") {
      sessions = await fetchDaySmart(rink, date);
    } else if (rink.platform === "ROCKVILLE_ICAL") {
      sessions = await fetchRockville(rink, date);
    } else if (rink.platform === "FL1") {
      sessions = await fetchFrontline(rink, date);
    } else {
      return res.status(400).json({ error: true, message: `Unsupported platform: ${rink.platform}` });
    }

    return res.status(200).json({
      error: false,
      rink_id: rink.rink_id,
      platform: rink.platform,
      resourceFilterStrict: rink.platform !== "DS2" ? null : (rink.allowed_resource_ids || []).length > 0,
      sessions,
    });
  } catch (err) {
    console.error("schedule handler failed", err);
    return res.status(200).json({
      error: true,
      message: err.message,
      sessions: [],
    });
  }
};
