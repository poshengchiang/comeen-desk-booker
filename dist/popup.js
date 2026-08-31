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
var BUILDING = { id: 5151, name: "100yards" };
var DESK_NAME_PATTERN = /^\d+-\d+$/;
function isValidDeskName(name) {
  return DESK_NAME_PATTERN.test(name.trim());
}
function prunePastSkipDates(skipDates, today) {
  return skipDates.filter((date) => date >= today);
}
var FLOORS = [
  { id: 4952, label: "Floor 3" },
  { id: 4953, label: "Floor 4" }
];
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

// src/popup.ts
var DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
var DOW_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}
var fields = {
  enabled: el("enabled"),
  deskName: el("deskName"),
  deskId: el("deskId"),
  floorId: el("floorId"),
  slot: el("slot"),
  horizonDays: el("horizonDays"),
  timeZone: el("timeZone"),
  endpoint: el("endpoint"),
  learnMode: el("learnMode")
};
el("buildingName").textContent = BUILDING.name;
for (const floor of FLOORS) {
  const option = document.createElement("option");
  option.value = String(floor.id);
  option.textContent = floor.label;
  fields.floorId.append(option);
}
var daysHost = el("days");
for (const day of DAYS) {
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.value = day;
  box.dataset.day = day;
  label.append(box, document.createTextNode(day.slice(0, 3)));
  daysHost.append(label);
}
function selectedDays() {
  return [...daysHost.querySelectorAll("input:checked")].map((box) => box.value);
}
var current = await loadSettings();
var lastLog;
function renderSettings(next) {
  fields.enabled.checked = next.enabled;
  fields.deskName.value = next.deskName;
  fields.deskId.value = next.deskId;
  fields.floorId.value = String(next.floorId);
  fields.slot.value = next.slot;
  fields.horizonDays.value = String(next.horizonDays);
  fields.timeZone.value = next.timeZone;
  fields.endpoint.value = JSON.stringify(next.endpoint, null, 2);
  el("timeZoneLabel").textContent = next.timeZone;
  for (const box of daysHost.querySelectorAll("input")) {
    box.checked = next.weekdays.includes(box.value);
  }
}
function collect() {
  let endpoint = current.endpoint;
  let endpointError;
  try {
    endpoint = JSON.parse(fields.endpoint.value);
  } catch (err) {
    endpointError = `Endpoint config is not valid JSON: ${err.message}`;
  }
  return {
    settings: {
      // Saving stamps the version the user has actually seen, so a later
      // build with a corrected contract still supersedes this.
      endpointVersion: current.endpointVersion,
      enabled: fields.enabled.checked,
      deskName: fields.deskName.value.trim(),
      deskId: fields.deskId.value.trim(),
      floorId: Number(fields.floorId.value) || DEFAULT_SETTINGS.floorId,
      // Fixed: there is one building, and it is shown as text, not edited.
      buildingId: BUILDING.id,
      weekdays: selectedDays(),
      slot: fields.slot.value,
      horizonDays: Number(fields.horizonDays.value) || DEFAULT_SETTINGS.horizonDays,
      // Owned by the calendar, not by any form field. Pruned on every
      // save so months of past entries do not pile up.
      cancelDates: prunePastSkipDates(
        current.cancelDates,
        toLocalISODate(/* @__PURE__ */ new Date(), fields.timeZone.value.trim() || DEFAULT_SETTINGS.timeZone)
      ),
      skipDates: prunePastSkipDates(
        current.skipDates,
        toLocalISODate(/* @__PURE__ */ new Date(), fields.timeZone.value.trim() || DEFAULT_SETTINGS.timeZone)
      ),
      timeZone: fields.timeZone.value.trim() || DEFAULT_SETTINGS.timeZone,
      endpoint
    },
    endpointError
  };
}
var pad = (value) => String(value).padStart(2, "0");
var isoFor = (year, month, day) => `${year}-${pad(month + 1)}-${pad(day)}`;
function renderPlan() {
  const host = el("calendar");
  host.textContent = "";
  const today = toLocalISODate(/* @__PURE__ */ new Date(), current.timeZone);
  const [todayYear, todayMonth] = today.split("-").map(Number);
  let candidates;
  try {
    candidates = new Set(datesToBook({
      weekdays: current.weekdays,
      horizonDays: current.horizonDays,
      skipDates: [],
      timeZone: current.timeZone
    }));
  } catch {
    candidates = /* @__PURE__ */ new Set();
  }
  const chosenWeekdays = new Set(current.weekdays);
  const isWorkday = (iso) => {
    try {
      return chosenWeekdays.has(localWeekday(/* @__PURE__ */ new Date(`${iso}T12:00:00Z`), current.timeZone));
    } catch {
      return false;
    }
  };
  const skipped = new Set(current.skipDates);
  const markedForCancel = new Set(current.cancelDates);
  const slotStart = SLOT_TIMES[current.slot].start;
  const outcome = /* @__PURE__ */ new Map();
  for (const row of lastLog?.rows ?? []) {
    if (row.status === "booked" || row.status === "skipped") outcome.set(row.date, "have");
    else if (row.status === "unavailable") outcome.set(row.date, "taken");
    else if (row.status === "error") outcome.set(row.date, "failed");
  }
  const asOf = el("planAsOf");
  asOf.textContent = lastLog ? `colours from ${new Date(lastLog.at).toLocaleString()} \xB7 click a day to skip it` : "click a day to skip it";
  for (let offset = 0; offset < 2; offset += 1) {
    const month = todayMonth - 1 + offset;
    const year = todayYear + Math.floor(month / 12);
    const normalised = (month % 12 + 12) % 12;
    const block = document.createElement("div");
    block.className = "month";
    const name = document.createElement("div");
    name.className = "month-name";
    name.textContent = new Date(Date.UTC(year, normalised, 1)).toLocaleDateString(void 0, { month: "long", year: "numeric", timeZone: "UTC" });
    block.append(name);
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const label of DOW_LABELS) {
      const head = document.createElement("div");
      head.className = "dow";
      head.textContent = label;
      grid.append(head);
    }
    const firstDayOfWeek = new Date(Date.UTC(year, normalised, 1)).getUTCDay();
    const lead = (firstDayOfWeek + 6) % 7;
    for (let blank = 0; blank < lead; blank += 1) grid.append(document.createElement("div"));
    const daysInMonth = new Date(Date.UTC(year, normalised + 1, 0)).getUTCDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = isoFor(year, normalised, day);
      const cell = document.createElement("button");
      cell.className = "day";
      cell.textContent = String(day);
      cell.type = "button";
      if (iso < today) cell.classList.add("past");
      if (iso === today) cell.classList.add("today");
      const planned = candidates.has(iso);
      const markable = planned || iso >= today && isWorkday(iso);
      if (markable) {
        const tooLate = planned && hasSlotStarted(iso, slotStart, current.timeZone);
        const state = markedForCancel.has(iso) ? "cancel" : skipped.has(iso) ? "skip" : outcome.get(iso) ?? (tooLate ? "late" : planned ? "book" : "later");
        cell.classList.add(state);
        if (state !== "late") cell.classList.add("clickable");
        cell.title = {
          skip: "Skipped \u2014 click to book it",
          have: "You already have this day. Clicking stops future runs re-booking it; it does not cancel the booking in Comeen.",
          taken: "Someone else has this desk that day. Clicking stops it being retried.",
          failed: "The last attempt failed on this day. Open Last run for the reason.",
          book: "Click to skip",
          later: "Beyond the booking window for now. Click to skip it in advance \u2014 it will be remembered when the window reaches it.",
          cancel: "Will be cancelled in Comeen on the next run. Click to keep it.",
          late: `Too late \u2014 the ${current.slot.replace("_", " ")} slot has already started, and Comeen refuses a booking whose start time has passed. Book it by hand if you still need it.`
        }[state] ?? "Click to skip";
        if (state === "late") {
          grid.append(cell);
          continue;
        }
        cell.addEventListener("click", () => {
          if (state === "cancel") {
            current.cancelDates = current.cancelDates.filter((entry) => entry !== iso);
            current.skipDates = current.skipDates.filter((entry) => entry !== iso);
          } else if (state === "have") {
            current.cancelDates = [...current.cancelDates, iso].sort();
            current.skipDates = [.../* @__PURE__ */ new Set([...current.skipDates, iso])].sort();
          } else {
            current.skipDates = skipped.has(iso) ? current.skipDates.filter((entry) => entry !== iso) : [...current.skipDates, iso].sort();
          }
          renderPlan();
          queueSave();
        });
      }
      grid.append(cell);
    }
    block.append(grid);
    host.append(block);
  }
}
function renderDeskState() {
  const raw = fields.deskName.value.trim();
  const note = el("deskNote");
  const valid = isValidDeskName(raw);
  if (raw === "") {
    note.textContent = "Pick your desk first \u2014 the number printed on it, like 3-23.";
    note.classList.remove("bad");
    fields.deskName.classList.remove("bad");
  } else if (valid) {
    note.textContent = "Looked up by name on every run, so the ID stays empty.";
    note.classList.remove("bad");
    fields.deskName.classList.remove("bad");
  } else {
    note.textContent = `"${raw}" is not a desk number. It should be digits, a dash, digits \u2014 like 3-23.`;
    note.classList.add("bad");
    fields.deskName.classList.add("bad");
  }
  const runnable = valid || fields.deskId.value.trim() !== "";
  for (const id of ["runNow", "dryRun"]) {
    el(id).disabled = !runnable;
  }
}
function renderAutoNote() {
  const note = el("autoNote");
  note.textContent = current.enabled ? `On. Checks every 6 hours and books any missing day in the next ${current.horizonDays} days. Only runs while Chrome is open \u2014 a closed laptop just means it catches up later.` : "Off. Nothing is booked unless you press Book now.";
}
function flashSaved(text = "Saved") {
  const flag = el("savedFlag");
  flag.textContent = text;
  flag.hidden = false;
  window.setTimeout(() => {
    flag.hidden = true;
  }, 1200);
}
var saveTimer;
function queueSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void commit();
  }, 300);
}
var savingLocally = false;
async function commit() {
  const { settings, endpointError } = collect();
  current = settings;
  savingLocally = true;
  try {
    await saveSettings(settings);
  } finally {
    window.setTimeout(() => {
      savingLocally = false;
    }, 0);
  }
  renderPlan();
  renderAutoNote();
  renderDeskState();
  flashSaved(endpointError ? "Endpoint JSON invalid \u2014 not saved" : "Saved");
}
for (const field of [
  fields.enabled,
  fields.deskName,
  fields.deskId,
  fields.floorId,
  fields.slot,
  fields.horizonDays,
  fields.timeZone,
  fields.endpoint
]) {
  field.addEventListener("change", queueSave);
  field.addEventListener("input", queueSave);
}
for (const field of [fields.deskName, fields.deskId]) {
  field.addEventListener("input", renderDeskState);
}
daysHost.addEventListener("change", queueSave);
function renderLog(log) {
  const host = el("log");
  host.textContent = "";
  if (!log) {
    host.textContent = "No runs yet.";
    return;
  }
  const when = new Date(log.at).toLocaleString();
  const head = document.createElement("div");
  head.textContent = `${when}${log.dryRun ? "  (preview \u2014 nothing was booked)" : ""}`;
  host.append(head);
  if (log.error) {
    const problem = document.createElement("div");
    problem.className = "st-error";
    problem.textContent = `error: ${log.error}`;
    host.append(problem);
  }
  for (const note of log.notes) {
    const line = document.createElement("div");
    line.className = "st-skipped";
    line.textContent = `\xB7 ${note}`;
    host.append(line);
  }
  for (const row of log.rows) {
    const line = document.createElement("div");
    line.className = `st-${row.status}`;
    line.textContent = `${row.date}  ${row.status}${row.detail ? `  ${row.detail}` : ""}`;
    host.append(line);
  }
}
async function renderCaptures() {
  const { captures = [] } = await chrome.storage.local.get("captures");
  const host = el("captures");
  if (captures.length === 0) {
    host.textContent = "Nothing recorded yet.";
    return;
  }
  host.textContent = captures.map((capture) => JSON.stringify(capture, null, 1)).join("\n\n");
}
renderSettings(current);
renderPlan();
renderAutoNote();
renderDeskState();
var { runs = [], learnMode = false } = await chrome.storage.local.get(["runs", "learnMode"]);
fields.learnMode.checked = learnMode;
lastLog = runs[0];
renderLog(runs[0]);
renderPlan();
void chrome.runtime.sendMessage({ type: "popup-opened" }).catch(() => {
});
await renderCaptures();
async function triggerRun(button, dryRun) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = dryRun ? "Checking\u2026" : "Booking\u2026";
  try {
    await commit();
    const response = await chrome.runtime.sendMessage({ type: "run", dryRun });
    if (response.ok && response.log) {
      lastLog = response.log;
      renderLog(response.log);
      renderPlan();
    } else {
      renderLog({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        dryRun,
        dates: [],
        rows: [],
        notes: [],
        error: response.error ?? "Unknown failure"
      });
    }
  } catch (err) {
    renderLog({
      at: (/* @__PURE__ */ new Date()).toISOString(),
      dryRun,
      dates: [],
      rows: [],
      notes: [],
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    button.textContent = original;
    renderDeskState();
  }
}
el("runNow").addEventListener("click", (event) => {
  void triggerRun(event.currentTarget, false);
});
el("dryRun").addEventListener("click", (event) => {
  void triggerRun(event.currentTarget, true);
});
fields.learnMode.addEventListener("change", () => {
  void chrome.storage.local.set({ learnMode: fields.learnMode.checked });
});
el("copyCaptures").addEventListener("click", async (event) => {
  const { captures = [] } = await chrome.storage.local.get("captures");
  await navigator.clipboard.writeText(JSON.stringify(captures, null, 2));
  const button = event.currentTarget;
  const original = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = original;
  }, 1400);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.runs) {
    const runs2 = changes.runs.newValue;
    lastLog = runs2?.[0];
    renderLog(lastLog);
    renderPlan();
  }
  if (changes.settings && !savingLocally) {
    current = mergeSettings(changes.settings.newValue);
    renderSettings(current);
    renderPlan();
    renderAutoNote();
    renderDeskState();
  }
});
el("clearCaptures").addEventListener("click", async () => {
  await chrome.storage.local.set({ captures: [] });
  await renderCaptures();
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvcmUvY29uZmlnLnRzIiwgIi4uL3NyYy9jb3JlL2RhdGVzLnRzIiwgIi4uL3NyYy9wb3B1cC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBXZWVrZGF5IH0gZnJvbSAnLi9kYXRlcy5qcyc7XG5cbmV4cG9ydCB0eXBlIFNsb3QgPSAnYWxsX2RheScgfCAnbW9ybmluZycgfCAnYWZ0ZXJub29uJztcblxuLyoqXG4gKiBIb3cgdGhlIGluLXBhZ2UgY29kZSBzaG91bGQgYXV0aGVudGljYXRlLlxuICpcbiAqIGBjb29raWVgICAgICAgIC0ganVzdCBzZW5kIGNyZWRlbnRpYWxzIHdpdGggdGhlIHJlcXVlc3QuIENvcnJlY3QgaWYgQ29tZWVuXG4gKiAgICAgICAgICAgICAgICAgIGF1dGhlbnRpY2F0ZXMgd2l0aCBhIHNlc3Npb24gY29va2llLlxuICogYGxvY2FsU3RvcmFnZWAgLSByZWFkIGEgdG9rZW4gb3V0IG9mIHRoZSBwYWdlJ3Mgb3duIGxvY2FsU3RvcmFnZSBhbmQgcHV0IGl0XG4gKiAgICAgICAgICAgICAgICAgIGluIGEgaGVhZGVyLiBDb3JyZWN0IGlmIENvbWVlbiB1c2VzIGEgYmVhcmVyIHRva2VuLlxuICpcbiAqIEVpdGhlciB3YXkgdGhlIHZhbHVlIGlzIHJlYWQgaW5zaWRlIHRoZSBwYWdlIGFuZCB1c2VkIHRoZXJlLiBJdCBpcyBuZXZlclxuICogY29waWVkIGludG8gZXh0ZW5zaW9uIHN0b3JhZ2UsIG5ldmVyIHBlcnNpc3RlZCwgYW5kIG5ldmVyIGxlYXZlcyB0aGUgdGFiLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhDb25maWcge1xuICAgIG1vZGU6ICdjb29raWUnIHwgJ2xvY2FsU3RvcmFnZSc7XG4gICAgLyoqIGxvY2FsU3RvcmFnZSBrZXkgaG9sZGluZyB0aGUgdG9rZW4uICovXG4gICAgc3RvcmFnZUtleT86IHN0cmluZztcbiAgICAvKiogRG90dGVkIHBhdGggaW5zaWRlIHRoZSBwYXJzZWQgSlNPTiwgZS5nLiBgc3RzVG9rZW5NYW5hZ2VyLmFjY2Vzc1Rva2VuYCAqL1xuICAgIGpzb25QYXRoPzogc3RyaW5nO1xuICAgIC8qKiBIZWFkZXIgdG8gc2V0LCBkZWZhdWx0IGBhdXRob3JpemF0aW9uYCAqL1xuICAgIGhlYWRlcj86IHN0cmluZztcbiAgICAvKiogUHJlZml4IGJlZm9yZSB0aGUgdG9rZW4sIGRlZmF1bHQgYEJlYXJlciBgICovXG4gICAgcHJlZml4Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlcXVlc3RUZW1wbGF0ZSB7XG4gICAgbWV0aG9kOiAnR0VUJyB8ICdQT1NUJyB8ICdQVVQnIHwgJ0RFTEVURSc7XG4gICAgLyoqIFBhdGggYXBwZW5kZWQgdG8gYXBpQmFzZS4gTWF5IGNvbnRhaW4gcGxhY2Vob2xkZXJzLiAqL1xuICAgIHBhdGg6IHN0cmluZztcbiAgICBxdWVyeT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgYm9keT86IHVua25vd247XG59XG5cbi8qKlxuICogSG93IHRoZSBcIndoYXQgZG8gSSBhbHJlYWR5IGhvbGRcIiByZXNwb25zZSBpcyBsYWlkIG91dC5cbiAqXG4gKiBgYXJyYXlgICAgICAgICAtIGEgZmxhdCBsaXN0IG9mIGJvb2tpbmdzLCBlYWNoIGNhcnJ5aW5nIGl0cyBvd24gZGF0ZSBmaWVsZCxcbiAqICAgICAgICAgICAgICAgICAgcmVhZCB2aWEgYGxpc3REYXRlRmllbGRzYC5cbiAqIGBkYXRlS2V5ZWRNYXBgIC0gYW4gb2JqZWN0IGtleWVkIGJ5IGBZWVlZLU1NLUREYCB3aG9zZSB2YWx1ZXMgYXJlIHRoYXQgZGF5J3NcbiAqICAgICAgICAgICAgICAgICAgZW50cmllcy4gQ29tZWVuIHJldHVybnMgdGhpcyBvbmUuIFRoZSBkYXRlIGlzIHRoZSAqa2V5Kiwgbm90XG4gKiAgICAgICAgICAgICAgICAgIGEgZmllbGQsIHNvIG5vIGFtb3VudCBvZiBzbmlmZmluZyBmaWVsZCBuYW1lcyB3b3VsZCBmaW5kIGl0IFx1MjAxNFxuICogICAgICAgICAgICAgICAgICB3aGljaCBpcyBleGFjdGx5IHdoeSB0aGUgc2hhcGUgaXMgY29uZmlndXJhdGlvbiByYXRoZXIgdGhhblxuICogICAgICAgICAgICAgICAgICBzb21ldGhpbmcgdGhlIGluLXBhZ2UgY29kZSBndWVzc2VzLlxuICovXG5leHBvcnQgdHlwZSBMaXN0U2hhcGUgPSAnYXJyYXknIHwgJ2RhdGVLZXllZE1hcCc7XG5cbi8qKlxuICogVGhlIHdob2xlIEFQSSBjb250cmFjdCBsaXZlcyBoZXJlIGFzIGRhdGEgc28gaXQgY2FuIGJlIGNvcnJlY3RlZCBmcm9tIHRoZVxuICogcG9wdXAgd2l0aG91dCByZWJ1aWxkaW5nLiBQbGFjZWhvbGRlcnMgYXZhaWxhYmxlIHRvIHBhdGhzLCBxdWVyaWVzIGFuZFxuICogYm9kaWVzOiB7e2RhdGV9fSwge3tkZXNrSWR9fSwge3tkZXNrTmFtZX19LCB7e3Nsb3R9fSwge3tzdGFydFRpbWV9fSxcbiAqIHt7ZW5kVGltZX19LCB7e2Zyb219fSwge3t0b319LCB7e3VzZXJJZH19LCB7e2Zsb29ySWR9fSwge3tidWlsZGluZ0lkfX0sXG4gKiB7e2FyZWFJZH19LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEVuZHBvaW50Q29uZmlnIHtcbiAgICBhcGlCYXNlOiBzdHJpbmc7XG4gICAgYXV0aDogQXV0aENvbmZpZztcbiAgICAvKipcbiAgICAgKiBMb29rIGEgZGVzayB1cCBieSBpdHMgaHVtYW4gbmFtZSBzbyBub2JvZHkgaGFzIHRvIGtub3cgaXRzIGludGVybmFsIGlkLlxuICAgICAqIFNldCB0byBudWxsIG9ubHkgaWYgeW91ciBDb21lZW4gaGFzIG5vIGRlc2stc2VhcmNoIGVuZHBvaW50LlxuICAgICAqL1xuICAgIHJlc29sdmU6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqIEZpZWxkIG5hbWVzIHRoYXQgbWlnaHQgaG9sZCBhIGRlc2sncyBodW1hbiBsYWJlbCBpbiBhIHNlYXJjaCByZXN1bHQuICovXG4gICAgZGVza05hbWVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKiBGaWVsZCBuYW1lcyB0aGF0IG1pZ2h0IGhvbGQgYSBkZXNrJ3MgaW50ZXJuYWwgaWQuIENvbWVlbiB1c2VzIGB1dWlkYC4gKi9cbiAgICBkZXNrSWRGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIEZpZWxkIG9uIGEgZGVzayByZWNvcmQgaG9sZGluZyB0aGF0IGRlc2sncyBvd24gYm9va2luZ3MgZm9yIHRoZSBxdWVyaWVkXG4gICAgICogd2luZG93LiBVc2VkIHRvIHRlbGwgeW91IGEgZGF5IGlzIGFscmVhZHkgdGFrZW4gKmJlZm9yZSogeW91IHByZXNzIEJvb2tcbiAgICAgKiBub3cuIFNldCB0byAnJyB0byBkaXNhYmxlLlxuICAgICAqL1xuICAgIGRlc2tTY2hlZHVsZUZpZWxkOiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogRGF0ZSBmaWVsZHMgdG8gcmVhZCBvZmYgb25lIG9mIHRob3NlIGVudHJpZXMsIGluIHByaW9yaXR5IG9yZGVyLCBmaXJzdFxuICAgICAqIG1hdGNoIHdpbnMuXG4gICAgICpcbiAgICAgKiBUaGUgb3JkZXIgbWF0dGVycyBtb3JlIHRoYW4gaXQgbG9va3M6IGFuIGVudHJ5IGFsbW9zdCBjZXJ0YWlubHkgYWxzb1xuICAgICAqIGNhcnJpZXMgY3JlYXRlZF9hdCBhbmQgdXBkYXRlZF9hdCwgd2hpY2ggYXJlIHdoZW4gdGhlIGJvb2tpbmcgd2FzIG1hZGUsXG4gICAgICogbm90IHRoZSBkYXkgYm9va2VkLiBMaXN0aW5nIG9ubHkgdGhlIGZpZWxkcyB0aGF0IG1lYW4gXCJ0aGUgZGF5IHRoaXMgaXNcbiAgICAgKiBmb3JcIiBpcyB3aGF0IHN0b3BzIGEgYm9va2luZyBtYWRlIHRocmVlIHdlZWtzIGFnbyBmcm9tIG1hcmtpbmcgdGhyZWVcbiAgICAgKiB3ZWVrcyBhZ28gYXMgdGFrZW4uXG4gICAgICovXG4gICAgZGVza1NjaGVkdWxlRGF0ZUZpZWxkczogc3RyaW5nW107XG4gICAgLyoqIFNldCB0byBudWxsIHRvIHNraXAgdGhlIFwid2hhdCBkbyBJIGFscmVhZHkgaGF2ZVwiIGNoZWNrLiAqL1xuICAgIGxpc3Q6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqIERvdHRlZCBwYXRoIHRvIHRoZSBjb250YWluZXIgaW5zaWRlIHRoZSBsaXN0IHJlc3BvbnNlLiAnJyBtZWFucyByb290LiAqL1xuICAgIGxpc3RSb290OiBzdHJpbmc7XG4gICAgbGlzdFNoYXBlOiBMaXN0U2hhcGU7XG4gICAgLyoqIE9ubHkgY29uc3VsdGVkIHdoZW4gbGlzdFNoYXBlIGlzICdhcnJheScuICovXG4gICAgbGlzdERhdGVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIERvdHRlZCBwYXRoIHRvIHRoZSBzaWduZWQtaW4gdXNlcidzIGlkIGluc2lkZSB0aGUgbGlzdCByZXNwb25zZS4gRW1wdHlcbiAgICAgKiBkaXNhYmxlcyB0aGUgbG9va3VwLCBhbmQge3t1c2VySWR9fSB0aGVuIHN0YXlzIHVuZmlsbGVkLlxuICAgICAqL1xuICAgIHVzZXJJZFBhdGg6IHN0cmluZztcbiAgICBjcmVhdGU6IFJlcXVlc3RUZW1wbGF0ZTtcbiAgICAvKipcbiAgICAgKiBDYW5jZWwgYSBib29raW5nLiBTZXQgdG8gbnVsbCB0byBkaXNhYmxlIGNhbmNlbGxpbmcgZW50aXJlbHkuXG4gICAgICpcbiAgICAgKiBUYWtlcyB7e2Jvb2tpbmdJZH19LCByZWFkIG9mZiB0aGUgbGlzdGVkIGJvb2tpbmcgdmlhIGxpc3RCb29raW5nSWRGaWVsZHMgXHUyMDE0XG4gICAgICogc28gY2FuY2VsbGluZyBkZXBlbmRzIG9uIGBsaXN0YCB3b3JraW5nLCB3aGljaCBpcyBjb3JyZWN0OiB5b3UgY2Fubm90XG4gICAgICogY2FuY2VsIHdoYXQgeW91IGhhdmUgbm90IGNvbmZpcm1lZCB5b3UgaG9sZC5cbiAgICAgKi9cbiAgICBjYW5jZWw6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqXG4gICAgICogRmllbGRzIG9uIGEgbGlzdGVkIGJvb2tpbmcgdGhhdCBpZGVudGlmeSBpdCBmb3IgY2FuY2VsbGF0aW9uLCBpbiBwcmlvcml0eVxuICAgICAqIG9yZGVyLiBDb21lZW4gd2FudHMgdGhlIG51bWVyaWMgYGlkYCBoZXJlLCBOT1QgdGhlIGB1dWlkYCB0aGF0IHRoZSBzYW1lXG4gICAgICogZW50cnkgYWxzbyBjYXJyaWVzIGFuZCB0aGF0IHRoZSBjcmVhdGUgYm9keSB1c2VzIGZvciB0aGUgZGVzay4gR2V0dGluZ1xuICAgICAqIHRoaXMgd3JvbmcgaXMgYSA0MDQgYXQgYmVzdC5cbiAgICAgKi9cbiAgICBsaXN0Qm9va2luZ0lkRmllbGRzOiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5ncyB7XG4gICAgLyoqXG4gICAgICogQnVtcGVkIGluIERFRkFVTFRfU0VUVElOR1Mgd2hlbmV2ZXIgdGhlIHNoaXBwZWQgZW5kcG9pbnQgY29uZmlnIGlzXG4gICAgICogY29ycmVjdGVkLiBTZWUgbWVyZ2VTZXR0aW5nczogYSBzdG9yZWQgY29uZmlnIG9sZGVyIHRoYW4gdGhlIHNoaXBwZWQgb25lXG4gICAgICogaXMgcmVwbGFjZWQgcmF0aGVyIHRoYW4gbWVyZ2VkLCB3aGljaCBpcyB3aGF0IGxldHMgYSBmaXggYWN0dWFsbHkgcmVhY2hcbiAgICAgKiBwZW9wbGUgd2hvIGhhdmUgYWxyZWFkeSBzYXZlZCBzZXR0aW5ncyBvbmNlLlxuICAgICAqL1xuICAgIGVuZHBvaW50VmVyc2lvbjogbnVtYmVyO1xuICAgIGVuYWJsZWQ6IGJvb2xlYW47XG4gICAgZGVza05hbWU6IHN0cmluZztcbiAgICBkZXNrSWQ6IHN0cmluZztcbiAgICAvKipcbiAgICAgKiBUaGUgZmxvb3IgdGhlIGRlc2sgaXMgb24uIFRoaXMgb25lIGNhbm5vdCBiZSBkZXJpdmVkOiByZXNvbHZpbmcgYSBkZXNrIGJ5XG4gICAgICogbmFtZSBtZWFucyBsaXN0aW5nIGEgZmxvb3IncyBkZXNrcywgc28gdGhlIGZsb29yIGhhcyB0byBiZSBrbm93biBmaXJzdC5cbiAgICAgKiBWaXNpYmxlIGluIHRoZSBVUkwgb2YgQ29tZWVuJ3MgZmxvb3IgcGxhbiwgYW5kIGluIGBmbG9vcl9pZGAgb24gYW55IGRlc2suXG4gICAgICovXG4gICAgZmxvb3JJZDogbnVtYmVyO1xuICAgIC8qKlxuICAgICAqIFRoZSBidWlsZGluZyB0aGUgZmxvb3IgaXMgaW4uIEFsc28gbm90IGRlcml2YWJsZSBcdTIwMTQgYSBkZXNrIHJlY29yZCBjYXJyaWVzXG4gICAgICogYGZsb29yX2lkYCBhbmQgYGFyZWFfaWRgIGJ1dCBubyBgYnVpbGRpbmdfaWRgLCBhbmQgdGhlIG9ubHkgZW5kcG9pbnQgdGhhdFxuICAgICAqIG1hcHMgb25lIHRvIHRoZSBvdGhlciBuZWVkcyBhIHNwYWNlIFVVSUQgd2UgbmV2ZXIgb3RoZXJ3aXNlIGZldGNoLlxuICAgICAqL1xuICAgIGJ1aWxkaW5nSWQ6IG51bWJlcjtcbiAgICB3ZWVrZGF5czogV2Vla2RheVtdO1xuICAgIHNsb3Q6IFNsb3Q7XG4gICAgaG9yaXpvbkRheXM6IG51bWJlcjtcbiAgICBza2lwRGF0ZXM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIERheXMgd2hvc2UgYm9va2luZyBzaG91bGQgYmUgY2FuY2VsbGVkIG9uIHRoZSBuZXh0IHJ1bi5cbiAgICAgKlxuICAgICAqIEEgb25lLXNob3QgaW5zdHJ1Y3Rpb24sIG5vdCBhIHByZWZlcmVuY2U6IGFuIGVudHJ5IGlzIHJlbW92ZWQgb25jZSB0aGVcbiAgICAgKiBjYW5jZWxsYXRpb24gc3VjY2VlZHMsIG9yIHRoZSBuZXh0IGF1dG9tYXRpYyBydW4gd291bGQga2VlcCB0cnlpbmcgdG9cbiAgICAgKiBkZWxldGUgc29tZXRoaW5nIGFscmVhZHkgZ29uZS4gQWRkaW5nIGEgZGF0ZSBoZXJlIGFsc28gYWRkcyBpdCB0b1xuICAgICAqIHNraXBEYXRlcyBcdTIwMTQgb3RoZXJ3aXNlIHRoZSBzYW1lIHJ1biB0aGF0IGNhbmNlbHMgaXQgYm9va3MgaXQgc3RyYWlnaHQgYmFjay5cbiAgICAgKi9cbiAgICBjYW5jZWxEYXRlczogc3RyaW5nW107XG4gICAgdGltZVpvbmU6IHN0cmluZztcbiAgICBlbmRwb2ludDogRW5kcG9pbnRDb25maWc7XG59XG5cbi8qKlxuICogQSBzbG90IGFzIHRoZSBuYWl2ZSBsb2NhbCB0aW1lcyBDb21lZW4gZXhwZWN0cy5cbiAqXG4gKiBDb21lZW4gc2VuZHMgZGF0ZXRpbWVzIGxpa2UgYDIwMjYtMDktMDFUMDA6MDA6MDAuMDAwWmAgYW5kIGVjaG9lcyB0aGVtIGJhY2tcbiAqIGFzIGAyMDI2LTA5LTAxVDAwOjAwOjAwYCBcdTIwMTQgYSBsb2NhbCB3YWxsLWNsb2NrIHRpbWUgd2VhcmluZyBhIGBaYC4gU28gdGhlIGRheVxuICogaXMgdXNlZCB2ZXJiYXRpbSBhbmQgbm8gdGltZXpvbmUgY29udmVyc2lvbiBoYXBwZW5zIGFueXdoZXJlIGluIHRoZSBib29raW5nXG4gKiBwYXRoLiBUaGUgZGF0ZSBsb2dpYyBpbiBkYXRlcy50cyBhbHJlYWR5IHByb2R1Y2VzIGV4YWN0bHkgdGhpcy5cbiAqXG4gKiBBbGwgdGhyZWUgY29uZmlybWVkIGFnYWluc3Qgd2hhdCBDb21lZW4ncyBvd24gd2ViIFVJIHNlbmRzLiBUaGUgaGFsZi1kYXlzXG4gKiB3ZXJlIGd1ZXNzZWQgZmlyc3QgYW5kIG9uZSBndWVzcyB3YXMgd3Jvbmc6IG1vcm5pbmcgZW5kcyBhdCAxMTo1OTo1OSwgbm90IGF0XG4gKiAxMjowMDowMCwgZm9sbG93aW5nIHRoZSBzYW1lIFwibGFzdCBzZWNvbmQgb2YgdGhlIHBlcmlvZFwiIHBhdHRlcm4gYXMgYWxsX2RheS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNMT1RfVElNRVM6IFJlY29yZDxTbG90LCB7IHN0YXJ0OiBzdHJpbmc7IGVuZDogc3RyaW5nIH0+ID0ge1xuICAgIGFsbF9kYXk6IHsgc3RhcnQ6ICcwMDowMDowMC4wMDBaJywgZW5kOiAnMjM6NTk6NTkuMDAwWicgfSxcbiAgICBtb3JuaW5nOiB7IHN0YXJ0OiAnMDA6MDA6MDAuMDAwWicsIGVuZDogJzExOjU5OjU5LjAwMFonIH0sXG4gICAgYWZ0ZXJub29uOiB7IHN0YXJ0OiAnMTI6MDA6MDAuMDAwWicsIGVuZDogJzIzOjU5OjU5LjAwMFonIH0sXG59O1xuXG4vKipcbiAqIENvbmZpcm1lZCBhZ2FpbnN0IGEgcmVhbCBzaWduZWQtaW4gc2Vzc2lvbiBpbiBBdWd1c3QgMjAyNiwgYnkgY2FwdHVyaW5nIHRoZVxuICogdHJhZmZpYyBvZiBvbmUgZGVzayBib29raW5nIG1hZGUgYnkgaGFuZC5cbiAqXG4gKiBOb3RlcyB3b3J0aCBrZWVwaW5nLCBiZWNhdXNlIGVhY2ggb25lIGNvbnRyYWRpY3RzIGEgcmVhc29uYWJsZSBndWVzczpcbiAqICAgLSBgYXBpQmFzZWAgaXMgbXkuY29tZWVuLmlvL2FwaSwgdGhlIFNQQSdzIG93biBvcmlnaW4sIE5PVCBhcGkuY29tZWVuLmlvXG4gKiAgICAgd2hlcmUgdGhlIHB1YmxpYyBkb2NzIGxpdmUuIEl0IGlzIGEgUmFpbHMgYmFja2VuZCBiZWhpbmQgYSBOdXh0IGZyb250IGVuZCxcbiAqICAgICB3aGljaCBpcyB3aHkgcGF0aHMgZW5kIGluIGAuanNvbmAuXG4gKiAgIC0gVGhlIEFQSSB2ZXJzaW9uIHZhcmllcyBwZXIgZW5kcG9pbnQgKC92MSwgL3YyLCAvdjJiZXRhKSwgc28gdGhlIHZlcnNpb25cbiAqICAgICBiZWxvbmdzIGluIGVhY2ggcGF0aCByYXRoZXIgdGhhbiBpbiBhcGlCYXNlLlxuICogICAtIEEgZGVzaydzIGlkIGlzIGB1dWlkYC4gVGhlcmUgaXMgbm8gYGlkYCBmaWVsZCBvbiBhIGRlc2sgYXQgYWxsLlxuICogICAtIFRoZSBib29raW5ncyBsaXN0IGlzIGtleWVkIGJ5IGRhdGU7IHRoZSBkYXRlIGlzIG5vdCBhIGZpZWxkIG9uIGFuIGVudHJ5LlxuICogICAtIEEgYm9va2luZyBpcyBhIFwid29yayBhY3Rpdml0eVwiIHdpdGggYSBkZXNrIGF0dGFjaGVkLCBub3QgYSBkZXNrIGJvb2tpbmdcbiAqICAgICBhcyBzdWNoLiBUaGF0IGlzIHdoeSB0aGUgcGF0aCBzYXlzIHdvcmtfYWN0aXZpdHlfc2NoZWR1bGUuXG4gKiAgIC0gQXV0aCBpcyB0aGUgc2Vzc2lvbiBjb29raWUuIEEgZmV0Y2ggZnJvbSB0aGUgcGFnZSB3aXRoIGNyZWRlbnRpYWxzXG4gKiAgICAgaW5jbHVkZWQgYW5kIG5vIEF1dGhvcml6YXRpb24gaGVhZGVyIHJldHVybnMgMjAwLCBzbyB0aGVyZSBpcyBubyB0b2tlbiB0b1xuICogICAgIHJlYWQgYW5kIG5vdGhpbmcgZm9yIHRoZSBleHRlbnNpb24gdG8gaG9sZC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFNldHRpbmdzID0ge1xuICAgIC8vIFx1MkIwNiBCVU1QIFRISVMgd2hlbmV2ZXIgeW91IGNvcnJlY3QgdGhlIGBlbmRwb2ludGAgYmxvY2sgYmVsb3csIG90aGVyd2lzZVxuICAgIC8vIGFueW9uZSB3aG8gYWxyZWFkeSBwcmVzc2VkIFNhdmUga2VlcHMgdGhlaXIgc3RhbGUgY29weSBmb3JldmVyLlxuICAgIGVuZHBvaW50VmVyc2lvbjogNCxcbiAgICBlbmFibGVkOiBmYWxzZSxcbiAgICAvLyBFbXB0eSBvbiBwdXJwb3NlLiBTaGlwcGluZyBhIHJlYWwgZGVzayBudW1iZXIgYXMgdGhlIGRlZmF1bHQgbWVhbnMgdGhlXG4gICAgLy8gZmlyc3QgcGVyc29uIHRvIGluc3RhbGwgdGhpcyBhbmQgcHJlc3MgQm9vayBub3cgdGFrZXMgc29tZWJvZHkgZWxzZSdzXG4gICAgLy8gc2VhdCwgaGF2aW5nIGRvbmUgbm90aGluZyB3cm9uZy4gTm90aGluZyBydW5zIHVudGlsIGEgZGVzayBpcyBjaG9zZW4uXG4gICAgZGVza05hbWU6ICcnLFxuICAgIGRlc2tJZDogJycsXG4gICAgZmxvb3JJZDogNDk1MixcbiAgICBidWlsZGluZ0lkOiA1MTUxLFxuICAgIHdlZWtkYXlzOiBbJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknXSxcbiAgICBzbG90OiAnYWxsX2RheScsXG4gICAgaG9yaXpvbkRheXM6IDE0LFxuICAgIHNraXBEYXRlczogW10sXG4gICAgY2FuY2VsRGF0ZXM6IFtdLFxuICAgIHRpbWVab25lOiAnRXVyb3BlL1ByYWd1ZScsXG4gICAgZW5kcG9pbnQ6IHtcbiAgICAgICAgYXBpQmFzZTogJ2h0dHBzOi8vbXkuY29tZWVuLmlvL2FwaScsXG4gICAgICAgIGF1dGg6IHsgbW9kZTogJ2Nvb2tpZScgfSxcbiAgICAgICAgcmVzb2x2ZToge1xuICAgICAgICAgICAgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgICAgIHBhdGg6ICcvdjEvZmxvb3JzL3t7Zmxvb3JJZH19L2Rlc2tzX3NjaGVkdWxlLmpzb24nLFxuICAgICAgICAgICAgcXVlcnk6IHtcbiAgICAgICAgICAgICAgICBzdGFydF9kYXRlOiAne3tmcm9tfX1UMDA6MDA6MDAuMDAwWicsXG4gICAgICAgICAgICAgICAgZW5kX2RhdGU6ICd7e3RvfX1UMjM6NTk6NTkuMDAwWicsXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBkZXNrTmFtZUZpZWxkczogWyduYW1lJywgJ3N5bmNfaWQnXSxcbiAgICAgICAgZGVza0lkRmllbGRzOiBbJ3V1aWQnLCAnaWQnXSxcbiAgICAgICAgZGVza1NjaGVkdWxlRmllbGQ6ICdzY2hlZHVsZScsXG4gICAgICAgIGRlc2tTY2hlZHVsZURhdGVGaWVsZHM6IFsnc3RhcnRfZGF0ZXRpbWUnLCAnc3RhcnRfZGF0ZScsICdkYXRlJywgJ2RheScsICdzdGFydCddLFxuICAgICAgICBsaXN0OiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICAgICAgcGF0aDogJy92MS91c2Vycy9tZS93b3JrX2FjdGl2aXR5X3NjaGVkdWxlLmpzb24nLFxuICAgICAgICAgICAgcXVlcnk6IHtcbiAgICAgICAgICAgICAgICBzdGFydF9kYXRlOiAne3tmcm9tfX1UMDA6MDA6MDAuMDAwWicsXG4gICAgICAgICAgICAgICAgZW5kX2RhdGU6ICd7e3RvfX1UMjM6NTk6NTkuMDAwWicsXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBsaXN0Um9vdDogJ3NjaGVkdWxlJyxcbiAgICAgICAgbGlzdFNoYXBlOiAnZGF0ZUtleWVkTWFwJyxcbiAgICAgICAgbGlzdERhdGVGaWVsZHM6IFsnc3RhcnRfZGF0ZXRpbWUnLCAnZGF0ZSddLFxuICAgICAgICB1c2VySWRQYXRoOiAndXNlci5pZCcsXG4gICAgICAgIGxpc3RCb29raW5nSWRGaWVsZHM6IFsnaWQnLCAndXVpZCddLFxuICAgICAgICBjcmVhdGU6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICAgICAgLy8gVGhlIGBtZWAgYWxpYXMgd29ya3MgZm9yIHJlYWRzOyB0aGUgYXBwIGl0c2VsZiB1c2VzIHRoZSBudW1lcmljXG4gICAgICAgICAgICAvLyBpZCB0byB3cml0ZSwgc28gdGhhdCBpcyB3aGF0IGlzIHVzZWQgaGVyZS5cbiAgICAgICAgICAgIHBhdGg6ICcvdjEvdXNlcnMve3t1c2VySWR9fS93b3JrX2FjdGl2aXR5X3NjaGVkdWxlLmpzb24nLFxuICAgICAgICAgICAgYm9keToge1xuICAgICAgICAgICAgICAgIHdvcmtfYWN0aXZpdHk6IHtcbiAgICAgICAgICAgICAgICAgICAgc3RhdGU6ICdvbl9zaXRlJyxcbiAgICAgICAgICAgICAgICAgICAgc3RhcnRfZGF0ZXRpbWU6ICd7e2RhdGV9fVR7e3N0YXJ0VGltZX19JyxcbiAgICAgICAgICAgICAgICAgICAgZW5kX2RhdGV0aW1lOiAne3tkYXRlfX1Ue3tlbmRUaW1lfX0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgcHJlc2VuY2U6IHtcbiAgICAgICAgICAgICAgICAgICAgYnVpbGRpbmdfaWQ6ICd7e2J1aWxkaW5nSWR9fScsXG4gICAgICAgICAgICAgICAgICAgIGZsb29yX2lkOiAne3tmbG9vcklkfX0nLFxuICAgICAgICAgICAgICAgICAgICBhcmVhX2lkOiAne3thcmVhSWR9fScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBkZXNrX2Jvb2tpbmc6IHsgZGVza191dWlkOiAne3tkZXNrSWR9fScgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGNhbmNlbDoge1xuICAgICAgICAgICAgbWV0aG9kOiAnREVMRVRFJyxcbiAgICAgICAgICAgIC8vIE5vdGUgYC9tZS9gLCBub3QgYC91c2Vycy97e3VzZXJJZH19L2AgYXMgY3JlYXRlIHVzZXMsIGFuZCB0aGVcbiAgICAgICAgICAgIC8vIG51bWVyaWMgYm9va2luZyBpZCByYXRoZXIgdGhhbiBpdHMgdXVpZC4gQm90aCBjb25maXJtZWQgZnJvbSBhXG4gICAgICAgICAgICAvLyBjYXB0dXJlZCBjYW5jZWxsYXRpb247IG5laXRoZXIgaXMgd2hhdCB5b3Ugd291bGQgaGF2ZSBndWVzc2VkXG4gICAgICAgICAgICAvLyBmcm9tIHRoZSBjcmVhdGUgY2FsbC5cbiAgICAgICAgICAgIHBhdGg6ICcvdjEvbWUvd29ya19hY3Rpdml0eV9zY2hlZHVsZS97e2Jvb2tpbmdJZH19JyxcbiAgICAgICAgfSxcbiAgICB9LFxufTtcblxuLyoqXG4gKiBUaGUgb2ZmaWNlLCBhcyBjYXB0dXJlZCBpbiBBdWd1c3QgMjAyNi5cbiAqXG4gKiBIYXJkY29kZWQgcmF0aGVyIHRoYW4gZmV0Y2hlZC4gVGhlIGZsb29yIGRyb3Bkb3duIGhhcyB0byBiZSBwb3B1bGF0ZWQgYmVmb3JlXG4gKiBhbnkgbmV0d29yayBjYWxsIGhhcHBlbnMsIGFuIG9mZmljZSBsYXlvdXQgY2hhbmdlcyBhYm91dCBuZXZlciwgYW5kIGFcbiAqIGhhcmRjb2RlZCBmbG9vciB0aGF0IGlzIHdyb25nIGlzIGEgdmlzaWJsZSBtaXN0YWtlIHJhdGhlciB0aGFuIGEgc2lsZW50IG9uZS5cbiAqXG4gKiBUbyBhZGQgYSBmbG9vciwgcmVhZCB0aGUgaWRzIGZyb20gdGhlIHJlc3BvbnNlIG9mXG4gKiAvYXBpL3YyL3NwYWNlcy88c3BhY2UtdXVpZD4vYnVpbGRpbmdzLzxidWlsZGluZy1pZD4vZmxvb3JzLmpzb24gd2l0aCB0aGVcbiAqIGZsb29yIHBsYW4gb3Blbi5cbiAqL1xuZXhwb3J0IGNvbnN0IEJVSUxESU5HID0geyBpZDogNTE1MSwgbmFtZTogJzEwMHlhcmRzJyB9O1xuXG4vKipcbiAqIEEgZGVzayBuYW1lIGlzIGRpZ2l0cywgYSBkYXNoLCBkaWdpdHMgXHUyMDE0IGAzLTIzYCwgYDEyLTRgLlxuICpcbiAqIERlbGliZXJhdGVseSBub3QgdGlnaHRlbmVkIHRvIHR3byB6ZXJvLXBhZGRlZCBkaWdpdHMsIHdoaWNoIGlzIHdoYXQgdGhpc1xuICogb2ZmaWNlIGhhcHBlbnMgdG8gdXNlOiBhIGZsb29yIDEyIG9yIGEgZGVzayAxMDAgd291bGQgdGhlbiBiZSByZWplY3RlZCBmb3JcbiAqIGxvb2tpbmcgd3JvbmcgcmF0aGVyIHRoYW4gZm9yIGJlaW5nIHdyb25nLiBXaGF0IHRoaXMgY2F0Y2hlcyBpcyB0aGUgbWlzdGFrZVxuICogcGVvcGxlIGFjdHVhbGx5IG1ha2UgXHUyMDE0IHR5cGluZyBzb21ldGhpbmcgdGhhdCBpcyBub3QgYSBkZXNrIG51bWJlciBhdCBhbGw6IGFcbiAqIG5hbWUsIGEgcm9vbSwgYSBzdHJheSBzcGFjZS5cbiAqL1xuZXhwb3J0IGNvbnN0IERFU0tfTkFNRV9QQVRURVJOID0gL15cXGQrLVxcZCskLztcblxuLyoqIEVtcHR5IGlzIG5vdCB2YWxpZCwgYnV0IGl0IGlzIG5vdCBhbiBlcnJvciBlaXRoZXIgXHUyMDE0IHNlZSB0aGUgcG9wdXAuICovXG5leHBvcnQgZnVuY3Rpb24gaXNWYWxpZERlc2tOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBERVNLX05BTUVfUEFUVEVSTi50ZXN0KG5hbWUudHJpbSgpKTtcbn1cblxuLyoqXG4gKiBEcm9wIHNraXAgZGF0ZXMgdGhhdCBoYXZlIGFscmVhZHkgcGFzc2VkLlxuICpcbiAqIERheXMgY2FuIGJlIG1hcmtlZCBtb250aHMgYWhlYWQsIHNvIHdpdGhvdXQgdGhpcyB0aGUgbGlzdCBvbmx5IGV2ZXIgZ3Jvd3MgXHUyMDE0XG4gKiBhIHllYXIgb2YgXCJJIHdhcyBhd2F5IHRoYXQgVHVlc2RheVwiIGFjY3VtdWxhdGluZyBpbiBzdG9yYWdlIGFuZCBpbiB0aGVcbiAqIHNldHRpbmdzIEpTT04sIHdoZXJlIGl0IGlzIG5vaXNlIHRoYXQgbWFrZXMgdGhlIHJlYWwgZW50cmllcyBoYXJkIHRvIHJlYWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcnVuZVBhc3RTa2lwRGF0ZXMoc2tpcERhdGVzOiBzdHJpbmdbXSwgdG9kYXk6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gc2tpcERhdGVzLmZpbHRlcigoZGF0ZSkgPT4gZGF0ZSA+PSB0b2RheSk7XG59XG5cbmV4cG9ydCBjb25zdCBGTE9PUlM6IHsgaWQ6IG51bWJlcjsgbGFiZWw6IHN0cmluZyB9W10gPSBbXG4gICAgeyBpZDogNDk1MiwgbGFiZWw6ICdGbG9vciAzJyB9LFxuICAgIHsgaWQ6IDQ5NTMsIGxhYmVsOiAnRmxvb3IgNCcgfSxcbl07XG5cbmV4cG9ydCB0eXBlIFZhcnMgPSBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4vKipcbiAqIEEgcGxhY2Vob2xkZXIgdGhhdCBtYWtlcyB1cCB0aGUgKmVudGlyZSogdmFsdWUgYW5kIHJlc29sdmVzIHRvIGFuIGludGVnZXJcbiAqIGJlY29tZXMgYSBudW1iZXIuXG4gKlxuICogVGhpcyBtYXR0ZXJzIGJlY2F1c2UgSlNPTiBkaXN0aW5ndWlzaGVzIDUxNTEgZnJvbSBcIjUxNTFcIiBhbmQgQ29tZWVuJ3NcbiAqIHByZXNlbmNlIGJsb2NrIHdhbnRzIHRoZSBmb3JtZXIuIFBhcnRpYWwgaW50ZXJwb2xhdGlvbiBcdTIwMTQgXCIvdXNlcnMve3t1c2VySWR9fS94XCJcbiAqIFx1MjAxNCBhbHdheXMgeWllbGRzIGEgc3RyaW5nLCB3aGljaCBpcyB3aGF0IGEgcGF0aCBuZWVkcywgc28gdGhlIHR3byBjYXNlcyBuZXZlclxuICogY29sbGlkZS4gQSB1dWlkIG9yIGEgZGF0ZSBjb250YWlucyBub24tZGlnaXRzIGFuZCBzdGF5cyBhIHN0cmluZyBlaXRoZXIgd2F5LlxuICovXG5jb25zdCBXSE9MRV9QTEFDRUhPTERFUiA9IC9eXFx7XFx7KFxcdyspXFx9XFx9JC87XG5jb25zdCBJTlRFR0VSID0gL14tP1xcZCskLztcblxuLyoqIFJlcGxhY2Uge3twbGFjZWhvbGRlcnN9fSB0aHJvdWdob3V0IGEgSlNPTi1pc2ggdmFsdWUuICovXG5leHBvcnQgZnVuY3Rpb24gc3Vic3RpdHV0ZSh2YWx1ZTogdW5rbm93biwgdmFyczogVmFycyk6IHVua25vd24ge1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGNvbnN0IHdob2xlID0gV0hPTEVfUExBQ0VIT0xERVIuZXhlYyh2YWx1ZSk7XG4gICAgICAgIGlmICh3aG9sZSkge1xuICAgICAgICAgICAgY29uc3QgcmVwbGFjZW1lbnQgPSB2YXJzW3dob2xlWzFdID8/ICcnXTtcbiAgICAgICAgICAgIGlmIChyZXBsYWNlbWVudCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdmFsdWU7XG4gICAgICAgICAgICByZXR1cm4gSU5URUdFUi50ZXN0KHJlcGxhY2VtZW50KSA/IE51bWJlcihyZXBsYWNlbWVudCkgOiByZXBsYWNlbWVudDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmFsdWUucmVwbGFjZSgvXFx7XFx7KFxcdyspXFx9XFx9L2csIChtYXRjaCwga2V5OiBzdHJpbmcpID0+IHZhcnNba2V5XSA/PyBtYXRjaCk7XG4gICAgfVxuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICByZXR1cm4gdmFsdWUubWFwKChlbnRyeSkgPT4gc3Vic3RpdHV0ZShlbnRyeSwgdmFycykpO1xuICAgIH1cbiAgICBpZiAodmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgZW50cnldIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlKSkgb3V0W2tleV0gPSBzdWJzdGl0dXRlKGVudHJ5LCB2YXJzKTtcbiAgICAgICAgcmV0dXJuIG91dDtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKipcbiAqIE1lcmdlIHN0b3JlZCBzZXR0aW5ncyBvdmVyIHRoZSBzaGlwcGVkIGRlZmF1bHRzLlxuICpcbiAqIFBlcnNvbmFsIGNob2ljZXMgKGRlc2ssIHdlZWtkYXlzLCB0aW1lem9uZSkgYWx3YXlzIHdpbjogdGhleSBhcmUgdGhlIHVzZXIncy5cbiAqIFRoZSBlbmRwb2ludCBjb25maWcgaXMgZGlmZmVyZW50LiBJdCBpcyBub3QgYSBwcmVmZXJlbmNlLCBpdCBpcyBhIGZhY3QgYWJvdXRcbiAqIENvbWVlbidzIEFQSSB0aGF0IG9uZSBwZXJzb24gZGlzY292ZXJzIGFuZCBldmVyeW9uZSBlbHNlIGluaGVyaXRzLiBJZiBhXG4gKiBzdG9yZWQgY29weSBwcmVkYXRlcyB0aGUgc2hpcHBlZCBvbmUsIHRoZSBzaGlwcGVkIG9uZSByZXBsYWNlcyBpdCBvdXRyaWdodC5cbiAqIE1lcmdpbmcga2V5LWJ5LWtleSB3b3VsZCBiZSB3b3JzZSB0aGFuIHVzZWxlc3MgaGVyZTogYSBjb3JyZWN0ZWQgYGNyZWF0ZWBcbiAqIGJsb2NrIHdvdWxkIHNpdCBuZXh0IHRvIGEgc3RhbGUgYGxpc3RgIGJsb2NrIGFuZCBmYWlsIGluIGEgY29uZnVzaW5nIHdheS5cbiAqXG4gKiBQdXJlIGFuZCBzZXBhcmF0ZSBmcm9tIGNocm9tZS5zdG9yYWdlIHNvIGl0IGNhbiBiZSB0ZXN0ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZVNldHRpbmdzKHN0b3JlZDogUGFydGlhbDxTZXR0aW5ncz4gfCB1bmRlZmluZWQpOiBTZXR0aW5ncyB7XG4gICAgY29uc3Qgc3RvcmVkVmVyc2lvbiA9IHN0b3JlZD8uZW5kcG9pbnRWZXJzaW9uID8/IDA7XG4gICAgY29uc3Qgc2hpcHBlZElzTmV3ZXIgPSBzdG9yZWRWZXJzaW9uIDwgREVGQVVMVF9TRVRUSU5HUy5lbmRwb2ludFZlcnNpb247XG5cbiAgICByZXR1cm4ge1xuICAgICAgICAuLi5ERUZBVUxUX1NFVFRJTkdTLFxuICAgICAgICAuLi5zdG9yZWQsXG4gICAgICAgIGVuZHBvaW50VmVyc2lvbjogREVGQVVMVF9TRVRUSU5HUy5lbmRwb2ludFZlcnNpb24sXG4gICAgICAgIGVuZHBvaW50OiBzaGlwcGVkSXNOZXdlciB8fCAhc3RvcmVkPy5lbmRwb2ludFxuICAgICAgICAgICAgPyBERUZBVUxUX1NFVFRJTkdTLmVuZHBvaW50XG4gICAgICAgICAgICA6IHN0b3JlZC5lbmRwb2ludCxcbiAgICB9O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZFNldHRpbmdzKCk6IFByb21pc2U8U2V0dGluZ3M+IHtcbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoJ3NldHRpbmdzJyk7XG4gICAgcmV0dXJuIG1lcmdlU2V0dGluZ3Moc3RvcmVkLnNldHRpbmdzIGFzIFBhcnRpYWw8U2V0dGluZ3M+IHwgdW5kZWZpbmVkKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVTZXR0aW5ncyhzZXR0aW5nczogU2V0dGluZ3MpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBzZXR0aW5ncyB9KTtcbn1cbiIsICJleHBvcnQgdHlwZSBXZWVrZGF5ID1cbiAgICB8ICdtb25kYXknIHwgJ3R1ZXNkYXknIHwgJ3dlZG5lc2RheSdcbiAgICB8ICd0aHVyc2RheScgfCAnZnJpZGF5JyB8ICdzYXR1cmRheScgfCAnc3VuZGF5JztcblxuY29uc3QgV0VFS0RBWV9OQU1FUzogcmVhZG9ubHkgV2Vla2RheVtdID0gW1xuICAgICdzdW5kYXknLCAnbW9uZGF5JywgJ3R1ZXNkYXknLCAnd2VkbmVzZGF5JywgJ3RodXJzZGF5JywgJ2ZyaWRheScsICdzYXR1cmRheScsXG5dO1xuXG5mdW5jdGlvbiBpc1dlZWtkYXkodmFsdWU6IHN0cmluZyk6IHZhbHVlIGlzIFdlZWtkYXkge1xuICAgIHJldHVybiAoV0VFS0RBWV9OQU1FUyBhcyByZWFkb25seSBzdHJpbmdbXSkuaW5jbHVkZXModmFsdWUpO1xufVxuXG4vKiogRm9ybWF0IGEgRGF0ZSBhcyBZWVlZLU1NLUREIGFzIHNlZW4gaW4gYHRpbWVab25lYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b0xvY2FsSVNPRGF0ZShkYXRlOiBEYXRlLCB0aW1lWm9uZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLUNBJywge1xuICAgICAgICB0aW1lWm9uZSwgeWVhcjogJ251bWVyaWMnLCBtb250aDogJzItZGlnaXQnLCBkYXk6ICcyLWRpZ2l0JyxcbiAgICB9KS5mb3JtYXQoZGF0ZSk7XG59XG5cbi8qKiBXZWVrZGF5IG5hbWUgb2YgYGRhdGVgIGFzIHNlZW4gaW4gYHRpbWVab25lYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2NhbFdlZWtkYXkoZGF0ZTogRGF0ZSwgdGltZVpvbmU6IHN0cmluZyk6IFdlZWtkYXkge1xuICAgIGNvbnN0IG5hbWUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tVVMnLCB7IHRpbWVab25lLCB3ZWVrZGF5OiAnbG9uZycgfSlcbiAgICAgICAgLmZvcm1hdChkYXRlKVxuICAgICAgICAudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAoIWlzV2Vla2RheShuYW1lKSkgdGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHdlZWtkYXkgZnJvbSBJbnRsOiBcIiR7bmFtZX1cImApO1xuICAgIHJldHVybiBuYW1lO1xufVxuXG4vKiogTG9jYWwgd2FsbC1jbG9jayB0aW1lIGFzIGBZWVlZLU1NLUREVEhIOm1tOnNzYCwgbWF0Y2hpbmcgd2hhdCBDb21lZW4gc2VuZHMuICovXG5leHBvcnQgZnVuY3Rpb24gdG9Mb2NhbElTT0RhdGVUaW1lKGRhdGU6IERhdGUsIHRpbWVab25lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IHBhcnRzID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLUNBJywge1xuICAgICAgICB0aW1lWm9uZSxcbiAgICAgICAgeWVhcjogJ251bWVyaWMnLCBtb250aDogJzItZGlnaXQnLCBkYXk6ICcyLWRpZ2l0JyxcbiAgICAgICAgaG91cjogJzItZGlnaXQnLCBtaW51dGU6ICcyLWRpZ2l0Jywgc2Vjb25kOiAnMi1kaWdpdCcsXG4gICAgICAgIGhvdXIxMjogZmFsc2UsXG4gICAgfSkuZm9ybWF0VG9QYXJ0cyhkYXRlKTtcbiAgICBjb25zdCBnZXQgPSAodHlwZTogc3RyaW5nKTogc3RyaW5nID0+IHBhcnRzLmZpbmQoKHBhcnQpID0+IHBhcnQudHlwZSA9PT0gdHlwZSk/LnZhbHVlID8/ICcwMCc7XG4gICAgLy8gSW50bCByZW5kZXJzIG1pZG5pZ2h0IGFzIDI0IGluIHNvbWUgbG9jYWxlcy9lbmdpbmVzLlxuICAgIGNvbnN0IGhvdXIgPSBnZXQoJ2hvdXInKSA9PT0gJzI0JyA/ICcwMCcgOiBnZXQoJ2hvdXInKTtcbiAgICByZXR1cm4gYCR7Z2V0KCd5ZWFyJyl9LSR7Z2V0KCdtb250aCcpfS0ke2dldCgnZGF5Jyl9VCR7aG91cn06JHtnZXQoJ21pbnV0ZScpfToke2dldCgnc2Vjb25kJyl9YDtcbn1cblxuLyoqXG4gKiBIYXMgdGhpcyBkYXkncyBzbG90IGFscmVhZHkgYmVndW4/XG4gKlxuICogQ29tZWVuIHJlZnVzZXMgYSBib29raW5nIHdob3NlIHN0YXJ0IHRpbWUgaXMgaW4gdGhlIHBhc3QgXHUyMDE0IHdpdGggYSA1MDAgcmF0aGVyXG4gKiB0aGFuIGFueXRoaW5nIGhlbHBmdWwsIGFuZCBpdCByZWZ1c2VzIGl0cyBvd24gd2ViIFVJIGp1c3QgdGhlIHNhbWUsIHNvIHRoaXNcbiAqIGlzIGl0cyBiZWhhdmlvdXIgYW5kIG5vdCBzb21ldGhpbmcgd2UgYXJlIGRvaW5nIHdyb25nLiBGb3IgYW4gYWxsLWRheSBzbG90XG4gKiB0aGUgc3RhcnQgaXMgbWlkbmlnaHQsIHNvIHRvZGF5IGlzIHVuYm9va2FibGUgZnJvbSBvbmUgc2Vjb25kIHBhc3QgbWlkbmlnaHRcbiAqIG9ud2FyZHMuIEZvciBhbiBhZnRlcm5vb24gc2xvdCwgdG9kYXkgc3RheXMgYm9va2FibGUgdW50aWwgbm9vbi5cbiAqXG4gKiBCb3RoIHNpZGVzIGFyZSBuYWl2ZSBsb2NhbCB3YWxsLWNsb2NrLCB3aGljaCBpcyB0aGUgd2hvbGUgY29udmVudGlvbiBDb21lZW5cbiAqIHVzZXMsIHNvIGEgc3RyaW5nIGNvbXBhcmlzb24gaXMgZXhhY3RseSByaWdodCBoZXJlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzU2xvdFN0YXJ0ZWQoXG4gICAgZGF0ZTogc3RyaW5nLFxuICAgIHN0YXJ0VGltZTogc3RyaW5nLFxuICAgIHRpbWVab25lOiBzdHJpbmcsXG4gICAgbm93ID0gbmV3IERhdGUoKSxcbik6IGJvb2xlYW4ge1xuICAgIGNvbnN0IHN0YXJ0ID0gYCR7ZGF0ZX1UJHtzdGFydFRpbWUucmVwbGFjZSgvXFwuXFxkK1o/JC8sICcnKS5yZXBsYWNlKC9aJC8sICcnKX1gO1xuICAgIHJldHVybiB0b0xvY2FsSVNPRGF0ZVRpbWUobm93LCB0aW1lWm9uZSkgPj0gc3RhcnQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGF0ZXNUb0Jvb2tPcHRpb25zIHtcbiAgICB3ZWVrZGF5czogc3RyaW5nW107XG4gICAgaG9yaXpvbkRheXM/OiBudW1iZXI7XG4gICAgc2tpcERhdGVzPzogc3RyaW5nW107XG4gICAgdGltZVpvbmU/OiBzdHJpbmc7XG4gICAgbm93PzogRGF0ZTtcbn1cblxuLyoqXG4gKiBFdmVyeSBkYXkgZnJvbSB0b2RheSAoaW5jbHVzaXZlKSB1cCB0byBgaG9yaXpvbkRheXNgIGFoZWFkIHdob3NlIHdlZWtkYXkgaXNcbiAqIGluIGB3ZWVrZGF5c2AsIG1pbnVzIGBza2lwRGF0ZXNgLlxuICpcbiAqIFRoZSAxNC1kYXkgZGVmYXVsdCBpcyB3aGF0IG1ha2VzIHVucmVsaWFibGUgc2NoZWR1bGluZyBhY2NlcHRhYmxlOiBlYWNoIHJ1blxuICogdG9wcyB0aGUgd2hvbGUgd2luZG93IGJhY2sgdXAsIHNvIG1pc3NpbmcgYSBkYXkgKGxhcHRvcCBzaHV0LCBDaHJvbWUgY2xvc2VkKVxuICogY29zdHMgbm90aGluZyBhcyBsb25nIGFzIHRoZSBleHRlbnNpb24gcnVucyBhZ2FpbiBiZWZvcmUgdGhlIHdpbmRvdyBkcmFpbnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYXRlc1RvQm9vayh7XG4gICAgd2Vla2RheXMsXG4gICAgaG9yaXpvbkRheXMgPSAxNCxcbiAgICBza2lwRGF0ZXMgPSBbXSxcbiAgICB0aW1lWm9uZSA9ICdFdXJvcGUvUHJhZ3VlJyxcbiAgICBub3cgPSBuZXcgRGF0ZSgpLFxufTogRGF0ZXNUb0Jvb2tPcHRpb25zKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IHdhbnRlZCA9IG5ldyBTZXQ8V2Vla2RheT4oKTtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiB3ZWVrZGF5cykge1xuICAgICAgICBjb25zdCBuYW1lID0gcmF3LnRvTG93ZXJDYXNlKCk7XG4gICAgICAgIGlmICghaXNXZWVrZGF5KG5hbWUpKSB0aHJvdyBuZXcgRXJyb3IoYE5vdCBhIHdlZWtkYXkgbmFtZTogXCIke3Jhd31cImApO1xuICAgICAgICB3YW50ZWQuYWRkKG5hbWUpO1xuICAgIH1cblxuICAgIGNvbnN0IHNraXAgPSBuZXcgU2V0KHNraXBEYXRlcyk7XG4gICAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgZm9yIChsZXQgb2Zmc2V0ID0gMDsgb2Zmc2V0IDw9IGhvcml6b25EYXlzOyBvZmZzZXQgKz0gMSkge1xuICAgICAgICBjb25zdCBkYXkgPSBuZXcgRGF0ZShub3cuZ2V0VGltZSgpICsgb2Zmc2V0ICogODZfNDAwXzAwMCk7XG4gICAgICAgIGNvbnN0IGlzbyA9IHRvTG9jYWxJU09EYXRlKGRheSwgdGltZVpvbmUpO1xuICAgICAgICBpZiAoIXdhbnRlZC5oYXMobG9jYWxXZWVrZGF5KGRheSwgdGltZVpvbmUpKSkgY29udGludWU7XG4gICAgICAgIGlmIChza2lwLmhhcyhpc28pKSBjb250aW51ZTtcbiAgICAgICAgb3V0LnB1c2goaXNvKTtcbiAgICB9XG5cbiAgICByZXR1cm4gb3V0O1xufVxuIiwgImltcG9ydCB7XG4gICAgQlVJTERJTkcsXG4gICAgREVGQVVMVF9TRVRUSU5HUyxcbiAgICBGTE9PUlMsXG4gICAgaXNWYWxpZERlc2tOYW1lLFxuICAgIGxvYWRTZXR0aW5ncyxcbiAgICBtZXJnZVNldHRpbmdzLFxuICAgIHBydW5lUGFzdFNraXBEYXRlcyxcbiAgICBTTE9UX1RJTUVTLFxuICAgIHNhdmVTZXR0aW5ncyxcbiAgICB0eXBlIEVuZHBvaW50Q29uZmlnLFxuICAgIHR5cGUgU2V0dGluZ3MsXG4gICAgdHlwZSBTbG90LFxufSBmcm9tICcuL2NvcmUvY29uZmlnLmpzJztcbmltcG9ydCB7XG4gICAgZGF0ZXNUb0Jvb2ssXG4gICAgaGFzU2xvdFN0YXJ0ZWQsXG4gICAgbG9jYWxXZWVrZGF5LFxuICAgIHRvTG9jYWxJU09EYXRlLFxuICAgIHR5cGUgV2Vla2RheSxcbn0gZnJvbSAnLi9jb3JlL2RhdGVzLmpzJztcbmltcG9ydCB0eXBlIHsgUnVuTG9nIH0gZnJvbSAnLi9iYWNrZ3JvdW5kLmpzJztcblxuY29uc3QgREFZUzogV2Vla2RheVtdID0gWydtb25kYXknLCAndHVlc2RheScsICd3ZWRuZXNkYXknLCAndGh1cnNkYXknLCAnZnJpZGF5JywgJ3NhdHVyZGF5JywgJ3N1bmRheSddO1xuXG4vKiogTW9uZGF5LWZpcnN0LCB0byBtYXRjaCBob3cgYSB3b3JraW5nIHdlZWsgaXMgcmVhZC4gKi9cbmNvbnN0IERPV19MQUJFTFMgPSBbJ01vJywgJ1R1JywgJ1dlJywgJ1RoJywgJ0ZyJywgJ1NhJywgJ1N1J107XG5cbmZ1bmN0aW9uIGVsPFQgZXh0ZW5kcyBIVE1MRWxlbWVudD4oaWQ6IHN0cmluZyk6IFQge1xuICAgIGNvbnN0IG5vZGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7XG4gICAgaWYgKCFub2RlKSB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgZWxlbWVudCAjJHtpZH1gKTtcbiAgICByZXR1cm4gbm9kZSBhcyBUO1xufVxuXG5jb25zdCBmaWVsZHMgPSB7XG4gICAgZW5hYmxlZDogZWw8SFRNTElucHV0RWxlbWVudD4oJ2VuYWJsZWQnKSxcbiAgICBkZXNrTmFtZTogZWw8SFRNTElucHV0RWxlbWVudD4oJ2Rlc2tOYW1lJyksXG4gICAgZGVza0lkOiBlbDxIVE1MSW5wdXRFbGVtZW50PignZGVza0lkJyksXG4gICAgZmxvb3JJZDogZWw8SFRNTFNlbGVjdEVsZW1lbnQ+KCdmbG9vcklkJyksXG4gICAgc2xvdDogZWw8SFRNTFNlbGVjdEVsZW1lbnQ+KCdzbG90JyksXG4gICAgaG9yaXpvbkRheXM6IGVsPEhUTUxJbnB1dEVsZW1lbnQ+KCdob3Jpem9uRGF5cycpLFxuICAgIHRpbWVab25lOiBlbDxIVE1MSW5wdXRFbGVtZW50PigndGltZVpvbmUnKSxcbiAgICBlbmRwb2ludDogZWw8SFRNTFRleHRBcmVhRWxlbWVudD4oJ2VuZHBvaW50JyksXG4gICAgbGVhcm5Nb2RlOiBlbDxIVE1MSW5wdXRFbGVtZW50PignbGVhcm5Nb2RlJyksXG59O1xuXG4vLyBcdTI1MDBcdTI1MDAgc3RhdGljIG9mZmljZSBmYWN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmVsPEhUTUxTcGFuRWxlbWVudD4oJ2J1aWxkaW5nTmFtZScpLnRleHRDb250ZW50ID0gQlVJTERJTkcubmFtZTtcblxuZm9yIChjb25zdCBmbG9vciBvZiBGTE9PUlMpIHtcbiAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICBvcHRpb24udmFsdWUgPSBTdHJpbmcoZmxvb3IuaWQpO1xuICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IGZsb29yLmxhYmVsO1xuICAgIGZpZWxkcy5mbG9vcklkLmFwcGVuZChvcHRpb24pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgd2Vla2RheSBjaGlwcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmNvbnN0IGRheXNIb3N0ID0gZWw8SFRNTERpdkVsZW1lbnQ+KCdkYXlzJyk7XG5mb3IgKGNvbnN0IGRheSBvZiBEQVlTKSB7XG4gICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpO1xuICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XG4gICAgYm94LnR5cGUgPSAnY2hlY2tib3gnO1xuICAgIGJveC52YWx1ZSA9IGRheTtcbiAgICBib3guZGF0YXNldC5kYXkgPSBkYXk7XG4gICAgbGFiZWwuYXBwZW5kKGJveCwgZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoZGF5LnNsaWNlKDAsIDMpKSk7XG4gICAgZGF5c0hvc3QuYXBwZW5kKGxhYmVsKTtcbn1cblxuZnVuY3Rpb24gc2VsZWN0ZWREYXlzKCk6IFdlZWtkYXlbXSB7XG4gICAgcmV0dXJuIFsuLi5kYXlzSG9zdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQ+KCdpbnB1dDpjaGVja2VkJyldXG4gICAgICAgIC5tYXAoKGJveCkgPT4gYm94LnZhbHVlIGFzIFdlZWtkYXkpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgc3RhdGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBTZXR0aW5ncyBhdXRvLXNhdmUsIHNvIHRoaXMgaXMgdGhlIGxpdmUgY29weSByYXRoZXIgdGhhbiBhIHNuYXBzaG90IHRha2VuIGF0XG4vLyBsb2FkLiBza2lwRGF0ZXMgaW4gcGFydGljdWxhciBpcyBtdXRhdGVkIGJ5IGNsaWNraW5nIHRoZSBjYWxlbmRhci5cbmxldCBjdXJyZW50OiBTZXR0aW5ncyA9IGF3YWl0IGxvYWRTZXR0aW5ncygpO1xuXG4vKipcbiAqIFRoZSBtb3N0IHJlY2VudCBydW4sIHNvIHRoZSBjYWxlbmRhciBjYW4gc2hvdyB3aGF0IHdhcyBhY3R1YWxseSBmb3VuZCByYXRoZXJcbiAqIHRoYW4gb25seSB3aGF0IGlzIHBsYW5uZWQuIENvbWVzIGZyb20gc3RvcmFnZSBvbiBvcGVuIGFuZCBpcyByZXBsYWNlZCBhZnRlclxuICogZXZlcnkgcnVuLlxuICovXG5sZXQgbGFzdExvZzogUnVuTG9nIHwgdW5kZWZpbmVkO1xuXG5mdW5jdGlvbiByZW5kZXJTZXR0aW5ncyhuZXh0OiBTZXR0aW5ncyk6IHZvaWQge1xuICAgIGZpZWxkcy5lbmFibGVkLmNoZWNrZWQgPSBuZXh0LmVuYWJsZWQ7XG4gICAgZmllbGRzLmRlc2tOYW1lLnZhbHVlID0gbmV4dC5kZXNrTmFtZTtcbiAgICBmaWVsZHMuZGVza0lkLnZhbHVlID0gbmV4dC5kZXNrSWQ7XG4gICAgZmllbGRzLmZsb29ySWQudmFsdWUgPSBTdHJpbmcobmV4dC5mbG9vcklkKTtcbiAgICBmaWVsZHMuc2xvdC52YWx1ZSA9IG5leHQuc2xvdDtcbiAgICBmaWVsZHMuaG9yaXpvbkRheXMudmFsdWUgPSBTdHJpbmcobmV4dC5ob3Jpem9uRGF5cyk7XG4gICAgZmllbGRzLnRpbWVab25lLnZhbHVlID0gbmV4dC50aW1lWm9uZTtcbiAgICBmaWVsZHMuZW5kcG9pbnQudmFsdWUgPSBKU09OLnN0cmluZ2lmeShuZXh0LmVuZHBvaW50LCBudWxsLCAyKTtcbiAgICBlbDxIVE1MU3BhbkVsZW1lbnQ+KCd0aW1lWm9uZUxhYmVsJykudGV4dENvbnRlbnQgPSBuZXh0LnRpbWVab25lO1xuICAgIGZvciAoY29uc3QgYm94IG9mIGRheXNIb3N0LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oJ2lucHV0JykpIHtcbiAgICAgICAgYm94LmNoZWNrZWQgPSBuZXh0LndlZWtkYXlzLmluY2x1ZGVzKGJveC52YWx1ZSBhcyBXZWVrZGF5KTtcbiAgICB9XG59XG5cbi8qKlxuICogUmVhZCB0aGUgZm9ybSBiYWNrIGludG8gYSBTZXR0aW5ncy5cbiAqXG4gKiBUaGUgZW5kcG9pbnQgdGV4dGFyZWEgaXMgdGhlIG9uZSBmaWVsZCB0aGF0IGNhbiBiZSBtaWQtZWRpdCBhbmQgdW5wYXJzZWFibGUuXG4gKiBBdXRvLXNhdmUgcnVucyBvbiBldmVyeSBrZXlzdHJva2UsIHNvIGEgaGFsZi10eXBlZCBicmFjZSBtdXN0IG5vdCB0aHJvdyBhd2F5XG4gKiB0aGUgd29ya2luZyBjb25maWc6IHRoZSBsYXN0IGdvb2QgdmFsdWUgaXMga2VwdCBhbmQgdGhlIGNhbGxlciBpcyB0b2xkLlxuICovXG5mdW5jdGlvbiBjb2xsZWN0KCk6IHsgc2V0dGluZ3M6IFNldHRpbmdzOyBlbmRwb2ludEVycm9yPzogc3RyaW5nIH0ge1xuICAgIGxldCBlbmRwb2ludDogRW5kcG9pbnRDb25maWcgPSBjdXJyZW50LmVuZHBvaW50O1xuICAgIGxldCBlbmRwb2ludEVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgICAgZW5kcG9pbnQgPSBKU09OLnBhcnNlKGZpZWxkcy5lbmRwb2ludC52YWx1ZSkgYXMgRW5kcG9pbnRDb25maWc7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGVuZHBvaW50RXJyb3IgPSBgRW5kcG9pbnQgY29uZmlnIGlzIG5vdCB2YWxpZCBKU09OOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YDtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBzZXR0aW5nczoge1xuICAgICAgICAgICAgLy8gU2F2aW5nIHN0YW1wcyB0aGUgdmVyc2lvbiB0aGUgdXNlciBoYXMgYWN0dWFsbHkgc2Vlbiwgc28gYSBsYXRlclxuICAgICAgICAgICAgLy8gYnVpbGQgd2l0aCBhIGNvcnJlY3RlZCBjb250cmFjdCBzdGlsbCBzdXBlcnNlZGVzIHRoaXMuXG4gICAgICAgICAgICBlbmRwb2ludFZlcnNpb246IGN1cnJlbnQuZW5kcG9pbnRWZXJzaW9uLFxuICAgICAgICAgICAgZW5hYmxlZDogZmllbGRzLmVuYWJsZWQuY2hlY2tlZCxcbiAgICAgICAgICAgICAgICBkZXNrTmFtZTogZmllbGRzLmRlc2tOYW1lLnZhbHVlLnRyaW0oKSxcbiAgICAgICAgICAgIGRlc2tJZDogZmllbGRzLmRlc2tJZC52YWx1ZS50cmltKCksXG4gICAgICAgICAgICBmbG9vcklkOiBOdW1iZXIoZmllbGRzLmZsb29ySWQudmFsdWUpIHx8IERFRkFVTFRfU0VUVElOR1MuZmxvb3JJZCxcbiAgICAgICAgICAgIC8vIEZpeGVkOiB0aGVyZSBpcyBvbmUgYnVpbGRpbmcsIGFuZCBpdCBpcyBzaG93biBhcyB0ZXh0LCBub3QgZWRpdGVkLlxuICAgICAgICAgICAgYnVpbGRpbmdJZDogQlVJTERJTkcuaWQsXG4gICAgICAgICAgICB3ZWVrZGF5czogc2VsZWN0ZWREYXlzKCksXG4gICAgICAgICAgICBzbG90OiBmaWVsZHMuc2xvdC52YWx1ZSBhcyBTbG90LFxuICAgICAgICAgICAgaG9yaXpvbkRheXM6IE51bWJlcihmaWVsZHMuaG9yaXpvbkRheXMudmFsdWUpIHx8IERFRkFVTFRfU0VUVElOR1MuaG9yaXpvbkRheXMsXG4gICAgICAgICAgICAvLyBPd25lZCBieSB0aGUgY2FsZW5kYXIsIG5vdCBieSBhbnkgZm9ybSBmaWVsZC4gUHJ1bmVkIG9uIGV2ZXJ5XG4gICAgICAgICAgICAvLyBzYXZlIHNvIG1vbnRocyBvZiBwYXN0IGVudHJpZXMgZG8gbm90IHBpbGUgdXAuXG4gICAgICAgICAgICBjYW5jZWxEYXRlczogcHJ1bmVQYXN0U2tpcERhdGVzKFxuICAgICAgICAgICAgICAgIGN1cnJlbnQuY2FuY2VsRGF0ZXMsXG4gICAgICAgICAgICAgICAgdG9Mb2NhbElTT0RhdGUobmV3IERhdGUoKSwgZmllbGRzLnRpbWVab25lLnZhbHVlLnRyaW0oKSB8fCBERUZBVUxUX1NFVFRJTkdTLnRpbWVab25lKSxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICBza2lwRGF0ZXM6IHBydW5lUGFzdFNraXBEYXRlcyhcbiAgICAgICAgICAgICAgICBjdXJyZW50LnNraXBEYXRlcyxcbiAgICAgICAgICAgICAgICB0b0xvY2FsSVNPRGF0ZShuZXcgRGF0ZSgpLCBmaWVsZHMudGltZVpvbmUudmFsdWUudHJpbSgpIHx8IERFRkFVTFRfU0VUVElOR1MudGltZVpvbmUpLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIHRpbWVab25lOiBmaWVsZHMudGltZVpvbmUudmFsdWUudHJpbSgpIHx8IERFRkFVTFRfU0VUVElOR1MudGltZVpvbmUsXG4gICAgICAgICAgICBlbmRwb2ludCxcbiAgICAgICAgfSxcbiAgICAgICAgZW5kcG9pbnRFcnJvcixcbiAgICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgdGhlIGJvb2tpbmcgcGxhbiBjYWxlbmRhciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgcGFkID0gKHZhbHVlOiBudW1iZXIpOiBzdHJpbmcgPT4gU3RyaW5nKHZhbHVlKS5wYWRTdGFydCgyLCAnMCcpO1xuY29uc3QgaXNvRm9yID0gKHllYXI6IG51bWJlciwgbW9udGg6IG51bWJlciwgZGF5OiBudW1iZXIpOiBzdHJpbmcgPT5cbiAgICBgJHt5ZWFyfS0ke3BhZChtb250aCArIDEpfS0ke3BhZChkYXkpfWA7XG5cbi8qKlxuICogVHdvIG1vbnRocyBvZiBkYXlzLCB3aXRoIHRoZSBvbmVzIHRoYXQgd2lsbCBhY3R1YWxseSBiZSBib29rZWQgaGlnaGxpZ2h0ZWQuXG4gKlxuICogVGhpcyBpcyB0aGUgYW5zd2VyIHRvIFwid2hhdCBpcyB0aGlzIGdvaW5nIHRvIGRvXCIsIHdoaWNoIGlzIHdoeSBpdCBkcmF3cyB0aGVcbiAqIHdob2xlIGhvcml6b24gcmF0aGVyIHRoYW4gb25seSB0aGUgZXhjZXB0aW9ucyB0byBpdC4gQ2xpY2tpbmcgYSBwbGFubmVkIGRheVxuICogbW92ZXMgaXQgaW4gYW5kIG91dCBvZiBza2lwRGF0ZXMuXG4gKi9cbmZ1bmN0aW9uIHJlbmRlclBsYW4oKTogdm9pZCB7XG4gICAgY29uc3QgaG9zdCA9IGVsPEhUTUxEaXZFbGVtZW50PignY2FsZW5kYXInKTtcbiAgICBob3N0LnRleHRDb250ZW50ID0gJyc7XG5cbiAgICBjb25zdCB0b2RheSA9IHRvTG9jYWxJU09EYXRlKG5ldyBEYXRlKCksIGN1cnJlbnQudGltZVpvbmUpO1xuICAgIGNvbnN0IFt0b2RheVllYXIsIHRvZGF5TW9udGhdID0gdG9kYXkuc3BsaXQoJy0nKS5tYXAoTnVtYmVyKSBhcyBbbnVtYmVyLCBudW1iZXIsIG51bWJlcl07XG5cbiAgICAvLyBDYW5kaWRhdGVzIGlnbm9yaW5nIHNraXBEYXRlcywgc28gYSBza2lwcGVkIGRheSBpcyBzdGlsbCBkcmF3biBhcyBvbmUgb2ZcbiAgICAvLyB0aGUgcGxhbm5lZCBkYXlzIHJhdGhlciB0aGFuIHZhbmlzaGluZyBpbnRvIHRoZSBiYWNrZ3JvdW5kLlxuICAgIGxldCBjYW5kaWRhdGVzOiBTZXQ8c3RyaW5nPjtcbiAgICB0cnkge1xuICAgICAgICBjYW5kaWRhdGVzID0gbmV3IFNldChkYXRlc1RvQm9vayh7XG4gICAgICAgICAgICB3ZWVrZGF5czogY3VycmVudC53ZWVrZGF5cyxcbiAgICAgICAgICAgIGhvcml6b25EYXlzOiBjdXJyZW50Lmhvcml6b25EYXlzLFxuICAgICAgICAgICAgc2tpcERhdGVzOiBbXSxcbiAgICAgICAgICAgIHRpbWVab25lOiBjdXJyZW50LnRpbWVab25lLFxuICAgICAgICB9KSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIGNhbmRpZGF0ZXMgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgLy8gV2hldGhlciBhIGRhdGUgaXMgYSB3ZWVrZGF5IHlvdSBjb21lIGluLCBpZ25vcmluZyB0aGUgaG9yaXpvbiBlbnRpcmVseS5cbiAgICAvLyBLbm93aW5nIGluIFNlcHRlbWJlciB0aGF0IHlvdSBhcmUgYXdheSBpbiBPY3RvYmVyIGlzIG5vcm1hbDsgdGhlIGhvcml6b25cbiAgICAvLyBnb3Zlcm5zIHdoYXQgZ2V0cyBib29rZWQsIGFuZCBoYXMgbm8gYnVzaW5lc3MgZ292ZXJuaW5nIHdoYXQgeW91IGFyZVxuICAgIC8vIGFsbG93ZWQgdG8gdGVsbCBpdCBpbiBhZHZhbmNlLlxuICAgIGNvbnN0IGNob3NlbldlZWtkYXlzID0gbmV3IFNldChjdXJyZW50LndlZWtkYXlzKTtcbiAgICBjb25zdCBpc1dvcmtkYXkgPSAoaXNvOiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIE1pZGRheSBhdm9pZHMgYW55IGNoYW5jZSBvZiB0aGUgcGFyc2VkIGluc3RhbnQgbGFuZGluZyBvbiB0aGVcbiAgICAgICAgICAgIC8vIHByZXZpb3VzIGRheSBvbmNlIHNoaWZ0ZWQgaW50byB0aGUgdGFyZ2V0IHpvbmUuXG4gICAgICAgICAgICByZXR1cm4gY2hvc2VuV2Vla2RheXMuaGFzKGxvY2FsV2Vla2RheShuZXcgRGF0ZShgJHtpc299VDEyOjAwOjAwWmApLCBjdXJyZW50LnRpbWVab25lKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgfTtcbiAgICBjb25zdCBza2lwcGVkID0gbmV3IFNldChjdXJyZW50LnNraXBEYXRlcyk7XG4gICAgY29uc3QgbWFya2VkRm9yQ2FuY2VsID0gbmV3IFNldChjdXJyZW50LmNhbmNlbERhdGVzKTtcblxuICAgIC8vIFRoZSBydW4gZHJvcHMgYSBkYXkgd2hvc2Ugc2xvdCBoYXMgYWxyZWFkeSBzdGFydGVkLCBzbyB0aGUgcGxhbiBtdXN0IG5vdFxuICAgIC8vIGtlZXAgZHJhd2luZyBpdCBhcyBhIGRheSB0aGF0IHdpbGwgYmUgYm9va2VkLiBTYW1lIHJ1bGUsIHNhbWUgc291cmNlLFxuICAgIC8vIHJhdGhlciB0aGFuIHR3byBwbGFjZXMgZGVjaWRpbmcgc2VwYXJhdGVseSB3aGF0IHRvZGF5IG1lYW5zLlxuICAgIGNvbnN0IHNsb3RTdGFydCA9IFNMT1RfVElNRVNbY3VycmVudC5zbG90XS5zdGFydDtcblxuICAgIC8vIFdoYXQgdGhlIGxhc3QgcnVuIGZvdW5kLCBieSBkYXRlLiBgYm9va2VkYCBhbmQgYHNraXBwZWRgIGJvdGggbWVhbiBcInlvdVxuICAgIC8vIGhvbGQgdGhhdCBkYXlcIiBcdTIwMTQgb25lIGp1c3QgaGFwcGVuZWQgbm93IGFuZCB0aGUgb3RoZXIgZWFybGllci5cbiAgICBjb25zdCBvdXRjb21lID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IHJvdyBvZiBsYXN0TG9nPy5yb3dzID8/IFtdKSB7XG4gICAgICAgIGlmIChyb3cuc3RhdHVzID09PSAnYm9va2VkJyB8fCByb3cuc3RhdHVzID09PSAnc2tpcHBlZCcpIG91dGNvbWUuc2V0KHJvdy5kYXRlLCAnaGF2ZScpO1xuICAgICAgICBlbHNlIGlmIChyb3cuc3RhdHVzID09PSAndW5hdmFpbGFibGUnKSBvdXRjb21lLnNldChyb3cuZGF0ZSwgJ3Rha2VuJyk7XG4gICAgICAgIGVsc2UgaWYgKHJvdy5zdGF0dXMgPT09ICdlcnJvcicpIG91dGNvbWUuc2V0KHJvdy5kYXRlLCAnZmFpbGVkJyk7XG4gICAgfVxuXG4gICAgLy8gQSBydW4gZnJvbSBkYXlzIGFnbyBjYW4gc3RpbGwgYmUgc2hvd2luZyBncmVlbiBmb3IgZGF5cyB0aGF0IGhhdmUgc2luY2VcbiAgICAvLyBiZWVuIGdpdmVuIGF3YXksIHNvIHRoZSBwbGFuIHNheXMgaG93IG9sZCBpdCBpcyByYXRoZXIgdGhhbiBpbXBseWluZyBpdFxuICAgIC8vIGlzIGxpdmUuXG4gICAgY29uc3QgYXNPZiA9IGVsPEhUTUxTcGFuRWxlbWVudD4oJ3BsYW5Bc09mJyk7XG4gICAgYXNPZi50ZXh0Q29udGVudCA9IGxhc3RMb2dcbiAgICAgICAgPyBgY29sb3VycyBmcm9tICR7bmV3IERhdGUobGFzdExvZy5hdCkudG9Mb2NhbGVTdHJpbmcoKX0gXHUwMEI3IGNsaWNrIGEgZGF5IHRvIHNraXAgaXRgXG4gICAgICAgIDogJ2NsaWNrIGEgZGF5IHRvIHNraXAgaXQnO1xuXG4gICAgZm9yIChsZXQgb2Zmc2V0ID0gMDsgb2Zmc2V0IDwgMjsgb2Zmc2V0ICs9IDEpIHtcbiAgICAgICAgY29uc3QgbW9udGggPSB0b2RheU1vbnRoIC0gMSArIG9mZnNldDtcbiAgICAgICAgY29uc3QgeWVhciA9IHRvZGF5WWVhciArIE1hdGguZmxvb3IobW9udGggLyAxMik7XG4gICAgICAgIGNvbnN0IG5vcm1hbGlzZWQgPSAoKG1vbnRoICUgMTIpICsgMTIpICUgMTI7XG5cbiAgICAgICAgY29uc3QgYmxvY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgYmxvY2suY2xhc3NOYW1lID0gJ21vbnRoJztcblxuICAgICAgICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIG5hbWUuY2xhc3NOYW1lID0gJ21vbnRoLW5hbWUnO1xuICAgICAgICBuYW1lLnRleHRDb250ZW50ID0gbmV3IERhdGUoRGF0ZS5VVEMoeWVhciwgbm9ybWFsaXNlZCwgMSkpXG4gICAgICAgICAgICAudG9Mb2NhbGVEYXRlU3RyaW5nKHVuZGVmaW5lZCwgeyBtb250aDogJ2xvbmcnLCB5ZWFyOiAnbnVtZXJpYycsIHRpbWVab25lOiAnVVRDJyB9KTtcbiAgICAgICAgYmxvY2suYXBwZW5kKG5hbWUpO1xuXG4gICAgICAgIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgZ3JpZC5jbGFzc05hbWUgPSAnZ3JpZCc7XG4gICAgICAgIGZvciAoY29uc3QgbGFiZWwgb2YgRE9XX0xBQkVMUykge1xuICAgICAgICAgICAgY29uc3QgaGVhZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICAgICAgaGVhZC5jbGFzc05hbWUgPSAnZG93JztcbiAgICAgICAgICAgIGhlYWQudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgICAgICAgIGdyaWQuYXBwZW5kKGhlYWQpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZmlyc3REYXlPZldlZWsgPSBuZXcgRGF0ZShEYXRlLlVUQyh5ZWFyLCBub3JtYWxpc2VkLCAxKSkuZ2V0VVRDRGF5KCk7XG4gICAgICAgIC8vIGdldFVUQ0RheSBpcyBTdW5kYXktZmlyc3Q7IHRoZSBncmlkIGlzIE1vbmRheS1maXJzdC5cbiAgICAgICAgY29uc3QgbGVhZCA9IChmaXJzdERheU9mV2VlayArIDYpICUgNztcbiAgICAgICAgZm9yIChsZXQgYmxhbmsgPSAwOyBibGFuayA8IGxlYWQ7IGJsYW5rICs9IDEpIGdyaWQuYXBwZW5kKGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpKTtcblxuICAgICAgICBjb25zdCBkYXlzSW5Nb250aCA9IG5ldyBEYXRlKERhdGUuVVRDKHllYXIsIG5vcm1hbGlzZWQgKyAxLCAwKSkuZ2V0VVRDRGF0ZSgpO1xuICAgICAgICBmb3IgKGxldCBkYXkgPSAxOyBkYXkgPD0gZGF5c0luTW9udGg7IGRheSArPSAxKSB7XG4gICAgICAgICAgICBjb25zdCBpc28gPSBpc29Gb3IoeWVhciwgbm9ybWFsaXNlZCwgZGF5KTtcbiAgICAgICAgICAgIGNvbnN0IGNlbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgICAgIGNlbGwuY2xhc3NOYW1lID0gJ2RheSc7XG4gICAgICAgICAgICBjZWxsLnRleHRDb250ZW50ID0gU3RyaW5nKGRheSk7XG4gICAgICAgICAgICBjZWxsLnR5cGUgPSAnYnV0dG9uJztcblxuICAgICAgICAgICAgaWYgKGlzbyA8IHRvZGF5KSBjZWxsLmNsYXNzTGlzdC5hZGQoJ3Bhc3QnKTtcbiAgICAgICAgICAgIGlmIChpc28gPT09IHRvZGF5KSBjZWxsLmNsYXNzTGlzdC5hZGQoJ3RvZGF5Jyk7XG5cbiAgICAgICAgICAgIGNvbnN0IHBsYW5uZWQgPSBjYW5kaWRhdGVzLmhhcyhpc28pO1xuICAgICAgICAgICAgY29uc3QgbWFya2FibGUgPSBwbGFubmVkIHx8IChpc28gPj0gdG9kYXkgJiYgaXNXb3JrZGF5KGlzbykpO1xuXG4gICAgICAgICAgICBpZiAobWFya2FibGUpIHtcbiAgICAgICAgICAgICAgICAvLyBUaGUgdXNlcidzIG93biBjaG9pY2UgdG8gc2tpcCBvdXRyYW5rcyBhbnl0aGluZyBhIHJ1biBmb3VuZDpcbiAgICAgICAgICAgICAgICAvLyBpdCBpcyBhbiBpbnN0cnVjdGlvbiwgbm90IGFuIG9ic2VydmF0aW9uLlxuICAgICAgICAgICAgICAgIC8vIENhbmNlbGxhdGlvbiBpcyB0aGUgc3Ryb25nZXN0IHN0YXRlbWVudCBhYm91dCBhIGRheSwgc28gaXRcbiAgICAgICAgICAgICAgICAvLyB3aW5zIHRoZSBkaXNwbGF5OiBpdCBpcyBib3RoIGFuIGluc3RydWN0aW9uIGFuZCBkZXN0cnVjdGl2ZSxcbiAgICAgICAgICAgICAgICAvLyBhbmQgbXVzdCBub3QgYmUgaGlkZGVuIGJlaGluZCBhIFwic2tpcHBlZFwiIHN0eWxlLlxuICAgICAgICAgICAgICAgIC8vIFJhbmtlZCwgbW9zdCBlbXBoYXRpYyBmaXJzdC4gYGxhdGVgIHNpdHMgYmVsb3cgYW55dGhpbmcgdGhlXG4gICAgICAgICAgICAgICAgLy8gbGFzdCBydW4gZm91bmQ6IGEgZGF5IHlvdSBhbHJlYWR5IGhvbGQgaXMgd29ydGggc2hvd2luZyBhc1xuICAgICAgICAgICAgICAgIC8vIGhlbGQgZXZlbiBvbmNlIGl0cyBzbG90IGhhcyBzdGFydGVkLlxuICAgICAgICAgICAgICAgIGNvbnN0IHRvb0xhdGUgPSBwbGFubmVkICYmIGhhc1Nsb3RTdGFydGVkKGlzbywgc2xvdFN0YXJ0LCBjdXJyZW50LnRpbWVab25lKTtcbiAgICAgICAgICAgICAgICBjb25zdCBzdGF0ZSA9IG1hcmtlZEZvckNhbmNlbC5oYXMoaXNvKVxuICAgICAgICAgICAgICAgICAgICA/ICdjYW5jZWwnXG4gICAgICAgICAgICAgICAgICAgIDogc2tpcHBlZC5oYXMoaXNvKVxuICAgICAgICAgICAgICAgICAgICAgICAgPyAnc2tpcCdcbiAgICAgICAgICAgICAgICAgICAgICAgIDogb3V0Y29tZS5nZXQoaXNvKSA/PyAodG9vTGF0ZSA/ICdsYXRlJyA6IHBsYW5uZWQgPyAnYm9vaycgOiAnbGF0ZXInKTtcbiAgICAgICAgICAgICAgICAvLyBOb3RoaW5nIHRvIGRlY2lkZSBhYm91dCBhIGRheSB0aGF0IGNhbm5vdCBiZSBib29rZWQgZWl0aGVyXG4gICAgICAgICAgICAgICAgLy8gd2F5LCBzbyBpdCBkb2VzIG5vdCBpbnZpdGUgYSBjbGljay5cbiAgICAgICAgICAgICAgICBjZWxsLmNsYXNzTGlzdC5hZGQoc3RhdGUpO1xuICAgICAgICAgICAgICAgIGlmIChzdGF0ZSAhPT0gJ2xhdGUnKSBjZWxsLmNsYXNzTGlzdC5hZGQoJ2NsaWNrYWJsZScpO1xuICAgICAgICAgICAgICAgIGNlbGwudGl0bGUgPSB7XG4gICAgICAgICAgICAgICAgICAgIHNraXA6ICdTa2lwcGVkIFx1MjAxNCBjbGljayB0byBib29rIGl0JyxcbiAgICAgICAgICAgICAgICAgICAgaGF2ZTogJ1lvdSBhbHJlYWR5IGhhdmUgdGhpcyBkYXkuIENsaWNraW5nIHN0b3BzIGZ1dHVyZSBydW5zIHJlLWJvb2tpbmcgaXQ7ICdcbiAgICAgICAgICAgICAgICAgICAgICAgICsgJ2l0IGRvZXMgbm90IGNhbmNlbCB0aGUgYm9va2luZyBpbiBDb21lZW4uJyxcbiAgICAgICAgICAgICAgICAgICAgdGFrZW46ICdTb21lb25lIGVsc2UgaGFzIHRoaXMgZGVzayB0aGF0IGRheS4gQ2xpY2tpbmcgc3RvcHMgaXQgYmVpbmcgcmV0cmllZC4nLFxuICAgICAgICAgICAgICAgICAgICBmYWlsZWQ6ICdUaGUgbGFzdCBhdHRlbXB0IGZhaWxlZCBvbiB0aGlzIGRheS4gT3BlbiBMYXN0IHJ1biBmb3IgdGhlIHJlYXNvbi4nLFxuICAgICAgICAgICAgICAgICAgICBib29rOiAnQ2xpY2sgdG8gc2tpcCcsXG4gICAgICAgICAgICAgICAgICAgIGxhdGVyOiAnQmV5b25kIHRoZSBib29raW5nIHdpbmRvdyBmb3Igbm93LiBDbGljayB0byBza2lwIGl0IGluIGFkdmFuY2UgXHUyMDE0IGl0ICdcbiAgICAgICAgICAgICAgICAgICAgICAgICsgJ3dpbGwgYmUgcmVtZW1iZXJlZCB3aGVuIHRoZSB3aW5kb3cgcmVhY2hlcyBpdC4nLFxuICAgICAgICAgICAgICAgICAgICBjYW5jZWw6ICdXaWxsIGJlIGNhbmNlbGxlZCBpbiBDb21lZW4gb24gdGhlIG5leHQgcnVuLiBDbGljayB0byBrZWVwIGl0LicsXG4gICAgICAgICAgICAgICAgICAgIGxhdGU6IGBUb28gbGF0ZSBcdTIwMTQgdGhlICR7Y3VycmVudC5zbG90LnJlcGxhY2UoJ18nLCAnICcpfSBzbG90IGhhcyBhbHJlYWR5IGBcbiAgICAgICAgICAgICAgICAgICAgICAgICsgJ3N0YXJ0ZWQsIGFuZCBDb21lZW4gcmVmdXNlcyBhIGJvb2tpbmcgd2hvc2Ugc3RhcnQgdGltZSBoYXMgcGFzc2VkLiAnXG4gICAgICAgICAgICAgICAgICAgICAgICArICdCb29rIGl0IGJ5IGhhbmQgaWYgeW91IHN0aWxsIG5lZWQgaXQuJyxcbiAgICAgICAgICAgICAgICB9W3N0YXRlXSA/PyAnQ2xpY2sgdG8gc2tpcCc7XG4gICAgICAgICAgICAgICAgaWYgKHN0YXRlID09PSAnbGF0ZScpIHtcbiAgICAgICAgICAgICAgICAgICAgZ3JpZC5hcHBlbmQoY2VsbCk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNlbGwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdGF0ZSA9PT0gJ2NhbmNlbCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFVuZG86IHN0b3AgY2FuY2VsbGluZywgYW5kIHN0b3Agc2tpcHBpbmcsIHNpbmNlIHRoZVxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gc2tpcCB3YXMgb25seSBldmVyIHRoZXJlIHRvIHByb3RlY3QgdGhlIGNhbmNlbGxhdGlvbi5cbiAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnQuY2FuY2VsRGF0ZXMgPSBjdXJyZW50LmNhbmNlbERhdGVzLmZpbHRlcigoZW50cnkpID0+IGVudHJ5ICE9PSBpc28pO1xuICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudC5za2lwRGF0ZXMgPSBjdXJyZW50LnNraXBEYXRlcy5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeSAhPT0gaXNvKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzdGF0ZSA9PT0gJ2hhdmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBZb3UgaG9sZCB0aGlzIGRheSwgc28gdGhlIHVzZWZ1bCBhY3Rpb24gaXMgdG8gZ2l2ZSBpdFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gdXAgcmF0aGVyIHRoYW4gbWVyZWx5IHRvIHN0b3AgcmUtYm9va2luZyBpdC4gU2tpcHBpbmdcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGFzIHdlbGwgaXMgbm90IG9wdGlvbmFsOiB3aXRob3V0IGl0LCB0aGUgdmVyeSBuZXh0IHJ1blxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gd291bGQgYm9vayBzdHJhaWdodCBiYWNrIHdoYXQgdGhpcyBvbmUgY2FuY2VsbGVkLlxuICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudC5jYW5jZWxEYXRlcyA9IFsuLi5jdXJyZW50LmNhbmNlbERhdGVzLCBpc29dLnNvcnQoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnQuc2tpcERhdGVzID0gWy4uLm5ldyBTZXQoWy4uLmN1cnJlbnQuc2tpcERhdGVzLCBpc29dKV0uc29ydCgpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudC5za2lwRGF0ZXMgPSBza2lwcGVkLmhhcyhpc28pXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBjdXJyZW50LnNraXBEYXRlcy5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeSAhPT0gaXNvKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogWy4uLmN1cnJlbnQuc2tpcERhdGVzLCBpc29dLnNvcnQoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZW5kZXJQbGFuKCk7XG4gICAgICAgICAgICAgICAgICAgIHF1ZXVlU2F2ZSgpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBncmlkLmFwcGVuZChjZWxsKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGJsb2NrLmFwcGVuZChncmlkKTtcbiAgICAgICAgaG9zdC5hcHBlbmQoYmxvY2spO1xuICAgIH1cbn1cblxuLyoqXG4gKiBTaG93IHdoZXRoZXIgdGhlIGRlc2sgbmFtZSBpcyB1c2FibGUsIGFuZCBzdG9wIHRoZSBidXR0b25zIGlmIGl0IGlzIG5vdC5cbiAqXG4gKiBUaHJlZSBzdGF0ZXMgcmF0aGVyIHRoYW4gdHdvOiBlbXB0eSBpcyBub3QgYW4gZXJyb3IsIGl0IGlzIHRoZSBzdGFydGluZ1xuICogcG9pbnQsIHNvIGl0IGdldHMgYSBwbGFpbiBoaW50LiBPbmx5IHNvbWV0aGluZyB0eXBlZCBhbmQgd3JvbmcgdHVybnMgcmVkLlxuICogU2NvbGRpbmcgc29tZW9uZSBmb3Igbm90IGhhdmluZyBmaWxsZWQgYSBmaWVsZCBpbiB5ZXQgaXMgaG93IGEgc2V0dXAgc2NyZWVuXG4gKiBtYWtlcyBwZW9wbGUgZmVlbCBzdHVwaWQuXG4gKi9cbmZ1bmN0aW9uIHJlbmRlckRlc2tTdGF0ZSgpOiB2b2lkIHtcbiAgICBjb25zdCByYXcgPSBmaWVsZHMuZGVza05hbWUudmFsdWUudHJpbSgpO1xuICAgIGNvbnN0IG5vdGUgPSBlbDxIVE1MUGFyYWdyYXBoRWxlbWVudD4oJ2Rlc2tOb3RlJyk7XG4gICAgY29uc3QgdmFsaWQgPSBpc1ZhbGlkRGVza05hbWUocmF3KTtcblxuICAgIGlmIChyYXcgPT09ICcnKSB7XG4gICAgICAgIG5vdGUudGV4dENvbnRlbnQgPSAnUGljayB5b3VyIGRlc2sgZmlyc3QgXHUyMDE0IHRoZSBudW1iZXIgcHJpbnRlZCBvbiBpdCwgbGlrZSAzLTIzLic7XG4gICAgICAgIG5vdGUuY2xhc3NMaXN0LnJlbW92ZSgnYmFkJyk7XG4gICAgICAgIGZpZWxkcy5kZXNrTmFtZS5jbGFzc0xpc3QucmVtb3ZlKCdiYWQnKTtcbiAgICB9IGVsc2UgaWYgKHZhbGlkKSB7XG4gICAgICAgIG5vdGUudGV4dENvbnRlbnQgPSAnTG9va2VkIHVwIGJ5IG5hbWUgb24gZXZlcnkgcnVuLCBzbyB0aGUgSUQgc3RheXMgZW1wdHkuJztcbiAgICAgICAgbm90ZS5jbGFzc0xpc3QucmVtb3ZlKCdiYWQnKTtcbiAgICAgICAgZmllbGRzLmRlc2tOYW1lLmNsYXNzTGlzdC5yZW1vdmUoJ2JhZCcpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIG5vdGUudGV4dENvbnRlbnQgPSBgXCIke3Jhd31cIiBpcyBub3QgYSBkZXNrIG51bWJlci4gSXQgc2hvdWxkIGJlIGRpZ2l0cywgYSBkYXNoLCBkaWdpdHMgXHUyMDE0IGxpa2UgMy0yMy5gO1xuICAgICAgICBub3RlLmNsYXNzTGlzdC5hZGQoJ2JhZCcpO1xuICAgICAgICBmaWVsZHMuZGVza05hbWUuY2xhc3NMaXN0LmFkZCgnYmFkJyk7XG4gICAgfVxuXG4gICAgLy8gQSBkZXNrIElEIHNldCBieSBoYW5kIGluIEFkdmFuY2VkIGlzIGEgZGVsaWJlcmF0ZSBvdmVycmlkZSwgYW5kIHN0YW5kcyBpblxuICAgIC8vIGZvciB0aGUgbmFtZS5cbiAgICBjb25zdCBydW5uYWJsZSA9IHZhbGlkIHx8IGZpZWxkcy5kZXNrSWQudmFsdWUudHJpbSgpICE9PSAnJztcbiAgICBmb3IgKGNvbnN0IGlkIG9mIFsncnVuTm93JywgJ2RyeVJ1biddKSB7XG4gICAgICAgIGVsPEhUTUxCdXR0b25FbGVtZW50PihpZCkuZGlzYWJsZWQgPSAhcnVubmFibGU7XG4gICAgfVxufVxuXG5mdW5jdGlvbiByZW5kZXJBdXRvTm90ZSgpOiB2b2lkIHtcbiAgICBjb25zdCBub3RlID0gZWw8SFRNTFBhcmFncmFwaEVsZW1lbnQ+KCdhdXRvTm90ZScpO1xuICAgIG5vdGUudGV4dENvbnRlbnQgPSBjdXJyZW50LmVuYWJsZWRcbiAgICAgICAgPyBgT24uIENoZWNrcyBldmVyeSA2IGhvdXJzIGFuZCBib29rcyBhbnkgbWlzc2luZyBkYXkgaW4gdGhlIG5leHQgJHtjdXJyZW50Lmhvcml6b25EYXlzfSBgXG4gICAgICAgICAgICArICdkYXlzLiBPbmx5IHJ1bnMgd2hpbGUgQ2hyb21lIGlzIG9wZW4gXHUyMDE0IGEgY2xvc2VkIGxhcHRvcCBqdXN0IG1lYW5zIGl0IGNhdGNoZXMgdXAgbGF0ZXIuJ1xuICAgICAgICA6ICdPZmYuIE5vdGhpbmcgaXMgYm9va2VkIHVubGVzcyB5b3UgcHJlc3MgQm9vayBub3cuJztcbn1cblxuLy8gXHUyNTAwXHUyNTAwIHNhdmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZmxhc2hTYXZlZCh0ZXh0ID0gJ1NhdmVkJyk6IHZvaWQge1xuICAgIGNvbnN0IGZsYWcgPSBlbDxIVE1MU3BhbkVsZW1lbnQ+KCdzYXZlZEZsYWcnKTtcbiAgICBmbGFnLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICBmbGFnLmhpZGRlbiA9IGZhbHNlO1xuICAgIHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHsgZmxhZy5oaWRkZW4gPSB0cnVlOyB9LCAxXzIwMCk7XG59XG5cbmxldCBzYXZlVGltZXI6IG51bWJlciB8IHVuZGVmaW5lZDtcblxuLyoqXG4gKiBUaGVyZSBpcyBubyBTYXZlIGJ1dHRvbjogZXZlcnkgY2hhbmdlIHBlcnNpc3RzIG9uIGl0cyBvd24gYWZ0ZXIgYSBzaG9ydFxuICogcGF1c2UuIFRoZSBwYXVzZSBpcyB3aGF0IGtlZXBzIGEgdHlwZWQgZGVzayBuYW1lIGZyb20gd3JpdGluZyBzdG9yYWdlIG9uY2VcbiAqIHBlciBrZXlzdHJva2UuXG4gKi9cbmZ1bmN0aW9uIHF1ZXVlU2F2ZSgpOiB2b2lkIHtcbiAgICB3aW5kb3cuY2xlYXJUaW1lb3V0KHNhdmVUaW1lcik7XG4gICAgc2F2ZVRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4geyB2b2lkIGNvbW1pdCgpOyB9LCAzMDApO1xufVxuXG4vKiogU2V0IHdoaWxlIHRoaXMgcG9wdXAgd3JpdGVzLCBzbyBpdHMgb3duIHNhdmUgZG9lcyBub3QgYm91bmNlIGJhY2sgYXMgYW4gdXBkYXRlLiAqL1xubGV0IHNhdmluZ0xvY2FsbHkgPSBmYWxzZTtcblxuYXN5bmMgZnVuY3Rpb24gY29tbWl0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHsgc2V0dGluZ3MsIGVuZHBvaW50RXJyb3IgfSA9IGNvbGxlY3QoKTtcbiAgICBjdXJyZW50ID0gc2V0dGluZ3M7XG4gICAgc2F2aW5nTG9jYWxseSA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKHNldHRpbmdzKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICAvLyBDbGVhcmVkIGFmdGVyIHRoZSBldmVudCBsb29wIHR1cm4sIHNvIHRoZSBjaGFuZ2UgZXZlbnQgdGhpcyB3cml0ZVxuICAgICAgICAvLyBwcm9kdWNlcyBpcyBzdGlsbCBzZWVuIGFzIGxvY2FsLlxuICAgICAgICB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7IHNhdmluZ0xvY2FsbHkgPSBmYWxzZTsgfSwgMCk7XG4gICAgfVxuICAgIHJlbmRlclBsYW4oKTtcbiAgICByZW5kZXJBdXRvTm90ZSgpO1xuICAgIHJlbmRlckRlc2tTdGF0ZSgpO1xuICAgIGZsYXNoU2F2ZWQoZW5kcG9pbnRFcnJvciA/ICdFbmRwb2ludCBKU09OIGludmFsaWQgXHUyMDE0IG5vdCBzYXZlZCcgOiAnU2F2ZWQnKTtcbn1cblxuZm9yIChjb25zdCBmaWVsZCBvZiBbXG4gICAgZmllbGRzLmVuYWJsZWQsIGZpZWxkcy5kZXNrTmFtZSwgZmllbGRzLmRlc2tJZCwgZmllbGRzLmZsb29ySWQsXG4gICAgZmllbGRzLnNsb3QsIGZpZWxkcy5ob3Jpem9uRGF5cywgZmllbGRzLnRpbWVab25lLCBmaWVsZHMuZW5kcG9pbnQsXG5dKSB7XG4gICAgZmllbGQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVldWVTYXZlKTtcbiAgICBmaWVsZC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIHF1ZXVlU2F2ZSk7XG59XG5cbi8vIFRoZSBzYXZlIGlzIGRlYm91bmNlZDsgdGhlIHZhbGlkYXRpb24gbXVzdCBub3QgYmUsIG9yIHRoZSBmaWVsZCBzdGF5cyByZWQgZm9yXG4vLyBhIHRoaXJkIG9mIGEgc2Vjb25kIGFmdGVyIHlvdSBoYXZlIGFscmVhZHkgZml4ZWQgaXQuXG5mb3IgKGNvbnN0IGZpZWxkIG9mIFtmaWVsZHMuZGVza05hbWUsIGZpZWxkcy5kZXNrSWRdKSB7XG4gICAgZmllbGQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCByZW5kZXJEZXNrU3RhdGUpO1xufVxuZGF5c0hvc3QuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVldWVTYXZlKTtcblxuLy8gXHUyNTAwXHUyNTAwIHJ1biBsb2cgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHJlbmRlckxvZyhsb2c6IFJ1bkxvZyB8IHVuZGVmaW5lZCk6IHZvaWQge1xuICAgIGNvbnN0IGhvc3QgPSBlbDxIVE1MUHJlRWxlbWVudD4oJ2xvZycpO1xuICAgIGhvc3QudGV4dENvbnRlbnQgPSAnJztcbiAgICBpZiAoIWxvZykge1xuICAgICAgICBob3N0LnRleHRDb250ZW50ID0gJ05vIHJ1bnMgeWV0Lic7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB3aGVuID0gbmV3IERhdGUobG9nLmF0KS50b0xvY2FsZVN0cmluZygpO1xuICAgIGNvbnN0IGhlYWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBoZWFkLnRleHRDb250ZW50ID0gYCR7d2hlbn0ke2xvZy5kcnlSdW4gPyAnICAocHJldmlldyBcdTIwMTQgbm90aGluZyB3YXMgYm9va2VkKScgOiAnJ31gO1xuICAgIGhvc3QuYXBwZW5kKGhlYWQpO1xuXG4gICAgaWYgKGxvZy5lcnJvcikge1xuICAgICAgICBjb25zdCBwcm9ibGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIHByb2JsZW0uY2xhc3NOYW1lID0gJ3N0LWVycm9yJztcbiAgICAgICAgcHJvYmxlbS50ZXh0Q29udGVudCA9IGBlcnJvcjogJHtsb2cuZXJyb3J9YDtcbiAgICAgICAgaG9zdC5hcHBlbmQocHJvYmxlbSk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBub3RlIG9mIGxvZy5ub3Rlcykge1xuICAgICAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIGxpbmUuY2xhc3NOYW1lID0gJ3N0LXNraXBwZWQnO1xuICAgICAgICBsaW5lLnRleHRDb250ZW50ID0gYFx1MDBCNyAke25vdGV9YDtcbiAgICAgICAgaG9zdC5hcHBlbmQobGluZSk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCByb3cgb2YgbG9nLnJvd3MpIHtcbiAgICAgICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBsaW5lLmNsYXNzTmFtZSA9IGBzdC0ke3Jvdy5zdGF0dXN9YDtcbiAgICAgICAgbGluZS50ZXh0Q29udGVudCA9IGAke3Jvdy5kYXRlfSAgJHtyb3cuc3RhdHVzfSR7cm93LmRldGFpbCA/IGAgICR7cm93LmRldGFpbH1gIDogJyd9YDtcbiAgICAgICAgaG9zdC5hcHBlbmQobGluZSk7XG4gICAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiByZW5kZXJDYXB0dXJlcygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IGNhcHR1cmVzID0gW10gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgnY2FwdHVyZXMnKSBhcyB7IGNhcHR1cmVzPzogdW5rbm93bltdIH07XG4gICAgY29uc3QgaG9zdCA9IGVsPEhUTUxQcmVFbGVtZW50PignY2FwdHVyZXMnKTtcbiAgICBpZiAoY2FwdHVyZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGhvc3QudGV4dENvbnRlbnQgPSAnTm90aGluZyByZWNvcmRlZCB5ZXQuJztcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBob3N0LnRleHRDb250ZW50ID0gY2FwdHVyZXMubWFwKChjYXB0dXJlKSA9PiBKU09OLnN0cmluZ2lmeShjYXB0dXJlLCBudWxsLCAxKSkuam9pbignXFxuXFxuJyk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBsb2FkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxucmVuZGVyU2V0dGluZ3MoY3VycmVudCk7XG5yZW5kZXJQbGFuKCk7XG5yZW5kZXJBdXRvTm90ZSgpO1xucmVuZGVyRGVza1N0YXRlKCk7XG5cbmNvbnN0IHsgcnVucyA9IFtdLCBsZWFybk1vZGUgPSBmYWxzZSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFsncnVucycsICdsZWFybk1vZGUnXSkgYXMge1xuICAgIHJ1bnM/OiBSdW5Mb2dbXTtcbiAgICBsZWFybk1vZGU/OiBib29sZWFuO1xufTtcbmZpZWxkcy5sZWFybk1vZGUuY2hlY2tlZCA9IGxlYXJuTW9kZTtcbmxhc3RMb2cgPSBydW5zWzBdO1xucmVuZGVyTG9nKHJ1bnNbMF0pO1xuLy8gVGhlIHBsYW4gd2FzIGRyYXduIGJlZm9yZSB0aGUgbG9nIHdhcyBsb2FkZWQsIHNvIGNvbG91ciBpdCBpbiBub3cuXG5yZW5kZXJQbGFuKCk7XG5cbi8vIE9wZW5pbmcgdGhlIHBvcHVwIGlzIHdoYXQgbWFya3MgYSBmYWlsdXJlIGFzIHJlYWQsIHNvIHRoZSBiYWRnZSBjbGVhcnMgaGVyZVxuLy8gcmF0aGVyIHRoYW4gd2FpdGluZyBmb3IgdGhlIG5leHQgc3VjY2Vzc2Z1bCBydW4uXG52b2lkIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgdHlwZTogJ3BvcHVwLW9wZW5lZCcgfSkuY2F0Y2goKCkgPT4geyAvKiB3b3JrZXIgYXNsZWVwICovIH0pO1xuYXdhaXQgcmVuZGVyQ2FwdHVyZXMoKTtcblxuLy8gXHUyNTAwXHUyNTAwIGFjdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmFzeW5jIGZ1bmN0aW9uIHRyaWdnZXJSdW4oYnV0dG9uOiBIVE1MQnV0dG9uRWxlbWVudCwgZHJ5UnVuOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTtcbiAgICBjb25zdCBvcmlnaW5hbCA9IGJ1dHRvbi50ZXh0Q29udGVudDtcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSBkcnlSdW4gPyAnQ2hlY2tpbmdcdTIwMjYnIDogJ0Jvb2tpbmdcdTIwMjYnO1xuICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGNvbW1pdCgpO1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgdHlwZTogJ3J1bicsIGRyeVJ1biB9KSBhcyB7XG4gICAgICAgICAgICBvazogYm9vbGVhbjtcbiAgICAgICAgICAgIGxvZz86IFJ1bkxvZztcbiAgICAgICAgICAgIGVycm9yPzogc3RyaW5nO1xuICAgICAgICB9O1xuICAgICAgICBpZiAocmVzcG9uc2Uub2sgJiYgcmVzcG9uc2UubG9nKSB7XG4gICAgICAgICAgICBsYXN0TG9nID0gcmVzcG9uc2UubG9nO1xuICAgICAgICAgICAgcmVuZGVyTG9nKHJlc3BvbnNlLmxvZyk7XG4gICAgICAgICAgICByZW5kZXJQbGFuKCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZW5kZXJMb2coe1xuICAgICAgICAgICAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgICAgICAgZHJ5UnVuLFxuICAgICAgICAgICAgICAgIGRhdGVzOiBbXSxcbiAgICAgICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgICAgICBub3RlczogW10sXG4gICAgICAgICAgICAgICAgZXJyb3I6IHJlc3BvbnNlLmVycm9yID8/ICdVbmtub3duIGZhaWx1cmUnLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmVuZGVyTG9nKHtcbiAgICAgICAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgICBkcnlSdW4sXG4gICAgICAgICAgICBkYXRlczogW10sXG4gICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgIG5vdGVzOiBbXSxcbiAgICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IG9yaWdpbmFsO1xuICAgICAgICAvLyBOb3QgYGRpc2FibGVkID0gZmFsc2VgOiB3aGV0aGVyIHRoZXNlIGFyZSB1c2FibGUgaXMgcmVuZGVyRGVza1N0YXRlJ3NcbiAgICAgICAgLy8gZGVjaXNpb24sIGFuZCBhIHJ1biBkb2VzIG5vdCBjaGFuZ2UgaXQuXG4gICAgICAgIHJlbmRlckRlc2tTdGF0ZSgpO1xuICAgIH1cbn1cblxuZWw8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdydW5Ob3cnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4ge1xuICAgIHZvaWQgdHJpZ2dlclJ1bihldmVudC5jdXJyZW50VGFyZ2V0IGFzIEhUTUxCdXR0b25FbGVtZW50LCBmYWxzZSk7XG59KTtcblxuZWw8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdkcnlSdW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4ge1xuICAgIHZvaWQgdHJpZ2dlclJ1bihldmVudC5jdXJyZW50VGFyZ2V0IGFzIEhUTUxCdXR0b25FbGVtZW50LCB0cnVlKTtcbn0pO1xuXG5maWVsZHMubGVhcm5Nb2RlLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICB2b2lkIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IGxlYXJuTW9kZTogZmllbGRzLmxlYXJuTW9kZS5jaGVja2VkIH0pO1xufSk7XG5cbmVsPEhUTUxCdXR0b25FbGVtZW50PignY29weUNhcHR1cmVzJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICBjb25zdCB7IGNhcHR1cmVzID0gW10gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgnY2FwdHVyZXMnKSBhcyB7IGNhcHR1cmVzPzogdW5rbm93bltdIH07XG4gICAgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoSlNPTi5zdHJpbmdpZnkoY2FwdHVyZXMsIG51bGwsIDIpKTtcbiAgICBjb25zdCBidXR0b24gPSBldmVudC5jdXJyZW50VGFyZ2V0IGFzIEhUTUxCdXR0b25FbGVtZW50O1xuICAgIGNvbnN0IG9yaWdpbmFsID0gYnV0dG9uLnRleHRDb250ZW50O1xuICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9ICdDb3BpZWQnO1xuICAgIHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHsgYnV0dG9uLnRleHRDb250ZW50ID0gb3JpZ2luYWw7IH0sIDFfNDAwKTtcbn0pO1xuXG4vKipcbiAqIEZvbGxvdyBjaGFuZ2VzIHRoZSBwb3B1cCBkaWQgbm90IG1ha2UgaXRzZWxmLlxuICpcbiAqIEEgcnVuIHN0YXJ0ZWQgZnJvbSBoZXJlIGFscmVhZHkgcmVkcmF3cyBvbiBpdHMgcmVwbHkuIFRoaXMgaXMgZm9yIGV2ZXJ5dGhpbmdcbiAqIGVsc2U6IGFuIGF1dG9tYXRpYyBydW4gZmluaXNoaW5nIHdoaWxlIHRoZSBwYW5lbCBpcyBvcGVuLCBhbmQgdGhlIHNldHRpbmdzIHRoZVxuICogYmFja2dyb3VuZCB3cml0ZXMgb24gaXRzIG93biBcdTIwMTQgdGhlIHJlc29sdmVkIGRlc2sgaWQgaXQgY2FjaGVzLCB0aGUgY2FuY2VsXG4gKiBkYXRlcyBpdCBjbGVhcnMgb25jZSBkb25lLiBXaXRob3V0IHRoaXMgdGhlIHBhbmVsIHF1aWV0bHkgc2hvd3MgYSBzdGFsZVxuICogcGljdHVyZSBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBvcGVuLCB3aGljaCBpcyBleGFjdGx5IHdoZW4gc29tZW9uZSBpc1xuICogd2F0Y2hpbmcgaXQgdG8gc2VlIHdoZXRoZXIgdGhlIHRoaW5nIHdvcmtzLlxuICovXG5jaHJvbWUuc3RvcmFnZS5vbkNoYW5nZWQuYWRkTGlzdGVuZXIoKGNoYW5nZXMsIGFyZWEpID0+IHtcbiAgICBpZiAoYXJlYSAhPT0gJ2xvY2FsJykgcmV0dXJuO1xuXG4gICAgaWYgKGNoYW5nZXMucnVucykge1xuICAgICAgICBjb25zdCBydW5zID0gY2hhbmdlcy5ydW5zLm5ld1ZhbHVlIGFzIFJ1bkxvZ1tdIHwgdW5kZWZpbmVkO1xuICAgICAgICBsYXN0TG9nID0gcnVucz8uWzBdO1xuICAgICAgICByZW5kZXJMb2cobGFzdExvZyk7XG4gICAgICAgIHJlbmRlclBsYW4oKTtcbiAgICB9XG5cbiAgICAvLyBPbmx5IHJlLXJlbmRlciBmcm9tIGEgYmFja2dyb3VuZCB3cml0ZSwgbmV2ZXIgZnJvbSB0aGlzIHBvcHVwJ3Mgb3duIHNhdmUsXG4gICAgLy8gb3IgZXZlcnkga2V5c3Ryb2tlIHdvdWxkIHJld3JpdGUgdGhlIGZpZWxkIHVuZGVyIHRoZSBjdXJzb3IuXG4gICAgaWYgKGNoYW5nZXMuc2V0dGluZ3MgJiYgIXNhdmluZ0xvY2FsbHkpIHtcbiAgICAgICAgY3VycmVudCA9IG1lcmdlU2V0dGluZ3MoY2hhbmdlcy5zZXR0aW5ncy5uZXdWYWx1ZSBhcyBQYXJ0aWFsPFNldHRpbmdzPiB8IHVuZGVmaW5lZCk7XG4gICAgICAgIHJlbmRlclNldHRpbmdzKGN1cnJlbnQpO1xuICAgICAgICByZW5kZXJQbGFuKCk7XG4gICAgICAgIHJlbmRlckF1dG9Ob3RlKCk7XG4gICAgICAgIHJlbmRlckRlc2tTdGF0ZSgpO1xuICAgIH1cbn0pO1xuXG5lbDxIVE1MQnV0dG9uRWxlbWVudD4oJ2NsZWFyQ2FwdHVyZXMnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBjYXB0dXJlczogW10gfSk7XG4gICAgYXdhaXQgcmVuZGVyQ2FwdHVyZXMoKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQXNLTyxJQUFNLGFBQTJEO0FBQUEsRUFDcEUsU0FBUyxFQUFFLE9BQU8saUJBQWlCLEtBQUssZ0JBQWdCO0FBQUEsRUFDeEQsU0FBUyxFQUFFLE9BQU8saUJBQWlCLEtBQUssZ0JBQWdCO0FBQUEsRUFDeEQsV0FBVyxFQUFFLE9BQU8saUJBQWlCLEtBQUssZ0JBQWdCO0FBQzlEO0FBb0JPLElBQU0sbUJBQTZCO0FBQUE7QUFBQTtBQUFBLEVBR3RDLGlCQUFpQjtBQUFBLEVBQ2pCLFNBQVM7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQUlULFVBQVU7QUFBQSxFQUNWLFFBQVE7QUFBQSxFQUNSLFNBQVM7QUFBQSxFQUNULFlBQVk7QUFBQSxFQUNaLFVBQVUsQ0FBQyxVQUFVLFdBQVcsYUFBYSxZQUFZLFFBQVE7QUFBQSxFQUNqRSxNQUFNO0FBQUEsRUFDTixhQUFhO0FBQUEsRUFDYixXQUFXLENBQUM7QUFBQSxFQUNaLGFBQWEsQ0FBQztBQUFBLEVBQ2QsVUFBVTtBQUFBLEVBQ1YsVUFBVTtBQUFBLElBQ04sU0FBUztBQUFBLElBQ1QsTUFBTSxFQUFFLE1BQU0s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
