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
    await reflectRun(entry);
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
  const failed = Boolean(entry.error) || entry.rows.some((row) => row.status === "error");
  if (entry.dryRun && !failed) return;
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
  } else if (!entry.dryRun) {
    chrome.notifications.clear(SIGNED_OUT_NOTIFICATION);
  }
}
async function clearFailureBadge() {
  await chrome.action.setBadgeText({ text: "" });
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
  if (message?.type === "popup-opened") {
    void clearFailureBadge();
    respond({ ok: true });
    return false;
  }
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvcmUvZGF0ZXMudHMiLCAiLi4vc3JjL2NvcmUvY29uZmlnLnRzIiwgIi4uL3NyYy9pbmplY3RlZC50cyIsICIuLi9zcmMvYmFja2dyb3VuZC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiZXhwb3J0IHR5cGUgV2Vla2RheSA9XG4gICAgfCAnbW9uZGF5JyB8ICd0dWVzZGF5JyB8ICd3ZWRuZXNkYXknXG4gICAgfCAndGh1cnNkYXknIHwgJ2ZyaWRheScgfCAnc2F0dXJkYXknIHwgJ3N1bmRheSc7XG5cbmNvbnN0IFdFRUtEQVlfTkFNRVM6IHJlYWRvbmx5IFdlZWtkYXlbXSA9IFtcbiAgICAnc3VuZGF5JywgJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknLCAnc2F0dXJkYXknLFxuXTtcblxuZnVuY3Rpb24gaXNXZWVrZGF5KHZhbHVlOiBzdHJpbmcpOiB2YWx1ZSBpcyBXZWVrZGF5IHtcbiAgICByZXR1cm4gKFdFRUtEQVlfTkFNRVMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKHZhbHVlKTtcbn1cblxuLyoqIEZvcm1hdCBhIERhdGUgYXMgWVlZWS1NTS1ERCBhcyBzZWVuIGluIGB0aW1lWm9uZWAuICovXG5leHBvcnQgZnVuY3Rpb24gdG9Mb2NhbElTT0RhdGUoZGF0ZTogRGF0ZSwgdGltZVpvbmU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1DQScsIHtcbiAgICAgICAgdGltZVpvbmUsIHllYXI6ICdudW1lcmljJywgbW9udGg6ICcyLWRpZ2l0JywgZGF5OiAnMi1kaWdpdCcsXG4gICAgfSkuZm9ybWF0KGRhdGUpO1xufVxuXG4vKiogV2Vla2RheSBuYW1lIG9mIGBkYXRlYCBhcyBzZWVuIGluIGB0aW1lWm9uZWAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYWxXZWVrZGF5KGRhdGU6IERhdGUsIHRpbWVab25lOiBzdHJpbmcpOiBXZWVrZGF5IHtcbiAgICBjb25zdCBuYW1lID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgeyB0aW1lWm9uZSwgd2Vla2RheTogJ2xvbmcnIH0pXG4gICAgICAgIC5mb3JtYXQoZGF0ZSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKCFpc1dlZWtkYXkobmFtZSkpIHRocm93IG5ldyBFcnJvcihgVW5leHBlY3RlZCB3ZWVrZGF5IGZyb20gSW50bDogXCIke25hbWV9XCJgKTtcbiAgICByZXR1cm4gbmFtZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEYXRlc1RvQm9va09wdGlvbnMge1xuICAgIHdlZWtkYXlzOiBzdHJpbmdbXTtcbiAgICBob3Jpem9uRGF5cz86IG51bWJlcjtcbiAgICBza2lwRGF0ZXM/OiBzdHJpbmdbXTtcbiAgICB0aW1lWm9uZT86IHN0cmluZztcbiAgICBub3c/OiBEYXRlO1xufVxuXG4vKipcbiAqIEV2ZXJ5IGRheSBmcm9tIHRvZGF5IChpbmNsdXNpdmUpIHVwIHRvIGBob3Jpem9uRGF5c2AgYWhlYWQgd2hvc2Ugd2Vla2RheSBpc1xuICogaW4gYHdlZWtkYXlzYCwgbWludXMgYHNraXBEYXRlc2AuXG4gKlxuICogVGhlIDE0LWRheSBkZWZhdWx0IGlzIHdoYXQgbWFrZXMgdW5yZWxpYWJsZSBzY2hlZHVsaW5nIGFjY2VwdGFibGU6IGVhY2ggcnVuXG4gKiB0b3BzIHRoZSB3aG9sZSB3aW5kb3cgYmFjayB1cCwgc28gbWlzc2luZyBhIGRheSAobGFwdG9wIHNodXQsIENocm9tZSBjbG9zZWQpXG4gKiBjb3N0cyBub3RoaW5nIGFzIGxvbmcgYXMgdGhlIGV4dGVuc2lvbiBydW5zIGFnYWluIGJlZm9yZSB0aGUgd2luZG93IGRyYWlucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRhdGVzVG9Cb29rKHtcbiAgICB3ZWVrZGF5cyxcbiAgICBob3Jpem9uRGF5cyA9IDE0LFxuICAgIHNraXBEYXRlcyA9IFtdLFxuICAgIHRpbWVab25lID0gJ0V1cm9wZS9QcmFndWUnLFxuICAgIG5vdyA9IG5ldyBEYXRlKCksXG59OiBEYXRlc1RvQm9va09wdGlvbnMpOiBzdHJpbmdbXSB7XG4gICAgY29uc3Qgd2FudGVkID0gbmV3IFNldDxXZWVrZGF5PigpO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIHdlZWtkYXlzKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSByYXcudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgaWYgKCFpc1dlZWtkYXkobmFtZSkpIHRocm93IG5ldyBFcnJvcihgTm90IGEgd2Vla2RheSBuYW1lOiBcIiR7cmF3fVwiYCk7XG4gICAgICAgIHdhbnRlZC5hZGQobmFtZSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoc2tpcERhdGVzKTtcbiAgICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG5cbiAgICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPD0gaG9yaXpvbkRheXM7IG9mZnNldCArPSAxKSB7XG4gICAgICAgIGNvbnN0IGRheSA9IG5ldyBEYXRlKG5vdy5nZXRUaW1lKCkgKyBvZmZzZXQgKiA4Nl80MDBfMDAwKTtcbiAgICAgICAgY29uc3QgaXNvID0gdG9Mb2NhbElTT0RhdGUoZGF5LCB0aW1lWm9uZSk7XG4gICAgICAgIGlmICghd2FudGVkLmhhcyhsb2NhbFdlZWtkYXkoZGF5LCB0aW1lWm9uZSkpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNraXAuaGFzKGlzbykpIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaChpc28pO1xuICAgIH1cblxuICAgIHJldHVybiBvdXQ7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBXZWVrZGF5IH0gZnJvbSAnLi9kYXRlcy5qcyc7XG5cbmV4cG9ydCB0eXBlIFNsb3QgPSAnYWxsX2RheScgfCAnbW9ybmluZycgfCAnYWZ0ZXJub29uJztcblxuLyoqXG4gKiBIb3cgdGhlIGluLXBhZ2UgY29kZSBzaG91bGQgYXV0aGVudGljYXRlLlxuICpcbiAqIGBjb29raWVgICAgICAgIC0ganVzdCBzZW5kIGNyZWRlbnRpYWxzIHdpdGggdGhlIHJlcXVlc3QuIENvcnJlY3QgaWYgQ29tZWVuXG4gKiAgICAgICAgICAgICAgICAgIGF1dGhlbnRpY2F0ZXMgd2l0aCBhIHNlc3Npb24gY29va2llLlxuICogYGxvY2FsU3RvcmFnZWAgLSByZWFkIGEgdG9rZW4gb3V0IG9mIHRoZSBwYWdlJ3Mgb3duIGxvY2FsU3RvcmFnZSBhbmQgcHV0IGl0XG4gKiAgICAgICAgICAgICAgICAgIGluIGEgaGVhZGVyLiBDb3JyZWN0IGlmIENvbWVlbiB1c2VzIGEgYmVhcmVyIHRva2VuLlxuICpcbiAqIEVpdGhlciB3YXkgdGhlIHZhbHVlIGlzIHJlYWQgaW5zaWRlIHRoZSBwYWdlIGFuZCB1c2VkIHRoZXJlLiBJdCBpcyBuZXZlclxuICogY29waWVkIGludG8gZXh0ZW5zaW9uIHN0b3JhZ2UsIG5ldmVyIHBlcnNpc3RlZCwgYW5kIG5ldmVyIGxlYXZlcyB0aGUgdGFiLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhDb25maWcge1xuICAgIG1vZGU6ICdjb29raWUnIHwgJ2xvY2FsU3RvcmFnZSc7XG4gICAgLyoqIGxvY2FsU3RvcmFnZSBrZXkgaG9sZGluZyB0aGUgdG9rZW4uICovXG4gICAgc3RvcmFnZUtleT86IHN0cmluZztcbiAgICAvKiogRG90dGVkIHBhdGggaW5zaWRlIHRoZSBwYXJzZWQgSlNPTiwgZS5nLiBgc3RzVG9rZW5NYW5hZ2VyLmFjY2Vzc1Rva2VuYCAqL1xuICAgIGpzb25QYXRoPzogc3RyaW5nO1xuICAgIC8qKiBIZWFkZXIgdG8gc2V0LCBkZWZhdWx0IGBhdXRob3JpemF0aW9uYCAqL1xuICAgIGhlYWRlcj86IHN0cmluZztcbiAgICAvKiogUHJlZml4IGJlZm9yZSB0aGUgdG9rZW4sIGRlZmF1bHQgYEJlYXJlciBgICovXG4gICAgcHJlZml4Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlcXVlc3RUZW1wbGF0ZSB7XG4gICAgbWV0aG9kOiAnR0VUJyB8ICdQT1NUJyB8ICdQVVQnO1xuICAgIC8qKiBQYXRoIGFwcGVuZGVkIHRvIGFwaUJhc2UuIE1heSBjb250YWluIHBsYWNlaG9sZGVycy4gKi9cbiAgICBwYXRoOiBzdHJpbmc7XG4gICAgcXVlcnk/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgIGJvZHk/OiB1bmtub3duO1xufVxuXG4vKipcbiAqIEhvdyB0aGUgXCJ3aGF0IGRvIEkgYWxyZWFkeSBob2xkXCIgcmVzcG9uc2UgaXMgbGFpZCBvdXQuXG4gKlxuICogYGFycmF5YCAgICAgICAgLSBhIGZsYXQgbGlzdCBvZiBib29raW5ncywgZWFjaCBjYXJyeWluZyBpdHMgb3duIGRhdGUgZmllbGQsXG4gKiAgICAgICAgICAgICAgICAgIHJlYWQgdmlhIGBsaXN0RGF0ZUZpZWxkc2AuXG4gKiBgZGF0ZUtleWVkTWFwYCAtIGFuIG9iamVjdCBrZXllZCBieSBgWVlZWS1NTS1ERGAgd2hvc2UgdmFsdWVzIGFyZSB0aGF0IGRheSdzXG4gKiAgICAgICAgICAgICAgICAgIGVudHJpZXMuIENvbWVlbiByZXR1cm5zIHRoaXMgb25lLiBUaGUgZGF0ZSBpcyB0aGUgKmtleSosIG5vdFxuICogICAgICAgICAgICAgICAgICBhIGZpZWxkLCBzbyBubyBhbW91bnQgb2Ygc25pZmZpbmcgZmllbGQgbmFtZXMgd291bGQgZmluZCBpdCBcdTIwMTRcbiAqICAgICAgICAgICAgICAgICAgd2hpY2ggaXMgZXhhY3RseSB3aHkgdGhlIHNoYXBlIGlzIGNvbmZpZ3VyYXRpb24gcmF0aGVyIHRoYW5cbiAqICAgICAgICAgICAgICAgICAgc29tZXRoaW5nIHRoZSBpbi1wYWdlIGNvZGUgZ3Vlc3Nlcy5cbiAqL1xuZXhwb3J0IHR5cGUgTGlzdFNoYXBlID0gJ2FycmF5JyB8ICdkYXRlS2V5ZWRNYXAnO1xuXG4vKipcbiAqIFRoZSB3aG9sZSBBUEkgY29udHJhY3QgbGl2ZXMgaGVyZSBhcyBkYXRhIHNvIGl0IGNhbiBiZSBjb3JyZWN0ZWQgZnJvbSB0aGVcbiAqIHBvcHVwIHdpdGhvdXQgcmVidWlsZGluZy4gUGxhY2Vob2xkZXJzIGF2YWlsYWJsZSB0byBwYXRocywgcXVlcmllcyBhbmRcbiAqIGJvZGllczoge3tkYXRlfX0sIHt7ZGVza0lkfX0sIHt7ZGVza05hbWV9fSwge3tzbG90fX0sIHt7c3RhcnRUaW1lfX0sXG4gKiB7e2VuZFRpbWV9fSwge3tmcm9tfX0sIHt7dG99fSwge3t1c2VySWR9fSwge3tmbG9vcklkfX0sIHt7YnVpbGRpbmdJZH19LFxuICoge3thcmVhSWR9fS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBFbmRwb2ludENvbmZpZyB7XG4gICAgYXBpQmFzZTogc3RyaW5nO1xuICAgIGF1dGg6IEF1dGhDb25maWc7XG4gICAgLyoqXG4gICAgICogTG9vayBhIGRlc2sgdXAgYnkgaXRzIGh1bWFuIG5hbWUgc28gbm9ib2R5IGhhcyB0byBrbm93IGl0cyBpbnRlcm5hbCBpZC5cbiAgICAgKiBTZXQgdG8gbnVsbCBvbmx5IGlmIHlvdXIgQ29tZWVuIGhhcyBubyBkZXNrLXNlYXJjaCBlbmRwb2ludC5cbiAgICAgKi9cbiAgICByZXNvbHZlOiBSZXF1ZXN0VGVtcGxhdGUgfCBudWxsO1xuICAgIC8qKiBGaWVsZCBuYW1lcyB0aGF0IG1pZ2h0IGhvbGQgYSBkZXNrJ3MgaHVtYW4gbGFiZWwgaW4gYSBzZWFyY2ggcmVzdWx0LiAqL1xuICAgIGRlc2tOYW1lRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKiogRmllbGQgbmFtZXMgdGhhdCBtaWdodCBob2xkIGEgZGVzaydzIGludGVybmFsIGlkLiBDb21lZW4gdXNlcyBgdXVpZGAuICovXG4gICAgZGVza0lkRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKipcbiAgICAgKiBGaWVsZCBvbiBhIGRlc2sgcmVjb3JkIGhvbGRpbmcgdGhhdCBkZXNrJ3Mgb3duIGJvb2tpbmdzIGZvciB0aGUgcXVlcmllZFxuICAgICAqIHdpbmRvdy4gVXNlZCB0byB0ZWxsIHlvdSBhIGRheSBpcyBhbHJlYWR5IHRha2VuICpiZWZvcmUqIHlvdSBwcmVzcyBCb29rXG4gICAgICogbm93LiBTZXQgdG8gJycgdG8gZGlzYWJsZS5cbiAgICAgKi9cbiAgICBkZXNrU2NoZWR1bGVGaWVsZDogc3RyaW5nO1xuICAgIC8qKlxuICAgICAqIERhdGUgZmllbGRzIHRvIHJlYWQgb2ZmIG9uZSBvZiB0aG9zZSBlbnRyaWVzLCBpbiBwcmlvcml0eSBvcmRlciwgZmlyc3RcbiAgICAgKiBtYXRjaCB3aW5zLlxuICAgICAqXG4gICAgICogVGhlIG9yZGVyIG1hdHRlcnMgbW9yZSB0aGFuIGl0IGxvb2tzOiBhbiBlbnRyeSBhbG1vc3QgY2VydGFpbmx5IGFsc29cbiAgICAgKiBjYXJyaWVzIGNyZWF0ZWRfYXQgYW5kIHVwZGF0ZWRfYXQsIHdoaWNoIGFyZSB3aGVuIHRoZSBib29raW5nIHdhcyBtYWRlLFxuICAgICAqIG5vdCB0aGUgZGF5IGJvb2tlZC4gTGlzdGluZyBvbmx5IHRoZSBmaWVsZHMgdGhhdCBtZWFuIFwidGhlIGRheSB0aGlzIGlzXG4gICAgICogZm9yXCIgaXMgd2hhdCBzdG9wcyBhIGJvb2tpbmcgbWFkZSB0aHJlZSB3ZWVrcyBhZ28gZnJvbSBtYXJraW5nIHRocmVlXG4gICAgICogd2Vla3MgYWdvIGFzIHRha2VuLlxuICAgICAqL1xuICAgIGRlc2tTY2hlZHVsZURhdGVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKiBTZXQgdG8gbnVsbCB0byBza2lwIHRoZSBcIndoYXQgZG8gSSBhbHJlYWR5IGhhdmVcIiBjaGVjay4gKi9cbiAgICBsaXN0OiBSZXF1ZXN0VGVtcGxhdGUgfCBudWxsO1xuICAgIC8qKiBEb3R0ZWQgcGF0aCB0byB0aGUgY29udGFpbmVyIGluc2lkZSB0aGUgbGlzdCByZXNwb25zZS4gJycgbWVhbnMgcm9vdC4gKi9cbiAgICBsaXN0Um9vdDogc3RyaW5nO1xuICAgIGxpc3RTaGFwZTogTGlzdFNoYXBlO1xuICAgIC8qKiBPbmx5IGNvbnN1bHRlZCB3aGVuIGxpc3RTaGFwZSBpcyAnYXJyYXknLiAqL1xuICAgIGxpc3REYXRlRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKipcbiAgICAgKiBEb3R0ZWQgcGF0aCB0byB0aGUgc2lnbmVkLWluIHVzZXIncyBpZCBpbnNpZGUgdGhlIGxpc3QgcmVzcG9uc2UuIEVtcHR5XG4gICAgICogZGlzYWJsZXMgdGhlIGxvb2t1cCwgYW5kIHt7dXNlcklkfX0gdGhlbiBzdGF5cyB1bmZpbGxlZC5cbiAgICAgKi9cbiAgICB1c2VySWRQYXRoOiBzdHJpbmc7XG4gICAgY3JlYXRlOiBSZXF1ZXN0VGVtcGxhdGU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ3Mge1xuICAgIC8qKlxuICAgICAqIEJ1bXBlZCBpbiBERUZBVUxUX1NFVFRJTkdTIHdoZW5ldmVyIHRoZSBzaGlwcGVkIGVuZHBvaW50IGNvbmZpZyBpc1xuICAgICAqIGNvcnJlY3RlZC4gU2VlIG1lcmdlU2V0dGluZ3M6IGEgc3RvcmVkIGNvbmZpZyBvbGRlciB0aGFuIHRoZSBzaGlwcGVkIG9uZVxuICAgICAqIGlzIHJlcGxhY2VkIHJhdGhlciB0aGFuIG1lcmdlZCwgd2hpY2ggaXMgd2hhdCBsZXRzIGEgZml4IGFjdHVhbGx5IHJlYWNoXG4gICAgICogcGVvcGxlIHdobyBoYXZlIGFscmVhZHkgc2F2ZWQgc2V0dGluZ3Mgb25jZS5cbiAgICAgKi9cbiAgICBlbmRwb2ludFZlcnNpb246IG51bWJlcjtcbiAgICBlbmFibGVkOiBib29sZWFuO1xuICAgIGRlc2tOYW1lOiBzdHJpbmc7XG4gICAgZGVza0lkOiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogVGhlIGZsb29yIHRoZSBkZXNrIGlzIG9uLiBUaGlzIG9uZSBjYW5ub3QgYmUgZGVyaXZlZDogcmVzb2x2aW5nIGEgZGVzayBieVxuICAgICAqIG5hbWUgbWVhbnMgbGlzdGluZyBhIGZsb29yJ3MgZGVza3MsIHNvIHRoZSBmbG9vciBoYXMgdG8gYmUga25vd24gZmlyc3QuXG4gICAgICogVmlzaWJsZSBpbiB0aGUgVVJMIG9mIENvbWVlbidzIGZsb29yIHBsYW4sIGFuZCBpbiBgZmxvb3JfaWRgIG9uIGFueSBkZXNrLlxuICAgICAqL1xuICAgIGZsb29ySWQ6IG51bWJlcjtcbiAgICAvKipcbiAgICAgKiBUaGUgYnVpbGRpbmcgdGhlIGZsb29yIGlzIGluLiBBbHNvIG5vdCBkZXJpdmFibGUgXHUyMDE0IGEgZGVzayByZWNvcmQgY2Fycmllc1xuICAgICAqIGBmbG9vcl9pZGAgYW5kIGBhcmVhX2lkYCBidXQgbm8gYGJ1aWxkaW5nX2lkYCwgYW5kIHRoZSBvbmx5IGVuZHBvaW50IHRoYXRcbiAgICAgKiBtYXBzIG9uZSB0byB0aGUgb3RoZXIgbmVlZHMgYSBzcGFjZSBVVUlEIHdlIG5ldmVyIG90aGVyd2lzZSBmZXRjaC5cbiAgICAgKi9cbiAgICBidWlsZGluZ0lkOiBudW1iZXI7XG4gICAgd2Vla2RheXM6IFdlZWtkYXlbXTtcbiAgICBzbG90OiBTbG90O1xuICAgIGhvcml6b25EYXlzOiBudW1iZXI7XG4gICAgc2tpcERhdGVzOiBzdHJpbmdbXTtcbiAgICB0aW1lWm9uZTogc3RyaW5nO1xuICAgIGVuZHBvaW50OiBFbmRwb2ludENvbmZpZztcbn1cblxuLyoqXG4gKiBBIHNsb3QgYXMgdGhlIG5haXZlIGxvY2FsIHRpbWVzIENvbWVlbiBleHBlY3RzLlxuICpcbiAqIENvbWVlbiBzZW5kcyBkYXRldGltZXMgbGlrZSBgMjAyNi0wOS0wMVQwMDowMDowMC4wMDBaYCBhbmQgZWNob2VzIHRoZW0gYmFja1xuICogYXMgYDIwMjYtMDktMDFUMDA6MDA6MDBgIFx1MjAxNCBhIGxvY2FsIHdhbGwtY2xvY2sgdGltZSB3ZWFyaW5nIGEgYFpgLiBTbyB0aGUgZGF5XG4gKiBpcyB1c2VkIHZlcmJhdGltIGFuZCBubyB0aW1lem9uZSBjb252ZXJzaW9uIGhhcHBlbnMgYW55d2hlcmUgaW4gdGhlIGJvb2tpbmdcbiAqIHBhdGguIFRoZSBkYXRlIGxvZ2ljIGluIGRhdGVzLnRzIGFscmVhZHkgcHJvZHVjZXMgZXhhY3RseSB0aGlzLlxuICpcbiAqIFx1MjZBMFx1RkUwRiBPbmx5IGBhbGxfZGF5YCBpcyBjb25maXJtZWQgYWdhaW5zdCBhIHJlYWwgYm9va2luZy4gVGhlIGhhbGYtZGF5cyBhcmUgYVxuICogcmVhc29uYWJsZSByZWFkaW5nIG9mIHRoZSBzYW1lIHNjaGVtZSwgbm90IGFuIG9ic2VydmVkIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNMT1RfVElNRVM6IFJlY29yZDxTbG90LCB7IHN0YXJ0OiBzdHJpbmc7IGVuZDogc3RyaW5nIH0+ID0ge1xuICAgIGFsbF9kYXk6IHsgc3RhcnQ6ICcwMDowMDowMC4wMDBaJywgZW5kOiAnMjM6NTk6NTkuMDAwWicgfSxcbiAgICBtb3JuaW5nOiB7IHN0YXJ0OiAnMDA6MDA6MDAuMDAwWicsIGVuZDogJzEyOjAwOjAwLjAwMFonIH0sXG4gICAgYWZ0ZXJub29uOiB7IHN0YXJ0OiAnMTI6MDA6MDAuMDAwWicsIGVuZDogJzIzOjU5OjU5LjAwMFonIH0sXG59O1xuXG4vKipcbiAqIENvbmZpcm1lZCBhZ2FpbnN0IGEgcmVhbCBzaWduZWQtaW4gc2Vzc2lvbiBpbiBBdWd1c3QgMjAyNiwgYnkgY2FwdHVyaW5nIHRoZVxuICogdHJhZmZpYyBvZiBvbmUgZGVzayBib29raW5nIG1hZGUgYnkgaGFuZC5cbiAqXG4gKiBOb3RlcyB3b3J0aCBrZWVwaW5nLCBiZWNhdXNlIGVhY2ggb25lIGNvbnRyYWRpY3RzIGEgcmVhc29uYWJsZSBndWVzczpcbiAqICAgLSBgYXBpQmFzZWAgaXMgbXkuY29tZWVuLmlvL2FwaSwgdGhlIFNQQSdzIG93biBvcmlnaW4sIE5PVCBhcGkuY29tZWVuLmlvXG4gKiAgICAgd2hlcmUgdGhlIHB1YmxpYyBkb2NzIGxpdmUuIEl0IGlzIGEgUmFpbHMgYmFja2VuZCBiZWhpbmQgYSBOdXh0IGZyb250IGVuZCxcbiAqICAgICB3aGljaCBpcyB3aHkgcGF0aHMgZW5kIGluIGAuanNvbmAuXG4gKiAgIC0gVGhlIEFQSSB2ZXJzaW9uIHZhcmllcyBwZXIgZW5kcG9pbnQgKC92MSwgL3YyLCAvdjJiZXRhKSwgc28gdGhlIHZlcnNpb25cbiAqICAgICBiZWxvbmdzIGluIGVhY2ggcGF0aCByYXRoZXIgdGhhbiBpbiBhcGlCYXNlLlxuICogICAtIEEgZGVzaydzIGlkIGlzIGB1dWlkYC4gVGhlcmUgaXMgbm8gYGlkYCBmaWVsZCBvbiBhIGRlc2sgYXQgYWxsLlxuICogICAtIFRoZSBib29raW5ncyBsaXN0IGlzIGtleWVkIGJ5IGRhdGU7IHRoZSBkYXRlIGlzIG5vdCBhIGZpZWxkIG9uIGFuIGVudHJ5LlxuICogICAtIEEgYm9va2luZyBpcyBhIFwid29yayBhY3Rpdml0eVwiIHdpdGggYSBkZXNrIGF0dGFjaGVkLCBub3QgYSBkZXNrIGJvb2tpbmdcbiAqICAgICBhcyBzdWNoLiBUaGF0IGlzIHdoeSB0aGUgcGF0aCBzYXlzIHdvcmtfYWN0aXZpdHlfc2NoZWR1bGUuXG4gKiAgIC0gQXV0aCBpcyB0aGUgc2Vzc2lvbiBjb29raWUuIEEgZmV0Y2ggZnJvbSB0aGUgcGFnZSB3aXRoIGNyZWRlbnRpYWxzXG4gKiAgICAgaW5jbHVkZWQgYW5kIG5vIEF1dGhvcml6YXRpb24gaGVhZGVyIHJldHVybnMgMjAwLCBzbyB0aGVyZSBpcyBubyB0b2tlbiB0b1xuICogICAgIHJlYWQgYW5kIG5vdGhpbmcgZm9yIHRoZSBleHRlbnNpb24gdG8gaG9sZC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFNldHRpbmdzID0ge1xuICAgIC8vIFx1MkIwNiBCVU1QIFRISVMgd2hlbmV2ZXIgeW91IGNvcnJlY3QgdGhlIGBlbmRwb2ludGAgYmxvY2sgYmVsb3csIG90aGVyd2lzZVxuICAgIC8vIGFueW9uZSB3aG8gYWxyZWFkeSBwcmVzc2VkIFNhdmUga2VlcHMgdGhlaXIgc3RhbGUgY29weSBmb3JldmVyLlxuICAgIGVuZHBvaW50VmVyc2lvbjogMyxcbiAgICBlbmFibGVkOiBmYWxzZSxcbiAgICAvLyBFbXB0eSBvbiBwdXJwb3NlLiBTaGlwcGluZyBhIHJlYWwgZGVzayBudW1iZXIgYXMgdGhlIGRlZmF1bHQgbWVhbnMgdGhlXG4gICAgLy8gZmlyc3QgcGVyc29uIHRvIGluc3RhbGwgdGhpcyBhbmQgcHJlc3MgQm9vayBub3cgdGFrZXMgc29tZWJvZHkgZWxzZSdzXG4gICAgLy8gc2VhdCwgaGF2aW5nIGRvbmUgbm90aGluZyB3cm9uZy4gTm90aGluZyBydW5zIHVudGlsIGEgZGVzayBpcyBjaG9zZW4uXG4gICAgZGVza05hbWU6ICcnLFxuICAgIGRlc2tJZDogJycsXG4gICAgZmxvb3JJZDogNDk1MixcbiAgICBidWlsZGluZ0lkOiA1MTUxLFxuICAgIHdlZWtkYXlzOiBbJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknXSxcbiAgICBzbG90OiAnYWxsX2RheScsXG4gICAgaG9yaXpvbkRheXM6IDE0LFxuICAgIHNraXBEYXRlczogW10sXG4gICAgdGltZVpvbmU6ICdFdXJvcGUvUHJhZ3VlJyxcbiAgICBlbmRwb2ludDoge1xuICAgICAgICBhcGlCYXNlOiAnaHR0cHM6Ly9teS5jb21lZW4uaW8vYXBpJyxcbiAgICAgICAgYXV0aDogeyBtb2RlOiAnY29va2llJyB9LFxuICAgICAgICByZXNvbHZlOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICAgICAgcGF0aDogJy92MS9mbG9vcnMve3tmbG9vcklkfX0vZGVza3Nfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGU6ICd7e2Zyb219fVQwMDowMDowMC4wMDBaJyxcbiAgICAgICAgICAgICAgICBlbmRfZGF0ZTogJ3t7dG99fVQyMzo1OTo1OS4wMDBaJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGRlc2tOYW1lRmllbGRzOiBbJ25hbWUnLCAnc3luY19pZCddLFxuICAgICAgICBkZXNrSWRGaWVsZHM6IFsndXVpZCcsICdpZCddLFxuICAgICAgICBkZXNrU2NoZWR1bGVGaWVsZDogJ3NjaGVkdWxlJyxcbiAgICAgICAgZGVza1NjaGVkdWxlRGF0ZUZpZWxkczogWydzdGFydF9kYXRldGltZScsICdzdGFydF9kYXRlJywgJ2RhdGUnLCAnZGF5JywgJ3N0YXJ0J10sXG4gICAgICAgIGxpc3Q6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgICAgICBwYXRoOiAnL3YxL3VzZXJzL21lL3dvcmtfYWN0aXZpdHlfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGU6ICd7e2Zyb219fVQwMDowMDowMC4wMDBaJyxcbiAgICAgICAgICAgICAgICBlbmRfZGF0ZTogJ3t7dG99fVQyMzo1OTo1OS4wMDBaJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGxpc3RSb290OiAnc2NoZWR1bGUnLFxuICAgICAgICBsaXN0U2hhcGU6ICdkYXRlS2V5ZWRNYXAnLFxuICAgICAgICBsaXN0RGF0ZUZpZWxkczogWydzdGFydF9kYXRldGltZScsICdkYXRlJ10sXG4gICAgICAgIHVzZXJJZFBhdGg6ICd1c2VyLmlkJyxcbiAgICAgICAgY3JlYXRlOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICAgIC8vIFRoZSBgbWVgIGFsaWFzIHdvcmtzIGZvciByZWFkczsgdGhlIGFwcCBpdHNlbGYgdXNlcyB0aGUgbnVtZXJpY1xuICAgICAgICAgICAgLy8gaWQgdG8gd3JpdGUsIHNvIHRoYXQgaXMgd2hhdCBpcyB1c2VkIGhlcmUuXG4gICAgICAgICAgICBwYXRoOiAnL3YxL3VzZXJzL3t7dXNlcklkfX0vd29ya19hY3Rpdml0eV9zY2hlZHVsZS5qc29uJyxcbiAgICAgICAgICAgIGJvZHk6IHtcbiAgICAgICAgICAgICAgICB3b3JrX2FjdGl2aXR5OiB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXRlOiAnb25fc2l0ZScsXG4gICAgICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGV0aW1lOiAne3tkYXRlfX1Ue3tzdGFydFRpbWV9fScsXG4gICAgICAgICAgICAgICAgICAgIGVuZF9kYXRldGltZTogJ3t7ZGF0ZX19VHt7ZW5kVGltZX19JyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHByZXNlbmNlOiB7XG4gICAgICAgICAgICAgICAgICAgIGJ1aWxkaW5nX2lkOiAne3tidWlsZGluZ0lkfX0nLFxuICAgICAgICAgICAgICAgICAgICBmbG9vcl9pZDogJ3t7Zmxvb3JJZH19JyxcbiAgICAgICAgICAgICAgICAgICAgYXJlYV9pZDogJ3t7YXJlYUlkfX0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgZGVza19ib29raW5nOiB7IGRlc2tfdXVpZDogJ3t7ZGVza0lkfX0nIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgIH0sXG59O1xuXG4vKipcbiAqIFRoZSBvZmZpY2UsIGFzIGNhcHR1cmVkIGluIEF1Z3VzdCAyMDI2LlxuICpcbiAqIEhhcmRjb2RlZCByYXRoZXIgdGhhbiBmZXRjaGVkLiBUaGUgZmxvb3IgZHJvcGRvd24gaGFzIHRvIGJlIHBvcHVsYXRlZCBiZWZvcmVcbiAqIGFueSBuZXR3b3JrIGNhbGwgaGFwcGVucywgYW4gb2ZmaWNlIGxheW91dCBjaGFuZ2VzIGFib3V0IG5ldmVyLCBhbmQgYVxuICogaGFyZGNvZGVkIGZsb29yIHRoYXQgaXMgd3JvbmcgaXMgYSB2aXNpYmxlIG1pc3Rha2UgcmF0aGVyIHRoYW4gYSBzaWxlbnQgb25lLlxuICpcbiAqIFRvIGFkZCBhIGZsb29yLCByZWFkIHRoZSBpZHMgZnJvbSB0aGUgcmVzcG9uc2Ugb2ZcbiAqIC9hcGkvdjIvc3BhY2VzLzxzcGFjZS11dWlkPi9idWlsZGluZ3MvPGJ1aWxkaW5nLWlkPi9mbG9vcnMuanNvbiB3aXRoIHRoZVxuICogZmxvb3IgcGxhbiBvcGVuLlxuICovXG5leHBvcnQgY29uc3QgQlVJTERJTkcgPSB7IGlkOiA1MTUxLCBuYW1lOiAnMTAweWFyZHMnIH07XG5cbi8qKlxuICogQSBkZXNrIG5hbWUgaXMgZGlnaXRzLCBhIGRhc2gsIGRpZ2l0cyBcdTIwMTQgYDMtMjNgLCBgMTItNGAuXG4gKlxuICogRGVsaWJlcmF0ZWx5IG5vdCB0aWdodGVuZWQgdG8gdHdvIHplcm8tcGFkZGVkIGRpZ2l0cywgd2hpY2ggaXMgd2hhdCB0aGlzXG4gKiBvZmZpY2UgaGFwcGVucyB0byB1c2U6IGEgZmxvb3IgMTIgb3IgYSBkZXNrIDEwMCB3b3VsZCB0aGVuIGJlIHJlamVjdGVkIGZvclxuICogbG9va2luZyB3cm9uZyByYXRoZXIgdGhhbiBmb3IgYmVpbmcgd3JvbmcuIFdoYXQgdGhpcyBjYXRjaGVzIGlzIHRoZSBtaXN0YWtlXG4gKiBwZW9wbGUgYWN0dWFsbHkgbWFrZSBcdTIwMTQgdHlwaW5nIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBhIGRlc2sgbnVtYmVyIGF0IGFsbDogYVxuICogbmFtZSwgYSByb29tLCBhIHN0cmF5IHNwYWNlLlxuICovXG5leHBvcnQgY29uc3QgREVTS19OQU1FX1BBVFRFUk4gPSAvXlxcZCstXFxkKyQvO1xuXG4vKiogRW1wdHkgaXMgbm90IHZhbGlkLCBidXQgaXQgaXMgbm90IGFuIGVycm9yIGVpdGhlciBcdTIwMTQgc2VlIHRoZSBwb3B1cC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ZhbGlkRGVza05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIERFU0tfTkFNRV9QQVRURVJOLnRlc3QobmFtZS50cmltKCkpO1xufVxuXG4vKipcbiAqIERyb3Agc2tpcCBkYXRlcyB0aGF0IGhhdmUgYWxyZWFkeSBwYXNzZWQuXG4gKlxuICogRGF5cyBjYW4gYmUgbWFya2VkIG1vbnRocyBhaGVhZCwgc28gd2l0aG91dCB0aGlzIHRoZSBsaXN0IG9ubHkgZXZlciBncm93cyBcdTIwMTRcbiAqIGEgeWVhciBvZiBcIkkgd2FzIGF3YXkgdGhhdCBUdWVzZGF5XCIgYWNjdW11bGF0aW5nIGluIHN0b3JhZ2UgYW5kIGluIHRoZVxuICogc2V0dGluZ3MgSlNPTiwgd2hlcmUgaXQgaXMgbm9pc2UgdGhhdCBtYWtlcyB0aGUgcmVhbCBlbnRyaWVzIGhhcmQgdG8gcmVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBydW5lUGFzdFNraXBEYXRlcyhza2lwRGF0ZXM6IHN0cmluZ1tdLCB0b2RheTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIHJldHVybiBza2lwRGF0ZXMuZmlsdGVyKChkYXRlKSA9PiBkYXRlID49IHRvZGF5KTtcbn1cblxuZXhwb3J0IGNvbnN0IEZMT09SUzogeyBpZDogbnVtYmVyOyBsYWJlbDogc3RyaW5nIH1bXSA9IFtcbiAgICB7IGlkOiA0OTUyLCBsYWJlbDogJ0Zsb29yIDMnIH0sXG4gICAgeyBpZDogNDk1MywgbGFiZWw6ICdGbG9vciA0JyB9LFxuXTtcblxuZXhwb3J0IHR5cGUgVmFycyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbi8qKlxuICogQSBwbGFjZWhvbGRlciB0aGF0IG1ha2VzIHVwIHRoZSAqZW50aXJlKiB2YWx1ZSBhbmQgcmVzb2x2ZXMgdG8gYW4gaW50ZWdlclxuICogYmVjb21lcyBhIG51bWJlci5cbiAqXG4gKiBUaGlzIG1hdHRlcnMgYmVjYXVzZSBKU09OIGRpc3Rpbmd1aXNoZXMgNTE1MSBmcm9tIFwiNTE1MVwiIGFuZCBDb21lZW4nc1xuICogcHJlc2VuY2UgYmxvY2sgd2FudHMgdGhlIGZvcm1lci4gUGFydGlhbCBpbnRlcnBvbGF0aW9uIFx1MjAxNCBcIi91c2Vycy97e3VzZXJJZH19L3hcIlxuICogXHUyMDE0IGFsd2F5cyB5aWVsZHMgYSBzdHJpbmcsIHdoaWNoIGlzIHdoYXQgYSBwYXRoIG5lZWRzLCBzbyB0aGUgdHdvIGNhc2VzIG5ldmVyXG4gKiBjb2xsaWRlLiBBIHV1aWQgb3IgYSBkYXRlIGNvbnRhaW5zIG5vbi1kaWdpdHMgYW5kIHN0YXlzIGEgc3RyaW5nIGVpdGhlciB3YXkuXG4gKi9cbmNvbnN0IFdIT0xFX1BMQUNFSE9MREVSID0gL15cXHtcXHsoXFx3KylcXH1cXH0kLztcbmNvbnN0IElOVEVHRVIgPSAvXi0/XFxkKyQvO1xuXG4vKiogUmVwbGFjZSB7e3BsYWNlaG9sZGVyc319IHRocm91Z2hvdXQgYSBKU09OLWlzaCB2YWx1ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdWJzdGl0dXRlKHZhbHVlOiB1bmtub3duLCB2YXJzOiBWYXJzKTogdW5rbm93biB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgY29uc3Qgd2hvbGUgPSBXSE9MRV9QTEFDRUhPTERFUi5leGVjKHZhbHVlKTtcbiAgICAgICAgaWYgKHdob2xlKSB7XG4gICAgICAgICAgICBjb25zdCByZXBsYWNlbWVudCA9IHZhcnNbd2hvbGVbMV0gPz8gJyddO1xuICAgICAgICAgICAgaWYgKHJlcGxhY2VtZW50ID09PSB1bmRlZmluZWQpIHJldHVybiB2YWx1ZTtcbiAgICAgICAgICAgIHJldHVybiBJTlRFR0VSLnRlc3QocmVwbGFjZW1lbnQpID8gTnVtYmVyKHJlcGxhY2VtZW50KSA6IHJlcGxhY2VtZW50O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9cXHtcXHsoXFx3KylcXH1cXH0vZywgKG1hdGNoLCBrZXk6IHN0cmluZykgPT4gdmFyc1trZXldID8/IG1hdGNoKTtcbiAgICB9XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZS5tYXAoKGVudHJ5KSA9PiBzdWJzdGl0dXRlKGVudHJ5LCB2YXJzKSk7XG4gICAgfVxuICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCBlbnRyeV0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUpKSBvdXRba2V5XSA9IHN1YnN0aXR1dGUoZW50cnksIHZhcnMpO1xuICAgICAgICByZXR1cm4gb3V0O1xuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG5cbi8qKlxuICogTWVyZ2Ugc3RvcmVkIHNldHRpbmdzIG92ZXIgdGhlIHNoaXBwZWQgZGVmYXVsdHMuXG4gKlxuICogUGVyc29uYWwgY2hvaWNlcyAoZGVzaywgd2Vla2RheXMsIHRpbWV6b25lKSBhbHdheXMgd2luOiB0aGV5IGFyZSB0aGUgdXNlcidzLlxuICogVGhlIGVuZHBvaW50IGNvbmZpZyBpcyBkaWZmZXJlbnQuIEl0IGlzIG5vdCBhIHByZWZlcmVuY2UsIGl0IGlzIGEgZmFjdCBhYm91dFxuICogQ29tZWVuJ3MgQVBJIHRoYXQgb25lIHBlcnNvbiBkaXNjb3ZlcnMgYW5kIGV2ZXJ5b25lIGVsc2UgaW5oZXJpdHMuIElmIGFcbiAqIHN0b3JlZCBjb3B5IHByZWRhdGVzIHRoZSBzaGlwcGVkIG9uZSwgdGhlIHNoaXBwZWQgb25lIHJlcGxhY2VzIGl0IG91dHJpZ2h0LlxuICogTWVyZ2luZyBrZXktYnkta2V5IHdvdWxkIGJlIHdvcnNlIHRoYW4gdXNlbGVzcyBoZXJlOiBhIGNvcnJlY3RlZCBgY3JlYXRlYFxuICogYmxvY2sgd291bGQgc2l0IG5leHQgdG8gYSBzdGFsZSBgbGlzdGAgYmxvY2sgYW5kIGZhaWwgaW4gYSBjb25mdXNpbmcgd2F5LlxuICpcbiAqIFB1cmUgYW5kIHNlcGFyYXRlIGZyb20gY2hyb21lLnN0b3JhZ2Ugc28gaXQgY2FuIGJlIHRlc3RlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlU2V0dGluZ3Moc3RvcmVkOiBQYXJ0aWFsPFNldHRpbmdzPiB8IHVuZGVmaW5lZCk6IFNldHRpbmdzIHtcbiAgICBjb25zdCBzdG9yZWRWZXJzaW9uID0gc3RvcmVkPy5lbmRwb2ludFZlcnNpb24gPz8gMDtcbiAgICBjb25zdCBzaGlwcGVkSXNOZXdlciA9IHN0b3JlZFZlcnNpb24gPCBERUZBVUxUX1NFVFRJTkdTLmVuZHBvaW50VmVyc2lvbjtcblxuICAgIHJldHVybiB7XG4gICAgICAgIC4uLkRFRkFVTFRfU0VUVElOR1MsXG4gICAgICAgIC4uLnN0b3JlZCxcbiAgICAgICAgZW5kcG9pbnRWZXJzaW9uOiBERUZBVUxUX1NFVFRJTkdTLmVuZHBvaW50VmVyc2lvbixcbiAgICAgICAgZW5kcG9pbnQ6IHNoaXBwZWRJc05ld2VyIHx8ICFzdG9yZWQ/LmVuZHBvaW50XG4gICAgICAgICAgICA/IERFRkFVTFRfU0VUVElOR1MuZW5kcG9pbnRcbiAgICAgICAgICAgIDogc3RvcmVkLmVuZHBvaW50LFxuICAgIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTxTZXR0aW5ncz4ge1xuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgnc2V0dGluZ3MnKTtcbiAgICByZXR1cm4gbWVyZ2VTZXR0aW5ncyhzdG9yZWQuc2V0dGluZ3MgYXMgUGFydGlhbDxTZXR0aW5ncz4gfCB1bmRlZmluZWQpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2F2ZVNldHRpbmdzKHNldHRpbmdzOiBTZXR0aW5ncyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IHNldHRpbmdzIH0pO1xufVxuIiwgImltcG9ydCB0eXBlIHsgRW5kcG9pbnRDb25maWcgfSBmcm9tICcuL2NvcmUvY29uZmlnLmpzJztcblxuZXhwb3J0IGludGVyZmFjZSBJblBhZ2VBcmdzIHtcbiAgICBlbmRwb2ludDogRW5kcG9pbnRDb25maWc7XG4gICAgZGF0ZXM6IHN0cmluZ1tdO1xuICAgIC8qKiBIdW1hbiBsYWJlbCwgZS5nLiBcIjMtMjNcIi4gVXNlZCB0byByZXNvbHZlIHRoZSBpZCB3aGVuIG9uZSBpcyBub3QgY2FjaGVkLiAqL1xuICAgIGRlc2tOYW1lOiBzdHJpbmc7XG4gICAgLyoqIEludGVybmFsIGlkLiBPbmx5IHVzZWQgd2hlbiBubyByZXNvbHZlIGVuZHBvaW50IGlzIGNvbmZpZ3VyZWQuICovXG4gICAgZGVza0lkOiBzdHJpbmc7XG4gICAgc2xvdDogc3RyaW5nO1xuICAgIC8qKiBOYWl2ZSBsb2NhbCB0aW1lcyBmb3IgdGhlIHNsb3QsIGUuZy4gXCIwMDowMDowMC4wMDBaXCIuICovXG4gICAgc3RhcnRUaW1lOiBzdHJpbmc7XG4gICAgZW5kVGltZTogc3RyaW5nO1xuICAgIGZsb29ySWQ6IG51bWJlcjtcbiAgICBidWlsZGluZ0lkOiBudW1iZXI7XG4gICAgZHJ5UnVuOiBib29sZWFuO1xufVxuXG5leHBvcnQgdHlwZSBJblBhZ2VTdGF0dXMgPSAnYm9va2VkJyB8ICdza2lwcGVkJyB8ICdkcnktcnVuJyB8ICd1bmF2YWlsYWJsZScgfCAnZXJyb3InO1xuXG5leHBvcnQgaW50ZXJmYWNlIEluUGFnZVJvdyB7XG4gICAgZGF0ZTogc3RyaW5nO1xuICAgIHN0YXR1czogSW5QYWdlU3RhdHVzO1xuICAgIGRldGFpbD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBJblBhZ2VSZXN1bHQge1xuICAgIHJvd3M6IEluUGFnZVJvd1tdO1xuICAgIG5vdGVzOiBzdHJpbmdbXTtcbiAgICAvKiogU2V0IHdoZW4gdGhlIGRlc2sgaWQgd2FzIGxvb2tlZCB1cCwgc28gdGhlIGNhbGxlciBjYW4gY2FjaGUgaXQuICovXG4gICAgcmVzb2x2ZWREZXNrSWQ/OiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogUHJlc2VudCBvbiBldmVyeSBlYXJseSByZXR1cm4uIE5ldmVyIGNvbnRhaW5zIGEgY3JlZGVudGlhbCBcdTIwMTQgb25seSB3aGljaFxuICAgICAqIHBhZ2UgdGhpcyByYW4gb24gYW5kIHdoaWNoIHN0b3JhZ2Uga2V5cyBleGlzdCwgbmV2ZXIgdGhlaXIgdmFsdWVzLlxuICAgICAqL1xuICAgIGRpYWdub3N0aWNzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgLyoqXG4gICAgICogVGhlIHNlc3Npb24gaXMgZGVhZC4gQSBzdHJ1Y3R1cmVkIGZsYWcgcmF0aGVyIHRoYW4gc29tZXRoaW5nIHRoZSBjYWxsZXJcbiAgICAgKiBoYXMgdG8gcGF0dGVybi1tYXRjaCBvdXQgb2YgYG5vdGVzYCwgYmVjYXVzZSB0aGUgYmFja2dyb3VuZCBzY3JpcHQgYWN0c1xuICAgICAqIG9uIGl0OiBpdCBiYWRnZXMsIG5vdGlmaWVzLCBhbmQgcmV0cmllcyB3aGVuIHlvdSBuZXh0IHZpc2l0IENvbWVlbi5cbiAgICAgKi9cbiAgICBzaWduZWRPdXQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIFJ1bnMgaW5zaWRlIHRoZSBDb21lZW4gdGFiLCBpbiB0aGUgcGFnZSdzIG93biBKYXZhU2NyaXB0IHdvcmxkLlxuICpcbiAqIFx1MjUwMFx1MjUwMFx1MjUwMCBXaHkgaXQgbG9va3MgbGlrZSB0aGlzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICogYGNocm9tZS5zY3JpcHRpbmcuZXhlY3V0ZVNjcmlwdGAgc2VyaWFsaXplcyB0aGlzIGZ1bmN0aW9uIGFuZCByZS1wYXJzZXMgaXQgaW5cbiAqIHRoZSBwYWdlLiBJdCB0aGVyZWZvcmUgQ0FOTk9UIHJlZmVyZW5jZSBhbnl0aGluZyBvdXRzaWRlIGl0cyBvd24gYm9keTogbm9cbiAqIGltcG9ydHMsIG5vIG1vZHVsZS1sZXZlbCBoZWxwZXJzLCBubyBjbG9zdXJlcy4gRXZlcnkgaGVscGVyIGlzIGRlZmluZWQgaW5saW5lXG4gKiBvbiBwdXJwb3NlLiBSZXNpc3QgdGhlIHVyZ2UgdG8gXCJjbGVhbiB0aGlzIHVwXCIgYnkgaG9pc3RpbmcgdGhlbSBvdXQuXG4gKlxuICogXHUyNTAwXHUyNTAwXHUyNTAwIFRoZSBzZWN1cml0eSBwcm9wZXJ0eSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAqIFRoZSBjcmVkZW50aWFsIGlzIHJlYWQgaGVyZSwgdXNlZCBoZXJlLCBhbmQgZGlzY2FyZGVkIGhlcmUuIEl0IGlzIG5ldmVyXG4gKiByZXR1cm5lZCB0byB0aGUgZXh0ZW5zaW9uLCBuZXZlciB3cml0dGVuIHRvIGNocm9tZS5zdG9yYWdlLCBhbmQgbmV2ZXIgbGVhdmVzXG4gKiB0aGUgdGFiLiBUaGUgZXh0ZW5zaW9uIGhvbGRzIGNvbmZpZ3VyYXRpb24gb25seS4gVGhhdCBpcyB0aGUgd2hvbGUgcmVhc29uIHRvXG4gKiBwcmVmZXIgdGhpcyBkZXNpZ24gb3ZlciBhIHNlcnZlci1zaWRlIHNjcmlwdCBob2xkaW5nIGEgc3RvcmVkIHRva2VuLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYm9va0luUGFnZShhcmdzOiBJblBhZ2VBcmdzKTogUHJvbWlzZTxJblBhZ2VSZXN1bHQ+IHtcbiAgICBjb25zdCB7IGVuZHBvaW50LCBkYXRlcywgZGVza05hbWUsIHNsb3QsIHN0YXJ0VGltZSwgZW5kVGltZSwgZHJ5UnVuIH0gPSBhcmdzO1xuICAgIGNvbnN0IG5vdGVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHJvd3M6IEluUGFnZVJvd1tdID0gW107XG4gICAgbGV0IGRlc2tJZCA9IGFyZ3MuZGVza0lkO1xuICAgIGxldCByZXNvbHZlZERlc2tJZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGxldCBzaWduZWRPdXQgPSBmYWxzZTtcbiAgICAvKipcbiAgICAgKiBEYXlzIHRoaXMgZGVzayBhbHJlYWR5IGxvb2tzIHNwb2tlbiBmb3IsIHJlYWQgb2ZmIHRoZSByZXNvbHZlZCBkZXNrJ3Mgb3duXG4gICAgICogc2NoZWR1bGUuIERlbGliZXJhdGVseSBBRFZJU09SWTogaXQgY2hhbmdlcyB3aGF0IFByZXZpZXcgcmVwb3J0cywgYW5kXG4gICAgICogbmV2ZXIgd2hldGhlciBhIHJlYWwgYm9va2luZyBpcyBhdHRlbXB0ZWQuIFNlZSB0aGUgY3JlYXRlIGxvb3AuXG4gICAgICovXG4gICAgY29uc3QgdGFrZW5EYXRlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gICAgLy8gV2hhdGV2ZXIgd2UgbGVhcm4gYWxvbmcgdGhlIHdheSBlbmRzIHVwIGhlcmUgYW5kIGZlZWRzIHRoZSBjcmVhdGUgYm9keS5cbiAgICBjb25zdCB2YXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICBkZXNrTmFtZSxcbiAgICAgICAgc2xvdCxcbiAgICAgICAgc3RhcnRUaW1lLFxuICAgICAgICBlbmRUaW1lLFxuICAgICAgICBmbG9vcklkOiBTdHJpbmcoYXJncy5mbG9vcklkKSxcbiAgICAgICAgYnVpbGRpbmdJZDogU3RyaW5nKGFyZ3MuYnVpbGRpbmdJZCksXG4gICAgICAgIGZyb206IGRhdGVzWzBdID8/ICcnLFxuICAgICAgICB0bzogZGF0ZXNbZGF0ZXMubGVuZ3RoIC0gMV0gPz8gJycsXG4gICAgfTtcblxuICAgIC8vIERpYWdub3N0aWNzIGZvciBldmVyeSBmYWlsdXJlIHBhdGguIEtleSBOQU1FUyBvbmx5LCBuZXZlciB2YWx1ZXMsIHNvIHRoaXNcbiAgICAvLyBjYW4gc2F5IFwieW91IGFyZSBzaWduZWQgb3V0XCIgd2l0aG91dCBldmVyIGhhbmRsaW5nIGEgY3JlZGVudGlhbC5cbiAgICBjb25zdCBkaWFnbm9zdGljcyA9ICgpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiAoe1xuICAgICAgICB1cmw6IHdpbmRvdy5sb2NhdGlvbi5ocmVmLFxuICAgICAgICBsb2NhbFN0b3JhZ2VLZXlzOiAoKCkgPT4ge1xuICAgICAgICAgICAgdHJ5IHsgcmV0dXJuIE9iamVjdC5rZXlzKHdpbmRvdy5sb2NhbFN0b3JhZ2UpOyB9IGNhdGNoIHsgcmV0dXJuIFsnPHVucmVhZGFibGU+J107IH1cbiAgICAgICAgfSkoKSxcbiAgICAgICAgY29va2llTmFtZXM6ICgoKSA9PiB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBkb2N1bWVudC5jb29raWUuc3BsaXQoJzsnKVxuICAgICAgICAgICAgICAgICAgICAubWFwKChwYWlyKSA9PiBwYWlyLnNwbGl0KCc9JylbMF0/LnRyaW0oKSA/PyAnJylcbiAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggeyByZXR1cm4gWyc8dW5yZWFkYWJsZT4nXTsgfVxuICAgICAgICB9KSgpLFxuICAgIH0pO1xuXG4gICAgLy8gXHUyNTAwXHUyNTAwIGlubGluZSBoZWxwZXJzIChzZWUgY29tbWVudCBhYm92ZSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgICAvLyBNaXJyb3JzIGBzdWJzdGl0dXRlYCBpbiBjb3JlL2NvbmZpZy50cy4gQSBwbGFjZWhvbGRlciB0aGF0IGlzIHRoZSBlbnRpcmVcbiAgICAvLyB2YWx1ZSBhbmQgcmVzb2x2ZXMgdG8gYW4gaW50ZWdlciBiZWNvbWVzIGEgbnVtYmVyLCBiZWNhdXNlIENvbWVlbidzXG4gICAgLy8gcHJlc2VuY2UgYmxvY2sgd2FudHMgYnVpbGRpbmdfaWQ6IDUxNTEsIG5vdCBcIjUxNTFcIi4gUGFydGlhbFxuICAgIC8vIGludGVycG9sYXRpb24gc3RheXMgYSBzdHJpbmcsIHdoaWNoIGlzIHdoYXQgYSBVUkwgcGF0aCBuZWVkcy5cbiAgICBjb25zdCBmaWxsID0gKHZhbHVlOiB1bmtub3duLCBzb3VyY2U6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiB1bmtub3duID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGNvbnN0IHdob2xlID0gL15cXHtcXHsoXFx3KylcXH1cXH0kLy5leGVjKHZhbHVlKTtcbiAgICAgICAgICAgIGlmICh3aG9sZSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlcGxhY2VtZW50ID0gc291cmNlW3dob2xlWzFdID8/ICcnXTtcbiAgICAgICAgICAgICAgICBpZiAocmVwbGFjZW1lbnQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHZhbHVlO1xuICAgICAgICAgICAgICAgIHJldHVybiAvXi0/XFxkKyQvLnRlc3QocmVwbGFjZW1lbnQpID8gTnVtYmVyKHJlcGxhY2VtZW50KSA6IHJlcGxhY2VtZW50O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLnJlcGxhY2UoL1xce1xceyhcXHcrKVxcfVxcfS9nLCAobWF0Y2gsIGtleTogc3RyaW5nKSA9PiBzb3VyY2Vba2V5XSA/PyBtYXRjaCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gdmFsdWUubWFwKChlbnRyeSkgPT4gZmlsbChlbnRyeSwgc291cmNlKSk7XG4gICAgICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSkpIG91dFtrZXldID0gZmlsbChlbnRyeSwgc291cmNlKTtcbiAgICAgICAgICAgIHJldHVybiBvdXQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH07XG5cbiAgICBjb25zdCBkaWcgPSAob2JqOiB1bmtub3duLCBwYXRoOiBzdHJpbmcpOiB1bmtub3duID0+IHBhdGhcbiAgICAgICAgLnNwbGl0KCcuJylcbiAgICAgICAgLnJlZHVjZTx1bmtub3duPigoY3VycmVudCwga2V5KSA9PiAoXG4gICAgICAgICAgICBjdXJyZW50ICYmIHR5cGVvZiBjdXJyZW50ID09PSAnb2JqZWN0JyA/IChjdXJyZW50IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrZXldIDogdW5kZWZpbmVkXG4gICAgICAgICksIG9iaik7XG5cbiAgICBjb25zdCBhdXRoSGVhZGVycyA9ICgpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0+IHtcbiAgICAgICAgaWYgKGVuZHBvaW50LmF1dGgubW9kZSAhPT0gJ2xvY2FsU3RvcmFnZScpIHJldHVybiB7fTtcbiAgICAgICAgY29uc3QgeyBzdG9yYWdlS2V5LCBqc29uUGF0aCwgaGVhZGVyLCBwcmVmaXggfSA9IGVuZHBvaW50LmF1dGg7XG4gICAgICAgIGlmICghc3RvcmFnZUtleSB8fCAhanNvblBhdGgpIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goJ2F1dGgubW9kZSBpcyBsb2NhbFN0b3JhZ2UgYnV0IHN0b3JhZ2VLZXkvanNvblBhdGggYXJlIG1pc3NpbmcuJyk7XG4gICAgICAgICAgICByZXR1cm4ge307XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmF3ID0gd2luZG93LmxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkpO1xuICAgICAgICBpZiAoIXJhdykge1xuICAgICAgICAgICAgbm90ZXMucHVzaChgbG9jYWxTdG9yYWdlIGtleSBcIiR7c3RvcmFnZUtleX1cIiBub3QgZm91bmQuIEFyZSB5b3Ugc2lnbmVkIGluP2ApO1xuICAgICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICB9XG4gICAgICAgIGxldCB0b2tlbjogdW5rbm93bjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHRva2VuID0gZGlnKEpTT04ucGFyc2UocmF3KSwganNvblBhdGgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goYGxvY2FsU3RvcmFnZSBrZXkgXCIke3N0b3JhZ2VLZXl9XCIgaXMgbm90IEpTT04uYCk7XG4gICAgICAgICAgICByZXR1cm4ge307XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHR5cGVvZiB0b2tlbiAhPT0gJ3N0cmluZycgfHwgIXRva2VuKSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGBObyB0b2tlbiBhdCBwYXRoIFwiJHtqc29uUGF0aH1cIi5gKTtcbiAgICAgICAgICAgIHJldHVybiB7fTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBbaGVhZGVyID8/ICdhdXRob3JpemF0aW9uJ106IGAke3ByZWZpeCA/PyAnQmVhcmVyICd9JHt0b2tlbn1gIH07XG4gICAgfTtcblxuICAgIGNvbnN0IGNhbGwgPSBhc3luYyAoXG4gICAgICAgIHRwbDogeyBtZXRob2Q6IHN0cmluZzsgcGF0aDogc3RyaW5nOyBxdWVyeT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47IGJvZHk/OiB1bmtub3duIH0sXG4gICAgICAgIHNvdXJjZTogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbiAgICApOiBQcm9taXNlPHsgb2s6IGJvb2xlYW47IHN0YXR1czogbnVtYmVyOyBkYXRhOiB1bmtub3duOyB0ZXh0OiBzdHJpbmc7IHNpZ25lZE91dDogYm9vbGVhbiB9PiA9PiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBmaWxsKHRwbC5wYXRoLCBzb3VyY2UpIGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChgJHtlbmRwb2ludC5hcGlCYXNlLnJlcGxhY2UoL1xcLyQvLCAnJyl9JHtwYXRofWApO1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhmaWxsKHRwbC5xdWVyeSA/PyB7fSwgc291cmNlKSBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KSkge1xuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoa2V5LCBTdHJpbmcodmFsdWUpKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBib2R5ID0gdHBsLmJvZHkgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IEpTT04uc3RyaW5naWZ5KGZpbGwodHBsLmJvZHksIHNvdXJjZSkpO1xuXG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHdpbmRvdy5mZXRjaCh1cmwudG9TdHJpbmcoKSwge1xuICAgICAgICAgICAgbWV0aG9kOiB0cGwubWV0aG9kLFxuICAgICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJyxcbiAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICBhY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAgICAgICAuLi4oYm9keSA9PT0gdW5kZWZpbmVkID8ge30gOiB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSksXG4gICAgICAgICAgICAgICAgLi4uYXV0aEhlYWRlcnMoKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBib2R5LFxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcbiAgICAgICAgbGV0IGRhdGE6IHVua25vd24gPSBudWxsO1xuICAgICAgICB0cnkgeyBkYXRhID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsOyB9IGNhdGNoIHsgZGF0YSA9IG51bGw7IH1cblxuICAgICAgICAvLyBBbiBleHBpcmVkIHNlc3Npb24gZG9lcyBub3QgYW5ub3VuY2UgaXRzZWxmIHdpdGggYSB0aWR5IDQwMS4gQ29tZWVuXG4gICAgICAgIC8vIHJlZGlyZWN0cyB0byB0aGUgbG9naW4gcGFnZSwgc28gdGhlIGZldGNoIGZvbGxvd3MgaXQgYW5kIGhhbmRzIGJhY2sgYVxuICAgICAgICAvLyAyMDAgZnVsbCBvZiBIVE1MLiBQYXJzZWQgYXMgSlNPTiB0aGF0IGJlY29tZXMgbnVsbCwgd2hpY2ggZG93bnN0cmVhbVxuICAgICAgICAvLyByZWFkcyBhcyBcInplcm8gcmVzdWx0c1wiIFx1MjAxNCBoZW5jZSB0aGUgb2xkLCBiYWRseSBtaXNsZWFkaW5nIFwibm8gZGVza1xuICAgICAgICAvLyBjYWxsZWQgMy0yMyBpbiAwIHNlYXJjaCByZXN1bHQocylcIi4gQ2F0Y2ggaXQgaGVyZSBpbnN0ZWFkLlxuICAgICAgICBsZXQgZmluYWxIb3N0ID0gJyc7XG4gICAgICAgIHRyeSB7IGZpbmFsSG9zdCA9IG5ldyBVUkwocmVzLnVybCkuaG9zdG5hbWU7IH0gY2F0Y2ggeyAvKiBzdHViIG9yIG9wYXF1ZSAqLyB9XG4gICAgICAgIGNvbnN0IGxvb2tzTGlrZUh0bWwgPSAvXlxccyo8KCFkb2N0eXBlfGh0bWwpL2kudGVzdCh0ZXh0KTtcbiAgICAgICAgY29uc3Qgc2lnbmVkT3V0ID0gcmVzLnN0YXR1cyA9PT0gNDAxXG4gICAgICAgICAgICB8fCByZXMuc3RhdHVzID09PSA0MDNcbiAgICAgICAgICAgIHx8IC8oXnxcXC4pYWNjb3VudHNcXC5jb21lZW5cXC5pbyQvLnRlc3QoZmluYWxIb3N0KVxuICAgICAgICAgICAgfHwgKGxvb2tzTGlrZUh0bWwgJiYgZGF0YSA9PT0gbnVsbCk7XG5cbiAgICAgICAgcmV0dXJuIHsgb2s6IHJlcy5vaywgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhLCB0ZXh0LCBzaWduZWRPdXQgfTtcbiAgICB9O1xuXG4gICAgY29uc3Qgc2lnbmVkT3V0UmVzdWx0ID0gKCk6IEluUGFnZVJlc3VsdCA9PiAoe1xuICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgbm90ZXM6IFsnTm90IHNpZ25lZCBpbiB0byBDb21lZW4uIE9wZW4gaHR0cHM6Ly9teS5jb21lZW4uaW8vLCBzaWduIGluLCB0aGVuIHJ1biBhZ2Fpbi4nXSxcbiAgICAgICAgZGlhZ25vc3RpY3M6IGRpYWdub3N0aWNzKCksXG4gICAgICAgIHNpZ25lZE91dDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFzTGlzdCA9IChkYXRhOiB1bmtub3duKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSA9PiB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSByZXR1cm4gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdO1xuICAgICAgICBpZiAoZGF0YSAmJiB0eXBlb2YgZGF0YSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IG9iaiA9IGRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBbJ2l0ZW1zJywgJ2RhdGEnLCAncmVzdWx0cycsICdib29raW5ncycsICdkZXNrcyddKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob2JqW2tleV0pKSByZXR1cm4gb2JqW2tleV0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gW107XG4gICAgfTtcblxuICAgIGNvbnN0IG5vcm1hbGlzZSA9ICh2YWx1ZTogdW5rbm93bik6IHN0cmluZyA9PiBTdHJpbmcodmFsdWUgPz8gJycpXG4gICAgICAgIC50cmltKCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bXFxzX10rL2csICctJyk7XG5cbiAgICAvLyBDb25maXJtZWQgYWdhaW5zdCBhIHJlYWwgY29udGVuZGVkIGRheTogQ29tZWVuIHJlamVjdHMgYSBkZXNrIHNvbWVvbmUgZWxzZVxuICAgIC8vIGFscmVhZHkgaG9sZHMgd2l0aCA0MjIgYW5kIGEgbWVzc2FnZSwgbm90IGEgY2xlYW4gNDA5LiBSZWFkaW5nIHRoZSBtZXNzYWdlXG4gICAgLy8gYXMgd2VsbCBhcyB0aGUgc3RhdHVzIGlzIHdoYXQga2VlcHMgdGhhdCByZXBvcnRlZCBhcyBcInVuYXZhaWxhYmxlXCIgcmF0aGVyXG4gICAgLy8gdGhhbiBhcyBhbiBlcnJvciB0aGF0IGxvb2tzIGxpa2UgYSBidWcgaW4gdGhpcyBleHRlbnNpb24uXG4gICAgY29uc3QgbG9va3NUYWtlbiA9IChzdGF0dXM6IG51bWJlciwgdGV4dDogc3RyaW5nKTogYm9vbGVhbiA9PiBzdGF0dXMgPT09IDQwOVxuICAgICAgICB8fCBzdGF0dXMgPT09IDQyMlxuICAgICAgICB8fCAvdGFrZW58YWxyZWFkeXx1bmF2YWlsYWJsZXxvY2N1cGllZHxmdWxsfGNvbmZsaWN0L2kudGVzdCh0ZXh0KTtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCAxLiB3aGljaCBkZXNrPyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAvLyBSZXNvbHZpbmcgZXZlcnkgcnVuIHJhdGhlciB0aGFuIHRydXN0aW5nIGEgY2FjaGVkIGlkOiB0aGUgbG9va3VwIGFsc29cbiAgICAvLyB5aWVsZHMgdGhlIGRlc2sncyBhcmVhX2lkLCB3aGljaCB0aGUgY3JlYXRlIGJvZHkgbmVlZHMsIGFuZCBpdCBtZWFucyBhXG4gICAgLy8gcmVudW1iZXJlZCBvciBtb3ZlZCBkZXNrIGNvcnJlY3RzIGl0c2VsZiBpbnN0ZWFkIG9mIGJvb2tpbmcgdGhlIHdyb25nIHNlYXQuXG4gICAgaWYgKGVuZHBvaW50LnJlc29sdmUpIHtcbiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgY2FsbChlbmRwb2ludC5yZXNvbHZlLCB2YXJzKTtcbiAgICAgICAgaWYgKHJlcy5zaWduZWRPdXQpIHJldHVybiBzaWduZWRPdXRSZXN1bHQoKTtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgcm93czogW10sXG4gICAgICAgICAgICAgICAgbm90ZXM6IFtgRGVzayBsb29rdXAgZmFpbGVkICgke3Jlcy5zdGF0dXN9KTogJHtyZXMudGV4dC5zbGljZSgwLCAyMDApfWBdLFxuICAgICAgICAgICAgICAgIGRpYWdub3N0aWNzOiBkaWFnbm9zdGljcygpLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBhc0xpc3QocmVzLmRhdGEpO1xuICAgICAgICBjb25zdCBtYXRjaCA9IGNhbmRpZGF0ZXMuZmluZCgoZGVzaykgPT4gZW5kcG9pbnQuZGVza05hbWVGaWVsZHNcbiAgICAgICAgICAgIC5zb21lKChmaWVsZCkgPT4gbm9ybWFsaXNlKGRlc2tbZmllbGRdKSA9PT0gbm9ybWFsaXNlKGRlc2tOYW1lKSkpO1xuXG4gICAgICAgIGlmICghbWF0Y2gpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgcm93czogW10sXG4gICAgICAgICAgICAgICAgbm90ZXM6IFtcbiAgICAgICAgICAgICAgICAgICAgYE5vIGRlc2sgY2FsbGVkIFwiJHtkZXNrTmFtZX1cIiBpbiAke2NhbmRpZGF0ZXMubGVuZ3RofSBzZWFyY2ggcmVzdWx0KHMpLmAsXG4gICAgICAgICAgICAgICAgICAgIGBGaXJzdCBmZXc6ICR7SlNPTi5zdHJpbmdpZnkoY2FuZGlkYXRlcy5zbGljZSgwLCAzKSkuc2xpY2UoMCwgNDAwKX1gLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgZGlhZ25vc3RpY3M6IGRpYWdub3N0aWNzKCksXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgaWRGaWVsZCA9IGVuZHBvaW50LmRlc2tJZEZpZWxkcy5maW5kKChmaWVsZCkgPT4gbWF0Y2hbZmllbGRdICE9PSB1bmRlZmluZWRcbiAgICAgICAgICAgICYmIG1hdGNoW2ZpZWxkXSAhPT0gbnVsbCk7XG4gICAgICAgIGlmICghaWRGaWVsZCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgICAgICBub3RlczogW1xuICAgICAgICAgICAgICAgICAgICBgRm91bmQgXCIke2Rlc2tOYW1lfVwiIGJ1dCBub25lIG9mICR7ZW5kcG9pbnQuZGVza0lkRmllbGRzLmpvaW4oJy8nKX0gaGVsZCBhbiBpZC5gLFxuICAgICAgICAgICAgICAgICAgICBgUmVjb3JkOiAke0pTT04uc3RyaW5naWZ5KG1hdGNoKS5zbGljZSgwLCA0MDApfWAsXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICBkaWFnbm9zdGljczogZGlhZ25vc3RpY3MoKSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBkZXNrSWQgPSBTdHJpbmcobWF0Y2hbaWRGaWVsZF0pO1xuICAgICAgICByZXNvbHZlZERlc2tJZCA9IGRlc2tJZDtcbiAgICAgICAgbm90ZXMucHVzaChgUmVzb2x2ZWQgXCIke2Rlc2tOYW1lfVwiIHRvICR7aWRGaWVsZH0gJHtkZXNrSWR9LmApO1xuXG4gICAgICAgIC8vIFRoZSBkZXNrIGtub3dzIHdoaWNoIGFyZWEgYW5kIGZsb29yIGl0IGlzIGluOyBwcmVmZXIgdGhhdCBvdmVyIHRoZVxuICAgICAgICAvLyBjb25maWd1cmVkIGZsb29yLCB3aGljaCBpcyBvbmx5IGEgc3RhcnRpbmcgcG9pbnQgZm9yIHRoZSBsb29rdXAuXG4gICAgICAgIGlmIChtYXRjaC5hcmVhX2lkICE9PSB1bmRlZmluZWQgJiYgbWF0Y2guYXJlYV9pZCAhPT0gbnVsbCkgdmFycy5hcmVhSWQgPSBTdHJpbmcobWF0Y2guYXJlYV9pZCk7XG4gICAgICAgIGlmIChtYXRjaC5mbG9vcl9pZCAhPT0gdW5kZWZpbmVkICYmIG1hdGNoLmZsb29yX2lkICE9PSBudWxsKSB2YXJzLmZsb29ySWQgPSBTdHJpbmcobWF0Y2guZmxvb3JfaWQpO1xuXG4gICAgICAgIGlmIChtYXRjaC5hdmFpbGFibGVfdG9fYm9va2luZyA9PT0gZmFsc2UpIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goYFx1MjZBMCBcIiR7ZGVza05hbWV9XCIgaXMgbWFya2VkIG5vdCBhdmFpbGFibGUgdG8gYm9va2luZyBcdTIwMTQgaXQgbWF5IGJlIGFzc2lnbmVkIHRvIHNvbWVvbmUuYCk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBUaGUgZGVzayBjYXJyaWVzIGl0cyBvd24gYm9va2luZ3MgZm9yIHRoZSBxdWVyaWVkIHdpbmRvdywgd2hpY2ggaXMgaG93XG4gICAgICAgIC8vIFByZXZpZXcgY2FuIHNheSBcInNvbWVvbmUgZWxzZSBoYXMgaXRcIiBpbnN0ZWFkIG9mIGNoZWVyZnVsbHkgcHJvbWlzaW5nXG4gICAgICAgIC8vIGEgZGF5IHRoYXQgd2lsbCA0MjIgdGhlIG1vbWVudCB5b3UgcHJlc3MgQm9vayBub3cuXG4gICAgICAgIGlmIChlbmRwb2ludC5kZXNrU2NoZWR1bGVGaWVsZCkge1xuICAgICAgICAgICAgY29uc3QgZW50cmllcyA9IG1hdGNoW2VuZHBvaW50LmRlc2tTY2hlZHVsZUZpZWxkXTtcbiAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudHJpZXMpKSB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+W10pIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFlbnRyeSB8fCB0eXBlb2YgZW50cnkgIT09ICdvYmplY3QnKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWVsZCBvZiBlbmRwb2ludC5kZXNrU2NoZWR1bGVEYXRlRmllbGRzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGVudHJ5W2ZpZWxkXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIC9eXFxkezR9LVxcZHsyfS1cXGR7Mn0vLnRlc3QodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFrZW5EYXRlcy5hZGQodmFsdWUuc2xpY2UoMCwgMTApKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAodGFrZW5EYXRlcy5zaXplID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBub3Rlcy5wdXNoKGBcIiR7ZGVza05hbWV9XCIgYWxyZWFkeSBoYXMgJHt0YWtlbkRhdGVzLnNpemV9IGRheShzKSBib29rZWQgaW4gdGhpcyB3aW5kb3cuYCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFkZXNrSWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHJvd3M6IFtdLFxuICAgICAgICAgICAgbm90ZXM6IFsnTm8gZGVzayBJRCBzZXQgYW5kIG5vIGRlc2stc2VhcmNoIGVuZHBvaW50IGNvbmZpZ3VyZWQuJ10sXG4gICAgICAgICAgICBkaWFnbm9zdGljczogZGlhZ25vc3RpY3MoKSxcbiAgICAgICAgfTtcbiAgICB9XG4gICAgdmFycy5kZXNrSWQgPSBkZXNrSWQ7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgMi4gd2hhdCBkbyBJIGFscmVhZHkgaGF2ZT8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgY29uc3QgaGVsZERhdGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgICBpZiAoZW5kcG9pbnQubGlzdCkge1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBjYWxsKGVuZHBvaW50Lmxpc3QsIHZhcnMpO1xuICAgICAgICBpZiAocmVzLnNpZ25lZE91dCkgcmV0dXJuIHNpZ25lZE91dFJlc3VsdCgpO1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgICAgLy8gTm90IGZhdGFsLCBidXQgaXQgbWVhbnMgd2UgbG9zZSBpZGVtcG90ZW5jeSwgc28gc2F5IHNvIGxvdWRseS5cbiAgICAgICAgICAgIG5vdGVzLnB1c2goXG4gICAgICAgICAgICAgICAgYENvdWxkIG5vdCBsaXN0IGV4aXN0aW5nIGJvb2tpbmdzICgke3Jlcy5zdGF0dXN9KS4gUHJvY2VlZGluZyB3aXRob3V0IHRoZSBgXG4gICAgICAgICAgICAgICAgKyBgZHVwbGljYXRlIGNoZWNrLCBzbyBleHBlY3QgXCJ1bmF2YWlsYWJsZVwiIG9uIGRheXMgeW91IGFscmVhZHkgaG9sZC4gYFxuICAgICAgICAgICAgICAgICsgYFJlc3BvbnNlOiAke3Jlcy50ZXh0LnNsaWNlKDAsIDIwMCl9YCxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBUaGUgc2lnbmVkLWluIHVzZXIncyBvd24gaWQgaXMgaW4gdGhpcyByZXNwb25zZSwgYW5kIHRoZSBjcmVhdGVcbiAgICAgICAgICAgIC8vIHBhdGggbmVlZHMgaXQuIFJlYWRpbmcgaXQgaGVyZSBhdm9pZHMgYSBzZWNvbmQgcm91bmQgdHJpcCBhbmRcbiAgICAgICAgICAgIC8vIGF2b2lkcyBtYWtpbmcgdGhlIHVzZXIgbG9vayB0aGVpciBvd24gaWQgdXAuXG4gICAgICAgICAgICBpZiAoZW5kcG9pbnQudXNlcklkUGF0aCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHVzZXJJZCA9IGRpZyhyZXMuZGF0YSwgZW5kcG9pbnQudXNlcklkUGF0aCk7XG4gICAgICAgICAgICAgICAgaWYgKHVzZXJJZCAhPT0gdW5kZWZpbmVkICYmIHVzZXJJZCAhPT0gbnVsbCkgdmFycy51c2VySWQgPSBTdHJpbmcodXNlcklkKTtcbiAgICAgICAgICAgICAgICBlbHNlIG5vdGVzLnB1c2goYE5vIHVzZXIgaWQgYXQgXCIke2VuZHBvaW50LnVzZXJJZFBhdGh9XCIgaW4gdGhlIGxpc3QgcmVzcG9uc2UuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGNvbnRhaW5lciA9IGVuZHBvaW50Lmxpc3RSb290ID8gZGlnKHJlcy5kYXRhLCBlbmRwb2ludC5saXN0Um9vdCkgOiByZXMuZGF0YTtcblxuICAgICAgICAgICAgaWYgKGVuZHBvaW50Lmxpc3RTaGFwZSA9PT0gJ2RhdGVLZXllZE1hcCcpIHtcbiAgICAgICAgICAgICAgICAvLyB7IFwiMjAyNi0wOS0wMVwiOiBbZW50cnldLCBcIjIwMjYtMDktMDJcIjogW10gfSBcdTIwMTQgYSBkYXkgd2l0aCBhbnlcbiAgICAgICAgICAgICAgICAvLyBlbnRyeSBpcyBhIGRheSBhbHJlYWR5IHNwb2tlbiBmb3IuXG4gICAgICAgICAgICAgICAgaWYgKGNvbnRhaW5lciAmJiB0eXBlb2YgY29udGFpbmVyID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShjb250YWluZXIpKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgW2RhdGUsIGVudHJpZXNdIG9mIE9iamVjdC5lbnRyaWVzKGNvbnRhaW5lciBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudHJpZXMpICYmIGVudHJpZXMubGVuZ3RoID4gMCkgaGVsZERhdGVzLmFkZChkYXRlLnNsaWNlKDAsIDEwKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgbm90ZXMucHVzaChgRm91bmQgJHtoZWxkRGF0ZXMuc2l6ZX0gZGF5KHMpIGFscmVhZHkgYm9va2VkIGluIHRoZSB3aW5kb3cuYCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgICAgICAgICAgICAgIGBsaXN0U2hhcGUgaXMgZGF0ZUtleWVkTWFwIGJ1dCBcIiR7ZW5kcG9pbnQubGlzdFJvb3R9XCIgaXMgbm90IGFuIG9iamVjdC4gYFxuICAgICAgICAgICAgICAgICAgICAgICAgKyBgR290OiAke0pTT04uc3RyaW5naWZ5KGNvbnRhaW5lcikuc2xpY2UoMCwgMjAwKX1gLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBhc0xpc3QoY29udGFpbmVyKTtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGJvb2tpbmcgb2YgZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWVsZCBvZiBlbmRwb2ludC5saXN0RGF0ZUZpZWxkcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBib29raW5nW2ZpZWxkXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaGVsZERhdGVzLmFkZCh2YWx1ZS5zbGljZSgwLCAxMCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goYEZvdW5kICR7ZXhpc3RpbmcubGVuZ3RofSBleGlzdGluZyBib29raW5nKHMpIGluIHRoZSB3aW5kb3cuYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBgbWVgIHdvcmtzIGZvciByZWFkcywgc28gaXQgaXMgYSBiZXR0ZXIgZmFsbGJhY2sgdGhhbiBhIGxpdGVyYWxcbiAgICAvLyB7e3VzZXJJZH19IGluIHRoZSBwYXRoIGlmIHRoZSBsaXN0IHN0ZXAgY291bGQgbm90IHN1cHBseSBvbmUuXG4gICAgaWYgKHZhcnMudXNlcklkID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdmFycy51c2VySWQgPSAnbWUnO1xuICAgICAgICBpZiAoZW5kcG9pbnQudXNlcklkUGF0aCkgbm90ZXMucHVzaCgnRmFsbGluZyBiYWNrIHRvIC91c2Vycy9tZSBmb3IgdGhlIGJvb2tpbmcgcGF0aC4nKTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgMy4gYm9vayB0aGUgZ2FwcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBmb3IgKGNvbnN0IGRhdGUgb2YgZGF0ZXMpIHtcbiAgICAgICAgaWYgKGhlbGREYXRlcy5oYXMoZGF0ZSkpIHtcbiAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ3NraXBwZWQnLCBkZXRhaWw6ICdhbHJlYWR5IGJvb2tlZCcgfSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZHJ5UnVuKSB7XG4gICAgICAgICAgICByb3dzLnB1c2godGFrZW5EYXRlcy5oYXMoZGF0ZSlcbiAgICAgICAgICAgICAgICA/IHsgZGF0ZSwgc3RhdHVzOiAndW5hdmFpbGFibGUnLCBkZXRhaWw6ICdzb21lb25lIGVsc2UgaG9sZHMgdGhpcyBkZXNrIHRoYXQgZGF5JyB9XG4gICAgICAgICAgICAgICAgOiB7IGRhdGUsIHN0YXR1czogJ2RyeS1ydW4nLCBkZXRhaWw6IGB3b3VsZCBib29rICR7ZGVza0lkfSAoJHtzbG90fSlgIH0pO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBOb3RlIHRoZSBhc3ltbWV0cnksIGFuZCBkbyBub3QgXCJvcHRpbWlzZVwiIHRoaXMgaW50byBhIHNraXAuIFRoZSBkZXNrXG4gICAgICAgIC8vIHNjaGVkdWxlIGlzIHJlYWQgZGVmZW5zaXZlbHkgZnJvbSBhIHNoYXBlIHRoYXQgaGFzIG5ldmVyIGJlZW4gc2VlblxuICAgICAgICAvLyBwb3B1bGF0ZWQsIHNvIGEgbWlzcmVhZGluZyBpcyBwb3NzaWJsZS4gQXR0ZW1wdGluZyBhbnl3YXkgY29zdHMgb25lXG4gICAgICAgIC8vIHJlcXVlc3QgdGhhdCByZXR1cm5zIDQyMiBhbmQgaXMgcmVwb3J0ZWQgYXMgdW5hdmFpbGFibGUgXHUyMDE0IGV4YWN0bHkgd2hhdFxuICAgICAgICAvLyB3b3VsZCBoYXZlIGJlZW4gcmVwb3J0ZWQgYnkgc2tpcHBpbmcuIFNraXBwaW5nIHdyb25nbHkgY29zdHMgYSBkYXlcbiAgICAgICAgLy8geW91IGNvdWxkIGhhdmUgaGFkLCBhbmQgZG9lcyBpdCBzaWxlbnRseS5cbiAgICAgICAgaWYgKHRha2VuRGF0ZXMuaGFzKGRhdGUpKSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGAke2RhdGV9OiBkZXNrIGxvb2tzIHRha2VuOyB0cnlpbmcgYW55d2F5IGluIGNhc2UgdGhhdCByZWFkaW5nIGlzIHdyb25nLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGNhbGwoZW5kcG9pbnQuY3JlYXRlLCB7IC4uLnZhcnMsIGRhdGUgfSk7XG4gICAgICAgICAgICBpZiAocmVzLnNpZ25lZE91dCkge1xuICAgICAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ2Vycm9yJywgZGV0YWlsOiAnbm90IHNpZ25lZCBpbicgfSk7XG4gICAgICAgICAgICAgICAgbm90ZXMucHVzaCgnU2lnbmVkIG91dCBwYXJ0d2F5IHRocm91Z2guIFNpZ24gaW4gYXQgaHR0cHM6Ly9teS5jb21lZW4uaW8vIGFuZCBydW4gJ1xuICAgICAgICAgICAgICAgICAgICArICdhZ2FpbiBcdTIwMTQgdGhlIGRheXMgYWxyZWFkeSBib29rZWQgd2lsbCBiZSBza2lwcGVkLicpO1xuICAgICAgICAgICAgICAgIHNpZ25lZE91dCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzLm9rKSB7XG4gICAgICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnYm9va2VkJyB9KTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobG9va3NUYWtlbihyZXMuc3RhdHVzLCByZXMudGV4dCkpIHtcbiAgICAgICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICd1bmF2YWlsYWJsZScsIGRldGFpbDogYCR7cmVzLnN0YXR1c306ICR7cmVzLnRleHQuc2xpY2UoMCwgMTYwKX1gIH0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICdlcnJvcicsIGRldGFpbDogYCR7cmVzLnN0YXR1c306ICR7cmVzLnRleHQuc2xpY2UoMCwgMjAwKX1gIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ2Vycm9yJywgZGV0YWlsOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4geyByb3dzLCBub3RlcywgcmVzb2x2ZWREZXNrSWQsIHNpZ25lZE91dCB9O1xufVxuIiwgImltcG9ydCB7IGRhdGVzVG9Cb29rIH0gZnJvbSAnLi9jb3JlL2RhdGVzLmpzJztcbmltcG9ydCB7XG4gICAgaXNWYWxpZERlc2tOYW1lLFxuICAgIGxvYWRTZXR0aW5ncyxcbiAgICBzYXZlU2V0dGluZ3MsXG4gICAgU0xPVF9USU1FUyxcbiAgICB0eXBlIFNldHRpbmdzLFxufSBmcm9tICcuL2NvcmUvY29uZmlnLmpzJztcbmltcG9ydCB7IGJvb2tJblBhZ2UsIHR5cGUgSW5QYWdlUmVzdWx0IH0gZnJvbSAnLi9pbmplY3RlZC5qcyc7XG5cbmNvbnN0IEFMQVJNID0gJ2NvbWVlbi10b3AtdXAnO1xuY29uc3QgQ09NRUVOX1VSTCA9ICdodHRwczovL215LmNvbWVlbi5pby8nO1xuY29uc3QgVEFCX01BVENIID0gJ2h0dHBzOi8vbXkuY29tZWVuLmlvLyonO1xuY29uc3QgU0lHTkVEX09VVF9OT1RJRklDQVRJT04gPSAnY29tZWVuLXNpZ25lZC1vdXQnO1xuXG4vKipcbiAqIFRocm93biB3aGVuIHRoZSBzZXNzaW9uIGlzIGdvbmUsIHNvIHRoZSBjYWxsZXIgY2FuIHRlbGwgaXQgYXBhcnQgZnJvbSBhblxuICogb3JkaW5hcnkgZmFpbHVyZSBieSB0eXBlIHJhdGhlciB0aGFuIGJ5IHJlYWRpbmcgdGhlIG1lc3NhZ2UgdGV4dC5cbiAqL1xuY2xhc3MgU2lnbmVkT3V0RXJyb3IgZXh0ZW5kcyBFcnJvciB7fVxuXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkxvZyB7XG4gICAgYXQ6IHN0cmluZztcbiAgICBkcnlSdW46IGJvb2xlYW47XG4gICAgZGF0ZXM6IHN0cmluZ1tdO1xuICAgIHJvd3M6IEluUGFnZVJlc3VsdFsncm93cyddO1xuICAgIG5vdGVzOiBzdHJpbmdbXTtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgICAvKiogVGhlIHJ1biBzdG9wcGVkIGJlY2F1c2UgdGhlIENvbWVlbiBzZXNzaW9uIGhhcyBleHBpcmVkLiAqL1xuICAgIHNpZ25lZE91dD86IGJvb2xlYW47XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwcGVuZExvZyhlbnRyeTogUnVuTG9nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgeyBydW5zID0gW10gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgncnVucycpIGFzIHsgcnVucz86IFJ1bkxvZ1tdIH07XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgcnVuczogW2VudHJ5LCAuLi5ydW5zXS5zbGljZSgwLCAxMCkgfSk7XG59XG5cbi8qKlxuICogRmluZCBhIENvbWVlbiB0YWIsIG9yIG9wZW4gb25lIGluIHRoZSBiYWNrZ3JvdW5kLlxuICogUmV0dXJucyB0aGUgdGFiIGlkIHBsdXMgd2hldGhlciB3ZSBjcmVhdGVkIGl0IChhbmQgc2hvdWxkIHRoZXJlZm9yZSBjbG9zZSBpdCkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdldENvbWVlblRhYigpOiBQcm9taXNlPHsgdGFiSWQ6IG51bWJlcjsgdGVtcG9yYXJ5OiBib29sZWFuIH0+IHtcbiAgICBjb25zdCBvcGVuID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyB1cmw6IFRBQl9NQVRDSCB9KTtcbiAgICBjb25zdCBleGlzdGluZyA9IG9wZW4uZmluZCgodCkgPT4gdHlwZW9mIHQuaWQgPT09ICdudW1iZXInICYmIHQuc3RhdHVzID09PSAnY29tcGxldGUnKVxuICAgICAgICA/PyBvcGVuLmZpbmQoKHQpID0+IHR5cGVvZiB0LmlkID09PSAnbnVtYmVyJyk7XG4gICAgaWYgKGV4aXN0aW5nPy5pZCAhPT0gdW5kZWZpbmVkKSByZXR1cm4geyB0YWJJZDogZXhpc3RpbmcuaWQsIHRlbXBvcmFyeTogZmFsc2UgfTtcblxuICAgIGNvbnN0IHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLmNyZWF0ZSh7IHVybDogQ09NRUVOX1VSTCwgYWN0aXZlOiBmYWxzZSB9KTtcbiAgICBpZiAodGFiLmlkID09PSB1bmRlZmluZWQpIHRocm93IG5ldyBFcnJvcignQ291bGQgbm90IG9wZW4gYSBDb21lZW4gdGFiLicpO1xuICAgIGF3YWl0IHdhaXRGb3JMb2FkKHRhYi5pZCk7XG5cbiAgICAvLyBBbiBleHBpcmVkIHNlc3Npb24gcmVkaXJlY3RzIG15LmNvbWVlbi5pbyB0byBhY2NvdW50cy5jb21lZW4uaW8sIHdoaWNoIGlzXG4gICAgLy8gZGVsaWJlcmF0ZWx5IG5vdCBpbiBob3N0X3Blcm1pc3Npb25zIFx1MjAxNCBzbyBleGVjdXRlU2NyaXB0IHdvdWxkIGZhaWwgdGhlcmVcbiAgICAvLyB3aXRoIGEgcGVybWlzc2lvbnMgZXJyb3IgdGhhdCBzYXlzIG5vdGhpbmcgYWJvdXQgdGhlIGFjdHVhbCBwcm9ibGVtLlxuICAgIC8vIENoZWNraW5nIHRoZSBVUkwgdHVybnMgdGhhdCBpbnRvIGEgc2VudGVuY2Ugd29ydGggcmVhZGluZy5cbiAgICBjb25zdCBsb2FkZWQgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQodGFiLmlkKTtcbiAgICBpZiAobG9hZGVkLnVybCAmJiAhbG9hZGVkLnVybC5zdGFydHNXaXRoKENPTUVFTl9VUkwpKSB7XG4gICAgICAgIHRocm93IG5ldyBTaWduZWRPdXRFcnJvcihcbiAgICAgICAgICAgICdOb3Qgc2lnbmVkIGluIHRvIENvbWVlbiAodGhlIHBhZ2UgcmVkaXJlY3RlZCB0byBzaWduLWluKS4gJ1xuICAgICAgICAgICAgKyAnT3BlbiBodHRwczovL215LmNvbWVlbi5pby8sIHNpZ24gaW4sIHRoZW4gcnVuIGFnYWluLicsXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgdGFiSWQ6IHRhYi5pZCwgdGVtcG9yYXJ5OiB0cnVlIH07XG59XG5cbmZ1bmN0aW9uIHdhaXRGb3JMb2FkKHRhYklkOiBudW1iZXIsIHRpbWVvdXRNcyA9IDMwXzAwMCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICBjaHJvbWUudGFicy5vblVwZGF0ZWQucmVtb3ZlTGlzdGVuZXIobGlzdGVuZXIpO1xuICAgICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcignQ29tZWVuIHRhYiBkaWQgbm90IGZpbmlzaCBsb2FkaW5nIGluIHRpbWUuJykpO1xuICAgICAgICB9LCB0aW1lb3V0TXMpO1xuXG4gICAgICAgIGNvbnN0IGxpc3RlbmVyID0gKGlkOiBudW1iZXIsIGluZm86IGNocm9tZS50YWJzLlRhYkNoYW5nZUluZm8pOiB2b2lkID0+IHtcbiAgICAgICAgICAgIGlmIChpZCAhPT0gdGFiSWQgfHwgaW5mby5zdGF0dXMgIT09ICdjb21wbGV0ZScpIHJldHVybjtcbiAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgICAgICBjaHJvbWUudGFicy5vblVwZGF0ZWQucmVtb3ZlTGlzdGVuZXIobGlzdGVuZXIpO1xuICAgICAgICAgICAgLy8gVGhlIFNQQSBuZWVkcyBhIG1vbWVudCBhZnRlciBgY29tcGxldGVgIGJlZm9yZSBpdHMgYXV0aCBzdGF0ZSBpcyByZWFkeS5cbiAgICAgICAgICAgIHNldFRpbWVvdXQocmVzb2x2ZSwgMl81MDApO1xuICAgICAgICB9O1xuICAgICAgICBjaHJvbWUudGFicy5vblVwZGF0ZWQuYWRkTGlzdGVuZXIobGlzdGVuZXIpO1xuICAgIH0pO1xufVxuXG5sZXQgaW5GbGlnaHQ6IFByb21pc2U8UnVuTG9nPiB8IHVuZGVmaW5lZDtcblxuLyoqXG4gKiBPbmUgcnVuIGF0IGEgdGltZS4gVHdvIG92ZXJsYXBwaW5nIHJ1bnMgd291bGQgZWFjaCByZWFkIHRoZSBib29raW5ncyBsaXN0XG4gKiBiZWZvcmUgdGhlIG90aGVyIGhhZCB3cml0dGVuIGFueXRoaW5nLCBzbyBib3RoIHdvdWxkIGRlY2lkZSB0aGUgc2FtZSBkYXkgd2FzXG4gKiBmcmVlIGFuZCBib3RoIHdvdWxkIHRyeSB0byBib29rIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcnVuQm9va2luZyhkcnlSdW46IGJvb2xlYW4pOiBQcm9taXNlPFJ1bkxvZz4ge1xuICAgIGlmIChpbkZsaWdodCkgcmV0dXJuIGluRmxpZ2h0O1xuICAgIGluRmxpZ2h0ID0gcnVuQm9va2luZ09uY2UoZHJ5UnVuKS5maW5hbGx5KCgpID0+IHsgaW5GbGlnaHQgPSB1bmRlZmluZWQ7IH0pO1xuICAgIHJldHVybiBpbkZsaWdodDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuQm9va2luZ09uY2UoZHJ5UnVuOiBib29sZWFuKTogUHJvbWlzZTxSdW5Mb2c+IHtcbiAgICBjb25zdCBzZXR0aW5nczogU2V0dGluZ3MgPSBhd2FpdCBsb2FkU2V0dGluZ3MoKTtcblxuICAgIGNvbnN0IGRhdGVzID0gZGF0ZXNUb0Jvb2soe1xuICAgICAgICB3ZWVrZGF5czogc2V0dGluZ3Mud2Vla2RheXMsXG4gICAgICAgIGhvcml6b25EYXlzOiBzZXR0aW5ncy5ob3Jpem9uRGF5cyxcbiAgICAgICAgc2tpcERhdGVzOiBzZXR0aW5ncy5za2lwRGF0ZXMsXG4gICAgICAgIHRpbWVab25lOiBzZXR0aW5ncy50aW1lWm9uZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGJhc2U6IFJ1bkxvZyA9IHsgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgZHJ5UnVuLCBkYXRlcywgcm93czogW10sIG5vdGVzOiBbXSB9O1xuXG4gICAgaWYgKGRhdGVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBjb25zdCBlbnRyeSA9IHsgLi4uYmFzZSwgbm90ZXM6IFsnTm8gY2FuZGlkYXRlIGRhdGVzIGluIHRoZSBob3Jpem9uLiddIH07XG4gICAgICAgIGF3YWl0IGFwcGVuZExvZyhlbnRyeSk7XG4gICAgICAgIGF3YWl0IHJlZmxlY3RSdW4oZW50cnkpO1xuICAgICAgICByZXR1cm4gZW50cnk7XG4gICAgfVxuXG4gICAgaWYgKCFzZXR0aW5ncy5kZXNrTmFtZSAmJiAhc2V0dGluZ3MuZGVza0lkKSB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0geyAuLi5iYXNlLCBlcnJvcjogJ1BpY2sgeW91ciBkZXNrIGluIHRoZSBwb3B1cCBmaXJzdCAodGhlIG51bWJlciBvbiBpdCwgbGlrZSAzLTIzKS4nIH07XG4gICAgICAgIGF3YWl0IGFwcGVuZExvZyhlbnRyeSk7XG4gICAgICAgIGF3YWl0IHJlZmxlY3RSdW4oZW50cnkpO1xuICAgICAgICByZXR1cm4gZW50cnk7XG4gICAgfVxuXG4gICAgLy8gVGhlIHBvcHVwIGdhdGVzIGl0cyBvd24gYnV0dG9ucyBvbiB0aGlzLCBidXQgYW4gYXV0b21hdGljIHJ1biByZWFkc1xuICAgIC8vIHN0cmFpZ2h0IGZyb20gc3RvcmFnZSBcdTIwMTQgd2hpY2ggY291bGQgaG9sZCBhIGJhZCB2YWx1ZSBzYXZlZCBieSBhbiBvbGRlclxuICAgIC8vIGJ1aWxkLCBvciBlZGl0ZWQgYnkgaGFuZC4gQ2hlY2tpbmcgaGVyZSBpcyB3aGF0IG1ha2VzIHRoZSBydWxlIHJlYWwuXG4gICAgaWYgKHNldHRpbmdzLmRlc2tOYW1lICYmICFpc1ZhbGlkRGVza05hbWUoc2V0dGluZ3MuZGVza05hbWUpKSB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0ge1xuICAgICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICAgIGVycm9yOiBgXCIke3NldHRpbmdzLmRlc2tOYW1lfVwiIGlzIG5vdCBhIGRlc2sgbnVtYmVyLiBJdCBzaG91bGQgYmUgZGlnaXRzLCBhIGRhc2gsIGBcbiAgICAgICAgICAgICAgICArICdkaWdpdHMgXHUyMDE0IGxpa2UgMy0yMy4nLFxuICAgICAgICB9O1xuICAgICAgICBhd2FpdCBhcHBlbmRMb2coZW50cnkpO1xuICAgICAgICBhd2FpdCByZWZsZWN0UnVuKGVudHJ5KTtcbiAgICAgICAgcmV0dXJuIGVudHJ5O1xuICAgIH1cblxuICAgIGxldCB0ZW1wb3JhcnkgPSBmYWxzZTtcbiAgICBsZXQgdGFiSWQ6IG51bWJlciB8IHVuZGVmaW5lZDtcblxuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHRhYiA9IGF3YWl0IGdldENvbWVlblRhYigpO1xuICAgICAgICB0YWJJZCA9IHRhYi50YWJJZDtcbiAgICAgICAgdGVtcG9yYXJ5ID0gdGFiLnRlbXBvcmFyeTtcblxuICAgICAgICBjb25zdCBbcmVzdWx0XSA9IGF3YWl0IGNocm9tZS5zY3JpcHRpbmcuZXhlY3V0ZVNjcmlwdCh7XG4gICAgICAgICAgICB0YXJnZXQ6IHsgdGFiSWQgfSxcbiAgICAgICAgICAgIHdvcmxkOiAnTUFJTicsXG4gICAgICAgICAgICBmdW5jOiBib29rSW5QYWdlLFxuICAgICAgICAgICAgYXJnczogW3tcbiAgICAgICAgICAgICAgICBlbmRwb2ludDogc2V0dGluZ3MuZW5kcG9pbnQsXG4gICAgICAgICAgICAgICAgZGF0ZXMsXG4gICAgICAgICAgICAgICAgZGVza05hbWU6IHNldHRpbmdzLmRlc2tOYW1lLFxuICAgICAgICAgICAgICAgIGRlc2tJZDogc2V0dGluZ3MuZGVza0lkLFxuICAgICAgICAgICAgICAgIHNsb3Q6IHNldHRpbmdzLnNsb3QsXG4gICAgICAgICAgICAgICAgLy8gUmVzb2x2ZWQgb3V0IGhlcmUgc28gdGhlIHNsb3QtdG8tdGltZXMgdGFibGUgc3RheXMgdGVzdGFibGVcbiAgICAgICAgICAgICAgICAvLyBpbnN0ZWFkIG9mIGJlaW5nIGlubGluZWQgaW50byB0aGUgc2VyaWFsaXplZCBwYWdlIGZ1bmN0aW9uLlxuICAgICAgICAgICAgICAgIHN0YXJ0VGltZTogU0xPVF9USU1FU1tzZXR0aW5ncy5zbG90XS5zdGFydCxcbiAgICAgICAgICAgICAgICBlbmRUaW1lOiBTTE9UX1RJTUVTW3NldHRpbmdzLnNsb3RdLmVuZCxcbiAgICAgICAgICAgICAgICBmbG9vcklkOiBzZXR0aW5ncy5mbG9vcklkLFxuICAgICAgICAgICAgICAgIGJ1aWxkaW5nSWQ6IHNldHRpbmdzLmJ1aWxkaW5nSWQsXG4gICAgICAgICAgICAgICAgZHJ5UnVuLFxuICAgICAgICAgICAgfV0sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVzdWx0Py5yZXN1bHQgYXMgSW5QYWdlUmVzdWx0IHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIC8vIENhY2hlIHRoZSBsb29rZWQtdXAgaWQgc28gdGhlIG5leHQgcnVuIHNraXBzIHRoZSBzZWFyY2ggZW50aXJlbHkuXG4gICAgICAgIGlmICh2YWx1ZT8ucmVzb2x2ZWREZXNrSWQgJiYgdmFsdWUucmVzb2x2ZWREZXNrSWQgIT09IHNldHRpbmdzLmRlc2tJZCkge1xuICAgICAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKHsgLi4uc2V0dGluZ3MsIGRlc2tJZDogdmFsdWUucmVzb2x2ZWREZXNrSWQgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBlbnRyeTogUnVuTG9nID0ge1xuICAgICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICAgIHJvd3M6IHZhbHVlPy5yb3dzID8/IFtdLFxuICAgICAgICAgICAgbm90ZXM6IHZhbHVlPy5ub3RlcyA/PyBbJ1RoZSBpbi1wYWdlIHNjcmlwdCByZXR1cm5lZCBub3RoaW5nLiddLFxuICAgICAgICAgICAgc2lnbmVkT3V0OiB2YWx1ZT8uc2lnbmVkT3V0ID09PSB0cnVlLFxuICAgICAgICB9O1xuICAgICAgICBhd2FpdCBhcHBlbmRMb2coZW50cnkpO1xuICAgICAgICBhd2FpdCByZWZsZWN0UnVuKGVudHJ5KTtcbiAgICAgICAgcmV0dXJuIGVudHJ5O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBlbnRyeTogUnVuTG9nID0ge1xuICAgICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgICAgICBzaWduZWRPdXQ6IGVyciBpbnN0YW5jZW9mIFNpZ25lZE91dEVycm9yLFxuICAgICAgICB9O1xuICAgICAgICBhd2FpdCBhcHBlbmRMb2coZW50cnkpO1xuICAgICAgICBhd2FpdCByZWZsZWN0UnVuKGVudHJ5KTtcbiAgICAgICAgcmV0dXJuIGVudHJ5O1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIC8vIE9ubHkgY2xvc2Ugd2hhdCB3ZSBvcGVuZWQuIE5ldmVyIGNsb3NlIGEgdGFiIHRoZSB1c2VyIHdhcyB1c2luZy5cbiAgICAgICAgaWYgKHRlbXBvcmFyeSAmJiB0YWJJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICB0cnkgeyBhd2FpdCBjaHJvbWUudGFicy5yZW1vdmUodGFiSWQpOyB9IGNhdGNoIHsgLyogYWxyZWFkeSBnb25lICovIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiBTaG93IHRoZSBvdXRjb21lIG9mIGEgcnVuIHNvbWV3aGVyZSB0aGUgdXNlciB3aWxsIGFjdHVhbGx5IHNlZSBpdC5cbiAqXG4gKiBFdmVyeXRoaW5nIGJlZm9yZSB0aGlzIHdhcyB3cml0dGVuIGludG8gY2hyb21lLnN0b3JhZ2UgYW5kIHJlbmRlcmVkIG9ubHkgaWZcbiAqIHlvdSBvcGVuZWQgdGhlIHBvcHVwIFx1MjAxNCBzbyBhbiBhdXRvbWF0aWMgcnVuIHRoYXQgZmFpbGVkIGF0IDNhbSB3YXMsIGluXG4gKiBwcmFjdGljZSwgc2lsZW50LiBBbiBhdXRvbWF0aW9uIHlvdSBjYW5ub3QgdGVsbCBoYXMgc3RvcHBlZCBpcyB3b3JzZSB0aGFuIG5vXG4gKiBhdXRvbWF0aW9uLCBiZWNhdXNlIHlvdSBzdG9wIGNoZWNraW5nLlxuICpcbiAqIFRoZSBiYWRnZSBtZWFucyBcInRoZXJlIGlzIGEgZmFpbHVyZSB5b3UgaGF2ZSBub3QgcmVhZCB5ZXRcIiwgbm90IFwidGhlIGxhc3QgcnVuXG4gKiBmYWlsZWRcIi4gVGhlIGRpZmZlcmVuY2UgbWF0dGVyczogcmVhZCBhcyB0aGUgbGF0dGVyLCBhIGJhZGdlIHJhaXNlZCBieSBhXG4gKiBzaWduZWQtb3V0IHJ1biBzdGF5ZWQgbGl0IGFmdGVyIHlvdSBzaWduZWQgaW4gYW5kIHByZXZpZXdlZCBzdWNjZXNzZnVsbHksXG4gKiB3aXRoIG5vIHdheSB0byBkaXNtaXNzIGl0LCBiZWNhdXNlIG9ubHkgYSBzdWNjZXNzZnVsIHJlYWwgcnVuIGNsZWFyZWQgaXQuXG4gKiBBdXRvbWF0aWMgc3dpdGNoZWQgb2ZmLCBhbmQgaXQgc3RheWVkIGxpdCBmb3IgZ29vZC4gT3BlbmluZyB0aGUgcG9wdXAgaXMgd2hhdFxuICogbWFya3MgaXQgcmVhZCBcdTIwMTQgc2VlIGNsZWFyRmFpbHVyZUJhZGdlLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWZsZWN0UnVuKGVudHJ5OiBSdW5Mb2cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBmYWlsZWQgPSBCb29sZWFuKGVudHJ5LmVycm9yKSB8fCBlbnRyeS5yb3dzLnNvbWUoKHJvdykgPT4gcm93LnN0YXR1cyA9PT0gJ2Vycm9yJyk7XG5cbiAgICAvLyBBIHByZXZpZXcgY2Fubm90IGV4ZXJjaXNlIHRoZSBjcmVhdGUgY2FsbCwgc28gYSBjbGVhbiBvbmUgaXMgbm90IHByb29mXG4gICAgLy8gdGhhdCBib29raW5nIHdvcmtzIGFuZCBtdXN0IG5vdCBjbGVhciBhIHJlYWwgZmFpbHVyZS4gSXQgY2FuIHN0aWxsIHJhaXNlXG4gICAgLy8gdGhlIGJhZGdlOiB3aGF0ZXZlciBpdCBoaXQgXHUyMDE0IHNpZ25lZCBvdXQsIGJhZCBkZXNrLCBBUEkgZG93biBcdTIwMTQgaXMgcmVhbC5cbiAgICBpZiAoZW50cnkuZHJ5UnVuICYmICFmYWlsZWQpIHJldHVybjtcblxuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VUZXh0KHsgdGV4dDogZmFpbGVkID8gJyEnIDogJycgfSk7XG4gICAgaWYgKGZhaWxlZCkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEJhZGdlQmFja2dyb3VuZENvbG9yKHsgY29sb3I6ICcjYjkxYzFjJyB9KTtcbiAgICB9XG5cbiAgICBpZiAoZW50cnkuc2lnbmVkT3V0KSB7XG4gICAgICAgIC8vIEZpeGVkIGlkLCBzbyBhIHNlc3Npb24gdGhhdCBzdGF5cyBleHBpcmVkIGFjcm9zcyBzZXZlcmFsIHJ1bnNcbiAgICAgICAgLy8gcmVwbGFjZXMgaXRzIG93biBub3RpZmljYXRpb24gaW5zdGVhZCBvZiBzdGFja2luZyB1cC5cbiAgICAgICAgY2hyb21lLm5vdGlmaWNhdGlvbnMuY3JlYXRlKFNJR05FRF9PVVRfTk9USUZJQ0FUSU9OLCB7XG4gICAgICAgICAgICB0eXBlOiAnYmFzaWMnLFxuICAgICAgICAgICAgaWNvblVybDogY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdpY29uLTEyOC5wbmcnKSxcbiAgICAgICAgICAgIHRpdGxlOiAnQ29tZWVuIGRlc2sgYm9va2VyJyxcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdZb3VyIENvbWVlbiBzZXNzaW9uIGV4cGlyZWQuIENsaWNrIGhlcmUgdG8gc2lnbiBpbiBcdTIwMTQgYm9va2luZyByZXN1bWVzIG9uICdcbiAgICAgICAgICAgICAgICArICdpdHMgb3duIG9uY2UgeW91IGFyZSBiYWNrLicsXG4gICAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAoIWVudHJ5LmRyeVJ1bikge1xuICAgICAgICBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihTSUdORURfT1VUX05PVElGSUNBVElPTik7XG4gICAgfVxufVxuXG4vKipcbiAqIE1hcmsgdGhlIGZhaWx1cmUgYXMgcmVhZC4gQ2FsbGVkIHdoZW4gdGhlIHBvcHVwIG9wZW5zLCBiZWNhdXNlIHRoYXQgaXMgd2hlcmVcbiAqIHRoZSBkZXRhaWwgbGl2ZXM6IGlmIHlvdSBoYXZlIGxvb2tlZCBhdCBMYXN0IHJ1biwgeW91IGtub3cuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNsZWFyRmFpbHVyZUJhZGdlKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VUZXh0KHsgdGV4dDogJycgfSk7XG59XG5cbi8qKlxuICogU2lnbmluZyBiYWNrIGluIGlzIHRoZSBmaXgsIHNvIG5vdGljaW5nIHRoYXQgeW91IGhhdmUgaXMgdGhlIHdob2xlIGZlYXR1cmU6XG4gKiB0aGUgbmV4dCB0aW1lIGEgQ29tZWVuIHBhZ2UgZmluaXNoZXMgbG9hZGluZyBhZnRlciBhIHNpZ25lZC1vdXQgZmFpbHVyZSwgdGhlXG4gKiBtaXNzZWQgcnVuIGhhcHBlbnMgYnkgaXRzZWxmLiBObyBidXR0b24gdG8gZmluZCwgbm8gbm90aWZpY2F0aW9uIHRvIGFjdCBvbi5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmV0cnlBZnRlclNpZ25JbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IHJ1bnMgPSBbXSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdydW5zJykgYXMgeyBydW5zPzogUnVuTG9nW10gfTtcbiAgICBpZiAocnVuc1swXT8uc2lnbmVkT3V0ICE9PSB0cnVlKSByZXR1cm47XG5cbiAgICAvLyBPbmx5IHRoZSBhdXRvbWF0aWMgcGF0aCBzZWxmLWhlYWxzLiBJZiBhdXRvbWF0aWMgaXMgb2ZmLCBldmVyeSBydW4gaXNcbiAgICAvLyBzb21ldGhpbmcgdGhlIHVzZXIgYXNrZWQgZm9yLCBhbmQgYSBzdXJwcmlzZSBib29raW5nIHdvdWxkIG5vdCBiZS5cbiAgICBjb25zdCBzZXR0aW5ncyA9IGF3YWl0IGxvYWRTZXR0aW5ncygpO1xuICAgIGlmICghc2V0dGluZ3MuZW5hYmxlZCkgcmV0dXJuO1xuXG4gICAgY29uc29sZS5pbmZvKCdbY29tZWVuXSBzaWduZWQgYmFjayBpbiBcdTIwMTQgcmV0cnlpbmcgdGhlIHJ1biB0aGF0IGZhaWxlZCcpO1xuICAgIGF3YWl0IHJ1bkJvb2tpbmcoZmFsc2UpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVBbGFybSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGNocm9tZS5hbGFybXMuZ2V0KEFMQVJNKTtcbiAgICBpZiAoZXhpc3RpbmcpIHJldHVybjtcbiAgICAvLyBFdmVyeSA2IGhvdXJzLiBUaGUgMTQtZGF5IGJvb2tpbmcgaG9yaXpvbiBtZWFucyBwcmVjaXNpb24gZG9lcyBub3QgbWF0dGVyOlxuICAgIC8vIGFueSBydW4gdG9wcyB0aGUgd2hvbGUgd2luZG93IGJhY2sgdXAsIHNvIGEgbWlzc2VkIGZpcmluZyBjb3N0cyBub3RoaW5nLlxuICAgIGF3YWl0IGNocm9tZS5hbGFybXMuY3JlYXRlKEFMQVJNLCB7IHBlcmlvZEluTWludXRlczogMzYwLCBkZWxheUluTWludXRlczogMSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuSWZFbmFibGVkKHJlYXNvbjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3Qgc2V0dGluZ3MgPSBhd2FpdCBsb2FkU2V0dGluZ3MoKTtcbiAgICBpZiAoIXNldHRpbmdzLmVuYWJsZWQpIHJldHVybjtcbiAgICBjb25zb2xlLmluZm8oYFtjb21lZW5dIHJ1bm5pbmcgKCR7cmVhc29ufSlgKTtcbiAgICBhd2FpdCBydW5Cb29raW5nKGZhbHNlKTtcbn1cblxuY2hyb21lLnJ1bnRpbWUub25JbnN0YWxsZWQuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICAgIHZvaWQgZW5zdXJlQWxhcm0oKTtcbn0pO1xuXG4vLyBDaHJvbWUgd2FzIGp1c3Qgc3RhcnRlZDogY2F0Y2ggdXAgaW1tZWRpYXRlbHkgcmF0aGVyIHRoYW4gd2FpdGluZyBmb3IgdGhlIGFsYXJtLlxuY2hyb21lLnJ1bnRpbWUub25TdGFydHVwLmFkZExpc3RlbmVyKCgpID0+IHtcbiAgICB2b2lkIGVuc3VyZUFsYXJtKCk7XG4gICAgdm9pZCBydW5JZkVuYWJsZWQoJ2Jyb3dzZXIgc3RhcnR1cCcpO1xufSk7XG5cbmNocm9tZS5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcigoYWxhcm0pID0+IHtcbiAgICBpZiAoYWxhcm0ubmFtZSAhPT0gQUxBUk0pIHJldHVybjtcbiAgICB2b2lkIHJ1bklmRW5hYmxlZCgnYWxhcm0nKTtcbn0pO1xuXG5jaHJvbWUudGFicy5vblVwZGF0ZWQuYWRkTGlzdGVuZXIoKF90YWJJZCwgaW5mbywgdGFiKSA9PiB7XG4gICAgaWYgKGluZm8uc3RhdHVzICE9PSAnY29tcGxldGUnKSByZXR1cm47XG4gICAgaWYgKCF0YWIudXJsPy5zdGFydHNXaXRoKENPTUVFTl9VUkwpKSByZXR1cm47XG4gICAgdm9pZCByZXRyeUFmdGVyU2lnbkluKCk7XG59KTtcblxuY2hyb21lLm5vdGlmaWNhdGlvbnMub25DbGlja2VkLmFkZExpc3RlbmVyKChpZCkgPT4ge1xuICAgIGlmIChpZCAhPT0gU0lHTkVEX09VVF9OT1RJRklDQVRJT04pIHJldHVybjtcbiAgICB2b2lkIGNocm9tZS50YWJzLmNyZWF0ZSh7IHVybDogQ09NRUVOX1VSTCB9KTtcbiAgICBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihTSUdORURfT1VUX05PVElGSUNBVElPTik7XG59KTtcblxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlOiB7IHR5cGU/OiBzdHJpbmc7IGRyeVJ1bj86IGJvb2xlYW4gfSwgX3NlbmRlciwgcmVzcG9uZCkgPT4ge1xuICAgIGlmIChtZXNzYWdlPy50eXBlID09PSAncG9wdXAtb3BlbmVkJykge1xuICAgICAgICB2b2lkIGNsZWFyRmFpbHVyZUJhZGdlKCk7XG4gICAgICAgIHJlc3BvbmQoeyBvazogdHJ1ZSB9KTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ3J1bicpIHtcbiAgICAgICAgcnVuQm9va2luZyhtZXNzYWdlLmRyeVJ1biA/PyBmYWxzZSlcbiAgICAgICAgICAgIC50aGVuKChsb2cpID0+IHJlc3BvbmQoeyBvazogdHJ1ZSwgbG9nIH0pKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IHJlc3BvbmQoe1xuICAgICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICAgICAgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTsgLy8ga2VlcCB0aGUgY2hhbm5lbCBvcGVuIGZvciB0aGUgYXN5bmMgcmVzcG9uc2VcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBSUEsSUFBTSxnQkFBb0M7QUFBQSxFQUN0QztBQUFBLEVBQVU7QUFBQSxFQUFVO0FBQUEsRUFBVztBQUFBLEVBQWE7QUFBQSxFQUFZO0FBQUEsRUFBVTtBQUN0RTtBQUVBLFNBQVMsVUFBVSxPQUFpQztBQUNoRCxTQUFRLGNBQW9DLFNBQVMsS0FBSztBQUM5RDtBQUdPLFNBQVMsZUFBZSxNQUFZ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ZSxhQUFhLFFBQStCO0FBQ3ZELFFBQU0sV0FBVyxNQUFNLGFBQWE7QUFDcEMsTUFBSSxDQUFDLFNBQVMsUUFBUztBQUN2QixVQUFRLEtBQUsscUJBQXFCLE1BQU0sR0FBRztBQUMzQyxRQUFNLFdBQVcsS0FBSztBQUMxQjtBQUVBLE9BQU8sUUFBUSxZQUFZLFlBQVksTUFBTTtBQUN6QyxPQUFLLFlBQVk7QUFDckIsQ0FBQztBQUdELE9BQU8sUUFBUSxVQUFVLFlBQVksTUFBTTtBQUN2QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxhQUFhLGlCQUFpQjtBQUN2QyxDQUFDO0FBRUQsT0FBTyxPQUFPLFFBQVEsWUFBWSxDQUFDLFVBQVU7QUFDekMsTUFBSSxNQUFNLFNBQVMsTUFBTztBQUMxQixPQUFLLGFBQWEsT0FBTztBQUM3QixDQUFDO0FBRUQsT0FBTyxLQUFLLFVBQVUsWUFBWSxDQUFDLFFBQVEsTUFBTSxRQUFRO0FBQ3JELE1BQUksS0FBSyxXQUFXLFdBQVk7QUFDaEMsTUFBSSxDQUFDLElBQUksS0FBSyxXQUFXLFVBQVUsRUFBRztBQUN0QyxPQUFLLGlCQUFpQjtBQUMxQixDQUFDO0FBRUQsT0FBTyxjQUFjLFVBQVUsWUFBWSxDQUFDLE9BQU87QUFDL0MsTUFBSSxPQUFPLHdCQUF5QjtBQUNwQyxPQUFLLE9BQU8sS0FBSyxPQUFPLEVBQUUsS0FBSyxXQUFXLENBQUM7QUFDM0MsU0FBTyxjQUFjLE1BQU0sdUJBQXVCO0FBQ3RELENBQUM7QUFFRCxPQUFPLFFBQVEsVUFBVSxZQUFZLENBQUMsU0FBOEMsU0FBUyxZQUFZO0FBQ3JHLE1BQUksU0FBUyxTQUFTLGdCQUFnQjtBQUNsQyxTQUFLLGtCQUFrQjtBQUN2QixZQUFRLEVBQUUsSUFBSSxLQUFLLENBQUM7QUFDcEIsV0FBTztBQUFBLEVBQ1g7QUFDQSxNQUFJLFNBQVMsU0FBUyxPQUFPO0FBQ3pCLGVBQVcsUUFBUSxVQUFVLEtBQUssRUFDN0IsS0FBSyxDQUFDLFFBQVEsUUFBUSxFQUFFLElBQUksTUFBTSxJQUFJLENBQUMsQ0FBQyxFQUN4QyxNQUFNLENBQUMsUUFBaUIsUUFBUTtBQUFBLE1BQzdCLElBQUk7QUFBQSxNQUNKLE9BQU8sZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFBQSxJQUMxRCxDQUFDLENBQUM7QUFDTixXQUFPO0FBQUEsRUFDWDtBQUNBLFNBQU87QUFDWCxDQUFDOyIsCiAgIm5hbWVzIjogWyJzaWduZWRPdXQiXQp9Cg==
