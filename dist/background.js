// src/core/dates.ts
var WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
];
function isWeekday(value) {
  return WEEKDAY_NAMES.includes(value);
}
function toLocalISODate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
function localWeekday(date, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(date).toLowerCase();
  if (!isWeekday(name)) throw new Error(`Unexpected weekday from Intl: "${name}"`);
  return name;
}
function datesToBook({
  weekdays,
  horizonDays = 14,
  skipDates = [],
  timeZone = "Europe/Prague",
  now = /* @__PURE__ */ new Date()
}) {
  const wanted = /* @__PURE__ */ new Set();
  for (const raw of weekdays) {
    const name = raw.toLowerCase();
    if (!isWeekday(name)) throw new Error(`Not a weekday name: "${raw}"`);
    wanted.add(name);
  }
  const skip = new Set(skipDates);
  const out = [];
  for (let offset = 0; offset <= horizonDays; offset += 1) {
    const day = new Date(now.getTime() + offset * 864e5);
    const iso = toLocalISODate(day, timeZone);
    if (!wanted.has(localWeekday(day, timeZone))) continue;
    if (skip.has(iso)) continue;
    out.push(iso);
  }
  return out;
}

// src/core/config.ts
var SLOT_TIMES = {
  all_day: { start: "00:00:00.000Z", end: "23:59:59.000Z" },
  morning: { start: "00:00:00.000Z", end: "12:00:00.000Z" },
  afternoon: { start: "12:00:00.000Z", end: "23:59:59.000Z" }
};
var DEFAULT_SETTINGS = {
  // ⬆ BUMP THIS whenever you correct the `endpoint` block below, otherwise
  // anyone who already pressed Save keeps their stale copy forever.
  endpointVersion: 3,
  enabled: false,
  // Empty on purpose. Shipping a real desk number as the default means the
  // first person to install this and press Book now takes somebody else's
  // seat, having done nothing wrong. Nothing runs until a desk is chosen.
  deskName: "",
  deskId: "",
  floorId: 4952,
  buildingId: 5151,
  weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  slot: "all_day",
  horizonDays: 14,
  skipDates: [],
  timeZone: "Europe/Prague",
  endpoint: {
    apiBase: "https://my.comeen.io/api",
    auth: { mode: "cookie" },
    resolve: {
      method: "GET",
      path: "/v1/floors/{{floorId}}/desks_schedule.json",
      query: {
        start_date: "{{from}}T00:00:00.000Z",
        end_date: "{{to}}T23:59:59.000Z"
      }
    },
    deskNameFields: ["name", "sync_id"],
    deskIdFields: ["uuid", "id"],
    deskScheduleField: "schedule",
    deskScheduleDateFields: ["start_datetime", "start_date", "date", "day", "start"],
    list: {
      method: "GET",
      path: "/v1/users/me/work_activity_schedule.json",
      query: {
        start_date: "{{from}}T00:00:00.000Z",
        end_date: "{{to}}T23:59:59.000Z"
      }
    },
    listRoot: "schedule",
    listShape: "dateKeyedMap",
    listDateFields: ["start_datetime", "date"],
    userIdPath: "user.id",
    create: {
      method: "POST",
      // The `me` alias works for reads; the app itself uses the numeric
      // id to write, so that is what is used here.
      path: "/v1/users/{{userId}}/work_activity_schedule.json",
      body: {
        work_activity: {
          state: "on_site",
          start_datetime: "{{date}}T{{startTime}}",
          end_datetime: "{{date}}T{{endTime}}"
        },
        presence: {
          building_id: "{{buildingId}}",
          floor_id: "{{floorId}}",
          area_id: "{{areaId}}"
        },
        desk_booking: { desk_uuid: "{{deskId}}" }
      }
    }
  }
};
var DESK_NAME_PATTERN = /^\d+-\d+$/;
function isValidDeskName(name) {
  return DESK_NAME_PATTERN.test(name.trim());
}
function mergeSettings(stored) {
  const storedVersion = stored?.endpointVersion ?? 0;
  const shippedIsNewer = storedVersion < DEFAULT_SETTINGS.endpointVersion;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    endpointVersion: DEFAULT_SETTINGS.endpointVersion,
    endpoint: shippedIsNewer || !stored?.endpoint ? DEFAULT_SETTINGS.endpoint : stored.endpoint
  };
}
async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  return mergeSettings(stored.settings);
}
async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

// src/injected.ts
async function bookInPage(args) {
  const { endpoint, dates, deskName, slot, startTime, endTime, dryRun } = args;
  const notes = [];
  const rows = [];
  let deskId = args.deskId;
  let resolvedDeskId;
  let signedOut = false;
  const takenDates = /* @__PURE__ */ new Set();
  const vars = {
    deskName,
    slot,
    startTime,
    endTime,
    floorId: String(args.floorId),
    buildingId: String(args.buildingId),
    from: dates[0] ?? "",
    to: dates[dates.length - 1] ?? ""
  };
  const diagnostics = () => ({
    url: window.location.href,
    localStorageKeys: (() => {
      try {
        return Object.keys(window.localStorage);
      } catch {
        return ["<unreadable>"];
      }
    })(),
    cookieNames: (() => {
      try {
        return document.cookie.split(";").map((pair) => pair.split("=")[0]?.trim() ?? "").filter(Boolean);
      } catch {
        return ["<unreadable>"];
      }
    })()
  });
  const fill = (value, source) => {
    if (typeof value === "string") {
      const whole = /^\{\{(\w+)\}\}$/.exec(value);
      if (whole) {
        const replacement = source[whole[1] ?? ""];
        if (replacement === void 0) return value;
        return /^-?\d+$/.test(replacement) ? Number(replacement) : replacement;
      }
      return value.replace(/\{\{(\w+)\}\}/g, (match, key) => source[key] ?? match);
    }
    if (Array.isArray(value)) return value.map((entry) => fill(entry, source));
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, entry] of Object.entries(value)) out[key] = fill(entry, source);
      return out;
    }
    return value;
  };
  const dig = (obj, path) => path.split(".").reduce((current, key) => current && typeof current === "object" ? current[key] : void 0, obj);
  const authHeaders = () => {
    if (endpoint.auth.mode !== "localStorage") return {};
    const { storageKey, jsonPath, header, prefix } = endpoint.auth;
    if (!storageKey || !jsonPath) {
      notes.push("auth.mode is localStorage but storageKey/jsonPath are missing.");
      return {};
    }
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      notes.push(`localStorage key "${storageKey}" not found. Are you signed in?`);
      return {};
    }
    let token;
    try {
      token = dig(JSON.parse(raw), jsonPath);
    } catch {
      notes.push(`localStorage key "${storageKey}" is not JSON.`);
      return {};
    }
    if (typeof token !== "string" || !token) {
      notes.push(`No token at path "${jsonPath}".`);
      return {};
    }
    return { [header ?? "authorization"]: `${prefix ?? "Bearer "}${token}` };
  };
  const call = async (tpl, source) => {
    const path = fill(tpl.path, source);
    const url = new URL(`${endpoint.apiBase.replace(/\/$/, "")}${path}`);
    for (const [key, value] of Object.entries(fill(tpl.query ?? {}, source))) {
      url.searchParams.set(key, String(value));
    }
    const body = tpl.body === void 0 ? void 0 : JSON.stringify(fill(tpl.body, source));
    const res = await window.fetch(url.toString(), {
      method: tpl.method,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...body === void 0 ? {} : { "content-type": "application/json" },
        ...authHeaders()
      },
      body
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    let finalHost = "";
    try {
      finalHost = new URL(res.url).hostname;
    } catch {
    }
    const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
    const signedOut2 = res.status === 401 || res.status === 403 || /(^|\.)accounts\.comeen\.io$/.test(finalHost) || looksLikeHtml && data === null;
    return { ok: res.ok, status: res.status, data, text, signedOut: signedOut2 };
  };
  const signedOutResult = () => ({
    rows: [],
    notes: ["Not signed in to Comeen. Open https://my.comeen.io/, sign in, then run again."],
    diagnostics: diagnostics(),
    signedOut: true
  });
  const asList = (data) => {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      const obj = data;
      for (const key of ["items", "data", "results", "bookings", "desks"]) {
        if (Array.isArray(obj[key])) return obj[key];
      }
    }
    return [];
  };
  const normalise = (value) => String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  const looksTaken = (status, text) => status === 409 || status === 422 || /taken|already|unavailable|occupied|full|conflict/i.test(text);
  if (endpoint.resolve) {
    const res = await call(endpoint.resolve, vars);
    if (res.signedOut) return signedOutResult();
    if (!res.ok) {
      return {
        rows: [],
        notes: [`Desk lookup failed (${res.status}): ${res.text.slice(0, 200)}`],
        diagnostics: diagnostics()
      };
    }
    const candidates = asList(res.data);
    const match = candidates.find((desk) => endpoint.deskNameFields.some((field) => normalise(desk[field]) === normalise(deskName)));
    if (!match) {
      return {
        rows: [],
        notes: [
          `No desk called "${deskName}" in ${candidates.length} search result(s).`,
          `First few: ${JSON.stringify(candidates.slice(0, 3)).slice(0, 400)}`
        ],
        diagnostics: diagnostics()
      };
    }
    const idField = endpoint.deskIdFields.find((field) => match[field] !== void 0 && match[field] !== null);
    if (!idField) {
      return {
        rows: [],
        notes: [
          `Found "${deskName}" but none of ${endpoint.deskIdFields.join("/")} held an id.`,
          `Record: ${JSON.stringify(match).slice(0, 400)}`
        ],
        diagnostics: diagnostics()
      };
    }
    deskId = String(match[idField]);
    resolvedDeskId = deskId;
    notes.push(`Resolved "${deskName}" to ${idField} ${deskId}.`);
    if (match.area_id !== void 0 && match.area_id !== null) vars.areaId = String(match.area_id);
    if (match.floor_id !== void 0 && match.floor_id !== null) vars.floorId = String(match.floor_id);
    if (match.available_to_booking === false) {
      notes.push(`\u26A0 "${deskName}" is marked not available to booking \u2014 it may be assigned to someone.`);
    }
    if (endpoint.deskScheduleField) {
      const entries = match[endpoint.deskScheduleField];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          for (const field of endpoint.deskScheduleDateFields) {
            const value = entry[field];
            if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
              takenDates.add(value.slice(0, 10));
              break;
            }
          }
        }
        if (takenDates.size > 0) {
          notes.push(`"${deskName}" already has ${takenDates.size} day(s) booked in this window.`);
        }
      }
    }
  }
  if (!deskId) {
    return {
      rows: [],
      notes: ["No desk ID set and no desk-search endpoint configured."],
      diagnostics: diagnostics()
    };
  }
  vars.deskId = deskId;
  const heldDates = /* @__PURE__ */ new Set();
  if (endpoint.list) {
    const res = await call(endpoint.list, vars);
    if (res.signedOut) return signedOutResult();
    if (!res.ok) {
      notes.push(
        `Could not list existing bookings (${res.status}). Proceeding without the duplicate check, so expect "unavailable" on days you already hold. Response: ${res.text.slice(0, 200)}`
      );
    } else {
      if (endpoint.userIdPath) {
        const userId = dig(res.data, endpoint.userIdPath);
        if (userId !== void 0 && userId !== null) vars.userId = String(userId);
        else notes.push(`No user id at "${endpoint.userIdPath}" in the list response.`);
      }
      const container = endpoint.listRoot ? dig(res.data, endpoint.listRoot) : res.data;
      if (endpoint.listShape === "dateKeyedMap") {
        if (container && typeof container === "object" && !Array.isArray(container)) {
          for (const [date, entries] of Object.entries(container)) {
            if (Array.isArray(entries) && entries.length > 0) heldDates.add(date.slice(0, 10));
          }
          notes.push(`Found ${heldDates.size} day(s) already booked in the window.`);
        } else {
          notes.push(
            `listShape is dateKeyedMap but "${endpoint.listRoot}" is not an object. Got: ${JSON.stringify(container).slice(0, 200)}`
          );
        }
      } else {
        const existing = asList(container);
        for (const booking of existing) {
          for (const field of endpoint.listDateFields) {
            const value = booking[field];
            if (typeof value === "string" && value) {
              heldDates.add(value.slice(0, 10));
              break;
            }
          }
        }
        notes.push(`Found ${existing.length} existing booking(s) in the window.`);
      }
    }
  }
  if (vars.userId === void 0) {
    vars.userId = "me";
    if (endpoint.userIdPath) notes.push("Falling back to /users/me for the booking path.");
  }
  for (const date of dates) {
    if (heldDates.has(date)) {
      rows.push({ date, status: "skipped", detail: "already booked" });
      continue;
    }
    if (dryRun) {
      rows.push(takenDates.has(date) ? { date, status: "unavailable", detail: "someone else holds this desk that day" } : { date, status: "dry-run", detail: `would book ${deskId} (${slot})` });
      continue;
    }
    if (takenDates.has(date)) {
      notes.push(`${date}: desk looks taken; trying anyway in case that reading is wrong.`);
    }
    try {
      const res = await call(endpoint.create, { ...vars, date });
      if (res.signedOut) {
        rows.push({ date, status: "error", detail: "not signed in" });
        notes.push("Signed out partway through. Sign in at https://my.comeen.io/ and run again \u2014 the days already booked will be skipped.");
        signedOut = true;
        break;
      }
      if (res.ok) {
        rows.push({ date, status: "booked" });
      } else if (looksTaken(res.status, res.text)) {
        rows.push({ date, status: "unavailable", detail: `${res.status}: ${res.text.slice(0, 160)}` });
      } else {
        rows.push({ date, status: "error", detail: `${res.status}: ${res.text.slice(0, 200)}` });
      }
    } catch (err) {
      rows.push({ date, status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return { rows, notes, resolvedDeskId, signedOut };
}

// src/background.ts
var ALARM = "comeen-top-up";
var COMEEN_URL = "https://my.comeen.io/";
var TAB_MATCH = "https://my.comeen.io/*";
var SIGNED_OUT_NOTIFICATION = "comeen-signed-out";
var SignedOutError = class extends Error {
};
async function appendLog(entry) {
  const { runs = [] } = await chrome.storage.local.get("runs");
  await chrome.storage.local.set({ runs: [entry, ...runs].slice(0, 10) });
}
async function getComeenTab() {
  const open = await chrome.tabs.query({ url: TAB_MATCH });
  const existing = open.find((t) => typeof t.id === "number" && t.status === "complete") ?? open.find((t) => typeof t.id === "number");
  if (existing?.id !== void 0) return { tabId: existing.id, temporary: false };
  const tab = await chrome.tabs.create({ url: COMEEN_URL, active: false });
  if (tab.id === void 0) throw new Error("Could not open a Comeen tab.");
  await waitForLoad(tab.id);
  const loaded = await chrome.tabs.get(tab.id);
  if (loaded.url && !loaded.url.startsWith(COMEEN_URL)) {
    throw new SignedOutError(
      "Not signed in to Comeen (the page redirected to sign-in). Open https://my.comeen.io/, sign in, then run again."
    );
  }
  return { tabId: tab.id, temporary: true };
}
function waitForLoad(tabId, timeoutMs = 3e4) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Comeen tab did not finish loading in time."));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(resolve, 2500);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
var inFlight;
function runBooking(dryRun) {
  if (inFlight) return inFlight;
  inFlight = runBookingOnce(dryRun).finally(() => {
    inFlight = void 0;
  });
  return inFlight;
}
async function runBookingOnce(dryRun) {
  const settings = await loadSettings();
  const dates = datesToBook({
    weekdays: settings.weekdays,
    horizonDays: settings.horizonDays,
    skipDates: settings.skipDates,
    timeZone: settings.timeZone
  });
  const base = { at: (/* @__PURE__ */ new Date()).toISOString(), dryRun, dates, rows: [], notes: [] };
  if (dates.length === 0) {
    const entry = { ...base, notes: ["No candidate dates in the horizon."] };
    await appendLog(entry);
    return entry;
  }
  if (!settings.deskName && !settings.deskId) {
    const entry = { ...base, error: "Pick your desk in the popup first (the number on it, like 3-23)." };
    await appendLog(entry);
    await reflectRun(entry);
    return entry;
  }
  if (settings.deskName && !isValidDeskName(settings.deskName)) {
    const entry = {
      ...base,
      error: `"${settings.deskName}" is not a desk number. It should be digits, a dash, digits \u2014 like 3-23.`
    };
    await appendLog(entry);
    await reflectRun(entry);
    return entry;
  }
  let temporary = false;
  let tabId;
  try {
    const tab = await getComeenTab();
    tabId = tab.tabId;
    temporary = tab.temporary;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: bookInPage,
      args: [{
        endpoint: settings.endpoint,
        dates,
        deskName: settings.deskName,
        deskId: settings.deskId,
        slot: settings.slot,
        // Resolved out here so the slot-to-times table stays testable
        // instead of being inlined into the serialized page function.
        startTime: SLOT_TIMES[settings.slot].start,
        endTime: SLOT_TIMES[settings.slot].end,
        floorId: settings.floorId,
        buildingId: settings.buildingId,
        dryRun
      }]
    });
    const value = result?.result;
    if (value?.resolvedDeskId && value.resolvedDeskId !== settings.deskId) {
      await saveSettings({ ...settings, deskId: value.resolvedDeskId });
    }
    const entry = {
      ...base,
      rows: value?.rows ?? [],
      notes: value?.notes ?? ["The in-page script returned nothing."],
      signedOut: value?.signedOut === true
    };
    await appendLog(entry);
    await reflectRun(entry);
    return entry;
  } catch (err) {
    const entry = {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      signedOut: err instanceof SignedOutError
    };
    await appendLog(entry);
    await reflectRun(entry);
    return entry;
  } finally {
    if (temporary && tabId !== void 0) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
      }
    }
  }
}
async function reflectRun(entry) {
  if (entry.dryRun) return;
  const failed = Boolean(entry.error) || entry.rows.some((row) => row.status === "error");
  await chrome.action.setBadgeText({ text: failed ? "!" : "" });
  if (failed) {
    await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
  }
  if (entry.signedOut) {
    chrome.notifications.create(SIGNED_OUT_NOTIFICATION, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      title: "Comeen desk booker",
      message: "Your Comeen session expired. Click here to sign in \u2014 booking resumes on its own once you are back."
    });
  } else {
    chrome.notifications.clear(SIGNED_OUT_NOTIFICATION);
  }
}
async function retryAfterSignIn() {
  const { runs = [] } = await chrome.storage.local.get("runs");
  if (runs[0]?.signedOut !== true) return;
  const settings = await loadSettings();
  if (!settings.enabled) return;
  console.info("[comeen] signed back in \u2014 retrying the run that failed");
  await runBooking(false);
}
async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM);
  if (existing) return;
  await chrome.alarms.create(ALARM, { periodInMinutes: 360, delayInMinutes: 1 });
}
async function runIfEnabled(reason) {
  const settings = await loadSettings();
  if (!settings.enabled) return;
  console.info(`[comeen] running (${reason})`);
  await runBooking(false);
}
chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void runIfEnabled("browser startup");
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  void runIfEnabled("alarm");
});
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!tab.url?.startsWith(COMEEN_URL)) return;
  void retryAfterSignIn();
});
chrome.notifications.onClicked.addListener((id) => {
  if (id !== SIGNED_OUT_NOTIFICATION) return;
  void chrome.tabs.create({ url: COMEEN_URL });
  chrome.notifications.clear(SIGNED_OUT_NOTIFICATION);
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "run") {
    runBooking(message.dryRun ?? false).then((log) => respond({ ok: true, log })).catch((err) => respond({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }));
    return true;
  }
  return false;
});
export {
  runBooking
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvcmUvZGF0ZXMudHMiLCAiLi4vc3JjL2NvcmUvY29uZmlnLnRzIiwgIi4uL3NyYy9pbmplY3RlZC50cyIsICIuLi9zcmMvYmFja2dyb3VuZC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiZXhwb3J0IHR5cGUgV2Vla2RheSA9XG4gICAgfCAnbW9uZGF5JyB8ICd0dWVzZGF5JyB8ICd3ZWRuZXNkYXknXG4gICAgfCAndGh1cnNkYXknIHwgJ2ZyaWRheScgfCAnc2F0dXJkYXknIHwgJ3N1bmRheSc7XG5cbmNvbnN0IFdFRUtEQVlfTkFNRVM6IHJlYWRvbmx5IFdlZWtkYXlbXSA9IFtcbiAgICAnc3VuZGF5JywgJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknLCAnc2F0dXJkYXknLFxuXTtcblxuZnVuY3Rpb24gaXNXZWVrZGF5KHZhbHVlOiBzdHJpbmcpOiB2YWx1ZSBpcyBXZWVrZGF5IHtcbiAgICByZXR1cm4gKFdFRUtEQVlfTkFNRVMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKHZhbHVlKTtcbn1cblxuLyoqIEZvcm1hdCBhIERhdGUgYXMgWVlZWS1NTS1ERCBhcyBzZWVuIGluIGB0aW1lWm9uZWAuICovXG5leHBvcnQgZnVuY3Rpb24gdG9Mb2NhbElTT0RhdGUoZGF0ZTogRGF0ZSwgdGltZVpvbmU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1DQScsIHtcbiAgICAgICAgdGltZVpvbmUsIHllYXI6ICdudW1lcmljJywgbW9udGg6ICcyLWRpZ2l0JywgZGF5OiAnMi1kaWdpdCcsXG4gICAgfSkuZm9ybWF0KGRhdGUpO1xufVxuXG4vKiogV2Vla2RheSBuYW1lIG9mIGBkYXRlYCBhcyBzZWVuIGluIGB0aW1lWm9uZWAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYWxXZWVrZGF5KGRhdGU6IERhdGUsIHRpbWVab25lOiBzdHJpbmcpOiBXZWVrZGF5IHtcbiAgICBjb25zdCBuYW1lID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgeyB0aW1lWm9uZSwgd2Vla2RheTogJ2xvbmcnIH0pXG4gICAgICAgIC5mb3JtYXQoZGF0ZSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKCFpc1dlZWtkYXkobmFtZSkpIHRocm93IG5ldyBFcnJvcihgVW5leHBlY3RlZCB3ZWVrZGF5IGZyb20gSW50bDogXCIke25hbWV9XCJgKTtcbiAgICByZXR1cm4gbmFtZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEYXRlc1RvQm9va09wdGlvbnMge1xuICAgIHdlZWtkYXlzOiBzdHJpbmdbXTtcbiAgICBob3Jpem9uRGF5cz86IG51bWJlcjtcbiAgICBza2lwRGF0ZXM/OiBzdHJpbmdbXTtcbiAgICB0aW1lWm9uZT86IHN0cmluZztcbiAgICBub3c/OiBEYXRlO1xufVxuXG4vKipcbiAqIEV2ZXJ5IGRheSBmcm9tIHRvZGF5IChpbmNsdXNpdmUpIHVwIHRvIGBob3Jpem9uRGF5c2AgYWhlYWQgd2hvc2Ugd2Vla2RheSBpc1xuICogaW4gYHdlZWtkYXlzYCwgbWludXMgYHNraXBEYXRlc2AuXG4gKlxuICogVGhlIDE0LWRheSBkZWZhdWx0IGlzIHdoYXQgbWFrZXMgdW5yZWxpYWJsZSBzY2hlZHVsaW5nIGFjY2VwdGFibGU6IGVhY2ggcnVuXG4gKiB0b3BzIHRoZSB3aG9sZSB3aW5kb3cgYmFjayB1cCwgc28gbWlzc2luZyBhIGRheSAobGFwdG9wIHNodXQsIENocm9tZSBjbG9zZWQpXG4gKiBjb3N0cyBub3RoaW5nIGFzIGxvbmcgYXMgdGhlIGV4dGVuc2lvbiBydW5zIGFnYWluIGJlZm9yZSB0aGUgd2luZG93IGRyYWlucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRhdGVzVG9Cb29rKHtcbiAgICB3ZWVrZGF5cyxcbiAgICBob3Jpem9uRGF5cyA9IDE0LFxuICAgIHNraXBEYXRlcyA9IFtdLFxuICAgIHRpbWVab25lID0gJ0V1cm9wZS9QcmFndWUnLFxuICAgIG5vdyA9IG5ldyBEYXRlKCksXG59OiBEYXRlc1RvQm9va09wdGlvbnMpOiBzdHJpbmdbXSB7XG4gICAgY29uc3Qgd2FudGVkID0gbmV3IFNldDxXZWVrZGF5PigpO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIHdlZWtkYXlzKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSByYXcudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgaWYgKCFpc1dlZWtkYXkobmFtZSkpIHRocm93IG5ldyBFcnJvcihgTm90IGEgd2Vla2RheSBuYW1lOiBcIiR7cmF3fVwiYCk7XG4gICAgICAgIHdhbnRlZC5hZGQobmFtZSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoc2tpcERhdGVzKTtcbiAgICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG5cbiAgICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPD0gaG9yaXpvbkRheXM7IG9mZnNldCArPSAxKSB7XG4gICAgICAgIGNvbnN0IGRheSA9IG5ldyBEYXRlKG5vdy5nZXRUaW1lKCkgKyBvZmZzZXQgKiA4Nl80MDBfMDAwKTtcbiAgICAgICAgY29uc3QgaXNvID0gdG9Mb2NhbElTT0RhdGUoZGF5LCB0aW1lWm9uZSk7XG4gICAgICAgIGlmICghd2FudGVkLmhhcyhsb2NhbFdlZWtkYXkoZGF5LCB0aW1lWm9uZSkpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNraXAuaGFzKGlzbykpIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaChpc28pO1xuICAgIH1cblxuICAgIHJldHVybiBvdXQ7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBXZWVrZGF5IH0gZnJvbSAnLi9kYXRlcy5qcyc7XG5cbmV4cG9ydCB0eXBlIFNsb3QgPSAnYWxsX2RheScgfCAnbW9ybmluZycgfCAnYWZ0ZXJub29uJztcblxuLyoqXG4gKiBIb3cgdGhlIGluLXBhZ2UgY29kZSBzaG91bGQgYXV0aGVudGljYXRlLlxuICpcbiAqIGBjb29raWVgICAgICAgIC0ganVzdCBzZW5kIGNyZWRlbnRpYWxzIHdpdGggdGhlIHJlcXVlc3QuIENvcnJlY3QgaWYgQ29tZWVuXG4gKiAgICAgICAgICAgICAgICAgIGF1dGhlbnRpY2F0ZXMgd2l0aCBhIHNlc3Npb24gY29va2llLlxuICogYGxvY2FsU3RvcmFnZWAgLSByZWFkIGEgdG9rZW4gb3V0IG9mIHRoZSBwYWdlJ3Mgb3duIGxvY2FsU3RvcmFnZSBhbmQgcHV0IGl0XG4gKiAgICAgICAgICAgICAgICAgIGluIGEgaGVhZGVyLiBDb3JyZWN0IGlmIENvbWVlbiB1c2VzIGEgYmVhcmVyIHRva2VuLlxuICpcbiAqIEVpdGhlciB3YXkgdGhlIHZhbHVlIGlzIHJlYWQgaW5zaWRlIHRoZSBwYWdlIGFuZCB1c2VkIHRoZXJlLiBJdCBpcyBuZXZlclxuICogY29waWVkIGludG8gZXh0ZW5zaW9uIHN0b3JhZ2UsIG5ldmVyIHBlcnNpc3RlZCwgYW5kIG5ldmVyIGxlYXZlcyB0aGUgdGFiLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhDb25maWcge1xuICAgIG1vZGU6ICdjb29raWUnIHwgJ2xvY2FsU3RvcmFnZSc7XG4gICAgLyoqIGxvY2FsU3RvcmFnZSBrZXkgaG9sZGluZyB0aGUgdG9rZW4uICovXG4gICAgc3RvcmFnZUtleT86IHN0cmluZztcbiAgICAvKiogRG90dGVkIHBhdGggaW5zaWRlIHRoZSBwYXJzZWQgSlNPTiwgZS5nLiBgc3RzVG9rZW5NYW5hZ2VyLmFjY2Vzc1Rva2VuYCAqL1xuICAgIGpzb25QYXRoPzogc3RyaW5nO1xuICAgIC8qKiBIZWFkZXIgdG8gc2V0LCBkZWZhdWx0IGBhdXRob3JpemF0aW9uYCAqL1xuICAgIGhlYWRlcj86IHN0cmluZztcbiAgICAvKiogUHJlZml4IGJlZm9yZSB0aGUgdG9rZW4sIGRlZmF1bHQgYEJlYXJlciBgICovXG4gICAgcHJlZml4Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlcXVlc3RUZW1wbGF0ZSB7XG4gICAgbWV0aG9kOiAnR0VUJyB8ICdQT1NUJyB8ICdQVVQnO1xuICAgIC8qKiBQYXRoIGFwcGVuZGVkIHRvIGFwaUJhc2UuIE1heSBjb250YWluIHBsYWNlaG9sZGVycy4gKi9cbiAgICBwYXRoOiBzdHJpbmc7XG4gICAgcXVlcnk/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgIGJvZHk/OiB1bmtub3duO1xufVxuXG4vKipcbiAqIEhvdyB0aGUgXCJ3aGF0IGRvIEkgYWxyZWFkeSBob2xkXCIgcmVzcG9uc2UgaXMgbGFpZCBvdXQuXG4gKlxuICogYGFycmF5YCAgICAgICAgLSBhIGZsYXQgbGlzdCBvZiBib29raW5ncywgZWFjaCBjYXJyeWluZyBpdHMgb3duIGRhdGUgZmllbGQsXG4gKiAgICAgICAgICAgICAgICAgIHJlYWQgdmlhIGBsaXN0RGF0ZUZpZWxkc2AuXG4gKiBgZGF0ZUtleWVkTWFwYCAtIGFuIG9iamVjdCBrZXllZCBieSBgWVlZWS1NTS1ERGAgd2hvc2UgdmFsdWVzIGFyZSB0aGF0IGRheSdzXG4gKiAgICAgICAgICAgICAgICAgIGVudHJpZXMuIENvbWVlbiByZXR1cm5zIHRoaXMgb25lLiBUaGUgZGF0ZSBpcyB0aGUgKmtleSosIG5vdFxuICogICAgICAgICAgICAgICAgICBhIGZpZWxkLCBzbyBubyBhbW91bnQgb2Ygc25pZmZpbmcgZmllbGQgbmFtZXMgd291bGQgZmluZCBpdCBcdTIwMTRcbiAqICAgICAgICAgICAgICAgICAgd2hpY2ggaXMgZXhhY3RseSB3aHkgdGhlIHNoYXBlIGlzIGNvbmZpZ3VyYXRpb24gcmF0aGVyIHRoYW5cbiAqICAgICAgICAgICAgICAgICAgc29tZXRoaW5nIHRoZSBpbi1wYWdlIGNvZGUgZ3Vlc3Nlcy5cbiAqL1xuZXhwb3J0IHR5cGUgTGlzdFNoYXBlID0gJ2FycmF5JyB8ICdkYXRlS2V5ZWRNYXAnO1xuXG4vKipcbiAqIFRoZSB3aG9sZSBBUEkgY29udHJhY3QgbGl2ZXMgaGVyZSBhcyBkYXRhIHNvIGl0IGNhbiBiZSBjb3JyZWN0ZWQgZnJvbSB0aGVcbiAqIHBvcHVwIHdpdGhvdXQgcmVidWlsZGluZy4gUGxhY2Vob2xkZXJzIGF2YWlsYWJsZSB0byBwYXRocywgcXVlcmllcyBhbmRcbiAqIGJvZGllczoge3tkYXRlfX0sIHt7ZGVza0lkfX0sIHt7ZGVza05hbWV9fSwge3tzbG90fX0sIHt7c3RhcnRUaW1lfX0sXG4gKiB7e2VuZFRpbWV9fSwge3tmcm9tfX0sIHt7dG99fSwge3t1c2VySWR9fSwge3tmbG9vcklkfX0sIHt7YnVpbGRpbmdJZH19LFxuICoge3thcmVhSWR9fS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBFbmRwb2ludENvbmZpZyB7XG4gICAgYXBpQmFzZTogc3RyaW5nO1xuICAgIGF1dGg6IEF1dGhDb25maWc7XG4gICAgLyoqXG4gICAgICogTG9vayBhIGRlc2sgdXAgYnkgaXRzIGh1bWFuIG5hbWUgc28gbm9ib2R5IGhhcyB0byBrbm93IGl0cyBpbnRlcm5hbCBpZC5cbiAgICAgKiBTZXQgdG8gbnVsbCBvbmx5IGlmIHlvdXIgQ29tZWVuIGhhcyBubyBkZXNrLXNlYXJjaCBlbmRwb2ludC5cbiAgICAgKi9cbiAgICByZXNvbHZlOiBSZXF1ZXN0VGVtcGxhdGUgfCBudWxsO1xuICAgIC8qKiBGaWVsZCBuYW1lcyB0aGF0IG1pZ2h0IGhvbGQgYSBkZXNrJ3MgaHVtYW4gbGFiZWwgaW4gYSBzZWFyY2ggcmVzdWx0LiAqL1xuICAgIGRlc2tOYW1lRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKiogRmllbGQgbmFtZXMgdGhhdCBtaWdodCBob2xkIGEgZGVzaydzIGludGVybmFsIGlkLiBDb21lZW4gdXNlcyBgdXVpZGAuICovXG4gICAgZGVza0lkRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKipcbiAgICAgKiBGaWVsZCBvbiBhIGRlc2sgcmVjb3JkIGhvbGRpbmcgdGhhdCBkZXNrJ3Mgb3duIGJvb2tpbmdzIGZvciB0aGUgcXVlcmllZFxuICAgICAqIHdpbmRvdy4gVXNlZCB0byB0ZWxsIHlvdSBhIGRheSBpcyBhbHJlYWR5IHRha2VuICpiZWZvcmUqIHlvdSBwcmVzcyBCb29rXG4gICAgICogbm93LiBTZXQgdG8gJycgdG8gZGlzYWJsZS5cbiAgICAgKi9cbiAgICBkZXNrU2NoZWR1bGVGaWVsZDogc3RyaW5nO1xuICAgIC8qKlxuICAgICAqIERhdGUgZmllbGRzIHRvIHJlYWQgb2ZmIG9uZSBvZiB0aG9zZSBlbnRyaWVzLCBpbiBwcmlvcml0eSBvcmRlciwgZmlyc3RcbiAgICAgKiBtYXRjaCB3aW5zLlxuICAgICAqXG4gICAgICogVGhlIG9yZGVyIG1hdHRlcnMgbW9yZSB0aGFuIGl0IGxvb2tzOiBhbiBlbnRyeSBhbG1vc3QgY2VydGFpbmx5IGFsc29cbiAgICAgKiBjYXJyaWVzIGNyZWF0ZWRfYXQgYW5kIHVwZGF0ZWRfYXQsIHdoaWNoIGFyZSB3aGVuIHRoZSBib29raW5nIHdhcyBtYWRlLFxuICAgICAqIG5vdCB0aGUgZGF5IGJvb2tlZC4gTGlzdGluZyBvbmx5IHRoZSBmaWVsZHMgdGhhdCBtZWFuIFwidGhlIGRheSB0aGlzIGlzXG4gICAgICogZm9yXCIgaXMgd2hhdCBzdG9wcyBhIGJvb2tpbmcgbWFkZSB0aHJlZSB3ZWVrcyBhZ28gZnJvbSBtYXJraW5nIHRocmVlXG4gICAgICogd2Vla3MgYWdvIGFzIHRha2VuLlxuICAgICAqL1xuICAgIGRlc2tTY2hlZHVsZURhdGVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKiBTZXQgdG8gbnVsbCB0byBza2lwIHRoZSBcIndoYXQgZG8gSSBhbHJlYWR5IGhhdmVcIiBjaGVjay4gKi9cbiAgICBsaXN0OiBSZXF1ZXN0VGVtcGxhdGUgfCBudWxsO1xuICAgIC8qKiBEb3R0ZWQgcGF0aCB0byB0aGUgY29udGFpbmVyIGluc2lkZSB0aGUgbGlzdCByZXNwb25zZS4gJycgbWVhbnMgcm9vdC4gKi9cbiAgICBsaXN0Um9vdDogc3RyaW5nO1xuICAgIGxpc3RTaGFwZTogTGlzdFNoYXBlO1xuICAgIC8qKiBPbmx5IGNvbnN1bHRlZCB3aGVuIGxpc3RTaGFwZSBpcyAnYXJyYXknLiAqL1xuICAgIGxpc3REYXRlRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKipcbiAgICAgKiBEb3R0ZWQgcGF0aCB0byB0aGUgc2lnbmVkLWluIHVzZXIncyBpZCBpbnNpZGUgdGhlIGxpc3QgcmVzcG9uc2UuIEVtcHR5XG4gICAgICogZGlzYWJsZXMgdGhlIGxvb2t1cCwgYW5kIHt7dXNlcklkfX0gdGhlbiBzdGF5cyB1bmZpbGxlZC5cbiAgICAgKi9cbiAgICB1c2VySWRQYXRoOiBzdHJpbmc7XG4gICAgY3JlYXRlOiBSZXF1ZXN0VGVtcGxhdGU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ3Mge1xuICAgIC8qKlxuICAgICAqIEJ1bXBlZCBpbiBERUZBVUxUX1NFVFRJTkdTIHdoZW5ldmVyIHRoZSBzaGlwcGVkIGVuZHBvaW50IGNvbmZpZyBpc1xuICAgICAqIGNvcnJlY3RlZC4gU2VlIG1lcmdlU2V0dGluZ3M6IGEgc3RvcmVkIGNvbmZpZyBvbGRlciB0aGFuIHRoZSBzaGlwcGVkIG9uZVxuICAgICAqIGlzIHJlcGxhY2VkIHJhdGhlciB0aGFuIG1lcmdlZCwgd2hpY2ggaXMgd2hhdCBsZXRzIGEgZml4IGFjdHVhbGx5IHJlYWNoXG4gICAgICogcGVvcGxlIHdobyBoYXZlIGFscmVhZHkgc2F2ZWQgc2V0dGluZ3Mgb25jZS5cbiAgICAgKi9cbiAgICBlbmRwb2ludFZlcnNpb246IG51bWJlcjtcbiAgICBlbmFibGVkOiBib29sZWFuO1xuICAgIGRlc2tOYW1lOiBzdHJpbmc7XG4gICAgZGVza0lkOiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogVGhlIGZsb29yIHRoZSBkZXNrIGlzIG9uLiBUaGlzIG9uZSBjYW5ub3QgYmUgZGVyaXZlZDogcmVzb2x2aW5nIGEgZGVzayBieVxuICAgICAqIG5hbWUgbWVhbnMgbGlzdGluZyBhIGZsb29yJ3MgZGVza3MsIHNvIHRoZSBmbG9vciBoYXMgdG8gYmUga25vd24gZmlyc3QuXG4gICAgICogVmlzaWJsZSBpbiB0aGUgVVJMIG9mIENvbWVlbidzIGZsb29yIHBsYW4sIGFuZCBpbiBgZmxvb3JfaWRgIG9uIGFueSBkZXNrLlxuICAgICAqL1xuICAgIGZsb29ySWQ6IG51bWJlcjtcbiAgICAvKipcbiAgICAgKiBUaGUgYnVpbGRpbmcgdGhlIGZsb29yIGlzIGluLiBBbHNvIG5vdCBkZXJpdmFibGUgXHUyMDE0IGEgZGVzayByZWNvcmQgY2Fycmllc1xuICAgICAqIGBmbG9vcl9pZGAgYW5kIGBhcmVhX2lkYCBidXQgbm8gYGJ1aWxkaW5nX2lkYCwgYW5kIHRoZSBvbmx5IGVuZHBvaW50IHRoYXRcbiAgICAgKiBtYXBzIG9uZSB0byB0aGUgb3RoZXIgbmVlZHMgYSBzcGFjZSBVVUlEIHdlIG5ldmVyIG90aGVyd2lzZSBmZXRjaC5cbiAgICAgKi9cbiAgICBidWlsZGluZ0lkOiBudW1iZXI7XG4gICAgd2Vla2RheXM6IFdlZWtkYXlbXTtcbiAgICBzbG90OiBTbG90O1xuICAgIGhvcml6b25EYXlzOiBudW1iZXI7XG4gICAgc2tpcERhdGVzOiBzdHJpbmdbXTtcbiAgICB0aW1lWm9uZTogc3RyaW5nO1xuICAgIGVuZHBvaW50OiBFbmRwb2ludENvbmZpZztcbn1cblxuLyoqXG4gKiBBIHNsb3QgYXMgdGhlIG5haXZlIGxvY2FsIHRpbWVzIENvbWVlbiBleHBlY3RzLlxuICpcbiAqIENvbWVlbiBzZW5kcyBkYXRldGltZXMgbGlrZSBgMjAyNi0wOS0wMVQwMDowMDowMC4wMDBaYCBhbmQgZWNob2VzIHRoZW0gYmFja1xuICogYXMgYDIwMjYtMDktMDFUMDA6MDA6MDBgIFx1MjAxNCBhIGxvY2FsIHdhbGwtY2xvY2sgdGltZSB3ZWFyaW5nIGEgYFpgLiBTbyB0aGUgZGF5XG4gKiBpcyB1c2VkIHZlcmJhdGltIGFuZCBubyB0aW1lem9uZSBjb252ZXJzaW9uIGhhcHBlbnMgYW55d2hlcmUgaW4gdGhlIGJvb2tpbmdcbiAqIHBhdGguIFRoZSBkYXRlIGxvZ2ljIGluIGRhdGVzLnRzIGFscmVhZHkgcHJvZHVjZXMgZXhhY3RseSB0aGlzLlxuICpcbiAqIFx1MjZBMFx1RkUwRiBPbmx5IGBhbGxfZGF5YCBpcyBjb25maXJtZWQgYWdhaW5zdCBhIHJlYWwgYm9va2luZy4gVGhlIGhhbGYtZGF5cyBhcmUgYVxuICogcmVhc29uYWJsZSByZWFkaW5nIG9mIHRoZSBzYW1lIHNjaGVtZSwgbm90IGFuIG9ic2VydmVkIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNMT1RfVElNRVM6IFJlY29yZDxTbG90LCB7IHN0YXJ0OiBzdHJpbmc7IGVuZDogc3RyaW5nIH0+ID0ge1xuICAgIGFsbF9kYXk6IHsgc3RhcnQ6ICcwMDowMDowMC4wMDBaJywgZW5kOiAnMjM6NTk6NTkuMDAwWicgfSxcbiAgICBtb3JuaW5nOiB7IHN0YXJ0OiAnMDA6MDA6MDAuMDAwWicsIGVuZDogJzEyOjAwOjAwLjAwMFonIH0sXG4gICAgYWZ0ZXJub29uOiB7IHN0YXJ0OiAnMTI6MDA6MDAuMDAwWicsIGVuZDogJzIzOjU5OjU5LjAwMFonIH0sXG59O1xuXG4vKipcbiAqIENvbmZpcm1lZCBhZ2FpbnN0IGEgcmVhbCBzaWduZWQtaW4gc2Vzc2lvbiBpbiBBdWd1c3QgMjAyNiwgYnkgY2FwdHVyaW5nIHRoZVxuICogdHJhZmZpYyBvZiBvbmUgZGVzayBib29raW5nIG1hZGUgYnkgaGFuZC5cbiAqXG4gKiBOb3RlcyB3b3J0aCBrZWVwaW5nLCBiZWNhdXNlIGVhY2ggb25lIGNvbnRyYWRpY3RzIGEgcmVhc29uYWJsZSBndWVzczpcbiAqICAgLSBgYXBpQmFzZWAgaXMgbXkuY29tZWVuLmlvL2FwaSwgdGhlIFNQQSdzIG93biBvcmlnaW4sIE5PVCBhcGkuY29tZWVuLmlvXG4gKiAgICAgd2hlcmUgdGhlIHB1YmxpYyBkb2NzIGxpdmUuIEl0IGlzIGEgUmFpbHMgYmFja2VuZCBiZWhpbmQgYSBOdXh0IGZyb250IGVuZCxcbiAqICAgICB3aGljaCBpcyB3aHkgcGF0aHMgZW5kIGluIGAuanNvbmAuXG4gKiAgIC0gVGhlIEFQSSB2ZXJzaW9uIHZhcmllcyBwZXIgZW5kcG9pbnQgKC92MSwgL3YyLCAvdjJiZXRhKSwgc28gdGhlIHZlcnNpb25cbiAqICAgICBiZWxvbmdzIGluIGVhY2ggcGF0aCByYXRoZXIgdGhhbiBpbiBhcGlCYXNlLlxuICogICAtIEEgZGVzaydzIGlkIGlzIGB1dWlkYC4gVGhlcmUgaXMgbm8gYGlkYCBmaWVsZCBvbiBhIGRlc2sgYXQgYWxsLlxuICogICAtIFRoZSBib29raW5ncyBsaXN0IGlzIGtleWVkIGJ5IGRhdGU7IHRoZSBkYXRlIGlzIG5vdCBhIGZpZWxkIG9uIGFuIGVudHJ5LlxuICogICAtIEEgYm9va2luZyBpcyBhIFwid29yayBhY3Rpdml0eVwiIHdpdGggYSBkZXNrIGF0dGFjaGVkLCBub3QgYSBkZXNrIGJvb2tpbmdcbiAqICAgICBhcyBzdWNoLiBUaGF0IGlzIHdoeSB0aGUgcGF0aCBzYXlzIHdvcmtfYWN0aXZpdHlfc2NoZWR1bGUuXG4gKiAgIC0gQXV0aCBpcyB0aGUgc2Vzc2lvbiBjb29raWUuIEEgZmV0Y2ggZnJvbSB0aGUgcGFnZSB3aXRoIGNyZWRlbnRpYWxzXG4gKiAgICAgaW5jbHVkZWQgYW5kIG5vIEF1dGhvcml6YXRpb24gaGVhZGVyIHJldHVybnMgMjAwLCBzbyB0aGVyZSBpcyBubyB0b2tlbiB0b1xuICogICAgIHJlYWQgYW5kIG5vdGhpbmcgZm9yIHRoZSBleHRlbnNpb24gdG8gaG9sZC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFNldHRpbmdzID0ge1xuICAgIC8vIFx1MkIwNiBCVU1QIFRISVMgd2hlbmV2ZXIgeW91IGNvcnJlY3QgdGhlIGBlbmRwb2ludGAgYmxvY2sgYmVsb3csIG90aGVyd2lzZVxuICAgIC8vIGFueW9uZSB3aG8gYWxyZWFkeSBwcmVzc2VkIFNhdmUga2VlcHMgdGhlaXIgc3RhbGUgY29weSBmb3JldmVyLlxuICAgIGVuZHBvaW50VmVyc2lvbjogMyxcbiAgICBlbmFibGVkOiBmYWxzZSxcbiAgICAvLyBFbXB0eSBvbiBwdXJwb3NlLiBTaGlwcGluZyBhIHJlYWwgZGVzayBudW1iZXIgYXMgdGhlIGRlZmF1bHQgbWVhbnMgdGhlXG4gICAgLy8gZmlyc3QgcGVyc29uIHRvIGluc3RhbGwgdGhpcyBhbmQgcHJlc3MgQm9vayBub3cgdGFrZXMgc29tZWJvZHkgZWxzZSdzXG4gICAgLy8gc2VhdCwgaGF2aW5nIGRvbmUgbm90aGluZyB3cm9uZy4gTm90aGluZyBydW5zIHVudGlsIGEgZGVzayBpcyBjaG9zZW4uXG4gICAgZGVza05hbWU6ICcnLFxuICAgIGRlc2tJZDogJycsXG4gICAgZmxvb3JJZDogNDk1MixcbiAgICBidWlsZGluZ0lkOiA1MTUxLFxuICAgIHdlZWtkYXlzOiBbJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknXSxcbiAgICBzbG90OiAnYWxsX2RheScsXG4gICAgaG9yaXpvbkRheXM6IDE0LFxuICAgIHNraXBEYXRlczogW10sXG4gICAgdGltZVpvbmU6ICdFdXJvcGUvUHJhZ3VlJyxcbiAgICBlbmRwb2ludDoge1xuICAgICAgICBhcGlCYXNlOiAnaHR0cHM6Ly9teS5jb21lZW4uaW8vYXBpJyxcbiAgICAgICAgYXV0aDogeyBtb2RlOiAnY29va2llJyB9LFxuICAgICAgICByZXNvbHZlOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICAgICAgcGF0aDogJy92MS9mbG9vcnMve3tmbG9vcklkfX0vZGVza3Nfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGU6ICd7e2Zyb219fVQwMDowMDowMC4wMDBaJyxcbiAgICAgICAgICAgICAgICBlbmRfZGF0ZTogJ3t7dG99fVQyMzo1OTo1OS4wMDBaJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGRlc2tOYW1lRmllbGRzOiBbJ25hbWUnLCAnc3luY19pZCddLFxuICAgICAgICBkZXNrSWRGaWVsZHM6IFsndXVpZCcsICdpZCddLFxuICAgICAgICBkZXNrU2NoZWR1bGVGaWVsZDogJ3NjaGVkdWxlJyxcbiAgICAgICAgZGVza1NjaGVkdWxlRGF0ZUZpZWxkczogWydzdGFydF9kYXRldGltZScsICdzdGFydF9kYXRlJywgJ2RhdGUnLCAnZGF5JywgJ3N0YXJ0J10sXG4gICAgICAgIGxpc3Q6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgICAgICBwYXRoOiAnL3YxL3VzZXJzL21lL3dvcmtfYWN0aXZpdHlfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGU6ICd7e2Zyb219fVQwMDowMDowMC4wMDBaJyxcbiAgICAgICAgICAgICAgICBlbmRfZGF0ZTogJ3t7dG99fVQyMzo1OTo1OS4wMDBaJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGxpc3RSb290OiAnc2NoZWR1bGUnLFxuICAgICAgICBsaXN0U2hhcGU6ICdkYXRlS2V5ZWRNYXAnLFxuICAgICAgICBsaXN0RGF0ZUZpZWxkczogWydzdGFydF9kYXRldGltZScsICdkYXRlJ10sXG4gICAgICAgIHVzZXJJZFBhdGg6ICd1c2VyLmlkJyxcbiAgICAgICAgY3JlYXRlOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICAgIC8vIFRoZSBgbWVgIGFsaWFzIHdvcmtzIGZvciByZWFkczsgdGhlIGFwcCBpdHNlbGYgdXNlcyB0aGUgbnVtZXJpY1xuICAgICAgICAgICAgLy8gaWQgdG8gd3JpdGUsIHNvIHRoYXQgaXMgd2hhdCBpcyB1c2VkIGhlcmUuXG4gICAgICAgICAgICBwYXRoOiAnL3YxL3VzZXJzL3t7dXNlcklkfX0vd29ya19hY3Rpdml0eV9zY2hlZHVsZS5qc29uJyxcbiAgICAgICAgICAgIGJvZHk6IHtcbiAgICAgICAgICAgICAgICB3b3JrX2FjdGl2aXR5OiB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXRlOiAnb25fc2l0ZScsXG4gICAgICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGV0aW1lOiAne3tkYXRlfX1Ue3tzdGFydFRpbWV9fScsXG4gICAgICAgICAgICAgICAgICAgIGVuZF9kYXRldGltZTogJ3t7ZGF0ZX19VHt7ZW5kVGltZX19JyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHByZXNlbmNlOiB7XG4gICAgICAgICAgICAgICAgICAgIGJ1aWxkaW5nX2lkOiAne3tidWlsZGluZ0lkfX0nLFxuICAgICAgICAgICAgICAgICAgICBmbG9vcl9pZDogJ3t7Zmxvb3JJZH19JyxcbiAgICAgICAgICAgICAgICAgICAgYXJlYV9pZDogJ3t7YXJlYUlkfX0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgZGVza19ib29raW5nOiB7IGRlc2tfdXVpZDogJ3t7ZGVza0lkfX0nIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgIH0sXG59O1xuXG4vKipcbiAqIFRoZSBvZmZpY2UsIGFzIGNhcHR1cmVkIGluIEF1Z3VzdCAyMDI2LlxuICpcbiAqIEhhcmRjb2RlZCByYXRoZXIgdGhhbiBmZXRjaGVkLiBUaGUgZmxvb3IgZHJvcGRvd24gaGFzIHRvIGJlIHBvcHVsYXRlZCBiZWZvcmVcbiAqIGFueSBuZXR3b3JrIGNhbGwgaGFwcGVucywgYW4gb2ZmaWNlIGxheW91dCBjaGFuZ2VzIGFib3V0IG5ldmVyLCBhbmQgYVxuICogaGFyZGNvZGVkIGZsb29yIHRoYXQgaXMgd3JvbmcgaXMgYSB2aXNpYmxlIG1pc3Rha2UgcmF0aGVyIHRoYW4gYSBzaWxlbnQgb25lLlxuICpcbiAqIFRvIGFkZCBhIGZsb29yLCByZWFkIHRoZSBpZHMgZnJvbSB0aGUgcmVzcG9uc2Ugb2ZcbiAqIC9hcGkvdjIvc3BhY2VzLzxzcGFjZS11dWlkPi9idWlsZGluZ3MvPGJ1aWxkaW5nLWlkPi9mbG9vcnMuanNvbiB3aXRoIHRoZVxuICogZmxvb3IgcGxhbiBvcGVuLlxuICovXG5leHBvcnQgY29uc3QgQlVJTERJTkcgPSB7IGlkOiA1MTUxLCBuYW1lOiAnMTAweWFyZHMnIH07XG5cbi8qKlxuICogQSBkZXNrIG5hbWUgaXMgZGlnaXRzLCBhIGRhc2gsIGRpZ2l0cyBcdTIwMTQgYDMtMjNgLCBgMTItNGAuXG4gKlxuICogRGVsaWJlcmF0ZWx5IG5vdCB0aWdodGVuZWQgdG8gdHdvIHplcm8tcGFkZGVkIGRpZ2l0cywgd2hpY2ggaXMgd2hhdCB0aGlzXG4gKiBvZmZpY2UgaGFwcGVucyB0byB1c2U6IGEgZmxvb3IgMTIgb3IgYSBkZXNrIDEwMCB3b3VsZCB0aGVuIGJlIHJlamVjdGVkIGZvclxuICogbG9va2luZyB3cm9uZyByYXRoZXIgdGhhbiBmb3IgYmVpbmcgd3JvbmcuIFdoYXQgdGhpcyBjYXRjaGVzIGlzIHRoZSBtaXN0YWtlXG4gKiBwZW9wbGUgYWN0dWFsbHkgbWFrZSBcdTIwMTQgdHlwaW5nIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBhIGRlc2sgbnVtYmVyIGF0IGFsbDogYVxuICogbmFtZSwgYSByb29tLCBhIHN0cmF5IHNwYWNlLlxuICovXG5leHBvcnQgY29uc3QgREVTS19OQU1FX1BBVFRFUk4gPSAvXlxcZCstXFxkKyQvO1xuXG4vKiogRW1wdHkgaXMgbm90IHZhbGlkLCBidXQgaXQgaXMgbm90IGFuIGVycm9yIGVpdGhlciBcdTIwMTQgc2VlIHRoZSBwb3B1cC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ZhbGlkRGVza05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIERFU0tfTkFNRV9QQVRURVJOLnRlc3QobmFtZS50cmltKCkpO1xufVxuXG5leHBvcnQgY29uc3QgRkxPT1JTOiB7IGlkOiBudW1iZXI7IGxhYmVsOiBzdHJpbmcgfVtdID0gW1xuICAgIHsgaWQ6IDQ5NTIsIGxhYmVsOiAnRmxvb3IgMycgfSxcbiAgICB7IGlkOiA0OTUzLCBsYWJlbDogJ0Zsb29yIDQnIH0sXG5dO1xuXG5leHBvcnQgdHlwZSBWYXJzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuLyoqXG4gKiBBIHBsYWNlaG9sZGVyIHRoYXQgbWFrZXMgdXAgdGhlICplbnRpcmUqIHZhbHVlIGFuZCByZXNvbHZlcyB0byBhbiBpbnRlZ2VyXG4gKiBiZWNvbWVzIGEgbnVtYmVyLlxuICpcbiAqIFRoaXMgbWF0dGVycyBiZWNhdXNlIEpTT04gZGlzdGluZ3Vpc2hlcyA1MTUxIGZyb20gXCI1MTUxXCIgYW5kIENvbWVlbidzXG4gKiBwcmVzZW5jZSBibG9jayB3YW50cyB0aGUgZm9ybWVyLiBQYXJ0aWFsIGludGVycG9sYXRpb24gXHUyMDE0IFwiL3VzZXJzL3t7dXNlcklkfX0veFwiXG4gKiBcdTIwMTQgYWx3YXlzIHlpZWxkcyBhIHN0cmluZywgd2hpY2ggaXMgd2hhdCBhIHBhdGggbmVlZHMsIHNvIHRoZSB0d28gY2FzZXMgbmV2ZXJcbiAqIGNvbGxpZGUuIEEgdXVpZCBvciBhIGRhdGUgY29udGFpbnMgbm9uLWRpZ2l0cyBhbmQgc3RheXMgYSBzdHJpbmcgZWl0aGVyIHdheS5cbiAqL1xuY29uc3QgV0hPTEVfUExBQ0VIT0xERVIgPSAvXlxce1xceyhcXHcrKVxcfVxcfSQvO1xuY29uc3QgSU5URUdFUiA9IC9eLT9cXGQrJC87XG5cbi8qKiBSZXBsYWNlIHt7cGxhY2Vob2xkZXJzfX0gdGhyb3VnaG91dCBhIEpTT04taXNoIHZhbHVlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1YnN0aXR1dGUodmFsdWU6IHVua25vd24sIHZhcnM6IFZhcnMpOiB1bmtub3duIHtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICBjb25zdCB3aG9sZSA9IFdIT0xFX1BMQUNFSE9MREVSLmV4ZWModmFsdWUpO1xuICAgICAgICBpZiAod2hvbGUpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlcGxhY2VtZW50ID0gdmFyc1t3aG9sZVsxXSA/PyAnJ107XG4gICAgICAgICAgICBpZiAocmVwbGFjZW1lbnQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHZhbHVlO1xuICAgICAgICAgICAgcmV0dXJuIElOVEVHRVIudGVzdChyZXBsYWNlbWVudCkgPyBOdW1iZXIocmVwbGFjZW1lbnQpIDogcmVwbGFjZW1lbnQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZhbHVlLnJlcGxhY2UoL1xce1xceyhcXHcrKVxcfVxcfS9nLCAobWF0Y2gsIGtleTogc3RyaW5nKSA9PiB2YXJzW2tleV0gPz8gbWF0Y2gpO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlLm1hcCgoZW50cnkpID0+IHN1YnN0aXR1dGUoZW50cnksIHZhcnMpKTtcbiAgICB9XG4gICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSkpIG91dFtrZXldID0gc3Vic3RpdHV0ZShlbnRyeSwgdmFycyk7XG4gICAgICAgIHJldHVybiBvdXQ7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbn1cblxuLyoqXG4gKiBNZXJnZSBzdG9yZWQgc2V0dGluZ3Mgb3ZlciB0aGUgc2hpcHBlZCBkZWZhdWx0cy5cbiAqXG4gKiBQZXJzb25hbCBjaG9pY2VzIChkZXNrLCB3ZWVrZGF5cywgdGltZXpvbmUpIGFsd2F5cyB3aW46IHRoZXkgYXJlIHRoZSB1c2VyJ3MuXG4gKiBUaGUgZW5kcG9pbnQgY29uZmlnIGlzIGRpZmZlcmVudC4gSXQgaXMgbm90IGEgcHJlZmVyZW5jZSwgaXQgaXMgYSBmYWN0IGFib3V0XG4gKiBDb21lZW4ncyBBUEkgdGhhdCBvbmUgcGVyc29uIGRpc2NvdmVycyBhbmQgZXZlcnlvbmUgZWxzZSBpbmhlcml0cy4gSWYgYVxuICogc3RvcmVkIGNvcHkgcHJlZGF0ZXMgdGhlIHNoaXBwZWQgb25lLCB0aGUgc2hpcHBlZCBvbmUgcmVwbGFjZXMgaXQgb3V0cmlnaHQuXG4gKiBNZXJnaW5nIGtleS1ieS1rZXkgd291bGQgYmUgd29yc2UgdGhhbiB1c2VsZXNzIGhlcmU6IGEgY29ycmVjdGVkIGBjcmVhdGVgXG4gKiBibG9jayB3b3VsZCBzaXQgbmV4dCB0byBhIHN0YWxlIGBsaXN0YCBibG9jayBhbmQgZmFpbCBpbiBhIGNvbmZ1c2luZyB3YXkuXG4gKlxuICogUHVyZSBhbmQgc2VwYXJhdGUgZnJvbSBjaHJvbWUuc3RvcmFnZSBzbyBpdCBjYW4gYmUgdGVzdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWVyZ2VTZXR0aW5ncyhzdG9yZWQ6IFBhcnRpYWw8U2V0dGluZ3M+IHwgdW5kZWZpbmVkKTogU2V0dGluZ3Mge1xuICAgIGNvbnN0IHN0b3JlZFZlcnNpb24gPSBzdG9yZWQ/LmVuZHBvaW50VmVyc2lvbiA/PyAwO1xuICAgIGNvbnN0IHNoaXBwZWRJc05ld2VyID0gc3RvcmVkVmVyc2lvbiA8IERFRkFVTFRfU0VUVElOR1MuZW5kcG9pbnRWZXJzaW9uO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgLi4uREVGQVVMVF9TRVRUSU5HUyxcbiAgICAgICAgLi4uc3RvcmVkLFxuICAgICAgICBlbmRwb2ludFZlcnNpb246IERFRkFVTFRfU0VUVElOR1MuZW5kcG9pbnRWZXJzaW9uLFxuICAgICAgICBlbmRwb2ludDogc2hpcHBlZElzTmV3ZXIgfHwgIXN0b3JlZD8uZW5kcG9pbnRcbiAgICAgICAgICAgID8gREVGQVVMVF9TRVRUSU5HUy5lbmRwb2ludFxuICAgICAgICAgICAgOiBzdG9yZWQuZW5kcG9pbnQsXG4gICAgfTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRTZXR0aW5ncygpOiBQcm9taXNlPFNldHRpbmdzPiB7XG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdzZXR0aW5ncycpO1xuICAgIHJldHVybiBtZXJnZVNldHRpbmdzKHN0b3JlZC5zZXR0aW5ncyBhcyBQYXJ0aWFsPFNldHRpbmdzPiB8IHVuZGVmaW5lZCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlU2V0dGluZ3Moc2V0dGluZ3M6IFNldHRpbmdzKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgc2V0dGluZ3MgfSk7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBFbmRwb2ludENvbmZpZyB9IGZyb20gJy4vY29yZS9jb25maWcuanMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEluUGFnZUFyZ3Mge1xuICAgIGVuZHBvaW50OiBFbmRwb2ludENvbmZpZztcbiAgICBkYXRlczogc3RyaW5nW107XG4gICAgLyoqIEh1bWFuIGxhYmVsLCBlLmcuIFwiMy0yM1wiLiBVc2VkIHRvIHJlc29sdmUgdGhlIGlkIHdoZW4gb25lIGlzIG5vdCBjYWNoZWQuICovXG4gICAgZGVza05hbWU6IHN0cmluZztcbiAgICAvKiogSW50ZXJuYWwgaWQuIE9ubHkgdXNlZCB3aGVuIG5vIHJlc29sdmUgZW5kcG9pbnQgaXMgY29uZmlndXJlZC4gKi9cbiAgICBkZXNrSWQ6IHN0cmluZztcbiAgICBzbG90OiBzdHJpbmc7XG4gICAgLyoqIE5haXZlIGxvY2FsIHRpbWVzIGZvciB0aGUgc2xvdCwgZS5nLiBcIjAwOjAwOjAwLjAwMFpcIi4gKi9cbiAgICBzdGFydFRpbWU6IHN0cmluZztcbiAgICBlbmRUaW1lOiBzdHJpbmc7XG4gICAgZmxvb3JJZDogbnVtYmVyO1xuICAgIGJ1aWxkaW5nSWQ6IG51bWJlcjtcbiAgICBkcnlSdW46IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIEluUGFnZVN0YXR1cyA9ICdib29rZWQnIHwgJ3NraXBwZWQnIHwgJ2RyeS1ydW4nIHwgJ3VuYXZhaWxhYmxlJyB8ICdlcnJvcic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5QYWdlUm93IHtcbiAgICBkYXRlOiBzdHJpbmc7XG4gICAgc3RhdHVzOiBJblBhZ2VTdGF0dXM7XG4gICAgZGV0YWlsPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEluUGFnZVJlc3VsdCB7XG4gICAgcm93czogSW5QYWdlUm93W107XG4gICAgbm90ZXM6IHN0cmluZ1tdO1xuICAgIC8qKiBTZXQgd2hlbiB0aGUgZGVzayBpZCB3YXMgbG9va2VkIHVwLCBzbyB0aGUgY2FsbGVyIGNhbiBjYWNoZSBpdC4gKi9cbiAgICByZXNvbHZlZERlc2tJZD86IHN0cmluZztcbiAgICAvKipcbiAgICAgKiBQcmVzZW50IG9uIGV2ZXJ5IGVhcmx5IHJldHVybi4gTmV2ZXIgY29udGFpbnMgYSBjcmVkZW50aWFsIFx1MjAxNCBvbmx5IHdoaWNoXG4gICAgICogcGFnZSB0aGlzIHJhbiBvbiBhbmQgd2hpY2ggc3RvcmFnZSBrZXlzIGV4aXN0LCBuZXZlciB0aGVpciB2YWx1ZXMuXG4gICAgICovXG4gICAgZGlhZ25vc3RpY3M/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAvKipcbiAgICAgKiBUaGUgc2Vzc2lvbiBpcyBkZWFkLiBBIHN0cnVjdHVyZWQgZmxhZyByYXRoZXIgdGhhbiBzb21ldGhpbmcgdGhlIGNhbGxlclxuICAgICAqIGhhcyB0byBwYXR0ZXJuLW1hdGNoIG91dCBvZiBgbm90ZXNgLCBiZWNhdXNlIHRoZSBiYWNrZ3JvdW5kIHNjcmlwdCBhY3RzXG4gICAgICogb24gaXQ6IGl0IGJhZGdlcywgbm90aWZpZXMsIGFuZCByZXRyaWVzIHdoZW4geW91IG5leHQgdmlzaXQgQ29tZWVuLlxuICAgICAqL1xuICAgIHNpZ25lZE91dD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogUnVucyBpbnNpZGUgdGhlIENvbWVlbiB0YWIsIGluIHRoZSBwYWdlJ3Mgb3duIEphdmFTY3JpcHQgd29ybGQuXG4gKlxuICogXHUyNTAwXHUyNTAwXHUyNTAwIFdoeSBpdCBsb29rcyBsaWtlIHRoaXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gKiBgY2hyb21lLnNjcmlwdGluZy5leGVjdXRlU2NyaXB0YCBzZXJpYWxpemVzIHRoaXMgZnVuY3Rpb24gYW5kIHJlLXBhcnNlcyBpdCBpblxuICogdGhlIHBhZ2UuIEl0IHRoZXJlZm9yZSBDQU5OT1QgcmVmZXJlbmNlIGFueXRoaW5nIG91dHNpZGUgaXRzIG93biBib2R5OiBub1xuICogaW1wb3J0cywgbm8gbW9kdWxlLWxldmVsIGhlbHBlcnMsIG5vIGNsb3N1cmVzLiBFdmVyeSBoZWxwZXIgaXMgZGVmaW5lZCBpbmxpbmVcbiAqIG9uIHB1cnBvc2UuIFJlc2lzdCB0aGUgdXJnZSB0byBcImNsZWFuIHRoaXMgdXBcIiBieSBob2lzdGluZyB0aGVtIG91dC5cbiAqXG4gKiBcdTI1MDBcdTI1MDBcdTI1MDAgVGhlIHNlY3VyaXR5IHByb3BlcnR5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICogVGhlIGNyZWRlbnRpYWwgaXMgcmVhZCBoZXJlLCB1c2VkIGhlcmUsIGFuZCBkaXNjYXJkZWQgaGVyZS4gSXQgaXMgbmV2ZXJcbiAqIHJldHVybmVkIHRvIHRoZSBleHRlbnNpb24sIG5ldmVyIHdyaXR0ZW4gdG8gY2hyb21lLnN0b3JhZ2UsIGFuZCBuZXZlciBsZWF2ZXNcbiAqIHRoZSB0YWIuIFRoZSBleHRlbnNpb24gaG9sZHMgY29uZmlndXJhdGlvbiBvbmx5LiBUaGF0IGlzIHRoZSB3aG9sZSByZWFzb24gdG9cbiAqIHByZWZlciB0aGlzIGRlc2lnbiBvdmVyIGEgc2VydmVyLXNpZGUgc2NyaXB0IGhvbGRpbmcgYSBzdG9yZWQgdG9rZW4uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBib29rSW5QYWdlKGFyZ3M6IEluUGFnZUFyZ3MpOiBQcm9taXNlPEluUGFnZVJlc3VsdD4ge1xuICAgIGNvbnN0IHsgZW5kcG9pbnQsIGRhdGVzLCBkZXNrTmFtZSwgc2xvdCwgc3RhcnRUaW1lLCBlbmRUaW1lLCBkcnlSdW4gfSA9IGFyZ3M7XG4gICAgY29uc3Qgbm90ZXM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3Qgcm93czogSW5QYWdlUm93W10gPSBbXTtcbiAgICBsZXQgZGVza0lkID0gYXJncy5kZXNrSWQ7XG4gICAgbGV0IHJlc29sdmVkRGVza0lkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgbGV0IHNpZ25lZE91dCA9IGZhbHNlO1xuICAgIC8qKlxuICAgICAqIERheXMgdGhpcyBkZXNrIGFscmVhZHkgbG9va3Mgc3Bva2VuIGZvciwgcmVhZCBvZmYgdGhlIHJlc29sdmVkIGRlc2sncyBvd25cbiAgICAgKiBzY2hlZHVsZS4gRGVsaWJlcmF0ZWx5IEFEVklTT1JZOiBpdCBjaGFuZ2VzIHdoYXQgUHJldmlldyByZXBvcnRzLCBhbmRcbiAgICAgKiBuZXZlciB3aGV0aGVyIGEgcmVhbCBib29raW5nIGlzIGF0dGVtcHRlZC4gU2VlIHRoZSBjcmVhdGUgbG9vcC5cbiAgICAgKi9cbiAgICBjb25zdCB0YWtlbkRhdGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgICAvLyBXaGF0ZXZlciB3ZSBsZWFybiBhbG9uZyB0aGUgd2F5IGVuZHMgdXAgaGVyZSBhbmQgZmVlZHMgdGhlIGNyZWF0ZSBib2R5LlxuICAgIGNvbnN0IHZhcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgIGRlc2tOYW1lLFxuICAgICAgICBzbG90LFxuICAgICAgICBzdGFydFRpbWUsXG4gICAgICAgIGVuZFRpbWUsXG4gICAgICAgIGZsb29ySWQ6IFN0cmluZyhhcmdzLmZsb29ySWQpLFxuICAgICAgICBidWlsZGluZ0lkOiBTdHJpbmcoYXJncy5idWlsZGluZ0lkKSxcbiAgICAgICAgZnJvbTogZGF0ZXNbMF0gPz8gJycsXG4gICAgICAgIHRvOiBkYXRlc1tkYXRlcy5sZW5ndGggLSAxXSA/PyAnJyxcbiAgICB9O1xuXG4gICAgLy8gRGlhZ25vc3RpY3MgZm9yIGV2ZXJ5IGZhaWx1cmUgcGF0aC4gS2V5IE5BTUVTIG9ubHksIG5ldmVyIHZhbHVlcywgc28gdGhpc1xuICAgIC8vIGNhbiBzYXkgXCJ5b3UgYXJlIHNpZ25lZCBvdXRcIiB3aXRob3V0IGV2ZXIgaGFuZGxpbmcgYSBjcmVkZW50aWFsLlxuICAgIGNvbnN0IGRpYWdub3N0aWNzID0gKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+ICh7XG4gICAgICAgIHVybDogd2luZG93LmxvY2F0aW9uLmhyZWYsXG4gICAgICAgIGxvY2FsU3RvcmFnZUtleXM6ICgoKSA9PiB7XG4gICAgICAgICAgICB0cnkgeyByZXR1cm4gT2JqZWN0LmtleXMod2luZG93LmxvY2FsU3RvcmFnZSk7IH0gY2F0Y2ggeyByZXR1cm4gWyc8dW5yZWFkYWJsZT4nXTsgfVxuICAgICAgICB9KSgpLFxuICAgICAgICBjb29raWVOYW1lczogKCgpID0+IHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRvY3VtZW50LmNvb2tpZS5zcGxpdCgnOycpXG4gICAgICAgICAgICAgICAgICAgIC5tYXAoKHBhaXIpID0+IHBhaXIuc3BsaXQoJz0nKVswXT8udHJpbSgpID8/ICcnKVxuICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgICAgICAgfSBjYXRjaCB7IHJldHVybiBbJzx1bnJlYWRhYmxlPiddOyB9XG4gICAgICAgIH0pKCksXG4gICAgfSk7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgaW5saW5lIGhlbHBlcnMgKHNlZSBjb21tZW50IGFib3ZlKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAgIC8vIE1pcnJvcnMgYHN1YnN0aXR1dGVgIGluIGNvcmUvY29uZmlnLnRzLiBBIHBsYWNlaG9sZGVyIHRoYXQgaXMgdGhlIGVudGlyZVxuICAgIC8vIHZhbHVlIGFuZCByZXNvbHZlcyB0byBhbiBpbnRlZ2VyIGJlY29tZXMgYSBudW1iZXIsIGJlY2F1c2UgQ29tZWVuJ3NcbiAgICAvLyBwcmVzZW5jZSBibG9jayB3YW50cyBidWlsZGluZ19pZDogNTE1MSwgbm90IFwiNTE1MVwiLiBQYXJ0aWFsXG4gICAgLy8gaW50ZXJwb2xhdGlvbiBzdGF5cyBhIHN0cmluZywgd2hpY2ggaXMgd2hhdCBhIFVSTCBwYXRoIG5lZWRzLlxuICAgIGNvbnN0IGZpbGwgPSAodmFsdWU6IHVua25vd24sIHNvdXJjZTogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IHVua25vd24gPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgY29uc3Qgd2hvbGUgPSAvXlxce1xceyhcXHcrKVxcfVxcfSQvLmV4ZWModmFsdWUpO1xuICAgICAgICAgICAgaWYgKHdob2xlKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVwbGFjZW1lbnQgPSBzb3VyY2Vbd2hvbGVbMV0gPz8gJyddO1xuICAgICAgICAgICAgICAgIGlmIChyZXBsYWNlbWVudCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdmFsdWU7XG4gICAgICAgICAgICAgICAgcmV0dXJuIC9eLT9cXGQrJC8udGVzdChyZXBsYWNlbWVudCkgPyBOdW1iZXIocmVwbGFjZW1lbnQpIDogcmVwbGFjZW1lbnQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUucmVwbGFjZSgvXFx7XFx7KFxcdyspXFx9XFx9L2csIChtYXRjaCwga2V5OiBzdHJpbmcpID0+IHNvdXJjZVtrZXldID8/IG1hdGNoKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB2YWx1ZS5tYXAoKGVudHJ5KSA9PiBmaWxsKGVudHJ5LCBzb3VyY2UpKTtcbiAgICAgICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2tleSwgZW50cnldIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlKSkgb3V0W2tleV0gPSBmaWxsKGVudHJ5LCBzb3VyY2UpO1xuICAgICAgICAgICAgcmV0dXJuIG91dDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfTtcblxuICAgIGNvbnN0IGRpZyA9IChvYmo6IHVua25vd24sIHBhdGg6IHN0cmluZyk6IHVua25vd24gPT4gcGF0aFxuICAgICAgICAuc3BsaXQoJy4nKVxuICAgICAgICAucmVkdWNlPHVua25vd24+KChjdXJyZW50LCBrZXkpID0+IChcbiAgICAgICAgICAgIGN1cnJlbnQgJiYgdHlwZW9mIGN1cnJlbnQgPT09ICdvYmplY3QnID8gKGN1cnJlbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW2tleV0gOiB1bmRlZmluZWRcbiAgICAgICAgKSwgb2JqKTtcblxuICAgIGNvbnN0IGF1dGhIZWFkZXJzID0gKCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPT4ge1xuICAgICAgICBpZiAoZW5kcG9pbnQuYXV0aC5tb2RlICE9PSAnbG9jYWxTdG9yYWdlJykgcmV0dXJuIHt9O1xuICAgICAgICBjb25zdCB7IHN0b3JhZ2VLZXksIGpzb25QYXRoLCBoZWFkZXIsIHByZWZpeCB9ID0gZW5kcG9pbnQuYXV0aDtcbiAgICAgICAgaWYgKCFzdG9yYWdlS2V5IHx8ICFqc29uUGF0aCkge1xuICAgICAgICAgICAgbm90ZXMucHVzaCgnYXV0aC5tb2RlIGlzIGxvY2FsU3RvcmFnZSBidXQgc3RvcmFnZUtleS9qc29uUGF0aCBhcmUgbWlzc2luZy4nKTtcbiAgICAgICAgICAgIHJldHVybiB7fTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByYXcgPSB3aW5kb3cubG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSk7XG4gICAgICAgIGlmICghcmF3KSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGBsb2NhbFN0b3JhZ2Uga2V5IFwiJHtzdG9yYWdlS2V5fVwiIG5vdCBmb3VuZC4gQXJlIHlvdSBzaWduZWQgaW4/YCk7XG4gICAgICAgICAgICByZXR1cm4ge307XG4gICAgICAgIH1cbiAgICAgICAgbGV0IHRva2VuOiB1bmtub3duO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgdG9rZW4gPSBkaWcoSlNPTi5wYXJzZShyYXcpLCBqc29uUGF0aCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgbm90ZXMucHVzaChgbG9jYWxTdG9yYWdlIGtleSBcIiR7c3RvcmFnZUtleX1cIiBpcyBub3QgSlNPTi5gKTtcbiAgICAgICAgICAgIHJldHVybiB7fTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodHlwZW9mIHRva2VuICE9PSAnc3RyaW5nJyB8fCAhdG9rZW4pIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goYE5vIHRva2VuIGF0IHBhdGggXCIke2pzb25QYXRofVwiLmApO1xuICAgICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IFtoZWFkZXIgPz8gJ2F1dGhvcml6YXRpb24nXTogYCR7cHJlZml4ID8/ICdCZWFyZXIgJ30ke3Rva2VufWAgfTtcbiAgICB9O1xuXG4gICAgY29uc3QgY2FsbCA9IGFzeW5jIChcbiAgICAgICAgdHBsOiB7IG1ldGhvZDogc3RyaW5nOyBwYXRoOiBzdHJpbmc7IHF1ZXJ5PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjsgYm9keT86IHVua25vd24gfSxcbiAgICAgICAgc291cmNlOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuICAgICk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IHVua25vd247IHRleHQ6IHN0cmluZzsgc2lnbmVkT3V0OiBib29sZWFuIH0+ID0+IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IGZpbGwodHBsLnBhdGgsIHNvdXJjZSkgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKGAke2VuZHBvaW50LmFwaUJhc2UucmVwbGFjZSgvXFwvJC8sICcnKX0ke3BhdGh9YCk7XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGZpbGwodHBsLnF1ZXJ5ID8/IHt9LCBzb3VyY2UpIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz4pKSB7XG4gICAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLnNldChrZXksIFN0cmluZyh2YWx1ZSkpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGJvZHkgPSB0cGwuYm9keSA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogSlNPTi5zdHJpbmdpZnkoZmlsbCh0cGwuYm9keSwgc291cmNlKSk7XG5cbiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgd2luZG93LmZldGNoKHVybC50b1N0cmluZygpLCB7XG4gICAgICAgICAgICBtZXRob2Q6IHRwbC5tZXRob2QsXG4gICAgICAgICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLFxuICAgICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgICAgIGFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgIC4uLihib2R5ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9KSxcbiAgICAgICAgICAgICAgICAuLi5hdXRoSGVhZGVycygpLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGJvZHksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgICAgICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gICAgICAgIHRyeSB7IGRhdGEgPSB0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IG51bGw7IH0gY2F0Y2ggeyBkYXRhID0gbnVsbDsgfVxuXG4gICAgICAgIC8vIEFuIGV4cGlyZWQgc2Vzc2lvbiBkb2VzIG5vdCBhbm5vdW5jZSBpdHNlbGYgd2l0aCBhIHRpZHkgNDAxLiBDb21lZW5cbiAgICAgICAgLy8gcmVkaXJlY3RzIHRvIHRoZSBsb2dpbiBwYWdlLCBzbyB0aGUgZmV0Y2ggZm9sbG93cyBpdCBhbmQgaGFuZHMgYmFjayBhXG4gICAgICAgIC8vIDIwMCBmdWxsIG9mIEhUTUwuIFBhcnNlZCBhcyBKU09OIHRoYXQgYmVjb21lcyBudWxsLCB3aGljaCBkb3duc3RyZWFtXG4gICAgICAgIC8vIHJlYWRzIGFzIFwiemVybyByZXN1bHRzXCIgXHUyMDE0IGhlbmNlIHRoZSBvbGQsIGJhZGx5IG1pc2xlYWRpbmcgXCJubyBkZXNrXG4gICAgICAgIC8vIGNhbGxlZCAzLTIzIGluIDAgc2VhcmNoIHJlc3VsdChzKVwiLiBDYXRjaCBpdCBoZXJlIGluc3RlYWQuXG4gICAgICAgIGxldCBmaW5hbEhvc3QgPSAnJztcbiAgICAgICAgdHJ5IHsgZmluYWxIb3N0ID0gbmV3IFVSTChyZXMudXJsKS5ob3N0bmFtZTsgfSBjYXRjaCB7IC8qIHN0dWIgb3Igb3BhcXVlICovIH1cbiAgICAgICAgY29uc3QgbG9va3NMaWtlSHRtbCA9IC9eXFxzKjwoIWRvY3R5cGV8aHRtbCkvaS50ZXN0KHRleHQpO1xuICAgICAgICBjb25zdCBzaWduZWRPdXQgPSByZXMuc3RhdHVzID09PSA0MDFcbiAgICAgICAgICAgIHx8IHJlcy5zdGF0dXMgPT09IDQwM1xuICAgICAgICAgICAgfHwgLyhefFxcLilhY2NvdW50c1xcLmNvbWVlblxcLmlvJC8udGVzdChmaW5hbEhvc3QpXG4gICAgICAgICAgICB8fCAobG9va3NMaWtlSHRtbCAmJiBkYXRhID09PSBudWxsKTtcblxuICAgICAgICByZXR1cm4geyBvazogcmVzLm9rLCBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEsIHRleHQsIHNpZ25lZE91dCB9O1xuICAgIH07XG5cbiAgICBjb25zdCBzaWduZWRPdXRSZXN1bHQgPSAoKTogSW5QYWdlUmVzdWx0ID0+ICh7XG4gICAgICAgIHJvd3M6IFtdLFxuICAgICAgICBub3RlczogWydOb3Qgc2lnbmVkIGluIHRvIENvbWVlbi4gT3BlbiBodHRwczovL215LmNvbWVlbi5pby8sIHNpZ24gaW4sIHRoZW4gcnVuIGFnYWluLiddLFxuICAgICAgICBkaWFnbm9zdGljczogZGlhZ25vc3RpY3MoKSxcbiAgICAgICAgc2lnbmVkT3V0OiB0cnVlLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYXNMaXN0ID0gKGRhdGE6IHVua25vd24pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdID0+IHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHJldHVybiBkYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+W107XG4gICAgICAgIGlmIChkYXRhICYmIHR5cGVvZiBkYXRhID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgY29uc3Qgb2JqID0gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIFsnaXRlbXMnLCAnZGF0YScsICdyZXN1bHRzJywgJ2Jvb2tpbmdzJywgJ2Rlc2tzJ10pIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvYmpba2V5XSkpIHJldHVybiBvYmpba2V5XSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBbXTtcbiAgICB9O1xuXG4gICAgY29uc3Qgbm9ybWFsaXNlID0gKHZhbHVlOiB1bmtub3duKTogc3RyaW5nID0+IFN0cmluZyh2YWx1ZSA/PyAnJylcbiAgICAgICAgLnRyaW0oKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1tcXHNfXSsvZywgJy0nKTtcblxuICAgIC8vIENvbmZpcm1lZCBhZ2FpbnN0IGEgcmVhbCBjb250ZW5kZWQgZGF5OiBDb21lZW4gcmVqZWN0cyBhIGRlc2sgc29tZW9uZSBlbHNlXG4gICAgLy8gYWxyZWFkeSBob2xkcyB3aXRoIDQyMiBhbmQgYSBtZXNzYWdlLCBub3QgYSBjbGVhbiA0MDkuIFJlYWRpbmcgdGhlIG1lc3NhZ2VcbiAgICAvLyBhcyB3ZWxsIGFzIHRoZSBzdGF0dXMgaXMgd2hhdCBrZWVwcyB0aGF0IHJlcG9ydGVkIGFzIFwidW5hdmFpbGFibGVcIiByYXRoZXJcbiAgICAvLyB0aGFuIGFzIGFuIGVycm9yIHRoYXQgbG9va3MgbGlrZSBhIGJ1ZyBpbiB0aGlzIGV4dGVuc2lvbi5cbiAgICBjb25zdCBsb29rc1Rha2VuID0gKHN0YXR1czogbnVtYmVyLCB0ZXh0OiBzdHJpbmcpOiBib29sZWFuID0+IHN0YXR1cyA9PT0gNDA5XG4gICAgICAgIHx8IHN0YXR1cyA9PT0gNDIyXG4gICAgICAgIHx8IC90YWtlbnxhbHJlYWR5fHVuYXZhaWxhYmxlfG9jY3VwaWVkfGZ1bGx8Y29uZmxpY3QvaS50ZXN0KHRleHQpO1xuXG4gICAgLy8gXHUyNTAwXHUyNTAwIDEuIHdoaWNoIGRlc2s/IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIC8vIFJlc29sdmluZyBldmVyeSBydW4gcmF0aGVyIHRoYW4gdHJ1c3RpbmcgYSBjYWNoZWQgaWQ6IHRoZSBsb29rdXAgYWxzb1xuICAgIC8vIHlpZWxkcyB0aGUgZGVzaydzIGFyZWFfaWQsIHdoaWNoIHRoZSBjcmVhdGUgYm9keSBuZWVkcywgYW5kIGl0IG1lYW5zIGFcbiAgICAvLyByZW51bWJlcmVkIG9yIG1vdmVkIGRlc2sgY29ycmVjdHMgaXRzZWxmIGluc3RlYWQgb2YgYm9va2luZyB0aGUgd3Jvbmcgc2VhdC5cbiAgICBpZiAoZW5kcG9pbnQucmVzb2x2ZSkge1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBjYWxsKGVuZHBvaW50LnJlc29sdmUsIHZhcnMpO1xuICAgICAgICBpZiAocmVzLnNpZ25lZE91dCkgcmV0dXJuIHNpZ25lZE91dFJlc3VsdCgpO1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgICAgICBub3RlczogW2BEZXNrIGxvb2t1cCBmYWlsZWQgKCR7cmVzLnN0YXR1c30pOiAke3Jlcy50ZXh0LnNsaWNlKDAsIDIwMCl9YF0sXG4gICAgICAgICAgICAgICAgZGlhZ25vc3RpY3M6IGRpYWdub3N0aWNzKCksXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGFzTGlzdChyZXMuZGF0YSk7XG4gICAgICAgIGNvbnN0IG1hdGNoID0gY2FuZGlkYXRlcy5maW5kKChkZXNrKSA9PiBlbmRwb2ludC5kZXNrTmFtZUZpZWxkc1xuICAgICAgICAgICAgLnNvbWUoKGZpZWxkKSA9PiBub3JtYWxpc2UoZGVza1tmaWVsZF0pID09PSBub3JtYWxpc2UoZGVza05hbWUpKSk7XG5cbiAgICAgICAgaWYgKCFtYXRjaCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgICAgICBub3RlczogW1xuICAgICAgICAgICAgICAgICAgICBgTm8gZGVzayBjYWxsZWQgXCIke2Rlc2tOYW1lfVwiIGluICR7Y2FuZGlkYXRlcy5sZW5ndGh9IHNlYXJjaCByZXN1bHQocykuYCxcbiAgICAgICAgICAgICAgICAgICAgYEZpcnN0IGZldzogJHtKU09OLnN0cmluZ2lmeShjYW5kaWRhdGVzLnNsaWNlKDAsIDMpKS5zbGljZSgwLCA0MDApfWAsXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICBkaWFnbm9zdGljczogZGlhZ25vc3RpY3MoKSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBpZEZpZWxkID0gZW5kcG9pbnQuZGVza0lkRmllbGRzLmZpbmQoKGZpZWxkKSA9PiBtYXRjaFtmaWVsZF0gIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgJiYgbWF0Y2hbZmllbGRdICE9PSBudWxsKTtcbiAgICAgICAgaWYgKCFpZEZpZWxkKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHJvd3M6IFtdLFxuICAgICAgICAgICAgICAgIG5vdGVzOiBbXG4gICAgICAgICAgICAgICAgICAgIGBGb3VuZCBcIiR7ZGVza05hbWV9XCIgYnV0IG5vbmUgb2YgJHtlbmRwb2ludC5kZXNrSWRGaWVsZHMuam9pbignLycpfSBoZWxkIGFuIGlkLmAsXG4gICAgICAgICAgICAgICAgICAgIGBSZWNvcmQ6ICR7SlNPTi5zdHJpbmdpZnkobWF0Y2gpLnNsaWNlKDAsIDQwMCl9YCxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgIGRpYWdub3N0aWNzOiBkaWFnbm9zdGljcygpLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGRlc2tJZCA9IFN0cmluZyhtYXRjaFtpZEZpZWxkXSk7XG4gICAgICAgIHJlc29sdmVkRGVza0lkID0gZGVza0lkO1xuICAgICAgICBub3Rlcy5wdXNoKGBSZXNvbHZlZCBcIiR7ZGVza05hbWV9XCIgdG8gJHtpZEZpZWxkfSAke2Rlc2tJZH0uYCk7XG5cbiAgICAgICAgLy8gVGhlIGRlc2sga25vd3Mgd2hpY2ggYXJlYSBhbmQgZmxvb3IgaXQgaXMgaW47IHByZWZlciB0aGF0IG92ZXIgdGhlXG4gICAgICAgIC8vIGNvbmZpZ3VyZWQgZmxvb3IsIHdoaWNoIGlzIG9ubHkgYSBzdGFydGluZyBwb2ludCBmb3IgdGhlIGxvb2t1cC5cbiAgICAgICAgaWYgKG1hdGNoLmFyZWFfaWQgIT09IHVuZGVmaW5lZCAmJiBtYXRjaC5hcmVhX2lkICE9PSBudWxsKSB2YXJzLmFyZWFJZCA9IFN0cmluZyhtYXRjaC5hcmVhX2lkKTtcbiAgICAgICAgaWYgKG1hdGNoLmZsb29yX2lkICE9PSB1bmRlZmluZWQgJiYgbWF0Y2guZmxvb3JfaWQgIT09IG51bGwpIHZhcnMuZmxvb3JJZCA9IFN0cmluZyhtYXRjaC5mbG9vcl9pZCk7XG5cbiAgICAgICAgaWYgKG1hdGNoLmF2YWlsYWJsZV90b19ib29raW5nID09PSBmYWxzZSkge1xuICAgICAgICAgICAgbm90ZXMucHVzaChgXHUyNkEwIFwiJHtkZXNrTmFtZX1cIiBpcyBtYXJrZWQgbm90IGF2YWlsYWJsZSB0byBib29raW5nIFx1MjAxNCBpdCBtYXkgYmUgYXNzaWduZWQgdG8gc29tZW9uZS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFRoZSBkZXNrIGNhcnJpZXMgaXRzIG93biBib29raW5ncyBmb3IgdGhlIHF1ZXJpZWQgd2luZG93LCB3aGljaCBpcyBob3dcbiAgICAgICAgLy8gUHJldmlldyBjYW4gc2F5IFwic29tZW9uZSBlbHNlIGhhcyBpdFwiIGluc3RlYWQgb2YgY2hlZXJmdWxseSBwcm9taXNpbmdcbiAgICAgICAgLy8gYSBkYXkgdGhhdCB3aWxsIDQyMiB0aGUgbW9tZW50IHlvdSBwcmVzcyBCb29rIG5vdy5cbiAgICAgICAgaWYgKGVuZHBvaW50LmRlc2tTY2hlZHVsZUZpZWxkKSB7XG4gICAgICAgICAgICBjb25zdCBlbnRyaWVzID0gbWF0Y2hbZW5kcG9pbnQuZGVza1NjaGVkdWxlRmllbGRdO1xuICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZW50cmllcykpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBlbnRyeSAhPT0gJ29iamVjdCcpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIGVuZHBvaW50LmRlc2tTY2hlZHVsZURhdGVGaWVsZHMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gZW50cnlbZmllbGRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgL15cXGR7NH0tXFxkezJ9LVxcZHsyfS8udGVzdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWtlbkRhdGVzLmFkZCh2YWx1ZS5zbGljZSgwLCAxMCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICh0YWtlbkRhdGVzLnNpemUgPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goYFwiJHtkZXNrTmFtZX1cIiBhbHJlYWR5IGhhcyAke3Rha2VuRGF0ZXMuc2l6ZX0gZGF5KHMpIGJvb2tlZCBpbiB0aGlzIHdpbmRvdy5gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIWRlc2tJZCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgcm93czogW10sXG4gICAgICAgICAgICBub3RlczogWydObyBkZXNrIElEIHNldCBhbmQgbm8gZGVzay1zZWFyY2ggZW5kcG9pbnQgY29uZmlndXJlZC4nXSxcbiAgICAgICAgICAgIGRpYWdub3N0aWNzOiBkaWFnbm9zdGljcygpLFxuICAgICAgICB9O1xuICAgIH1cbiAgICB2YXJzLmRlc2tJZCA9IGRlc2tJZDtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCAyLiB3aGF0IGRvIEkgYWxyZWFkeSBoYXZlPyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBjb25zdCBoZWxkRGF0ZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICAgIGlmIChlbmRwb2ludC5saXN0KSB7XG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGNhbGwoZW5kcG9pbnQubGlzdCwgdmFycyk7XG4gICAgICAgIGlmIChyZXMuc2lnbmVkT3V0KSByZXR1cm4gc2lnbmVkT3V0UmVzdWx0KCk7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgICAvLyBOb3QgZmF0YWwsIGJ1dCBpdCBtZWFucyB3ZSBsb3NlIGlkZW1wb3RlbmN5LCBzbyBzYXkgc28gbG91ZGx5LlxuICAgICAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgICAgICBgQ291bGQgbm90IGxpc3QgZXhpc3RpbmcgYm9va2luZ3MgKCR7cmVzLnN0YXR1c30pLiBQcm9jZWVkaW5nIHdpdGhvdXQgdGhlIGBcbiAgICAgICAgICAgICAgICArIGBkdXBsaWNhdGUgY2hlY2ssIHNvIGV4cGVjdCBcInVuYXZhaWxhYmxlXCIgb24gZGF5cyB5b3UgYWxyZWFkeSBob2xkLiBgXG4gICAgICAgICAgICAgICAgKyBgUmVzcG9uc2U6ICR7cmVzLnRleHQuc2xpY2UoMCwgMjAwKX1gLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIFRoZSBzaWduZWQtaW4gdXNlcidzIG93biBpZCBpcyBpbiB0aGlzIHJlc3BvbnNlLCBhbmQgdGhlIGNyZWF0ZVxuICAgICAgICAgICAgLy8gcGF0aCBuZWVkcyBpdC4gUmVhZGluZyBpdCBoZXJlIGF2b2lkcyBhIHNlY29uZCByb3VuZCB0cmlwIGFuZFxuICAgICAgICAgICAgLy8gYXZvaWRzIG1ha2luZyB0aGUgdXNlciBsb29rIHRoZWlyIG93biBpZCB1cC5cbiAgICAgICAgICAgIGlmIChlbmRwb2ludC51c2VySWRQYXRoKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdXNlcklkID0gZGlnKHJlcy5kYXRhLCBlbmRwb2ludC51c2VySWRQYXRoKTtcbiAgICAgICAgICAgICAgICBpZiAodXNlcklkICE9PSB1bmRlZmluZWQgJiYgdXNlcklkICE9PSBudWxsKSB2YXJzLnVzZXJJZCA9IFN0cmluZyh1c2VySWQpO1xuICAgICAgICAgICAgICAgIGVsc2Ugbm90ZXMucHVzaChgTm8gdXNlciBpZCBhdCBcIiR7ZW5kcG9pbnQudXNlcklkUGF0aH1cIiBpbiB0aGUgbGlzdCByZXNwb25zZS5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgY29udGFpbmVyID0gZW5kcG9pbnQubGlzdFJvb3QgPyBkaWcocmVzLmRhdGEsIGVuZHBvaW50Lmxpc3RSb290KSA6IHJlcy5kYXRhO1xuXG4gICAgICAgICAgICBpZiAoZW5kcG9pbnQubGlzdFNoYXBlID09PSAnZGF0ZUtleWVkTWFwJykge1xuICAgICAgICAgICAgICAgIC8vIHsgXCIyMDI2LTA5LTAxXCI6IFtlbnRyeV0sIFwiMjAyNi0wOS0wMlwiOiBbXSB9IFx1MjAxNCBhIGRheSB3aXRoIGFueVxuICAgICAgICAgICAgICAgIC8vIGVudHJ5IGlzIGEgZGF5IGFscmVhZHkgc3Bva2VuIGZvci5cbiAgICAgICAgICAgICAgICBpZiAoY29udGFpbmVyICYmIHR5cGVvZiBjb250YWluZXIgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KGNvbnRhaW5lcikpIHtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBbZGF0ZSwgZW50cmllc10gb2YgT2JqZWN0LmVudHJpZXMoY29udGFpbmVyIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZW50cmllcykgJiYgZW50cmllcy5sZW5ndGggPiAwKSBoZWxkRGF0ZXMuYWRkKGRhdGUuc2xpY2UoMCwgMTApKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBub3Rlcy5wdXNoKGBGb3VuZCAke2hlbGREYXRlcy5zaXplfSBkYXkocykgYWxyZWFkeSBib29rZWQgaW4gdGhlIHdpbmRvdy5gKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBub3Rlcy5wdXNoKFxuICAgICAgICAgICAgICAgICAgICAgICAgYGxpc3RTaGFwZSBpcyBkYXRlS2V5ZWRNYXAgYnV0IFwiJHtlbmRwb2ludC5saXN0Um9vdH1cIiBpcyBub3QgYW4gb2JqZWN0LiBgXG4gICAgICAgICAgICAgICAgICAgICAgICArIGBHb3Q6ICR7SlNPTi5zdHJpbmdpZnkoY29udGFpbmVyKS5zbGljZSgwLCAyMDApfWAsXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGFzTGlzdChjb250YWluZXIpO1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgYm9va2luZyBvZiBleGlzdGluZykge1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIGVuZHBvaW50Lmxpc3REYXRlRmllbGRzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGJvb2tpbmdbZmllbGRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBoZWxkRGF0ZXMuYWRkKHZhbHVlLnNsaWNlKDAsIDEwKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbm90ZXMucHVzaChgRm91bmQgJHtleGlzdGluZy5sZW5ndGh9IGV4aXN0aW5nIGJvb2tpbmcocykgaW4gdGhlIHdpbmRvdy5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIGBtZWAgd29ya3MgZm9yIHJlYWRzLCBzbyBpdCBpcyBhIGJldHRlciBmYWxsYmFjayB0aGFuIGEgbGl0ZXJhbFxuICAgIC8vIHt7dXNlcklkfX0gaW4gdGhlIHBhdGggaWYgdGhlIGxpc3Qgc3RlcCBjb3VsZCBub3Qgc3VwcGx5IG9uZS5cbiAgICBpZiAodmFycy51c2VySWQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YXJzLnVzZXJJZCA9ICdtZSc7XG4gICAgICAgIGlmIChlbmRwb2ludC51c2VySWRQYXRoKSBub3Rlcy5wdXNoKCdGYWxsaW5nIGJhY2sgdG8gL3VzZXJzL21lIGZvciB0aGUgYm9va2luZyBwYXRoLicpO1xuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCAzLiBib29rIHRoZSBnYXBzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIGZvciAoY29uc3QgZGF0ZSBvZiBkYXRlcykge1xuICAgICAgICBpZiAoaGVsZERhdGVzLmhhcyhkYXRlKSkge1xuICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnc2tpcHBlZCcsIGRldGFpbDogJ2FscmVhZHkgYm9va2VkJyB9KTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChkcnlSdW4pIHtcbiAgICAgICAgICAgIHJvd3MucHVzaCh0YWtlbkRhdGVzLmhhcyhkYXRlKVxuICAgICAgICAgICAgICAgID8geyBkYXRlLCBzdGF0dXM6ICd1bmF2YWlsYWJsZScsIGRldGFpbDogJ3NvbWVvbmUgZWxzZSBob2xkcyB0aGlzIGRlc2sgdGhhdCBkYXknIH1cbiAgICAgICAgICAgICAgICA6IHsgZGF0ZSwgc3RhdHVzOiAnZHJ5LXJ1bicsIGRldGFpbDogYHdvdWxkIGJvb2sgJHtkZXNrSWR9ICgke3Nsb3R9KWAgfSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIE5vdGUgdGhlIGFzeW1tZXRyeSwgYW5kIGRvIG5vdCBcIm9wdGltaXNlXCIgdGhpcyBpbnRvIGEgc2tpcC4gVGhlIGRlc2tcbiAgICAgICAgLy8gc2NoZWR1bGUgaXMgcmVhZCBkZWZlbnNpdmVseSBmcm9tIGEgc2hhcGUgdGhhdCBoYXMgbmV2ZXIgYmVlbiBzZWVuXG4gICAgICAgIC8vIHBvcHVsYXRlZCwgc28gYSBtaXNyZWFkaW5nIGlzIHBvc3NpYmxlLiBBdHRlbXB0aW5nIGFueXdheSBjb3N0cyBvbmVcbiAgICAgICAgLy8gcmVxdWVzdCB0aGF0IHJldHVybnMgNDIyIGFuZCBpcyByZXBvcnRlZCBhcyB1bmF2YWlsYWJsZSBcdTIwMTQgZXhhY3RseSB3aGF0XG4gICAgICAgIC8vIHdvdWxkIGhhdmUgYmVlbiByZXBvcnRlZCBieSBza2lwcGluZy4gU2tpcHBpbmcgd3JvbmdseSBjb3N0cyBhIGRheVxuICAgICAgICAvLyB5b3UgY291bGQgaGF2ZSBoYWQsIGFuZCBkb2VzIGl0IHNpbGVudGx5LlxuICAgICAgICBpZiAodGFrZW5EYXRlcy5oYXMoZGF0ZSkpIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goYCR7ZGF0ZX06IGRlc2sgbG9va3MgdGFrZW47IHRyeWluZyBhbnl3YXkgaW4gY2FzZSB0aGF0IHJlYWRpbmcgaXMgd3JvbmcuYCk7XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgY2FsbChlbmRwb2ludC5jcmVhdGUsIHsgLi4udmFycywgZGF0ZSB9KTtcbiAgICAgICAgICAgIGlmIChyZXMuc2lnbmVkT3V0KSB7XG4gICAgICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnZXJyb3InLCBkZXRhaWw6ICdub3Qgc2lnbmVkIGluJyB9KTtcbiAgICAgICAgICAgICAgICBub3Rlcy5wdXNoKCdTaWduZWQgb3V0IHBhcnR3YXkgdGhyb3VnaC4gU2lnbiBpbiBhdCBodHRwczovL215LmNvbWVlbi5pby8gYW5kIHJ1biAnXG4gICAgICAgICAgICAgICAgICAgICsgJ2FnYWluIFx1MjAxNCB0aGUgZGF5cyBhbHJlYWR5IGJvb2tlZCB3aWxsIGJlIHNraXBwZWQuJyk7XG4gICAgICAgICAgICAgICAgc2lnbmVkT3V0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChyZXMub2spIHtcbiAgICAgICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICdib29rZWQnIH0pO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChsb29rc1Rha2VuKHJlcy5zdGF0dXMsIHJlcy50ZXh0KSkge1xuICAgICAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ3VuYXZhaWxhYmxlJywgZGV0YWlsOiBgJHtyZXMuc3RhdHVzfTogJHtyZXMudGV4dC5zbGljZSgwLCAxNjApfWAgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ2Vycm9yJywgZGV0YWlsOiBgJHtyZXMuc3RhdHVzfTogJHtyZXMudGV4dC5zbGljZSgwLCAyMDApfWAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnZXJyb3InLCBkZXRhaWw6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSB9KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB7IHJvd3MsIG5vdGVzLCByZXNvbHZlZERlc2tJZCwgc2lnbmVkT3V0IH07XG59XG4iLCAiaW1wb3J0IHsgZGF0ZXNUb0Jvb2sgfSBmcm9tICcuL2NvcmUvZGF0ZXMuanMnO1xuaW1wb3J0IHtcbiAgICBpc1ZhbGlkRGVza05hbWUsXG4gICAgbG9hZFNldHRpbmdzLFxuICAgIHNhdmVTZXR0aW5ncyxcbiAgICBTTE9UX1RJTUVTLFxuICAgIHR5cGUgU2V0dGluZ3MsXG59IGZyb20gJy4vY29yZS9jb25maWcuanMnO1xuaW1wb3J0IHsgYm9va0luUGFnZSwgdHlwZSBJblBhZ2VSZXN1bHQgfSBmcm9tICcuL2luamVjdGVkLmpzJztcblxuY29uc3QgQUxBUk0gPSAnY29tZWVuLXRvcC11cCc7XG5jb25zdCBDT01FRU5fVVJMID0gJ2h0dHBzOi8vbXkuY29tZWVuLmlvLyc7XG5jb25zdCBUQUJfTUFUQ0ggPSAnaHR0cHM6Ly9teS5jb21lZW4uaW8vKic7XG5jb25zdCBTSUdORURfT1VUX05PVElGSUNBVElPTiA9ICdjb21lZW4tc2lnbmVkLW91dCc7XG5cbi8qKlxuICogVGhyb3duIHdoZW4gdGhlIHNlc3Npb24gaXMgZ29uZSwgc28gdGhlIGNhbGxlciBjYW4gdGVsbCBpdCBhcGFydCBmcm9tIGFuXG4gKiBvcmRpbmFyeSBmYWlsdXJlIGJ5IHR5cGUgcmF0aGVyIHRoYW4gYnkgcmVhZGluZyB0aGUgbWVzc2FnZSB0ZXh0LlxuICovXG5jbGFzcyBTaWduZWRPdXRFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbmV4cG9ydCBpbnRlcmZhY2UgUnVuTG9nIHtcbiAgICBhdDogc3RyaW5nO1xuICAgIGRyeVJ1bjogYm9vbGVhbjtcbiAgICBkYXRlczogc3RyaW5nW107XG4gICAgcm93czogSW5QYWdlUmVzdWx0Wydyb3dzJ107XG4gICAgbm90ZXM6IHN0cmluZ1tdO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICAgIC8qKiBUaGUgcnVuIHN0b3BwZWQgYmVjYXVzZSB0aGUgQ29tZWVuIHNlc3Npb24gaGFzIGV4cGlyZWQuICovXG4gICAgc2lnbmVkT3V0PzogYm9vbGVhbjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBwZW5kTG9nKGVudHJ5OiBSdW5Mb2cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IHJ1bnMgPSBbXSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdydW5zJykgYXMgeyBydW5zPzogUnVuTG9nW10gfTtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBydW5zOiBbZW50cnksIC4uLnJ1bnNdLnNsaWNlKDAsIDEwKSB9KTtcbn1cblxuLyoqXG4gKiBGaW5kIGEgQ29tZWVuIHRhYiwgb3Igb3BlbiBvbmUgaW4gdGhlIGJhY2tncm91bmQuXG4gKiBSZXR1cm5zIHRoZSB0YWIgaWQgcGx1cyB3aGV0aGVyIHdlIGNyZWF0ZWQgaXQgKGFuZCBzaG91bGQgdGhlcmVmb3JlIGNsb3NlIGl0KS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0Q29tZWVuVGFiKCk6IFByb21pc2U8eyB0YWJJZDogbnVtYmVyOyB0ZW1wb3Jhcnk6IGJvb2xlYW4gfT4ge1xuICAgIGNvbnN0IG9wZW4gPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IHVybDogVEFCX01BVENIIH0pO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gb3Blbi5maW5kKCh0KSA9PiB0eXBlb2YgdC5pZCA9PT0gJ251bWJlcicgJiYgdC5zdGF0dXMgPT09ICdjb21wbGV0ZScpXG4gICAgICAgID8/IG9wZW4uZmluZCgodCkgPT4gdHlwZW9mIHQuaWQgPT09ICdudW1iZXInKTtcbiAgICBpZiAoZXhpc3Rpbmc/LmlkICE9PSB1bmRlZmluZWQpIHJldHVybiB7IHRhYklkOiBleGlzdGluZy5pZCwgdGVtcG9yYXJ5OiBmYWxzZSB9O1xuXG4gICAgY29uc3QgdGFiID0gYXdhaXQgY2hyb21lLnRhYnMuY3JlYXRlKHsgdXJsOiBDT01FRU5fVVJMLCBhY3RpdmU6IGZhbHNlIH0pO1xuICAgIGlmICh0YWIuaWQgPT09IHVuZGVmaW5lZCkgdGhyb3cgbmV3IEVycm9yKCdDb3VsZCBub3Qgb3BlbiBhIENvbWVlbiB0YWIuJyk7XG4gICAgYXdhaXQgd2FpdEZvckxvYWQodGFiLmlkKTtcblxuICAgIC8vIEFuIGV4cGlyZWQgc2Vzc2lvbiByZWRpcmVjdHMgbXkuY29tZWVuLmlvIHRvIGFjY291bnRzLmNvbWVlbi5pbywgd2hpY2ggaXNcbiAgICAvLyBkZWxpYmVyYXRlbHkgbm90IGluIGhvc3RfcGVybWlzc2lvbnMgXHUyMDE0IHNvIGV4ZWN1dGVTY3JpcHQgd291bGQgZmFpbCB0aGVyZVxuICAgIC8vIHdpdGggYSBwZXJtaXNzaW9ucyBlcnJvciB0aGF0IHNheXMgbm90aGluZyBhYm91dCB0aGUgYWN0dWFsIHByb2JsZW0uXG4gICAgLy8gQ2hlY2tpbmcgdGhlIFVSTCB0dXJucyB0aGF0IGludG8gYSBzZW50ZW5jZSB3b3J0aCByZWFkaW5nLlxuICAgIGNvbnN0IGxvYWRlZCA9IGF3YWl0IGNocm9tZS50YWJzLmdldCh0YWIuaWQpO1xuICAgIGlmIChsb2FkZWQudXJsICYmICFsb2FkZWQudXJsLnN0YXJ0c1dpdGgoQ09NRUVOX1VSTCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFNpZ25lZE91dEVycm9yKFxuICAgICAgICAgICAgJ05vdCBzaWduZWQgaW4gdG8gQ29tZWVuICh0aGUgcGFnZSByZWRpcmVjdGVkIHRvIHNpZ24taW4pLiAnXG4gICAgICAgICAgICArICdPcGVuIGh0dHBzOi8vbXkuY29tZWVuLmlvLywgc2lnbiBpbiwgdGhlbiBydW4gYWdhaW4uJyxcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICByZXR1cm4geyB0YWJJZDogdGFiLmlkLCB0ZW1wb3Jhcnk6IHRydWUgfTtcbn1cblxuZnVuY3Rpb24gd2FpdEZvckxvYWQodGFiSWQ6IG51bWJlciwgdGltZW91dE1zID0gMzBfMDAwKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIGNocm9tZS50YWJzLm9uVXBkYXRlZC5yZW1vdmVMaXN0ZW5lcihsaXN0ZW5lcik7XG4gICAgICAgICAgICByZWplY3QobmV3IEVycm9yKCdDb21lZW4gdGFiIGRpZCBub3QgZmluaXNoIGxvYWRpbmcgaW4gdGltZS4nKSk7XG4gICAgICAgIH0sIHRpbWVvdXRNcyk7XG5cbiAgICAgICAgY29uc3QgbGlzdGVuZXIgPSAoaWQ6IG51bWJlciwgaW5mbzogY2hyb21lLnRhYnMuVGFiQ2hhbmdlSW5mbyk6IHZvaWQgPT4ge1xuICAgICAgICAgICAgaWYgKGlkICE9PSB0YWJJZCB8fCBpbmZvLnN0YXR1cyAhPT0gJ2NvbXBsZXRlJykgcmV0dXJuO1xuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgICAgIGNocm9tZS50YWJzLm9uVXBkYXRlZC5yZW1vdmVMaXN0ZW5lcihsaXN0ZW5lcik7XG4gICAgICAgICAgICAvLyBUaGUgU1BBIG5lZWRzIGEgbW9tZW50IGFmdGVyIGBjb21wbGV0ZWAgYmVmb3JlIGl0cyBhdXRoIHN0YXRlIGlzIHJlYWR5LlxuICAgICAgICAgICAgc2V0VGltZW91dChyZXNvbHZlLCAyXzUwMCk7XG4gICAgICAgIH07XG4gICAgICAgIGNocm9tZS50YWJzLm9uVXBkYXRlZC5hZGRMaXN0ZW5lcihsaXN0ZW5lcik7XG4gICAgfSk7XG59XG5cbmxldCBpbkZsaWdodDogUHJvbWlzZTxSdW5Mb2c+IHwgdW5kZWZpbmVkO1xuXG4vKipcbiAqIE9uZSBydW4gYXQgYSB0aW1lLiBUd28gb3ZlcmxhcHBpbmcgcnVucyB3b3VsZCBlYWNoIHJlYWQgdGhlIGJvb2tpbmdzIGxpc3RcbiAqIGJlZm9yZSB0aGUgb3RoZXIgaGFkIHdyaXR0ZW4gYW55dGhpbmcsIHNvIGJvdGggd291bGQgZGVjaWRlIHRoZSBzYW1lIGRheSB3YXNcbiAqIGZyZWUgYW5kIGJvdGggd291bGQgdHJ5IHRvIGJvb2sgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydW5Cb29raW5nKGRyeVJ1bjogYm9vbGVhbik6IFByb21pc2U8UnVuTG9nPiB7XG4gICAgaWYgKGluRmxpZ2h0KSByZXR1cm4gaW5GbGlnaHQ7XG4gICAgaW5GbGlnaHQgPSBydW5Cb29raW5nT25jZShkcnlSdW4pLmZpbmFsbHkoKCkgPT4geyBpbkZsaWdodCA9IHVuZGVmaW5lZDsgfSk7XG4gICAgcmV0dXJuIGluRmxpZ2h0O1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5Cb29raW5nT25jZShkcnlSdW46IGJvb2xlYW4pOiBQcm9taXNlPFJ1bkxvZz4ge1xuICAgIGNvbnN0IHNldHRpbmdzOiBTZXR0aW5ncyA9IGF3YWl0IGxvYWRTZXR0aW5ncygpO1xuXG4gICAgY29uc3QgZGF0ZXMgPSBkYXRlc1RvQm9vayh7XG4gICAgICAgIHdlZWtkYXlzOiBzZXR0aW5ncy53ZWVrZGF5cyxcbiAgICAgICAgaG9yaXpvbkRheXM6IHNldHRpbmdzLmhvcml6b25EYXlzLFxuICAgICAgICBza2lwRGF0ZXM6IHNldHRpbmdzLnNraXBEYXRlcyxcbiAgICAgICAgdGltZVpvbmU6IHNldHRpbmdzLnRpbWVab25lLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYmFzZTogUnVuTG9nID0geyBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBkcnlSdW4sIGRhdGVzLCByb3dzOiBbXSwgbm90ZXM6IFtdIH07XG5cbiAgICBpZiAoZGF0ZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0geyAuLi5iYXNlLCBub3RlczogWydObyBjYW5kaWRhdGUgZGF0ZXMgaW4gdGhlIGhvcml6b24uJ10gfTtcbiAgICAgICAgYXdhaXQgYXBwZW5kTG9nKGVudHJ5KTtcbiAgICAgICAgcmV0dXJuIGVudHJ5O1xuICAgIH1cblxuICAgIGlmICghc2V0dGluZ3MuZGVza05hbWUgJiYgIXNldHRpbmdzLmRlc2tJZCkge1xuICAgICAgICBjb25zdCBlbnRyeSA9IHsgLi4uYmFzZSwgZXJyb3I6ICdQaWNrIHlvdXIgZGVzayBpbiB0aGUgcG9wdXAgZmlyc3QgKHRoZSBudW1iZXIgb24gaXQsIGxpa2UgMy0yMykuJyB9O1xuICAgICAgICBhd2FpdCBhcHBlbmRMb2coZW50cnkpO1xuICAgICAgICBhd2FpdCByZWZsZWN0UnVuKGVudHJ5KTtcbiAgICAgICAgcmV0dXJuIGVudHJ5O1xuICAgIH1cblxuICAgIC8vIFRoZSBwb3B1cCBnYXRlcyBpdHMgb3duIGJ1dHRvbnMgb24gdGhpcywgYnV0IGFuIGF1dG9tYXRpYyBydW4gcmVhZHNcbiAgICAvLyBzdHJhaWdodCBmcm9tIHN0b3JhZ2UgXHUyMDE0IHdoaWNoIGNvdWxkIGhvbGQgYSBiYWQgdmFsdWUgc2F2ZWQgYnkgYW4gb2xkZXJcbiAgICAvLyBidWlsZCwgb3IgZWRpdGVkIGJ5IGhhbmQuIENoZWNraW5nIGhlcmUgaXMgd2hhdCBtYWtlcyB0aGUgcnVsZSByZWFsLlxuICAgIGlmIChzZXR0aW5ncy5kZXNrTmFtZSAmJiAhaXNWYWxpZERlc2tOYW1lKHNldHRpbmdzLmRlc2tOYW1lKSkge1xuICAgICAgICBjb25zdCBlbnRyeSA9IHtcbiAgICAgICAgICAgIC4uLmJhc2UsXG4gICAgICAgICAgICBlcnJvcjogYFwiJHtzZXR0aW5ncy5kZXNrTmFtZX1cIiBpcyBub3QgYSBkZXNrIG51bWJlci4gSXQgc2hvdWxkIGJlIGRpZ2l0cywgYSBkYXNoLCBgXG4gICAgICAgICAgICAgICAgKyAnZGlnaXRzIFx1MjAxNCBsaWtlIDMtMjMuJyxcbiAgICAgICAgfTtcbiAgICAgICAgYXdhaXQgYXBwZW5kTG9nKGVudHJ5KTtcbiAgICAgICAgYXdhaXQgcmVmbGVjdFJ1bihlbnRyeSk7XG4gICAgICAgIHJldHVybiBlbnRyeTtcbiAgICB9XG5cbiAgICBsZXQgdGVtcG9yYXJ5ID0gZmFsc2U7XG4gICAgbGV0IHRhYklkOiBudW1iZXIgfCB1bmRlZmluZWQ7XG5cbiAgICB0cnkge1xuICAgICAgICBjb25zdCB0YWIgPSBhd2FpdCBnZXRDb21lZW5UYWIoKTtcbiAgICAgICAgdGFiSWQgPSB0YWIudGFiSWQ7XG4gICAgICAgIHRlbXBvcmFyeSA9IHRhYi50ZW1wb3Jhcnk7XG5cbiAgICAgICAgY29uc3QgW3Jlc3VsdF0gPSBhd2FpdCBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHQoe1xuICAgICAgICAgICAgdGFyZ2V0OiB7IHRhYklkIH0sXG4gICAgICAgICAgICB3b3JsZDogJ01BSU4nLFxuICAgICAgICAgICAgZnVuYzogYm9va0luUGFnZSxcbiAgICAgICAgICAgIGFyZ3M6IFt7XG4gICAgICAgICAgICAgICAgZW5kcG9pbnQ6IHNldHRpbmdzLmVuZHBvaW50LFxuICAgICAgICAgICAgICAgIGRhdGVzLFxuICAgICAgICAgICAgICAgIGRlc2tOYW1lOiBzZXR0aW5ncy5kZXNrTmFtZSxcbiAgICAgICAgICAgICAgICBkZXNrSWQ6IHNldHRpbmdzLmRlc2tJZCxcbiAgICAgICAgICAgICAgICBzbG90OiBzZXR0aW5ncy5zbG90LFxuICAgICAgICAgICAgICAgIC8vIFJlc29sdmVkIG91dCBoZXJlIHNvIHRoZSBzbG90LXRvLXRpbWVzIHRhYmxlIHN0YXlzIHRlc3RhYmxlXG4gICAgICAgICAgICAgICAgLy8gaW5zdGVhZCBvZiBiZWluZyBpbmxpbmVkIGludG8gdGhlIHNlcmlhbGl6ZWQgcGFnZSBmdW5jdGlvbi5cbiAgICAgICAgICAgICAgICBzdGFydFRpbWU6IFNMT1RfVElNRVNbc2V0dGluZ3Muc2xvdF0uc3RhcnQsXG4gICAgICAgICAgICAgICAgZW5kVGltZTogU0xPVF9USU1FU1tzZXR0aW5ncy5zbG90XS5lbmQsXG4gICAgICAgICAgICAgICAgZmxvb3JJZDogc2V0dGluZ3MuZmxvb3JJZCxcbiAgICAgICAgICAgICAgICBidWlsZGluZ0lkOiBzZXR0aW5ncy5idWlsZGluZ0lkLFxuICAgICAgICAgICAgICAgIGRyeVJ1bixcbiAgICAgICAgICAgIH1dLFxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCB2YWx1ZSA9IHJlc3VsdD8ucmVzdWx0IGFzIEluUGFnZVJlc3VsdCB8IHVuZGVmaW5lZDtcblxuICAgICAgICAvLyBDYWNoZSB0aGUgbG9va2VkLXVwIGlkIHNvIHRoZSBuZXh0IHJ1biBza2lwcyB0aGUgc2VhcmNoIGVudGlyZWx5LlxuICAgICAgICBpZiAodmFsdWU/LnJlc29sdmVkRGVza0lkICYmIHZhbHVlLnJlc29sdmVkRGVza0lkICE9PSBzZXR0aW5ncy5kZXNrSWQpIHtcbiAgICAgICAgICAgIGF3YWl0IHNhdmVTZXR0aW5ncyh7IC4uLnNldHRpbmdzLCBkZXNrSWQ6IHZhbHVlLnJlc29sdmVkRGVza0lkIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZW50cnk6IFJ1bkxvZyA9IHtcbiAgICAgICAgICAgIC4uLmJhc2UsXG4gICAgICAgICAgICByb3dzOiB2YWx1ZT8ucm93cyA/PyBbXSxcbiAgICAgICAgICAgIG5vdGVzOiB2YWx1ZT8ubm90ZXMgPz8gWydUaGUgaW4tcGFnZSBzY3JpcHQgcmV0dXJuZWQgbm90aGluZy4nXSxcbiAgICAgICAgICAgIHNpZ25lZE91dDogdmFsdWU/LnNpZ25lZE91dCA9PT0gdHJ1ZSxcbiAgICAgICAgfTtcbiAgICAgICAgYXdhaXQgYXBwZW5kTG9nKGVudHJ5KTtcbiAgICAgICAgYXdhaXQgcmVmbGVjdFJ1bihlbnRyeSk7XG4gICAgICAgIHJldHVybiBlbnRyeTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc3QgZW50cnk6IFJ1bkxvZyA9IHtcbiAgICAgICAgICAgIC4uLmJhc2UsXG4gICAgICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICAgICAgc2lnbmVkT3V0OiBlcnIgaW5zdGFuY2VvZiBTaWduZWRPdXRFcnJvcixcbiAgICAgICAgfTtcbiAgICAgICAgYXdhaXQgYXBwZW5kTG9nKGVudHJ5KTtcbiAgICAgICAgYXdhaXQgcmVmbGVjdFJ1bihlbnRyeSk7XG4gICAgICAgIHJldHVybiBlbnRyeTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICAvLyBPbmx5IGNsb3NlIHdoYXQgd2Ugb3BlbmVkLiBOZXZlciBjbG9zZSBhIHRhYiB0aGUgdXNlciB3YXMgdXNpbmcuXG4gICAgICAgIGlmICh0ZW1wb3JhcnkgJiYgdGFiSWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgY2hyb21lLnRhYnMucmVtb3ZlKHRhYklkKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XG4gICAgICAgIH1cbiAgICB9XG59XG5cbi8qKlxuICogU2hvdyB0aGUgb3V0Y29tZSBvZiBhIHJ1biBzb21ld2hlcmUgdGhlIHVzZXIgd2lsbCBhY3R1YWxseSBzZWUgaXQuXG4gKlxuICogRXZlcnl0aGluZyBiZWZvcmUgdGhpcyB3YXMgd3JpdHRlbiBpbnRvIGNocm9tZS5zdG9yYWdlIGFuZCByZW5kZXJlZCBvbmx5IGlmXG4gKiB5b3Ugb3BlbmVkIHRoZSBwb3B1cCBcdTIwMTQgc28gYW4gYXV0b21hdGljIHJ1biB0aGF0IGZhaWxlZCBhdCAzYW0gd2FzLCBpblxuICogcHJhY3RpY2UsIHNpbGVudC4gQW4gYXV0b21hdGlvbiB5b3UgY2Fubm90IHRlbGwgaGFzIHN0b3BwZWQgaXMgd29yc2UgdGhhbiBub1xuICogYXV0b21hdGlvbiwgYmVjYXVzZSB5b3Ugc3RvcCBjaGVja2luZy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVmbGVjdFJ1bihlbnRyeTogUnVuTG9nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLy8gQSBwcmV2aWV3IGlzIGEgcXVlc3Rpb24sIG5vdCBhbiBvdXRjb21lLiBJdCBtdXN0IG5vdCBjbGVhciBhIHJlYWxcbiAgICAvLyBmYWlsdXJlJ3MgYmFkZ2UsIG5vciByYWlzZSBvbmUgb2YgaXRzIG93bi5cbiAgICBpZiAoZW50cnkuZHJ5UnVuKSByZXR1cm47XG5cbiAgICBjb25zdCBmYWlsZWQgPSBCb29sZWFuKGVudHJ5LmVycm9yKSB8fCBlbnRyeS5yb3dzLnNvbWUoKHJvdykgPT4gcm93LnN0YXR1cyA9PT0gJ2Vycm9yJyk7XG5cbiAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEJhZGdlVGV4dCh7IHRleHQ6IGZhaWxlZCA/ICchJyA6ICcnIH0pO1xuICAgIGlmIChmYWlsZWQpIHtcbiAgICAgICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRCYWRnZUJhY2tncm91bmRDb2xvcih7IGNvbG9yOiAnI2I5MWMxYycgfSk7XG4gICAgfVxuXG4gICAgaWYgKGVudHJ5LnNpZ25lZE91dCkge1xuICAgICAgICAvLyBGaXhlZCBpZCwgc28gYSBzZXNzaW9uIHRoYXQgc3RheXMgZXhwaXJlZCBhY3Jvc3Mgc2V2ZXJhbCBydW5zXG4gICAgICAgIC8vIHJlcGxhY2VzIGl0cyBvd24gbm90aWZpY2F0aW9uIGluc3RlYWQgb2Ygc3RhY2tpbmcgdXAuXG4gICAgICAgIGNocm9tZS5ub3RpZmljYXRpb25zLmNyZWF0ZShTSUdORURfT1VUX05PVElGSUNBVElPTiwge1xuICAgICAgICAgICAgdHlwZTogJ2Jhc2ljJyxcbiAgICAgICAgICAgIGljb25Vcmw6IGNocm9tZS5ydW50aW1lLmdldFVSTCgnaWNvbi0xMjgucG5nJyksXG4gICAgICAgICAgICB0aXRsZTogJ0NvbWVlbiBkZXNrIGJvb2tlcicsXG4gICAgICAgICAgICBtZXNzYWdlOiAnWW91ciBDb21lZW4gc2Vzc2lvbiBleHBpcmVkLiBDbGljayBoZXJlIHRvIHNpZ24gaW4gXHUyMDE0IGJvb2tpbmcgcmVzdW1lcyBvbiAnXG4gICAgICAgICAgICAgICAgKyAnaXRzIG93biBvbmNlIHlvdSBhcmUgYmFjay4nLFxuICAgICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihTSUdORURfT1VUX05PVElGSUNBVElPTik7XG4gICAgfVxufVxuXG4vKipcbiAqIFNpZ25pbmcgYmFjayBpbiBpcyB0aGUgZml4LCBzbyBub3RpY2luZyB0aGF0IHlvdSBoYXZlIGlzIHRoZSB3aG9sZSBmZWF0dXJlOlxuICogdGhlIG5leHQgdGltZSBhIENvbWVlbiBwYWdlIGZpbmlzaGVzIGxvYWRpbmcgYWZ0ZXIgYSBzaWduZWQtb3V0IGZhaWx1cmUsIHRoZVxuICogbWlzc2VkIHJ1biBoYXBwZW5zIGJ5IGl0c2VsZi4gTm8gYnV0dG9uIHRvIGZpbmQsIG5vIG5vdGlmaWNhdGlvbiB0byBhY3Qgb24uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJldHJ5QWZ0ZXJTaWduSW4oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgeyBydW5zID0gW10gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgncnVucycpIGFzIHsgcnVucz86IFJ1bkxvZ1tdIH07XG4gICAgaWYgKHJ1bnNbMF0/LnNpZ25lZE91dCAhPT0gdHJ1ZSkgcmV0dXJuO1xuXG4gICAgLy8gT25seSB0aGUgYXV0b21hdGljIHBhdGggc2VsZi1oZWFscy4gSWYgYXV0b21hdGljIGlzIG9mZiwgZXZlcnkgcnVuIGlzXG4gICAgLy8gc29tZXRoaW5nIHRoZSB1c2VyIGFza2VkIGZvciwgYW5kIGEgc3VycHJpc2UgYm9va2luZyB3b3VsZCBub3QgYmUuXG4gICAgY29uc3Qgc2V0dGluZ3MgPSBhd2FpdCBsb2FkU2V0dGluZ3MoKTtcbiAgICBpZiAoIXNldHRpbmdzLmVuYWJsZWQpIHJldHVybjtcblxuICAgIGNvbnNvbGUuaW5mbygnW2NvbWVlbl0gc2lnbmVkIGJhY2sgaW4gXHUyMDE0IHJldHJ5aW5nIHRoZSBydW4gdGhhdCBmYWlsZWQnKTtcbiAgICBhd2FpdCBydW5Cb29raW5nKGZhbHNlKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZW5zdXJlQWxhcm0oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCBjaHJvbWUuYWxhcm1zLmdldChBTEFSTSk7XG4gICAgaWYgKGV4aXN0aW5nKSByZXR1cm47XG4gICAgLy8gRXZlcnkgNiBob3Vycy4gVGhlIDE0LWRheSBib29raW5nIGhvcml6b24gbWVhbnMgcHJlY2lzaW9uIGRvZXMgbm90IG1hdHRlcjpcbiAgICAvLyBhbnkgcnVuIHRvcHMgdGhlIHdob2xlIHdpbmRvdyBiYWNrIHVwLCBzbyBhIG1pc3NlZCBmaXJpbmcgY29zdHMgbm90aGluZy5cbiAgICBhd2FpdCBjaHJvbWUuYWxhcm1zLmNyZWF0ZShBTEFSTSwgeyBwZXJpb2RJbk1pbnV0ZXM6IDM2MCwgZGVsYXlJbk1pbnV0ZXM6IDEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bklmRW5hYmxlZChyZWFzb246IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHNldHRpbmdzID0gYXdhaXQgbG9hZFNldHRpbmdzKCk7XG4gICAgaWYgKCFzZXR0aW5ncy5lbmFibGVkKSByZXR1cm47XG4gICAgY29uc29sZS5pbmZvKGBbY29tZWVuXSBydW5uaW5nICgke3JlYXNvbn0pYCk7XG4gICAgYXdhaXQgcnVuQm9va2luZyhmYWxzZSk7XG59XG5cbmNocm9tZS5ydW50aW1lLm9uSW5zdGFsbGVkLmFkZExpc3RlbmVyKCgpID0+IHtcbiAgICB2b2lkIGVuc3VyZUFsYXJtKCk7XG59KTtcblxuLy8gQ2hyb21lIHdhcyBqdXN0IHN0YXJ0ZWQ6IGNhdGNoIHVwIGltbWVkaWF0ZWx5IHJhdGhlciB0aGFuIHdhaXRpbmcgZm9yIHRoZSBhbGFybS5cbmNocm9tZS5ydW50aW1lLm9uU3RhcnR1cC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4gICAgdm9pZCBlbnN1cmVBbGFybSgpO1xuICAgIHZvaWQgcnVuSWZFbmFibGVkKCdicm93c2VyIHN0YXJ0dXAnKTtcbn0pO1xuXG5jaHJvbWUuYWxhcm1zLm9uQWxhcm0uYWRkTGlzdGVuZXIoKGFsYXJtKSA9PiB7XG4gICAgaWYgKGFsYXJtLm5hbWUgIT09IEFMQVJNKSByZXR1cm47XG4gICAgdm9pZCBydW5JZkVuYWJsZWQoJ2FsYXJtJyk7XG59KTtcblxuY2hyb21lLnRhYnMub25VcGRhdGVkLmFkZExpc3RlbmVyKChfdGFiSWQsIGluZm8sIHRhYikgPT4ge1xuICAgIGlmIChpbmZvLnN0YXR1cyAhPT0gJ2NvbXBsZXRlJykgcmV0dXJuO1xuICAgIGlmICghdGFiLnVybD8uc3RhcnRzV2l0aChDT01FRU5fVVJMKSkgcmV0dXJuO1xuICAgIHZvaWQgcmV0cnlBZnRlclNpZ25JbigpO1xufSk7XG5cbmNocm9tZS5ub3RpZmljYXRpb25zLm9uQ2xpY2tlZC5hZGRMaXN0ZW5lcigoaWQpID0+IHtcbiAgICBpZiAoaWQgIT09IFNJR05FRF9PVVRfTk9USUZJQ0FUSU9OKSByZXR1cm47XG4gICAgdm9pZCBjaHJvbWUudGFicy5jcmVhdGUoeyB1cmw6IENPTUVFTl9VUkwgfSk7XG4gICAgY2hyb21lLm5vdGlmaWNhdGlvbnMuY2xlYXIoU0lHTkVEX09VVF9OT1RJRklDQVRJT04pO1xufSk7XG5cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobWVzc2FnZTogeyB0eXBlPzogc3RyaW5nOyBkcnlSdW4/OiBib29sZWFuIH0sIF9zZW5kZXIsIHJlc3BvbmQpID0+IHtcbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ3J1bicpIHtcbiAgICAgICAgcnVuQm9va2luZyhtZXNzYWdlLmRyeVJ1biA/PyBmYWxzZSlcbiAgICAgICAgICAgIC50aGVuKChsb2cpID0+IHJlc3BvbmQoeyBvazogdHJ1ZSwgbG9nIH0pKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IHJlc3BvbmQoe1xuICAgICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICAgICAgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTsgLy8ga2VlcCB0aGUgY2hhbm5lbCBvcGVuIGZvciB0aGUgYXN5bmMgcmVzcG9uc2VcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBSUEsSUFBTSxnQkFBb0M7QUFBQSxFQUN0QztBQUFBLEVBQVU7QUFBQSxFQUFVO0FBQUEsRUFBVztBQUFBLEVBQWE7QUFBQSxFQUFZO0FBQUEsRUFBVTtBQUN0RTtBQUVBLFNBQVMsVUFBVSxPQUFpQztBQUNoRCxTQUFRLGNBQW9DLFNBQVMsS0FBSztBQUM5RDtBQUdPLFNBQVMsZUFBZSxNQUFZLFVBQTBCO0FBQ2pFLFNBQU8sSUFBSSxLQUFLLGVBQWUsU0FBUztBQUFBLElBQ3BDO0FBQUEsSUFBVSxNQUFNO0FBQUEsSUFBVyxPQUFPO0FBQUEsSUFBVyxLQUFLO0FBQUEsRUFDdEQsQ0FBQyxFQUFFLE9BQU8sSUFBSTtBQUNsQjtBQUdPLFNBQVMsYUFBYSxNQUFZLFVBQTJCO0FBQ2hFLFFBQU0sT0FBTyxJQUFJLEtBQUssZUFBZSxTQUFTLEVBQUUsVUFBVSxTQUFTLE9BQU8sQ0FBQyxFQUN0RSxPQUFPLElBQUksRUFDWCxZQUFZO0FBQ2pCLE1BQUksQ0FBQyxVQUFVLElBQUksRUFBRyxPQUFNLElBQUksTUFBTSxrQ0FBa0MsSUFBSSxHQUFHO0FBQy9FLFNBQU87QUFDWDtBQWtCTyxTQUFTLFlBQVk7QUFBQSxFQUN4QjtBQUFBLEVBQ0EsY0FBYztBQUFBLEVBQ2QsWUFBWSxDQUFDO0FBQUEsRUFDYixXQUFXO0FBQUEsRUFDWCxNQUFNLG9CQUFJLEtBQUs7QUFDbkIsR0FBaUM7QUFDN0IsUUFBTSxTQUFTLG9CQUFJLElBQWE7QUFDaEMsYUFBVyxPQUFPLFVBQVU7QUFDeEIsVUFBTSxPQUFPLElBQUksWUFBWTtBQUM3QixRQUFJLENBQUMsVUFBVSxJQUFJLEVBQUcsT0FBTSxJQUFJLE1BQU0sd0JBQXdCLEdBQUcsR0FBRztBQUNwRSxXQUFPLElBQUksSUFB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QUFLLDZEQUF3RDtBQUNyRSxRQUFNLFdBQVcsS0FBSztBQUMxQjtBQUVBLGVBQWUsY0FBNkI7QUFDeEMsUUFBTSxXQUFXLE1BQU0sT0FBTyxPQUFPLElBQUksS0FBSztBQUM5QyxNQUFJLFNBQVU7QUFHZCxRQUFNLE9BQU8sT0FBTyxPQUFPLE9BQU8sRUFBRSxpQkFBaUIsS0FBSyxnQkFBZ0IsRUFBRSxDQUFDO0FBQ2pGO0FBRUEsZUFBZSxhQUFhLFFBQStCO0FBQ3ZELFFBQU0sV0FBVyxNQUFNLGFBQWE7QUFDcEMsTUFBSSxDQUFDLFNBQVMsUUFBUztBQUN2QixVQUFRLEtBQUsscUJBQXFCLE1BQU0sR0FBRztBQUMzQyxRQUFNLFdBQVcsS0FBSztBQUMxQjtBQUVBLE9BQU8sUUFBUSxZQUFZLFlBQVksTUFBTTtBQUN6QyxPQUFLLFlBQVk7QUFDckIsQ0FBQztBQUdELE9BQU8sUUFBUSxVQUFVLFlBQVksTUFBTTtBQUN2QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxhQUFhLGlCQUFpQjtBQUN2QyxDQUFDO0FBRUQsT0FBTyxPQUFPLFFBQVEsWUFBWSxDQUFDLFVBQVU7QUFDekMsTUFBSSxNQUFNLFNBQVMsTUFBTztBQUMxQixPQUFLLGFBQWEsT0FBTztBQUM3QixDQUFDO0FBRUQsT0FBTyxLQUFLLFVBQVUsWUFBWSxDQUFDLFFBQVEsTUFBTSxRQUFRO0FBQ3JELE1BQUksS0FBSyxXQUFXLFdBQVk7QUFDaEMsTUFBSSxDQUFDLElBQUksS0FBSyxXQUFXLFVBQVUsRUFBRztBQUN0QyxPQUFLLGlCQUFpQjtBQUMxQixDQUFDO0FBRUQsT0FBTyxjQUFjLFVBQVUsWUFBWSxDQUFDLE9BQU87QUFDL0MsTUFBSSxPQUFPLHdCQUF5QjtBQUNwQyxPQUFLLE9BQU8sS0FBSyxPQUFPLEVBQUUsS0FBSyxXQUFXLENBQUM7QUFDM0MsU0FBTyxjQUFjLE1BQU0sdUJBQXVCO0FBQ3RELENBQUM7QUFFRCxPQUFPLFFBQVEsVUFBVSxZQUFZLENBQUMsU0FBOEMsU0FBUyxZQUFZO0FBQ3JHLE1BQUksU0FBUyxTQUFTLE9BQU87QUFDekIsZUFBVyxRQUFRLFVBQVUsS0FBSyxFQUM3QixLQUFLLENBQUMsUUFBUSxRQUFRLEVBQUUsSUFBSSxNQUFNLElBQUksQ0FBQyxDQUFDLEVBQ3hDLE1BQU0sQ0FBQyxRQUFpQixRQUFRO0FBQUEsTUFDN0IsSUFBSTtBQUFBLE1BQ0osT0FBTyxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRztBQUFBLElBQzFELENBQUMsQ0FBQztBQUNOLFdBQU87QUFBQSxFQUNYO0FBQ0EsU0FBTztBQUNYLENBQUM7IiwKICAibmFtZXMiOiBbInNpZ25lZE91dCJdCn0K
