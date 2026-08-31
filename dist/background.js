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
function toLocalISODateTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}
function hasSlotStarted(date, startTime, timeZone, now = /* @__PURE__ */ new Date()) {
  const start = `${date}T${startTime.replace(/\.\d+Z?$/, "").replace(/Z$/, "")}`;
  return toLocalISODateTime(now, timeZone) >= start;
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
  morning: { start: "00:00:00.000Z", end: "11:59:59.000Z" },
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
  const planned = datesToBook({
    weekdays: settings.weekdays,
    horizonDays: settings.horizonDays,
    skipDates: settings.skipDates,
    timeZone: settings.timeZone
  });
  const slotStart = SLOT_TIMES[settings.slot].start;
  const dates = planned.filter((date) => !hasSlotStarted(date, slotStart, settings.timeZone));
  const startedAlready = planned.filter((date) => hasSlotStarted(date, slotStart, settings.timeZone));
  const base = { at: (/* @__PURE__ */ new Date()).toISOString(), dryRun, dates, rows: [], notes: [] };
  if (startedAlready.length > 0) {
    base.notes.push(
      `Not attempting ${startedAlready.join(", ")}: the ${settings.slot} slot has already started, and Comeen refuses a booking whose start time has passed.`
    );
  }
  if (dates.length === 0 && settings.cancelDates.length === 0) {
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvcmUvZGF0ZXMudHMiLCAiLi4vc3JjL2NvcmUvY29uZmlnLnRzIiwgIi4uL3NyYy9pbmplY3RlZC50cyIsICIuLi9zcmMvYmFja2dyb3VuZC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiZXhwb3J0IHR5cGUgV2Vla2RheSA9XG4gICAgfCAnbW9uZGF5JyB8ICd0dWVzZGF5JyB8ICd3ZWRuZXNkYXknXG4gICAgfCAndGh1cnNkYXknIHwgJ2ZyaWRheScgfCAnc2F0dXJkYXknIHwgJ3N1bmRheSc7XG5cbmNvbnN0IFdFRUtEQVlfTkFNRVM6IHJlYWRvbmx5IFdlZWtkYXlbXSA9IFtcbiAgICAnc3VuZGF5JywgJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknLCAnc2F0dXJkYXknLFxuXTtcblxuZnVuY3Rpb24gaXNXZWVrZGF5KHZhbHVlOiBzdHJpbmcpOiB2YWx1ZSBpcyBXZWVrZGF5IHtcbiAgICByZXR1cm4gKFdFRUtEQVlfTkFNRVMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKHZhbHVlKTtcbn1cblxuLyoqIEZvcm1hdCBhIERhdGUgYXMgWVlZWS1NTS1ERCBhcyBzZWVuIGluIGB0aW1lWm9uZWAuICovXG5leHBvcnQgZnVuY3Rpb24gdG9Mb2NhbElTT0RhdGUoZGF0ZTogRGF0ZSwgdGltZVpvbmU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1DQScsIHtcbiAgICAgICAgdGltZVpvbmUsIHllYXI6ICdudW1lcmljJywgbW9udGg6ICcyLWRpZ2l0JywgZGF5OiAnMi1kaWdpdCcsXG4gICAgfSkuZm9ybWF0KGRhdGUpO1xufVxuXG4vKiogV2Vla2RheSBuYW1lIG9mIGBkYXRlYCBhcyBzZWVuIGluIGB0aW1lWm9uZWAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYWxXZWVrZGF5KGRhdGU6IERhdGUsIHRpbWVab25lOiBzdHJpbmcpOiBXZWVrZGF5IHtcbiAgICBjb25zdCBuYW1lID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgeyB0aW1lWm9uZSwgd2Vla2RheTogJ2xvbmcnIH0pXG4gICAgICAgIC5mb3JtYXQoZGF0ZSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKCFpc1dlZWtkYXkobmFtZSkpIHRocm93IG5ldyBFcnJvcihgVW5leHBlY3RlZCB3ZWVrZGF5IGZyb20gSW50bDogXCIke25hbWV9XCJgKTtcbiAgICByZXR1cm4gbmFtZTtcbn1cblxuLyoqIExvY2FsIHdhbGwtY2xvY2sgdGltZSBhcyBgWVlZWS1NTS1ERFRISDptbTpzc2AsIG1hdGNoaW5nIHdoYXQgQ29tZWVuIHNlbmRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvTG9jYWxJU09EYXRlVGltZShkYXRlOiBEYXRlLCB0aW1lWm9uZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBwYXJ0cyA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1DQScsIHtcbiAgICAgICAgdGltZVpvbmUsXG4gICAgICAgIHllYXI6ICdudW1lcmljJywgbW9udGg6ICcyLWRpZ2l0JywgZGF5OiAnMi1kaWdpdCcsXG4gICAgICAgIGhvdXI6ICcyLWRpZ2l0JywgbWludXRlOiAnMi1kaWdpdCcsIHNlY29uZDogJzItZGlnaXQnLFxuICAgICAgICBob3VyMTI6IGZhbHNlLFxuICAgIH0pLmZvcm1hdFRvUGFydHMoZGF0ZSk7XG4gICAgY29uc3QgZ2V0ID0gKHR5cGU6IHN0cmluZyk6IHN0cmluZyA9PiBwYXJ0cy5maW5kKChwYXJ0KSA9PiBwYXJ0LnR5cGUgPT09IHR5cGUpPy52YWx1ZSA/PyAnMDAnO1xuICAgIC8vIEludGwgcmVuZGVycyBtaWRuaWdodCBhcyAyNCBpbiBzb21lIGxvY2FsZXMvZW5naW5lcy5cbiAgICBjb25zdCBob3VyID0gZ2V0KCdob3VyJykgPT09ICcyNCcgPyAnMDAnIDogZ2V0KCdob3VyJyk7XG4gICAgcmV0dXJuIGAke2dldCgneWVhcicpfS0ke2dldCgnbW9udGgnKX0tJHtnZXQoJ2RheScpfVQke2hvdXJ9OiR7Z2V0KCdtaW51dGUnKX06JHtnZXQoJ3NlY29uZCcpfWA7XG59XG5cbi8qKlxuICogSGFzIHRoaXMgZGF5J3Mgc2xvdCBhbHJlYWR5IGJlZ3VuP1xuICpcbiAqIENvbWVlbiByZWZ1c2VzIGEgYm9va2luZyB3aG9zZSBzdGFydCB0aW1lIGlzIGluIHRoZSBwYXN0IFx1MjAxNCB3aXRoIGEgNTAwIHJhdGhlclxuICogdGhhbiBhbnl0aGluZyBoZWxwZnVsLCBhbmQgaXQgcmVmdXNlcyBpdHMgb3duIHdlYiBVSSBqdXN0IHRoZSBzYW1lLCBzbyB0aGlzXG4gKiBpcyBpdHMgYmVoYXZpb3VyIGFuZCBub3Qgc29tZXRoaW5nIHdlIGFyZSBkb2luZyB3cm9uZy4gRm9yIGFuIGFsbC1kYXkgc2xvdFxuICogdGhlIHN0YXJ0IGlzIG1pZG5pZ2h0LCBzbyB0b2RheSBpcyB1bmJvb2thYmxlIGZyb20gb25lIHNlY29uZCBwYXN0IG1pZG5pZ2h0XG4gKiBvbndhcmRzLiBGb3IgYW4gYWZ0ZXJub29uIHNsb3QsIHRvZGF5IHN0YXlzIGJvb2thYmxlIHVudGlsIG5vb24uXG4gKlxuICogQm90aCBzaWRlcyBhcmUgbmFpdmUgbG9jYWwgd2FsbC1jbG9jaywgd2hpY2ggaXMgdGhlIHdob2xlIGNvbnZlbnRpb24gQ29tZWVuXG4gKiB1c2VzLCBzbyBhIHN0cmluZyBjb21wYXJpc29uIGlzIGV4YWN0bHkgcmlnaHQgaGVyZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc1Nsb3RTdGFydGVkKFxuICAgIGRhdGU6IHN0cmluZyxcbiAgICBzdGFydFRpbWU6IHN0cmluZyxcbiAgICB0aW1lWm9uZTogc3RyaW5nLFxuICAgIG5vdyA9IG5ldyBEYXRlKCksXG4pOiBib29sZWFuIHtcbiAgICBjb25zdCBzdGFydCA9IGAke2RhdGV9VCR7c3RhcnRUaW1lLnJlcGxhY2UoL1xcLlxcZCtaPyQvLCAnJykucmVwbGFjZSgvWiQvLCAnJyl9YDtcbiAgICByZXR1cm4gdG9Mb2NhbElTT0RhdGVUaW1lKG5vdywgdGltZVpvbmUpID49IHN0YXJ0O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERhdGVzVG9Cb29rT3B0aW9ucyB7XG4gICAgd2Vla2RheXM6IHN0cmluZ1tdO1xuICAgIGhvcml6b25EYXlzPzogbnVtYmVyO1xuICAgIHNraXBEYXRlcz86IHN0cmluZ1tdO1xuICAgIHRpbWVab25lPzogc3RyaW5nO1xuICAgIG5vdz86IERhdGU7XG59XG5cbi8qKlxuICogRXZlcnkgZGF5IGZyb20gdG9kYXkgKGluY2x1c2l2ZSkgdXAgdG8gYGhvcml6b25EYXlzYCBhaGVhZCB3aG9zZSB3ZWVrZGF5IGlzXG4gKiBpbiBgd2Vla2RheXNgLCBtaW51cyBgc2tpcERhdGVzYC5cbiAqXG4gKiBUaGUgMTQtZGF5IGRlZmF1bHQgaXMgd2hhdCBtYWtlcyB1bnJlbGlhYmxlIHNjaGVkdWxpbmcgYWNjZXB0YWJsZTogZWFjaCBydW5cbiAqIHRvcHMgdGhlIHdob2xlIHdpbmRvdyBiYWNrIHVwLCBzbyBtaXNzaW5nIGEgZGF5IChsYXB0b3Agc2h1dCwgQ2hyb21lIGNsb3NlZClcbiAqIGNvc3RzIG5vdGhpbmcgYXMgbG9uZyBhcyB0aGUgZXh0ZW5zaW9uIHJ1bnMgYWdhaW4gYmVmb3JlIHRoZSB3aW5kb3cgZHJhaW5zLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGF0ZXNUb0Jvb2soe1xuICAgIHdlZWtkYXlzLFxuICAgIGhvcml6b25EYXlzID0gMTQsXG4gICAgc2tpcERhdGVzID0gW10sXG4gICAgdGltZVpvbmUgPSAnRXVyb3BlL1ByYWd1ZScsXG4gICAgbm93ID0gbmV3IERhdGUoKSxcbn06IERhdGVzVG9Cb29rT3B0aW9ucyk6IHN0cmluZ1tdIHtcbiAgICBjb25zdCB3YW50ZWQgPSBuZXcgU2V0PFdlZWtkYXk+KCk7XG4gICAgZm9yIChjb25zdCByYXcgb2Ygd2Vla2RheXMpIHtcbiAgICAgICAgY29uc3QgbmFtZSA9IHJhdy50b0xvd2VyQ2FzZSgpO1xuICAgICAgICBpZiAoIWlzV2Vla2RheShuYW1lKSkgdGhyb3cgbmV3IEVycm9yKGBOb3QgYSB3ZWVrZGF5IG5hbWU6IFwiJHtyYXd9XCJgKTtcbiAgICAgICAgd2FudGVkLmFkZChuYW1lKTtcbiAgICB9XG5cbiAgICBjb25zdCBza2lwID0gbmV3IFNldChza2lwRGF0ZXMpO1xuICAgIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcblxuICAgIGZvciAobGV0IG9mZnNldCA9IDA7IG9mZnNldCA8PSBob3Jpem9uRGF5czsgb2Zmc2V0ICs9IDEpIHtcbiAgICAgICAgY29uc3QgZGF5ID0gbmV3IERhdGUobm93LmdldFRpbWUoKSArIG9mZnNldCAqIDg2XzQwMF8wMDApO1xuICAgICAgICBjb25zdCBpc28gPSB0b0xvY2FsSVNPRGF0ZShkYXksIHRpbWVab25lKTtcbiAgICAgICAgaWYgKCF3YW50ZWQuaGFzKGxvY2FsV2Vla2RheShkYXksIHRpbWVab25lKSkpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoc2tpcC5oYXMoaXNvKSkgY29udGludWU7XG4gICAgICAgIG91dC5wdXNoKGlzbyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIG91dDtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IFdlZWtkYXkgfSBmcm9tICcuL2RhdGVzLmpzJztcblxuZXhwb3J0IHR5cGUgU2xvdCA9ICdhbGxfZGF5JyB8ICdtb3JuaW5nJyB8ICdhZnRlcm5vb24nO1xuXG4vKipcbiAqIEhvdyB0aGUgaW4tcGFnZSBjb2RlIHNob3VsZCBhdXRoZW50aWNhdGUuXG4gKlxuICogYGNvb2tpZWAgICAgICAgLSBqdXN0IHNlbmQgY3JlZGVudGlhbHMgd2l0aCB0aGUgcmVxdWVzdC4gQ29ycmVjdCBpZiBDb21lZW5cbiAqICAgICAgICAgICAgICAgICAgYXV0aGVudGljYXRlcyB3aXRoIGEgc2Vzc2lvbiBjb29raWUuXG4gKiBgbG9jYWxTdG9yYWdlYCAtIHJlYWQgYSB0b2tlbiBvdXQgb2YgdGhlIHBhZ2UncyBvd24gbG9jYWxTdG9yYWdlIGFuZCBwdXQgaXRcbiAqICAgICAgICAgICAgICAgICAgaW4gYSBoZWFkZXIuIENvcnJlY3QgaWYgQ29tZWVuIHVzZXMgYSBiZWFyZXIgdG9rZW4uXG4gKlxuICogRWl0aGVyIHdheSB0aGUgdmFsdWUgaXMgcmVhZCBpbnNpZGUgdGhlIHBhZ2UgYW5kIHVzZWQgdGhlcmUuIEl0IGlzIG5ldmVyXG4gKiBjb3BpZWQgaW50byBleHRlbnNpb24gc3RvcmFnZSwgbmV2ZXIgcGVyc2lzdGVkLCBhbmQgbmV2ZXIgbGVhdmVzIHRoZSB0YWIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXV0aENvbmZpZyB7XG4gICAgbW9kZTogJ2Nvb2tpZScgfCAnbG9jYWxTdG9yYWdlJztcbiAgICAvKiogbG9jYWxTdG9yYWdlIGtleSBob2xkaW5nIHRoZSB0b2tlbi4gKi9cbiAgICBzdG9yYWdlS2V5Pzogc3RyaW5nO1xuICAgIC8qKiBEb3R0ZWQgcGF0aCBpbnNpZGUgdGhlIHBhcnNlZCBKU09OLCBlLmcuIGBzdHNUb2tlbk1hbmFnZXIuYWNjZXNzVG9rZW5gICovXG4gICAganNvblBhdGg/OiBzdHJpbmc7XG4gICAgLyoqIEhlYWRlciB0byBzZXQsIGRlZmF1bHQgYGF1dGhvcml6YXRpb25gICovXG4gICAgaGVhZGVyPzogc3RyaW5nO1xuICAgIC8qKiBQcmVmaXggYmVmb3JlIHRoZSB0b2tlbiwgZGVmYXVsdCBgQmVhcmVyIGAgKi9cbiAgICBwcmVmaXg/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVxdWVzdFRlbXBsYXRlIHtcbiAgICBtZXRob2Q6ICdHRVQnIHwgJ1BPU1QnIHwgJ1BVVCcgfCAnREVMRVRFJztcbiAgICAvKiogUGF0aCBhcHBlbmRlZCB0byBhcGlCYXNlLiBNYXkgY29udGFpbiBwbGFjZWhvbGRlcnMuICovXG4gICAgcGF0aDogc3RyaW5nO1xuICAgIHF1ZXJ5PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICBib2R5PzogdW5rbm93bjtcbn1cblxuLyoqXG4gKiBIb3cgdGhlIFwid2hhdCBkbyBJIGFscmVhZHkgaG9sZFwiIHJlc3BvbnNlIGlzIGxhaWQgb3V0LlxuICpcbiAqIGBhcnJheWAgICAgICAgIC0gYSBmbGF0IGxpc3Qgb2YgYm9va2luZ3MsIGVhY2ggY2FycnlpbmcgaXRzIG93biBkYXRlIGZpZWxkLFxuICogICAgICAgICAgICAgICAgICByZWFkIHZpYSBgbGlzdERhdGVGaWVsZHNgLlxuICogYGRhdGVLZXllZE1hcGAgLSBhbiBvYmplY3Qga2V5ZWQgYnkgYFlZWVktTU0tRERgIHdob3NlIHZhbHVlcyBhcmUgdGhhdCBkYXknc1xuICogICAgICAgICAgICAgICAgICBlbnRyaWVzLiBDb21lZW4gcmV0dXJucyB0aGlzIG9uZS4gVGhlIGRhdGUgaXMgdGhlICprZXkqLCBub3RcbiAqICAgICAgICAgICAgICAgICAgYSBmaWVsZCwgc28gbm8gYW1vdW50IG9mIHNuaWZmaW5nIGZpZWxkIG5hbWVzIHdvdWxkIGZpbmQgaXQgXHUyMDE0XG4gKiAgICAgICAgICAgICAgICAgIHdoaWNoIGlzIGV4YWN0bHkgd2h5IHRoZSBzaGFwZSBpcyBjb25maWd1cmF0aW9uIHJhdGhlciB0aGFuXG4gKiAgICAgICAgICAgICAgICAgIHNvbWV0aGluZyB0aGUgaW4tcGFnZSBjb2RlIGd1ZXNzZXMuXG4gKi9cbmV4cG9ydCB0eXBlIExpc3RTaGFwZSA9ICdhcnJheScgfCAnZGF0ZUtleWVkTWFwJztcblxuLyoqXG4gKiBUaGUgd2hvbGUgQVBJIGNvbnRyYWN0IGxpdmVzIGhlcmUgYXMgZGF0YSBzbyBpdCBjYW4gYmUgY29ycmVjdGVkIGZyb20gdGhlXG4gKiBwb3B1cCB3aXRob3V0IHJlYnVpbGRpbmcuIFBsYWNlaG9sZGVycyBhdmFpbGFibGUgdG8gcGF0aHMsIHF1ZXJpZXMgYW5kXG4gKiBib2RpZXM6IHt7ZGF0ZX19LCB7e2Rlc2tJZH19LCB7e2Rlc2tOYW1lfX0sIHt7c2xvdH19LCB7e3N0YXJ0VGltZX19LFxuICoge3tlbmRUaW1lfX0sIHt7ZnJvbX19LCB7e3RvfX0sIHt7dXNlcklkfX0sIHt7Zmxvb3JJZH19LCB7e2J1aWxkaW5nSWR9fSxcbiAqIHt7YXJlYUlkfX0uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRW5kcG9pbnRDb25maWcge1xuICAgIGFwaUJhc2U6IHN0cmluZztcbiAgICBhdXRoOiBBdXRoQ29uZmlnO1xuICAgIC8qKlxuICAgICAqIExvb2sgYSBkZXNrIHVwIGJ5IGl0cyBodW1hbiBuYW1lIHNvIG5vYm9keSBoYXMgdG8ga25vdyBpdHMgaW50ZXJuYWwgaWQuXG4gICAgICogU2V0IHRvIG51bGwgb25seSBpZiB5b3VyIENvbWVlbiBoYXMgbm8gZGVzay1zZWFyY2ggZW5kcG9pbnQuXG4gICAgICovXG4gICAgcmVzb2x2ZTogUmVxdWVzdFRlbXBsYXRlIHwgbnVsbDtcbiAgICAvKiogRmllbGQgbmFtZXMgdGhhdCBtaWdodCBob2xkIGEgZGVzaydzIGh1bWFuIGxhYmVsIGluIGEgc2VhcmNoIHJlc3VsdC4gKi9cbiAgICBkZXNrTmFtZUZpZWxkczogc3RyaW5nW107XG4gICAgLyoqIEZpZWxkIG5hbWVzIHRoYXQgbWlnaHQgaG9sZCBhIGRlc2sncyBpbnRlcm5hbCBpZC4gQ29tZWVuIHVzZXMgYHV1aWRgLiAqL1xuICAgIGRlc2tJZEZpZWxkczogc3RyaW5nW107XG4gICAgLyoqXG4gICAgICogRmllbGQgb24gYSBkZXNrIHJlY29yZCBob2xkaW5nIHRoYXQgZGVzaydzIG93biBib29raW5ncyBmb3IgdGhlIHF1ZXJpZWRcbiAgICAgKiB3aW5kb3cuIFVzZWQgdG8gdGVsbCB5b3UgYSBkYXkgaXMgYWxyZWFkeSB0YWtlbiAqYmVmb3JlKiB5b3UgcHJlc3MgQm9va1xuICAgICAqIG5vdy4gU2V0IHRvICcnIHRvIGRpc2FibGUuXG4gICAgICovXG4gICAgZGVza1NjaGVkdWxlRmllbGQ6IHN0cmluZztcbiAgICAvKipcbiAgICAgKiBEYXRlIGZpZWxkcyB0byByZWFkIG9mZiBvbmUgb2YgdGhvc2UgZW50cmllcywgaW4gcHJpb3JpdHkgb3JkZXIsIGZpcnN0XG4gICAgICogbWF0Y2ggd2lucy5cbiAgICAgKlxuICAgICAqIFRoZSBvcmRlciBtYXR0ZXJzIG1vcmUgdGhhbiBpdCBsb29rczogYW4gZW50cnkgYWxtb3N0IGNlcnRhaW5seSBhbHNvXG4gICAgICogY2FycmllcyBjcmVhdGVkX2F0IGFuZCB1cGRhdGVkX2F0LCB3aGljaCBhcmUgd2hlbiB0aGUgYm9va2luZyB3YXMgbWFkZSxcbiAgICAgKiBub3QgdGhlIGRheSBib29rZWQuIExpc3Rpbmcgb25seSB0aGUgZmllbGRzIHRoYXQgbWVhbiBcInRoZSBkYXkgdGhpcyBpc1xuICAgICAqIGZvclwiIGlzIHdoYXQgc3RvcHMgYSBib29raW5nIG1hZGUgdGhyZWUgd2Vla3MgYWdvIGZyb20gbWFya2luZyB0aHJlZVxuICAgICAqIHdlZWtzIGFnbyBhcyB0YWtlbi5cbiAgICAgKi9cbiAgICBkZXNrU2NoZWR1bGVEYXRlRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKiogU2V0IHRvIG51bGwgdG8gc2tpcCB0aGUgXCJ3aGF0IGRvIEkgYWxyZWFkeSBoYXZlXCIgY2hlY2suICovXG4gICAgbGlzdDogUmVxdWVzdFRlbXBsYXRlIHwgbnVsbDtcbiAgICAvKiogRG90dGVkIHBhdGggdG8gdGhlIGNvbnRhaW5lciBpbnNpZGUgdGhlIGxpc3QgcmVzcG9uc2UuICcnIG1lYW5zIHJvb3QuICovXG4gICAgbGlzdFJvb3Q6IHN0cmluZztcbiAgICBsaXN0U2hhcGU6IExpc3RTaGFwZTtcbiAgICAvKiogT25seSBjb25zdWx0ZWQgd2hlbiBsaXN0U2hhcGUgaXMgJ2FycmF5Jy4gKi9cbiAgICBsaXN0RGF0ZUZpZWxkczogc3RyaW5nW107XG4gICAgLyoqXG4gICAgICogRG90dGVkIHBhdGggdG8gdGhlIHNpZ25lZC1pbiB1c2VyJ3MgaWQgaW5zaWRlIHRoZSBsaXN0IHJlc3BvbnNlLiBFbXB0eVxuICAgICAqIGRpc2FibGVzIHRoZSBsb29rdXAsIGFuZCB7e3VzZXJJZH19IHRoZW4gc3RheXMgdW5maWxsZWQuXG4gICAgICovXG4gICAgdXNlcklkUGF0aDogc3RyaW5nO1xuICAgIGNyZWF0ZTogUmVxdWVzdFRlbXBsYXRlO1xuICAgIC8qKlxuICAgICAqIENhbmNlbCBhIGJvb2tpbmcuIFNldCB0byBudWxsIHRvIGRpc2FibGUgY2FuY2VsbGluZyBlbnRpcmVseS5cbiAgICAgKlxuICAgICAqIFRha2VzIHt7Ym9va2luZ0lkfX0sIHJlYWQgb2ZmIHRoZSBsaXN0ZWQgYm9va2luZyB2aWEgbGlzdEJvb2tpbmdJZEZpZWxkcyBcdTIwMTRcbiAgICAgKiBzbyBjYW5jZWxsaW5nIGRlcGVuZHMgb24gYGxpc3RgIHdvcmtpbmcsIHdoaWNoIGlzIGNvcnJlY3Q6IHlvdSBjYW5ub3RcbiAgICAgKiBjYW5jZWwgd2hhdCB5b3UgaGF2ZSBub3QgY29uZmlybWVkIHlvdSBob2xkLlxuICAgICAqL1xuICAgIGNhbmNlbDogUmVxdWVzdFRlbXBsYXRlIHwgbnVsbDtcbiAgICAvKipcbiAgICAgKiBGaWVsZHMgb24gYSBsaXN0ZWQgYm9va2luZyB0aGF0IGlkZW50aWZ5IGl0IGZvciBjYW5jZWxsYXRpb24sIGluIHByaW9yaXR5XG4gICAgICogb3JkZXIuIENvbWVlbiB3YW50cyB0aGUgbnVtZXJpYyBgaWRgIGhlcmUsIE5PVCB0aGUgYHV1aWRgIHRoYXQgdGhlIHNhbWVcbiAgICAgKiBlbnRyeSBhbHNvIGNhcnJpZXMgYW5kIHRoYXQgdGhlIGNyZWF0ZSBib2R5IHVzZXMgZm9yIHRoZSBkZXNrLiBHZXR0aW5nXG4gICAgICogdGhpcyB3cm9uZyBpcyBhIDQwNCBhdCBiZXN0LlxuICAgICAqL1xuICAgIGxpc3RCb29raW5nSWRGaWVsZHM6IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdzIHtcbiAgICAvKipcbiAgICAgKiBCdW1wZWQgaW4gREVGQVVMVF9TRVRUSU5HUyB3aGVuZXZlciB0aGUgc2hpcHBlZCBlbmRwb2ludCBjb25maWcgaXNcbiAgICAgKiBjb3JyZWN0ZWQuIFNlZSBtZXJnZVNldHRpbmdzOiBhIHN0b3JlZCBjb25maWcgb2xkZXIgdGhhbiB0aGUgc2hpcHBlZCBvbmVcbiAgICAgKiBpcyByZXBsYWNlZCByYXRoZXIgdGhhbiBtZXJnZWQsIHdoaWNoIGlzIHdoYXQgbGV0cyBhIGZpeCBhY3R1YWxseSByZWFjaFxuICAgICAqIHBlb3BsZSB3aG8gaGF2ZSBhbHJlYWR5IHNhdmVkIHNldHRpbmdzIG9uY2UuXG4gICAgICovXG4gICAgZW5kcG9pbnRWZXJzaW9uOiBudW1iZXI7XG4gICAgZW5hYmxlZDogYm9vbGVhbjtcbiAgICBkZXNrTmFtZTogc3RyaW5nO1xuICAgIGRlc2tJZDogc3RyaW5nO1xuICAgIC8qKlxuICAgICAqIFRoZSBmbG9vciB0aGUgZGVzayBpcyBvbi4gVGhpcyBvbmUgY2Fubm90IGJlIGRlcml2ZWQ6IHJlc29sdmluZyBhIGRlc2sgYnlcbiAgICAgKiBuYW1lIG1lYW5zIGxpc3RpbmcgYSBmbG9vcidzIGRlc2tzLCBzbyB0aGUgZmxvb3IgaGFzIHRvIGJlIGtub3duIGZpcnN0LlxuICAgICAqIFZpc2libGUgaW4gdGhlIFVSTCBvZiBDb21lZW4ncyBmbG9vciBwbGFuLCBhbmQgaW4gYGZsb29yX2lkYCBvbiBhbnkgZGVzay5cbiAgICAgKi9cbiAgICBmbG9vcklkOiBudW1iZXI7XG4gICAgLyoqXG4gICAgICogVGhlIGJ1aWxkaW5nIHRoZSBmbG9vciBpcyBpbi4gQWxzbyBub3QgZGVyaXZhYmxlIFx1MjAxNCBhIGRlc2sgcmVjb3JkIGNhcnJpZXNcbiAgICAgKiBgZmxvb3JfaWRgIGFuZCBgYXJlYV9pZGAgYnV0IG5vIGBidWlsZGluZ19pZGAsIGFuZCB0aGUgb25seSBlbmRwb2ludCB0aGF0XG4gICAgICogbWFwcyBvbmUgdG8gdGhlIG90aGVyIG5lZWRzIGEgc3BhY2UgVVVJRCB3ZSBuZXZlciBvdGhlcndpc2UgZmV0Y2guXG4gICAgICovXG4gICAgYnVpbGRpbmdJZDogbnVtYmVyO1xuICAgIHdlZWtkYXlzOiBXZWVrZGF5W107XG4gICAgc2xvdDogU2xvdDtcbiAgICBob3Jpem9uRGF5czogbnVtYmVyO1xuICAgIHNraXBEYXRlczogc3RyaW5nW107XG4gICAgLyoqXG4gICAgICogRGF5cyB3aG9zZSBib29raW5nIHNob3VsZCBiZSBjYW5jZWxsZWQgb24gdGhlIG5leHQgcnVuLlxuICAgICAqXG4gICAgICogQSBvbmUtc2hvdCBpbnN0cnVjdGlvbiwgbm90IGEgcHJlZmVyZW5jZTogYW4gZW50cnkgaXMgcmVtb3ZlZCBvbmNlIHRoZVxuICAgICAqIGNhbmNlbGxhdGlvbiBzdWNjZWVkcywgb3IgdGhlIG5leHQgYXV0b21hdGljIHJ1biB3b3VsZCBrZWVwIHRyeWluZyB0b1xuICAgICAqIGRlbGV0ZSBzb21ldGhpbmcgYWxyZWFkeSBnb25lLiBBZGRpbmcgYSBkYXRlIGhlcmUgYWxzbyBhZGRzIGl0IHRvXG4gICAgICogc2tpcERhdGVzIFx1MjAxNCBvdGhlcndpc2UgdGhlIHNhbWUgcnVuIHRoYXQgY2FuY2VscyBpdCBib29rcyBpdCBzdHJhaWdodCBiYWNrLlxuICAgICAqL1xuICAgIGNhbmNlbERhdGVzOiBzdHJpbmdbXTtcbiAgICB0aW1lWm9uZTogc3RyaW5nO1xuICAgIGVuZHBvaW50OiBFbmRwb2ludENvbmZpZztcbn1cblxuLyoqXG4gKiBBIHNsb3QgYXMgdGhlIG5haXZlIGxvY2FsIHRpbWVzIENvbWVlbiBleHBlY3RzLlxuICpcbiAqIENvbWVlbiBzZW5kcyBkYXRldGltZXMgbGlrZSBgMjAyNi0wOS0wMVQwMDowMDowMC4wMDBaYCBhbmQgZWNob2VzIHRoZW0gYmFja1xuICogYXMgYDIwMjYtMDktMDFUMDA6MDA6MDBgIFx1MjAxNCBhIGxvY2FsIHdhbGwtY2xvY2sgdGltZSB3ZWFyaW5nIGEgYFpgLiBTbyB0aGUgZGF5XG4gKiBpcyB1c2VkIHZlcmJhdGltIGFuZCBubyB0aW1lem9uZSBjb252ZXJzaW9uIGhhcHBlbnMgYW55d2hlcmUgaW4gdGhlIGJvb2tpbmdcbiAqIHBhdGguIFRoZSBkYXRlIGxvZ2ljIGluIGRhdGVzLnRzIGFscmVhZHkgcHJvZHVjZXMgZXhhY3RseSB0aGlzLlxuICpcbiAqIEFsbCB0aHJlZSBjb25maXJtZWQgYWdhaW5zdCB3aGF0IENvbWVlbidzIG93biB3ZWIgVUkgc2VuZHMuIFRoZSBoYWxmLWRheXNcbiAqIHdlcmUgZ3Vlc3NlZCBmaXJzdCBhbmQgb25lIGd1ZXNzIHdhcyB3cm9uZzogbW9ybmluZyBlbmRzIGF0IDExOjU5OjU5LCBub3QgYXRcbiAqIDEyOjAwOjAwLCBmb2xsb3dpbmcgdGhlIHNhbWUgXCJsYXN0IHNlY29uZCBvZiB0aGUgcGVyaW9kXCIgcGF0dGVybiBhcyBhbGxfZGF5LlxuICovXG5leHBvcnQgY29uc3QgU0xPVF9USU1FUzogUmVjb3JkPFNsb3QsIHsgc3RhcnQ6IHN0cmluZzsgZW5kOiBzdHJpbmcgfT4gPSB7XG4gICAgYWxsX2RheTogeyBzdGFydDogJzAwOjAwOjAwLjAwMFonLCBlbmQ6ICcyMzo1OTo1OS4wMDBaJyB9LFxuICAgIG1vcm5pbmc6IHsgc3RhcnQ6ICcwMDowMDowMC4wMDBaJywgZW5kOiAnMTE6NTk6NTkuMDAwWicgfSxcbiAgICBhZnRlcm5vb246IHsgc3RhcnQ6ICcxMjowMDowMC4wMDBaJywgZW5kOiAnMjM6NTk6NTkuMDAwWicgfSxcbn07XG5cbi8qKlxuICogQ29uZmlybWVkIGFnYWluc3QgYSByZWFsIHNpZ25lZC1pbiBzZXNzaW9uIGluIEF1Z3VzdCAyMDI2LCBieSBjYXB0dXJpbmcgdGhlXG4gKiB0cmFmZmljIG9mIG9uZSBkZXNrIGJvb2tpbmcgbWFkZSBieSBoYW5kLlxuICpcbiAqIE5vdGVzIHdvcnRoIGtlZXBpbmcsIGJlY2F1c2UgZWFjaCBvbmUgY29udHJhZGljdHMgYSByZWFzb25hYmxlIGd1ZXNzOlxuICogICAtIGBhcGlCYXNlYCBpcyBteS5jb21lZW4uaW8vYXBpLCB0aGUgU1BBJ3Mgb3duIG9yaWdpbiwgTk9UIGFwaS5jb21lZW4uaW9cbiAqICAgICB3aGVyZSB0aGUgcHVibGljIGRvY3MgbGl2ZS4gSXQgaXMgYSBSYWlscyBiYWNrZW5kIGJlaGluZCBhIE51eHQgZnJvbnQgZW5kLFxuICogICAgIHdoaWNoIGlzIHdoeSBwYXRocyBlbmQgaW4gYC5qc29uYC5cbiAqICAgLSBUaGUgQVBJIHZlcnNpb24gdmFyaWVzIHBlciBlbmRwb2ludCAoL3YxLCAvdjIsIC92MmJldGEpLCBzbyB0aGUgdmVyc2lvblxuICogICAgIGJlbG9uZ3MgaW4gZWFjaCBwYXRoIHJhdGhlciB0aGFuIGluIGFwaUJhc2UuXG4gKiAgIC0gQSBkZXNrJ3MgaWQgaXMgYHV1aWRgLiBUaGVyZSBpcyBubyBgaWRgIGZpZWxkIG9uIGEgZGVzayBhdCBhbGwuXG4gKiAgIC0gVGhlIGJvb2tpbmdzIGxpc3QgaXMga2V5ZWQgYnkgZGF0ZTsgdGhlIGRhdGUgaXMgbm90IGEgZmllbGQgb24gYW4gZW50cnkuXG4gKiAgIC0gQSBib29raW5nIGlzIGEgXCJ3b3JrIGFjdGl2aXR5XCIgd2l0aCBhIGRlc2sgYXR0YWNoZWQsIG5vdCBhIGRlc2sgYm9va2luZ1xuICogICAgIGFzIHN1Y2guIFRoYXQgaXMgd2h5IHRoZSBwYXRoIHNheXMgd29ya19hY3Rpdml0eV9zY2hlZHVsZS5cbiAqICAgLSBBdXRoIGlzIHRoZSBzZXNzaW9uIGNvb2tpZS4gQSBmZXRjaCBmcm9tIHRoZSBwYWdlIHdpdGggY3JlZGVudGlhbHNcbiAqICAgICBpbmNsdWRlZCBhbmQgbm8gQXV0aG9yaXphdGlvbiBoZWFkZXIgcmV0dXJucyAyMDAsIHNvIHRoZXJlIGlzIG5vIHRva2VuIHRvXG4gKiAgICAgcmVhZCBhbmQgbm90aGluZyBmb3IgdGhlIGV4dGVuc2lvbiB0byBob2xkLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9TRVRUSU5HUzogU2V0dGluZ3MgPSB7XG4gICAgLy8gXHUyQjA2IEJVTVAgVEhJUyB3aGVuZXZlciB5b3UgY29ycmVjdCB0aGUgYGVuZHBvaW50YCBibG9jayBiZWxvdywgb3RoZXJ3aXNlXG4gICAgLy8gYW55b25lIHdobyBhbHJlYWR5IHByZXNzZWQgU2F2ZSBrZWVwcyB0aGVpciBzdGFsZSBjb3B5IGZvcmV2ZXIuXG4gICAgZW5kcG9pbnRWZXJzaW9uOiA0LFxuICAgIGVuYWJsZWQ6IGZhbHNlLFxuICAgIC8vIEVtcHR5IG9uIHB1cnBvc2UuIFNoaXBwaW5nIGEgcmVhbCBkZXNrIG51bWJlciBhcyB0aGUgZGVmYXVsdCBtZWFucyB0aGVcbiAgICAvLyBmaXJzdCBwZXJzb24gdG8gaW5zdGFsbCB0aGlzIGFuZCBwcmVzcyBCb29rIG5vdyB0YWtlcyBzb21lYm9keSBlbHNlJ3NcbiAgICAvLyBzZWF0LCBoYXZpbmcgZG9uZSBub3RoaW5nIHdyb25nLiBOb3RoaW5nIHJ1bnMgdW50aWwgYSBkZXNrIGlzIGNob3Nlbi5cbiAgICBkZXNrTmFtZTogJycsXG4gICAgZGVza0lkOiAnJyxcbiAgICBmbG9vcklkOiA0OTUyLFxuICAgIGJ1aWxkaW5nSWQ6IDUxNTEsXG4gICAgd2Vla2RheXM6IFsnbW9uZGF5JywgJ3R1ZXNkYXknLCAnd2VkbmVzZGF5JywgJ3RodXJzZGF5JywgJ2ZyaWRheSddLFxuICAgIHNsb3Q6ICdhbGxfZGF5JyxcbiAgICBob3Jpem9uRGF5czogMTQsXG4gICAgc2tpcERhdGVzOiBbXSxcbiAgICBjYW5jZWxEYXRlczogW10sXG4gICAgdGltZVpvbmU6ICdFdXJvcGUvUHJhZ3VlJyxcbiAgICBlbmRwb2ludDoge1xuICAgICAgICBhcGlCYXNlOiAnaHR0cHM6Ly9teS5jb21lZW4uaW8vYXBpJyxcbiAgICAgICAgYXV0aDogeyBtb2RlOiAnY29va2llJyB9LFxuICAgICAgICByZXNvbHZlOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICAgICAgcGF0aDogJy92MS9mbG9vcnMve3tmbG9vcklkfX0vZGVza3Nfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGU6ICd7e2Zyb219fVQwMDowMDowMC4wMDBaJyxcbiAgICAgICAgICAgICAgICBlbmRfZGF0ZTogJ3t7dG99fVQyMzo1OTo1OS4wMDBaJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGRlc2tOYW1lRmllbGRzOiBbJ25hbWUnLCAnc3luY19pZCddLFxuICAgICAgICBkZXNrSWRGaWVsZHM6IFsndXVpZCcsICdpZCddLFxuICAgICAgICBkZXNrU2NoZWR1bGVGaWVsZDogJ3NjaGVkdWxlJyxcbiAgICAgICAgZGVza1NjaGVkdWxlRGF0ZUZpZWxkczogWydzdGFydF9kYXRldGltZScsICdzdGFydF9kYXRlJywgJ2RhdGUnLCAnZGF5JywgJ3N0YXJ0J10sXG4gICAgICAgIGxpc3Q6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgICAgICBwYXRoOiAnL3YxL3VzZXJzL21lL3dvcmtfYWN0aXZpdHlfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGU6ICd7e2Zyb219fVQwMDowMDowMC4wMDBaJyxcbiAgICAgICAgICAgICAgICBlbmRfZGF0ZTogJ3t7dG99fVQyMzo1OTo1OS4wMDBaJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGxpc3RSb290OiAnc2NoZWR1bGUnLFxuICAgICAgICBsaXN0U2hhcGU6ICdkYXRlS2V5ZWRNYXAnLFxuICAgICAgICBsaXN0RGF0ZUZpZWxkczogWydzdGFydF9kYXRldGltZScsICdkYXRlJ10sXG4gICAgICAgIHVzZXJJZFBhdGg6ICd1c2VyLmlkJyxcbiAgICAgICAgbGlzdEJvb2tpbmdJZEZpZWxkczogWydpZCcsICd1dWlkJ10sXG4gICAgICAgIGNyZWF0ZToge1xuICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgICAvLyBUaGUgYG1lYCBhbGlhcyB3b3JrcyBmb3IgcmVhZHM7IHRoZSBhcHAgaXRzZWxmIHVzZXMgdGhlIG51bWVyaWNcbiAgICAgICAgICAgIC8vIGlkIHRvIHdyaXRlLCBzbyB0aGF0IGlzIHdoYXQgaXMgdXNlZCBoZXJlLlxuICAgICAgICAgICAgcGF0aDogJy92MS91c2Vycy97e3VzZXJJZH19L3dvcmtfYWN0aXZpdHlfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBib2R5OiB7XG4gICAgICAgICAgICAgICAgd29ya19hY3Rpdml0eToge1xuICAgICAgICAgICAgICAgICAgICBzdGF0ZTogJ29uX3NpdGUnLFxuICAgICAgICAgICAgICAgICAgICBzdGFydF9kYXRldGltZTogJ3t7ZGF0ZX19VHt7c3RhcnRUaW1lfX0nLFxuICAgICAgICAgICAgICAgICAgICBlbmRfZGF0ZXRpbWU6ICd7e2RhdGV9fVR7e2VuZFRpbWV9fScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBwcmVzZW5jZToge1xuICAgICAgICAgICAgICAgICAgICBidWlsZGluZ19pZDogJ3t7YnVpbGRpbmdJZH19JyxcbiAgICAgICAgICAgICAgICAgICAgZmxvb3JfaWQ6ICd7e2Zsb29ySWR9fScsXG4gICAgICAgICAgICAgICAgICAgIGFyZWFfaWQ6ICd7e2FyZWFJZH19JyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGRlc2tfYm9va2luZzogeyBkZXNrX3V1aWQ6ICd7e2Rlc2tJZH19JyB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgY2FuY2VsOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdERUxFVEUnLFxuICAgICAgICAgICAgLy8gTm90ZSBgL21lL2AsIG5vdCBgL3VzZXJzL3t7dXNlcklkfX0vYCBhcyBjcmVhdGUgdXNlcywgYW5kIHRoZVxuICAgICAgICAgICAgLy8gbnVtZXJpYyBib29raW5nIGlkIHJhdGhlciB0aGFuIGl0cyB1dWlkLiBCb3RoIGNvbmZpcm1lZCBmcm9tIGFcbiAgICAgICAgICAgIC8vIGNhcHR1cmVkIGNhbmNlbGxhdGlvbjsgbmVpdGhlciBpcyB3aGF0IHlvdSB3b3VsZCBoYXZlIGd1ZXNzZWRcbiAgICAgICAgICAgIC8vIGZyb20gdGhlIGNyZWF0ZSBjYWxsLlxuICAgICAgICAgICAgcGF0aDogJy92MS9tZS93b3JrX2FjdGl2aXR5X3NjaGVkdWxlL3t7Ym9va2luZ0lkfX0nLFxuICAgICAgICB9LFxuICAgIH0sXG59O1xuXG4vKipcbiAqIFRoZSBvZmZpY2UsIGFzIGNhcHR1cmVkIGluIEF1Z3VzdCAyMDI2LlxuICpcbiAqIEhhcmRjb2RlZCByYXRoZXIgdGhhbiBmZXRjaGVkLiBUaGUgZmxvb3IgZHJvcGRvd24gaGFzIHRvIGJlIHBvcHVsYXRlZCBiZWZvcmVcbiAqIGFueSBuZXR3b3JrIGNhbGwgaGFwcGVucywgYW4gb2ZmaWNlIGxheW91dCBjaGFuZ2VzIGFib3V0IG5ldmVyLCBhbmQgYVxuICogaGFyZGNvZGVkIGZsb29yIHRoYXQgaXMgd3JvbmcgaXMgYSB2aXNpYmxlIG1pc3Rha2UgcmF0aGVyIHRoYW4gYSBzaWxlbnQgb25lLlxuICpcbiAqIFRvIGFkZCBhIGZsb29yLCByZWFkIHRoZSBpZHMgZnJvbSB0aGUgcmVzcG9uc2Ugb2ZcbiAqIC9hcGkvdjIvc3BhY2VzLzxzcGFjZS11dWlkPi9idWlsZGluZ3MvPGJ1aWxkaW5nLWlkPi9mbG9vcnMuanNvbiB3aXRoIHRoZVxuICogZmxvb3IgcGxhbiBvcGVuLlxuICovXG5leHBvcnQgY29uc3QgQlVJTERJTkcgPSB7IGlkOiA1MTUxLCBuYW1lOiAnMTAweWFyZHMnIH07XG5cbi8qKlxuICogQSBkZXNrIG5hbWUgaXMgZGlnaXRzLCBhIGRhc2gsIGRpZ2l0cyBcdTIwMTQgYDMtMjNgLCBgMTItNGAuXG4gKlxuICogRGVsaWJlcmF0ZWx5IG5vdCB0aWdodGVuZWQgdG8gdHdvIHplcm8tcGFkZGVkIGRpZ2l0cywgd2hpY2ggaXMgd2hhdCB0aGlzXG4gKiBvZmZpY2UgaGFwcGVucyB0byB1c2U6IGEgZmxvb3IgMTIgb3IgYSBkZXNrIDEwMCB3b3VsZCB0aGVuIGJlIHJlamVjdGVkIGZvclxuICogbG9va2luZyB3cm9uZyByYXRoZXIgdGhhbiBmb3IgYmVpbmcgd3JvbmcuIFdoYXQgdGhpcyBjYXRjaGVzIGlzIHRoZSBtaXN0YWtlXG4gKiBwZW9wbGUgYWN0dWFsbHkgbWFrZSBcdTIwMTQgdHlwaW5nIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBhIGRlc2sgbnVtYmVyIGF0IGFsbDogYVxuICogbmFtZSwgYSByb29tLCBhIHN0cmF5IHNwYWNlLlxuICovXG5leHBvcnQgY29uc3QgREVTS19OQU1FX1BBVFRFUk4gPSAvXlxcZCstXFxkKyQvO1xuXG4vKiogRW1wdHkgaXMgbm90IHZhbGlkLCBidXQgaXQgaXMgbm90IGFuIGVycm9yIGVpdGhlciBcdTIwMTQgc2VlIHRoZSBwb3B1cC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ZhbGlkRGVza05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIERFU0tfTkFNRV9QQVRURVJOLnRlc3QobmFtZS50cmltKCkpO1xufVxuXG4vKipcbiAqIERyb3Agc2tpcCBkYXRlcyB0aGF0IGhhdmUgYWxyZWFkeSBwYXNzZWQuXG4gKlxuICogRGF5cyBjYW4gYmUgbWFya2VkIG1vbnRocyBhaGVhZCwgc28gd2l0aG91dCB0aGlzIHRoZSBsaXN0IG9ubHkgZXZlciBncm93cyBcdTIwMTRcbiAqIGEgeWVhciBvZiBcIkkgd2FzIGF3YXkgdGhhdCBUdWVzZGF5XCIgYWNjdW11bGF0aW5nIGluIHN0b3JhZ2UgYW5kIGluIHRoZVxuICogc2V0dGluZ3MgSlNPTiwgd2hlcmUgaXQgaXMgbm9pc2UgdGhhdCBtYWtlcyB0aGUgcmVhbCBlbnRyaWVzIGhhcmQgdG8gcmVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBydW5lUGFzdFNraXBEYXRlcyhza2lwRGF0ZXM6IHN0cmluZ1tdLCB0b2RheTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIHJldHVybiBza2lwRGF0ZXMuZmlsdGVyKChkYXRlKSA9PiBkYXRlID49IHRvZGF5KTtcbn1cblxuZXhwb3J0IGNvbnN0IEZMT09SUzogeyBpZDogbnVtYmVyOyBsYWJlbDogc3RyaW5nIH1bXSA9IFtcbiAgICB7IGlkOiA0OTUyLCBsYWJlbDogJ0Zsb29yIDMnIH0sXG4gICAgeyBpZDogNDk1MywgbGFiZWw6ICdGbG9vciA0JyB9LFxuXTtcblxuZXhwb3J0IHR5cGUgVmFycyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbi8qKlxuICogQSBwbGFjZWhvbGRlciB0aGF0IG1ha2VzIHVwIHRoZSAqZW50aXJlKiB2YWx1ZSBhbmQgcmVzb2x2ZXMgdG8gYW4gaW50ZWdlclxuICogYmVjb21lcyBhIG51bWJlci5cbiAqXG4gKiBUaGlzIG1hdHRlcnMgYmVjYXVzZSBKU09OIGRpc3Rpbmd1aXNoZXMgNTE1MSBmcm9tIFwiNTE1MVwiIGFuZCBDb21lZW4nc1xuICogcHJlc2VuY2UgYmxvY2sgd2FudHMgdGhlIGZvcm1lci4gUGFydGlhbCBpbnRlcnBvbGF0aW9uIFx1MjAxNCBcIi91c2Vycy97e3VzZXJJZH19L3hcIlxuICogXHUyMDE0IGFsd2F5cyB5aWVsZHMgYSBzdHJpbmcsIHdoaWNoIGlzIHdoYXQgYSBwYXRoIG5lZWRzLCBzbyB0aGUgdHdvIGNhc2VzIG5ldmVyXG4gKiBjb2xsaWRlLiBBIHV1aWQgb3IgYSBkYXRlIGNvbnRhaW5zIG5vbi1kaWdpdHMgYW5kIHN0YXlzIGEgc3RyaW5nIGVpdGhlciB3YXkuXG4gKi9cbmNvbnN0IFdIT0xFX1BMQUNFSE9MREVSID0gL15cXHtcXHsoXFx3KylcXH1cXH0kLztcbmNvbnN0IElOVEVHRVIgPSAvXi0/XFxkKyQvO1xuXG4vKiogUmVwbGFjZSB7e3BsYWNlaG9sZGVyc319IHRocm91Z2hvdXQgYSBKU09OLWlzaCB2YWx1ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdWJzdGl0dXRlKHZhbHVlOiB1bmtub3duLCB2YXJzOiBWYXJzKTogdW5rbm93biB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgY29uc3Qgd2hvbGUgPSBXSE9MRV9QTEFDRUhPTERFUi5leGVjKHZhbHVlKTtcbiAgICAgICAgaWYgKHdob2xlKSB7XG4gICAgICAgICAgICBjb25zdCByZXBsYWNlbWVudCA9IHZhcnNbd2hvbGVbMV0gPz8gJyddO1xuICAgICAgICAgICAgaWYgKHJlcGxhY2VtZW50ID09PSB1bmRlZmluZWQpIHJldHVybiB2YWx1ZTtcbiAgICAgICAgICAgIHJldHVybiBJTlRFR0VSLnRlc3QocmVwbGFjZW1lbnQpID8gTnVtYmVyKHJlcGxhY2VtZW50KSA6IHJlcGxhY2VtZW50O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9cXHtcXHsoXFx3KylcXH1cXH0vZywgKG1hdGNoLCBrZXk6IHN0cmluZykgPT4gdmFyc1trZXldID8/IG1hdGNoKTtcbiAgICB9XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZS5tYXAoKGVudHJ5KSA9PiBzdWJzdGl0dXRlKGVudHJ5LCB2YXJzKSk7XG4gICAgfVxuICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCBlbnRyeV0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUpKSBvdXRba2V5XSA9IHN1YnN0aXR1dGUoZW50cnksIHZhcnMpO1xuICAgICAgICByZXR1cm4gb3V0O1xuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG5cbi8qKlxuICogTWVyZ2Ugc3RvcmVkIHNldHRpbmdzIG92ZXIgdGhlIHNoaXBwZWQgZGVmYXVsdHMuXG4gKlxuICogUGVyc29uYWwgY2hvaWNlcyAoZGVzaywgd2Vla2RheXMsIHRpbWV6b25lKSBhbHdheXMgd2luOiB0aGV5IGFyZSB0aGUgdXNlcidzLlxuICogVGhlIGVuZHBvaW50IGNvbmZpZyBpcyBkaWZmZXJlbnQuIEl0IGlzIG5vdCBhIHByZWZlcmVuY2UsIGl0IGlzIGEgZmFjdCBhYm91dFxuICogQ29tZWVuJ3MgQVBJIHRoYXQgb25lIHBlcnNvbiBkaXNjb3ZlcnMgYW5kIGV2ZXJ5b25lIGVsc2UgaW5oZXJpdHMuIElmIGFcbiAqIHN0b3JlZCBjb3B5IHByZWRhdGVzIHRoZSBzaGlwcGVkIG9uZSwgdGhlIHNoaXBwZWQgb25lIHJlcGxhY2VzIGl0IG91dHJpZ2h0LlxuICogTWVyZ2luZyBrZXktYnkta2V5IHdvdWxkIGJlIHdvcnNlIHRoYW4gdXNlbGVzcyBoZXJlOiBhIGNvcnJlY3RlZCBgY3JlYXRlYFxuICogYmxvY2sgd291bGQgc2l0IG5leHQgdG8gYSBzdGFsZSBgbGlzdGAgYmxvY2sgYW5kIGZhaWwgaW4gYSBjb25mdXNpbmcgd2F5LlxuICpcbiAqIFB1cmUgYW5kIHNlcGFyYXRlIGZyb20gY2hyb21lLnN0b3JhZ2Ugc28gaXQgY2FuIGJlIHRlc3RlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlU2V0dGluZ3Moc3RvcmVkOiBQYXJ0aWFsPFNldHRpbmdzPiB8IHVuZGVmaW5lZCk6IFNldHRpbmdzIHtcbiAgICBjb25zdCBzdG9yZWRWZXJzaW9uID0gc3RvcmVkPy5lbmRwb2ludFZlcnNpb24gPz8gMDtcbiAgICBjb25zdCBzaGlwcGVkSXNOZXdlciA9IHN0b3JlZFZlcnNpb24gPCBERUZBVUxUX1NFVFRJTkdTLmVuZHBvaW50VmVyc2lvbjtcblxuICAgIHJldHVybiB7XG4gICAgICAgIC4uLkRFRkFVTFRfU0VUVElOR1MsXG4gICAgICAgIC4uLnN0b3JlZCxcbiAgICAgICAgZW5kcG9pbnRWZXJzaW9uOiBERUZBVUxUX1NFVFRJTkdTLmVuZHBvaW50VmVyc2lvbixcbiAgICAgICAgZW5kcG9pbnQ6IHNoaXBwZWRJc05ld2VyIHx8ICFzdG9yZWQ/LmVuZHBvaW50XG4gICAgICAgICAgICA/IERFRkFVTFRfU0VUVElOR1MuZW5kcG9pbnRcbiAgICAgICAgICAgIDogc3RvcmVkLmVuZHBvaW50LFxuICAgIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTxTZXR0aW5ncz4ge1xuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgnc2V0dGluZ3MnKTtcbiAgICByZXR1cm4gbWVyZ2VTZXR0aW5ncyhzdG9yZWQuc2V0dGluZ3MgYXMgUGFydGlhbDxTZXR0aW5ncz4gfCB1bmRlZmluZWQpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2F2ZVNldHRpbmdzKHNldHRpbmdzOiBTZXR0aW5ncyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IHNldHRpbmdzIH0pO1xufVxuIiwgImltcG9ydCB0eXBlIHsgRW5kcG9pbnRDb25maWcgfSBmcm9tICcuL2NvcmUvY29uZmlnLmpzJztcblxuZXhwb3J0IGludGVyZmFjZSBJblBhZ2VBcmdzIHtcbiAgICBlbmRwb2ludDogRW5kcG9pbnRDb25maWc7XG4gICAgZGF0ZXM6IHN0cmluZ1tdO1xuICAgIC8qKiBIdW1hbiBsYWJlbCwgZS5nLiBcIjMtMjNcIi4gVXNlZCB0byByZXNvbHZlIHRoZSBpZCB3aGVuIG9uZSBpcyBub3QgY2FjaGVkLiAqL1xuICAgIGRlc2tOYW1lOiBzdHJpbmc7XG4gICAgLyoqIEludGVybmFsIGlkLiBPbmx5IHVzZWQgd2hlbiBubyByZXNvbHZlIGVuZHBvaW50IGlzIGNvbmZpZ3VyZWQuICovXG4gICAgZGVza0lkOiBzdHJpbmc7XG4gICAgc2xvdDogc3RyaW5nO1xuICAgIC8qKiBEYXlzIHdob3NlIGV4aXN0aW5nIGJvb2tpbmcgc2hvdWxkIGJlIGNhbmNlbGxlZC4gKi9cbiAgICBjYW5jZWxEYXRlczogc3RyaW5nW107XG4gICAgLyoqIE5haXZlIGxvY2FsIHRpbWVzIGZvciB0aGUgc2xvdCwgZS5nLiBcIjAwOjAwOjAwLjAwMFpcIi4gKi9cbiAgICBzdGFydFRpbWU6IHN0cmluZztcbiAgICBlbmRUaW1lOiBzdHJpbmc7XG4gICAgZmxvb3JJZDogbnVtYmVyO1xuICAgIGJ1aWxkaW5nSWQ6IG51bWJlcjtcbiAgICBkcnlSdW46IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIEluUGFnZVN0YXR1cyA9ICdib29rZWQnIHwgJ2NhbmNlbGxlZCcgfCAnc2tpcHBlZCcgfCAnZHJ5LXJ1bicgfCAndW5hdmFpbGFibGUnIHwgJ2Vycm9yJztcblxuZXhwb3J0IGludGVyZmFjZSBJblBhZ2VSb3cge1xuICAgIGRhdGU6IHN0cmluZztcbiAgICBzdGF0dXM6IEluUGFnZVN0YXR1cztcbiAgICBkZXRhaWw/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5QYWdlUmVzdWx0IHtcbiAgICByb3dzOiBJblBhZ2VSb3dbXTtcbiAgICBub3Rlczogc3RyaW5nW107XG4gICAgLyoqIFNldCB3aGVuIHRoZSBkZXNrIGlkIHdhcyBsb29rZWQgdXAsIHNvIHRoZSBjYWxsZXIgY2FuIGNhY2hlIGl0LiAqL1xuICAgIHJlc29sdmVkRGVza0lkPzogc3RyaW5nO1xuICAgIC8qKlxuICAgICAqIFByZXNlbnQgb24gZXZlcnkgZWFybHkgcmV0dXJuLiBOZXZlciBjb250YWlucyBhIGNyZWRlbnRpYWwgXHUyMDE0IG9ubHkgd2hpY2hcbiAgICAgKiBwYWdlIHRoaXMgcmFuIG9uIGFuZCB3aGljaCBzdG9yYWdlIGtleXMgZXhpc3QsIG5ldmVyIHRoZWlyIHZhbHVlcy5cbiAgICAgKi9cbiAgICBkaWFnbm9zdGljcz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIC8qKlxuICAgICAqIFRoZSBzZXNzaW9uIGlzIGRlYWQuIEEgc3RydWN0dXJlZCBmbGFnIHJhdGhlciB0aGFuIHNvbWV0aGluZyB0aGUgY2FsbGVyXG4gICAgICogaGFzIHRvIHBhdHRlcm4tbWF0Y2ggb3V0IG9mIGBub3Rlc2AsIGJlY2F1c2UgdGhlIGJhY2tncm91bmQgc2NyaXB0IGFjdHNcbiAgICAgKiBvbiBpdDogaXQgYmFkZ2VzLCBub3RpZmllcywgYW5kIHJldHJpZXMgd2hlbiB5b3UgbmV4dCB2aXNpdCBDb21lZW4uXG4gICAgICovXG4gICAgc2lnbmVkT3V0PzogYm9vbGVhbjtcbiAgICAvKipcbiAgICAgKiBEYXRlcyB3aG9zZSBjYW5jZWxsYXRpb24gaXMgZG9uZSB3aXRoLCBzbyB0aGUgY2FsbGVyIGNhbiBkcm9wIHRoZW0gZnJvbVxuICAgICAqIGNhbmNlbERhdGVzLiBXaXRob3V0IHRoaXMgYW4gYXV0b21hdGljIHJ1biByZXRyaWVzIGV2ZXJ5IHBhc3RcbiAgICAgKiBjYW5jZWxsYXRpb24gZm9yZXZlci5cbiAgICAgKi9cbiAgICBjYW5jZWxsZWQ/OiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBSdW5zIGluc2lkZSB0aGUgQ29tZWVuIHRhYiwgaW4gdGhlIHBhZ2UncyBvd24gSmF2YVNjcmlwdCB3b3JsZC5cbiAqXG4gKiBcdTI1MDBcdTI1MDBcdTI1MDAgV2h5IGl0IGxvb2tzIGxpa2UgdGhpcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAqIGBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHRgIHNlcmlhbGl6ZXMgdGhpcyBmdW5jdGlvbiBhbmQgcmUtcGFyc2VzIGl0IGluXG4gKiB0aGUgcGFnZS4gSXQgdGhlcmVmb3JlIENBTk5PVCByZWZlcmVuY2UgYW55dGhpbmcgb3V0c2lkZSBpdHMgb3duIGJvZHk6IG5vXG4gKiBpbXBvcnRzLCBubyBtb2R1bGUtbGV2ZWwgaGVscGVycywgbm8gY2xvc3VyZXMuIEV2ZXJ5IGhlbHBlciBpcyBkZWZpbmVkIGlubGluZVxuICogb24gcHVycG9zZS4gUmVzaXN0IHRoZSB1cmdlIHRvIFwiY2xlYW4gdGhpcyB1cFwiIGJ5IGhvaXN0aW5nIHRoZW0gb3V0LlxuICpcbiAqIFx1MjUwMFx1MjUwMFx1MjUwMCBUaGUgc2VjdXJpdHkgcHJvcGVydHkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gKiBUaGUgY3JlZGVudGlhbCBpcyByZWFkIGhlcmUsIHVzZWQgaGVyZSwgYW5kIGRpc2NhcmRlZCBoZXJlLiBJdCBpcyBuZXZlclxuICogcmV0dXJuZWQgdG8gdGhlIGV4dGVuc2lvbiwgbmV2ZXIgd3JpdHRlbiB0byBjaHJvbWUuc3RvcmFnZSwgYW5kIG5ldmVyIGxlYXZlc1xuICogdGhlIHRhYi4gVGhlIGV4dGVuc2lvbiBob2xkcyBjb25maWd1cmF0aW9uIG9ubHkuIFRoYXQgaXMgdGhlIHdob2xlIHJlYXNvbiB0b1xuICogcHJlZmVyIHRoaXMgZGVzaWduIG92ZXIgYSBzZXJ2ZXItc2lkZSBzY3JpcHQgaG9sZGluZyBhIHN0b3JlZCB0b2tlbi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJvb2tJblBhZ2UoYXJnczogSW5QYWdlQXJncyk6IFByb21pc2U8SW5QYWdlUmVzdWx0PiB7XG4gICAgY29uc3QgeyBlbmRwb2ludCwgZGF0ZXMsIGRlc2tOYW1lLCBzbG90LCBzdGFydFRpbWUsIGVuZFRpbWUsIGRyeVJ1biB9ID0gYXJncztcbiAgICBjb25zdCBjYW5jZWxEYXRlcyA9IGFyZ3MuY2FuY2VsRGF0ZXMgPz8gW107XG4gICAgY29uc3Qgbm90ZXM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3Qgcm93czogSW5QYWdlUm93W10gPSBbXTtcbiAgICBsZXQgZGVza0lkID0gYXJncy5kZXNrSWQ7XG4gICAgbGV0IHJlc29sdmVkRGVza0lkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgbGV0IHNpZ25lZE91dCA9IGZhbHNlO1xuICAgIC8qKlxuICAgICAqIERheXMgdGhpcyBkZXNrIGFscmVhZHkgbG9va3Mgc3Bva2VuIGZvciwgcmVhZCBvZmYgdGhlIHJlc29sdmVkIGRlc2sncyBvd25cbiAgICAgKiBzY2hlZHVsZS4gRGVsaWJlcmF0ZWx5IEFEVklTT1JZOiBpdCBjaGFuZ2VzIHdoYXQgUHJldmlldyByZXBvcnRzLCBhbmRcbiAgICAgKiBuZXZlciB3aGV0aGVyIGEgcmVhbCBib29raW5nIGlzIGF0dGVtcHRlZC4gU2VlIHRoZSBjcmVhdGUgbG9vcC5cbiAgICAgKi9cbiAgICBjb25zdCB0YWtlbkRhdGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgICAvLyBXaGF0ZXZlciB3ZSBsZWFybiBhbG9uZyB0aGUgd2F5IGVuZHMgdXAgaGVyZSBhbmQgZmVlZHMgdGhlIGNyZWF0ZSBib2R5LlxuICAgIGNvbnN0IHZhcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgIGRlc2tOYW1lLFxuICAgICAgICBzbG90LFxuICAgICAgICBzdGFydFRpbWUsXG4gICAgICAgIGVuZFRpbWUsXG4gICAgICAgIGZsb29ySWQ6IFN0cmluZyhhcmdzLmZsb29ySWQpLFxuICAgICAgICBidWlsZGluZ0lkOiBTdHJpbmcoYXJncy5idWlsZGluZ0lkKSxcbiAgICAgICAgLy8gVGhlIHdpbmRvdyBtdXN0IHNwYW4gYm90aCB3aGF0IGlzIGJlaW5nIGJvb2tlZCBhbmQgd2hhdCBpcyBiZWluZ1xuICAgICAgICAvLyBjYW5jZWxsZWQ6IGEgYm9va2luZyBtYXJrZWQgZm9yIGNhbmNlbGxhdGlvbiBuZXh0IG1vbnRoIGlzIGludmlzaWJsZVxuICAgICAgICAvLyB0byBhIGxpc3QgcXVlcnkgdGhhdCBzdG9wcyBhdCB0aGUgYm9va2luZyBob3Jpem9uLlxuICAgICAgICBmcm9tOiBbLi4uZGF0ZXMsIC4uLmNhbmNlbERhdGVzXS5zb3J0KClbMF0gPz8gJycsXG4gICAgICAgIHRvOiBbLi4uZGF0ZXMsIC4uLmNhbmNlbERhdGVzXS5zb3J0KCkucG9wKCkgPz8gJycsXG4gICAgfTtcblxuICAgIC8vIERpYWdub3N0aWNzIGZvciBldmVyeSBmYWlsdXJlIHBhdGguIEtleSBOQU1FUyBvbmx5LCBuZXZlciB2YWx1ZXMsIHNvIHRoaXNcbiAgICAvLyBjYW4gc2F5IFwieW91IGFyZSBzaWduZWQgb3V0XCIgd2l0aG91dCBldmVyIGhhbmRsaW5nIGEgY3JlZGVudGlhbC5cbiAgICBjb25zdCBkaWFnbm9zdGljcyA9ICgpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiAoe1xuICAgICAgICB1cmw6IHdpbmRvdy5sb2NhdGlvbi5ocmVmLFxuICAgICAgICBsb2NhbFN0b3JhZ2VLZXlzOiAoKCkgPT4ge1xuICAgICAgICAgICAgdHJ5IHsgcmV0dXJuIE9iamVjdC5rZXlzKHdpbmRvdy5sb2NhbFN0b3JhZ2UpOyB9IGNhdGNoIHsgcmV0dXJuIFsnPHVucmVhZGFibGU+J107IH1cbiAgICAgICAgfSkoKSxcbiAgICAgICAgY29va2llTmFtZXM6ICgoKSA9PiB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBkb2N1bWVudC5jb29raWUuc3BsaXQoJzsnKVxuICAgICAgICAgICAgICAgICAgICAubWFwKChwYWlyKSA9PiBwYWlyLnNwbGl0KCc9JylbMF0/LnRyaW0oKSA/PyAnJylcbiAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggeyByZXR1cm4gWyc8dW5yZWFkYWJsZT4nXTsgfVxuICAgICAgICB9KSgpLFxuICAgIH0pO1xuXG4gICAgLy8gXHUyNTAwXHUyNTAwIGlubGluZSBoZWxwZXJzIChzZWUgY29tbWVudCBhYm92ZSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgICAvLyBNaXJyb3JzIGBzdWJzdGl0dXRlYCBpbiBjb3JlL2NvbmZpZy50cy4gQSBwbGFjZWhvbGRlciB0aGF0IGlzIHRoZSBlbnRpcmVcbiAgICAvLyB2YWx1ZSBhbmQgcmVzb2x2ZXMgdG8gYW4gaW50ZWdlciBiZWNvbWVzIGEgbnVtYmVyLCBiZWNhdXNlIENvbWVlbidzXG4gICAgLy8gcHJlc2VuY2UgYmxvY2sgd2FudHMgYnVpbGRpbmdfaWQ6IDUxNTEsIG5vdCBcIjUxNTFcIi4gUGFydGlhbFxuICAgIC8vIGludGVycG9sYXRpb24gc3RheXMgYSBzdHJpbmcsIHdoaWNoIGlzIHdoYXQgYSBVUkwgcGF0aCBuZWVkcy5cbiAgICBjb25zdCBmaWxsID0gKHZhbHVlOiB1bmtub3duLCBzb3VyY2U6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiB1bmtub3duID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGNvbnN0IHdob2xlID0gL15cXHtcXHsoXFx3KylcXH1cXH0kLy5leGVjKHZhbHVlKTtcbiAgICAgICAgICAgIGlmICh3aG9sZSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlcGxhY2VtZW50ID0gc291cmNlW3dob2xlWzFdID8/ICcnXTtcbiAgICAgICAgICAgICAgICBpZiAocmVwbGFjZW1lbnQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHZhbHVlO1xuICAgICAgICAgICAgICAgIHJldHVybiAvXi0/XFxkKyQvLnRlc3QocmVwbGFjZW1lbnQpID8gTnVtYmVyKHJlcGxhY2VtZW50KSA6IHJlcGxhY2VtZW50O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLnJlcGxhY2UoL1xce1xceyhcXHcrKVxcfVxcfS9nLCAobWF0Y2gsIGtleTogc3RyaW5nKSA9PiBzb3VyY2Vba2V5XSA/PyBtYXRjaCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gdmFsdWUubWFwKChlbnRyeSkgPT4gZmlsbChlbnRyeSwgc291cmNlKSk7XG4gICAgICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSkpIG91dFtrZXldID0gZmlsbChlbnRyeSwgc291cmNlKTtcbiAgICAgICAgICAgIHJldHVybiBvdXQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH07XG5cbiAgICBjb25zdCBkaWcgPSAob2JqOiB1bmtub3duLCBwYXRoOiBzdHJpbmcpOiB1bmtub3duID0+IHBhdGhcbiAgICAgICAgLnNwbGl0KCcuJylcbiAgICAgICAgLnJlZHVjZTx1bmtub3duPigoY3VycmVudCwga2V5KSA9PiAoXG4gICAgICAgICAgICBjdXJyZW50ICYmIHR5cGVvZiBjdXJyZW50ID09PSAnb2JqZWN0JyA/IChjdXJyZW50IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrZXldIDogdW5kZWZpbmVkXG4gICAgICAgICksIG9iaik7XG5cbiAgICBjb25zdCBhdXRoSGVhZGVycyA9ICgpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0+IHtcbiAgICAgICAgaWYgKGVuZHBvaW50LmF1dGgubW9kZSAhPT0gJ2xvY2FsU3RvcmFnZScpIHJldHVybiB7fTtcbiAgICAgICAgY29uc3QgeyBzdG9yYWdlS2V5LCBqc29uUGF0aCwgaGVhZGVyLCBwcmVmaXggfSA9IGVuZHBvaW50LmF1dGg7XG4gICAgICAgIGlmICghc3RvcmFnZUtleSB8fCAhanNvblBhdGgpIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goJ2F1dGgubW9kZSBpcyBsb2NhbFN0b3JhZ2UgYnV0IHN0b3JhZ2VLZXkvanNvblBhdGggYXJlIG1pc3NpbmcuJyk7XG4gICAgICAgICAgICByZXR1cm4ge307XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmF3ID0gd2luZG93LmxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkpO1xuICAgICAgICBpZiAoIXJhdykge1xuICAgICAgICAgICAgbm90ZXMucHVzaChgbG9jYWxTdG9yYWdlIGtleSBcIiR7c3RvcmFnZUtleX1cIiBub3QgZm91bmQuIEFyZSB5b3Ugc2lnbmVkIGluP2ApO1xuICAgICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICB9XG4gICAgICAgIGxldCB0b2tlbjogdW5rbm93bjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHRva2VuID0gZGlnKEpTT04ucGFyc2UocmF3KSwganNvblBhdGgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goYGxvY2FsU3RvcmFnZSBrZXkgXCIke3N0b3JhZ2VLZXl9XCIgaXMgbm90IEpTT04uYCk7XG4gICAgICAgICAgICByZXR1cm4ge307XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHR5cGVvZiB0b2tlbiAhPT0gJ3N0cmluZycgfHwgIXRva2VuKSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGBObyB0b2tlbiBhdCBwYXRoIFwiJHtqc29uUGF0aH1cIi5gKTtcbiAgICAgICAgICAgIHJldHVybiB7fTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBbaGVhZGVyID8/ICdhdXRob3JpemF0aW9uJ106IGAke3ByZWZpeCA/PyAnQmVhcmVyICd9JHt0b2tlbn1gIH07XG4gICAgfTtcblxuICAgIGNvbnN0IGNhbGwgPSBhc3luYyAoXG4gICAgICAgIHRwbDogeyBtZXRob2Q6IHN0cmluZzsgcGF0aDogc3RyaW5nOyBxdWVyeT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47IGJvZHk/OiB1bmtub3duIH0sXG4gICAgICAgIHNvdXJjZTogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbiAgICApOiBQcm9taXNlPHsgb2s6IGJvb2xlYW47IHN0YXR1czogbnVtYmVyOyBkYXRhOiB1bmtub3duOyB0ZXh0OiBzdHJpbmc7IHNpZ25lZE91dDogYm9vbGVhbiB9PiA9PiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBmaWxsKHRwbC5wYXRoLCBzb3VyY2UpIGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChgJHtlbmRwb2ludC5hcGlCYXNlLnJlcGxhY2UoL1xcLyQvLCAnJyl9JHtwYXRofWApO1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhmaWxsKHRwbC5xdWVyeSA/PyB7fSwgc291cmNlKSBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KSkge1xuICAgICAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoa2V5LCBTdHJpbmcodmFsdWUpKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBib2R5ID0gdHBsLmJvZHkgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IEpTT04uc3RyaW5naWZ5KGZpbGwodHBsLmJvZHksIHNvdXJjZSkpO1xuXG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHdpbmRvdy5mZXRjaCh1cmwudG9TdHJpbmcoKSwge1xuICAgICAgICAgICAgbWV0aG9kOiB0cGwubWV0aG9kLFxuICAgICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJyxcbiAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICBhY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAgICAgICAuLi4oYm9keSA9PT0gdW5kZWZpbmVkID8ge30gOiB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSksXG4gICAgICAgICAgICAgICAgLi4uYXV0aEhlYWRlcnMoKSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBib2R5LFxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcbiAgICAgICAgbGV0IGRhdGE6IHVua25vd24gPSBudWxsO1xuICAgICAgICB0cnkgeyBkYXRhID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsOyB9IGNhdGNoIHsgZGF0YSA9IG51bGw7IH1cblxuICAgICAgICAvLyBBbiBleHBpcmVkIHNlc3Npb24gZG9lcyBub3QgYW5ub3VuY2UgaXRzZWxmIHdpdGggYSB0aWR5IDQwMS4gQ29tZWVuXG4gICAgICAgIC8vIHJlZGlyZWN0cyB0byB0aGUgbG9naW4gcGFnZSwgc28gdGhlIGZldGNoIGZvbGxvd3MgaXQgYW5kIGhhbmRzIGJhY2sgYVxuICAgICAgICAvLyAyMDAgZnVsbCBvZiBIVE1MLiBQYXJzZWQgYXMgSlNPTiB0aGF0IGJlY29tZXMgbnVsbCwgd2hpY2ggZG93bnN0cmVhbVxuICAgICAgICAvLyByZWFkcyBhcyBcInplcm8gcmVzdWx0c1wiIFx1MjAxNCBoZW5jZSB0aGUgb2xkLCBiYWRseSBtaXNsZWFkaW5nIFwibm8gZGVza1xuICAgICAgICAvLyBjYWxsZWQgMy0yMyBpbiAwIHNlYXJjaCByZXN1bHQocylcIi4gQ2F0Y2ggaXQgaGVyZSBpbnN0ZWFkLlxuICAgICAgICBsZXQgZmluYWxIb3N0ID0gJyc7XG4gICAgICAgIHRyeSB7IGZpbmFsSG9zdCA9IG5ldyBVUkwocmVzLnVybCkuaG9zdG5hbWU7IH0gY2F0Y2ggeyAvKiBzdHViIG9yIG9wYXF1ZSAqLyB9XG4gICAgICAgIGNvbnN0IGxvb2tzTGlrZUh0bWwgPSAvXlxccyo8KCFkb2N0eXBlfGh0bWwpL2kudGVzdCh0ZXh0KTtcbiAgICAgICAgY29uc3Qgc2lnbmVkT3V0ID0gcmVzLnN0YXR1cyA9PT0gNDAxXG4gICAgICAgICAgICB8fCByZXMuc3RhdHVzID09PSA0MDNcbiAgICAgICAgICAgIHx8IC8oXnxcXC4pYWNjb3VudHNcXC5jb21lZW5cXC5pbyQvLnRlc3QoZmluYWxIb3N0KVxuICAgICAgICAgICAgfHwgKGxvb2tzTGlrZUh0bWwgJiYgZGF0YSA9PT0gbnVsbCk7XG5cbiAgICAgICAgcmV0dXJuIHsgb2s6IHJlcy5vaywgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhLCB0ZXh0LCBzaWduZWRPdXQgfTtcbiAgICB9O1xuXG4gICAgY29uc3Qgc2lnbmVkT3V0UmVzdWx0ID0gKCk6IEluUGFnZVJlc3VsdCA9PiAoe1xuICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgbm90ZXM6IFsnTm90IHNpZ25lZCBpbiB0byBDb21lZW4uIE9wZW4gaHR0cHM6Ly9teS5jb21lZW4uaW8vLCBzaWduIGluLCB0aGVuIHJ1biBhZ2Fpbi4nXSxcbiAgICAgICAgZGlhZ25vc3RpY3M6IGRpYWdub3N0aWNzKCksXG4gICAgICAgIHNpZ25lZE91dDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFzTGlzdCA9IChkYXRhOiB1bmtub3duKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSA9PiB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSByZXR1cm4gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdO1xuICAgICAgICBpZiAoZGF0YSAmJiB0eXBlb2YgZGF0YSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IG9iaiA9IGRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBbJ2l0ZW1zJywgJ2RhdGEnLCAncmVzdWx0cycsICdib29raW5ncycsICdkZXNrcyddKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob2JqW2tleV0pKSByZXR1cm4gb2JqW2tleV0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gW107XG4gICAgfTtcblxuICAgIGNvbnN0IG5vcm1hbGlzZSA9ICh2YWx1ZTogdW5rbm93bik6IHN0cmluZyA9PiBTdHJpbmcodmFsdWUgPz8gJycpXG4gICAgICAgIC50cmltKCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bXFxzX10rL2csICctJyk7XG5cbiAgICAvLyBDb25maXJtZWQgYWdhaW5zdCBhIHJlYWwgY29udGVuZGVkIGRheTogQ29tZWVuIHJlamVjdHMgYSBkZXNrIHNvbWVvbmUgZWxzZVxuICAgIC8vIGFscmVhZHkgaG9sZHMgd2l0aCA0MjIgYW5kIGEgbWVzc2FnZSwgbm90IGEgY2xlYW4gNDA5LiBSZWFkaW5nIHRoZSBtZXNzYWdlXG4gICAgLy8gYXMgd2VsbCBhcyB0aGUgc3RhdHVzIGlzIHdoYXQga2VlcHMgdGhhdCByZXBvcnRlZCBhcyBcInVuYXZhaWxhYmxlXCIgcmF0aGVyXG4gICAgLy8gdGhhbiBhcyBhbiBlcnJvciB0aGF0IGxvb2tzIGxpa2UgYSBidWcgaW4gdGhpcyBleHRlbnNpb24uXG4gICAgY29uc3QgbG9va3NUYWtlbiA9IChzdGF0dXM6IG51bWJlciwgdGV4dDogc3RyaW5nKTogYm9vbGVhbiA9PiBzdGF0dXMgPT09IDQwOVxuICAgICAgICB8fCBzdGF0dXMgPT09IDQyMlxuICAgICAgICB8fCAvdGFrZW58YWxyZWFkeXx1bmF2YWlsYWJsZXxvY2N1cGllZHxmdWxsfGNvbmZsaWN0L2kudGVzdCh0ZXh0KTtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCAxLiB3aGljaCBkZXNrPyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAvLyBSZXNvbHZpbmcgZXZlcnkgcnVuIHJhdGhlciB0aGFuIHRydXN0aW5nIGEgY2FjaGVkIGlkOiB0aGUgbG9va3VwIGFsc29cbiAgICAvLyB5aWVsZHMgdGhlIGRlc2sncyBhcmVhX2lkLCB3aGljaCB0aGUgY3JlYXRlIGJvZHkgbmVlZHMsIGFuZCBpdCBtZWFucyBhXG4gICAgLy8gcmVudW1iZXJlZCBvciBtb3ZlZCBkZXNrIGNvcnJlY3RzIGl0c2VsZiBpbnN0ZWFkIG9mIGJvb2tpbmcgdGhlIHdyb25nIHNlYXQuXG4gICAgaWYgKGVuZHBvaW50LnJlc29sdmUpIHtcbiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgY2FsbChlbmRwb2ludC5yZXNvbHZlLCB2YXJzKTtcbiAgICAgICAgaWYgKHJlcy5zaWduZWRPdXQpIHJldHVybiBzaWduZWRPdXRSZXN1bHQoKTtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgcm93czogW10sXG4gICAgICAgICAgICAgICAgbm90ZXM6IFtgRGVzayBsb29rdXAgZmFpbGVkICgke3Jlcy5zdGF0dXN9KTogJHtyZXMudGV4dC5zbGljZSgwLCAyMDApfWBdLFxuICAgICAgICAgICAgICAgIGRpYWdub3N0aWNzOiBkaWFnbm9zdGljcygpLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBhc0xpc3QocmVzLmRhdGEpO1xuICAgICAgICBjb25zdCBtYXRjaCA9IGNhbmRpZGF0ZXMuZmluZCgoZGVzaykgPT4gZW5kcG9pbnQuZGVza05hbWVGaWVsZHNcbiAgICAgICAgICAgIC5zb21lKChmaWVsZCkgPT4gbm9ybWFsaXNlKGRlc2tbZmllbGRdKSA9PT0gbm9ybWFsaXNlKGRlc2tOYW1lKSkpO1xuXG4gICAgICAgIGlmICghbWF0Y2gpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgcm93czogW10sXG4gICAgICAgICAgICAgICAgbm90ZXM6IFtcbiAgICAgICAgICAgICAgICAgICAgYE5vIGRlc2sgY2FsbGVkIFwiJHtkZXNrTmFtZX1cIiBpbiAke2NhbmRpZGF0ZXMubGVuZ3RofSBzZWFyY2ggcmVzdWx0KHMpLmAsXG4gICAgICAgICAgICAgICAgICAgIGBGaXJzdCBmZXc6ICR7SlNPTi5zdHJpbmdpZnkoY2FuZGlkYXRlcy5zbGljZSgwLCAzKSkuc2xpY2UoMCwgNDAwKX1gLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgZGlhZ25vc3RpY3M6IGRpYWdub3N0aWNzKCksXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgaWRGaWVsZCA9IGVuZHBvaW50LmRlc2tJZEZpZWxkcy5maW5kKChmaWVsZCkgPT4gbWF0Y2hbZmllbGRdICE9PSB1bmRlZmluZWRcbiAgICAgICAgICAgICYmIG1hdGNoW2ZpZWxkXSAhPT0gbnVsbCk7XG4gICAgICAgIGlmICghaWRGaWVsZCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgICAgICBub3RlczogW1xuICAgICAgICAgICAgICAgICAgICBgRm91bmQgXCIke2Rlc2tOYW1lfVwiIGJ1dCBub25lIG9mICR7ZW5kcG9pbnQuZGVza0lkRmllbGRzLmpvaW4oJy8nKX0gaGVsZCBhbiBpZC5gLFxuICAgICAgICAgICAgICAgICAgICBgUmVjb3JkOiAke0pTT04uc3RyaW5naWZ5KG1hdGNoKS5zbGljZSgwLCA0MDApfWAsXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICBkaWFnbm9zdGljczogZGlhZ25vc3RpY3MoKSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBkZXNrSWQgPSBTdHJpbmcobWF0Y2hbaWRGaWVsZF0pO1xuICAgICAgICByZXNvbHZlZERlc2tJZCA9IGRlc2tJZDtcbiAgICAgICAgbm90ZXMucHVzaChgUmVzb2x2ZWQgXCIke2Rlc2tOYW1lfVwiIHRvICR7aWRGaWVsZH0gJHtkZXNrSWR9LmApO1xuXG4gICAgICAgIC8vIFRoZSBkZXNrIGtub3dzIHdoaWNoIGFyZWEgYW5kIGZsb29yIGl0IGlzIGluOyBwcmVmZXIgdGhhdCBvdmVyIHRoZVxuICAgICAgICAvLyBjb25maWd1cmVkIGZsb29yLCB3aGljaCBpcyBvbmx5IGEgc3RhcnRpbmcgcG9pbnQgZm9yIHRoZSBsb29rdXAuXG4gICAgICAgIGlmIChtYXRjaC5hcmVhX2lkICE9PSB1bmRlZmluZWQgJiYgbWF0Y2guYXJlYV9pZCAhPT0gbnVsbCkgdmFycy5hcmVhSWQgPSBTdHJpbmcobWF0Y2guYXJlYV9pZCk7XG4gICAgICAgIGlmIChtYXRjaC5mbG9vcl9pZCAhPT0gdW5kZWZpbmVkICYmIG1hdGNoLmZsb29yX2lkICE9PSBudWxsKSB2YXJzLmZsb29ySWQgPSBTdHJpbmcobWF0Y2guZmxvb3JfaWQpO1xuXG4gICAgICAgIGlmIChtYXRjaC5hdmFpbGFibGVfdG9fYm9va2luZyA9PT0gZmFsc2UpIHtcbiAgICAgICAgICAgIG5vdGVzLnB1c2goYFx1MjZBMCBcIiR7ZGVza05hbWV9XCIgaXMgbWFya2VkIG5vdCBhdmFpbGFibGUgdG8gYm9va2luZyBcdTIwMTQgaXQgbWF5IGJlIGFzc2lnbmVkIHRvIHNvbWVvbmUuYCk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBUaGUgZGVzayBjYXJyaWVzIGl0cyBvd24gYm9va2luZ3MgZm9yIHRoZSBxdWVyaWVkIHdpbmRvdywgd2hpY2ggaXMgaG93XG4gICAgICAgIC8vIFByZXZpZXcgY2FuIHNheSBcInNvbWVvbmUgZWxzZSBoYXMgaXRcIiBpbnN0ZWFkIG9mIGNoZWVyZnVsbHkgcHJvbWlzaW5nXG4gICAgICAgIC8vIGEgZGF5IHRoYXQgd2lsbCA0MjIgdGhlIG1vbWVudCB5b3UgcHJlc3MgQm9vayBub3cuXG4gICAgICAgIGlmIChlbmRwb2ludC5kZXNrU2NoZWR1bGVGaWVsZCkge1xuICAgICAgICAgICAgY29uc3QgZW50cmllcyA9IG1hdGNoW2VuZHBvaW50LmRlc2tTY2hlZHVsZUZpZWxkXTtcbiAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudHJpZXMpKSB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+W10pIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFlbnRyeSB8fCB0eXBlb2YgZW50cnkgIT09ICdvYmplY3QnKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWVsZCBvZiBlbmRwb2ludC5kZXNrU2NoZWR1bGVEYXRlRmllbGRzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGVudHJ5W2ZpZWxkXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIC9eXFxkezR9LVxcZHsyfS1cXGR7Mn0vLnRlc3QodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFrZW5EYXRlcy5hZGQodmFsdWUuc2xpY2UoMCwgMTApKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAodGFrZW5EYXRlcy5zaXplID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBub3Rlcy5wdXNoKGBcIiR7ZGVza05hbWV9XCIgYWxyZWFkeSBoYXMgJHt0YWtlbkRhdGVzLnNpemV9IGRheShzKSBib29rZWQgaW4gdGhpcyB3aW5kb3cuYCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFkZXNrSWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHJvd3M6IFtdLFxuICAgICAgICAgICAgbm90ZXM6IFsnTm8gZGVzayBJRCBzZXQgYW5kIG5vIGRlc2stc2VhcmNoIGVuZHBvaW50IGNvbmZpZ3VyZWQuJ10sXG4gICAgICAgICAgICBkaWFnbm9zdGljczogZGlhZ25vc3RpY3MoKSxcbiAgICAgICAgfTtcbiAgICB9XG4gICAgdmFycy5kZXNrSWQgPSBkZXNrSWQ7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgMi4gd2hhdCBkbyBJIGFscmVhZHkgaGF2ZT8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgY29uc3QgaGVsZERhdGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgLyoqIGRhdGUgXHUyMTkyIHRoZSBpZCB0aGF0IGNhbmNlbGxpbmcgb25lIG5lZWRzLiAqL1xuICAgIGNvbnN0IGJvb2tpbmdJZHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuXG4gICAgaWYgKGVuZHBvaW50Lmxpc3QpIHtcbiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgY2FsbChlbmRwb2ludC5saXN0LCB2YXJzKTtcbiAgICAgICAgaWYgKHJlcy5zaWduZWRPdXQpIHJldHVybiBzaWduZWRPdXRSZXN1bHQoKTtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAgIC8vIE5vdCBmYXRhbCwgYnV0IGl0IG1lYW5zIHdlIGxvc2UgaWRlbXBvdGVuY3ksIHNvIHNheSBzbyBsb3VkbHkuXG4gICAgICAgICAgICBub3Rlcy5wdXNoKFxuICAgICAgICAgICAgICAgIGBDb3VsZCBub3QgbGlzdCBleGlzdGluZyBib29raW5ncyAoJHtyZXMuc3RhdHVzfSkuIFByb2NlZWRpbmcgd2l0aG91dCB0aGUgYFxuICAgICAgICAgICAgICAgICsgYGR1cGxpY2F0ZSBjaGVjaywgc28gZXhwZWN0IFwidW5hdmFpbGFibGVcIiBvbiBkYXlzIHlvdSBhbHJlYWR5IGhvbGQuIGBcbiAgICAgICAgICAgICAgICArIGBSZXNwb25zZTogJHtyZXMudGV4dC5zbGljZSgwLCAyMDApfWAsXG4gICAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gVGhlIHNpZ25lZC1pbiB1c2VyJ3Mgb3duIGlkIGlzIGluIHRoaXMgcmVzcG9uc2UsIGFuZCB0aGUgY3JlYXRlXG4gICAgICAgICAgICAvLyBwYXRoIG5lZWRzIGl0LiBSZWFkaW5nIGl0IGhlcmUgYXZvaWRzIGEgc2Vjb25kIHJvdW5kIHRyaXAgYW5kXG4gICAgICAgICAgICAvLyBhdm9pZHMgbWFraW5nIHRoZSB1c2VyIGxvb2sgdGhlaXIgb3duIGlkIHVwLlxuICAgICAgICAgICAgaWYgKGVuZHBvaW50LnVzZXJJZFBhdGgpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB1c2VySWQgPSBkaWcocmVzLmRhdGEsIGVuZHBvaW50LnVzZXJJZFBhdGgpO1xuICAgICAgICAgICAgICAgIGlmICh1c2VySWQgIT09IHVuZGVmaW5lZCAmJiB1c2VySWQgIT09IG51bGwpIHZhcnMudXNlcklkID0gU3RyaW5nKHVzZXJJZCk7XG4gICAgICAgICAgICAgICAgZWxzZSBub3Rlcy5wdXNoKGBObyB1c2VyIGlkIGF0IFwiJHtlbmRwb2ludC51c2VySWRQYXRofVwiIGluIHRoZSBsaXN0IHJlc3BvbnNlLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBjb250YWluZXIgPSBlbmRwb2ludC5saXN0Um9vdCA/IGRpZyhyZXMuZGF0YSwgZW5kcG9pbnQubGlzdFJvb3QpIDogcmVzLmRhdGE7XG5cbiAgICAgICAgICAgIGlmIChlbmRwb2ludC5saXN0U2hhcGUgPT09ICdkYXRlS2V5ZWRNYXAnKSB7XG4gICAgICAgICAgICAgICAgLy8geyBcIjIwMjYtMDktMDFcIjogW2VudHJ5XSwgXCIyMDI2LTA5LTAyXCI6IFtdIH0gXHUyMDE0IGEgZGF5IHdpdGggYW55XG4gICAgICAgICAgICAgICAgLy8gZW50cnkgaXMgYSBkYXkgYWxyZWFkeSBzcG9rZW4gZm9yLlxuICAgICAgICAgICAgICAgIGlmIChjb250YWluZXIgJiYgdHlwZW9mIGNvbnRhaW5lciA9PT0gJ29iamVjdCcgJiYgIUFycmF5LmlzQXJyYXkoY29udGFpbmVyKSkge1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IFtkYXRlLCBlbnRyaWVzXSBvZiBPYmplY3QuZW50cmllcyhjb250YWluZXIgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZW50cmllcykgfHwgZW50cmllcy5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZGF5ID0gZGF0ZS5zbGljZSgwLCAxMCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBoZWxkRGF0ZXMuYWRkKGRheSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBPbmUgZW50cnkgcGVyIGRheS4gVmVyaWZpZWQgcmF0aGVyIHRoYW4gYXNzdW1lZDogYWNyb3NzXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBldmVyeSBjYXB0dXJlZCByZXNwb25zZSwgbm8gZGF0ZSBldmVyIGNhcnJpZWQgbW9yZSB0aGFuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvbmUgd29yayBhY3Rpdml0eSBcdTIwMTQgQ29tZWVuJ3MgbW9kZWwgaXMgb25lIHBlciBkYXkuIEFcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIDYxLWRheSBxdWVyeSBhbHNvIGNhbWUgYmFjayB3aXRoIGV4YWN0bHkgNjEgZGF0ZSBrZXlzXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBhbmQgbm8gcGFnaW5hdGlvbiBmaWVsZHMsIHNvIHRoaXMgcmVzcG9uc2UgaXMgY29tcGxldGVcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGZvciBpdHMgd2luZG93IGFuZCBub3RoaW5nIGhlcmUgaXMgYmVpbmcgdHJ1bmNhdGVkLlxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZmlyc3QgPSBlbnRyaWVzWzBdIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpcnN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWVsZCBvZiBlbmRwb2ludC5saXN0Qm9va2luZ0lkRmllbGRzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gZmlyc3RbZmllbGRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUgIT09IHVuZGVmaW5lZCAmJiB2YWx1ZSAhPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9va2luZ0lkcy5zZXQoZGF5LCBTdHJpbmcodmFsdWUpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goYEZvdW5kICR7aGVsZERhdGVzLnNpemV9IGRheShzKSBhbHJlYWR5IGJvb2tlZCBpbiB0aGUgd2luZG93LmApO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goXG4gICAgICAgICAgICAgICAgICAgICAgICBgbGlzdFNoYXBlIGlzIGRhdGVLZXllZE1hcCBidXQgXCIke2VuZHBvaW50Lmxpc3RSb290fVwiIGlzIG5vdCBhbiBvYmplY3QuIGBcbiAgICAgICAgICAgICAgICAgICAgICAgICsgYEdvdDogJHtKU09OLnN0cmluZ2lmeShjb250YWluZXIpLnNsaWNlKDAsIDIwMCl9YCxcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYXNMaXN0KGNvbnRhaW5lcik7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBib29raW5nIG9mIGV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZmllbGQgb2YgZW5kcG9pbnQubGlzdERhdGVGaWVsZHMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gYm9va2luZ1tmaWVsZF07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGRheSA9IHZhbHVlLnNsaWNlKDAsIDEwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBoZWxkRGF0ZXMuYWRkKGRheSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBpZEZpZWxkIG9mIGVuZHBvaW50Lmxpc3RCb29raW5nSWRGaWVsZHMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgaWQgPSBib29raW5nW2lkRmllbGRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaWQgIT09IHVuZGVmaW5lZCAmJiBpZCAhPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9va2luZ0lkcy5zZXQoZGF5LCBTdHJpbmcoaWQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG5vdGVzLnB1c2goYEZvdW5kICR7ZXhpc3RpbmcubGVuZ3RofSBleGlzdGluZyBib29raW5nKHMpIGluIHRoZSB3aW5kb3cuYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBgbWVgIHdvcmtzIGZvciByZWFkcywgc28gaXQgaXMgYSBiZXR0ZXIgZmFsbGJhY2sgdGhhbiBhIGxpdGVyYWxcbiAgICAvLyB7e3VzZXJJZH19IGluIHRoZSBwYXRoIGlmIHRoZSBsaXN0IHN0ZXAgY291bGQgbm90IHN1cHBseSBvbmUuXG4gICAgaWYgKHZhcnMudXNlcklkID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdmFycy51c2VySWQgPSAnbWUnO1xuICAgICAgICBpZiAoZW5kcG9pbnQudXNlcklkUGF0aCkgbm90ZXMucHVzaCgnRmFsbGluZyBiYWNrIHRvIC91c2Vycy9tZSBmb3IgdGhlIGJvb2tpbmcgcGF0aC4nKTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgMy4gY2FuY2VsIHdoYXQgd2FzIGFza2VkIGZvciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAvLyBCZWZvcmUgYm9va2luZywgc28gdGhhdCBhIGRhdGUgc29tZWhvdyBwcmVzZW50IGluIGJvdGggbGlzdHMgZW5kcyB1cFxuICAgIC8vIGNhbmNlbGxlZCByYXRoZXIgdGhhbiBjYW5jZWxsZWQtdGhlbi1pbW1lZGlhdGVseS1yZWJvb2tlZC5cbiAgICBjb25zdCBjYW5jZWxsZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICAgIGZvciAoY29uc3QgZGF0ZSBvZiBjYW5jZWxEYXRlcykge1xuICAgICAgICBpZiAoIWVuZHBvaW50LmNhbmNlbCkge1xuICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnZXJyb3InLCBkZXRhaWw6ICdubyBjYW5jZWwgZW5kcG9pbnQgY29uZmlndXJlZCcgfSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGJvb2tpbmdJZCA9IGJvb2tpbmdJZHMuZ2V0KGRhdGUpO1xuICAgICAgICBpZiAoIWJvb2tpbmdJZCkge1xuICAgICAgICAgICAgLy8gTm90aGluZyB0byBkZWxldGU6IGFscmVhZHkgZ29uZSwgb3IgbmV2ZXIgaGVsZC4gRWl0aGVyIHdheSB0aGVcbiAgICAgICAgICAgIC8vIGRlc2lyZWQgc3RhdGUgaXMgcmVhY2hlZCwgc28gdGhpcyBpcyBub3QgYSBmYWlsdXJlLlxuICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnc2tpcHBlZCcsIGRldGFpbDogJ25vdGhpbmcgYm9va2VkIHRvIGNhbmNlbCcgfSk7XG4gICAgICAgICAgICBjYW5jZWxsZWQuYWRkKGRhdGUpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoZHJ5UnVuKSB7XG4gICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICdkcnktcnVuJywgZGV0YWlsOiBgd291bGQgY2FuY2VsIGJvb2tpbmcgJHtib29raW5nSWR9YCB9KTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGNhbGwoZW5kcG9pbnQuY2FuY2VsLCB7IC4uLnZhcnMsIGRhdGUsIGJvb2tpbmdJZCB9KTtcbiAgICAgICAgICAgIGlmIChyZXMuc2lnbmVkT3V0KSB7XG4gICAgICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnZXJyb3InLCBkZXRhaWw6ICdub3Qgc2lnbmVkIGluJyB9KTtcbiAgICAgICAgICAgICAgICBub3Rlcy5wdXNoKCdTaWduZWQgb3V0IGJlZm9yZSBjYW5jZWxsaW5nLiBTaWduIGluIGFuZCBydW4gYWdhaW4uJyk7XG4gICAgICAgICAgICAgICAgc2lnbmVkT3V0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChyZXMub2sgfHwgcmVzLnN0YXR1cyA9PT0gNDA0KSB7XG4gICAgICAgICAgICAgICAgLy8gNDA0IG1lYW5zIHNvbWVib2R5IG9yIHNvbWV0aGluZyBhbHJlYWR5IHJlbW92ZWQgaXQuIFRoZSBlbmRcbiAgICAgICAgICAgICAgICAvLyBzdGF0ZSBpcyB3aGF0IHdhcyB3YW50ZWQsIHNvIHJlcG9ydCBpdCBhcyBkb25lLlxuICAgICAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ2NhbmNlbGxlZCcsIGRldGFpbDogcmVzLnN0YXR1cyA9PT0gNDA0ID8gJ2FscmVhZHkgZ29uZScgOiB1bmRlZmluZWQgfSk7XG4gICAgICAgICAgICAgICAgY2FuY2VsbGVkLmFkZChkYXRlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnZXJyb3InLCBkZXRhaWw6IGAke3Jlcy5zdGF0dXN9OiAke3Jlcy50ZXh0LnNsaWNlKDAsIDIwMCl9YCB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICdlcnJvcicsIGRldGFpbDogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpIH0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIDQuIGJvb2sgdGhlIGdhcHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgZm9yIChjb25zdCBkYXRlIG9mIGRhdGVzKSB7XG4gICAgICAgIC8vIEJlbHQgYW5kIGJyYWNlczogdGhlIHBvcHVwIGFkZHMgYSBjYW5jZWxsZWQgZGF5IHRvIHNraXBEYXRlcyB0b28sIHNvXG4gICAgICAgIC8vIGl0IHNob3VsZCBub3QgYXBwZWFyIGhlcmUgYXQgYWxsLiBJZiBpdCBzb21laG93IGRvZXMsIGNhbmNlbGxpbmcgYW5kXG4gICAgICAgIC8vIHRoZW4gcmVib29raW5nIGluIG9uZSBydW4gd291bGQgYmUgdGhlIHdvcnN0IHBvc3NpYmxlIG91dGNvbWUuXG4gICAgICAgIGlmIChjYW5jZWxEYXRlcy5pbmNsdWRlcyhkYXRlKSkgY29udGludWU7XG5cbiAgICAgICAgaWYgKGhlbGREYXRlcy5oYXMoZGF0ZSkpIHtcbiAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ3NraXBwZWQnLCBkZXRhaWw6ICdhbHJlYWR5IGJvb2tlZCcgfSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZHJ5UnVuKSB7XG4gICAgICAgICAgICByb3dzLnB1c2godGFrZW5EYXRlcy5oYXMoZGF0ZSlcbiAgICAgICAgICAgICAgICA/IHsgZGF0ZSwgc3RhdHVzOiAndW5hdmFpbGFibGUnLCBkZXRhaWw6ICdzb21lb25lIGVsc2UgaG9sZHMgdGhpcyBkZXNrIHRoYXQgZGF5JyB9XG4gICAgICAgICAgICAgICAgOiB7IGRhdGUsIHN0YXR1czogJ2RyeS1ydW4nLCBkZXRhaWw6IGB3b3VsZCBib29rICR7ZGVza0lkfSAoJHtzbG90fSlgIH0pO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBOb3RlIHRoZSBhc3ltbWV0cnksIGFuZCBkbyBub3QgXCJvcHRpbWlzZVwiIHRoaXMgaW50byBhIHNraXAuIFRoZSBkZXNrXG4gICAgICAgIC8vIHNjaGVkdWxlIGlzIHJlYWQgZGVmZW5zaXZlbHkgZnJvbSBhIHNoYXBlIHRoYXQgaGFzIG5ldmVyIGJlZW4gc2VlblxuICAgICAgICAvLyBwb3B1bGF0ZWQsIHNvIGEgbWlzcmVhZGluZyBpcyBwb3NzaWJsZS4gQXR0ZW1wdGluZyBhbnl3YXkgY29zdHMgb25lXG4gICAgICAgIC8vIHJlcXVlc3QgdGhhdCByZXR1cm5zIDQyMiBhbmQgaXMgcmVwb3J0ZWQgYXMgdW5hdmFpbGFibGUgXHUyMDE0IGV4YWN0bHkgd2hhdFxuICAgICAgICAvLyB3b3VsZCBoYXZlIGJlZW4gcmVwb3J0ZWQgYnkgc2tpcHBpbmcuIFNraXBwaW5nIHdyb25nbHkgY29zdHMgYSBkYXlcbiAgICAgICAgLy8geW91IGNvdWxkIGhhdmUgaGFkLCBhbmQgZG9lcyBpdCBzaWxlbnRseS5cbiAgICAgICAgaWYgKHRha2VuRGF0ZXMuaGFzKGRhdGUpKSB7XG4gICAgICAgICAgICBub3Rlcy5wdXNoKGAke2RhdGV9OiBkZXNrIGxvb2tzIHRha2VuOyB0cnlpbmcgYW55d2F5IGluIGNhc2UgdGhhdCByZWFkaW5nIGlzIHdyb25nLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGNhbGwoZW5kcG9pbnQuY3JlYXRlLCB7IC4uLnZhcnMsIGRhdGUgfSk7XG4gICAgICAgICAgICBpZiAocmVzLnNpZ25lZE91dCkge1xuICAgICAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ2Vycm9yJywgZGV0YWlsOiAnbm90IHNpZ25lZCBpbicgfSk7XG4gICAgICAgICAgICAgICAgbm90ZXMucHVzaCgnU2lnbmVkIG91dCBwYXJ0d2F5IHRocm91Z2guIFNpZ24gaW4gYXQgaHR0cHM6Ly9teS5jb21lZW4uaW8vIGFuZCBydW4gJ1xuICAgICAgICAgICAgICAgICAgICArICdhZ2FpbiBcdTIwMTQgdGhlIGRheXMgYWxyZWFkeSBib29rZWQgd2lsbCBiZSBza2lwcGVkLicpO1xuICAgICAgICAgICAgICAgIHNpZ25lZE91dCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzLm9rKSB7XG4gICAgICAgICAgICAgICAgcm93cy5wdXNoKHsgZGF0ZSwgc3RhdHVzOiAnYm9va2VkJyB9KTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobG9va3NUYWtlbihyZXMuc3RhdHVzLCByZXMudGV4dCkpIHtcbiAgICAgICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICd1bmF2YWlsYWJsZScsIGRldGFpbDogYCR7cmVzLnN0YXR1c306ICR7cmVzLnRleHQuc2xpY2UoMCwgMTYwKX1gIH0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByb3dzLnB1c2goeyBkYXRlLCBzdGF0dXM6ICdlcnJvcicsIGRldGFpbDogYCR7cmVzLnN0YXR1c306ICR7cmVzLnRleHQuc2xpY2UoMCwgMjAwKX1gIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJvd3MucHVzaCh7IGRhdGUsIHN0YXR1czogJ2Vycm9yJywgZGV0YWlsOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4geyByb3dzLCBub3RlcywgcmVzb2x2ZWREZXNrSWQsIHNpZ25lZE91dCwgY2FuY2VsbGVkOiBbLi4uY2FuY2VsbGVkXSB9O1xufVxuIiwgImltcG9ydCB7IGRhdGVzVG9Cb29rLCBoYXNTbG90U3RhcnRlZCB9IGZyb20gJy4vY29yZS9kYXRlcy5qcyc7XG5pbXBvcnQge1xuICAgIGlzVmFsaWREZXNrTmFtZSxcbiAgICBsb2FkU2V0dGluZ3MsXG4gICAgc2F2ZVNldHRpbmdzLFxuICAgIFNMT1RfVElNRVMsXG4gICAgdHlwZSBTZXR0aW5ncyxcbn0gZnJvbSAnLi9jb3JlL2NvbmZpZy5qcyc7XG5pbXBvcnQgeyBib29rSW5QYWdlLCB0eXBlIEluUGFnZVJlc3VsdCB9IGZyb20gJy4vaW5qZWN0ZWQuanMnO1xuXG5jb25zdCBBTEFSTSA9ICdjb21lZW4tdG9wLXVwJztcbmNvbnN0IENPTUVFTl9VUkwgPSAnaHR0cHM6Ly9teS5jb21lZW4uaW8vJztcbmNvbnN0IFRBQl9NQVRDSCA9ICdodHRwczovL215LmNvbWVlbi5pby8qJztcbmNvbnN0IFNJR05FRF9PVVRfTk9USUZJQ0FUSU9OID0gJ2NvbWVlbi1zaWduZWQtb3V0JztcblxuLyoqXG4gKiBUaHJvd24gd2hlbiB0aGUgc2Vzc2lvbiBpcyBnb25lLCBzbyB0aGUgY2FsbGVyIGNhbiB0ZWxsIGl0IGFwYXJ0IGZyb20gYW5cbiAqIG9yZGluYXJ5IGZhaWx1cmUgYnkgdHlwZSByYXRoZXIgdGhhbiBieSByZWFkaW5nIHRoZSBtZXNzYWdlIHRleHQuXG4gKi9cbmNsYXNzIFNpZ25lZE91dEVycm9yIGV4dGVuZHMgRXJyb3Ige31cblxuZXhwb3J0IGludGVyZmFjZSBSdW5Mb2cge1xuICAgIGF0OiBzdHJpbmc7XG4gICAgZHJ5UnVuOiBib29sZWFuO1xuICAgIGRhdGVzOiBzdHJpbmdbXTtcbiAgICByb3dzOiBJblBhZ2VSZXN1bHRbJ3Jvd3MnXTtcbiAgICBub3Rlczogc3RyaW5nW107XG4gICAgZXJyb3I/OiBzdHJpbmc7XG4gICAgLyoqIFRoZSBydW4gc3RvcHBlZCBiZWNhdXNlIHRoZSBDb21lZW4gc2Vzc2lvbiBoYXMgZXhwaXJlZC4gKi9cbiAgICBzaWduZWRPdXQ/OiBib29sZWFuO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhcHBlbmRMb2coZW50cnk6IFJ1bkxvZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHsgcnVucyA9IFtdIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoJ3J1bnMnKSBhcyB7IHJ1bnM/OiBSdW5Mb2dbXSB9O1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IHJ1bnM6IFtlbnRyeSwgLi4ucnVuc10uc2xpY2UoMCwgMTApIH0pO1xufVxuXG4vKipcbiAqIEZpbmQgYSBDb21lZW4gdGFiLCBvciBvcGVuIG9uZSBpbiB0aGUgYmFja2dyb3VuZC5cbiAqIFJldHVybnMgdGhlIHRhYiBpZCBwbHVzIHdoZXRoZXIgd2UgY3JlYXRlZCBpdCAoYW5kIHNob3VsZCB0aGVyZWZvcmUgY2xvc2UgaXQpLlxuICovXG5hc3luYyBmdW5jdGlvbiBnZXRDb21lZW5UYWIoKTogUHJvbWlzZTx7IHRhYklkOiBudW1iZXI7IHRlbXBvcmFyeTogYm9vbGVhbiB9PiB7XG4gICAgY29uc3Qgb3BlbiA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgdXJsOiBUQUJfTUFUQ0ggfSk7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBvcGVuLmZpbmQoKHQpID0+IHR5cGVvZiB0LmlkID09PSAnbnVtYmVyJyAmJiB0LnN0YXR1cyA9PT0gJ2NvbXBsZXRlJylcbiAgICAgICAgPz8gb3Blbi5maW5kKCh0KSA9PiB0eXBlb2YgdC5pZCA9PT0gJ251bWJlcicpO1xuICAgIGlmIChleGlzdGluZz8uaWQgIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgdGFiSWQ6IGV4aXN0aW5nLmlkLCB0ZW1wb3Jhcnk6IGZhbHNlIH07XG5cbiAgICBjb25zdCB0YWIgPSBhd2FpdCBjaHJvbWUudGFicy5jcmVhdGUoeyB1cmw6IENPTUVFTl9VUkwsIGFjdGl2ZTogZmFsc2UgfSk7XG4gICAgaWYgKHRhYi5pZCA9PT0gdW5kZWZpbmVkKSB0aHJvdyBuZXcgRXJyb3IoJ0NvdWxkIG5vdCBvcGVuIGEgQ29tZWVuIHRhYi4nKTtcbiAgICBhd2FpdCB3YWl0Rm9yTG9hZCh0YWIuaWQpO1xuXG4gICAgLy8gQW4gZXhwaXJlZCBzZXNzaW9uIHJlZGlyZWN0cyBteS5jb21lZW4uaW8gdG8gYWNjb3VudHMuY29tZWVuLmlvLCB3aGljaCBpc1xuICAgIC8vIGRlbGliZXJhdGVseSBub3QgaW4gaG9zdF9wZXJtaXNzaW9ucyBcdTIwMTQgc28gZXhlY3V0ZVNjcmlwdCB3b3VsZCBmYWlsIHRoZXJlXG4gICAgLy8gd2l0aCBhIHBlcm1pc3Npb25zIGVycm9yIHRoYXQgc2F5cyBub3RoaW5nIGFib3V0IHRoZSBhY3R1YWwgcHJvYmxlbS5cbiAgICAvLyBDaGVja2luZyB0aGUgVVJMIHR1cm5zIHRoYXQgaW50byBhIHNlbnRlbmNlIHdvcnRoIHJlYWRpbmcuXG4gICAgY29uc3QgbG9hZGVkID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHRhYi5pZCk7XG4gICAgaWYgKGxvYWRlZC51cmwgJiYgIWxvYWRlZC51cmwuc3RhcnRzV2l0aChDT01FRU5fVVJMKSkge1xuICAgICAgICB0aHJvdyBuZXcgU2lnbmVkT3V0RXJyb3IoXG4gICAgICAgICAgICAnTm90IHNpZ25lZCBpbiB0byBDb21lZW4gKHRoZSBwYWdlIHJlZGlyZWN0ZWQgdG8gc2lnbi1pbikuICdcbiAgICAgICAgICAgICsgJ09wZW4gaHR0cHM6Ly9teS5jb21lZW4uaW8vLCBzaWduIGluLCB0aGVuIHJ1biBhZ2Fpbi4nLFxuICAgICAgICApO1xuICAgIH1cblxuICAgIHJldHVybiB7IHRhYklkOiB0YWIuaWQsIHRlbXBvcmFyeTogdHJ1ZSB9O1xufVxuXG5mdW5jdGlvbiB3YWl0Rm9yTG9hZCh0YWJJZDogbnVtYmVyLCB0aW1lb3V0TXMgPSAzMF8wMDApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgY2hyb21lLnRhYnMub25VcGRhdGVkLnJlbW92ZUxpc3RlbmVyKGxpc3RlbmVyKTtcbiAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoJ0NvbWVlbiB0YWIgZGlkIG5vdCBmaW5pc2ggbG9hZGluZyBpbiB0aW1lLicpKTtcbiAgICAgICAgfSwgdGltZW91dE1zKTtcblxuICAgICAgICBjb25zdCBsaXN0ZW5lciA9IChpZDogbnVtYmVyLCBpbmZvOiBjaHJvbWUudGFicy5UYWJDaGFuZ2VJbmZvKTogdm9pZCA9PiB7XG4gICAgICAgICAgICBpZiAoaWQgIT09IHRhYklkIHx8IGluZm8uc3RhdHVzICE9PSAnY29tcGxldGUnKSByZXR1cm47XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgY2hyb21lLnRhYnMub25VcGRhdGVkLnJlbW92ZUxpc3RlbmVyKGxpc3RlbmVyKTtcbiAgICAgICAgICAgIC8vIFRoZSBTUEEgbmVlZHMgYSBtb21lbnQgYWZ0ZXIgYGNvbXBsZXRlYCBiZWZvcmUgaXRzIGF1dGggc3RhdGUgaXMgcmVhZHkuXG4gICAgICAgICAgICBzZXRUaW1lb3V0KHJlc29sdmUsIDJfNTAwKTtcbiAgICAgICAgfTtcbiAgICAgICAgY2hyb21lLnRhYnMub25VcGRhdGVkLmFkZExpc3RlbmVyKGxpc3RlbmVyKTtcbiAgICB9KTtcbn1cblxubGV0IGluRmxpZ2h0OiBQcm9taXNlPFJ1bkxvZz4gfCB1bmRlZmluZWQ7XG5cbi8qKlxuICogT25lIHJ1biBhdCBhIHRpbWUuIFR3byBvdmVybGFwcGluZyBydW5zIHdvdWxkIGVhY2ggcmVhZCB0aGUgYm9va2luZ3MgbGlzdFxuICogYmVmb3JlIHRoZSBvdGhlciBoYWQgd3JpdHRlbiBhbnl0aGluZywgc28gYm90aCB3b3VsZCBkZWNpZGUgdGhlIHNhbWUgZGF5IHdhc1xuICogZnJlZSBhbmQgYm90aCB3b3VsZCB0cnkgdG8gYm9vayBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJ1bkJvb2tpbmcoZHJ5UnVuOiBib29sZWFuKTogUHJvbWlzZTxSdW5Mb2c+IHtcbiAgICBpZiAoaW5GbGlnaHQpIHJldHVybiBpbkZsaWdodDtcbiAgICBpbkZsaWdodCA9IHJ1bkJvb2tpbmdPbmNlKGRyeVJ1bikuZmluYWxseSgoKSA9PiB7IGluRmxpZ2h0ID0gdW5kZWZpbmVkOyB9KTtcbiAgICByZXR1cm4gaW5GbGlnaHQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bkJvb2tpbmdPbmNlKGRyeVJ1bjogYm9vbGVhbik6IFByb21pc2U8UnVuTG9nPiB7XG4gICAgY29uc3Qgc2V0dGluZ3M6IFNldHRpbmdzID0gYXdhaXQgbG9hZFNldHRpbmdzKCk7XG5cbiAgICBjb25zdCBwbGFubmVkID0gZGF0ZXNUb0Jvb2soe1xuICAgICAgICB3ZWVrZGF5czogc2V0dGluZ3Mud2Vla2RheXMsXG4gICAgICAgIGhvcml6b25EYXlzOiBzZXR0aW5ncy5ob3Jpem9uRGF5cyxcbiAgICAgICAgc2tpcERhdGVzOiBzZXR0aW5ncy5za2lwRGF0ZXMsXG4gICAgICAgIHRpbWVab25lOiBzZXR0aW5ncy50aW1lWm9uZSxcbiAgICB9KTtcblxuICAgIC8vIENvbWVlbiBhbnN3ZXJzIGEgYm9va2luZyB3aG9zZSBzdGFydCB0aW1lIGhhcyBwYXNzZWQgd2l0aCBhIDUwMCwgYW5kXG4gICAgLy8gYW5zd2VycyBpdHMgb3duIHdlYiBVSSB0aGUgc2FtZSB3YXksIHNvIHRoaXMgaXMgaXRzIGJlaGF2aW91ciByYXRoZXIgdGhhblxuICAgIC8vIG91cnMuIFdpdGggdGhlIGRlZmF1bHQgYWxsLWRheSBzbG90IHRoYXQgbWVhbnMgdG9kYXkgaXMgdW5ib29rYWJsZSBmcm9tXG4gICAgLy8gb25lIHNlY29uZCBwYXN0IG1pZG5pZ2h0LiBTZW5kaW5nIGl0IGFueXdheSB3b3VsZCBwdXQgYW4gZXJyb3Igb24gZXZlcnlcbiAgICAvLyBzaW5nbGUgcnVuIGZvciBldmVyLCBhbmQgYW4gYWxhcm0gdGhhdCBpcyBhbHdheXMgb24gaXMgbm90IGFuIGFsYXJtLlxuICAgIGNvbnN0IHNsb3RTdGFydCA9IFNMT1RfVElNRVNbc2V0dGluZ3Muc2xvdF0uc3RhcnQ7XG4gICAgY29uc3QgZGF0ZXMgPSBwbGFubmVkLmZpbHRlcigoZGF0ZSkgPT4gIWhhc1Nsb3RTdGFydGVkKGRhdGUsIHNsb3RTdGFydCwgc2V0dGluZ3MudGltZVpvbmUpKTtcbiAgICBjb25zdCBzdGFydGVkQWxyZWFkeSA9IHBsYW5uZWQuZmlsdGVyKChkYXRlKSA9PiBoYXNTbG90U3RhcnRlZChkYXRlLCBzbG90U3RhcnQsIHNldHRpbmdzLnRpbWVab25lKSk7XG5cbiAgICBjb25zdCBiYXNlOiBSdW5Mb2cgPSB7IGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIGRyeVJ1biwgZGF0ZXMsIHJvd3M6IFtdLCBub3RlczogW10gfTtcbiAgICBpZiAoc3RhcnRlZEFscmVhZHkubGVuZ3RoID4gMCkge1xuICAgICAgICBiYXNlLm5vdGVzLnB1c2goXG4gICAgICAgICAgICBgTm90IGF0dGVtcHRpbmcgJHtzdGFydGVkQWxyZWFkeS5qb2luKCcsICcpfTogdGhlICR7c2V0dGluZ3Muc2xvdH0gc2xvdCBoYXMgYWxyZWFkeSBgXG4gICAgICAgICAgICArICdzdGFydGVkLCBhbmQgQ29tZWVuIHJlZnVzZXMgYSBib29raW5nIHdob3NlIHN0YXJ0IHRpbWUgaGFzIHBhc3NlZC4nLFxuICAgICAgICApO1xuICAgIH1cblxuICAgIGlmIChkYXRlcy5sZW5ndGggPT09IDAgJiYgc2V0dGluZ3MuY2FuY2VsRGF0ZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0geyAuLi5iYXNlLCBub3RlczogWydObyBjYW5kaWRhdGUgZGF0ZXMgaW4gdGhlIGhvcml6b24uJ10gfTtcbiAgICAgICAgYXdhaXQgYXBwZW5kTG9nKGVudHJ5KTtcbiAgICAgICAgYXdhaXQgcmVmbGVjdFJ1bihlbnRyeSk7XG4gICAgICAgIHJldHVybiBlbnRyeTtcbiAgICB9XG5cbiAgICBpZiAoIXNldHRpbmdzLmRlc2tOYW1lICYmICFzZXR0aW5ncy5kZXNrSWQpIHtcbiAgICAgICAgY29uc3QgZW50cnkgPSB7IC4uLmJhc2UsIGVycm9yOiAnUGljayB5b3VyIGRlc2sgaW4gdGhlIHBvcHVwIGZpcnN0ICh0aGUgbnVtYmVyIG9uIGl0LCBsaWtlIDMtMjMpLicgfTtcbiAgICAgICAgYXdhaXQgYXBwZW5kTG9nKGVudHJ5KTtcbiAgICAgICAgYXdhaXQgcmVmbGVjdFJ1bihlbnRyeSk7XG4gICAgICAgIHJldHVybiBlbnRyeTtcbiAgICB9XG5cbiAgICAvLyBUaGUgcG9wdXAgZ2F0ZXMgaXRzIG93biBidXR0b25zIG9uIHRoaXMsIGJ1dCBhbiBhdXRvbWF0aWMgcnVuIHJlYWRzXG4gICAgLy8gc3RyYWlnaHQgZnJvbSBzdG9yYWdlIFx1MjAxNCB3aGljaCBjb3VsZCBob2xkIGEgYmFkIHZhbHVlIHNhdmVkIGJ5IGFuIG9sZGVyXG4gICAgLy8gYnVpbGQsIG9yIGVkaXRlZCBieSBoYW5kLiBDaGVja2luZyBoZXJlIGlzIHdoYXQgbWFrZXMgdGhlIHJ1bGUgcmVhbC5cbiAgICBpZiAoc2V0dGluZ3MuZGVza05hbWUgJiYgIWlzVmFsaWREZXNrTmFtZShzZXR0aW5ncy5kZXNrTmFtZSkpIHtcbiAgICAgICAgY29uc3QgZW50cnkgPSB7XG4gICAgICAgICAgICAuLi5iYXNlLFxuICAgICAgICAgICAgZXJyb3I6IGBcIiR7c2V0dGluZ3MuZGVza05hbWV9XCIgaXMgbm90IGEgZGVzayBudW1iZXIuIEl0IHNob3VsZCBiZSBkaWdpdHMsIGEgZGFzaCwgYFxuICAgICAgICAgICAgICAgICsgJ2RpZ2l0cyBcdTIwMTQgbGlrZSAzLTIzLicsXG4gICAgICAgIH07XG4gICAgICAgIGF3YWl0IGFwcGVuZExvZyhlbnRyeSk7XG4gICAgICAgIGF3YWl0IHJlZmxlY3RSdW4oZW50cnkpO1xuICAgICAgICByZXR1cm4gZW50cnk7XG4gICAgfVxuXG4gICAgbGV0IHRlbXBvcmFyeSA9IGZhbHNlO1xuICAgIGxldCB0YWJJZDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdGFiID0gYXdhaXQgZ2V0Q29tZWVuVGFiKCk7XG4gICAgICAgIHRhYklkID0gdGFiLnRhYklkO1xuICAgICAgICB0ZW1wb3JhcnkgPSB0YWIudGVtcG9yYXJ5O1xuXG4gICAgICAgIGNvbnN0IFtyZXN1bHRdID0gYXdhaXQgY2hyb21lLnNjcmlwdGluZy5leGVjdXRlU2NyaXB0KHtcbiAgICAgICAgICAgIHRhcmdldDogeyB0YWJJZCB9LFxuICAgICAgICAgICAgd29ybGQ6ICdNQUlOJyxcbiAgICAgICAgICAgIGZ1bmM6IGJvb2tJblBhZ2UsXG4gICAgICAgICAgICBhcmdzOiBbe1xuICAgICAgICAgICAgICAgIGVuZHBvaW50OiBzZXR0aW5ncy5lbmRwb2ludCxcbiAgICAgICAgICAgICAgICBkYXRlcyxcbiAgICAgICAgICAgICAgICBkZXNrTmFtZTogc2V0dGluZ3MuZGVza05hbWUsXG4gICAgICAgICAgICAgICAgZGVza0lkOiBzZXR0aW5ncy5kZXNrSWQsXG4gICAgICAgICAgICAgICAgc2xvdDogc2V0dGluZ3Muc2xvdCxcbiAgICAgICAgICAgICAgICBjYW5jZWxEYXRlczogc2V0dGluZ3MuY2FuY2VsRGF0ZXMsXG4gICAgICAgICAgICAgICAgLy8gUmVzb2x2ZWQgb3V0IGhlcmUgc28gdGhlIHNsb3QtdG8tdGltZXMgdGFibGUgc3RheXMgdGVzdGFibGVcbiAgICAgICAgICAgICAgICAvLyBpbnN0ZWFkIG9mIGJlaW5nIGlubGluZWQgaW50byB0aGUgc2VyaWFsaXplZCBwYWdlIGZ1bmN0aW9uLlxuICAgICAgICAgICAgICAgIHN0YXJ0VGltZTogU0xPVF9USU1FU1tzZXR0aW5ncy5zbG90XS5zdGFydCxcbiAgICAgICAgICAgICAgICBlbmRUaW1lOiBTTE9UX1RJTUVTW3NldHRpbmdzLnNsb3RdLmVuZCxcbiAgICAgICAgICAgICAgICBmbG9vcklkOiBzZXR0aW5ncy5mbG9vcklkLFxuICAgICAgICAgICAgICAgIGJ1aWxkaW5nSWQ6IHNldHRpbmdzLmJ1aWxkaW5nSWQsXG4gICAgICAgICAgICAgICAgZHJ5UnVuLFxuICAgICAgICAgICAgfV0sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVzdWx0Py5yZXN1bHQgYXMgSW5QYWdlUmVzdWx0IHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIC8vIFNldHRpbmdzIGNoYW5nZXMgdGhlIHJ1biBpdHNlbGYgaW1wbGllcy4gQmF0Y2hlZCBpbnRvIG9uZSB3cml0ZSBzbyBhXG4gICAgICAgIC8vIHJlc29sdmVkIGRlc2sgaWQgYW5kIGEgY29tcGxldGVkIGNhbmNlbGxhdGlvbiBjYW5ub3QgY2xvYmJlciBlYWNoXG4gICAgICAgIC8vIG90aGVyLlxuICAgICAgICBjb25zdCB1cGRhdGVzOiBQYXJ0aWFsPFNldHRpbmdzPiA9IHt9O1xuICAgICAgICBpZiAodmFsdWU/LnJlc29sdmVkRGVza0lkICYmIHZhbHVlLnJlc29sdmVkRGVza0lkICE9PSBzZXR0aW5ncy5kZXNrSWQpIHtcbiAgICAgICAgICAgIHVwZGF0ZXMuZGVza0lkID0gdmFsdWUucmVzb2x2ZWREZXNrSWQ7XG4gICAgICAgIH1cbiAgICAgICAgLy8gQSBjYW5jZWxsYXRpb24gaXMgYSBvbmUtc2hvdCBpbnN0cnVjdGlvbi4gTGVhdmluZyBhIGZpbmlzaGVkIG9uZSBpblxuICAgICAgICAvLyBwbGFjZSBtZWFucyBldmVyeSBsYXRlciBhdXRvbWF0aWMgcnVuIHRyaWVzIHRvIGRlbGV0ZSBpdCBhZ2Fpbi5cbiAgICAgICAgaWYgKCFkcnlSdW4gJiYgdmFsdWU/LmNhbmNlbGxlZD8ubGVuZ3RoKSB7XG4gICAgICAgICAgICBjb25zdCBkb25lID0gbmV3IFNldCh2YWx1ZS5jYW5jZWxsZWQpO1xuICAgICAgICAgICAgdXBkYXRlcy5jYW5jZWxEYXRlcyA9IHNldHRpbmdzLmNhbmNlbERhdGVzLmZpbHRlcigoZGF0ZSkgPT4gIWRvbmUuaGFzKGRhdGUpKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoT2JqZWN0LmtleXModXBkYXRlcykubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKHsgLi4uc2V0dGluZ3MsIC4uLnVwZGF0ZXMgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBlbnRyeTogUnVuTG9nID0ge1xuICAgICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICAgIHJvd3M6IHZhbHVlPy5yb3dzID8/IFtdLFxuICAgICAgICAgICAgbm90ZXM6IHZhbHVlPy5ub3RlcyA/PyBbJ1RoZSBpbi1wYWdlIHNjcmlwdCByZXR1cm5lZCBub3RoaW5nLiddLFxuICAgICAgICAgICAgc2lnbmVkT3V0OiB2YWx1ZT8uc2lnbmVkT3V0ID09PSB0cnVlLFxuICAgICAgICB9O1xuICAgICAgICBhd2FpdCBhcHBlbmRMb2coZW50cnkpO1xuICAgICAgICBhd2FpdCByZWZsZWN0UnVuKGVudHJ5KTtcbiAgICAgICAgcmV0dXJuIGVudHJ5O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBlbnRyeTogUnVuTG9nID0ge1xuICAgICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgICAgICBzaWduZWRPdXQ6IGVyciBpbnN0YW5jZW9mIFNpZ25lZE91dEVycm9yLFxuICAgICAgICB9O1xuICAgICAgICBhd2FpdCBhcHBlbmRMb2coZW50cnkpO1xuICAgICAgICBhd2FpdCByZWZsZWN0UnVuKGVudHJ5KTtcbiAgICAgICAgcmV0dXJuIGVudHJ5O1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIC8vIE9ubHkgY2xvc2Ugd2hhdCB3ZSBvcGVuZWQuIE5ldmVyIGNsb3NlIGEgdGFiIHRoZSB1c2VyIHdhcyB1c2luZy5cbiAgICAgICAgaWYgKHRlbXBvcmFyeSAmJiB0YWJJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICB0cnkgeyBhd2FpdCBjaHJvbWUudGFicy5yZW1vdmUodGFiSWQpOyB9IGNhdGNoIHsgLyogYWxyZWFkeSBnb25lICovIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiBTaG93IHRoZSBvdXRjb21lIG9mIGEgcnVuIHNvbWV3aGVyZSB0aGUgdXNlciB3aWxsIGFjdHVhbGx5IHNlZSBpdC5cbiAqXG4gKiBFdmVyeXRoaW5nIGJlZm9yZSB0aGlzIHdhcyB3cml0dGVuIGludG8gY2hyb21lLnN0b3JhZ2UgYW5kIHJlbmRlcmVkIG9ubHkgaWZcbiAqIHlvdSBvcGVuZWQgdGhlIHBvcHVwIFx1MjAxNCBzbyBhbiBhdXRvbWF0aWMgcnVuIHRoYXQgZmFpbGVkIGF0IDNhbSB3YXMsIGluXG4gKiBwcmFjdGljZSwgc2lsZW50LiBBbiBhdXRvbWF0aW9uIHlvdSBjYW5ub3QgdGVsbCBoYXMgc3RvcHBlZCBpcyB3b3JzZSB0aGFuIG5vXG4gKiBhdXRvbWF0aW9uLCBiZWNhdXNlIHlvdSBzdG9wIGNoZWNraW5nLlxuICpcbiAqIFRoZSBiYWRnZSBtZWFucyBcInRoZXJlIGlzIGEgZmFpbHVyZSB5b3UgaGF2ZSBub3QgcmVhZCB5ZXRcIiwgbm90IFwidGhlIGxhc3QgcnVuXG4gKiBmYWlsZWRcIi4gVGhlIGRpZmZlcmVuY2UgbWF0dGVyczogcmVhZCBhcyB0aGUgbGF0dGVyLCBhIGJhZGdlIHJhaXNlZCBieSBhXG4gKiBzaWduZWQtb3V0IHJ1biBzdGF5ZWQgbGl0IGFmdGVyIHlvdSBzaWduZWQgaW4gYW5kIHByZXZpZXdlZCBzdWNjZXNzZnVsbHksXG4gKiB3aXRoIG5vIHdheSB0byBkaXNtaXNzIGl0LCBiZWNhdXNlIG9ubHkgYSBzdWNjZXNzZnVsIHJlYWwgcnVuIGNsZWFyZWQgaXQuXG4gKiBBdXRvbWF0aWMgc3dpdGNoZWQgb2ZmLCBhbmQgaXQgc3RheWVkIGxpdCBmb3IgZ29vZC4gT3BlbmluZyB0aGUgcG9wdXAgaXMgd2hhdFxuICogbWFya3MgaXQgcmVhZCBcdTIwMTQgc2VlIGNsZWFyRmFpbHVyZUJhZGdlLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWZsZWN0UnVuKGVudHJ5OiBSdW5Mb2cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBmYWlsZWQgPSBCb29sZWFuKGVudHJ5LmVycm9yKSB8fCBlbnRyeS5yb3dzLnNvbWUoKHJvdykgPT4gcm93LnN0YXR1cyA9PT0gJ2Vycm9yJyk7XG5cbiAgICAvLyBBIHByZXZpZXcgY2Fubm90IGV4ZXJjaXNlIHRoZSBjcmVhdGUgY2FsbCwgc28gYSBjbGVhbiBvbmUgaXMgbm90IHByb29mXG4gICAgLy8gdGhhdCBib29raW5nIHdvcmtzIGFuZCBtdXN0IG5vdCBjbGVhciBhIHJlYWwgZmFpbHVyZS4gSXQgY2FuIHN0aWxsIHJhaXNlXG4gICAgLy8gdGhlIGJhZGdlOiB3aGF0ZXZlciBpdCBoaXQgXHUyMDE0IHNpZ25lZCBvdXQsIGJhZCBkZXNrLCBBUEkgZG93biBcdTIwMTQgaXMgcmVhbC5cbiAgICBpZiAoZW50cnkuZHJ5UnVuICYmICFmYWlsZWQpIHJldHVybjtcblxuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VUZXh0KHsgdGV4dDogZmFpbGVkID8gJyEnIDogJycgfSk7XG4gICAgaWYgKGZhaWxlZCkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEJhZGdlQmFja2dyb3VuZENvbG9yKHsgY29sb3I6ICcjYjkxYzFjJyB9KTtcbiAgICB9XG5cbiAgICBpZiAoZW50cnkuc2lnbmVkT3V0KSB7XG4gICAgICAgIC8vIEZpeGVkIGlkLCBzbyBhIHNlc3Npb24gdGhhdCBzdGF5cyBleHBpcmVkIGFjcm9zcyBzZXZlcmFsIHJ1bnNcbiAgICAgICAgLy8gcmVwbGFjZXMgaXRzIG93biBub3RpZmljYXRpb24gaW5zdGVhZCBvZiBzdGFja2luZyB1cC5cbiAgICAgICAgY2hyb21lLm5vdGlmaWNhdGlvbnMuY3JlYXRlKFNJR05FRF9PVVRfTk9USUZJQ0FUSU9OLCB7XG4gICAgICAgICAgICB0eXBlOiAnYmFzaWMnLFxuICAgICAgICAgICAgaWNvblVybDogY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdpY29uLTEyOC5wbmcnKSxcbiAgICAgICAgICAgIHRpdGxlOiAnQ29tZWVuIGRlc2sgYm9va2VyJyxcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdZb3VyIENvbWVlbiBzZXNzaW9uIGV4cGlyZWQuIENsaWNrIGhlcmUgdG8gc2lnbiBpbiBcdTIwMTQgYm9va2luZyByZXN1bWVzIG9uICdcbiAgICAgICAgICAgICAgICArICdpdHMgb3duIG9uY2UgeW91IGFyZSBiYWNrLicsXG4gICAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAoIWVudHJ5LmRyeVJ1bikge1xuICAgICAgICBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihTSUdORURfT1VUX05PVElGSUNBVElPTik7XG4gICAgfVxufVxuXG4vKipcbiAqIE1hcmsgdGhlIGZhaWx1cmUgYXMgcmVhZC4gQ2FsbGVkIHdoZW4gdGhlIHBvcHVwIG9wZW5zLCBiZWNhdXNlIHRoYXQgaXMgd2hlcmVcbiAqIHRoZSBkZXRhaWwgbGl2ZXM6IGlmIHlvdSBoYXZlIGxvb2tlZCBhdCBMYXN0IHJ1biwgeW91IGtub3cuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNsZWFyRmFpbHVyZUJhZGdlKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0QmFkZ2VUZXh0KHsgdGV4dDogJycgfSk7XG59XG5cbi8qKlxuICogU2lnbmluZyBiYWNrIGluIGlzIHRoZSBmaXgsIHNvIG5vdGljaW5nIHRoYXQgeW91IGhhdmUgaXMgdGhlIHdob2xlIGZlYXR1cmU6XG4gKiB0aGUgbmV4dCB0aW1lIGEgQ29tZWVuIHBhZ2UgZmluaXNoZXMgbG9hZGluZyBhZnRlciBhIHNpZ25lZC1vdXQgZmFpbHVyZSwgdGhlXG4gKiBtaXNzZWQgcnVuIGhhcHBlbnMgYnkgaXRzZWxmLiBObyBidXR0b24gdG8gZmluZCwgbm8gbm90aWZpY2F0aW9uIHRvIGFjdCBvbi5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmV0cnlBZnRlclNpZ25JbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IHJ1bnMgPSBbXSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdydW5zJykgYXMgeyBydW5zPzogUnVuTG9nW10gfTtcbiAgICBpZiAocnVuc1swXT8uc2lnbmVkT3V0ICE9PSB0cnVlKSByZXR1cm47XG5cbiAgICAvLyBPbmx5IHRoZSBhdXRvbWF0aWMgcGF0aCBzZWxmLWhlYWxzLiBJZiBhdXRvbWF0aWMgaXMgb2ZmLCBldmVyeSBydW4gaXNcbiAgICAvLyBzb21ldGhpbmcgdGhlIHVzZXIgYXNrZWQgZm9yLCBhbmQgYSBzdXJwcmlzZSBib29raW5nIHdvdWxkIG5vdCBiZS5cbiAgICBjb25zdCBzZXR0aW5ncyA9IGF3YWl0IGxvYWRTZXR0aW5ncygpO1xuICAgIGlmICghc2V0dGluZ3MuZW5hYmxlZCkgcmV0dXJuO1xuXG4gICAgY29uc29sZS5pbmZvKCdbY29tZWVuXSBzaWduZWQgYmFjayBpbiBcdTIwMTQgcmV0cnlpbmcgdGhlIHJ1biB0aGF0IGZhaWxlZCcpO1xuICAgIGF3YWl0IHJ1bkJvb2tpbmcoZmFsc2UpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVBbGFybSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGNocm9tZS5hbGFybXMuZ2V0KEFMQVJNKTtcbiAgICBpZiAoZXhpc3RpbmcpIHJldHVybjtcbiAgICAvLyBFdmVyeSA2IGhvdXJzLiBUaGUgMTQtZGF5IGJvb2tpbmcgaG9yaXpvbiBtZWFucyBwcmVjaXNpb24gZG9lcyBub3QgbWF0dGVyOlxuICAgIC8vIGFueSBydW4gdG9wcyB0aGUgd2hvbGUgd2luZG93IGJhY2sgdXAsIHNvIGEgbWlzc2VkIGZpcmluZyBjb3N0cyBub3RoaW5nLlxuICAgIGF3YWl0IGNocm9tZS5hbGFybXMuY3JlYXRlKEFMQVJNLCB7IHBlcmlvZEluTWludXRlczogMzYwLCBkZWxheUluTWludXRlczogMSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuSWZFbmFibGVkKHJlYXNvbjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3Qgc2V0dGluZ3MgPSBhd2FpdCBsb2FkU2V0dGluZ3MoKTtcbiAgICBpZiAoIXNldHRpbmdzLmVuYWJsZWQpIHJldHVybjtcbiAgICBjb25zb2xlLmluZm8oYFtjb21lZW5dIHJ1bm5pbmcgKCR7cmVhc29ufSlgKTtcbiAgICBhd2FpdCBydW5Cb29raW5nKGZhbHNlKTtcbn1cblxuY2hyb21lLnJ1bnRpbWUub25JbnN0YWxsZWQuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICAgIHZvaWQgZW5zdXJlQWxhcm0oKTtcbn0pO1xuXG4vLyBDaHJvbWUgd2FzIGp1c3Qgc3RhcnRlZDogY2F0Y2ggdXAgaW1tZWRpYXRlbHkgcmF0aGVyIHRoYW4gd2FpdGluZyBmb3IgdGhlIGFsYXJtLlxuY2hyb21lLnJ1bnRpbWUub25TdGFydHVwLmFkZExpc3RlbmVyKCgpID0+IHtcbiAgICB2b2lkIGVuc3VyZUFsYXJtKCk7XG4gICAgdm9pZCBydW5JZkVuYWJsZWQoJ2Jyb3dzZXIgc3RhcnR1cCcpO1xufSk7XG5cbmNocm9tZS5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcigoYWxhcm0pID0+IHtcbiAgICBpZiAoYWxhcm0ubmFtZSAhPT0gQUxBUk0pIHJldHVybjtcbiAgICB2b2lkIHJ1bklmRW5hYmxlZCgnYWxhcm0nKTtcbn0pO1xuXG5jaHJvbWUudGFicy5vblVwZGF0ZWQuYWRkTGlzdGVuZXIoKF90YWJJZCwgaW5mbywgdGFiKSA9PiB7XG4gICAgaWYgKGluZm8uc3RhdHVzICE9PSAnY29tcGxldGUnKSByZXR1cm47XG4gICAgaWYgKCF0YWIudXJsPy5zdGFydHNXaXRoKENPTUVFTl9VUkwpKSByZXR1cm47XG4gICAgdm9pZCByZXRyeUFmdGVyU2lnbkluKCk7XG59KTtcblxuY2hyb21lLm5vdGlmaWNhdGlvbnMub25DbGlja2VkLmFkZExpc3RlbmVyKChpZCkgPT4ge1xuICAgIGlmIChpZCAhPT0gU0lHTkVEX09VVF9OT1RJRklDQVRJT04pIHJldHVybjtcbiAgICB2b2lkIGNocm9tZS50YWJzLmNyZWF0ZSh7IHVybDogQ09NRUVOX1VSTCB9KTtcbiAgICBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihTSUdORURfT1VUX05PVElGSUNBVElPTik7XG59KTtcblxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlOiB7IHR5cGU/OiBzdHJpbmc7IGRyeVJ1bj86IGJvb2xlYW4gfSwgX3NlbmRlciwgcmVzcG9uZCkgPT4ge1xuICAgIGlmIChtZXNzYWdlPy50eXBlID09PSAncG9wdXAtb3BlbmVkJykge1xuICAgICAgICB2b2lkIGNsZWFyRmFpbHVyZUJhZGdlKCk7XG4gICAgICAgIHJlc3BvbmQoeyBvazogdHJ1ZSB9KTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ3J1bicpIHtcbiAgICAgICAgcnVuQm9va2luZyhtZXNzYWdlLmRyeVJ1biA/PyBmYWxzZSlcbiAgICAgICAgICAgIC50aGVuKChsb2cpID0+IHJlc3BvbmQoeyBvazogdHJ1ZSwgbG9nIH0pKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IHJlc3BvbmQoe1xuICAgICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICAgICAgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTsgLy8ga2VlcCB0aGUgY2hhbm5lbCBvcGVuIGZvciB0aGUgYXN5bmMgcmVzcG9uc2VcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBSUEsSUFBTSxnQkFBb0M7QUFBQSxFQUN0QztBQUFBLEVBQVU7QUFBQSxFQUFVO0FBQUEsRUFBVztBQUFBLEVBQWE7QUFBQSxFQUFZO0FBQUEsRUFBVTtBQUN0RTtBQUVBLFNBQVMsVUFBVSxPQUFpQztBQUNoRCxTQUFRLGNBQW9DLFNBQVMsS0FBSztBQUM5RDtBQUdPLFNBQVMsZUFBZSxNQUFZLFVBQTBCO0FBQ2pFLFNBQU8sSUFBSSxLQUFLLGVBQWUsU0FBUztBQUFBLElBQ3BDO0FBQUEsSUFBVSxNQUFNO0FBQUEsSUFBVyxPQUFP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QUFJLFNBQVU7QUFHZCxRQUFNLE9BQU8sT0FBTyxPQUFPLE9BQU8sRUFBRSxpQkFBaUIsS0FBSyxnQkFBZ0IsRUFBRSxDQUFDO0FBQ2pGO0FBRUEsZUFBZSxhQUFhLFFBQStCO0FBQ3ZELFFBQU0sV0FBVyxNQUFNLGFBQWE7QUFDcEMsTUFBSSxDQUFDLFNBQVMsUUFBUztBQUN2QixVQUFRLEtBQUsscUJBQXFCLE1BQU0sR0FBRztBQUMzQyxRQUFNLFdBQVcsS0FBSztBQUMxQjtBQUVBLE9BQU8sUUFBUSxZQUFZLFlBQVksTUFBTTtBQUN6QyxPQUFLLFlBQVk7QUFDckIsQ0FBQztBQUdELE9BQU8sUUFBUSxVQUFVLFlBQVksTUFBTTtBQUN2QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxhQUFhLGlCQUFpQjtBQUN2QyxDQUFDO0FBRUQsT0FBTyxPQUFPLFFBQVEsWUFBWSxDQUFDLFVBQVU7QUFDekMsTUFBSSxNQUFNLFNBQVMsTUFBTztBQUMxQixPQUFLLGFBQWEsT0FBTztBQUM3QixDQUFDO0FBRUQsT0FBTyxLQUFLLFVBQVUsWUFBWSxDQUFDLFFBQVEsTUFBTSxRQUFRO0FBQ3JELE1BQUksS0FBSyxXQUFXLFdBQVk7QUFDaEMsTUFBSSxDQUFDLElBQUksS0FBSyxXQUFXLFVBQVUsRUFBRztBQUN0QyxPQUFLLGlCQUFpQjtBQUMxQixDQUFDO0FBRUQsT0FBTyxjQUFjLFVBQVUsWUFBWSxDQUFDLE9BQU87QUFDL0MsTUFBSSxPQUFPLHdCQUF5QjtBQUNwQyxPQUFLLE9BQU8sS0FBSyxPQUFPLEVBQUUsS0FBSyxXQUFXLENBQUM7QUFDM0MsU0FBTyxjQUFjLE1BQU0sdUJBQXVCO0FBQ3RELENBQUM7QUFFRCxPQUFPLFFBQVEsVUFBVSxZQUFZLENBQUMsU0FBOEMsU0FBUyxZQUFZO0FBQ3JHLE1BQUksU0FBUyxTQUFTLGdCQUFnQjtBQUNsQyxTQUFLLGtCQUFrQjtBQUN2QixZQUFRLEVBQUUsSUFBSSxLQUFLLENBQUM7QUFDcEIsV0FBTztBQUFBLEVBQ1g7QUFDQSxNQUFJLFNBQVMsU0FBUyxPQUFPO0FBQ3pCLGVBQVcsUUFBUSxVQUFVLEtBQUssRUFDN0IsS0FBSyxDQUFDLFFBQVEsUUFBUSxFQUFFLElBQUksTUFBTSxJQUFJLENBQUMsQ0FBQyxFQUN4QyxNQUFNLENBQUMsUUFBaUIsUUFBUTtBQUFBLE1BQzdCLElBQUk7QUFBQSxNQUNKLE9BQU8sZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFBQSxJQUMxRCxDQUFDLENBQUM7QUFDTixXQUFPO0FBQUEsRUFDWDtBQUNBLFNBQU87QUFDWCxDQUFDOyIsCiAgIm5hbWVzIjogWyJzaWduZWRPdXQiXQp9Cg==
