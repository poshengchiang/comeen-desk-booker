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
  endpointVersion: 4,
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
  cancelDates: [],
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
    listBookingIdFields: ["id", "uuid"],
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
    },
    cancel: {
      method: "DELETE",
      // Note `/me/`, not `/users/{{userId}}/` as create uses, and the
      // numeric booking id rather than its uuid. Both confirmed from a
      // captured cancellation; neither is what you would have guessed
      // from the create call.
      path: "/v1/me/work_activity_schedule/{{bookingId}}"
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
  const cancelDates = args.cancelDates ?? [];
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
    // The window must span both what is being booked and what is being
    // cancelled: a booking marked for cancellation next month is invisible
    // to a list query that stops at the booking horizon.
    from: [...dates, ...cancelDates].sort()[0] ?? "",
    to: [...dates, ...cancelDates].sort().pop() ?? ""
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
  const bookingIds = /* @__PURE__ */ new Map();
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
            if (!Array.isArray(entries) || entries.length === 0) continue;
            const day = date.slice(0, 10);
            heldDates.add(day);
            const first = entries[0];
            if (first) {
              for (const field of endpoint.listBookingIdFields) {
                const value = first[field];
                if (value !== void 0 && value !== null) {
                  bookingIds.set(day, String(value));
                  break;
                }
              }
            }
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
              const day = value.slice(0, 10);
              heldDates.add(day);
              for (const idField of endpoint.listBookingIdFields) {
                const id = booking[idField];
                if (id !== void 0 && id !== null) {
                  bookingIds.set(day, String(id));
                  break;
                }
              }
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
  const cancelled = /* @__PURE__ */ new Set();
  for (const date of cancelDates) {
    if (!endpoint.cancel) {
      rows.push({ date, status: "error", detail: "no cancel endpoint configured" });
      continue;
    }
    const bookingId = bookingIds.get(date);
    if (!bookingId) {
      rows.push({ date, status: "skipped", detail: "nothing booked to cancel" });
      cancelled.add(date);
      continue;
    }
    if (dryRun) {
      rows.push({ date, status: "dry-run", detail: `would cancel booking ${bookingId}` });
      continue;
    }
    try {
      const res = await call(endpoint.cancel, { ...vars, date, bookingId });
      if (res.signedOut) {
        rows.push({ date, status: "error", detail: "not signed in" });
        notes.push("Signed out before cancelling. Sign in and run again.");
        signedOut = true;
        break;
      }
      if (res.ok || res.status === 404) {
        rows.push({ date, status: "cancelled", detail: res.status === 404 ? "already gone" : void 0 });
        cancelled.add(date);
      } else {
        rows.push({ date, status: "error", detail: `${res.status}: ${res.text.slice(0, 200)}` });
      }
    } catch (err) {
      rows.push({ date, status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const date of dates) {
    if (cancelDates.includes(date)) continue;
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
  return { rows, notes, resolvedDeskId, signedOut, cancelled: [...cancelled] };
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
        cancelDates: settings.cancelDates,
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
    const updates = {};
    if (value?.resolvedDeskId && value.resolvedDeskId !== settings.deskId) {
      updates.deskId = value.resolvedDeskId;
    }
    if (!dryRun && value?.cancelled?.length) {
      const done = new Set(value.cancelled);
      updates.cancelDates = settings.cancelDates.filter((date) => !done.has(date));
    }
    if (Object.keys(updates).length > 0) {
      await saveSettings({ ...settings, ...updates });
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvcmUvZGF0ZXMudHMiLCAiLi4vc3JjL2NvcmUvY29uZmlnLnRzIiwgIi4uL3NyYy9pbmplY3RlZC50cyIsICIuLi9zcmMvYmFja2dyb3VuZC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiZXhwb3J0IHR5cGUgV2Vla2RheSA9XG4gICAgfCAnbW9uZGF5JyB8ICd0dWVzZGF5JyB8ICd3ZWRuZXNkYXknXG4gICAgfCAndGh1cnNkYXknIHwgJ2ZyaWRheScgfCAnc2F0dXJkYXknIHwgJ3N1bmRheSc7XG5cbmNvbnN0IFdFRUtEQVlfTkFNRVM6IHJlYWRvbmx5IFdlZWtkYXlbXSA9IFtcbiAgICAnc3VuZGF5JywgJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknLCAnc2F0dXJkYXknLFxuXTtcblxuZnVuY3Rpb24gaXNXZWVrZGF5KHZhbHVlOiBzdHJpbmcpOiB2YWx1ZSBpcyBXZWVrZGF5IHtcbiAgICByZXR1cm4gKFdFRUtEQVlfTkFNRVMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKHZhbHVlKTtcbn1cblxuLyoqIEZvcm1hdCBhIERhdGUgYXMgWVlZWS1NTS1ERCBhcyBzZWVuIGluIGB0aW1lWm9uZWAuICovXG5leHBvcnQgZnVuY3Rpb24gdG9Mb2NhbElTT0RhdGUoZGF0ZTogRGF0ZSwgdGltZVpvbmU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1DQScsIHtcbiAgICAgICAgdGltZVpvbmUsIHllYXI6ICdudW1lcmljJywgbW9udGg6ICcyLWRpZ2l0JywgZGF5OiAnMi1kaWdpdCcsXG4gICAgfSkuZm9ybWF0KGRhdGUpO1xufVxuXG4vKiogV2Vla2RheSBuYW1lIG9mIGBkYXRlYCBhcyBzZWVuIGluIGB0aW1lWm9uZWAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYWxXZWVrZGF5KGRhdGU6IERhdGUsIHRpbWVab25lOiBzdHJpbmcpOiBXZWVrZGF5IHtcbiAgICBjb25zdCBuYW1lID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgeyB0aW1lWm9uZSwgd2Vla2RheTogJ2xvbmcnIH0pXG4gICAgICAgIC5mb3JtYXQoZGF0ZSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKCFpc1dlZWtkYXkobmFtZSkpIHRocm93IG5ldyBFcnJvcihgVW5leHBlY3RlZCB3ZWVrZGF5IGZyb20gSW50bDogXCIke25hbWV9XCJgKTtcbiAgICByZXR1cm4gbmFtZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEYXRlc1RvQm9va09wdGlvbnMge1xuICAgIHdlZWtkYXlzOiBzdHJpbmdbXTtcbiAgICBob3Jpem9uRGF5cz86IG51bWJlcjtcbiAgICBza2lwRGF0ZXM/OiBzdHJpbmdbXTtcbiAgICB0aW1lWm9uZT86IHN0cmluZztcbiAgICBub3c/OiBEYXRlO1xufVxuXG4vKipcbiAqIEV2ZXJ5IGRheSBmcm9tIHRvZGF5IChpbmNsdXNpdmUpIHVwIHRvIGBob3Jpem9uRGF5c2AgYWhlYWQgd2hvc2Ugd2Vla2RheSBpc1xuICogaW4gYHdlZWtkYXlzYCwgbWludXMgYHNraXBEYXRlc2AuXG4gKlxuICogVGhlIDE0LWRheSBkZWZhdWx0IGlzIHdoYXQgbWFrZXMgdW5yZWxpYWJsZSBzY2hlZHVsaW5nIGFjY2VwdGFibGU6IGVhY2ggcnVuXG4gKiB0b3BzIHRoZSB3aG9sZSB3aW5kb3cgYmFjayB1cCwgc28gbWlzc2luZyBhIGRheSAobGFwdG9wIHNodXQsIENocm9tZSBjbG9zZWQpXG4gKiBjb3N0cyBub3RoaW5nIGFzIGxvbmcgYXMgdGhlIGV4dGVuc2lvbiBydW5zIGFnYWluIGJlZm9yZSB0aGUgd2luZG93IGRyYWlucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRhdGVzVG9Cb29rKHtcbiAgICB3ZWVrZGF5cyxcbiAgICBob3Jpem9uRGF5cyA9IDE0LFxuICAgIHNraXBEYXRlcyA9IFtdLFxuICAgIHRpbWVab25lID0gJ0V1cm9wZS9QcmFndWUnLFxuICAgIG5vdyA9IG5ldyBEYXRlKCksXG59OiBEYXRlc1RvQm9va09wdGlvbnMpOiBzdHJpbmdbXSB7XG4gICAgY29uc3Qgd2FudGVkID0gbmV3IFNldDxXZWVrZGF5PigpO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIHdlZWtkYXlzKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSByYXcudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgaWYgKCFpc1dlZWtkYXkobmFtZSkpIHRocm93IG5ldyBFcnJvcihgTm90IGEgd2Vla2RheSBuYW1lOiBcIiR7cmF3fVwiYCk7XG4gICAgICAgIHdhbnRlZC5hZGQobmFtZSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoc2tpcERhdGVzKTtcbiAgICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG5cbiAgICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPD0gaG9yaXpvbkRheXM7IG9mZnNldCArPSAxKSB7XG4gICAgICAgIGNvbnN0IGRheSA9IG5ldyBEYXRlKG5vdy5nZXRUaW1lKCkgKyBvZmZzZXQgKiA4Nl80MDBfMDAwKTtcbiAgICAgICAgY29uc3QgaXNvID0gdG9Mb2NhbElTT0RhdGUoZGF5LCB0aW1lWm9uZSk7XG4gICAgICAgIGlmICghd2FudGVkLmhhcyhsb2NhbFdlZWtkYXkoZGF5LCB0aW1lWm9uZSkpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNraXAuaGFzKGlzbykpIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaChpc28pO1xuICAgIH1cblxuICAgIHJldHVybiBvdXQ7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBXZWVrZGF5IH0gZnJvbSAnLi9kYXRlcy5qcyc7XG5cbmV4cG9ydCB0eXBlIFNsb3QgPSAnYWxsX2RheScgfCAnbW9ybmluZycgfCAnYWZ0ZXJub29uJztcblxuLyoqXG4gKiBIb3cgdGhlIGluLXBhZ2UgY29kZSBzaG91bGQgYXV0aGVudGljYXRlLlxuICpcbiAqIGBjb29raWVgICAgICAgIC0ganVzdCBzZW5kIGNyZWRlbnRpYWxzIHdpdGggdGhlIHJlcXVlc3QuIENvcnJlY3QgaWYgQ29tZWVuXG4gKiAgICAgICAgICAgICAgICAgIGF1dGhlbnRpY2F0ZXMgd2l0aCBhIHNlc3Npb24gY29va2llLlxuICogYGxvY2FsU3RvcmFnZWAgLSByZWFkIGEgdG9rZW4gb3V0IG9mIHRoZSBwYWdlJ3Mgb3duIGxvY2FsU3RvcmFnZSBhbmQgcHV0IGl0XG4gKiAgICAgICAgICAgICAgICAgIGluIGEgaGVhZGVyLiBDb3JyZWN0IGlmIENvbWVlbiB1c2VzIGEgYmVhcmVyIHRva2VuLlxuICpcbiAqIEVpdGhlciB3YXkgdGhlIHZhbHVlIGlzIHJlYWQgaW5zaWRlIHRoZSBwYWdlIGFuZCB1c2VkIHRoZXJlLiBJdCBpcyBuZXZlclxuICogY29waWVkIGludG8gZXh0ZW5zaW9uIHN0b3JhZ2UsIG5ldmVyIHBlcnNpc3RlZCwgYW5kIG5ldmVyIGxlYXZlcyB0aGUgdGFiLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhDb25maWcge1xuICAgIG1vZGU6ICdjb29raWUnIHwgJ2xvY2FsU3RvcmFnZSc7XG4gICAgLyoqIGxvY2FsU3RvcmFnZSBrZXkgaG9sZGluZyB0aGUgdG9rZW4uICovXG4gICAgc3RvcmFnZUtleT86IHN0cmluZztcbiAgICAvKiogRG90dGVkIHBhdGggaW5zaWRlIHRoZSBwYXJzZWQgSlNPTiwgZS5nLiBgc3RzVG9rZW5NYW5hZ2VyLmFjY2Vzc1Rva2VuYCAqL1xuICAgIGpzb25QYXRoPzogc3RyaW5nO1xuICAgIC8qKiBIZWFkZXIgdG8gc2V0LCBkZWZhdWx0IGBhdXRob3JpemF0aW9uYCAqL1xuICAgIGhlYWRlcj86IHN0cmluZztcbiAgICAvKiogUHJlZml4IGJlZm9yZSB0aGUgdG9rZW4sIGRlZmF1bHQgYEJlYXJlciBgICovXG4gICAgcHJlZml4Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlcXVlc3RUZW1wbGF0ZSB7XG4gICAgbWV0aG9kOiAnR0VUJyB8ICdQT1NUJyB8ICdQVVQnIHwgJ0RFTEVURSc7XG4gICAgLyoqIFBhdGggYXBwZW5kZWQgdG8gYXBpQmFzZS4gTWF5IGNvbnRhaW4gcGxhY2Vob2xkZXJzLiAqL1xuICAgIHBhdGg6IHN0cmluZztcbiAgICBxdWVyeT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgYm9keT86IHVua25vd247XG59XG5cbi8qKlxuICogSG93IHRoZSBcIndoYXQgZG8gSSBhbHJlYWR5IGhvbGRcIiByZXNwb25zZSBpcyBsYWlkIG91dC5cbiAqXG4gKiBgYXJyYXlgICAgICAgICAtIGEgZmxhdCBsaXN0IG9mIGJvb2tpbmdzLCBlYWNoIGNhcnJ5aW5nIGl0cyBvd24gZGF0ZSBmaWVsZCxcbiAqICAgICAgICAgICAgICAgICAgcmVhZCB2aWEgYGxpc3REYXRlRmllbGRzYC5cbiAqIGBkYXRlS2V5ZWRNYXBgIC0gYW4gb2JqZWN0IGtleWVkIGJ5IGBZWVlZLU1NLUREYCB3aG9zZSB2YWx1ZXMgYXJlIHRoYXQgZGF5J3NcbiAqICAgICAgICAgICAgICAgICAgZW50cmllcy4gQ29tZWVuIHJldHVybnMgdGhpcyBvbmUuIFRoZSBkYXRlIGlzIHRoZSAqa2V5Kiwgbm90XG4gKiAgICAgICAgICAgICAgICAgIGEgZmllbGQsIHNvIG5vIGFtb3VudCBvZiBzbmlmZmluZyBmaWVsZCBuYW1lcyB3b3VsZCBmaW5kIGl0IFx1MjAxNFxuICogICAgICAgICAgICAgICAgICB3aGljaCBpcyBleGFjdGx5IHdoeSB0aGUgc2hhcGUgaXMgY29uZmlndXJhdGlvbiByYXRoZXIgdGhhblxuICogICAgICAgICAgICAgICAgICBzb21ldGhpbmcgdGhlIGluLXBhZ2UgY29kZSBndWVzc2VzLlxuICovXG5leHBvcnQgdHlwZSBMaXN0U2hhcGUgPSAnYXJyYXknIHwgJ2RhdGVLZXllZE1hcCc7XG5cbi8qKlxuICogVGhlIHdob2xlIEFQSSBjb250cmFjdCBsaXZlcyBoZXJlIGFzIGRhdGEgc28gaXQgY2FuIGJlIGNvcnJlY3RlZCBmcm9tIHRoZVxuICogcG9wdXAgd2l0aG91dCByZWJ1aWxkaW5nLiBQbGFjZWhvbGRlcnMgYXZhaWxhYmxlIHRvIHBhdGhzLCBxdWVyaWVzIGFuZFxuICogYm9kaWVzOiB7e2RhdGV9fSwge3tkZXNrSWR9fSwge3tkZXNrTmFtZX19LCB7e3Nsb3R9fSwge3tzdGFydFRpbWV9fSxcbiAqIHt7ZW5kVGltZX19LCB7e2Zyb219fSwge3t0b319LCB7e3VzZXJJZH19LCB7e2Zsb29ySWR9fSwge3tidWlsZGluZ0lkfX0sXG4gKiB7e2FyZWFJZH19LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEVuZHBvaW50Q29uZmlnIHtcbiAgICBhcGlCYXNlOiBzdHJpbmc7XG4gICAgYXV0aDogQXV0aENvbmZpZztcbiAgICAvKipcbiAgICAgKiBMb29rIGEgZGVzayB1cCBieSBpdHMgaHVtYW4gbmFtZSBzbyBub2JvZHkgaGFzIHRvIGtub3cgaXRzIGludGVybmFsIGlkLlxuICAgICAqIFNldCB0byBudWxsIG9ubHkgaWYgeW91ciBDb21lZW4gaGFzIG5vIGRlc2stc2VhcmNoIGVuZHBvaW50LlxuICAgICAqL1xuICAgIHJlc29sdmU6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqIEZpZWxkIG5hbWVzIHRoYXQgbWlnaHQgaG9sZCBhIGRlc2sncyBodW1hbiBsYWJlbCBpbiBhIHNlYXJjaCByZXN1bHQuICovXG4gICAgZGVza05hbWVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKiBGaWVsZCBuYW1lcyB0aGF0IG1pZ2h0IGhvbGQgYSBkZXNrJ3MgaW50ZXJuYWwgaWQuIENvbWVlbiB1c2VzIGB1dWlkYC4gKi9cbiAgICBkZXNrSWRGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIEZpZWxkIG9uIGEgZGVzayByZWNvcmQgaG9sZGluZyB0aGF0IGRlc2sncyBvd24gYm9va2luZ3MgZm9yIHRoZSBxdWVyaWVkXG4gICAgICogd2luZG93LiBVc2VkIHRvIHRlbGwgeW91IGEgZGF5IGlzIGFscmVhZHkgdGFrZW4gKmJlZm9yZSogeW91IHByZXNzIEJvb2tcbiAgICAgKiBub3cuIFNldCB0byAnJyB0byBkaXNhYmxlLlxuICAgICAqL1xuICAgIGRlc2tTY2hlZHVsZUZpZWxkOiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogRGF0ZSBmaWVsZHMgdG8gcmVhZCBvZmYgb25lIG9mIHRob3NlIGVudHJpZXMsIGluIHByaW9yaXR5IG9yZGVyLCBmaXJzdFxuICAgICAqIG1hdGNoIHdpbnMuXG4gICAgICpcbiAgICAgKiBUaGUgb3JkZXIgbWF0dGVycyBtb3JlIHRoYW4gaXQgbG9va3M6IGFuIGVudHJ5IGFsbW9zdCBjZXJ0YWlubHkgYWxzb1xuICAgICAqIGNhcnJpZXMgY3JlYXRlZF9hdCBhbmQgdXBkYXRlZF9hdCwgd2hpY2ggYXJlIHdoZW4gdGhlIGJvb2tpbmcgd2FzIG1hZGUsXG4gICAgICogbm90IHRoZSBkYXkgYm9va2VkLiBMaXN0aW5nIG9ubHkgdGhlIGZpZWxkcyB0aGF0IG1lYW4gXCJ0aGUgZGF5IHRoaXMgaXNcbiAgICAgKiBmb3JcIiBpcyB3aGF0IHN0b3BzIGEgYm9va2luZyBtYWRlIHRocmVlIHdlZWtzIGFnbyBmcm9tIG1hcmtpbmcgdGhyZWVcbiAgICAgKiB3ZWVrcyBhZ28gYXMgdGFrZW4uXG4gICAgICovXG4gICAgZGVza1NjaGVkdWxlRGF0ZUZpZWxkczogc3RyaW5nW107XG4gICAgLyoqIFNldCB0byBudWxsIHRvIHNraXAgdGhlIFwid2hhdCBkbyBJIGFscmVhZHkgaGF2ZVwiIGNoZWNrLiAqL1xuICAgIGxpc3Q6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqIERvdHRlZCBwYXRoIHRvIHRoZSBjb250YWluZXIgaW5zaWRlIHRoZSBsaXN0IHJlc3BvbnNlLiAnJyBtZWFucyByb290LiAqL1xuICAgIGxpc3RSb290OiBzdHJpbmc7XG4gICAgbGlzdFNoYXBlOiBMaXN0U2hhcGU7XG4gICAgLyoqIE9ubHkgY29uc3VsdGVkIHdoZW4gbGlzdFNoYXBlIGlzICdhcnJheScuICovXG4gICAgbGlzdERhdGVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIERvdHRlZCBwYXRoIHRvIHRoZSBzaWduZWQtaW4gdXNlcidzIGlkIGluc2lkZSB0aGUgbGlzdCByZXNwb25zZS4gRW1wdHlcbiAgICAgKiBkaXNhYmxlcyB0aGUgbG9va3VwLCBhbmQge3t1c2VySWR9fSB0aGVuIHN0YXlzIHVuZmlsbGVkLlxuICAgICAqL1xuICAgIHVzZXJJZFBhdGg6IHN0cmluZztcbiAgICBjcmVhdGU6IFJlcXVlc3RUZW1wbGF0ZTtcbiAgICAvKipcbiAgICAgKiBDYW5jZWwgYSBib29raW5nLiBTZXQgdG8gbnVsbCB0byBkaXNhYmxlIGNhbmNlbGxpbmcgZW50aXJlbHkuXG4gICAgICpcbiAgICAgKiBUYWtlcyB7e2Jvb2tpbmdJZH19LCByZWFkIG9mZiB0aGUgbGlzdGVkIGJvb2tpbmcgdmlhIGxpc3RCb29raW5nSWRGaWVsZHMgXHUyMDE0XG4gICAgICogc28gY2FuY2VsbGluZyBkZXBlbmRzIG9uIGBsaXN0YCB3b3JraW5nLCB3aGljaCBpcyBjb3JyZWN0OiB5b3UgY2Fubm90XG4gICAgICogY2FuY2VsIHdoYXQgeW91IGhhdmUgbm90IGNvbmZpcm1lZCB5b3UgaG9sZC5cbiAgICAgKi9cbiAgICBjYW5jZWw6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqXG4gICAgICogRmllbGRzIG9uIGEgbGlzdGVkIGJvb2tpbmcgdGhhdCBpZGVudGlmeSBpdCBmb3IgY2FuY2VsbGF0aW9uLCBpbiBwcmlvcml0eVxuICAgICAqIG9yZGVyLiBDb21lZW4gd2FudHMgdGhlIG51bWVyaWMgYGlkYCBoZXJlLCBOT1QgdGhlIGB1dWlkYCB0aGF0IHRoZSBzYW1lXG4gICAgICogZW50cnkgYWxzbyBjYXJyaWVzIGFuZCB0aGF0IHRoZSBjcmVhdGUgYm9keSB1c2VzIGZvciB0aGUgZGVzay4gR2V0dGluZ1xuICAgICAqIHRoaXMgd3JvbmcgaXMgYSA0MDQgYXQgYmVzdC5cbiAgICAgKi9cbiAgICBsaXN0Qm9va2luZ0lkRmllbGRzOiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5ncyB7XG4gICAgLyoqXG4gICAgICogQnVtcGVkIGluIERFRkFVTFRfU0VUVElOR1Mgd2hlbmV2ZXIgdGhlIHNoaXBwZWQgZW5kcG9pbnQgY29uZmlnIGlzXG4gICAgICogY29ycmVjdGVkLiBTZWUgbWVyZ2VTZXR0aW5nczogYSBzdG9yZWQgY29uZmlnIG9sZGVyIHRoYW4gdGhlIHNoaXBwZWQgb25lXG4gICAgICogaXMgcmVwbGFjZWQgcmF0aGVyIHRoYW4gbWVyZ2VkLCB3aGljaCBpcyB3aGF0IGxldHMgYSBmaXggYWN0dWFsbHkgcmVhY2hcbiAgICAgKiBwZW9wbGUgd2hvIGhhdmUgYWxyZWFkeSBzYXZlZCBzZXR0aW5ncyBvbmNlLlxuICAgICAqL1xuICAgIGVuZHBvaW50VmVyc2lvbjogbnVtYmVyO1xuICAgIGVuYWJsZWQ6IGJvb2xlYW47XG4gICAgZGVza05hbWU6IHN0cmluZztcbiAgICBkZXNrSWQ6IHN0cmluZztcbiAgICAvKipcbiAgICAgKiBUaGUgZmxvb3IgdGhlIGRlc2sgaXMgb24uIFRoaXMgb25lIGNhbm5vdCBiZSBkZXJpdmVkOiByZXNvbHZpbmcgYSBkZXNrIGJ5XG4gICAgICogbmFtZSBtZWFucyBsaXN0aW5nIGEgZmxvb3IncyBkZXNrcywgc28gdGhlIGZsb29yIGhhcyB0byBiZSBrbm93biBmaXJzdC5cbiAgICAgKiBWaXNpYmxlIGluIHRoZSBVUkwgb2YgQ29tZWVuJ3MgZmxvb3IgcGxhbiwgYW5kIGluIGBmbG9vcl9pZGAgb24gYW55IGRlc2suXG4gICAgICovXG4gICAgZmxvb3JJZDogbnVtYmVyO1xuICAgIC8qKlxuICAgICAqIFRoZSBidWlsZGluZyB0aGUgZmxvb3IgaXMgaW4uIEFsc28gbm90IGRlcml2YWJsZSBcdTIwMTQgYSBkZXNrIHJlY29yZCBjYXJyaWVzXG4gICAgICogYGZsb29yX2lkYCBhbmQgYGFyZWFfaWRgIGJ1dCBubyBgYnVpbGRpbmdfaWRgLCBhbmQgdGhlIG9ubHkgZW5kcG9pbnQgdGhhdFxuICAgICAqIG1hcHMgb25lIHRvIHRoZSBvdGhlciBuZWVkcyBhIHNwYWNlIFVVSUQgd2UgbmV2ZXIgb3RoZXJ3aXNlIGZldGNoLlxuICAgICAqL1xuICAgIGJ1aWxkaW5nSWQ6IG51bWJlcjtcbiAgICB3ZWVrZGF5czogV2Vla2RheVtdO1xuICAgIHNsb3Q6IFNsb3Q7XG4gICAgaG9yaXpvbkRheXM6IG51bWJlcjtcbiAgICBza2lwRGF0ZXM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIERheXMgd2hvc2UgYm9va2luZyBzaG91bGQgYmUgY2FuY2VsbGVkIG9uIHRoZSBuZXh0IHJ1bi5cbiAgICAgKlxuICAgICAqIEEgb25lLXNob3QgaW5zdHJ1Y3Rpb24sIG5vdCBhIHByZWZlcmVuY2U6IGFuIGVudHJ5IGlzIHJlbW92ZWQgb25jZSB0aGVcbiAgICAgKiBjYW5jZWxsYXRpb24gc3VjY2VlZHMsIG9yIHRoZSBuZXh0IGF1dG9tYXRpYyBydW4gd291bGQga2VlcCB0cnlpbmcgdG9cbiAgICAgKiBkZWxldGUgc29tZXRoaW5nIGFscmVhZHkgZ29uZS4gQWRkaW5nIGEgZGF0ZSBoZXJlIGFsc28gYWRkcyBpdCB0b1xuICAgICAqIHNraXBEYXRlcyBcdTIwMTQgb3RoZXJ3aXNlIHRoZSBzYW1lIHJ1biB0aGF0IGNhbmNlbHMgaXQgYm9va3MgaXQgc3RyYWlnaHQgYmFjay5cbiAgICAgKi9cbiAgICBjYW5jZWxEYXRlczogc3RyaW5nW107XG4gICAgdGltZVpvbmU6IHN0cmluZztcbiAgICBlbmRwb2ludDogRW5kcG9pbnRDb25maWc7XG59XG5cbi8qKlxuICogQSBzbG90IGFzIHRoZSBuYWl2ZSBsb2NhbCB0aW1lcyBDb21lZW4gZXhwZWN0cy5cbiAqXG4gKiBDb21lZW4gc2VuZHMgZGF0ZXRpbWVzIGxpa2UgYDIwMjYtMDktMDFUMDA6MDA6MDAuMDAwWmAgYW5kIGVjaG9lcyB0aGVtIGJhY2tcbiAqIGFzIGAyMDI2LTA5LTAxVDAwOjAwOjAwYCBcdTIwMTQgYSBsb2NhbCB3YWxsLWNsb2NrIHRpbWUgd2VhcmluZyBhIGBaYC4gU28gdGhlIGRheVxuICogaXMgdXNlZCB2ZXJiYXRpbSBhbmQgbm8gdGltZXpvbmUgY29udmVyc2lvbiBoYXBwZW5zIGFueXdoZXJlIGluIHRoZSBib29raW5nXG4gKiBwYXRoLiBUaGUgZGF0ZSBsb2dpYyBpbiBkYXRlcy50cyBhbHJlYWR5IHByb2R1Y2VzIGV4YWN0bHkgdGhpcy5cbiAqXG4gKiBcdTI2QTBcdUZFMEYgT25seSBgYWxsX2RheWAgaXMgY29uZmlybWVkIGFnYWluc3QgYSByZWFsIGJvb2tpbmcuIFRoZSBoYWxmLWRheXMgYXJlIGFcbiAqIHJlYXNvbmFibGUgcmVhZGluZyBvZiB0aGUgc2FtZSBzY2hlbWUsIG5vdCBhbiBvYnNlcnZlZCBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBTTE9UX1RJTUVTOiBSZWNvcmQ8U2xvdCwgeyBzdGFydDogc3RyaW5nOyBlbmQ6IHN0cmluZyB9PiA9IHtcbiAgICBhbGxfZGF5OiB7IHN0YXJ0OiAnMDA6MDA6MDAuMDAwWicsIGVuZDogJzIzOjU5OjU5LjAwMFonIH0sXG4gICAgbW9ybmluZzogeyBzdGFydDogJzAwOjAwOjAwLjAwMFonLCBlbmQ6ICcxMjowMDowMC4wMDBaJyB9LFxuICAgIGFmdGVybm9vbjogeyBzdGFydDogJzEyOjAwOjAwLjAwMFonLCBlbmQ6ICcyMzo1OTo1OS4wMDBaJyB9LFxufTtcblxuLyoqXG4gKiBDb25maXJtZWQgYWdhaW5zdCBhIHJlYWwgc2lnbmVkLWluIHNlc3Npb24gaW4gQXVndXN0IDIwMjYsIGJ5IGNhcHR1cmluZyB0aGVcbiAqIHRyYWZmaWMgb2Ygb25lIGRlc2sgYm9va2luZyBtYWRlIGJ5IGhhbmQuXG4gKlxuICogTm90ZXMgd29ydGgga2VlcGluZywgYmVjYXVzZSBlYWNoIG9uZSBjb250cmFkaWN0cyBhIHJlYXNvbmFibGUgZ3Vlc3M6XG4gKiAgIC0gYGFwaUJhc2VgIGlzIG15LmNvbWVlbi5pby9hcGksIHRoZSBTUEEncyBvd24gb3JpZ2luLCBOT1QgYXBpLmNvbWVlbi5pb1xuICogICAgIHdoZXJlIHRoZSBwdWJsaWMgZG9jcyBsaXZlLiBJdCBpcyBhIFJhaWxzIGJhY2tlbmQgYmVoaW5kIGEgTnV4dCBmcm9udCBlbmQsXG4gKiAgICAgd2hpY2ggaXMgd2h5IHBhdGhzIGVuZCBpbiBgLmpzb25gLlxuICogICAtIFRoZSBBUEkgdmVyc2lvbiB2YXJpZXMgcGVyIGVuZHBvaW50ICgvdjEsIC92MiwgL3YyYmV0YSksIHNvIHRoZSB2ZXJzaW9uXG4gKiAgICAgYmVsb25ncyBpbiBlYWNoIHBhdGggcmF0aGVyIHRoYW4gaW4gYXBpQmFzZS5cbiAqICAgLSBBIGRlc2sncyBpZCBpcyBgdXVpZGAuIFRoZXJlIGlzIG5vIGBpZGAgZmllbGQgb24gYSBkZXNrIGF0IGFsbC5cbiAqICAgLSBUaGUgYm9va2luZ3MgbGlzdCBpcyBrZXllZCBieSBkYXRlOyB0aGUgZGF0ZSBpcyBub3QgYSBmaWVsZCBvbiBhbiBlbnRyeS5cbiAqICAgLSBBIGJvb2tpbmcgaXMgYSBcIndvcmsgYWN0aXZpdHlcIiB3aXRoIGEgZGVzayBhdHRhY2hlZCwgbm90IGEgZGVzayBib29raW5nXG4gKiAgICAgYXMgc3VjaC4gVGhhdCBpcyB3aHkgdGhlIHBhdGggc2F5cyB3b3JrX2FjdGl2aXR5X3NjaGVkdWxlLlxuICogICAtIEF1dGggaXMgdGhlIHNlc3Npb24gY29va2llLiBBIGZldGNoIGZyb20gdGhlIHBhZ2Ugd2l0aCBjcmVkZW50aWFsc1xuICogICAgIGluY2x1ZGVkIGFuZCBubyBBdXRob3JpemF0aW9uIGhlYWRlciByZXR1cm5zIDIwMCwgc28gdGhlcmUgaXMgbm8gdG9rZW4gdG9cbiAqICAgICByZWFkIGFuZCBub3RoaW5nIGZvciB0aGUgZXh0ZW5zaW9uIHRvIGhvbGQuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NFVFRJTkdTOiBTZXR0aW5ncyA9IHtcbiAgICAvLyBcdTJCMDYgQlVNUCBUSElTIHdoZW5ldmVyIHlvdSBjb3JyZWN0IHRoZSBgZW5kcG9pbnRgIGJsb2NrIGJlbG93LCBvdGhlcndpc2VcbiAgICAvLyBhbnlvbmUgd2hvIGFscmVhZHkgcHJlc3NlZCBTYXZlIGtlZXBzIHRoZWlyIHN0YWxlIGNvcHkgZm9yZXZlci5cbiAgICBlbmRwb2ludFZlcnNpb246IDQsXG4gICAgZW5hYmxlZDogZmFsc2UsXG4gICAgLy8gRW1wdHkgb24gcHVycG9zZS4gU2hpcHBpbmcgYSByZWFsIGRlc2sgbnVtYmVyIGFzIHRoZSBkZWZhdWx0IG1lYW5zIHRoZVxuICAgIC8vIGZpcnN0IHBlcnNvbiB0byBpbnN0YWxsIHRoaXMgYW5kIHByZXNzIEJvb2sgbm93IHRha2VzIHNvbWVib2R5IGVsc2Unc1xuICAgIC8vIHNlYXQsIGhhdmluZyBkb25lIG5vdGhpbmcgd3JvbmcuIE5vdGhpbmcgcnVucyB1bnRpbCBhIGRlc2sgaXMgY2hvc2VuLlxuICAgIGRlc2tOYW1lOiAnJyxcbiAgICBkZXNrSWQ6ICcnLFxuICAgIGZsb29ySWQ6IDQ5NTIsXG4gICAgYnVpbGRpbmdJZDogNTE1MSxcbiAgICB3ZWVrZGF5czogWydtb25kYXknLCAndHVlc2RheScsICd3ZWRuZXNkYXknLCAndGh1cnNkYXknLCAnZnJpZGF5J10sXG4gICAgc2xvdDogJ2FsbF9kYXknLFxuICAgIGhvcml6b25EYXlzOiAxNCxcbiAgICBza2lwRGF0ZXM6IFtdLFxuICAgIGNhbmNlbERhdGVzOiBbXSxcbiAgICB0aW1lWm9uZTogJ0V1cm9wZS9QcmFndWUnLFxuICAgIGVuZHBvaW50OiB7XG4gICAgICAgIGFwaUJhc2U6ICdodHRwczovL215LmNvbWVlbi5pby9hcGknLFxuICAgICAgICBhdXRoOiB7IG1vZGU6ICdjb29raWUnIH0sXG4gICAgICAgIHJlc29sdmU6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgICAgICBwYXRoOiAnL3YxL2Zsb29ycy97e2Zsb29ySWR9fS9kZXNrc19zY2hlZHVsZS5qc29uJyxcbiAgICAgICAgICAgIHF1ZXJ5OiB7XG4gICAgICAgICAgICAgICAgc3RhcnRfZGF0ZTogJ3t7ZnJvbX19VDAwOjAwOjAwLjAwMFonLFxuICAgICAgICAgICAgICAgIGVuZF9kYXRlOiAne3t0b319VDIzOjU5OjU5LjAwMFonLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgZGVza05hbWVGaWVsZHM6IFsnbmFtZScsICdzeW5jX2lkJ10sXG4gICAgICAgIGRlc2tJZEZpZWxkczogWyd1dWlkJywgJ2lkJ10sXG4gICAgICAgIGRlc2tTY2hlZHVsZUZpZWxkOiAnc2NoZWR1bGUnLFxuICAgICAgICBkZXNrU2NoZWR1bGVEYXRlRmllbGRzOiBbJ3N0YXJ0X2RhdGV0aW1lJywgJ3N0YXJ0X2RhdGUnLCAnZGF0ZScsICdkYXknLCAnc3RhcnQnXSxcbiAgICAgICAgbGlzdDoge1xuICAgICAgICAgICAgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgICAgIHBhdGg6ICcvdjEvdXNlcnMvbWUvd29ya19hY3Rpdml0eV9zY2hlZHVsZS5qc29uJyxcbiAgICAgICAgICAgIHF1ZXJ5OiB7XG4gICAgICAgICAgICAgICAgc3RhcnRfZGF0ZTogJ3t7ZnJvbX19VDAwOjAwOjAwLjAwMFonLFxuICAgICAgICAgICAgICAgIGVuZF9kYXRlOiAne3t0b319VDIzOjU5OjU5LjAwMFonLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgbGlzdFJvb3Q6ICdzY2hlZHVsZScsXG4gICAgICAgIGxpc3RTaGFwZTogJ2RhdGVLZXllZE1hcCcsXG4gICAgICAgIGxpc3REYXRlRmllbGRzOiBbJ3N0YXJ0X2RhdGV0aW1lJywgJ2RhdGUnXSxcbiAgICAgICAgdXNlcklkUGF0aDogJ3VzZXIuaWQnLFxuICAgICAgICBsaXN0Qm9va2luZ0lkRmllbGRzOiBbJ2lkJywgJ3V1aWQnXSxcbiAgICAgICAgY3JlYXRlOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICAgIC8vIFRoZSBgbWVgIGFsaWFzIHdvcmtzIGZvciByZWFkczsgdGhlIGFwcCBpdHNlbGYgdXNlcyB0aGUgbnVtZXJpY1xuICAgICAgICAgICAgLy8gaWQgdG8gd3JpdGUsIHNvIHRoYXQgaXMgd2hhdCBpcyB1c2VkIGhlcmUuXG4gICAgICAgICAgICBwYXRoOiAnL3YxL3VzZXJzL3t7dXNlcklkfX0vd29ya19hY3Rpdml0eV9zY2hlZHVsZS5qc29uJyxcbiAgICAgICAgICAgIGJvZHk6IHtcbiAgICAgICAgICAgICAgICB3b3JrX2FjdGl2aXR5OiB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXRlOiAnb25fc2l0ZScsXG4gICAgICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGV0aW1lOiAne3tkYXRlfX1Ue3tzdGFydFRpbWV9fScsXG4gICAgICAgICAgICAgICAgICAgIGVuZF9kYXRldGltZTogJ3t7ZGF0ZX19VHt7ZW5kVGltZX19JyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHByZXNlbmNlOiB7XG4gICAgICAgICAgICAgICAgICAgIGJ1aWxkaW5nX2lkOiAne3tidWlsZGluZ0lkfX0nLFxuICAgICAgICAgICAgICAgICAgICBmbG9vcl9pZDogJ3t7Zmxvb3JJZH19JyxcbiAgICAgICAgICAgICAgICAgICAgYXJlYV9pZDogJ3t7YXJlYUlkfX0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgZGVza19ib29raW5nOiB7IGRlc2tfdXVpZDogJ3t7ZGVza0lkfX0nIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBjYW5jZWw6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ0RFTEVURScsXG4gICAgICAgICAgICAvLyBOb3RlIGAvbWUvYCwgbm90IGAvdXNlcnMve3t1c2VySWR9fS9gIGFzIGNyZWF0ZSB1c2VzLCBhbmQgdGhlXG4gICAgICAgICAgICAvLyBudW1lcmljIGJvb2tpbmcgaWQgcmF0aGVyIHRoYW4gaXRzIHV1aWQuIEJvdGggY29uZmlybWVkIGZyb20gYVxuICAgICAgICAgICAgLy8gY2FwdHVyZWQgY2FuY2VsbGF0aW9uOyBuZWl0aGVyIGlzIHdoYXQgeW91IHdvdWxkIGhhdmUgZ3Vlc3NlZFxuICAgICAgICAgICAgLy8gZnJvbSB0aGUgY3JlYXRlIGNhbGwuXG4gICAgICAgICAgICBwYXRoOiAnL3YxL21lL3dvcmtfYWN0aXZpdHlfc2NoZWR1bGUve3tib29raW5nSWR9fScsXG4gICAgICAgIH0sXG4gICAgfSxcbn07XG5cbi8qKlxuICogVGhlIG9mZmljZSwgYXMgY2FwdHVyZWQgaW4gQXVndXN0IDIwMjYuXG4gKlxuICogSGFyZGNvZGVkIHJhdGhlciB0aGFuIGZldGNoZWQuIFRoZSBmbG9vciBkcm9wZG93biBoYXMgdG8gYmUgcG9wdWxhdGVkIGJlZm9yZVxuICogYW55IG5ldHdvcmsgY2FsbCBoYXBwZW5zLCBhbiBvZmZpY2UgbGF5b3V0IGNoYW5nZXMgYWJvdXQgbmV2ZXIsIGFuZCBhXG4gKiBoYXJkY29kZWQgZmxvb3IgdGhhdCBpcyB3cm9uZyBpcyBhIHZpc2libGUgbWlzdGFrZSByYXRoZXIgdGhhbiBhIHNpbGVudCBvbmUuXG4gKlxuICogVG8gYWRkIGEgZmxvb3IsIHJlYWQgdGhlIGlkcyBmcm9tIHRoZSByZXNwb25zZSBvZlxuICogL2FwaS92Mi9zcGFjZXMvPHNwYWNlLXV1aWQ+L2J1aWxkaW5ncy88YnVpbGRpbmctaWQ+L2Zsb29ycy5qc29uIHdpdGggdGhlXG4gKiBmbG9vciBwbGFuIG9wZW4uXG4gKi9cbmV4cG9ydCBjb25zdCBCVUlMRElORyA9IHsgaWQ6IDUxNTEsIG5hbWU6ICcxMDB5YXJkcycgfTtcblxuLyoqXG4gKiBBIGRlc2sgbmFtZSBpcyBkaWdpdHMsIGEgZGFzaCwgZGlnaXRzIFx1MjAxNCBgMy0yM2AsIGAxMi00YC5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgbm90IHRpZ2h0ZW5lZCB0byB0d28gemVyby1wYWRkZWQgZGlnaXRzLCB3aGljaCBpcyB3aGF0IHRoaXNcbiAqIG9mZmljZSBoYXBwZW5zIHRvIHVzZTogYSBmbG9vciAxMiBvciBhIGRlc2sgMTAwIHdvdWxkIHRoZW4gYmUgcmVqZWN0ZWQgZm9yXG4gKiBsb29raW5nIHdyb25nIHJhdGhlciB0aGFuIGZvciBiZWluZyB3cm9uZy4gV2hhdCB0aGlzIGNhdGNoZXMgaXMgdGhlIG1pc3Rha2VcbiAqIHBlb3BsZSBhY3R1YWxseSBtYWtlIFx1MjAxNCB0eXBpbmcgc29tZXRoaW5nIHRoYXQgaXMgbm90IGEgZGVzayBudW1iZXIgYXQgYWxsOiBhXG4gKiBuYW1lLCBhIHJvb20sIGEgc3RyYXkgc3BhY2UuXG4gKi9cbmV4cG9ydCBjb25zdCBERVNLX05BTUVfUEFUVEVSTiA9IC9eXFxkKy1cXGQrJC87XG5cbi8qKiBFbXB0eSBpcyBub3QgdmFsaWQsIGJ1dCBpdCBpcyBub3QgYW4gZXJyb3IgZWl0aGVyIFx1MjAxNCBzZWUgdGhlIHBvcHVwLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzVmFsaWREZXNrTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gREVTS19OQU1FX1BBVFRFUk4udGVzdChuYW1lLnRyaW0oKSk7XG59XG5cbi8qKlxuICogRHJvcCBza2lwIGRhdGVzIHRoYXQgaGF2ZSBhbHJlYWR5IHBhc3NlZC5cbiAqXG4gKiBEYXlzIGNhbiBiZSBtYXJrZWQgbW9udGhzIGFoZWFkLCBzbyB3aXRob3V0IHRoaXMgdGhlIGxpc3Qgb25seSBldmVyIGdyb3dzIFx1MjAxNFxuICogYSB5ZWFyIG9mIFwiSSB3YXMgYXdheSB0aGF0IFR1ZXNkYXlcIiBhY2N1bXVsYXRpbmcgaW4gc3RvcmFnZSBhbmQgaW4gdGhlXG4gKiBzZXR0aW5ncyBKU09OLCB3aGVyZSBpdCBpcyBub2lzZSB0aGF0IG1ha2VzIHRoZSByZWFsIGVudHJpZXMgaGFyZCB0byByZWFkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJ1bmVQYXN0U2tpcERhdGVzKHNraXBEYXRlczogc3RyaW5nW10sIHRvZGF5OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIHNraXBEYXRlcy5maWx0ZXIoKGRhdGUpID0+IGRhdGUgPj0gdG9kYXkpO1xufVxuXG5leHBvcnQgY29uc3QgRkxPT1JTOiB7IGlkOiBudW1iZXI7IGxhYmVsOiBzdHJpbmcgfVtdID0gW1xuICAgIHsgaWQ6IDQ5NTIsIGxhYmVsOiAnRmxvb3IgMycgfSxcbiAgICB7IGlkOiA0OTUzLCBsYWJlbDogJ0Zsb29yIDQnIH0sXG5dO1xuXG5leHBvcnQgdHlwZSBWYXJzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuLyoqXG4gKiBBIHBsYWNlaG9sZGVyIHRoYXQgbWFrZXMgdXAgdGhlICplbnRpcmUqIHZhbHVlIGFuZCByZXNvbHZlcyB0byBhbiBpbnRlZ2VyXG4gKiBiZWNvbWVzIGEgbnVtYmVyLlxuICpcbiAqIFRoaXMgbWF0dGVycyBiZWNhdXNlIEpTT04gZGlzdGluZ3Vpc2hlcyA1MTUxIGZyb20gXCI1MTUxXCIgYW5kIENvbWVlbidzXG4gKiBwcmVzZW5jZSBibG9jayB3YW50cyB0aGUgZm9ybWVyLiBQYXJ0aWFsIGludGVycG9sYXRpb24gXHUyMDE0IFwiL3VzZXJzL3t7dXNlcklkfX0veFwiXG4gKiBcdTIwMTQgYWx3YXlzIHlpZWxkcyBhIHN0cmluZywgd2hpY2ggaXMgd2hhdCBhIHBhdGggbmVlZHMsIHNvIHRoZSB0d28gY2FzZXMgbmV2ZXJcbiAqIGNvbGxpZGUuIEEgdXVpZCBvciBhIGRhdGUgY29udGFpbnMgbm9uLWRpZ2l0cyBhbmQgc3RheXMgYSBzdHJpbmcgZWl0aGVyIHdheS5cbiAqL1xuY29uc3QgV0hPTEVfUExBQ0VIT0xERVIgPSAvXlxce1xceyhcXHcrKVxcfVxcfSQvO1xuY29uc3QgSU5URUdFUiA9IC9eLT9cXGQrJC87XG5cbi8qKiBSZXBsYWNlIHt7cGxhY2Vob2xkZXJzfX0gdGhyb3VnaG91dCBhIEpTT04taXNoIHZhbHVlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1YnN0aXR1dGUodmFsdWU6IHVua25vd24sIHZhcnM6IFZhcnMpOiB1bmtub3duIHtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICBjb25zdCB3aG9sZSA9IFdIT0xFX1BMQUNFSE9MREVSLmV4ZWModmFsdWUpO1xuICAgICAgICBpZiAod2hvbGUpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlcGxhY2VtZW50ID0gdmFyc1t3aG9sZVsxXSA/PyAnJ107XG4gICAgICAgICAgICBpZiAocmVwbGFjZW1lbnQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHZhbHVlO1xuICAgICAgICAgICAgcmV0dXJuIElOVEVHRVIudGVzdChyZXBsYWNlbWVudCkgPyBOdW1iZXIocmVwbGFjZW1lbnQpIDogcmVwbGFjZW1lbnQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZhbHVlLnJlcGxhY2UoL1xce1xceyhcXHcrKVxcfVxcfS9nLCAobWF0Y2gsIGtleTogc3RyaW5nKSA9PiB2YXJzW2tleV0gPz8gbWF0Y2gpO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlLm1hcCgoZW50cnkpID0+IHN1YnN0aXR1dGUoZW50cnksIHZhcnMpKTtcbiAgICB9XG4gICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSkpIG91dFtrZXldID0gc3Vic3RpdHV0ZShlbnRyeSwgdmFycyk7XG4gICAgICAgIHJldHVybiBvdXQ7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbn1cblxuLyoqXG4gKiBNZXJnZSBzdG9yZWQgc2V0dGluZ3Mgb3ZlciB0aGUgc2hpcHBlZCBkZWZhdWx0cy5cbiAqXG4gKiBQZXJzb25hbCBjaG9pY2VzIChkZXNrLCB3ZWVrZGF5cywgdGltZXpvbmUpIGFsd2F5cyB3aW46IHRoZXkgYXJlIHRoZSB1c2VyJ3MuXG4gKiBUaGUgZW5kcG9pbnQgY29uZmlnIGlzIGRpZmZlcmVudC4gSXQgaXMgbm90IGEgcHJlZmVyZW5jZSwgaXQgaXMgYSBmYWN0IGFib3V0XG4gKiBDb21lZW4ncyBBUEkgdGhhdCBvbmUgcGVyc29uIGRpc2NvdmVycyBhbmQgZXZlcnlvbmUgZWxzZSBpbmhlcml0cy4gSWYgYVxuICogc3RvcmVkIGNvcHkgcHJlZGF0ZXMgdGhlIHNoaXBwZWQgb25lLCB0aGUgc2hpcHBlZCBvbmUgcmVwbGFjZXMgaXQgb3V0cmlnaHQuXG4gKiBNZXJnaW5nIGtleS1ieS1rZXkgd291bGQgYmUgd29yc2UgdGhhbiB1c2VsZXNzIGhlcmU6IGEgY29ycmVjdGVkIGBjcmVhdGVgXG4gKiBibG9jayB3b3VsZCBzaXQgbmV4dCB0byBhIHN0YWxlIGBsaXN0YCBibG9jayBhbmQgZmFpbCBpbiBhIGNvbmZ1c2luZyB3YXkuXG4gKlxuICogUHVyZSBhbmQgc2VwYXJhdGUgZnJvbSBjaHJvbWUuc3RvcmFnZSBzbyBpdCBjYW4gYmUgdGVzdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWVyZ2VTZXR0aW5ncyhzdG9yZWQ6IFBhcnRpYWw8U2V0dGluZ3M+IHwgdW5kZWZpbmVkKTogU2V0dGluZ3Mge1xuICAgIGNvbnN0IHN0b3JlZFZlcnNpb24gPSBzdG9yZWQ/LmVuZHBvaW50VmVyc2lvbiA/PyAwO1xuICAgIGNvbnN0IHNoaXBwZWRJc05ld2VyID0gc3RvcmVkVmVyc2lvbiA8IERFRkFVTFRfU0VUVElOR1MuZW5kcG9pbnRWZXJzaW9uO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgLi4uREVGQVVMVF9TRVRUSU5HUyxcbiAgICAgICAgLi4uc3RvcmVkLFxuICAgICAgICBlbmRwb2ludFZlcnNpb246IERFRkFVTFRfU0VUVElOR1MuZW5kcG9pbnRWZXJzaW9uLFxuICAgICAgICBlbmRwb2ludDogc2hpcHBlZElzTmV3ZXIgfHwgIXN0b3JlZD8uZW5kcG9pbnRcbiAgICAgICAgICAgID8gREVGQVVMVF9TRVRUSU5HUy5lbmRwb2ludFxuICAgICAgICAgICAgOiBzdG9yZWQuZW5kcG9pbnQsXG4gICAgfTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRTZXR0aW5ncygpOiBQcm9taXNlPFNldHRpbmdzPiB7XG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdzZXR0aW5ncycpO1xuICAgIHJldHVybiBtZXJnZVNldHRpbmdzKHN0b3JlZC5zZXR0aW5ncyBhcyBQYXJ0aWFsPFNldHRpbmdzPiB8IHVuZGVmaW5lZCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlU2V0dGluZ3Moc2V0dGluZ3M6IFNldHRpbmdzKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgc2V0dGluZ3MgfSk7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBFbmRwb2ludENvbmZpZyB9IGZyb20gJy4vY29yZS9jb25maWcuanMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEluUGFnZUFyZ3Mge1xuICAgIGVuZHBvaW50OiBFbmRwb2ludENvbmZpZztcbiAgICBkYXRlczogc3RyaW5nW107XG4gICAgLyoqIEh1bWFuIGxhYmVsLCBlLmcuIFwiMy0yM1wiLiBVc2VkIHRvIHJlc29sdmUgdGhlIGlkIHdoZW4gb25lIGlzIG5vdCBjYWNoZWQuICovXG4gICAgZGVza05hbWU6IHN0cmluZztcbiAgICAvKiogSW50ZXJuYWwgaWQuIE9ubHkgdXNlZCB3aGVuIG5vIHJlc29sdmUgZW5kcG9pbnQgaXMgY29uZmlndXJlZC4gKi9cbiAgICBkZXNrSWQ6IHN0cmluZztcbiAgICBzbG90OiBzdHJpbmc7XG4gICAgLyoqIERheXMgd2hvc2UgZXhpc3RpbmcgYm9va2luZyBzaG91bGQgYmUgY2FuY2VsbGVkLiAqL1xuICAgIGNhbmNlbERhdGVzOiBzdHJpbmdbXTtcbiAgICAvKiogTmFpdmUgbG9jYWwgdGltZXMgZm9yIHRoZSBzbG90LCBlLmcuIFwiMDA6MDA6MDAuMDAwWlwiLiAqL1xuICAgIHN0YXJ0VGltZTogc3RyaW5nO1xuICAgIGVuZFRpbWU6IHN0cmluZztcbiAgICBmbG9vcklkOiBudW1iZXI7XG4gICAgYnVpbGRpbmdJZDogbnVtYmVyO1xuICAgIGRyeVJ1bjogYm9vbGVhbjtcbn1cblxuZXhwb3J0IHR5cGUgSW5QYWdlU3RhdHVzID0gJ2Jvb2tlZCcgfCAnY2FuY2VsbGVkJyB8ICdza2lwcGVkJyB8ICdkcnktcnVuJyB8ICd1bmF2YWlsYWJsZScgfCAnZXJyb3InO1xuXG5leHBvcnQgaW50ZXJmYWNlIEluUGFnZVJvdyB7XG4gICAgZGF0ZTogc3RyaW5nO1xuICAgIHN0YXR1czogSW5QYWdlU3RhdHVzO1xuICAgIGRldGFpbD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBJblBhZ2VSZXN1bHQge1xuICAgIHJvd3M6IEluUGFnZVJvd1tdO1xuICAgIG5vdGVzOiBzdHJpbmdbXTtcbiAgICAvKiogU2V0IHdoZW4gdGhlIGRlc2sgaWQgd2FzIGxvb2tlZCB1cCwgc28gdGhlIGNhbGxlciBjYW4gY2FjaGUgaXQuICovXG4gICAgcmVzb2x2ZWREZXNrSWQ/OiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogUHJlc2VudCBvbiBldmVyeSBlYXJseSByZXR1cm4uIE5ldmVyIGNvbnRhaW5zIGEgY3JlZGVudGlhbCBcdTIwMTQgb25seSB3aGljaFxuICAgICAqIHBhZ2UgdGhpcyByYW4gb24gYW5kIHdoaWNoIHN0b3JhZ2Uga2V5cyBleGlzdCwgbmV2ZXIgdGhlaXIgdmFsdWVzLlxuICAgICAqL1xuICAgIGRpYWdub3N0aWNzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgLyoqXG4gICAgICogVGhlIHNlc3Npb24gaXMgZGVhZC4gQSBzdHJ1Y3R1cmVkIGZsYWcgcmF0aGVyIHRoYW4gc29tZXRoaW5nIHRoZSBjYWxsZXJcbiAgICAgKiBoYXMgdG8gcGF0dGVybi1tYXRjaCBvdXQgb2YgYG5vdGVzYCwgYmVjYXVzZSB0aGUgYmFja2dyb3VuZCBzY3JpcHQgYWN0c1xuICAgICAqIG9uIGl0OiBpdCBiYWRnZXMsIG5vdGlmaWVzLCBhbmQgcmV0cmllcyB3aGVuIHlvdSBuZXh0IHZpc2l0IENvbWVlbi5cbiAgICAgKi9cbiAgICBzaWduZWRPdXQ/OiBib29sZWFuO1xuICAgIC8qKlxuICAgICAqIERhdGVzIHdob3NlIGNhbmNlbGxhdGlvbiBpcyBkb25lIHdpdGgsIHNvIHRoZSBjYWxsZXIgY2FuIGRyb3AgdGhlbSBmcm9tXG4gICAgICogY2FuY2VsRGF0ZXMuIFdpdGhvdXQgdGhpcyBhbiBhdXRvbWF0aWMgcnVuIHJldHJpZXMgZXZlcnkgcGFzdFxuICAgICAqIGNhbmNlbGxhdGlvbiBmb3JldmVyLlxuICAgICAqL1xuICAgIGNhbmNlbGxlZD86IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIFJ1bnMgaW5zaWRlIHRoZSBDb21lZW4gdGFiLCBpbiB0aGUgcGFnZSdzIG93biBKYXZhU2NyaXB0IHdvcmxkLlxuICpcbiAqIFx1MjUwMFx1MjUwMFx1MjUwMCBXaHkgaXQgbG9va3MgbGlrZSB0aGlzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICogYGNocm9tZS5zY3JpcHRpbmcuZXhlY3V0ZVNjcmlwdGAgc2VyaWFsaXplcyB0aGlzIGZ1bmN0aW9uIGFuZCByZS1wYXJzZXMgaXQgaW5cbiAqIHRoZSBwYWdlLiBJdCB0aGVyZWZvcmUgQ0FOTk9UIHJlZmVyZW5jZSBhbnl0aGluZyBvdXRzaWRlIGl0cyBvd24gYm9keTogbm9cbiAqIGltcG9ydHMsIG5vIG1vZHVsZS1sZXZlbCBoZWxwZXJzLCBubyBjbG9zdXJlcy4gRXZlcnkgaGVscGVyIGlzIGRlZmluZWQgaW5saW5lXG4gKiBvbiBwdXJwb3NlLiBSZXNpc3QgdGhlIHVyZ2UgdG8gXCJjbGVhbiB0aGlzIHVwXCIgYnkgaG9pc3RpbmcgdGhlbSBvdXQuXG4gKlxuICogXHUyNTAwXHUyNTAwXHUyNTAwIFRoZSBzZWN1cml0eSBwcm9wZXJ0eSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAqIFRoZSBjcmVkZW50aWFsIGlzIHJlYWQgaGVyZSwgdXNlZCBoZXJlLCBhbmQgZGlzY2FyZGVkIGhlcmUuIEl0IGlzIG5ldmVyXG4gKiByZXR1cm5lZCB0byB0aGUgZXh0ZW5zaW9uLCBuZXZlciB3cml0dGVuIHRvIGNocm9tZS5zdG9yYWdlLCBhbmQgbmV2ZXIgbGVhdmVzXG4gKiB0aGUgdGFiLiBUaGUgZXh0ZW5zaW9uIGhvbGRzIGNvbmZpZ3VyYXRpb24gb25seS4gVGhhdCBpcyB0aGUgd2hvbGUgcmVhc29uIHRvXG4gKiBwcmVmZXIgdGhpcyBkZXNpZ24gb3ZlciBhIHNlcnZlci1zaWRlIHNjcmlwdCBob2xkaW5nIGEgc3RvcmVkIHRva2VuLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYm9va0luUGFnZShhcmdzOiBJblBhZ2VBcmdzKTogUHJvbWlzZTxJblBhZ2VSZXN1bHQ+IHtcbiAgICBjb25zdCB7IGVuZHBvaW50LCBkYXRlcywgZGVza05hbWUsIHNsb3QsIHN0YXJ0VGltZSwgZW5kVGltZSwgZHJ5UnVuIH0gPSBhcmdzO1xuICAgIGNvbnN0IGNhbmNlbERhdGVzID0gYXJncy5jYW5jZWxEYXRlcyA/PyBbXTtcbiAgICBjb25zdCBub3Rlczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByb3dzOiBJblBhZ2VSb3dbXSA9IFtdO1xuICAgIGxldCBkZXNrSWQgPSBhcmdzLmRlc2tJZDtcbiAgICBsZXQgcmVzb2x2ZWREZXNrSWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgc2lnbmVkT3V0ID0gZmFsc2U7XG4gICAgLyoqXG4gICAgICogRGF5cyB0aGlzIGRlc2sgYWxyZWFkeSBsb29rcyBzcG9rZW4gZm9yLCByZWFkIG9mZiB0aGUgcmVzb2x2ZWQgZGVzaydzIG93blxuICAgICAqIHNjaGVkdWxlLiBEZWxpYmVyYXRlbHkgQURWSVNPUlk6IGl0IGNoYW5nZXMgd2hhdCBQcmV2aWV3IHJlcG9ydHMsIGFuZFxuICAgICAqIG5ldmVyIHdoZXRoZXIgYSByZWFsIGJvb2tpbmcgaXMgYXR0ZW1wdGVkLiBTZWUgdGhlIGNyZWF0ZSBsb29wLlxuICAgICAqL1xuICAgIGNvbnN0IHRha2VuRGF0ZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICAgIC8vIFdoYXRldmVyIHdlIGxlYXJuIGFsb25nIHRoZSB3YXkgZW5kcyB1cCBoZXJlIGFuZCBmZWVkcyB0aGUgY3JlYXRlIGJvZHkuXG4gICAgY29uc3QgdmFyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAgICAgZGVza05hbWUsXG4gICAgICAgIHNsb3QsXG4gICAgICAgIHN0YXJ0VGltZSxcbiAgICAgICAgZW5kVGltZSxcbiAgICAgICAgZmxvb3JJZDogU3RyaW5nKGFyZ3MuZmxvb3JJZCksXG4gICAgICAgIGJ1aWxkaW5nSWQ6IFN0cmluZyhhcmdzLmJ1aWxkaW5nSWQpLFxuICAgICAgICAvLyBUaGUgd2luZG93IG11c3Qgc3BhbiBib3RoIHdoYXQgaXMgYmVpbmcgYm9va2VkIGFuZCB3aGF0IGlzIGJlaW5nXG4gICAgICAgIC8vIGNhbmNlbGxlZDogYSBib29raW5nIG1hcmtlZCBmb3IgY2FuY2VsbGF0aW9uIG5leHQgbW9udGggaXMgaW52aXNpYmxlXG4gICAgICAgIC8vIHRvIGEgbGlzdCBxdWVyeSB0aGF0IHN0b3BzIGF0IHRoZSBib29raW5nIGhvcml6b24uXG4gICAgICAgIGZyb206IFsuLi5kYXRlcywgLi4uY2FuY2VsRGF0ZXNdLnNvcnQoKVswXSA/PyAnJyxcbiAgICAgICAgdG86IFsuLi5kYXRlcywgLi4uY2FuY2VsRGF0ZXNdLnNvcnQoKS5wb3AoKSA/PyAnJyxcbiAgICB9O1xuXG4gICAgLy8gRGlhZ25vc3RpY3MgZm9yIGV2ZXJ5IGZhaWx1cmUgcGF0aC4gS2V5IE5BTUVTIG9ubHksIG5ldmVyIHZhbHVlcywgc28gdGhpc1xuICAgIC8vIGNhbiBzYXkgXCJ5b3UgYXJlIHNpZ25lZCBvdXRcIiB3aXRob3V0IGV2ZXIgaGFuZGxpbmcgYSBjcmVkZW50aWFsLlxuICAgIGNvbnN0IGRpYWdub3N0aWNzID0gKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+ICh7XG4gICAgICAgIHVybDogd2luZG93LmxvY2F0aW9uLmhyZWYsXG4gICAgICAgIGxvY2FsU3RvcmFnZUtleXM6ICgoKSA9PiB7XG4gICAgICAgICAgICB0cnkgeyByZXR1cm4gT2JqZWN0LmtleXMod2luZG93LmxvY2FsU3RvcmFnZSk7IH0gY2F0Y2ggeyByZXR1cm4gWyc8dW5yZWFkYWJsZT4nXTsgfVxuICAgICAgICB9KSgpLFxuICAgICAgICBjb29raWVOYW1lczogKCgpID0+IHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRvY3VtZW50LmNvb2tpZS5zcGxpdCgnOycpXG4gICAgICAgICAgICAgICAgICAgIC5tYXAoKHBhaXIpID0+IHBhaXIuc3BsaXQoJz0nKVswXT8udHJpbSgpID8/ICcnKVxuICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgICAgICAgfSBjYXRjaCB7IHJldHVybiBbJzx1bnJlYWRhYmxlPiddOyB9XG4gICAgICAgIH0pKCksXG4gICAgfSk7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgaW5saW5lIGhlbHBlcnMgKHNlZSBjb21tZW50IGFib3ZlKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAgIC8vIE1pcnJvcnMgYHN1YnN0aXR1dGVgIGluIGNvcmUvY29uZmlnLnRzLiBBIHBsYWNlaG9sZGVyIHRoYXQgaXMgdGhlIGVudGlyZVxuICAgIC8vIHZhbHVlIGFuZCByZXNvbHZlcyB0byBhbiBpbnRlZ2VyIGJlY29tZXMgYSBudW1iZXIsIGJlY2F1c2UgQ29tZWVuJ3NcbiAgICAvLyBwcmVzZW5jZSBibG9jayB3YW50cyBidWlsZGluZ19pZDogNTE1MSwgbm90IFwiNTE1MVwiLiBQYXJ0aWFsXG4gICAgLy8gaW50ZXJwb2xhdGlvbiBzdGF5cyBhIHN0cmluZywgd2hpY2ggaXMgd2hhdCBhIFVSTCBwYXRoIG5lZWRzLlxuICAgIGNvbnN0IGZpbGwgPSAodmFsdWU6IHVua25vd24sIHNvdXJjZTogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IHVua25vd24gPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgY29uc3Qgd2hvbGUgPSAvXlxce1xceyhcXHcrKVxcfVxcfSQvLmV4ZWModmFsdWUpO1xuICAgICAgICAgICAgaWYgKHdob2xlKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVwbGFjZW1lbnQgPSBzb3VyY2Vbd2hvbGVbMV0gPz8gJyddO1xuICAgICAgICAgICAgICAgIGlmIChyZXBsYWNlbWVudCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdmFsdWU7XG4gICAgICAgICAgICAgICAgcmV0dXJuIC9eLT9cXGQrJC8udGVzdChyZXBsYWNlbWVudCkgPyBOdW1iZXIocmVwbGFjZW1lbnQpIDogcmVwbGFjZW1lbnQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUucmVwbGFjZSgvXFx7XFx7KFxcdyspXFx9XFx9L2csIChtYXRjaCwga2V5OiBzdHJpbmcpID0+IHNvdXJjZVtrZXldID8/IG1hdGNoKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB2YWx1ZS5tYXAoKGVudHJ5KSA9PiBmaWxsKGVudHJ5LCBzb3VyY2UpKTtcbiAgICAgICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2tleSwgZW50cnldIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlKSkgb3V0W2tleV0gPSBmaWxsKGVudHJ5LCBzb3VyY2UpO1xuICAgICAgICAgICAgcmV0dXJuIG91dDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfTtcblxuICAgIGNvbnN0IGRpZyA9IChvYmo6IHVua25vd24sIHBhdGg6IHN0cmluZyk6IHVua25vd24gPT4gcGF0aFxuICAgICAgICAuc3BsaXQoJy4nKVxuICAgICAgICAucmVkdWNlPHVua25vd24+KChjdXJyZW50LCBrZXkpID0+IChcbiAgICAgICAgICAgIGN1cnJlbnQgJiYgdHlwZW9mIGN1cnJlbnQgPT09ICdvYmplY3QnID8gKGN1cnJlbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW2tleV0gOiB1bmRlZmluZWRcbiAgICAgICAgKSwgb2JqKTtcblxuICAgIGNvbnN0IGF1dGhIZWFkZXJzID0gKCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPT4ge1xuICAgICAgICBpZiAoZW5kcG9pbnQuYXV0aC5tb2RlICE9PSAnbG9jYWxTdG9yYWdlJykgcmV0dXJuIHt9O1xuICAgICAgICBjb25zdCB7IHN0b3JhZ2VLZXksIGpzb25QYXRoLCBoZWFkZXIsIHByZWZpeCB9ID0gZW5kcG9pbnQuYXV0aDtcbiAgICAgICAgaWYgKCFzdG9yYWdlS2V5IHx8ICFqc29uUGF0aCkge1xuICAgICAgICAgICAgbm90ZXMucHVzaCgnYXV0aC5tb2RlIGlzIGxvY2FsU3RvcmFnZSBidXQgc3RvcmFnZUtleS9qc29uUGF0aCBhcmUgbWlzc2luZy4nKTtcbiAgICAgICAgICAgIHJldHVybiB7fTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByYXcgPSB3aW5kb3cubG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSk7XG4gICAgICAgIGlmICghcmF3KSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGBsb2NhbFN0b3JhZ2Uga2V5IFwiJHtzdG9yYWdlS2V5fVwiIG5vdCBmb3VuZC4gQXJlIHlvdSBzaWduZWQgaW4/YCk7XG4gICAgICAgICAgICByZXR1cm4ge307XG4gICAgICAgIH1cbiAgICAgICAgbGV0IHRva2VuOiB1bmtub3duO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgdG9rZW4gPSBkaWcoSlNPTi5wYXJzZShyYXcpLCBqc29uUGF0aCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgbm90ZXMucHVzaChgbG9jYWxTdG9yYWdlIGtleSBcIiR7c3RvcmFnZUtleX1cIiBpcyBub3QgSlNPTi5gKTtcbiAgICAgICAgICAgIHJldHVybiB7fTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodHlwZW9mIHRva2VuICE9PSAnc3RyaW5nJyB8fCAhdG9rZW4pIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goYE5vIHRva2VuIGF0IHBhdGggXCIke2pzb25QYXRofVwiLmApO1xuICAgICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IFtoZWFkZXIgPz8gJ2F1dGhvcml6YXRpb24nXTogYCR7cHJlZml4ID8/ICdCZWFyZXIgJ30ke3Rva2VufWAgfTtcbiAgICB9O1xuXG4gICAgY29uc3QgY2FsbCA9IGFzeW5jIChcbiAgICAgICAgdHBsOiB7IG1ldGhvZDogc3RyaW5nOyBwYXRoOiBzdHJpbmc7IHF1ZXJ5PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjsgYm9keT86IHVua25vd24gfSxcbiAgICAgICAgc291cmNlOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuICAgICk6IFByb21pc2U8eyBvazogYm9vbGVhbjsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IHVua25vd247IHRleHQ6IHN0cmluZzsgc2lnbmVkT3V0OiBib29sZWFuIH0+ID0+IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IGZpbGwodHBsLnBhdGgsIHNvdXJjZSkgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKGAke2VuZHBvaW50LmFwaUJhc2UucmVwbGFjZSgvXFwvJC8sICcnKX0ke3BhdGh9YCk7XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGZpbGwodHBsLnF1ZXJ5ID8/IHt9LCBzb3VyY2UpIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZz4pKSB7XG4gICAgICAgICAgICB1cmwuc2VhcmNoUGFyYW1zLnNldChrZXksIFN0cmluZyh2YWx1ZSkpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGJvZHkgPSB0cGwuYm9keSA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogSlNPTi5zdHJpbmdpZnkoZmlsbCh0cGwuYm9keSwgc291cmNlKSk7XG5cbiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgd2luZG93LmZldGNoKHVybC50b1N0cmluZygpLCB7XG4gICAgICAgICAgICBtZXRob2Q6IHRwbC5tZXRob2QsXG4gICAgICAgICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLFxuICAgICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgICAgIGFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAgIC4uLihib2R5ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9KSxcbiAgICAgICAgICAgICAgICAuLi5hdXRoSGVhZGVycygpLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGJvZHksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgICAgICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gICAgICAgIHRyeSB7IGRhdGEgPSB0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IG51bGw7IH0gY2F0Y2ggeyBkYXRhID0gbnVsbDsgfVxuXG4gICAgICAgIC8vIEFuIGV4cGlyZWQgc2Vzc2lvbiBkb2VzIG5vdCBhbm5vdW5jZSBpdHNlbGYgd2l0aCBhIHRpZHkgNDAxLiBDb21lZW5cbiAgICAgICAgLy8gcmVkaXJlY3RzIHRvIHRoZSBsb2dpbiBwYWdlLCBzbyB0aGUgZmV0Y2ggZm9sbG93cyBpdCBhbmQgaGFuZHMgYmFjayBhXG4gICAgICAgIC8vIDIwMCBmdWxsIG9mIEhUTUwuIFBhcnNlZCBhcyBKU09OIHRoYXQgYmVjb21lcyBudWxsLCB3aGljaCBkb3duc3RyZWFtXG4gICAgICAgIC8vIHJlYWRzIGFzIFwiemVybyByZXN1bHRzXCIgXHUyMDE0IGhlbmNlIHRoZSBvbGQsIGJhZGx5IG1pc2xlYWRpbmcgXCJubyBkZXNrXG4gICAgICAgIC8vIGNhbGxlZCAzLTIzIGluIDAgc2VhcmNoIHJlc3VsdChzKVwiLiBDYXRjaCBpdCBoZXJlIGluc3RlYWQuXG4gICAgICAgIGxldCBmaW5hbEhvc3QgPSAnJztcbiAgICAgICAgdHJ5IHsgZmluYWxIb3N0ID0gbmV3IFVSTChyZXMudXJsKS5ob3N0bmFtZTsgfSBjYXRjaCB7IC8qIHN0dWIgb3Igb3BhcXVlICovIH1cbiAgICAgICAgY29uc3QgbG9va3NMaWtlSHRtbCA9IC9eXFxzKjwoIWRvY3R5cGV8aHRtbCkvaS50ZXN0KHRleHQpO1xuICAgICAgICBjb25zdCBzaWduZWRPdXQgPSByZXMuc3RhdHVzID09PSA0MDFcbiAgICAgICAgICAgIHx8IHJlcy5zdGF0dXMgPT09IDQwM1xuICAgICAgICAgICAgfHwgLyhefFxcLilhY2NvdW50c1xcLmNvbWVlblxcLmlvJC8udGVzdChmaW5hbEhvc3QpXG4gICAgICAgICAgICB8fCAobG9va3NMaWtlSHRtbCAmJiBkYXRhID09PSBudWxsKTtcblxuICAgICAgICByZXR1cm4geyBvazogcmVzLm9rLCBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEsIHRleHQsIHNpZ25lZE91dCB9O1xuICAgIH07XG5cbiAgICBjb25zdCBzaWduZWRPdXRSZXN1bHQgPSAoKTogSW5QYWdlUmVzdWx0ID0+ICh7XG4gICAgICAgIHJvd3M6IFtdLFxuICAgICAgICBub3RlczogWydOb3Qgc2lnbmVkIGluIHRvIENvbWVlbi4gT3BlbiBodHRwczovL215LmNvbWVlbi5pby8sIHNpZ24gaW4sIHRoZW4gcnVuIGFnYWluLiddLFxuICAgICAgICBkaWFnbm9zdGljczogZGlhZ25vc3RpY3MoKSxcbiAgICAgICAgc2lnbmVkT3V0OiB0cnVlLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYXNMaXN0ID0gKGRhdGE6IHVua25vd24pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdID0+IHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHJldHVybiBkYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+W107XG4gICAgICAgIGlmIChkYXRhICYmIHR5cGVvZiBkYXRhID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgY29uc3Qgb2JqID0gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIFsnaXRlbXMnLCAnZGF0YScsICdyZXN1bHRzJywgJ2Jvb2tpbmdzJywgJ2Rlc2tzJ10pIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvYmpba2V5XSkpIHJldHVybiBvYmpba2V5XSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBbXTtcbiAgICB9O1xuXG4gICAgY29uc3Qgbm9ybWFsaXNlID0gKHZhbHVlOiB1bmtub3duKTogc3RyaW5nID0+IFN0cmluZyh2YWx1ZSA/PyAnJylcbiAgICAgICAgLnRyaW0oKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1tcXHNfXSsvZywgJy0nKTtcblxuICAgIC8vIENvbmZpcm1lZCBhZ2FpbnN0IGEgcmVhbCBjb250ZW5kZWQgZGF5OiBDb21lZW4gcmVqZWN0cyBhIGRlc2sgc29tZW9uZSBlbHNlXG4gICAgLy8gYWxyZWFkeSBob2xkcyB3aXRoIDQyMiBhbmQgYSBtZXNzYWdlLCBub3QgYSBjbGVhbiA0MDkuIFJlYWRpbmcgdGhlIG1lc3NhZ2VcbiAgICAvLyBhcyB3ZWxsIGFzIHRoZSBzdGF0dXMgaXMgd2hhdCBrZWVwcyB0aGF0IHJlcG9ydGVkIGFzIFwidW5hdmFpbGFibGVcIiByYXRoZXJcbiAgICAvLyB0aGFuIGFzIGFuIGVycm9yIHRoYXQgbG9va3MgbGlrZSBhIGJ1ZyBpbiB0aGlzIGV4dGVuc2lvbi5cbiAgICBjb25zdCBsb29rc1Rha2VuID0gKHN0YXR1czogbnVtYmVyLCB0ZXh0OiBzdHJpbmcpOiBib29sZWFuID0+IHN0YXR1cyA9PT0gNDA5XG4gICAgICAgIHx8IHN0YXR1cyA9PT0gNDIyXG4gICAgICAgIHx8IC90YWtlbnxhbHJlYWR5fHVuYXZhaWxhYmxlfG9jY3VwaWVkfGZ1bGx8Y29uZmxpY3QvaS50ZXN0KHRleHQpO1xuXG4gICAgLy8gXHUyNTAwXHUyNTAwIDEuIHdoaWNoIGRlc2s/IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIC8vIFJlc29sdmluZyBldmVyeSBydW4gcmF0aGVyIHRoYW4gdHJ1c3RpbmcgYSBjYWNoZWQgaWQ6IHRoZSBsb29rdXAgYWxzb1xuICAgIC8vIHlpZWxkcyB0aGUgZGVzaydzIGFyZWFfaWQsIHdoaWNoIHRoZSBjcmVhdGUgYm9keSBuZWVkcywgYW5kIGl0IG1lYW5zIGFcbiAgICAvLyByZW51bWJlcmVkIG9yIG1vdmVkIGRlc2sgY29ycmVjdHMgaXRzZWxmIGluc3RlYWQgb2YgYm9va2luZyB0aGUgd3Jvbmcgc2VhdC5cbiAgICBpZiAoZW5kcG9pbnQucmVzb2x2ZSkge1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBjYWxsKGVuZHBvaW50LnJlc29sdmUsIHZhcnMpO1xuICAgICAgICBpZiAocmVzLnNpZ25lZE91dCkgcmV0dXJuIHNpZ25lZE91dFJlc3VsdCgpO1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgICAgICBub3RlczogW2BEZXNrIGxvb2t1cCBmYWlsZWQgKCR7cmVzLnN0YXR1c30pOiAke3Jlcy50ZXh0LnNsaWNlKDAsIDIwMCl9YF0sXG4gICAgICAgICAgICAgICAgZGlhZ25vc3RpY3M6IGRpYWdub3N0aWNzKCksXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGFzTGlzdChyZXMuZGF0YSk7XG4gICAgICAgIGNvbnN0IG1hdGNoID0gY2FuZGlkYXRlcy5maW5kKChkZXNrKSA9PiBlbmRwb2ludC5kZXNrTmFtZUZpZWxkc1xuICAgICAgICAgICAgLnNvbWUoKGZpZWxkKSA9PiBub3JtYWxpc2UoZGVza1tmaWVsZF0pID09PSBub3JtYWxpc2UoZGVza05hbWUpKSk7XG5cbiAgICAgICAgaWYgKCFtYXRjaCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgICAgICBub3RlczogW1xuICAgICAgICAgICAgICAgICAgICBgTm8gZGVzayBjYWxsZWQgXCIke2Rlc2tOYW1lfVwiIGluICR7Y2FuZGlkYXRlcy5sZW5ndGh9IHNlYXJjaCByZXN1bHQocykuYCxcbiAgICAgICAgICAgICAgICAgICAgYEZpcnN0IGZldzogJHtKU09OLnN0cmluZ2lmeShjYW5kaWRhdGVzLnNsaWNlKDAsIDMpKS5zbGljZSgwLCA0MDApfWAsXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICBkaWFnbm9zdGljczogZGlhZ25vc3RpY3MoKSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBpZEZpZWxkID0gZW5kcG9pbnQuZGVza0lkRmllbGRzLmZpbmQoKGZpZWxkKSA9PiBtYXRjaFtmaWVsZF0gIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgJiYgbWF0Y2hbZmllbGRdICE9PSBudWxsKTtcbiAgICAgICAgaWYgKCFpZEZpZWxkKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHJvd3M6IFtdLFxuICAgICAgICAgICAgICAgIG5vdGVzOiBbXG4gICAgICAgICAgICAgICAgICAgIGBGb3VuZCBcIiR7ZGVza05hbWV9XCIgYnV0IG5vbmUgb2YgJHtlbmRwb2ludC5kZXNrSWRGaWVsZHMuam9pbignLycpfSBoZWxkIGFuIGlkLmAsXG4gICAgICAgICAgICAgICAgICAgIGBSZWNvcmQ6ICR7SlNPTi5zdHJpbmdpZnkobWF0Y2gpLnNsaWNlKDAsIDQwMCl9YCxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgIGRpYWdub3N0aWNzOiBkaWFnbm9zdGljcygpLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGRlc2tJZCA9IFN0cmluZyhtYXRjaFtpZEZpZWxkXSk7XG4gICAgICAgIHJlc29sdmVkRGVza0lkID0gZGVza0lkO1xuICAgICAgICBub3Rlcy5wdXNoKGBSZXNvbHZlZCBcIiR7ZGVza05hbWV9XCIgdG8gJHtpZEZpZWxkfSAke2Rlc2tJZH0uYCk7XG5cbiAgICAgICAgLy8gVGhlIGRlc2sga25vd3Mgd2hpY2ggYXJlYSBhbmQgZmxvb3IgaXQgaXMgaW47IHByZWZlciB0aGF0IG92ZXIgdGhlXG4gICAgICAgIC8vIGNvbmZpZ3VyZWQgZmxvb3IsIHdoaWNoIGlzIG9ubHkgYSBzdGFydGluZyBwb2ludCBmb3IgdGhlIGxvb2t1cC5cbiAgICAgICAgaWYgKG1hdGNoLmFyZWFfaWQgIT09IHVuZGVmaW5lZCAmJiBtYXRjaC5hcmVhX2lkICE9PSBudWxsKSB2YXJzLmFyZWFJZCA9IFN0cmluZyhtYXRjaC5hcmVhX2lkKTtcbiAgICAgICAgaWYgKG1hdGNoLmZsb29yX2lkICE9PSB1bmRlZmluZWQgJiYgbWF0Y2guZmxvb3JfaWQgIT09IG51bGwpIHZhcnMuZmxvb3JJZCA9IFN0cmluZyhtYXRjaC5mbG9vcl9pZCk7XG5cbiAgICAgICAgaWYgKG1hdGNoLmF2YWlsYWJsZV90b19ib29raW5nID09PSBmYWxzZSkge1xuICAgICAgICAgICAgbm90ZXMucHVzaChgXHUyNkEwIFwiJHtkZXNrTmFtZX1cIiBpcyBtYXJrZWQgbm90IGF2YWlsYWJsZSB0byBib29raW5nIFx1MjAxNCBpdCBtYXkgYmUgYXNzaWduZWQgdG8gc29tZW9uZS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFRoZSBkZXNrIGNhcnJpZXMgaXRzIG93biBib29raW5ncyBmb3IgdGhlIHF1ZXJpZWQgd2luZG93LCB3aGljaCBpcyBob3dcbiAgICAgICAgLy8gUHJldmlldyBjYW4gc2F5IFwic29tZW9uZSBlbHNlIGhhcyBpdFwiIGluc3RlYWQgb2YgY2hlZXJmdWxseSBwcm9taXNpbmdcbiAgICAgICAgLy8gYSBkYXkgdGhhdCB3aWxsIDQyMiB0aGUgbW9tZW50IHlvdSBwcmVzcyBCb29rIG5vdy5cbiAgICAgICAgaWYgKGVuZHBvaW50LmRlc2tTY2hlZHVsZUZpZWxkKSB7XG4gICAgICAgICAgICBjb25zdCBlbnRyaWVzID0gbWF0Y2hbZW5kcG9pbnQuZGVza1NjaGVkdWxlRmllbGRdO1xuICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZW50cmllcykpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBlbnRyeSAhPT0gJ29iamVjdCcpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIGVuZHBvaW50LmRlc2tTY2hlZHVsZURhdGVGaWVsZHMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gZW50cnlbZmllbGRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgL15cXGR7NH0tXFxkezJ9LVxcZHsyfS8udGVzdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWtlbkRhdGVzLmFkZCh2YWx1ZS5zbGljZSgwLCAxMCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICh0YWtlbkRhdGVzLnNpemUgPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goYFwiJHtkZXNrTmFtZX1cIiBhbHJlYWR5IGhhcyAke3Rha2VuRGF0ZXMuc2l6ZX0gZGF5KHMpIGJvb2tlZCBpbiB0aGlzIHdpbmRvdy5gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIWRlc2tJZCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgcm93czogW10sXG4gICAgICAgICAgICBub3RlczogWydObyBkZXNrIElEIHNldCBhbmQgbm8gZGVzay1zZWFyY2ggZW5kcG9pbnQgY29uZmlndXJlZC4nXSxcbiAgICAgICAgICAgIGRpYWdub3N0aWNzOiBkaWFnbm9zdGljcygpLFxuICAgICAgICB9O1xuICAgIH1cbiAgICB2YXJzLmRlc2tJZCA9IGRlc2tJZDtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCAyLiB3aGF0IGRvIEkgYWxyZWFkeSBoYXZlPyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBjb25zdCBoZWxkRGF0ZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICAvKiogZGF0ZSBcdTIxOTIgdGhlIGlkIHRoYXQgY2FuY2VsbGluZyBvbmUgbmVlZHMuICovXG4gICAgY29uc3QgYm9va2luZ0lkcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cbiAgICBpZiAoZW5kcG9pbnQubGlzdCkge1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBjYWxsKGVuZHBvaW50Lmxpc3QsIHZhcnMpO1xuICAgICAgICBpZiAocmVzLnNpZ25lZE91dCkgcmV0dXJuIHNpZ25lZE91dFJlc3VsdCgpO1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgICAgLy8gTm90IGZhdGFsLCBidXQgaXQgbWVhbnMgd2UgbG9zZSBpZGVtcG90ZW5jeSwgc28gc2F5IHNvIGxvdWRseS5cbiAgICAgICAgICAgIG5vdGVzLnB1c2goXG4gICAgICAgICAgICAgICAgYENvdWxkIG5vdCBsaXN0IGV4aXN0aW5nIGJvb2tpbmdzICgke3Jlcy5zdGF0dXN9KS4gUHJvY2VlZGluZyB3aXRob3V0IHRoZSBgXG4gICAgICAgICAgICAgICAgKyBgZHVwbGljYXRlIGNoZWNrLCBzbyBleHBlY3QgXCJ1bmF2YWlsYWJsZVwiIG9uIGRheXMgeW91IGFscmVhZHkgaG9sZC4gYFxuICAgICAgICAgICAgICAgICsgYFJlc3BvbnNlOiAke3Jlcy50ZXh0LnNsaWNlKDAsIDIwMCl9YCxcbiAgICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBUaGUgc2lnbmVkLWluIHVzZXIncyBvd24gaWQgaXMgaW4gdGhpcyByZXNwb25zZSwgYW5kIHRoZSBjcmVhdGVcbiAgICAgICAgICAgIC8vIHBhdGggbmVlZHMgaXQuIFJlYWRpbmcgaXQgaGVyZSBhdm9pZHMgYSBzZWNvbmQgcm91bmQgdHJpcCBhbmRcbiAgICAgICAgICAgIC8vIGF2b2lkcyBtYWtpbmcgdGhlIHVzZXIgbG9vayB0aGVpciBvd24gaWQgdXAuXG4gICAgICAgICAgICBpZiAoZW5kcG9pbnQudXNlcklkUGF0aCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHVzZXJJZCA9IGRpZyhyZXMuZGF0YSwgZW5kcG9pbnQudXNlcklkUGF0aCk7XG4gICAgICAgICAgICAgICAgaWYgKHVzZXJJZCAhPT0gdW5kZWZpbmVkICYmIHVzZXJJZCAhPT0gbnVsbCkgdmFycy51c2VySWQgPSBTdHJpbmcodXNlcklkKTtcbiAgICAgICAgICAgICAgICBlbHNlIG5vdGVzLnB1c2goYE5vIHVzZXIgaWQgYXQgXCIke2VuZHBvaW50LnVzZXJJZFBhdGh9XCIgaW4gdGhlIGxpc3QgcmVzcG9uc2UuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGNvbnRhaW5lciA9IGVuZHBvaW50Lmxpc3RSb290ID8gZGlnKHJlcy5kYXRhLCBlbmRwb2ludC5saXN0Um9vdCkgOiByZXMuZGF0YTtcblxuICAgICAgICAgICAgaWYgKGVuZHBvaW50Lmxpc3RTaGFwZSA9PT0gJ2RhdGVLZXllZE1hcCcpIHtcbiAgICAgICAgICAgICAgICAvLyB7IFwiMjAyNi0wOS0wMVwiOiBbZW50cnldLCBcIjIwMjYtMDktMDJcIjogW10gfSBcdTIwMTQgYSBkYXkgd2l0aCBhbnlcbiAgICAgICAgICAgICAgICAvLyBlbnRyeSBpcyBhIGRheSBhbHJlYWR5IHNwb2tlbiBmb3IuXG4gICAgICAgICAgICAgICAgaWYgKGNvbnRhaW5lciAmJiB0eXBlb2YgY29udGFpbmVyID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShjb250YWluZXIpKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgW2RhdGUsIGVudHJpZXNdIG9mIE9iamVjdC5lbnRyaWVzKGNvbnRhaW5lciBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShlbnRyaWVzKSB8fCBlbnRyaWVzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBkYXkgPSBkYXRlLnNsaWNlKDAsIDEwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGhlbGREYXRlcy5hZGQoZGF5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIE9uZSBlbnRyeSBwZXIgZGF5LiBWZXJpZmllZCByYXRoZXIgdGhhbiBhc3N1bWVkOiBhY3Jvc3NcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGV2ZXJ5IGNhcHR1cmVkIHJlc3BvbnNlLCBubyBkYXRlIGV2ZXIgY2FycmllZCBtb3JlIHRoYW5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9uZSB3b3JrIGFjdGl2aXR5IFx1MjAxNCBDb21lZW4ncyBtb2RlbCBpcyBvbmUgcGVyIGRheS4gQVxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gNjEtZGF5IHF1ZXJ5IGFsc28gY2FtZSBiYWNrIHdpdGggZXhhY3RseSA2MSBkYXRlIGtleXNcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGFuZCBubyBwYWdpbmF0aW9uIGZpZWxkcywgc28gdGhpcyByZXNwb25zZSBpcyBjb21wbGV0ZVxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gZm9yIGl0cyB3aW5kb3cgYW5kIG5vdGhpbmcgaGVyZSBpcyBiZWluZyB0cnVuY2F0ZWQuXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBmaXJzdCA9IGVudHJpZXNbMF0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmlyc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIGVuZHBvaW50Lmxpc3RCb29raW5nSWRGaWVsZHMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBmaXJzdFtmaWVsZF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkICYmIHZhbHVlICE9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBib29raW5nSWRzLnNldChkYXksIFN0cmluZyh2YWx1ZSkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgbm90ZXMucHVzaChgRm91bmQgJHtoZWxkRGF0ZXMuc2l6ZX0gZGF5KHMpIGFscmVhZHkgYm9va2VkIGluIHRoZSB3aW5kb3cuYCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbm90ZXMucHVzaChcbiAgICAgICAgICAgICAgICAgICAgICAgIGBsaXN0U2hhcGUgaXMgZGF0ZUtleWVkTWFwIGJ1dCBcIiR7ZW5kcG9pbnQubGlzdFJvb3R9XCIgaXMgbm90IGFuIG9iamVjdC4gYFxuICAgICAgICAgICAgICAgICAgICAgICAgKyBgR290OiAke0pTT04uc3RyaW5naWZ5KGNvbnRhaW5lcikuc2xpY2UoMCwgMjAwKX1gLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBhc0xpc3QoY29udGFpbmVyKTtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGJvb2tpbmcgb2YgZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWVsZCBvZiBlbmRwb2ludC5saXN0RGF0ZUZpZWxkcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBib29raW5nW2ZpZWxkXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZGF5ID0gdmFsdWUuc2xpY2UoMCwgMTApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGhlbGREYXRlcy5hZGQoZGF5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGlkRmllbGQgb2YgZW5kcG9pbnQubGlzdEJvb2tpbmdJZEZpZWxkcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBpZCA9IGJvb2tpbmdbaWRGaWVsZF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpZCAhPT0gdW5kZWZpbmVkICYmIGlkICE9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBib29raW5nSWRzLnNldChkYXksIFN0cmluZyhpZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbm90ZXMucHVzaChgRm91bmQgJHtleGlzdGluZy5sZW5ndGh9IGV4aXN0aW5nIGJvb2tpbmcocykgaW4gdGhlIHdpbmRvdy5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIGBtZWAgd29ya3MgZm9yIHJlYWRzLCBzbyBpdCBpcyBhIGJldHRlciBmYWxsYmFjayB0aGFuIGEgbGl0ZXJhbFxuICAgIC8vIHt7dXNlcklkfX0gaW4gdGhlIHBhdGggaWYgdGhlIGxpc3Qgc3RlcCBjb3VsZCBub3Qgc3VwcGx5IG9uZS5cbiAgICBpZiAodmFycy51c2VySWQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICB2YXJzLnVzZXJJZCA9ICdtZSc7XG4gICAgICAgIGlmIChlbmRwb2ludC51c2VySWRQYXRoKSBub3Rlcy5wdXNoKCdGYWxsaW5nIGJhY2sgdG8gL3VzZXJzL21lIGZvciB0aGUgYm9va2luZyBwYXRoLicpO1xuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCAzLiBjYW5jZWwgd2hhdCB3YXMgYXNrZWQgZm9yIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIC8vIEJlZm9yZSBib29raW5nLCBzbyB0aGF0IGEgZGF0ZSBzb21laG93IHByZXNlbnQgaW4gYm90aCBsaXN0cyBlbmRzIHVwXG4gICAgLy8gY2FuY2VsbGVkIHJhdGhlciB0aGFuIGNhbmNlbGxlZC10aGVuLWltbWVkaWF0ZWx5LXJlYm9va2VkLlxuICAgIGNvbnN0IGNhbmNlbGxlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gICAgZm9yIChjb25zdCBkYXRlIG9mIGNhbmNlbERhdGVzKSB7XG4gICAgICAgIGlmICghZW5kcG9pbnQuY2FuY2VsKSB7XG4gICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICdlcnJvcicsIGRldGFpbDogJ25vIGNhbmNlbCBlbmRwb2ludCBjb25maWd1cmVkJyB9KTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgYm9va2luZ0lkID0gYm9va2luZ0lkcy5nZXQoZGF0ZSk7XG4gICAgICAgIGlmICghYm9va2luZ0lkKSB7XG4gICAgICAgICAgICAvLyBOb3RoaW5nIHRvIGRlbGV0ZTogYWxyZWFkeSBnb25lLCBvciBuZXZlciBoZWxkLiBFaXRoZXIgd2F5IHRoZVxuICAgICAgICAgICAgLy8gZGVzaXJlZCBzdGF0ZSBpcyByZWFjaGVkLCBzbyB0aGlzIGlzIG5vdCBhIGZhaWx1cmUuXG4gICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICdza2lwcGVkJywgZGV0YWlsOiAnbm90aGluZyBib29rZWQgdG8gY2FuY2VsJyB9KTtcbiAgICAgICAgICAgIGNhbmNlbGxlZC5hZGQoZGF0ZSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChkcnlSdW4pIHtcbiAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ2RyeS1ydW4nLCBkZXRhaWw6IGB3b3VsZCBjYW5jZWwgYm9va2luZyAke2Jvb2tpbmdJZH1gIH0pO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgY2FsbChlbmRwb2ludC5jYW5jZWwsIHsgLi4udmFycywgZGF0ZSwgYm9va2luZ0lkIH0pO1xuICAgICAgICAgICAgaWYgKHJlcy5zaWduZWRPdXQpIHtcbiAgICAgICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICdlcnJvcicsIGRldGFpbDogJ25vdCBzaWduZWQgaW4nIH0pO1xuICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goJ1NpZ25lZCBvdXQgYmVmb3JlIGNhbmNlbGxpbmcuIFNpZ24gaW4gYW5kIHJ1biBhZ2Fpbi4nKTtcbiAgICAgICAgICAgICAgICBzaWduZWRPdXQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHJlcy5vayB8fCByZXMuc3RhdHVzID09PSA0MDQpIHtcbiAgICAgICAgICAgICAgICAvLyA0MDQgbWVhbnMgc29tZWJvZHkgb3Igc29tZXRoaW5nIGFscmVhZHkgcmVtb3ZlZCBpdC4gVGhlIGVuZFxuICAgICAgICAgICAgICAgIC8vIHN0YXRlIGlzIHdoYXQgd2FzIHdhbnRlZCwgc28gcmVwb3J0IGl0IGFzIGRvbmUuXG4gICAgICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnY2FuY2VsbGVkJywgZGV0YWlsOiByZXMuc3RhdHVzID09PSA0MDQgPyAnYWxyZWFkeSBnb25lJyA6IHVuZGVmaW5lZCB9KTtcbiAgICAgICAgICAgICAgICBjYW5jZWxsZWQuYWRkKGRhdGUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICdlcnJvcicsIGRldGFpbDogYCR7cmVzLnN0YXR1c306ICR7cmVzLnRleHQuc2xpY2UoMCwgMjAwKX1gIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ2Vycm9yJywgZGV0YWlsOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgNC4gYm9vayB0aGUgZ2FwcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBmb3IgKGNvbnN0IGRhdGUgb2YgZGF0ZXMpIHtcbiAgICAgICAgLy8gQmVsdCBhbmQgYnJhY2VzOiB0aGUgcG9wdXAgYWRkcyBhIGNhbmNlbGxlZCBkYXkgdG8gc2tpcERhdGVzIHRvbywgc29cbiAgICAgICAgLy8gaXQgc2hvdWxkIG5vdCBhcHBlYXIgaGVyZSBhdCBhbGwuIElmIGl0IHNvbWVob3cgZG9lcywgY2FuY2VsbGluZyBhbmRcbiAgICAgICAgLy8gdGhlbiByZWJvb2tpbmcgaW4gb25lIHJ1biB3b3VsZCBiZSB0aGUgd29yc3QgcG9zc2libGUgb3V0Y29tZS5cbiAgICAgICAgaWYgKGNhbmNlbERhdGVzLmluY2x1ZGVzKGRhdGUpKSBjb250aW51ZTtcblxuICAgICAgICBpZiAoaGVsZERhdGVzLmhhcyhkYXRlKSkge1xuICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnc2tpcHBlZCcsIGRldGFpbDogJ2FscmVhZHkgYm9va2VkJyB9KTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChkcnlSdW4pIHtcbiAgICAgICAgICAgIHJvd3MucHVzaCh0YWtlbkRhdGVzLmhhcyhkYXRlKVxuICAgICAgICAgICAgICAgID8geyBkYXRlLCBzdGF0dXM6ICd1bmF2YWlsYWJsZScsIGRldGFpbDogJ3NvbWVvbmUgZWxzZSBob2xkcyB0aGlzIGRlc2sgdGhhdCBkYXknIH1cbiAgICAgICAgICAgICAgICA6IHsgZGF0ZSwgc3RhdHVzOiAnZHJ5LXJ1bicsIGRldGFpbDogYHdvdWxkIGJvb2sgJHtkZXNrSWR9ICgke3Nsb3R9KWAgfSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIE5vdGUgdGhlIGFzeW1tZXRyeSwgYW5kIGRvIG5vdCBcIm9wdGltaXNlXCIgdGhpcyBpbnRvIGEgc2tpcC4gVGhlIGRlc2tcbiAgICAgICAgLy8gc2NoZWR1bGUgaXMgcmVhZCBkZWZlbnNpdmVseSBmcm9tIGEgc2hhcGUgdGhhdCBoYXMgbmV2ZXIgYmVlbiBzZWVuXG4gICAgICAgIC8vIHBvcHVsYXRlZCwgc28gYSBtaXNyZWFkaW5nIGlzIHBvc3NpYmxlLiBBdHRlbXB0aW5nIGFueXdheSBjb3N0cyBvbmVcbiAgICAgICAgLy8gcmVxdWVzdCB0aGF0IHJldHVybnMgNDIyIGFuZCBpcyByZXBvcnRlZCBhcyB1bmF2YWlsYWJsZSBcdTIwMTQgZXhhY3RseSB3aGF0XG4gICAgICAgIC8vIHdvdWxkIGhhdmUgYmVlbiByZXBvcnRlZCBieSBza2lwcGluZy4gU2tpcHBpbmcgd3JvbmdseSBjb3N0cyBhIGRheVxuICAgICAgICAvLyB5b3UgY291bGQgaGF2ZSBoYWQsIGFuZCBkb2VzIGl0IHNpbGVudGx5LlxuICAgICAgICBpZiAodGFrZW5EYXRlcy5oYXMoZGF0ZSkpIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goYCR7ZGF0ZX06IGRlc2sgbG9va3MgdGFrZW47IHRyeWluZyBhbnl3YXkgaW4gY2FzZSB0aGF0IHJlYWRpbmcgaXMgd3JvbmcuYCk7XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgY2FsbChlbmRwb2ludC5jcmVhdGUsIHsgLi4udmFycywgZGF0ZSB9KTtcbiAgICAgICAgICAgIGlmIChyZXMuc2lnbmVkT3V0KSB7XG4gICAgICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnZXJyb3InLCBkZXRhaWw6ICdub3Qgc2lnbmVkIGluJyB9KTtcbiAgICAgICAgICAgICAgICBub3Rlcy5wdXNoKCdTaWduZWQgb3V0IHBhcnR3YXkgdGhyb3VnaC4gU2lnbiBpbiBhdCBodHRwczovL215LmNvbWVlbi5pby8gYW5kIHJ1biAnXG4gICAgICAgICAgICAgICAgICAgICsgJ2FnYWluIFx1MjAxNCB0aGUgZGF5cyBhbHJlYWR5IGJvb2tlZCB3aWxsIGJlIHNraXBwZWQuJyk7XG4gICAgICAgICAgICAgICAgc2lnbmVkT3V0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChyZXMub2spIHtcbiAgICAgICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICdib29rZWQnIH0pO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChsb29rc1Rha2VuKHJlcy5zdGF0dXMsIHJlcy50ZXh0KSkge1xuICAgICAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ3VuYXZhaWxhYmxlJywgZGV0YWlsOiBgJHtyZXMuc3RhdHVzfTogJHtyZXMudGV4dC5zbGljZSgwLCAxNjApfWAgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ2Vycm9yJywgZGV0YWlsOiBgJHtyZXMuc3RhdHVzfTogJHtyZXMudGV4dC5zbGljZSgwLCAyMDApfWAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnZXJyb3InLCBkZXRhaWw6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSB9KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB7IHJvd3MsIG5vdGVzLCByZXNvbHZlZERlc2tJZCwgc2lnbmVkT3V0LCBjYW5jZWxsZWQ6IFsuLi5jYW5jZWxsZWRdIH07XG59XG4iLCAiaW1wb3J0IHsgZGF0ZXNUb0Jvb2sgfSBmcm9tICcuL2NvcmUvZGF0ZXMuanMnO1xuaW1wb3J0IHtcbiAgICBpc1ZhbGlkRGVza05hbWUsXG4gICAgbG9hZFNldHRpbmdzLFxuICAgIHNhdmVTZXR0aW5ncyxcbiAgICBTTE9UX1RJTUVTLFxuICAgIHR5cGUgU2V0dGluZ3MsXG59IGZyb20gJy4vY29yZS9jb25maWcuanMnO1xuaW1wb3J0IHsgYm9va0luUGFnZSwgdHlwZSBJblBhZ2VSZXN1bHQgfSBmcm9tICcuL2luamVjdGVkLmpzJztcblxuY29uc3QgQUxBUk0gPSAnY29tZWVuLXRvcC11cCc7XG5jb25zdCBDT01FRU5fVVJMID0gJ2h0dHBzOi8vbXkuY29tZWVuLmlvLyc7XG5jb25zdCBUQUJfTUFUQ0ggPSAnaHR0cHM6Ly9teS5jb21lZW4uaW8vKic7XG5jb25zdCBTSUdORURfT1VUX05PVElGSUNBVElPTiA9ICdjb21lZW4tc2lnbmVkLW91dCc7XG5cbi8qKlxuICogVGhyb3duIHdoZW4gdGhlIHNlc3Npb24gaXMgZ29uZSwgc28gdGhlIGNhbGxlciBjYW4gdGVsbCBpdCBhcGFydCBmcm9tIGFuXG4gKiBvcmRpbmFyeSBmYWlsdXJlIGJ5IHR5cGUgcmF0aGVyIHRoYW4gYnkgcmVhZGluZyB0aGUgbWVzc2FnZSB0ZXh0LlxuICovXG5jbGFzcyBTaWduZWRPdXRFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbmV4cG9ydCBpbnRlcmZhY2UgUnVuTG9nIHtcbiAgICBhdDogc3RyaW5nO1xuICAgIGRyeVJ1bjogYm9vbGVhbjtcbiAgICBkYXRlczogc3RyaW5nW107XG4gICAgcm93czogSW5QYWdlUmVzdWx0Wydyb3dzJ107XG4gICAgbm90ZXM6IHN0cmluZ1tdO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICAgIC8qKiBUaGUgcnVuIHN0b3BwZWQgYmVjYXVzZSB0aGUgQ29tZWVuIHNlc3Npb24gaGFzIGV4cGlyZWQuICovXG4gICAgc2lnbmVkT3V0PzogYm9vbGVhbjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBwZW5kTG9nKGVudHJ5OiBSdW5Mb2cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IHJ1bnMgPSBbXSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdydW5zJykgYXMgeyBydW5zPzogUnVuTG9nW10gfTtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBydW5zOiBbZW50cnksIC4uLnJ1bnNdLnNsaWNlKDAsIDEwKSB9KTtcbn1cblxuLyoqXG4gKiBGaW5kIGEgQ29tZWVuIHRhYiwgb3Igb3BlbiBvbmUgaW4gdGhlIGJhY2tncm91bmQuXG4gKiBSZXR1cm5zIHRoZSB0YWIgaWQgcGx1cyB3aGV0aGVyIHdlIGNyZWF0ZWQgaXQgKGFuZCBzaG91bGQgdGhlcmVmb3JlIGNsb3NlIGl0KS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0Q29tZWVuVGFiKCk6IFByb21pc2U8eyB0YWJJZDogbnVtYmVyOyB0ZW1wb3Jhcnk6IGJvb2xlYW4gfT4ge1xuICAgIGNvbnN0IG9wZW4gPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IHVybDogVEFCX01BVENIIH0pO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gb3Blbi5maW5kKCh0KSA9PiB0eXBlb2YgdC5pZCA9PT0gJ251bWJlcicgJiYgdC5zdGF0dXMgPT09ICdjb21wbGV0ZScpXG4gICAgICAgID8/IG9wZW4uZmluZCgodCkgPT4gdHlwZW9mIHQuaWQgPT09ICdudW1iZXInKTtcbiAgICBpZiAoZXhpc3Rpbmc/LmlkICE9PSB1bmRlZmluZWQpIHJldHVybiB7IHRhYklkOiBleGlzdGluZy5pZCwgdGVtcG9yYXJ5OiBmYWxzZSB9O1xuXG4gICAgY29uc3QgdGFiID0gYXdhaXQgY2hyb21lLnRhYnMuY3JlYXRlKHsgdXJsOiBDT01FRU5fVVJMLCBhY3RpdmU6IGZhbHNlIH0pO1xuICAgIGlmICh0YWIuaWQgPT09IHVuZGVmaW5lZCkgdGhyb3cgbmV3IEVycm9yKCdDb3VsZCBub3Qgb3BlbiBhIENvbWVlbiB0YWIuJyk7XG4gICAgYXdhaXQgd2FpdEZvckxvYWQodGFiLmlkKTtcblxuICAgIC8vIEFuIGV4cGlyZWQgc2Vzc2lvbiByZWRpcmVjdHMgbXkuY29tZWVuLmlvIHRvIGFjY291bnRzLmNvbWVlbi5pbywgd2hpY2ggaXNcbiAgICAvLyBkZWxpYmVyYXRlbHkgbm90IGluIGhvc3RfcGVybWlzc2lvbnMgXHUyMDE0IHNvIGV4ZWN1dGVTY3JpcHQgd291bGQgZmFpbCB0aGVyZVxuICAgIC8vIHdpdGggYSBwZXJtaXNzaW9ucyBlcnJvciB0aGF0IHNheXMgbm90aGluZyBhYm91dCB0aGUgYWN0dWFsIHByb2JsZW0uXG4gICAgLy8gQ2hlY2tpbmcgdGhlIFVSTCB0dXJucyB0aGF0IGludG8gYSBzZW50ZW5jZSB3b3J0aCByZWFkaW5nLlxuICAgIGNvbnN0IGxvYWRlZCA9IGF3YWl0IGNocm9tZS50YWJzLmdldCh0YWIuaWQpO1xuICAgIGlmIChsb2FkZWQudXJsICYmICFsb2FkZWQudXJsLnN0YXJ0c1dpdGgoQ09NRUVOX1VSTCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFNpZ25lZE91dEVycm9yKFxuICAgICAgICAgICAgJ05vdCBzaWduZWQgaW4gdG8gQ29tZWVuICh0aGUgcGFnZSByZWRpcmVjdGVkIHRvIHNpZ24taW4pLiAnXG4gICAgICAgICAgICArICdPcGVuIGh0dHBzOi8vbXkuY29tZWVuLmlvLywgc2lnbiBpbiwgdGhlbiBydW4gYWdhaW4uJyxcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICByZXR1cm4geyB0YWJJZDogdGFiLmlkLCB0ZW1wb3Jhcnk6IHRydWUgfTtcbn1cblxuZnVuY3Rpb24gd2FpdEZvckxvYWQodGFiSWQ6IG51bWJlciwgdGltZW91dE1zID0gMzBfMDAwKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIGNocm9tZS50YWJzLm9uVXBkYXRlZC5yZW1vdmVMaXN0ZW5lcihsaXN0ZW5lcik7XG4gICAgICAgICAgICByZWplY3QobmV3IEVycm9yKCdDb21lZW4gdGFiIGRpZCBub3QgZmluaXNoIGxvYWRpbmcgaW4gdGltZS4nKSk7XG4gICAgICAgIH0sIHRpbWVvdXRNcyk7XG5cbiAgICAgICAgY29uc3QgbGlzdGVuZXIgPSAoaWQ6IG51bWJlciwgaW5mbzogY2hyb21lLnRhYnMuVGFiQ2hhbmdlSW5mbyk6IHZvaWQgPT4ge1xuICAgICAgICAgICAgaWYgKGlkICE9PSB0YWJJZCB8fCBpbmZvLnN0YXR1cyAhPT0gJ2NvbXBsZXRlJykgcmV0dXJuO1xuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgICAgIGNocm9tZS50YWJzLm9uVXBkYXRlZC5yZW1vdmVMaXN0ZW5lcihsaXN0ZW5lcik7XG4gICAgICAgICAgICAvLyBUaGUgU1BBIG5lZWRzIGEgbW9tZW50IGFmdGVyIGBjb21wbGV0ZWAgYmVmb3JlIGl0cyBhdXRoIHN0YXRlIGlzIHJlYWR5LlxuICAgICAgICAgICAgc2V0VGltZW91dChyZXNvbHZlLCAyXzUwMCk7XG4gICAgICAgIH07XG4gICAgICAgIGNocm9tZS50YWJzLm9uVXBkYXRlZC5hZGRMaXN0ZW5lcihsaXN0ZW5lcik7XG4gICAgfSk7XG59XG5cbmxldCBpbkZsaWdodDogUHJvbWlzZTxSdW5Mb2c+IHwgdW5kZWZpbmVkO1xuXG4vKipcbiAqIE9uZSBydW4gYXQgYSB0aW1lLiBUd28gb3ZlcmxhcHBpbmcgcnVucyB3b3VsZCBlYWNoIHJlYWQgdGhlIGJvb2tpbmdzIGxpc3RcbiAqIGJlZm9yZSB0aGUgb3RoZXIgaGFkIHdyaXR0ZW4gYW55dGhpbmcsIHNvIGJvdGggd291bGQgZGVjaWRlIHRoZSBzYW1lIGRheSB3YXNcbiAqIGZyZWUgYW5kIGJvdGggd291bGQgdHJ5IHRvIGJvb2sgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydW5Cb29raW5nKGRyeVJ1bjogYm9vbGVhbik6IFByb21pc2U8UnVuTG9nPiB7XG4gICAgaWYgKGluRmxpZ2h0KSByZXR1cm4gaW5GbGlnaHQ7XG4gICAgaW5GbGlnaHQgPSBydW5Cb29raW5nT25jZShkcnlSdW4pLmZpbmFsbHkoKCkgPT4geyBpbkZsaWdodCA9IHVuZGVmaW5lZDsgfSk7XG4gICAgcmV0dXJuIGluRmxpZ2h0O1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5Cb29raW5nT25jZShkcnlSdW46IGJvb2xlYW4pOiBQcm9taXNlPFJ1bkxvZz4ge1xuICAgIGNvbnN0IHNldHRpbmdzOiBTZXR0aW5ncyA9IGF3YWl0IGxvYWRTZXR0aW5ncygpO1xuXG4gICAgY29uc3QgZGF0ZXMgPSBkYXRlc1RvQm9vayh7XG4gICAgICAgIHdlZWtkYXlzOiBzZXR0aW5ncy53ZWVrZGF5cyxcbiAgICAgICAgaG9yaXpvbkRheXM6IHNldHRpbmdzLmhvcml6b25EYXlzLFxuICAgICAgICBza2lwRGF0ZXM6IHNldHRpbmdzLnNraXBEYXRlcyxcbiAgICAgICAgdGltZVpvbmU6IHNldHRpbmdzLnRpbWVab25lLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYmFzZTogUnVuTG9nID0geyBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBkcnlSdW4sIGRhdGVzLCByb3dzOiBbXSwgbm90ZXM6IFtdIH07XG5cbiAgICBpZiAoZGF0ZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0geyAuLi5iYXNlLCBub3RlczogWydObyBjYW5kaWRhdGUgZGF0ZXMgaW4gdGhlIGhvcml6b24uJ10gfTtcbiAgICAgICAgYXdhaXQgYXBwZW5kTG9nKGVudHJ5KTtcbiAgICAgICAgYXdhaXQgcmVmbGVjdFJ1bihlbnRyeSk7XG4gICAgICAgIHJldHVybiBlbnRyeTtcbiAgICB9XG5cbiAgICBpZiAoIXNldHRpbmdzLmRlc2tOYW1lICYmICFzZXR0aW5ncy5kZXNrSWQpIHtcbiAgICAgICAgY29uc3QgZW50cnkgPSB7IC4uLmJhc2UsIGVycm9yOiAnUGljayB5b3VyIGRlc2sgaW4gdGhlIHBvcHVwIGZpcnN0ICh0aGUgbnVtYmVyIG9uIGl0LCBsaWtlIDMtMjMpLicgfTtcbiAgICAgICAgYXdhaXQgYXBwZW5kTG9nKGVudHJ5KTtcbiAgICAgICAgYXdhaXQgcmVmbGVjdFJ1bihlbnRyeSk7XG4gICAgICAgIHJldHVybiBlbnRyeTtcbiAgICB9XG5cbiAgICAvLyBUaGUgcG9wdXAgZ2F0ZXMgaXRzIG93biBidXR0b25zIG9uIHRoaXMsIGJ1dCBhbiBhdXRvbWF0aWMgcnVuIHJlYWRzXG4gICAgLy8gc3RyYWlnaHQgZnJvbSBzdG9yYWdlIFx1MjAxNCB3aGljaCBjb3VsZCBob2xkIGEgYmFkIHZhbHVlIHNhdmVkIGJ5IGFuIG9sZGVyXG4gICAgLy8gYnVpbGQsIG9yIGVkaXRlZCBieSBoYW5kLiBDaGVja2luZyBoZXJlIGlzIHdoYXQgbWFrZXMgdGhlIHJ1bGUgcmVhbC5cbiAgICBpZiAoc2V0dGluZ3MuZGVza05hbWUgJiYgIWlzVmFsaWREZXNrTmFtZShzZXR0aW5ncy5kZXNrTmFtZSkpIHtcbiAgICAgICAgY29uc3QgZW50cnkgPSB7XG4gICAgICAgICAgICAuLi5iYXNlLFxuICAgICAgICAgICAgZXJyb3I6IGBcIiR7c2V0dGluZ3MuZGVza05hbWV9XCIgaXMgbm90IGEgZGVzayBudW1iZXIuIEl0IHNob3VsZCBiZSBkaWdpdHMsIGEgZGFzaCwgYFxuICAgICAgICAgICAgICAgICsgJ2RpZ2l0cyBcdTIwMTQgbGlrZSAzLTIzLicsXG4gICAgICAgIH07XG4gICAgICAgIGF3YWl0IGFwcGVuZExvZyhlbnRyeSk7XG4gICAgICAgIGF3YWl0IHJlZmxlY3RSdW4oZW50cnkpO1xuICAgICAgICByZXR1cm4gZW50cnk7XG4gICAgfVxuXG4gICAgbGV0IHRlbXBvcmFyeSA9IGZhbHNlO1xuICAgIGxldCB0YWJJZDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdGFiID0gYXdhaXQgZ2V0Q29tZWVuVGFiKCk7XG4gICAgICAgIHRhYklkID0gdGFiLnRhYklkO1xuICAgICAgICB0ZW1wb3JhcnkgPSB0YWIudGVtcG9yYXJ5O1xuXG4gICAgICAgIGNvbnN0IFtyZXN1bHRdID0gYXdhaXQgY2hyb21lLnNjcmlwdGluZy5leGVjdXRlU2NyaXB0KHtcbiAgICAgICAgICAgIHRhcmdldDogeyB0YWJJZCB9LFxuICAgICAgICAgICAgd29ybGQ6ICdNQUlOJyxcbiAgICAgICAgICAgIGZ1bmM6IGJvb2tJblBhZ2UsXG4gICAgICAgICAgICBhcmdzOiBbe1xuICAgICAgICAgICAgICAgIGVuZHBvaW50OiBzZXR0aW5ncy5lbmRwb2ludCxcbiAgICAgICAgICAgICAgICBkYXRlcyxcbiAgICAgICAgICAgICAgICBkZXNrTmFtZTogc2V0dGluZ3MuZGVza05hbWUsXG4gICAgICAgICAgICAgICAgZGVza0lkOiBzZXR0aW5ncy5kZXNrSWQsXG4gICAgICAgICAgICAgICAgc2xvdDogc2V0dGluZ3Muc2xvdCxcbiAgICAgICAgICAgICAgICBjYW5jZWxEYXRlczogc2V0dGluZ3MuY2FuY2VsRGF0ZXMsXG4gICAgICAgICAgICAgICAgLy8gUmVzb2x2ZWQgb3V0IGhlcmUgc28gdGhlIHNsb3QtdG8tdGltZXMgdGFibGUgc3RheXMgdGVzdGFibGVcbiAgICAgICAgICAgICAgICAvLyBpbnN0ZWFkIG9mIGJlaW5nIGlubGluZWQgaW50byB0aGUgc2VyaWFsaXplZCBwYWdlIGZ1bmN0aW9uLlxuICAgICAgICAgICAgICAgIHN0YXJ0VGltZTogU0xPVF9USU1FU1tzZXR0aW5ncy5zbG90XS5zdGFydCxcbiAgICAgICAgICAgICAgICBlbmRUaW1lOiBTTE9UX1RJTUVTW3NldHRpbmdzLnNsb3RdLmVuZCxcbiAgICAgICAgICAgICAgICBmbG9vcklkOiBzZXR0aW5ncy5mbG9vcklkLFxuICAgICAgICAgICAgICAgIGJ1aWxkaW5nSWQ6IHNldHRpbmdzLmJ1aWxkaW5nSWQsXG4gICAgICAgICAgICAgICAgZHJ5UnVuLFxuICAgICAgICAgICAgfV0sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVzdWx0Py5yZXN1bHQgYXMgSW5QYWdlUmVzdWx0IHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIC8vIFNldHRpbmdzIGNoYW5nZXMgdGhlIHJ1biBpdHNlbGYgaW1wbGllcy4gQmF0Y2hlZCBpbnRvIG9uZSB3cml0ZSBzbyBhXG4gICAgICAgIC8vIHJlc29sdmVkIGRlc2sgaWQgYW5kIGEgY29tcGxldGVkIGNhbmNlbGxhdGlvbiBjYW5ub3QgY2xvYmJlciBlYWNoXG4gICAgICAgIC8vIG90aGVyLlxuICAgICAgICBjb25zdCB1cGRhdGVzOiBQYXJ0aWFsPFNldHRpbmdzPiA9IHt9O1xuICAgICAgICBpZiAodmFsdWU/LnJlc29sdmVkRGVza0lkICYmIHZhbHVlLnJlc29sdmVkRGVza0lkICE9PSBzZXR0aW5ncy5kZXNrSWQpIHtcbiAgICAgICAgICAgIHVwZGF0ZXMuZGVza0lkID0gdmFsdWUucmVzb2x2ZWREZXNrSWQ7XG4gICAgICAgIH1cbiAgICAgICAgLy8gQSBjYW5jZWxsYXRpb24gaXMgYSBvbmUtc2hvdCBpbnN0cnVjdGlvbi4gTGVhdmluZyBhIGZpbmlzaGVkIG9uZSBpblxuICAgICAgICAvLyBwbGFjZSBtZWFucyBldmVyeSBsYXRlciBhdXRvbWF0aWMgcnVuIHRyaWVzIHRvIGRlbGV0ZSBpdCBhZ2Fpbi5cbiAgICAgICAgaWYgKCFkcnlSdW4gJiYgdmFsdWU/LmNhbmNlbGxlZD8ubGVuZ3RoKSB7XG4gICAgICAgICAgICBjb25zdCBkb25lID0gbmV3IFNldCh2YWx1ZS5jYW5jZWxsZWQpO1xuICAgICAgICAgICAgdXBkYXRlcy5jYW5jZWxEYXRlcyA9IHNldHRpbmdzLmNhbmNlbERhdGVzLmZpbHRlcigoZGF0ZSkgPT4gIWRvbmUuaGFzKGRhdGUpKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoT2JqZWN0LmtleXModXBkYXRlcykubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKHsgLi4uc2V0dGluZ3MsIC4uLnVwZGF0ZXMgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBlbnRyeTogUnVuTG9nID0ge1xuICAgICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICAgIHJvd3M6IHZhbHVlPy5yb3dzID8/IFtdLFxuICAgICAgICAgICAgbm90ZXM6IHZhbHVlPy5ub3RlcyA/PyBbJ1RoZSBpbi1wYWdlIHNjcmlwdCByZXR1cm5lZCBub3RoaW5nLiddLFxuICAgICAgICAgICAgc2lnbmVkT3V0OiB2YWx1ZT8uc2lnbmVkT3V0ID09PSB0cnVlLFxuICAgICAgICB9O1xuICAgICAgICBhd2FpdCBhcHBlbmRMb2coZW50cnkpO1xuICAgICAgICBhd2FpdCByZWZsZWN0UnVuKGVudHJ5KTtcbiAgICAgICAgcmV0dXJuIGVudHJ5O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBlbnRyeTogUnVuTG9nID0ge1xuICAgICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgICAgICBzaWduZWRPdXQ6IGVyciBpbnN0YW5jZW9mIFNpZ25lZE91dEVycm9yLFxuICAgICAgICB9O1xuICAgICAgICBhd2FpdCBhcHBlbmRMb2coZW50cnkpO1xuICAgICAgICBhd2FpdCByZWZsZWN0UnVuKGVudHJ5KTtcbiAgICAgICAgcmV0dXJuIGVudHJ5O1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIC8vIE9ubHkgY2xvc2Ugd2hhdCB3ZSBvcGVuZWQuIE5ldmVyIGNsb3NlIGEgdGFiIHRoZSB1c2VyIHdhcyB1c2luZy5cbiAgICAgICAgaWYgKHRlbXBvcmFyeSAmJiB0YWJJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICB0cnkgeyBhd2FpdCBjaHJvbWUudGFicy5yZW1vdmUodGFiSWQpOyB9IGNhdGNoIHsgLyogYWxyZWFkeSBnb25lICovIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiBTaG93IHRoZSBvdXRjb21lIG9mIGEgcnVuIHNvbWV3aGVyZSB0aGUgdXNlciB3aWxsIGFjdHVhbGx5IHNlZSBpdC5cbiAqXG4gKiBFdmVyeXRoaW5nIGJlZm9yZSB0aGlzIHdhcyB3cml0dGVuIGludG8gY2hyb21lLnN0b3JhZ2UgYW5kIHJlbmRlcmVkIG9ubHkgaWZcbiAqIHlvdSBvcGVuZWQgdGhlIHBvcHVwIFx1MjAxNCBzbyBhbiBhdXRvbWF0aWMgcnVuIHRoYXQgZmFpbGVkIGF0IDNhbSB3YXMsIGluXG4gKiBwcmFjdGljZSwgc2lsZW50LiBBbiBhdXRvbWF0aW9uIHlvdSBjYW5ub3QgdGVsbCBoYXMgc3RvcHBlZCBpcyB3b3JzZSB0aGFuIG5vXG4gKiBhdXRvbWF0aW9uLCBiZWNhdXNlIHlvdSBzdG9wIGNoZWNraW5nLlxuICpcbiAqIFRoZSBiYWRnZSBtZWFucyBcInRoZXJlIGlzIGEgZmFpbHVyZSB5b3UgaGF2ZSBub3QgcmVhZCB5ZXRcIiwgbm90IFwidGhlIGxhc3QgcnVuXG4gKiBmYWlsZWRcIi4gVGhlIGRpZmZlcmVuY2UgbWF0dGVyczogcmVhZCBhcyB0aGUgbGF0dGVyLCBhIGJhZGdlIHJhaXNlZCBieSBhXG4gKiBzaWduZWQtb3V0IHJ1biBzdGF5ZWQgbGl0IGFmdGVyIHlvdSBzaWduZWQgaW4gYW5kIHByZXZpZXdlZCBzdWNjZXNzZnVsbHksXG4gKiB3aXRoIG5vIHdheSB0byBkaXNtaXNzIGl0LCBiZWNhdXNlIG9ubHkgYSBzdWNjZXNzZnVsIHJlYWwgcnVuIGNsZWFyZWQgaXQuXG4gKiBBdXRvbWF0aWMgc3dpdGNoZWQgb2ZmLCBhbmQgaXQgc3RheWVkIGxpdCBmb3IgZ29vZC4gT3BlbmluZyB0aGUgcG9wdXAgaXMgd2hhdFxuICogbWFya3MgaXQgcmVhZCBcdTIwMTQgc2VlIGNsZWFyRmFpbHVyZUJhZGdlLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWZsZWN0UnVuKGVudHJ5OiBSdW5Mb2cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBmYWlsZWQgPSBCb29sZWFuKGVudHJ5LmVycm9yKSB8fCBlbnRyeS5yb3dzLnNvbWUoKHJvdykgPT4gcm93LnN0YXR1cyA9PT0gJ2Vycm9yJyk7XG5cbiAgICAvLyBBIHByZXZpZXcgY2Fubm90IGV4ZXJjaXNlIHRoZSBjcmVhdGUgY2FsbCwgc28gYSBjbGVhbiBvbmUgaXMgbm90IHByb29mXG4gICAgLy8gdGhhdCBib29raW5nIHdvcmtzIGFuZCBtdXN0IG5vdCBjbGVhciBhIHJlYWwgZmFpbHVyZS4gSXQgY2FuIHN0aWxsIHJhaXNlXG4gICAgLy8gdGhlIGJhZGdlOiB3aGF0ZXZlciBpdCBoaXQgXHUyMDE0IHNpZ25lZCBvdXQsIGJhZCBkZXNrLCBBUEkgZG93biBcdTIwMTQgaXMgcmVhbC5cbiAgICBpZiAoZW50cnkuZHJ5UnVuICYmICFmYWlsZWQpIHJldHVybjtcblxuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VUZXh0KHsgdGV4dDogZmFpbGVkID8gJyEnIDogJycgfSk7XG4gICAgaWYgKGZhaWxlZCkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEJhZGdlQmFja2dyb3VuZENvbG9yKHsgY29sb3I6ICcjYjkxYzFjJyB9KTtcbiAgICB9XG5cbiAgICBpZiAoZW50cnkuc2lnbmVkT3V0KSB7XG4gICAgICAgIC8vIEZpeGVkIGlkLCBzbyBhIHNlc3Npb24gdGhhdCBzdGF5cyBleHBpcmVkIGFjcm9zcyBzZXZlcmFsIHJ1bnNcbiAgICAgICAgLy8gcmVwbGFjZXMgaXRzIG93biBub3RpZmljYXRpb24gaW5zdGVhZCBvZiBzdGFja2luZyB1cC5cbiAgICAgICAgY2hyb21lLm5vdGlmaWNhdGlvbnMuY3JlYXRlKFNJR05FRF9PVVRfTk9USUZJQ0FUSU9OLCB7XG4gICAgICAgICAgICB0eXBlOiAnYmFzaWMnLFxuICAgICAgICAgICAgaWNvblVybDogY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdpY29uLTEyOC5wbmcnKSxcbiAgICAgICAgICAgIHRpdGxlOiAnQ29tZWVuIGRlc2sgYm9va2VyJyxcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdZb3VyIENvbWVlbiBzZXNzaW9uIGV4cGlyZWQuIENsaWNrIGhlcmUgdG8gc2lnbiBpbiBcdTIwMTQgYm9va2luZyByZXN1bWVzIG9uICdcbiAgICAgICAgICAgICAgICArICdpdHMgb3duIG9uY2UgeW91IGFyZSBiYWNrLicsXG4gICAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAoIWVudHJ5LmRyeVJ1bikge1xuICAgICAgICBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihTSUdORURfT1VUX05PVElGSUNBVElPTik7XG4gICAgfVxufVxuXG4vKipcbiAqIE1hcmsgdGhlIGZhaWx1cmUgYXMgcmVhZC4gQ2FsbGVkIHdoZW4gdGhlIHBvcHVwIG9wZW5zLCBiZWNhdXNlIHRoYXQgaXMgd2hlcmVcbiAqIHRoZSBkZXRhaWwgbGl2ZXM6IGlmIHlvdSBoYXZlIGxvb2tlZCBhdCBMYXN0IHJ1biwgeW91IGtub3cuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNsZWFyRmFpbHVyZUJhZGdlKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VUZXh0KHsgdGV4dDogJycgfSk7XG59XG5cbi8qKlxuICogU2lnbmluZyBiYWNrIGluIGlzIHRoZSBmaXgsIHNvIG5vdGljaW5nIHRoYXQgeW91IGhhdmUgaXMgdGhlIHdob2xlIGZlYXR1cmU6XG4gKiB0aGUgbmV4dCB0aW1lIGEgQ29tZWVuIHBhZ2UgZmluaXNoZXMgbG9hZGluZyBhZnRlciBhIHNpZ25lZC1vdXQgZmFpbHVyZSwgdGhlXG4gKiBtaXNzZWQgcnVuIGhhcHBlbnMgYnkgaXRzZWxmLiBObyBidXR0b24gdG8gZmluZCwgbm8gbm90aWZpY2F0aW9uIHRvIGFjdCBvbi5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmV0cnlBZnRlclNpZ25JbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IHJ1bnMgPSBbXSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdydW5zJykgYXMgeyBydW5zPzogUnVuTG9nW10gfTtcbiAgICBpZiAocnVuc1swXT8uc2lnbmVkT3V0ICE9PSB0cnVlKSByZXR1cm47XG5cbiAgICAvLyBPbmx5IHRoZSBhdXRvbWF0aWMgcGF0aCBzZWxmLWhlYWxzLiBJZiBhdXRvbWF0aWMgaXMgb2ZmLCBldmVyeSBydW4gaXNcbiAgICAvLyBzb21ldGhpbmcgdGhlIHVzZXIgYXNrZWQgZm9yLCBhbmQgYSBzdXJwcmlzZSBib29raW5nIHdvdWxkIG5vdCBiZS5cbiAgICBjb25zdCBzZXR0aW5ncyA9IGF3YWl0IGxvYWRTZXR0aW5ncygpO1xuICAgIGlmICghc2V0dGluZ3MuZW5hYmxlZCkgcmV0dXJuO1xuXG4gICAgY29uc29sZS5pbmZvKCdbY29tZWVuXSBzaWduZWQgYmFjayBpbiBcdTIwMTQgcmV0cnlpbmcgdGhlIHJ1biB0aGF0IGZhaWxlZCcpO1xuICAgIGF3YWl0IHJ1bkJvb2tpbmcoZmFsc2UpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVBbGFybSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGNocm9tZS5hbGFybXMuZ2V0KEFMQVJNKTtcbiAgICBpZiAoZXhpc3RpbmcpIHJldHVybjtcbiAgICAvLyBFdmVyeSA2IGhvdXJzLiBUaGUgMTQtZGF5IGJvb2tpbmcgaG9yaXpvbiBtZWFucyBwcmVjaXNpb24gZG9lcyBub3QgbWF0dGVyOlxuICAgIC8vIGFueSBydW4gdG9wcyB0aGUgd2hvbGUgd2luZG93IGJhY2sgdXAsIHNvIGEgbWlzc2VkIGZpcmluZyBjb3N0cyBub3RoaW5nLlxuICAgIGF3YWl0IGNocm9tZS5hbGFybXMuY3JlYXRlKEFMQVJNLCB7IHBlcmlvZEluTWludXRlczogMzYwLCBkZWxheUluTWludXRlczogMSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuSWZFbmFibGVkKHJlYXNvbjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3Qgc2V0dGluZ3MgPSBhd2FpdCBsb2FkU2V0dGluZ3MoKTtcbiAgICBpZiAoIXNldHRpbmdzLmVuYWJsZWQpIHJldHVybjtcbiAgICBjb25zb2xlLmluZm8oYFtjb21lZW5dIHJ1bm5pbmcgKCR7cmVhc29ufSlgKTtcbiAgICBhd2FpdCBydW5Cb29raW5nKGZhbHNlKTtcbn1cblxuY2hyb21lLnJ1bnRpbWUub25JbnN0YWxsZWQuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICAgIHZvaWQgZW5zdXJlQWxhcm0oKTtcbn0pO1xuXG4vLyBDaHJvbWUgd2FzIGp1c3Qgc3RhcnRlZDogY2F0Y2ggdXAgaW1tZWRpYXRlbHkgcmF0aGVyIHRoYW4gd2FpdGluZyBmb3IgdGhlIGFsYXJtLlxuY2hyb21lLnJ1bnRpbWUub25TdGFydHVwLmFkZExpc3RlbmVyKCgpID0+IHtcbiAgICB2b2lkIGVuc3VyZUFsYXJtKCk7XG4gICAgdm9pZCBydW5JZkVuYWJsZWQoJ2Jyb3dzZXIgc3RhcnR1cCcpO1xufSk7XG5cbmNocm9tZS5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcigoYWxhcm0pID0+IHtcbiAgICBpZiAoYWxhcm0ubmFtZSAhPT0gQUxBUk0pIHJldHVybjtcbiAgICB2b2lkIHJ1bklmRW5hYmxlZCgnYWxhcm0nKTtcbn0pO1xuXG5jaHJvbWUudGFicy5vblVwZGF0ZWQuYWRkTGlzdGVuZXIoKF90YWJJZCwgaW5mbywgdGFiKSA9PiB7XG4gICAgaWYgKGluZm8uc3RhdHVzICE9PSAnY29tcGxldGUnKSByZXR1cm47XG4gICAgaWYgKCF0YWIudXJsPy5zdGFydHNXaXRoKENPTUVFTl9VUkwpKSByZXR1cm47XG4gICAgdm9pZCByZXRyeUFmdGVyU2lnbkluKCk7XG59KTtcblxuY2hyb21lLm5vdGlmaWNhdGlvbnMub25DbGlja2VkLmFkZExpc3RlbmVyKChpZCkgPT4ge1xuICAgIGlmIChpZCAhPT0gU0lHTkVEX09VVF9OT1RJRklDQVRJT04pIHJldHVybjtcbiAgICB2b2lkIGNocm9tZS50YWJzLmNyZWF0ZSh7IHVybDogQ09NRUVOX1VSTCB9KTtcbiAgICBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihTSUdORURfT1VUX05PVElGSUNBVElPTik7XG59KTtcblxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlOiB7IHR5cGU/OiBzdHJpbmc7IGRyeVJ1bj86IGJvb2xlYW4gfSwgX3NlbmRlciwgcmVzcG9uZCkgPT4ge1xuICAgIGlmIChtZXNzYWdlPy50eXBlID09PSAncG9wdXAtb3BlbmVkJykge1xuICAgICAgICB2b2lkIGNsZWFyRmFpbHVyZUJhZGdlKCk7XG4gICAgICAgIHJlc3BvbmQoeyBvazogdHJ1ZSB9KTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ3J1bicpIHtcbiAgICAgICAgcnVuQm9va2luZyhtZXNzYWdlLmRyeVJ1biA/PyBmYWxzZSlcbiAgICAgICAgICAgIC50aGVuKChsb2cpID0+IHJlc3BvbmQoeyBvazogdHJ1ZSwgbG9nIH0pKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IHJlc3BvbmQoe1xuICAgICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICAgICAgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTsgLy8ga2VlcCB0aGUgY2hhbm5lbCBvcGVuIGZvciB0aGUgYXN5bmMgcmVzcG9uc2VcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBSUEsSUFBTSxnQkFBb0M7QUFBQSxFQUN0QztBQUFBLEVBQVU7QUFBQSxFQUFVO0FBQUEsRUFBVztBQUFBLEVBQWE7QUFBQSxFQUFZO0FBQUEsRUFBVTtBQUN0RTtBQUVBLFNBQVMsVUFBVSxPQUFpQztBQUNoRCxTQUFRLGNBQW9DLFNBQVMsS0FBSztBQUM5RDtBQUdPLFNBQVMsZUFBZSxNQUFZLFVBQTBCO0FBQ2pFLFNBQU8sSUFBSSxLQUFLLGVBQWUsU0FBUztBQUFBLElBQ3BDO0FBQUEsSUFBVSxNQUFNO0FBQUEsSUFBVyxPQUFPO0FBQUEsSUFBVyxLQUFLO0FBQUEsRUFDdEQsQ0FBQyxFQUFFLE9BQU8sSUFBSTtBQUNsQjtBQUdPLFNBQVMsYUFBYSxNQUFZLFVBQTJCO0FBQ2hFLFFBQU0sT0FBTyxJQUFJLEtBQUssZUFBZSxTQUFTLEVBQUUsVUFBVSxTQUFTLE9BQU8sQ0FBQyxFQUN0RSxPQUFPLElBQUksRUFDWCxZQUFZO0FBQ2pCLE1BQUksQ0FBQyxVQUFVLElBQUksRUFBRyxPQUFNLElBQUksTUFBTSxrQ0FBa0MsSUFBSSxHQUFHO0FBQy9FLFNBQU87QUFDWDtBQWtCTyxTQUFTLFlBQVk7QUFBQSxFQUN4QjtBQUFBLEVBQ0EsY0FBYztBQUFBLEVBQ2QsWUFBWSxDQUFDO0FBQUEsRUFDYixXQUFXO0FBQUEsRUFDWCxNQUFNLG9CQUFJLEtBQUs7QUFDbkIsR0FBaUM7QUFDN0IsUUFBTSxTQUFTLG9CQUFJLElBQWE7QUFDaEMsYUFBVyxPQUFPLFVBQVU7QUFDeEIsVUFBTSxPQUFPLElBQUksWUFBWTtBQUM3QixRQUFJLENBQUMsVUFBVSxJQUFJLEVBQUcsT0FBTSxJQUFJLE1BQU0sd0JBQXdCLEdBQUcsR0FBRztBQUNwRSxXQUFPLElBQUksSUFBSTtBQUFBLEVBQ25CO0FBRUEsUUFBTSxPQUFPLElBQUksSUFBSSxTQUFTO0FBQzlCLFFBQU0sTUFBZ0IsQ0FBQztBQUV2QixXQUFTLFNBQVMsR0FBRyxVQUFVLGFBQWEsVUFBVSxHQUFHO0FBQ3JELFVBQU0sTUFBTSxJQUFJLEtBQUssSUFBSSxRQUFRLElBQUksU0FBUyxLQUFVO0FBQ3hELFVBQU0sTUFBTSxlQUFlLEtBQUssUUFBUTtBQUN4QyxRQUFJLENBQUMsT0FBTyxJQUFJLGFBQWEsS0FBSyxRQUFRLENBQUMsRUFBRztBQUM5QyxRQUFJLEtBQUssSUFBSSxHQUFHLEVBQUc7QUFDbkIsUUFBSSxLQUFLLEdBQUc7QUFBQSxFQUNoQjtBQUVBLFNBQU87QUFDWDs7O0FDK0ZPLElBQU0sYUFBMkQ7QUFBQSxFQUNwRSxTQUFTLEVBQUUsT0FBTyxpQkFBaUIsS0FBSyxnQkFBZ0I7QUFBQSxFQUN4RCxTQUFTLEVBQUUsT0FBTyxpQkFBaUIsS0FBSyxnQkFBZ0I7QUFBQSxFQUN4RCxXQUFXLEVBQUUsT0FBTyxpQkFBaUIsS0FBSyxnQkFBZ0I7QUFDOUQ7QUFvQk8sSUFBTSxtQkFBNkI7QUFBQTtBQUFBO0FBQUEsRUFHdEMsaUJBQWlCO0FBQUEsRUFDakIsU0FBUztBQUFBO0FBQUE7QUFBQTtBQUFBLEVBSVQsVUFBVTtBQUFBLEVBQ1YsUUFBUTtBQUFBLEVBQ1IsU0FBUztBQUFBLEVBQ1QsWUFBWTtBQUFBLEVBQ1osVUFBVSxDQUFDLFVBQVUsV0FBVyxhQUFhLFlBQVksUUFBUTtBQUFBLEVBQ2pFLE1BQU07QUFBQSxFQUNOLGFBQWE7QUFBQSxFQUNiLFdBQVcsQ0FBQztBQUFBLEVBQ1osYUFBYSxDQUFDO0FBQUEsRUFDZCxVQUFVO0FBQUEsRUFDVixVQUFVO0FBQUEsSUFDTixTQUFTO0FBQUEsSUFDVCxNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsSUFDdkIsU0FBUztBQUFBLE1BQ0wsUUFBUTtBQUFBLE1BQ1IsTUFBTTtBQUFBLE1BQ04sT0FBTztBQUFBLFFBQ0gsWUFBWTtBQUFBLFFBQ1osVUFBVTtBQUFBLE1BQ2Q7QUFBQSxJQUNKO0FBQUEsSUFDQSxnQkFBZ0IsQ0FBQyxRQUFRLFNBQVM7QUFBQSxJQUNsQyxjQUFjLENBQUMsUUFBUSxJQUFJO0FBQUEsSUFDM0IsbUJBQW1CO0FBQUEsSUFDbkIsd0JBQXdCLENBQUMsa0JBQWtCLGNBQWMsUUFBUSxPQUFPLE9BQU87QUFBQSxJQUMvRSxNQUFNO0FBQUEsTUFDRixRQUFRO0FBQUEsTUFDUixNQUFNO0FBQUEsTUFDTixPQUFPO0FBQUEsUUFDSCxZQUFZO0FBQUEsUUFDWixVQUFVO0FBQUEsTUFDZDtBQUFBLElBQ0o7QUFBQSxJQUNBLFVBQVU7QUFBQSxJQUNWLFdBQVc7QUFBQSxJQUNYLGdCQUFnQixDQUFDLGtCQUFrQixNQUFNO0FBQUEsSUFDekMsWUFBWTtBQUFBLElBQ1oscUJBQXFCLENBQUMsTUFBTSxNQUFNO0FBQUEsSUFDbEMsUUFBUTtBQUFBLE1BQ0osUUFBUTtBQUFBO0FBQUE7QUFBQSxNQUdSLE1BQU07QUFBQSxNQUNOLE1BQU07QUFBQSxRQUNGLGVBQWU7QUFBQSxVQUNYLE9BQU87QUFBQSxVQUNQLGdCQUFnQjtBQUFBLFVBQ2hCLGNBQWM7QUFBQSxRQUNsQjtBQUFBLFFBQ0EsVUFBVTtBQUFBLFVBQ04sYUFBYTtBQUFBLFVBQ2IsVUFBVTtBQUFBLFVBQ1YsU0FBUztBQUFBLFFBQ2I7QUFBQSxRQUNBLGNBQWMsRUFBRSxXQUFXLGFBQWE7QUFBQSxNQUM1QztBQUFBLElBQ0o7QUFBQSxJQUNBLFFBQVE7QUFBQSxNQUNKLFFBQVE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLE1BS1IsTUFBTTtBQUFBLElBQ1Y7QUFBQSxFQUNKO0FBQ0o7QUF3Qk8sSUFBTSxvQkFBb0I7QUFHMUIsU0FBUyxnQkFBZ0IsTUFBdUI7QUFDbkQsU0FBTyxrQkFBa0IsS0FBSyxLQUFLLEtBQUssQ0FBQztBQUM3QztBQWtFTyxTQUFTLGNBQWMsUUFBaUQ7QUFDM0UsUUFBTSxnQkFBZ0IsUUFBUSxtQkFBbUI7QUFDakQsUUFBTSxpQkFBaUIsZ0JBQWdCLGlCQUFpQjtBQUV4RCxTQUFPO0FBQUEsSUFDSCxHQUFHO0FBQUEsSUFDSCxHQUFHO0FBQUEsSUFDSCxpQkFBaUIsaUJBQWlCO0FBQUEsSUFDbEMsVUFBVSxrQkFBa0IsQ0FBQyxRQUFRLFdBQy9CLGlCQUFpQixXQUNqQixPQUFPO0FBQUEsRUFDakI7QUFDSjtBQUVBLGVBQXNCLGVBQWtDO0FBQ3BELFFBQU0sU0FBUyxNQUFNLE9BQU8sUUFBUSxNQUFNLElBQUksVUFBVTtBQUN4RCxTQUFPLGNBQWMsT0FBTyxRQUF5QztBQUN6RTtBQUVBLGVBQXNCLGFBQWEsVUFBbUM7QUFDbEUsUUFBTSxPQUFPLFFBQVEsTUFBTSxJQUFJLEVBQUUsU0FBUyxDQUFDO0FBQy9DOzs7QUN4VEEsZUFBc0IsV0FBVyxNQUF5QztBQUN0RSxRQUFNLEVBQUUsVUFBVSxPQUFPLFVBQVUsTUFBTSxXQUFXLFNBQVMsT0FBTyxJQUFJO0FBQ3hFLFFBQU0sY0FBYyxLQUFLLGVBQWUsQ0FBQztBQUN6QyxRQUFNLFFBQWtCLENBQUM7QUFDekIsUUFBTSxPQUFvQixDQUFDO0FBQzNCLE1BQUksU0FBUyxLQUFLO0FBQ2xCLE1BQUk7QUFDSixNQUFJLFlBQVk7QUFNaEIsUUFBTSxhQUFhLG9CQUFJLElBQVk7QUFHbkMsUUFBTSxPQUErQjtBQUFBLElBQ2pDO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxTQUFTLE9BQU8sS0FBSyxPQUFPO0FBQUEsSUFDNUIsWUFBWSxPQUFPLEtBQUssVUFBVTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBSWxDLE1BQU0sQ0FBQyxHQUFHLE9BQU8sR0FBRyxXQUFXLEVBQUUsS0FBSyxFQUFFLENBQUMsS0FBSztBQUFBLElBQzlDLElBQUksQ0FBQyxHQUFHLE9BQU8sR0FBRyxXQUFXLEVBQUUsS0FBSyxFQUFFLElBQUksS0FBSztBQUFBLEVBQ25EO0FBSUEsUUFBTSxjQUFjLE9BQWdDO0FBQUEsSUFDaEQsS0FBSyxPQUFPLFNBQVM7QUFBQSxJQUNyQixtQkFBbUIsTUFBTTtBQUNyQixVQUFJO0FBQUUsZUFBTyxPQUFPLEtBQUssT0FBTyxZQUFZO0FBQUEsTUFBRyxRQUFRO0FBQUUsZUFBTyxDQUFDLGNBQWM7QUFBQSxNQUFHO0FBQUEsSUFDdEYsR0FBRztBQUFBLElBQ0gsY0FBYyxNQUFNO0FBQ2hCLFVBQUk7QUFDQSxlQUFPLFNBQVMsT0FBTyxNQUFNLEdBQUcsRUFDM0IsSUFBSSxDQUFDLFNBQVMsS0FBSyxNQUFNLEdBQUcsRUFBRSxDQUFDLEdBQUcsS0FBSyxLQUFLLEVBQUUsRUFDOUMsT0FBTyxPQUFPO0FBQUEsTUFDdkIsUUFBUTtBQUFFLGVBQU8sQ0FBQyxjQUFjO0FBQUEsTUFBRztBQUFBLElBQ3ZDLEdBQUc7QUFBQSxFQUNQO0FBUUEsUUFBTSxPQUFPLENBQUMsT0FBZ0IsV0FBNEM7QUFDdEUsUUFBSSxPQUFPLFVBQVUsVUFBVTtBQUMzQixZQUFNLFFBQVEsa0JBQWtCLEtBQUssS0FBSztBQUMxQyxVQUFJLE9BQU87QUFDUCxjQUFNLGNBQWMsT0FBTyxNQUFNLENBQUMsS0FBSyxFQUFFO0FBQ3pDLFlBQUksZ0JBQWdCLE9BQVcsUUFBTztBQUN0QyxlQUFPLFVBQVUsS0FBSyxXQUFXLElBQUksT0FBTyxXQUFXLElBQUk7QUFBQSxNQUMvRDtBQUNBLGFBQU8sTUFBTSxRQUFRLGtCQUFrQixDQUFDLE9BQU8sUUFBZ0IsT0FBTyxHQUFHLEtBQUssS0FBSztBQUFBLElBQ3ZGO0FBQ0EsUUFBSSxNQUFNLFFBQVEsS0FBSyxFQUFHLFFBQU8sTUFBTSxJQUFJLENBQUMsVUFBVSxLQUFLLE9BQU8sTUFBTSxDQUFDO0FBQ3pFLFFBQUksU0FBUyxPQUFPLFVBQVUsVUFBVTtBQUNwQyxZQUFNLE1BQStCLENBQUM7QUFDdEMsaUJBQVcsQ0FBQyxLQUFLLEtBQUssS0FBSyxPQUFPLFFBQVEsS0FBSyxFQUFHLEtBQUksR0FBRyxJQUFJLEtBQUssT0FBTyxNQUFNO0FBQy9FLGFBQU87QUFBQSxJQUNYO0FBQ0EsV0FBTztBQUFBLEVBQ1g7QUFFQSxRQUFNLE1BQU0sQ0FBQyxLQUFjLFNBQTBCLEtBQ2hELE1BQU0sR0FBRyxFQUNULE9BQWdCLENBQUMsU0FBUyxRQUN2QixXQUFXLE9BQU8sWUFBWSxXQUFZLFFBQW9DLEdBQUcsSUFBSSxRQUN0RixHQUFHO0FBRVYsUUFBTSxjQUFjLE1BQThCO0FBQzlDLFFBQUksU0FBUyxLQUFLLFNBQVMsZUFBZ0IsUUFBTyxDQUFDO0FBQ25ELFVBQU0sRUFBRSxZQUFZLFVBQVUsUUFBUSxPQUFPLElBQUksU0FBUztBQUMxRCxRQUFJLENBQUMsY0FBYyxDQUFDLFVBQVU7QUFDMUIsWUFBTSxLQUFLLGdFQUFnRTtBQUMzRSxhQUFPLENBQUM7QUFBQSxJQUNaO0FBQ0EsVUFBTSxNQUFNLE9BQU8sYUFBYSxRQUFRLFVBQVU7QUFDbEQsUUFBSSxDQUFDLEtBQUs7QUFDTixZQUFNLEtBQUsscUJBQXFCLFVBQVUsaUNBQWlDO0FBQzNFLGFBQU8sQ0FBQztBQUFBLElBQ1o7QUFDQSxRQUFJO0FBQ0osUUFBSTtBQUNBLGNBQVEsSUFBSSxLQUFLLE1BQU0sR0FBRyxHQUFHLFFBQVE7QUFBQSxJQUN6QyxRQUFRO0FBQ0osWUFBTSxLQUFLLHFCQUFxQixVQUFVLGdCQUFnQjtBQUMxRCxhQUFPLENBQUM7QUFBQSxJQUNaO0FBQ0EsUUFBSSxPQUFPLFVBQVUsWUFBWSxDQUFDLE9BQU87QUFDckMsWUFBTSxLQUFLLHFCQUFxQixRQUFRLElBQUk7QUFDNUMsYUFBTyxDQUFDO0FBQUEsSUFDWjtBQUNBLFdBQU8sRUFBRSxDQUFDLFVBQVUsZUFBZSxHQUFHLEdBQUcsVUFBVSxTQUFTLEdBQUcsS0FBSyxHQUFHO0FBQUEsRUFDM0U7QUFFQSxRQUFNLE9BQU8sT0FDVCxLQUNBLFdBQzRGO0FBQzVGLFVBQU0sT0FBTyxLQUFLLElBQUksTUFBTSxNQUFNO0FBQ2xDLFVBQU0sTUFBTSxJQUFJLElBQUksR0FBRyxTQUFTLFFBQVEsUUFBUSxPQUFPLEVBQUUsQ0FBQyxHQUFHLElBQUksRUFBRTtBQUNuRSxlQUFXLENBQUMsS0FBSyxLQUFLLEtBQUssT0FBTyxRQUFRLEtBQUssSUFBSSxTQUFTLENBQUMsR0FBRyxNQUFNLENBQTJCLEdBQUc7QUFDaEcsVUFBSSxhQUFhLElBQUksS0FBSyxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzNDO0FBQ0EsVUFBTSxPQUFPLElBQUksU0FBUyxTQUFZLFNBQVksS0FBSyxVQUFVLEtBQUssSUFBSSxNQUFNLE1BQU0sQ0FBQztBQUV2RixVQUFNLE1BQU0sTUFBTSxPQUFPLE1BQU0sSUFBSSxTQUFTLEdBQUc7QUFBQSxNQUMzQyxRQUFRLElBQUk7QUFBQSxNQUNaLGFBQWE7QUFBQSxNQUNiLFNBQVM7QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLEdBQUksU0FBUyxTQUFZLENBQUMsSUFBSSxFQUFFLGdCQUFnQixtQkFBbUI7QUFBQSxRQUNuRSxHQUFHLFlBQVk7QUFBQSxNQUNuQjtBQUFBLE1BQ0E7QUFBQSxJQUNKLENBQUM7QUFFRCxVQUFNLE9BQU8sTUFBTSxJQUFJLEtBQUs7QUFDNUIsUUFBSSxPQUFnQjtBQUNwQixRQUFJO0FBQUUsYUFBTyxPQUFPLEtBQUssTUFBTSxJQUFJLElBQUk7QUFBQSxJQUFNLFFBQVE7QUFBRSxhQUFPO0FBQUEsSUFBTTtBQU9wRSxRQUFJLFlBQVk7QUFDaEIsUUFBSTtBQUFFLGtCQUFZLElBQUksSUFBSSxJQUFJLEdBQUcsRUFBRTtBQUFBLElBQVUsUUFBUTtBQUFBLElBQXVCO0FBQzVFLFVBQU0sZ0JBQWdCLHdCQUF3QixLQUFLLElBQUk7QUFDdkQsVUFBTUEsYUFBWSxJQUFJLFdBQVcsT0FDMUIsSUFBSSxXQUFXLE9BQ2YsOEJBQThCLEtBQUssU0FBUyxLQUMzQyxpQkFBaUIsU0FBUztBQUVsQyxXQUFPLEVBQUUsSUFBSSxJQUFJLElBQUksUUFBUSxJQUFJLFFBQVEsTUFBTSxNQUFNLFdBQUFBLFdBQVU7QUFBQSxFQUNuRTtBQUVBLFFBQU0sa0JBQWtCLE9BQXFCO0FBQUEsSUFDekMsTUFBTSxDQUFDO0FBQUEsSUFDUCxPQUFPLENBQUMsK0VBQStFO0FBQUEsSUFDdkYsYUFBYSxZQUFZO0FBQUEsSUFDekIsV0FBVztBQUFBLEVBQ2Y7QUFFQSxRQUFNLFNBQVMsQ0FBQyxTQUE2QztBQUN6RCxRQUFJLE1BQU0sUUFBUSxJQUFJLEVBQUcsUUFBTztBQUNoQyxRQUFJLFFBQVEsT0FBTyxTQUFTLFVBQVU7QUFDbEMsWUFBTSxNQUFNO0FBQ1osaUJBQVcsT0FBTyxDQUFDLFNBQVMsUUFBUSxXQUFXLFlBQVksT0FBTyxHQUFHO0FBQ2pFLFlBQUksTUFBTSxRQUFRLElBQUksR0FBRyxDQUFDLEVBQUcsUUFBTyxJQUFJLEdBQUc7QUFBQSxNQUMvQztBQUFBLElBQ0o7QUFDQSxXQUFPLENBQUM7QUFBQSxFQUNaO0FBRUEsUUFBTSxZQUFZLENBQUMsVUFBMkIsT0FBTyxTQUFTLEVBQUUsRUFDM0QsS0FBSyxFQUFFLFlBQVksRUFBRSxRQUFRLFdBQVcsR0FBRztBQU1oRCxRQUFNLGFBQWEsQ0FBQyxRQUFnQixTQUEwQixXQUFXLE9BQ2xFLFdBQVcsT0FDWCxvREFBb0QsS0FBSyxJQUFJO0FBTXBFLE1BQUksU0FBUyxTQUFTO0FBQ2xCLFVBQU0sTUFBTSxNQUFNLEtBQUssU0FBUyxTQUFTLElBQUk7QUFDN0MsUUFBSSxJQUFJLFVBQVcsUUFBTyxnQkFBZ0I7QUFDMUMsUUFBSSxDQUFDLElBQUksSUFBSTtBQUNULGFBQU87QUFBQSxRQUNILE1BQU0sQ0FBQztBQUFBLFFBQ1AsT0FBTyxDQUFDLHVCQUF1QixJQUFJLE1BQU0sTUFBTSxJQUFJLEtBQUssTUFBTSxHQUFHLEdBQUcsQ0FBQyxFQUFFO0FBQUEsUUFDdkUsYUFBYSxZQUFZO0FBQUEsTUFDN0I7QUFBQSxJQUNKO0FBRUEsVUFBTSxhQUFhLE9BQU8sSUFBSSxJQUFJO0FBQ2xDLFVBQU0sUUFBUSxXQUFXLEtBQUssQ0FBQyxTQUFTLFNBQVMsZUFDNUMsS0FBSyxDQUFDLFVBQVUsVUFBVSxLQUFLLEtBQUssQ0FBQyxNQUFNLFVBQVUsUUFBUSxDQUFDLENBQUM7QUFFcEUsUUFBSSxDQUFDLE9BQU87QUFDUixhQUFPO0FBQUEsUUFDSCxNQUFNLENBQUM7QUFBQSxRQUNQLE9BQU87QUFBQSxVQUNILG1CQUFtQixRQUFRLFFBQVEsV0FBVyxNQUFNO0FBQUEsVUFDcEQsY0FBYyxLQUFLLFVBQVUsV0FBVyxNQUFNLEdBQUcsQ0FBQyxDQUFDLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQztBQUFBLFFBQ3RFO0FBQUEsUUFDQSxhQUFhLFlBQVk7QUFBQSxNQUM3QjtBQUFBLElBQ0o7QUFFQSxVQUFNLFVBQVUsU0FBUyxhQUFhLEtBQUssQ0FBQyxVQUFVLE1BQU0sS0FBSyxNQUFNLFVBQ2hFLE1BQU0sS0FBSyxNQUFNLElBQUk7QUFDNUIsUUFBSSxDQUFDLFNBQVM7QUFDVixhQUFPO0FBQUEsUUFDSCxNQUFNLENBQUM7QUFBQSxRQUNQLE9BQU87QUFBQSxVQUNILFVBQVUsUUFBUSxpQkFBaUIsU0FBUyxhQUFhLEtBQUssR0FBRyxDQUFDO0FBQUEsVUFDbEUsV0FBVyxLQUFLLFVBQVUsS0FBSyxFQUFFLE1BQU0sR0FBRyxHQUFHLENBQUM7QUFBQSxRQUNsRDtBQUFBLFFBQ0EsYUFBYSxZQUFZO0FBQUEsTUFDN0I7QUFBQSxJQUNKO0FBRUEsYUFBUyxPQUFPLE1BQU0sT0FBTyxDQUFDO0FBQzlCLHFCQUFpQjtBQUNqQixVQUFNLEtBQUssYUFBYSxRQUFRLFFBQVEsT0FBTyxJQUFJLE1BQU0sR0FBRztBQUk1RCxRQUFJLE1BQU0sWUFBWSxVQUFhLE1BQU0sWUFBWSxLQUFNLE1BQUssU0FBUyxPQUFPLE1BQU0sT0FBTztBQUM3RixRQUFJLE1BQU0sYUFBYSxVQUFhLE1BQU0sYUFBYSxLQUFNLE1BQUssVUFBVSxPQUFPLE1BQU0sUUFBUTtBQUVqRyxRQUFJLE1BQU0seUJBQXlCLE9BQU87QUFDdEMsWUFBTSxLQUFLLFdBQU0sUUFBUSw0RUFBdUU7QUFBQSxJQUNwRztBQUtBLFFBQUksU0FBUyxtQkFBbUI7QUFDNUIsWUFBTSxVQUFVLE1BQU0sU0FBUyxpQkFBaUI7QUFDaEQsVUFBSSxNQUFNLFFBQVEsT0FBTyxHQUFHO0FBQ3hCLG1CQUFXLFNBQVMsU0FBc0M7QUFDdEQsY0FBSSxDQUFDLFNBQVMsT0FBTyxVQUFVLFNBQVU7QUFDekMscUJBQVcsU0FBUyxTQUFTLHdCQUF3QjtBQUNqRCxrQkFBTSxRQUFRLE1BQU0sS0FBSztBQUN6QixnQkFBSSxPQUFPLFVBQVUsWUFBWSxxQkFBcUIsS0FBSyxLQUFLLEdBQUc7QUFDL0QseUJBQVcsSUFBSSxNQUFNLE1BQU0sR0FBRyxFQUFFLENBQUM7QUFDakM7QUFBQSxZQUNKO0FBQUEsVUFDSjtBQUFBLFFBQ0o7QUFDQSxZQUFJLFdBQVcsT0FBTyxHQUFHO0FBQ3JCLGdCQUFNLEtBQUssSUFBSSxRQUFRLGlCQUFpQixXQUFXLElBQUksZ0NBQWdDO0FBQUEsUUFDM0Y7QUFBQSxNQUNKO0FBQUEsSUFDSjtBQUFBLEVBQ0o7QUFFQSxNQUFJLENBQUMsUUFBUTtBQUNULFdBQU87QUFBQSxNQUNILE1BQU0sQ0FBQztBQUFBLE1BQ1AsT0FBTyxDQUFDLHdEQUF3RDtBQUFBLE1BQ2hFLGFBQWEsWUFBWTtBQUFBLElBQzdCO0FBQUEsRUFDSjtBQUNBLE9BQUssU0FBUztBQUdkLFFBQU0sWUFBWSxvQkFBSSxJQUFZO0FBRWxDLFFBQU0sYUFBYSxvQkFBSSxJQUFvQjtBQUUzQyxNQUFJLFNBQVMsTUFBTTtBQUNmLFVBQU0sTUFBTSxNQUFNLEtBQUssU0FBUyxNQUFNLElBQUk7QUFDMUMsUUFBSSxJQUFJLFVBQVcsUUFBTyxnQkFBZ0I7QUFDMUMsUUFBSSxDQUFDLElBQUksSUFBSTtBQUVULFlBQU07QUFBQSxRQUNGLHFDQUFxQyxJQUFJLE1BQU0sMEdBRWhDLElBQUksS0FBSyxNQUFNLEdBQUcsR0FBRyxDQUFDO0FBQUEsTUFDekM7QUFBQSxJQUNKLE9BQU87QUFJSCxVQUFJLFNBQVMsWUFBWTtBQUNyQixjQUFNLFNBQVMsSUFBSSxJQUFJLE1BQU0sU0FBUyxVQUFVO0FBQ2hELFlBQUksV0FBVyxVQUFhLFdBQVcsS0FBTSxNQUFLLFNBQVMsT0FBTyxNQUFNO0FBQUEsWUFDbkUsT0FBTSxLQUFLLGtCQUFrQixTQUFTLFVBQVUseUJBQXlCO0FBQUEsTUFDbEY7QUFFQSxZQUFNLFlBQVksU0FBUyxXQUFXLElBQUksSUFBSSxNQUFNLFNBQVMsUUFBUSxJQUFJLElBQUk7QUFFN0UsVUFBSSxTQUFTLGNBQWMsZ0JBQWdCO0FBR3ZDLFlBQUksYUFBYSxPQUFPLGNBQWMsWUFBWSxDQUFDLE1BQU0sUUFBUSxTQUFTLEdBQUc7QUFDekUscUJBQVcsQ0FBQyxNQUFNLE9BQU8sS0FBSyxPQUFPLFFBQVEsU0FBb0MsR0FBRztBQUNoRixnQkFBSSxDQUFDLE1BQU0sUUFBUSxPQUFPLEtBQUssUUFBUSxXQUFXLEVBQUc7QUFDckQsa0JBQU0sTUFBTSxLQUFLLE1BQU0sR0FBRyxFQUFFO0FBQzVCLHNCQUFVLElBQUksR0FBRztBQU9qQixrQkFBTSxRQUFRLFFBQVEsQ0FBQztBQUN2QixnQkFBSSxPQUFPO0FBQ1AseUJBQVcsU0FBUyxTQUFTLHFCQUFxQjtBQUM5QyxzQkFBTSxRQUFRLE1BQU0sS0FBSztBQUN6QixvQkFBSSxVQUFVLFVBQWEsVUFBVSxNQUFNO0FBQ3ZDLDZCQUFXLElBQUksS0FBSyxPQUFPLEtBQUssQ0FBQztBQUNqQztBQUFBLGdCQUNKO0FBQUEsY0FDSjtBQUFBLFlBQ0o7QUFBQSxVQUNKO0FBQ0EsZ0JBQU0sS0FBSyxTQUFTLFVBQVUsSUFBSSx1Q0FBdUM7QUFBQSxRQUM3RSxPQUFPO0FBQ0gsZ0JBQU07QUFBQSxZQUNGLGtDQUFrQyxTQUFTLFFBQVEsNEJBQ3pDLEtBQUssVUFBVSxTQUFTLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQztBQUFBLFVBQ3JEO0FBQUEsUUFDSjtBQUFBLE1BQ0osT0FBTztBQUNILGNBQU0sV0FBVyxPQUFPLFNBQVM7QUFDakMsbUJBQVcsV0FBVyxVQUFVO0FBQzVCLHFCQUFXLFNBQVMsU0FBUyxnQkFBZ0I7QUFDekMsa0JBQU0sUUFBUSxRQUFRLEtBQUs7QUFDM0IsZ0JBQUksT0FBTyxVQUFVLFlBQVksT0FBTztBQUNwQyxvQkFBTSxNQUFNLE1BQU0sTUFBTSxHQUFHLEVBQUU7QUFDN0Isd0JBQVUsSUFBSSxHQUFHO0FBQ2pCLHlCQUFXLFdBQVcsU0FBUyxxQkFBcUI7QUFDaEQsc0JBQU0sS0FBSyxRQUFRLE9BQU87QUFDMUIsb0JBQUksT0FBTyxVQUFhLE9BQU8sTUFBTTtBQUNqQyw2QkFBVyxJQUFJLEtBQUssT0FBTyxFQUFFLENBQUM7QUFDOUI7QUFBQSxnQkFDSjtBQUFBLGNBQ0o7QUFDQTtBQUFBLFlBQ0o7QUFBQSxVQUNKO0FBQUEsUUFDSjtBQUNBLGNBQU0sS0FBSyxTQUFTLFNBQVMsTUFBTSxxQ0FBcUM7QUFBQSxNQUM1RTtBQUFBLElBQ0o7QUFBQSxFQUNKO0FBSUEsTUFBSSxLQUFLLFdBQVcsUUFBVztBQUMzQixTQUFLLFNBQVM7QUFDZCxRQUFJLFNBQVMsV0FBWSxPQUFNLEtBQUssaURBQWlEO0FBQUEsRUFDekY7QUFLQSxRQUFNLFlBQVksb0JBQUksSUFBWTtBQUVsQyxhQUFXLFFBQVEsYUFBYTtBQUM1QixRQUFJLENBQUMsU0FBUyxRQUFRO0FBQ2xCLFdBQUssS0FBSyxFQUFFLE1BQU0sUUFBUSxTQUFTLFFBQVEsZ0NBQWdDLENBQUM7QUFDNUU7QUFBQSxJQUNKO0FBRUEsVUFBTSxZQUFZLFdBQVcsSUFBSSxJQUFJO0FBQ3JDLFFBQUksQ0FBQyxXQUFXO0FBR1osV0FBSyxLQUFLLEVBQUUsTUFBTSxRQUFRLFdBQVcsUUFBUSwyQkFBMkIsQ0FBQztBQUN6RSxnQkFBVSxJQUFJLElBQUk7QUFDbEI7QUFBQSxJQUNKO0FBRUEsUUFBSSxRQUFRO0FBQ1IsV0FBSyxLQUFLLEVBQUUsTUFBTSxRQUFRLFdBQVcsUUFBUSx3QkFBd0IsU0FBUyxHQUFHLENBQUM7QUFDbEY7QUFBQSxJQUNKO0FBRUEsUUFBSTtBQUNBLFlBQU0sTUFBTSxNQUFNLEtBQUssU0FBUyxRQUFRLEVBQUUsR0FBRyxNQUFNLE1BQU0sVUFBVSxDQUFDO0FBQ3BFLFVBQUksSUFBSSxXQUFXO0FBQ2YsYUFBSyxLQUFLLEVBQUUsTUFBTSxRQUFRLFNBQVMsUUFBUSxnQkFBZ0IsQ0FBQztBQUM1RCxjQUFNLEtBQUssc0RBQXNEO0FBQ2pFLG9CQUFZO0FBQ1o7QUFBQSxNQUNKO0FBQ0EsVUFBSSxJQUFJLE1BQU0sSUFBSSxXQUFXLEtBQUs7QUFHOUIsYUFBSyxLQUFLLEVBQUUsTUFBTSxRQUFRLGFBQWEsUUFBUSxJQUFJLFdBQVcsTUFBTSxpQkFBaUIsT0FBVSxDQUFDO0FBQ2hHLGtCQUFVLElBQUksSUFBSTtBQUFBLE1BQ3RCLE9BQU87QUFDSCxhQUFLLEtBQUssRUFBRSxNQUFNLFFBQVEsU0FBUyxRQUFRLEdBQUcsSUFBSSxNQUFNLEtBQUssSUFBSSxLQUFLLE1BQU0sR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQUEsTUFDM0Y7QUFBQSxJQUNKLFNBQVMsS0FBSztBQUNWLFdBQUssS0FBSyxFQUFFLE1BQU0sUUFBUSxTQUFTLFFBQVEsZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUcsRUFBRSxDQUFDO0FBQUEsSUFDakc7QUFBQSxFQUNKO0FBR0EsYUFBVyxRQUFRLE9BQU87QUFJdEIsUUFBSSxZQUFZLFNBQVMsSUFBSSxFQUFHO0FBRWhDLFFBQUksVUFBVSxJQUFJLElBQUksR0FBRztBQUNyQixXQUFLLEtBQUssRUFBRSxNQUFNLFFBQVEsV0FBVyxRQUFRLGlCQUFpQixDQUFDO0FBQy9EO0FBQUEsSUFDSjtBQUNBLFFBQUksUUFBUTtBQUNSLFdBQUssS0FBSyxXQUFXLElBQUksSUFBSSxJQUN2QixFQUFFLE1BQU0sUUFBUSxlQUFlLFFBQVEsd0NBQXdDLElBQy9FLEVBQUUsTUFBTSxRQUFRLFdBQVcsUUFBUSxjQUFjLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQztBQUMzRTtBQUFBLElBQ0o7QUFRQSxRQUFJLFdBQVcsSUFBSSxJQUFJLEdBQUc7QUFDdEIsWUFBTSxLQUFLLEdBQUcsSUFBSSxrRUFBa0U7QUFBQSxJQUN4RjtBQUVBLFFBQUk7QUFDQSxZQUFNLE1BQU0sTUFBTSxLQUFLLFNBQVMsUUFBUSxFQUFFLEdBQUcsTUFBTSxLQUFLLENBQUM7QUFDekQsVUFBSSxJQUFJLFdBQVc7QUFDZixhQUFLLEtBQUssRUFBRSxNQUFNLFFBQVEsU0FBUyxRQUFRLGdCQUFnQixDQUFDO0FBQzVELGNBQU0sS0FBSyw0SEFDNkM7QUFDeEQsb0JBQVk7QUFDWjtBQUFBLE1BQ0o7QUFDQSxVQUFJLElBQUksSUFBSTtBQUNSLGFBQUssS0FBSyxFQUFFLE1BQU0sUUFBUSxTQUFTLENBQUM7QUFBQSxNQUN4QyxXQUFXLFdBQVcsSUFBSSxRQUFRLElBQUksSUFBSSxHQUFHO0FBQ3pDLGFBQUssS0FBSyxFQUFFLE1BQU0sUUFBUSxlQUFlLFFBQVEsR0FBRyxJQUFJLE1BQU0sS0FBSyxJQUFJLEtBQUssTUFBTSxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUM7QUFBQSxNQUNqRyxPQUFPO0FBQ0gsYUFBSyxLQUFLLEVBQUUsTUFBTSxRQUFRLFNBQVMsUUFBUSxHQUFHLElBQUksTUFBTSxLQUFLLElBQUksS0FBSyxNQUFNLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQztBQUFBLE1BQzNGO0FBQUEsSUFDSixTQUFTLEtBQUs7QUFDVixXQUFLLEtBQUssRUFBRSxNQUFNLFFBQVEsU0FBUyxRQUFRLGVBQWUsUUFBUSxJQUFJLFVBQVUsT0FBTyxHQUFHLEVBQUUsQ0FBQztBQUFBLElBQ2pHO0FBQUEsRUFDSjtBQUVBLFNBQU8sRUFBRSxNQUFNLE9BQU8sZ0JBQWdCLFdBQVcsV0FBVyxDQUFDLEdBQUcsU0FBUyxFQUFFO0FBQy9FOzs7QUN6ZkEsSUFBTSxRQUFRO0FBQ2QsSUFBTSxhQUFhO0FBQ25CLElBQU0sWUFBWTtBQUNsQixJQUFNLDBCQUEwQjtBQU1oQyxJQUFNLGlCQUFOLGNBQTZCLE1BQU07QUFBQztBQWFwQyxlQUFlLFVBQVUsT0FBOEI7QUFDbkQsUUFBTSxFQUFFLE9BQU8sQ0FBQyxFQUFFLElBQUksTUFBTSxPQUFPLFFBQVEsTUFBTSxJQUFJLE1BQU07QUFDM0QsUUFBTSxPQUFPLFFBQVEsTUFBTSxJQUFJLEVBQUUsTUFBTSxDQUFDLE9BQU8sR0FBRyxJQUFJLEVBQUUsTUFBTSxHQUFHLEVBQUUsRUFBRSxDQUFDO0FBQzFFO0FBTUEsZUFBZSxlQUErRDtBQUMxRSxRQUFNLE9BQU8sTUFBTSxPQUFPLEtBQUssTUFBTSxFQUFFLEtBQUssVUFBVSxDQUFDO0FBQ3ZELFFBQU0sV0FBVyxLQUFLLEtBQUssQ0FBQyxNQUFNLE9BQU8sRUFBRSxPQUFPLFlBQVksRUFBRSxXQUFXLFVBQVUsS0FDOUUsS0FBSyxLQUFLLENBQUMsTUFBTSxPQUFPLEVBQUUsT0FBTyxRQUFRO0FBQ2hELE1BQUksVUFBVSxPQUFPLE9BQVcsUUFBTyxFQUFFLE9BQU8sU0FBUyxJQUFJLFdBQVcsTUFBTTtBQUU5RSxRQUFNLE1BQU0sTUFBTSxPQUFPLEtBQUssT0FBTyxFQUFFLEtBQUssWUFBWSxRQUFRLE1BQU0sQ0FBQztBQUN2RSxNQUFJLElBQUksT0FBTyxPQUFXLE9BQU0sSUFBSSxNQUFNLDhCQUE4QjtBQUN4RSxRQUFNLFlBQVksSUFBSSxFQUFFO0FBTXhCLFFBQU0sU0FBUyxNQUFNLE9BQU8sS0FBSyxJQUFJLElBQUksRUFBRTtBQUMzQyxNQUFJLE9BQU8sT0FBTyxDQUFDLE9BQU8sSUFBSSxXQUFXLFVBQVUsR0FBRztBQUNsRCxVQUFNLElBQUk7QUFBQSxNQUNOO0FBQUEsSUFFSjtBQUFBLEVBQ0o7QUFFQSxTQUFPLEVBQUUsT0FBTyxJQUFJLElBQUksV0FBVyxLQUFLO0FBQzVDO0FBRUEsU0FBUyxZQUFZLE9BQWUsWUFBWSxLQUF1QjtBQUNuRSxTQUFPLElBQUksUUFBUSxDQUFDLFNBQVMsV0FBVztBQUNwQyxVQUFNLFFBQVEsV0FBVyxNQUFNO0FBQzNCLGFBQU8sS0FBSyxVQUFVLGVBQWUsUUFBUTtBQUM3QyxhQUFPLElBQUksTUFBTSw0Q0FBNEMsQ0FBQztBQUFBLElBQ2xFLEdBQUcsU0FBUztBQUVaLFVBQU0sV0FBVyxDQUFDLElBQVksU0FBMEM7QUFDcEUsVUFBSSxPQUFPLFNBQVMsS0FBSyxXQUFXLFdBQVk7QUFDaEQsbUJBQWEsS0FBSztBQUNsQixhQUFPLEtBQUssVUFBVSxlQUFlLFFBQVE7QUFFN0MsaUJBQVcsU0FBUyxJQUFLO0FBQUEsSUFDN0I7QUFDQSxXQUFPLEtBQUssVUFBVSxZQUFZLFFBQVE7QUFBQSxFQUM5QyxDQUFDO0FBQ0w7QUFFQSxJQUFJO0FBT0csU0FBUyxXQUFXLFFBQWtDO0FBQ3pELE1BQUksU0FBVSxRQUFPO0FBQ3JCLGFBQVcsZUFBZSxNQUFNLEVBQUUsUUFBUSxNQUFNO0FBQUUsZUFBVztBQUFBLEVBQVcsQ0FBQztBQUN6RSxTQUFPO0FBQ1g7QUFFQSxlQUFlLGVBQWUsUUFBa0M7QUFDNUQsUUFBTSxXQUFxQixNQUFNLGFBQWE7QUFFOUMsUUFBTSxRQUFRLFlBQVk7QUFBQSxJQUN0QixVQUFVLFNBQVM7QUFBQSxJQUNuQixhQUFhLFNBQVM7QUFBQSxJQUN0QixXQUFXLFNBQVM7QUFBQSxJQUNwQixVQUFVLFNBQVM7QUFBQSxFQUN2QixDQUFDO0FBRUQsUUFBTSxPQUFlLEVBQUUsS0FBSSxvQkFBSSxLQUFLLEdBQUUsWUFBWSxHQUFHLFFBQVEsT0FBTyxNQUFNLENBQUMsR0FBRyxPQUFPLENBQUMsRUFBRTtBQUV4RixNQUFJLE1BQU0sV0FBVyxHQUFHO0FBQ3BCLFVBQU0sUUFBUSxFQUFFLEdBQUcsTUFBTSxPQUFPLENBQUMsb0NBQW9DLEVBQUU7QUFDdkUsVUFBTSxVQUFVLEtBQUs7QUFDckIsVUFBTSxXQUFXLEtBQUs7QUFDdEIsV0FBTztBQUFBLEVBQ1g7QUFFQSxNQUFJLENBQUMsU0FBUyxZQUFZLENBQUMsU0FBUyxRQUFRO0FBQ3hDLFVBQU0sUUFBUSxFQUFFLEdBQUcsTUFBTSxPQUFPLG1FQUFtRTtBQUNuRyxVQUFNLFVBQVUsS0FBSztBQUNyQixVQUFNLFdBQVcsS0FBSztBQUN0QixXQUFPO0FBQUEsRUFDWDtBQUtBLE1BQUksU0FBUyxZQUFZLENBQUMsZ0JBQWdCLFNBQVMsUUFBUSxHQUFHO0FBQzFELFVBQU0sUUFBUTtBQUFBLE1BQ1YsR0FBRztBQUFBLE1BQ0gsT0FBTyxJQUFJLFNBQVMsUUFBUTtBQUFBLElBRWhDO0FBQ0EsVUFBTSxVQUFVLEtBQUs7QUFDckIsVUFBTSxXQUFXLEtBQUs7QUFDdEIsV0FBTztBQUFBLEVBQ1g7QUFFQSxNQUFJLFlBQVk7QUFDaEIsTUFBSTtBQUVKLE1BQUk7QUFDQSxVQUFNLE1BQU0sTUFBTSxhQUFhO0FBQy9CLFlBQVEsSUFBSTtBQUNaLGdCQUFZLElBQUk7QUFFaEIsVUFBTSxDQUFDLE1BQU0sSUFBSSxNQUFNLE9BQU8sVUFBVSxjQUFjO0FBQUEsTUFDbEQsUUFBUSxFQUFFLE1BQU07QUFBQSxNQUNoQixPQUFPO0FBQUEsTUFDUCxNQUFNO0FBQUEsTUFDTixNQUFNLENBQUM7QUFBQSxRQUNILFVBQVUsU0FBUztBQUFBLFFBQ25CO0FBQUEsUUFDQSxVQUFVLFNBQVM7QUFBQSxRQUNuQixRQUFRLFNBQVM7QUFBQSxRQUNqQixNQUFNLFNBQVM7QUFBQSxRQUNmLGFBQWEsU0FBUztBQUFBO0FBQUE7QUFBQSxRQUd0QixXQUFXLFdBQVcsU0FBUyxJQUFJLEVBQUU7QUFBQSxRQUNyQyxTQUFTLFdBQVcsU0FBUyxJQUFJLEVBQUU7QUFBQSxRQUNuQyxTQUFTLFNBQVM7QUFBQSxRQUNsQixZQUFZLFNBQVM7QUFBQSxRQUNyQjtBQUFBLE1BQ0osQ0FBQztBQUFBLElBQ0wsQ0FBQztBQUVELFVBQU0sUUFBUSxRQUFRO0FBS3RCLFVBQU0sVUFBNkIsQ0FBQztBQUNwQyxRQUFJLE9BQU8sa0JBQWtCLE1BQU0sbUJBQW1CLFNBQVMsUUFBUTtBQUNuRSxjQUFRLFNBQVMsTUFBTTtBQUFBLElBQzNCO0FBR0EsUUFBSSxDQUFDLFVBQVUsT0FBTyxXQUFXLFFBQVE7QUFDckMsWUFBTSxPQUFPLElBQUksSUFBSSxNQUFNLFNBQVM7QUFDcEMsY0FBUSxjQUFjLFNBQVMsWUFBWSxPQUFPLENBQUMsU0FBUyxDQUFDLEtBQUssSUFBSSxJQUFJLENBQUM7QUFBQSxJQUMvRTtBQUNBLFFBQUksT0FBTyxLQUFLLE9BQU8sRUFBRSxTQUFTLEdBQUc7QUFDakMsWUFBTSxhQUFhLEVBQUUsR0FBRyxVQUFVLEdBQUcsUUFBUSxDQUFDO0FBQUEsSUFDbEQ7QUFFQSxVQUFNLFFBQWdCO0FBQUEsTUFDbEIsR0FBRztBQUFBLE1BQ0gsTUFBTSxPQUFPLFFBQVEsQ0FBQztBQUFBLE1BQ3RCLE9BQU8sT0FBTyxTQUFTLENBQUMsc0NBQXNDO0FBQUEsTUFDOUQsV0FBVyxPQUFPLGNBQWM7QUFBQSxJQUNwQztBQUNBLFVBQU0sVUFBVSxLQUFLO0FBQ3JCLFVBQU0sV0FBVyxLQUFLO0FBQ3RCLFdBQU87QUFBQSxFQUNYLFNBQVMsS0FBSztBQUNWLFVBQU0sUUFBZ0I7QUFBQSxNQUNsQixHQUFHO0FBQUEsTUFDSCxPQUFPLGVBQWUsUUFBUSxJQUFJLFVBQVUsT0FBTyxHQUFHO0FBQUEsTUFDdEQsV0FBVyxlQUFlO0FBQUEsSUFDOUI7QUFDQSxVQUFNLFVBQVUsS0FBSztBQUNyQixVQUFNLFdBQVcsS0FBSztBQUN0QixXQUFPO0FBQUEsRUFDWCxVQUFFO0FBRUUsUUFBSSxhQUFhLFVBQVUsUUFBVztBQUNsQyxVQUFJO0FBQUUsY0FBTSxPQUFPLEtBQUssT0FBTyxLQUFLO0FBQUEsTUFBRyxRQUFRO0FBQUEsTUFBcUI7QUFBQSxJQUN4RTtBQUFBLEVBQ0o7QUFDSjtBQWlCQSxlQUFlLFdBQVcsT0FBOEI7QUFDcEQsUUFBTSxTQUFTLFFBQVEsTUFBTSxLQUFLLEtBQUssTUFBTSxLQUFLLEtBQUssQ0FBQyxRQUFRLElBQUksV0FBVyxPQUFPO0FBS3RGLE1BQUksTUFBTSxVQUFVLENBQUMsT0FBUTtBQUU3QixRQUFNLE9BQU8sT0FBTyxhQUFhLEVBQUUsTUFBTSxTQUFTLE1BQU0sR0FBRyxDQUFDO0FBQzVELE1BQUksUUFBUTtBQUNSLFVBQU0sT0FBTyxPQUFPLHdCQUF3QixFQUFFLE9BQU8sVUFBVSxDQUFDO0FBQUEsRUFDcEU7QUFFQSxNQUFJLE1BQU0sV0FBVztBQUdqQixXQUFPLGNBQWMsT0FBTyx5QkFBeUI7QUFBQSxNQUNqRCxNQUFNO0FBQUEsTUFDTixTQUFTLE9BQU8sUUFBUSxPQUFPLGNBQWM7QUFBQSxNQUM3QyxPQUFPO0FBQUEsTUFDUCxTQUFTO0FBQUEsSUFFYixDQUFDO0FBQUEsRUFDTCxXQUFXLENBQUMsTUFBTSxRQUFRO0FBQ3RCLFdBQU8sY0FBYyxNQUFNLHVCQUF1QjtBQUFBLEVBQ3REO0FBQ0o7QUFNQSxlQUFlLG9CQUFtQztBQUM5QyxRQUFNLE9BQU8sT0FBTyxhQUFhLEVBQUUsTUFBTSxHQUFHLENBQUM7QUFDakQ7QUFPQSxlQUFlLG1CQUFrQztBQUM3QyxRQUFNLEVBQUUsT0FBTyxDQUFDLEVBQUUsSUFBSSxNQUFNLE9BQU8sUUFBUSxNQUFNLElBQUksTUFBTTtBQUMzRCxNQUFJLEtBQUssQ0FBQyxHQUFHLGNBQWMsS0FBTTtBQUlqQyxRQUFNLFdBQVcsTUFBTSxhQUFhO0FBQ3BDLE1BQUksQ0FBQyxTQUFTLFFBQVM7QUFFdkIsVUFBUSxLQUFLLDZEQUF3RDtBQUNyRSxRQUFNLFdBQVcsS0FBSztBQUMxQjtBQUVBLGVBQWUsY0FBNkI7QUFDeEMsUUFBTSxXQUFXLE1BQU0sT0FBTyxPQUFPLElBQUksS0FBSztBQUM5QyxNQUFJLFNBQVU7QUFHZCxRQUFNLE9BQU8sT0FBTyxPQUFPLE9BQU8sRUFBRSxpQkFBaUIsS0FBSyxnQkFBZ0IsRUFBRSxDQUFDO0FBQ2pGO0FBRUEsZUFBZSxhQUFhLFFBQStCO0FBQ3ZELFFBQU0sV0FBVyxNQUFNLGFBQWE7QUFDcEMsTUFBSSxDQUFDLFNBQVMsUUFBUztBQUN2QixVQUFRLEtBQUsscUJBQXFCLE1BQU0sR0FBRztBQUMzQyxRQUFNLFdBQVcsS0FBSztBQUMxQjtBQUVBLE9BQU8sUUFBUSxZQUFZLFlBQVksTUFBTTtBQUN6QyxPQUFLLFlBQVk7QUFDckIsQ0FBQztBQUdELE9BQU8sUUFBUSxVQUFVLFlBQVksTUFBTTtBQUN2QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxhQUFhLGlCQUFpQjtBQUN2QyxDQUFDO0FBRUQsT0FBTyxPQUFPLFFBQVEsWUFBWSxDQUFDLFVBQVU7QUFDekMsTUFBSSxNQUFNLFNBQVMsTUFBTztBQUMxQixPQUFLLGFBQWEsT0FBTztBQUM3QixDQUFDO0FBRUQsT0FBTyxLQUFLLFVBQVUsWUFBWSxDQUFDLFFBQVEsTUFBTSxRQUFRO0FBQ3JELE1BQUksS0FBSyxXQUFXLFdBQVk7QUFDaEMsTUFBSSxDQUFDLElBQUksS0FBSyxXQUFXLFVBQVUsRUFBRztBQUN0QyxPQUFLLGlCQUFpQjtBQUMxQixDQUFDO0FBRUQsT0FBTyxjQUFjLFVBQVUsWUFBWSxDQUFDLE9BQU87QUFDL0MsTUFBSSxPQUFPLHdCQUF5QjtBQUNwQyxPQUFLLE9BQU8sS0FBSyxPQUFPLEVBQUUsS0FBSyxXQUFXLENBQUM7QUFDM0MsU0FBTyxjQUFjLE1BQU0sdUJBQXVCO0FBQ3RELENBQUM7QUFFRCxPQUFPLFFBQVEsVUFBVSxZQUFZLENBQUMsU0FBOEMsU0FBUyxZQUFZO0FBQ3JHLE1BQUksU0FBUyxTQUFTLGdCQUFnQjtBQUNsQyxTQUFLLGtCQUFrQjtBQUN2QixZQUFRLEVBQUUsSUFBSSxLQUFLLENBQUM7QUFDcEIsV0FBTztBQUFBLEVBQ1g7QUFDQSxNQUFJLFNBQVMsU0FBUyxPQUFPO0FBQ3pCLGVBQVcsUUFBUSxVQUFVLEtBQUssRUFDN0IsS0FBSyxDQUFDLFFBQVEsUUFBUSxFQUFFLElBQUksTUFBTSxJQUFJLENBQUMsQ0FBQyxFQUN4QyxNQUFNLENBQUMsUUFBaUIsUUFBUTtBQUFBLE1BQzdCLElBQUk7QUFBQSxNQUNKLE9BQU8sZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFBQSxJQUMxRCxDQUFDLENBQUM7QUFDTixXQUFPO0FBQUEsRUFDWDtBQUNBLFNBQU87QUFDWCxDQUFDOyIsCiAgIm5hbWVzIjogWyJzaWduZWRPdXQiXQp9Cg==
