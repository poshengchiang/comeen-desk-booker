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
function markRunsRead() {
  void chrome.runtime.sendMessage({ type: "runs-read" }).catch(() => {
  });
}
markRunsRead();
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
      markRunsRead();
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvcmUvY29uZmlnLnRzIiwgIi4uL3NyYy9jb3JlL2RhdGVzLnRzIiwgIi4uL3NyYy9wb3B1cC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBXZWVrZGF5IH0gZnJvbSAnLi9kYXRlcy5qcyc7XG5cbmV4cG9ydCB0eXBlIFNsb3QgPSAnYWxsX2RheScgfCAnbW9ybmluZycgfCAnYWZ0ZXJub29uJztcblxuLyoqXG4gKiBIb3cgdGhlIGluLXBhZ2UgY29kZSBzaG91bGQgYXV0aGVudGljYXRlLlxuICpcbiAqIGBjb29raWVgICAgICAgIC0ganVzdCBzZW5kIGNyZWRlbnRpYWxzIHdpdGggdGhlIHJlcXVlc3QuIENvcnJlY3QgaWYgQ29tZWVuXG4gKiAgICAgICAgICAgICAgICAgIGF1dGhlbnRpY2F0ZXMgd2l0aCBhIHNlc3Npb24gY29va2llLlxuICogYGxvY2FsU3RvcmFnZWAgLSByZWFkIGEgdG9rZW4gb3V0IG9mIHRoZSBwYWdlJ3Mgb3duIGxvY2FsU3RvcmFnZSBhbmQgcHV0IGl0XG4gKiAgICAgICAgICAgICAgICAgIGluIGEgaGVhZGVyLiBDb3JyZWN0IGlmIENvbWVlbiB1c2VzIGEgYmVhcmVyIHRva2VuLlxuICpcbiAqIEVpdGhlciB3YXkgdGhlIHZhbHVlIGlzIHJlYWQgaW5zaWRlIHRoZSBwYWdlIGFuZCB1c2VkIHRoZXJlLiBJdCBpcyBuZXZlclxuICogY29waWVkIGludG8gZXh0ZW5zaW9uIHN0b3JhZ2UsIG5ldmVyIHBlcnNpc3RlZCwgYW5kIG5ldmVyIGxlYXZlcyB0aGUgdGFiLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhDb25maWcge1xuICAgIG1vZGU6ICdjb29raWUnIHwgJ2xvY2FsU3RvcmFnZSc7XG4gICAgLyoqIGxvY2FsU3RvcmFnZSBrZXkgaG9sZGluZyB0aGUgdG9rZW4uICovXG4gICAgc3RvcmFnZUtleT86IHN0cmluZztcbiAgICAvKiogRG90dGVkIHBhdGggaW5zaWRlIHRoZSBwYXJzZWQgSlNPTiwgZS5nLiBgc3RzVG9rZW5NYW5hZ2VyLmFjY2Vzc1Rva2VuYCAqL1xuICAgIGpzb25QYXRoPzogc3RyaW5nO1xuICAgIC8qKiBIZWFkZXIgdG8gc2V0LCBkZWZhdWx0IGBhdXRob3JpemF0aW9uYCAqL1xuICAgIGhlYWRlcj86IHN0cmluZztcbiAgICAvKiogUHJlZml4IGJlZm9yZSB0aGUgdG9rZW4sIGRlZmF1bHQgYEJlYXJlciBgICovXG4gICAgcHJlZml4Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlcXVlc3RUZW1wbGF0ZSB7XG4gICAgbWV0aG9kOiAnR0VUJyB8ICdQT1NUJyB8ICdQVVQnIHwgJ0RFTEVURSc7XG4gICAgLyoqIFBhdGggYXBwZW5kZWQgdG8gYXBpQmFzZS4gTWF5IGNvbnRhaW4gcGxhY2Vob2xkZXJzLiAqL1xuICAgIHBhdGg6IHN0cmluZztcbiAgICBxdWVyeT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgYm9keT86IHVua25vd247XG59XG5cbi8qKlxuICogSG93IHRoZSBcIndoYXQgZG8gSSBhbHJlYWR5IGhvbGRcIiByZXNwb25zZSBpcyBsYWlkIG91dC5cbiAqXG4gKiBgYXJyYXlgICAgICAgICAtIGEgZmxhdCBsaXN0IG9mIGJvb2tpbmdzLCBlYWNoIGNhcnJ5aW5nIGl0cyBvd24gZGF0ZSBmaWVsZCxcbiAqICAgICAgICAgICAgICAgICAgcmVhZCB2aWEgYGxpc3REYXRlRmllbGRzYC5cbiAqIGBkYXRlS2V5ZWRNYXBgIC0gYW4gb2JqZWN0IGtleWVkIGJ5IGBZWVlZLU1NLUREYCB3aG9zZSB2YWx1ZXMgYXJlIHRoYXQgZGF5J3NcbiAqICAgICAgICAgICAgICAgICAgZW50cmllcy4gQ29tZWVuIHJldHVybnMgdGhpcyBvbmUuIFRoZSBkYXRlIGlzIHRoZSAqa2V5Kiwgbm90XG4gKiAgICAgICAgICAgICAgICAgIGEgZmllbGQsIHNvIG5vIGFtb3VudCBvZiBzbmlmZmluZyBmaWVsZCBuYW1lcyB3b3VsZCBmaW5kIGl0IFx1MjAxNFxuICogICAgICAgICAgICAgICAgICB3aGljaCBpcyBleGFjdGx5IHdoeSB0aGUgc2hhcGUgaXMgY29uZmlndXJhdGlvbiByYXRoZXIgdGhhblxuICogICAgICAgICAgICAgICAgICBzb21ldGhpbmcgdGhlIGluLXBhZ2UgY29kZSBndWVzc2VzLlxuICovXG5leHBvcnQgdHlwZSBMaXN0U2hhcGUgPSAnYXJyYXknIHwgJ2RhdGVLZXllZE1hcCc7XG5cbi8qKlxuICogVGhlIHdob2xlIEFQSSBjb250cmFjdCBsaXZlcyBoZXJlIGFzIGRhdGEgc28gaXQgY2FuIGJlIGNvcnJlY3RlZCBmcm9tIHRoZVxuICogcG9wdXAgd2l0aG91dCByZWJ1aWxkaW5nLiBQbGFjZWhvbGRlcnMgYXZhaWxhYmxlIHRvIHBhdGhzLCBxdWVyaWVzIGFuZFxuICogYm9kaWVzOiB7e2RhdGV9fSwge3tkZXNrSWR9fSwge3tkZXNrTmFtZX19LCB7e3Nsb3R9fSwge3tzdGFydFRpbWV9fSxcbiAqIHt7ZW5kVGltZX19LCB7e2Zyb219fSwge3t0b319LCB7e3VzZXJJZH19LCB7e2Zsb29ySWR9fSwge3tidWlsZGluZ0lkfX0sXG4gKiB7e2FyZWFJZH19LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEVuZHBvaW50Q29uZmlnIHtcbiAgICBhcGlCYXNlOiBzdHJpbmc7XG4gICAgYXV0aDogQXV0aENvbmZpZztcbiAgICAvKipcbiAgICAgKiBMb29rIGEgZGVzayB1cCBieSBpdHMgaHVtYW4gbmFtZSBzbyBub2JvZHkgaGFzIHRvIGtub3cgaXRzIGludGVybmFsIGlkLlxuICAgICAqIFNldCB0byBudWxsIG9ubHkgaWYgeW91ciBDb21lZW4gaGFzIG5vIGRlc2stc2VhcmNoIGVuZHBvaW50LlxuICAgICAqL1xuICAgIHJlc29sdmU6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqIEZpZWxkIG5hbWVzIHRoYXQgbWlnaHQgaG9sZCBhIGRlc2sncyBodW1hbiBsYWJlbCBpbiBhIHNlYXJjaCByZXN1bHQuICovXG4gICAgZGVza05hbWVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKiBGaWVsZCBuYW1lcyB0aGF0IG1pZ2h0IGhvbGQgYSBkZXNrJ3MgaW50ZXJuYWwgaWQuIENvbWVlbiB1c2VzIGB1dWlkYC4gKi9cbiAgICBkZXNrSWRGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIEZpZWxkIG9uIGEgZGVzayByZWNvcmQgaG9sZGluZyB0aGF0IGRlc2sncyBvd24gYm9va2luZ3MgZm9yIHRoZSBxdWVyaWVkXG4gICAgICogd2luZG93LiBVc2VkIHRvIHRlbGwgeW91IGEgZGF5IGlzIGFscmVhZHkgdGFrZW4gKmJlZm9yZSogeW91IHByZXNzIEJvb2tcbiAgICAgKiBub3cuIFNldCB0byAnJyB0byBkaXNhYmxlLlxuICAgICAqL1xuICAgIGRlc2tTY2hlZHVsZUZpZWxkOiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogRGF0ZSBmaWVsZHMgdG8gcmVhZCBvZmYgb25lIG9mIHRob3NlIGVudHJpZXMsIGluIHByaW9yaXR5IG9yZGVyLCBmaXJzdFxuICAgICAqIG1hdGNoIHdpbnMuXG4gICAgICpcbiAgICAgKiBUaGUgb3JkZXIgbWF0dGVycyBtb3JlIHRoYW4gaXQgbG9va3M6IGFuIGVudHJ5IGFsbW9zdCBjZXJ0YWlubHkgYWxzb1xuICAgICAqIGNhcnJpZXMgY3JlYXRlZF9hdCBhbmQgdXBkYXRlZF9hdCwgd2hpY2ggYXJlIHdoZW4gdGhlIGJvb2tpbmcgd2FzIG1hZGUsXG4gICAgICogbm90IHRoZSBkYXkgYm9va2VkLiBMaXN0aW5nIG9ubHkgdGhlIGZpZWxkcyB0aGF0IG1lYW4gXCJ0aGUgZGF5IHRoaXMgaXNcbiAgICAgKiBmb3JcIiBpcyB3aGF0IHN0b3BzIGEgYm9va2luZyBtYWRlIHRocmVlIHdlZWtzIGFnbyBmcm9tIG1hcmtpbmcgdGhyZWVcbiAgICAgKiB3ZWVrcyBhZ28gYXMgdGFrZW4uXG4gICAgICovXG4gICAgZGVza1NjaGVkdWxlRGF0ZUZpZWxkczogc3RyaW5nW107XG4gICAgLyoqIFNldCB0byBudWxsIHRvIHNraXAgdGhlIFwid2hhdCBkbyBJIGFscmVhZHkgaGF2ZVwiIGNoZWNrLiAqL1xuICAgIGxpc3Q6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqIERvdHRlZCBwYXRoIHRvIHRoZSBjb250YWluZXIgaW5zaWRlIHRoZSBsaXN0IHJlc3BvbnNlLiAnJyBtZWFucyByb290LiAqL1xuICAgIGxpc3RSb290OiBzdHJpbmc7XG4gICAgbGlzdFNoYXBlOiBMaXN0U2hhcGU7XG4gICAgLyoqIE9ubHkgY29uc3VsdGVkIHdoZW4gbGlzdFNoYXBlIGlzICdhcnJheScuICovXG4gICAgbGlzdERhdGVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIERvdHRlZCBwYXRoIHRvIHRoZSBzaWduZWQtaW4gdXNlcidzIGlkIGluc2lkZSB0aGUgbGlzdCByZXNwb25zZS4gRW1wdHlcbiAgICAgKiBkaXNhYmxlcyB0aGUgbG9va3VwLCBhbmQge3t1c2VySWR9fSB0aGVuIHN0YXlzIHVuZmlsbGVkLlxuICAgICAqL1xuICAgIHVzZXJJZFBhdGg6IHN0cmluZztcbiAgICBjcmVhdGU6IFJlcXVlc3RUZW1wbGF0ZTtcbiAgICAvKipcbiAgICAgKiBDYW5jZWwgYSBib29raW5nLiBTZXQgdG8gbnVsbCB0byBkaXNhYmxlIGNhbmNlbGxpbmcgZW50aXJlbHkuXG4gICAgICpcbiAgICAgKiBUYWtlcyB7e2Jvb2tpbmdJZH19LCByZWFkIG9mZiB0aGUgbGlzdGVkIGJvb2tpbmcgdmlhIGxpc3RCb29raW5nSWRGaWVsZHMgXHUyMDE0XG4gICAgICogc28gY2FuY2VsbGluZyBkZXBlbmRzIG9uIGBsaXN0YCB3b3JraW5nLCB3aGljaCBpcyBjb3JyZWN0OiB5b3UgY2Fubm90XG4gICAgICogY2FuY2VsIHdoYXQgeW91IGhhdmUgbm90IGNvbmZpcm1lZCB5b3UgaG9sZC5cbiAgICAgKi9cbiAgICBjYW5jZWw6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqXG4gICAgICogRmllbGRzIG9uIGEgbGlzdGVkIGJvb2tpbmcgdGhhdCBpZGVudGlmeSBpdCBmb3IgY2FuY2VsbGF0aW9uLCBpbiBwcmlvcml0eVxuICAgICAqIG9yZGVyLiBDb21lZW4gd2FudHMgdGhlIG51bWVyaWMgYGlkYCBoZXJlLCBOT1QgdGhlIGB1dWlkYCB0aGF0IHRoZSBzYW1lXG4gICAgICogZW50cnkgYWxzbyBjYXJyaWVzIGFuZCB0aGF0IHRoZSBjcmVhdGUgYm9keSB1c2VzIGZvciB0aGUgZGVzay4gR2V0dGluZ1xuICAgICAqIHRoaXMgd3JvbmcgaXMgYSA0MDQgYXQgYmVzdC5cbiAgICAgKi9cbiAgICBsaXN0Qm9va2luZ0lkRmllbGRzOiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5ncyB7XG4gICAgLyoqXG4gICAgICogQnVtcGVkIGluIERFRkFVTFRfU0VUVElOR1Mgd2hlbmV2ZXIgdGhlIHNoaXBwZWQgZW5kcG9pbnQgY29uZmlnIGlzXG4gICAgICogY29ycmVjdGVkLiBTZWUgbWVyZ2VTZXR0aW5nczogYSBzdG9yZWQgY29uZmlnIG9sZGVyIHRoYW4gdGhlIHNoaXBwZWQgb25lXG4gICAgICogaXMgcmVwbGFjZWQgcmF0aGVyIHRoYW4gbWVyZ2VkLCB3aGljaCBpcyB3aGF0IGxldHMgYSBmaXggYWN0dWFsbHkgcmVhY2hcbiAgICAgKiBwZW9wbGUgd2hvIGhhdmUgYWxyZWFkeSBzYXZlZCBzZXR0aW5ncyBvbmNlLlxuICAgICAqL1xuICAgIGVuZHBvaW50VmVyc2lvbjogbnVtYmVyO1xuICAgIGVuYWJsZWQ6IGJvb2xlYW47XG4gICAgZGVza05hbWU6IHN0cmluZztcbiAgICBkZXNrSWQ6IHN0cmluZztcbiAgICAvKipcbiAgICAgKiBUaGUgZmxvb3IgdGhlIGRlc2sgaXMgb24uIFRoaXMgb25lIGNhbm5vdCBiZSBkZXJpdmVkOiByZXNvbHZpbmcgYSBkZXNrIGJ5XG4gICAgICogbmFtZSBtZWFucyBsaXN0aW5nIGEgZmxvb3IncyBkZXNrcywgc28gdGhlIGZsb29yIGhhcyB0byBiZSBrbm93biBmaXJzdC5cbiAgICAgKiBWaXNpYmxlIGluIHRoZSBVUkwgb2YgQ29tZWVuJ3MgZmxvb3IgcGxhbiwgYW5kIGluIGBmbG9vcl9pZGAgb24gYW55IGRlc2suXG4gICAgICovXG4gICAgZmxvb3JJZDogbnVtYmVyO1xuICAgIC8qKlxuICAgICAqIFRoZSBidWlsZGluZyB0aGUgZmxvb3IgaXMgaW4uIEFsc28gbm90IGRlcml2YWJsZSBcdTIwMTQgYSBkZXNrIHJlY29yZCBjYXJyaWVzXG4gICAgICogYGZsb29yX2lkYCBhbmQgYGFyZWFfaWRgIGJ1dCBubyBgYnVpbGRpbmdfaWRgLCBhbmQgdGhlIG9ubHkgZW5kcG9pbnQgdGhhdFxuICAgICAqIG1hcHMgb25lIHRvIHRoZSBvdGhlciBuZWVkcyBhIHNwYWNlIFVVSUQgd2UgbmV2ZXIgb3RoZXJ3aXNlIGZldGNoLlxuICAgICAqL1xuICAgIGJ1aWxkaW5nSWQ6IG51bWJlcjtcbiAgICB3ZWVrZGF5czogV2Vla2RheVtdO1xuICAgIHNsb3Q6IFNsb3Q7XG4gICAgaG9yaXpvbkRheXM6IG51bWJlcjtcbiAgICBza2lwRGF0ZXM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIERheXMgd2hvc2UgYm9va2luZyBzaG91bGQgYmUgY2FuY2VsbGVkIG9uIHRoZSBuZXh0IHJ1bi5cbiAgICAgKlxuICAgICAqIEEgb25lLXNob3QgaW5zdHJ1Y3Rpb24sIG5vdCBhIHByZWZlcmVuY2U6IGFuIGVudHJ5IGlzIHJlbW92ZWQgb25jZSB0aGVcbiAgICAgKiBjYW5jZWxsYXRpb24gc3VjY2VlZHMsIG9yIHRoZSBuZXh0IGF1dG9tYXRpYyBydW4gd291bGQga2VlcCB0cnlpbmcgdG9cbiAgICAgKiBkZWxldGUgc29tZXRoaW5nIGFscmVhZHkgZ29uZS4gQWRkaW5nIGEgZGF0ZSBoZXJlIGFsc28gYWRkcyBpdCB0b1xuICAgICAqIHNraXBEYXRlcyBcdTIwMTQgb3RoZXJ3aXNlIHRoZSBzYW1lIHJ1biB0aGF0IGNhbmNlbHMgaXQgYm9va3MgaXQgc3RyYWlnaHQgYmFjay5cbiAgICAgKi9cbiAgICBjYW5jZWxEYXRlczogc3RyaW5nW107XG4gICAgdGltZVpvbmU6IHN0cmluZztcbiAgICBlbmRwb2ludDogRW5kcG9pbnRDb25maWc7XG59XG5cbi8qKlxuICogQSBzbG90IGFzIHRoZSBuYWl2ZSBsb2NhbCB0aW1lcyBDb21lZW4gZXhwZWN0cy5cbiAqXG4gKiBDb21lZW4gc2VuZHMgZGF0ZXRpbWVzIGxpa2UgYDIwMjYtMDktMDFUMDA6MDA6MDAuMDAwWmAgYW5kIGVjaG9lcyB0aGVtIGJhY2tcbiAqIGFzIGAyMDI2LTA5LTAxVDAwOjAwOjAwYCBcdTIwMTQgYSBsb2NhbCB3YWxsLWNsb2NrIHRpbWUgd2VhcmluZyBhIGBaYC4gU28gdGhlIGRheVxuICogaXMgdXNlZCB2ZXJiYXRpbSBhbmQgbm8gdGltZXpvbmUgY29udmVyc2lvbiBoYXBwZW5zIGFueXdoZXJlIGluIHRoZSBib29raW5nXG4gKiBwYXRoLiBUaGUgZGF0ZSBsb2dpYyBpbiBkYXRlcy50cyBhbHJlYWR5IHByb2R1Y2VzIGV4YWN0bHkgdGhpcy5cbiAqXG4gKiBBbGwgdGhyZWUgY29uZmlybWVkIGFnYWluc3Qgd2hhdCBDb21lZW4ncyBvd24gd2ViIFVJIHNlbmRzLiBUaGUgaGFsZi1kYXlzXG4gKiB3ZXJlIGd1ZXNzZWQgZmlyc3QgYW5kIG9uZSBndWVzcyB3YXMgd3Jvbmc6IG1vcm5pbmcgZW5kcyBhdCAxMTo1OTo1OSwgbm90IGF0XG4gKiAxMjowMDowMCwgZm9sbG93aW5nIHRoZSBzYW1lIFwibGFzdCBzZWNvbmQgb2YgdGhlIHBlcmlvZFwiIHBhdHRlcm4gYXMgYWxsX2RheS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNMT1RfVElNRVM6IFJlY29yZDxTbG90LCB7IHN0YXJ0OiBzdHJpbmc7IGVuZDogc3RyaW5nIH0+ID0ge1xuICAgIGFsbF9kYXk6IHsgc3RhcnQ6ICcwMDowMDowMC4wMDBaJywgZW5kOiAnMjM6NTk6NTkuMDAwWicgfSxcbiAgICBtb3JuaW5nOiB7IHN0YXJ0OiAnMDA6MDA6MDAuMDAwWicsIGVuZDogJzExOjU5OjU5LjAwMFonIH0sXG4gICAgYWZ0ZXJub29uOiB7IHN0YXJ0OiAnMTI6MDA6MDAuMDAwWicsIGVuZDogJzIzOjU5OjU5LjAwMFonIH0sXG59O1xuXG4vKipcbiAqIENvbmZpcm1lZCBhZ2FpbnN0IGEgcmVhbCBzaWduZWQtaW4gc2Vzc2lvbiBpbiBBdWd1c3QgMjAyNiwgYnkgY2FwdHVyaW5nIHRoZVxuICogdHJhZmZpYyBvZiBvbmUgZGVzayBib29raW5nIG1hZGUgYnkgaGFuZC5cbiAqXG4gKiBOb3RlcyB3b3J0aCBrZWVwaW5nLCBiZWNhdXNlIGVhY2ggb25lIGNvbnRyYWRpY3RzIGEgcmVhc29uYWJsZSBndWVzczpcbiAqICAgLSBgYXBpQmFzZWAgaXMgbXkuY29tZWVuLmlvL2FwaSwgdGhlIFNQQSdzIG93biBvcmlnaW4sIE5PVCBhcGkuY29tZWVuLmlvXG4gKiAgICAgd2hlcmUgdGhlIHB1YmxpYyBkb2NzIGxpdmUuIEl0IGlzIGEgUmFpbHMgYmFja2VuZCBiZWhpbmQgYSBOdXh0IGZyb250IGVuZCxcbiAqICAgICB3aGljaCBpcyB3aHkgcGF0aHMgZW5kIGluIGAuanNvbmAuXG4gKiAgIC0gVGhlIEFQSSB2ZXJzaW9uIHZhcmllcyBwZXIgZW5kcG9pbnQgKC92MSwgL3YyLCAvdjJiZXRhKSwgc28gdGhlIHZlcnNpb25cbiAqICAgICBiZWxvbmdzIGluIGVhY2ggcGF0aCByYXRoZXIgdGhhbiBpbiBhcGlCYXNlLlxuICogICAtIEEgZGVzaydzIGlkIGlzIGB1dWlkYC4gVGhlcmUgaXMgbm8gYGlkYCBmaWVsZCBvbiBhIGRlc2sgYXQgYWxsLlxuICogICAtIFRoZSBib29raW5ncyBsaXN0IGlzIGtleWVkIGJ5IGRhdGU7IHRoZSBkYXRlIGlzIG5vdCBhIGZpZWxkIG9uIGFuIGVudHJ5LlxuICogICAtIEEgYm9va2luZyBpcyBhIFwid29yayBhY3Rpdml0eVwiIHdpdGggYSBkZXNrIGF0dGFjaGVkLCBub3QgYSBkZXNrIGJvb2tpbmdcbiAqICAgICBhcyBzdWNoLiBUaGF0IGlzIHdoeSB0aGUgcGF0aCBzYXlzIHdvcmtfYWN0aXZpdHlfc2NoZWR1bGUuXG4gKiAgIC0gQXV0aCBpcyB0aGUgc2Vzc2lvbiBjb29raWUuIEEgZmV0Y2ggZnJvbSB0aGUgcGFnZSB3aXRoIGNyZWRlbnRpYWxzXG4gKiAgICAgaW5jbHVkZWQgYW5kIG5vIEF1dGhvcml6YXRpb24gaGVhZGVyIHJldHVybnMgMjAwLCBzbyB0aGVyZSBpcyBubyB0b2tlbiB0b1xuICogICAgIHJlYWQgYW5kIG5vdGhpbmcgZm9yIHRoZSBleHRlbnNpb24gdG8gaG9sZC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFNldHRpbmdzID0ge1xuICAgIC8vIFx1MkIwNiBCVU1QIFRISVMgd2hlbmV2ZXIgeW91IGNvcnJlY3QgdGhlIGBlbmRwb2ludGAgYmxvY2sgYmVsb3csIG90aGVyd2lzZVxuICAgIC8vIGFueW9uZSB3aG8gYWxyZWFkeSBwcmVzc2VkIFNhdmUga2VlcHMgdGhlaXIgc3RhbGUgY29weSBmb3JldmVyLlxuICAgIGVuZHBvaW50VmVyc2lvbjogNCxcbiAgICBlbmFibGVkOiBmYWxzZSxcbiAgICAvLyBFbXB0eSBvbiBwdXJwb3NlLiBTaGlwcGluZyBhIHJlYWwgZGVzayBudW1iZXIgYXMgdGhlIGRlZmF1bHQgbWVhbnMgdGhlXG4gICAgLy8gZmlyc3QgcGVyc29uIHRvIGluc3RhbGwgdGhpcyBhbmQgcHJlc3MgQm9vayBub3cgdGFrZXMgc29tZWJvZHkgZWxzZSdzXG4gICAgLy8gc2VhdCwgaGF2aW5nIGRvbmUgbm90aGluZyB3cm9uZy4gTm90aGluZyBydW5zIHVudGlsIGEgZGVzayBpcyBjaG9zZW4uXG4gICAgZGVza05hbWU6ICcnLFxuICAgIGRlc2tJZDogJycsXG4gICAgZmxvb3JJZDogNDk1MixcbiAgICBidWlsZGluZ0lkOiA1MTUxLFxuICAgIHdlZWtkYXlzOiBbJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknXSxcbiAgICBzbG90OiAnYWxsX2RheScsXG4gICAgaG9yaXpvbkRheXM6IDE0LFxuICAgIHNraXBEYXRlczogW10sXG4gICAgY2FuY2VsRGF0ZXM6IFtdLFxuICAgIHRpbWVab25lOiAnRXVyb3BlL1ByYWd1ZScsXG4gICAgZW5kcG9pbnQ6IHtcbiAgICAgICAgYXBpQmFzZTogJ2h0dHBzOi8vbXkuY29tZWVuLmlvL2FwaScsXG4gICAgICAgIGF1dGg6IHsgbW9kZTogJ2Nvb2tpZScgfSxcbiAgICAgICAgcmVzb2x2ZToge1xuICAgICAgICAgICAgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgICAgIHBhdGg6ICcvdjEvZmxvb3JzL3t7Zmxvb3JJZH19L2Rlc2tzX3NjaGVkdWxlLmpzb24nLFxuICAgICAgICAgICAgcXVlcnk6IHtcbiAgICAgICAgICAgICAgICBzdGFydF9kYXRlOiAne3tmcm9tfX1UMDA6MDA6MDAuMDAwWicsXG4gICAgICAgICAgICAgICAgZW5kX2RhdGU6ICd7e3RvfX1UMjM6NTk6NTkuMDAwWicsXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBkZXNrTmFtZUZpZWxkczogWyduYW1lJywgJ3N5bmNfaWQnXSxcbiAgICAgICAgZGVza0lkRmllbGRzOiBbJ3V1aWQnLCAnaWQnXSxcbiAgICAgICAgZGVza1NjaGVkdWxlRmllbGQ6ICdzY2hlZHVsZScsXG4gICAgICAgIGRlc2tTY2hlZHVsZURhdGVGaWVsZHM6IFsnc3RhcnRfZGF0ZXRpbWUnLCAnc3RhcnRfZGF0ZScsICdkYXRlJywgJ2RheScsICdzdGFydCddLFxuICAgICAgICBsaXN0OiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICAgICAgcGF0aDogJy92MS91c2Vycy9tZS93b3JrX2FjdGl2aXR5X3NjaGVkdWxlLmpzb24nLFxuICAgICAgICAgICAgcXVlcnk6IHtcbiAgICAgICAgICAgICAgICBzdGFydF9kYXRlOiAne3tmcm9tfX1UMDA6MDA6MDAuMDAwWicsXG4gICAgICAgICAgICAgICAgZW5kX2RhdGU6ICd7e3RvfX1UMjM6NTk6NTkuMDAwWicsXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBsaXN0Um9vdDogJ3NjaGVkdWxlJyxcbiAgICAgICAgbGlzdFNoYXBlOiAnZGF0ZUtleWVkTWFwJyxcbiAgICAgICAgbGlzdERhdGVGaWVsZHM6IFsnc3RhcnRfZGF0ZXRpbWUnLCAnZGF0ZSddLFxuICAgICAgICB1c2VySWRQYXRoOiAndXNlci5pZCcsXG4gICAgICAgIGxpc3RCb29raW5nSWRGaWVsZHM6IFsnaWQnLCAndXVpZCddLFxuICAgICAgICBjcmVhdGU6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICAgICAgLy8gVGhlIGBtZWAgYWxpYXMgd29ya3MgZm9yIHJlYWRzOyB0aGUgYXBwIGl0c2VsZiB1c2VzIHRoZSBudW1lcmljXG4gICAgICAgICAgICAvLyBpZCB0byB3cml0ZSwgc28gdGhhdCBpcyB3aGF0IGlzIHVzZWQgaGVyZS5cbiAgICAgICAgICAgIHBhdGg6ICcvdjEvdXNlcnMve3t1c2VySWR9fS93b3JrX2FjdGl2aXR5X3NjaGVkdWxlLmpzb24nLFxuICAgICAgICAgICAgYm9keToge1xuICAgICAgICAgICAgICAgIHdvcmtfYWN0aXZpdHk6IHtcbiAgICAgICAgICAgICAgICAgICAgc3RhdGU6ICdvbl9zaXRlJyxcbiAgICAgICAgICAgICAgICAgICAgc3RhcnRfZGF0ZXRpbWU6ICd7e2RhdGV9fVR7e3N0YXJ0VGltZX19JyxcbiAgICAgICAgICAgICAgICAgICAgZW5kX2RhdGV0aW1lOiAne3tkYXRlfX1Ue3tlbmRUaW1lfX0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgcHJlc2VuY2U6IHtcbiAgICAgICAgICAgICAgICAgICAgYnVpbGRpbmdfaWQ6ICd7e2J1aWxkaW5nSWR9fScsXG4gICAgICAgICAgICAgICAgICAgIGZsb29yX2lkOiAne3tmbG9vcklkfX0nLFxuICAgICAgICAgICAgICAgICAgICBhcmVhX2lkOiAne3thcmVhSWR9fScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBkZXNrX2Jvb2tpbmc6IHsgZGVza191dWlkOiAne3tkZXNrSWR9fScgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGNhbmNlbDoge1xuICAgICAgICAgICAgbWV0aG9kOiAnREVMRVRFJyxcbiAgICAgICAgICAgIC8vIE5vdGUgYC9tZS9gLCBub3QgYC91c2Vycy97e3VzZXJJZH19L2AgYXMgY3JlYXRlIHVzZXMsIGFuZCB0aGVcbiAgICAgICAgICAgIC8vIG51bWVyaWMgYm9va2luZyBpZCByYXRoZXIgdGhhbiBpdHMgdXVpZC4gQm90aCBjb25maXJtZWQgZnJvbSBhXG4gICAgICAgICAgICAvLyBjYXB0dXJlZCBjYW5jZWxsYXRpb247IG5laXRoZXIgaXMgd2hhdCB5b3Ugd291bGQgaGF2ZSBndWVzc2VkXG4gICAgICAgICAgICAvLyBmcm9tIHRoZSBjcmVhdGUgY2FsbC5cbiAgICAgICAgICAgIHBhdGg6ICcvdjEvbWUvd29ya19hY3Rpdml0eV9zY2hlZHVsZS97e2Jvb2tpbmdJZH19JyxcbiAgICAgICAgfSxcbiAgICB9LFxufTtcblxuLyoqXG4gKiBUaGUgb2ZmaWNlIHRoZXNlIGRlZmF1bHRzIGFyZSBmb3I6IEFwaWZ5J3MsIGluIFByYWd1ZSwgYXMgY2FwdHVyZWQgaW5cbiAqIEF1Z3VzdCAyMDI2LlxuICpcbiAqIFx1MjUwMFx1MjUwMFx1MjUwMCBXaHkgcmVhbCB2YWx1ZXMgYW5kIG5vdCBwbGFjZWhvbGRlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gKiBUaGVzZSBhcmUgbm90IHNlY3JldHMgXHUyMDE0IGFuIGlkIGlzIHVzZWxlc3Mgd2l0aG91dCBhIENvbWVlbiBzZXNzaW9uIGF0IHRoaXNcbiAqIGNvbXBhbnkgXHUyMDE0IGFuZCByZWFsIHZhbHVlcyBhcmUgd2hhdCBtYWtlIHRoZSBleHRlbnNpb24gd29yayB0aGUgbW9tZW50IGl0IGlzXG4gKiBpbnN0YWxsZWQuIFBsYWNlaG9sZGVycyB3b3VsZCBtYWtlIGl0IHdvcmsgZm9yIG5vYm9keSwgYW5kIHdvdWxkIHB1dCBcIm9wZW5cbiAqIERldlRvb2xzIGFuZCBmaW5kIHR3byBpZHNcIiBpbnRvIGEgc2V0dXAgZ3VpZGUgd3JpdHRlbiBmb3IgcGVvcGxlIHdobyBzaG91bGRcbiAqIG5ldmVyIGhhdmUgdG8gb3BlbiBEZXZUb29scy5cbiAqXG4gKiBcdTI1MDBcdTI1MDBcdTI1MDAgVXNpbmcgdGhpcyBzb21ld2hlcmUgZWxzZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAqIENoYW5nZSB0aGVzZSB0d28gY29uc3RhbnRzLiBOZWl0aGVyIG5lZWRzIHRoZSBzcGFjZSBVVUlELCBhbmQgYm90aCBhcmVcbiAqIHZpc2libGUgaW4gdGhlIE5ldHdvcmsgdGFiIHdpdGggdGhlIGZsb29yIHBsYW4gb3BlbjpcbiAqXG4gKiAgIGZsb29ySWQgICAgIGluIHRoZSBVUkwgb2YgdGhlIGRlc2tzX3NjaGVkdWxlLmpzb24gcmVxdWVzdCwgYW5kIGFnYWluIGFzXG4gKiAgICAgICAgICAgICAgIGBmbG9vcl9pZGAgb24gZXZlcnkgZGVzayBpbiBpdHMgcmVzcG9uc2VcbiAqICAgYnVpbGRpbmdJZCAgYXMgYGlkYCBpbiB0aGUgYnVpbGRpbmdzLmpzb24gcmVzcG9uc2UsIHdoaWNoIGFsc28gbGlzdHMgZXZlcnlcbiAqICAgICAgICAgICAgICAgZmxvb3Igd2l0aCBpdHMgaWQgYW5kIG5hbWUgXHUyMDE0IGVub3VnaCB0byBmaWxsIGluIEZMT09SUyB0b29cbiAqXG4gKiBIYXJkY29kZWQgcmF0aGVyIHRoYW4gZmV0Y2hlZCBhdCBydW50aW1lOiB0aGUgZmxvb3IgZHJvcGRvd24gaGFzIHRvIGJlXG4gKiBwb3B1bGF0ZWQgYmVmb3JlIGFueSBuZXR3b3JrIGNhbGwgaGFwcGVucywgYW4gb2ZmaWNlIGxheW91dCBjaGFuZ2VzIGFib3V0XG4gKiBuZXZlciwgYW5kIHRoZSBvbmUgZW5kcG9pbnQgdGhhdCB3b3VsZCByZXR1cm4gYWxsIG9mIHRoaXMgbmVlZHMgYSBzcGFjZSBVVUlEXG4gKiB0aGF0IGRvZXMgbm90IGFwcGVhciBpbiBhbnkgb3RoZXIgcmVzcG9uc2UsIHNvIGZldGNoaW5nIHdvdWxkIGJ1eSBhIG5ldHdvcmtcbiAqIGNhbGwgYW5kIGEgZmFpbHVyZSBwYXRoIHdpdGhvdXQgcmVtb3ZpbmcgdGhlIGNvbnN0YW50LlxuICovXG5leHBvcnQgY29uc3QgQlVJTERJTkcgPSB7IGlkOiA1MTUxLCBuYW1lOiAnMTAweWFyZHMnIH07XG5cbi8qKlxuICogQSBkZXNrIG5hbWUgaXMgZGlnaXRzLCBhIGRhc2gsIGRpZ2l0cyBcdTIwMTQgYDMtMjNgLCBgMTItNGAuXG4gKlxuICogRGVsaWJlcmF0ZWx5IG5vdCB0aWdodGVuZWQgdG8gdHdvIHplcm8tcGFkZGVkIGRpZ2l0cywgd2hpY2ggaXMgd2hhdCB0aGlzXG4gKiBvZmZpY2UgaGFwcGVucyB0byB1c2U6IGEgZmxvb3IgMTIgb3IgYSBkZXNrIDEwMCB3b3VsZCB0aGVuIGJlIHJlamVjdGVkIGZvclxuICogbG9va2luZyB3cm9uZyByYXRoZXIgdGhhbiBmb3IgYmVpbmcgd3JvbmcuIFdoYXQgdGhpcyBjYXRjaGVzIGlzIHRoZSBtaXN0YWtlXG4gKiBwZW9wbGUgYWN0dWFsbHkgbWFrZSBcdTIwMTQgdHlwaW5nIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBhIGRlc2sgbnVtYmVyIGF0IGFsbDogYVxuICogbmFtZSwgYSByb29tLCBhIHN0cmF5IHNwYWNlLlxuICovXG5leHBvcnQgY29uc3QgREVTS19OQU1FX1BBVFRFUk4gPSAvXlxcZCstXFxkKyQvO1xuXG4vKiogRW1wdHkgaXMgbm90IHZhbGlkLCBidXQgaXQgaXMgbm90IGFuIGVycm9yIGVpdGhlciBcdTIwMTQgc2VlIHRoZSBwb3B1cC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ZhbGlkRGVza05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIERFU0tfTkFNRV9QQVRURVJOLnRlc3QobmFtZS50cmltKCkpO1xufVxuXG4vKipcbiAqIERyb3Agc2tpcCBkYXRlcyB0aGF0IGhhdmUgYWxyZWFkeSBwYXNzZWQuXG4gKlxuICogRGF5cyBjYW4gYmUgbWFya2VkIG1vbnRocyBhaGVhZCwgc28gd2l0aG91dCB0aGlzIHRoZSBsaXN0IG9ubHkgZXZlciBncm93cyBcdTIwMTRcbiAqIGEgeWVhciBvZiBcIkkgd2FzIGF3YXkgdGhhdCBUdWVzZGF5XCIgYWNjdW11bGF0aW5nIGluIHN0b3JhZ2UgYW5kIGluIHRoZVxuICogc2V0dGluZ3MgSlNPTiwgd2hlcmUgaXQgaXMgbm9pc2UgdGhhdCBtYWtlcyB0aGUgcmVhbCBlbnRyaWVzIGhhcmQgdG8gcmVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBydW5lUGFzdFNraXBEYXRlcyhza2lwRGF0ZXM6IHN0cmluZ1tdLCB0b2RheTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIHJldHVybiBza2lwRGF0ZXMuZmlsdGVyKChkYXRlKSA9PiBkYXRlID49IHRvZGF5KTtcbn1cblxuZXhwb3J0IGNvbnN0IEZMT09SUzogeyBpZDogbnVtYmVyOyBsYWJlbDogc3RyaW5nIH1bXSA9IFtcbiAgICB7IGlkOiA0OTUyLCBsYWJlbDogJ0Zsb29yIDMnIH0sXG4gICAgeyBpZDogNDk1MywgbGFiZWw6ICdGbG9vciA0JyB9LFxuXTtcblxuZXhwb3J0IHR5cGUgVmFycyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbi8qKlxuICogQSBwbGFjZWhvbGRlciB0aGF0IG1ha2VzIHVwIHRoZSAqZW50aXJlKiB2YWx1ZSBhbmQgcmVzb2x2ZXMgdG8gYW4gaW50ZWdlclxuICogYmVjb21lcyBhIG51bWJlci5cbiAqXG4gKiBUaGlzIG1hdHRlcnMgYmVjYXVzZSBKU09OIGRpc3Rpbmd1aXNoZXMgNTE1MSBmcm9tIFwiNTE1MVwiIGFuZCBDb21lZW4nc1xuICogcHJlc2VuY2UgYmxvY2sgd2FudHMgdGhlIGZvcm1lci4gUGFydGlhbCBpbnRlcnBvbGF0aW9uIFx1MjAxNCBcIi91c2Vycy97e3VzZXJJZH19L3hcIlxuICogXHUyMDE0IGFsd2F5cyB5aWVsZHMgYSBzdHJpbmcsIHdoaWNoIGlzIHdoYXQgYSBwYXRoIG5lZWRzLCBzbyB0aGUgdHdvIGNhc2VzIG5ldmVyXG4gKiBjb2xsaWRlLiBBIHV1aWQgb3IgYSBkYXRlIGNvbnRhaW5zIG5vbi1kaWdpdHMgYW5kIHN0YXlzIGEgc3RyaW5nIGVpdGhlciB3YXkuXG4gKi9cbmNvbnN0IFdIT0xFX1BMQUNFSE9MREVSID0gL15cXHtcXHsoXFx3KylcXH1cXH0kLztcbmNvbnN0IElOVEVHRVIgPSAvXi0/XFxkKyQvO1xuXG4vKiogUmVwbGFjZSB7e3BsYWNlaG9sZGVyc319IHRocm91Z2hvdXQgYSBKU09OLWlzaCB2YWx1ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdWJzdGl0dXRlKHZhbHVlOiB1bmtub3duLCB2YXJzOiBWYXJzKTogdW5rbm93biB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgY29uc3Qgd2hvbGUgPSBXSE9MRV9QTEFDRUhPTERFUi5leGVjKHZhbHVlKTtcbiAgICAgICAgaWYgKHdob2xlKSB7XG4gICAgICAgICAgICBjb25zdCByZXBsYWNlbWVudCA9IHZhcnNbd2hvbGVbMV0gPz8gJyddO1xuICAgICAgICAgICAgaWYgKHJlcGxhY2VtZW50ID09PSB1bmRlZmluZWQpIHJldHVybiB2YWx1ZTtcbiAgICAgICAgICAgIHJldHVybiBJTlRFR0VSLnRlc3QocmVwbGFjZW1lbnQpID8gTnVtYmVyKHJlcGxhY2VtZW50KSA6IHJlcGxhY2VtZW50O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9cXHtcXHsoXFx3KylcXH1cXH0vZywgKG1hdGNoLCBrZXk6IHN0cmluZykgPT4gdmFyc1trZXldID8/IG1hdGNoKTtcbiAgICB9XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZS5tYXAoKGVudHJ5KSA9PiBzdWJzdGl0dXRlKGVudHJ5LCB2YXJzKSk7XG4gICAgfVxuICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCBlbnRyeV0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUpKSBvdXRba2V5XSA9IHN1YnN0aXR1dGUoZW50cnksIHZhcnMpO1xuICAgICAgICByZXR1cm4gb3V0O1xuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG5cbi8qKlxuICogTWVyZ2Ugc3RvcmVkIHNldHRpbmdzIG92ZXIgdGhlIHNoaXBwZWQgZGVmYXVsdHMuXG4gKlxuICogUGVyc29uYWwgY2hvaWNlcyAoZGVzaywgd2Vla2RheXMsIHRpbWV6b25lKSBhbHdheXMgd2luOiB0aGV5IGFyZSB0aGUgdXNlcidzLlxuICogVGhlIGVuZHBvaW50IGNvbmZpZyBpcyBkaWZmZXJlbnQuIEl0IGlzIG5vdCBhIHByZWZlcmVuY2UsIGl0IGlzIGEgZmFjdCBhYm91dFxuICogQ29tZWVuJ3MgQVBJIHRoYXQgb25lIHBlcnNvbiBkaXNjb3ZlcnMgYW5kIGV2ZXJ5b25lIGVsc2UgaW5oZXJpdHMuIElmIGFcbiAqIHN0b3JlZCBjb3B5IHByZWRhdGVzIHRoZSBzaGlwcGVkIG9uZSwgdGhlIHNoaXBwZWQgb25lIHJlcGxhY2VzIGl0IG91dHJpZ2h0LlxuICogTWVyZ2luZyBrZXktYnkta2V5IHdvdWxkIGJlIHdvcnNlIHRoYW4gdXNlbGVzcyBoZXJlOiBhIGNvcnJlY3RlZCBgY3JlYXRlYFxuICogYmxvY2sgd291bGQgc2l0IG5leHQgdG8gYSBzdGFsZSBgbGlzdGAgYmxvY2sgYW5kIGZhaWwgaW4gYSBjb25mdXNpbmcgd2F5LlxuICpcbiAqIFB1cmUgYW5kIHNlcGFyYXRlIGZyb20gY2hyb21lLnN0b3JhZ2Ugc28gaXQgY2FuIGJlIHRlc3RlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlU2V0dGluZ3Moc3RvcmVkOiBQYXJ0aWFsPFNldHRpbmdzPiB8IHVuZGVmaW5lZCk6IFNldHRpbmdzIHtcbiAgICBjb25zdCBzdG9yZWRWZXJzaW9uID0gc3RvcmVkPy5lbmRwb2ludFZlcnNpb24gPz8gMDtcbiAgICBjb25zdCBzaGlwcGVkSXNOZXdlciA9IHN0b3JlZFZlcnNpb24gPCBERUZBVUxUX1NFVFRJTkdTLmVuZHBvaW50VmVyc2lvbjtcblxuICAgIHJldHVybiB7XG4gICAgICAgIC4uLkRFRkFVTFRfU0VUVElOR1MsXG4gICAgICAgIC4uLnN0b3JlZCxcbiAgICAgICAgZW5kcG9pbnRWZXJzaW9uOiBERUZBVUxUX1NFVFRJTkdTLmVuZHBvaW50VmVyc2lvbixcbiAgICAgICAgZW5kcG9pbnQ6IHNoaXBwZWRJc05ld2VyIHx8ICFzdG9yZWQ/LmVuZHBvaW50XG4gICAgICAgICAgICA/IERFRkFVTFRfU0VUVElOR1MuZW5kcG9pbnRcbiAgICAgICAgICAgIDogc3RvcmVkLmVuZHBvaW50LFxuICAgIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTxTZXR0aW5ncz4ge1xuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgnc2V0dGluZ3MnKTtcbiAgICByZXR1cm4gbWVyZ2VTZXR0aW5ncyhzdG9yZWQuc2V0dGluZ3MgYXMgUGFydGlhbDxTZXR0aW5ncz4gfCB1bmRlZmluZWQpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2F2ZVNldHRpbmdzKHNldHRpbmdzOiBTZXR0aW5ncyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IHNldHRpbmdzIH0pO1xufVxuIiwgImV4cG9ydCB0eXBlIFdlZWtkYXkgPVxuICAgIHwgJ21vbmRheScgfCAndHVlc2RheScgfCAnd2VkbmVzZGF5J1xuICAgIHwgJ3RodXJzZGF5JyB8ICdmcmlkYXknIHwgJ3NhdHVyZGF5JyB8ICdzdW5kYXknO1xuXG5jb25zdCBXRUVLREFZX05BTUVTOiByZWFkb25seSBXZWVrZGF5W10gPSBbXG4gICAgJ3N1bmRheScsICdtb25kYXknLCAndHVlc2RheScsICd3ZWRuZXNkYXknLCAndGh1cnNkYXknLCAnZnJpZGF5JywgJ3NhdHVyZGF5Jyxcbl07XG5cbmZ1bmN0aW9uIGlzV2Vla2RheSh2YWx1ZTogc3RyaW5nKTogdmFsdWUgaXMgV2Vla2RheSB7XG4gICAgcmV0dXJuIChXRUVLREFZX05BTUVTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyh2YWx1ZSk7XG59XG5cbi8qKiBGb3JtYXQgYSBEYXRlIGFzIFlZWVktTU0tREQgYXMgc2VlbiBpbiBgdGltZVpvbmVgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvTG9jYWxJU09EYXRlKGRhdGU6IERhdGUsIHRpbWVab25lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tQ0EnLCB7XG4gICAgICAgIHRpbWVab25lLCB5ZWFyOiAnbnVtZXJpYycsIG1vbnRoOiAnMi1kaWdpdCcsIGRheTogJzItZGlnaXQnLFxuICAgIH0pLmZvcm1hdChkYXRlKTtcbn1cblxuLyoqIFdlZWtkYXkgbmFtZSBvZiBgZGF0ZWAgYXMgc2VlbiBpbiBgdGltZVpvbmVgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2FsV2Vla2RheShkYXRlOiBEYXRlLCB0aW1lWm9uZTogc3RyaW5nKTogV2Vla2RheSB7XG4gICAgY29uc3QgbmFtZSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1VUycsIHsgdGltZVpvbmUsIHdlZWtkYXk6ICdsb25nJyB9KVxuICAgICAgICAuZm9ybWF0KGRhdGUpXG4gICAgICAgIC50b0xvd2VyQ2FzZSgpO1xuICAgIGlmICghaXNXZWVrZGF5KG5hbWUpKSB0aHJvdyBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgd2Vla2RheSBmcm9tIEludGw6IFwiJHtuYW1lfVwiYCk7XG4gICAgcmV0dXJuIG5hbWU7XG59XG5cbi8qKiBMb2NhbCB3YWxsLWNsb2NrIHRpbWUgYXMgYFlZWVktTU0tRERUSEg6bW06c3NgLCBtYXRjaGluZyB3aGF0IENvbWVlbiBzZW5kcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b0xvY2FsSVNPRGF0ZVRpbWUoZGF0ZTogRGF0ZSwgdGltZVpvbmU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgcGFydHMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tQ0EnLCB7XG4gICAgICAgIHRpbWVab25lLFxuICAgICAgICB5ZWFyOiAnbnVtZXJpYycsIG1vbnRoOiAnMi1kaWdpdCcsIGRheTogJzItZGlnaXQnLFxuICAgICAgICBob3VyOiAnMi1kaWdpdCcsIG1pbnV0ZTogJzItZGlnaXQnLCBzZWNvbmQ6ICcyLWRpZ2l0JyxcbiAgICAgICAgaG91cjEyOiBmYWxzZSxcbiAgICB9KS5mb3JtYXRUb1BhcnRzKGRhdGUpO1xuICAgIGNvbnN0IGdldCA9ICh0eXBlOiBzdHJpbmcpOiBzdHJpbmcgPT4gcGFydHMuZmluZCgocGFydCkgPT4gcGFydC50eXBlID09PSB0eXBlKT8udmFsdWUgPz8gJzAwJztcbiAgICAvLyBJbnRsIHJlbmRlcnMgbWlkbmlnaHQgYXMgMjQgaW4gc29tZSBsb2NhbGVzL2VuZ2luZXMuXG4gICAgY29uc3QgaG91ciA9IGdldCgnaG91cicpID09PSAnMjQnID8gJzAwJyA6IGdldCgnaG91cicpO1xuICAgIHJldHVybiBgJHtnZXQoJ3llYXInKX0tJHtnZXQoJ21vbnRoJyl9LSR7Z2V0KCdkYXknKX1UJHtob3VyfToke2dldCgnbWludXRlJyl9OiR7Z2V0KCdzZWNvbmQnKX1gO1xufVxuXG4vKipcbiAqIEhhcyB0aGlzIGRheSdzIHNsb3QgYWxyZWFkeSBiZWd1bj9cbiAqXG4gKiBDb21lZW4gcmVmdXNlcyBhIGJvb2tpbmcgd2hvc2Ugc3RhcnQgdGltZSBpcyBpbiB0aGUgcGFzdCBcdTIwMTQgd2l0aCBhIDUwMCByYXRoZXJcbiAqIHRoYW4gYW55dGhpbmcgaGVscGZ1bCwgYW5kIGl0IHJlZnVzZXMgaXRzIG93biB3ZWIgVUkganVzdCB0aGUgc2FtZSwgc28gdGhpc1xuICogaXMgaXRzIGJlaGF2aW91ciBhbmQgbm90IHNvbWV0aGluZyB3ZSBhcmUgZG9pbmcgd3JvbmcuIEZvciBhbiBhbGwtZGF5IHNsb3RcbiAqIHRoZSBzdGFydCBpcyBtaWRuaWdodCwgc28gdG9kYXkgaXMgdW5ib29rYWJsZSBmcm9tIG9uZSBzZWNvbmQgcGFzdCBtaWRuaWdodFxuICogb253YXJkcy4gRm9yIGFuIGFmdGVybm9vbiBzbG90LCB0b2RheSBzdGF5cyBib29rYWJsZSB1bnRpbCBub29uLlxuICpcbiAqIEJvdGggc2lkZXMgYXJlIG5haXZlIGxvY2FsIHdhbGwtY2xvY2ssIHdoaWNoIGlzIHRoZSB3aG9sZSBjb252ZW50aW9uIENvbWVlblxuICogdXNlcywgc28gYSBzdHJpbmcgY29tcGFyaXNvbiBpcyBleGFjdGx5IHJpZ2h0IGhlcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNTbG90U3RhcnRlZChcbiAgICBkYXRlOiBzdHJpbmcsXG4gICAgc3RhcnRUaW1lOiBzdHJpbmcsXG4gICAgdGltZVpvbmU6IHN0cmluZyxcbiAgICBub3cgPSBuZXcgRGF0ZSgpLFxuKTogYm9vbGVhbiB7XG4gICAgY29uc3Qgc3RhcnQgPSBgJHtkYXRlfVQke3N0YXJ0VGltZS5yZXBsYWNlKC9cXC5cXGQrWj8kLywgJycpLnJlcGxhY2UoL1okLywgJycpfWA7XG4gICAgcmV0dXJuIHRvTG9jYWxJU09EYXRlVGltZShub3csIHRpbWVab25lKSA+PSBzdGFydDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEYXRlc1RvQm9va09wdGlvbnMge1xuICAgIHdlZWtkYXlzOiBzdHJpbmdbXTtcbiAgICBob3Jpem9uRGF5cz86IG51bWJlcjtcbiAgICBza2lwRGF0ZXM/OiBzdHJpbmdbXTtcbiAgICB0aW1lWm9uZT86IHN0cmluZztcbiAgICBub3c/OiBEYXRlO1xufVxuXG4vKipcbiAqIEV2ZXJ5IGRheSBmcm9tIHRvZGF5IChpbmNsdXNpdmUpIHVwIHRvIGBob3Jpem9uRGF5c2AgYWhlYWQgd2hvc2Ugd2Vla2RheSBpc1xuICogaW4gYHdlZWtkYXlzYCwgbWludXMgYHNraXBEYXRlc2AuXG4gKlxuICogVGhlIDE0LWRheSBkZWZhdWx0IGlzIHdoYXQgbWFrZXMgdW5yZWxpYWJsZSBzY2hlZHVsaW5nIGFjY2VwdGFibGU6IGVhY2ggcnVuXG4gKiB0b3BzIHRoZSB3aG9sZSB3aW5kb3cgYmFjayB1cCwgc28gbWlzc2luZyBhIGRheSAobGFwdG9wIHNodXQsIENocm9tZSBjbG9zZWQpXG4gKiBjb3N0cyBub3RoaW5nIGFzIGxvbmcgYXMgdGhlIGV4dGVuc2lvbiBydW5zIGFnYWluIGJlZm9yZSB0aGUgd2luZG93IGRyYWlucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRhdGVzVG9Cb29rKHtcbiAgICB3ZWVrZGF5cyxcbiAgICBob3Jpem9uRGF5cyA9IDE0LFxuICAgIHNraXBEYXRlcyA9IFtdLFxuICAgIHRpbWVab25lID0gJ0V1cm9wZS9QcmFndWUnLFxuICAgIG5vdyA9IG5ldyBEYXRlKCksXG59OiBEYXRlc1RvQm9va09wdGlvbnMpOiBzdHJpbmdbXSB7XG4gICAgY29uc3Qgd2FudGVkID0gbmV3IFNldDxXZWVrZGF5PigpO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIHdlZWtkYXlzKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSByYXcudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgaWYgKCFpc1dlZWtkYXkobmFtZSkpIHRocm93IG5ldyBFcnJvcihgTm90IGEgd2Vla2RheSBuYW1lOiBcIiR7cmF3fVwiYCk7XG4gICAgICAgIHdhbnRlZC5hZGQobmFtZSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoc2tpcERhdGVzKTtcbiAgICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG5cbiAgICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPD0gaG9yaXpvbkRheXM7IG9mZnNldCArPSAxKSB7XG4gICAgICAgIGNvbnN0IGRheSA9IG5ldyBEYXRlKG5vdy5nZXRUaW1lKCkgKyBvZmZzZXQgKiA4Nl80MDBfMDAwKTtcbiAgICAgICAgY29uc3QgaXNvID0gdG9Mb2NhbElTT0RhdGUoZGF5LCB0aW1lWm9uZSk7XG4gICAgICAgIGlmICghd2FudGVkLmhhcyhsb2NhbFdlZWtkYXkoZGF5LCB0aW1lWm9uZSkpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNraXAuaGFzKGlzbykpIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaChpc28pO1xuICAgIH1cblxuICAgIHJldHVybiBvdXQ7XG59XG4iLCAiaW1wb3J0IHtcbiAgICBCVUlMRElORyxcbiAgICBERUZBVUxUX1NFVFRJTkdTLFxuICAgIEZMT09SUyxcbiAgICBpc1ZhbGlkRGVza05hbWUsXG4gICAgbG9hZFNldHRpbmdzLFxuICAgIG1lcmdlU2V0dGluZ3MsXG4gICAgcHJ1bmVQYXN0U2tpcERhdGVzLFxuICAgIFNMT1RfVElNRVMsXG4gICAgc2F2ZVNldHRpbmdzLFxuICAgIHR5cGUgRW5kcG9pbnRDb25maWcsXG4gICAgdHlwZSBTZXR0aW5ncyxcbiAgICB0eXBlIFNsb3QsXG59IGZyb20gJy4vY29yZS9jb25maWcuanMnO1xuaW1wb3J0IHtcbiAgICBkYXRlc1RvQm9vayxcbiAgICBoYXNTbG90U3RhcnRlZCxcbiAgICBsb2NhbFdlZWtkYXksXG4gICAgdG9Mb2NhbElTT0RhdGUsXG4gICAgdHlwZSBXZWVrZGF5LFxufSBmcm9tICcuL2NvcmUvZGF0ZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBSdW5Mb2cgfSBmcm9tICcuL2JhY2tncm91bmQuanMnO1xuXG5jb25zdCBEQVlTOiBXZWVrZGF5W10gPSBbJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknLCAnc2F0dXJkYXknLCAnc3VuZGF5J107XG5cbi8qKiBNb25kYXktZmlyc3QsIHRvIG1hdGNoIGhvdyBhIHdvcmtpbmcgd2VlayBpcyByZWFkLiAqL1xuY29uc3QgRE9XX0xBQkVMUyA9IFsnTW8nLCAnVHUnLCAnV2UnLCAnVGgnLCAnRnInLCAnU2EnLCAnU3UnXTtcblxuZnVuY3Rpb24gZWw8VCBleHRlbmRzIEhUTUxFbGVtZW50PihpZDogc3RyaW5nKTogVCB7XG4gICAgY29uc3Qgbm9kZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTtcbiAgICBpZiAoIW5vZGUpIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyBlbGVtZW50ICMke2lkfWApO1xuICAgIHJldHVybiBub2RlIGFzIFQ7XG59XG5cbmNvbnN0IGZpZWxkcyA9IHtcbiAgICBlbmFibGVkOiBlbDxIVE1MSW5wdXRFbGVtZW50PignZW5hYmxlZCcpLFxuICAgIGRlc2tOYW1lOiBlbDxIVE1MSW5wdXRFbGVtZW50PignZGVza05hbWUnKSxcbiAgICBkZXNrSWQ6IGVsPEhUTUxJbnB1dEVsZW1lbnQ+KCdkZXNrSWQnKSxcbiAgICBmbG9vcklkOiBlbDxIVE1MU2VsZWN0RWxlbWVudD4oJ2Zsb29ySWQnKSxcbiAgICBzbG90OiBlbDxIVE1MU2VsZWN0RWxlbWVudD4oJ3Nsb3QnKSxcbiAgICBob3Jpem9uRGF5czogZWw8SFRNTElucHV0RWxlbWVudD4oJ2hvcml6b25EYXlzJyksXG4gICAgdGltZVpvbmU6IGVsPEhUTUxJbnB1dEVsZW1lbnQ+KCd0aW1lWm9uZScpLFxuICAgIGVuZHBvaW50OiBlbDxIVE1MVGV4dEFyZWFFbGVtZW50PignZW5kcG9pbnQnKSxcbiAgICBsZWFybk1vZGU6IGVsPEhUTUxJbnB1dEVsZW1lbnQ+KCdsZWFybk1vZGUnKSxcbn07XG5cbi8vIFx1MjUwMFx1MjUwMCBzdGF0aWMgb2ZmaWNlIGZhY3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuZWw8SFRNTFNwYW5FbGVtZW50PignYnVpbGRpbmdOYW1lJykudGV4dENvbnRlbnQgPSBCVUlMRElORy5uYW1lO1xuXG5mb3IgKGNvbnN0IGZsb29yIG9mIEZMT09SUykge1xuICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xuICAgIG9wdGlvbi52YWx1ZSA9IFN0cmluZyhmbG9vci5pZCk7XG4gICAgb3B0aW9uLnRleHRDb250ZW50ID0gZmxvb3IubGFiZWw7XG4gICAgZmllbGRzLmZsb29ySWQuYXBwZW5kKG9wdGlvbik7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCB3ZWVrZGF5IGNoaXBzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuY29uc3QgZGF5c0hvc3QgPSBlbDxIVE1MRGl2RWxlbWVudD4oJ2RheXMnKTtcbmZvciAoY29uc3QgZGF5IG9mIERBWVMpIHtcbiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7XG4gICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcbiAgICBib3gudHlwZSA9ICdjaGVja2JveCc7XG4gICAgYm94LnZhbHVlID0gZGF5O1xuICAgIGJveC5kYXRhc2V0LmRheSA9IGRheTtcbiAgICBsYWJlbC5hcHBlbmQoYm94LCBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShkYXkuc2xpY2UoMCwgMykpKTtcbiAgICBkYXlzSG9zdC5hcHBlbmQobGFiZWwpO1xufVxuXG5mdW5jdGlvbiBzZWxlY3RlZERheXMoKTogV2Vla2RheVtdIHtcbiAgICByZXR1cm4gWy4uLmRheXNIb3N0LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oJ2lucHV0OmNoZWNrZWQnKV1cbiAgICAgICAgLm1hcCgoYm94KSA9PiBib3gudmFsdWUgYXMgV2Vla2RheSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBzdGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFNldHRpbmdzIGF1dG8tc2F2ZSwgc28gdGhpcyBpcyB0aGUgbGl2ZSBjb3B5IHJhdGhlciB0aGFuIGEgc25hcHNob3QgdGFrZW4gYXRcbi8vIGxvYWQuIHNraXBEYXRlcyBpbiBwYXJ0aWN1bGFyIGlzIG11dGF0ZWQgYnkgY2xpY2tpbmcgdGhlIGNhbGVuZGFyLlxubGV0IGN1cnJlbnQ6IFNldHRpbmdzID0gYXdhaXQgbG9hZFNldHRpbmdzKCk7XG5cbi8qKlxuICogVGhlIG1vc3QgcmVjZW50IHJ1biwgc28gdGhlIGNhbGVuZGFyIGNhbiBzaG93IHdoYXQgd2FzIGFjdHVhbGx5IGZvdW5kIHJhdGhlclxuICogdGhhbiBvbmx5IHdoYXQgaXMgcGxhbm5lZC4gQ29tZXMgZnJvbSBzdG9yYWdlIG9uIG9wZW4gYW5kIGlzIHJlcGxhY2VkIGFmdGVyXG4gKiBldmVyeSBydW4uXG4gKi9cbmxldCBsYXN0TG9nOiBSdW5Mb2cgfCB1bmRlZmluZWQ7XG5cbmZ1bmN0aW9uIHJlbmRlclNldHRpbmdzKG5leHQ6IFNldHRpbmdzKTogdm9pZCB7XG4gICAgZmllbGRzLmVuYWJsZWQuY2hlY2tlZCA9IG5leHQuZW5hYmxlZDtcbiAgICBmaWVsZHMuZGVza05hbWUudmFsdWUgPSBuZXh0LmRlc2tOYW1lO1xuICAgIGZpZWxkcy5kZXNrSWQudmFsdWUgPSBuZXh0LmRlc2tJZDtcbiAgICBmaWVsZHMuZmxvb3JJZC52YWx1ZSA9IFN0cmluZyhuZXh0LmZsb29ySWQpO1xuICAgIGZpZWxkcy5zbG90LnZhbHVlID0gbmV4dC5zbG90O1xuICAgIGZpZWxkcy5ob3Jpem9uRGF5cy52YWx1ZSA9IFN0cmluZyhuZXh0Lmhvcml6b25EYXlzKTtcbiAgICBmaWVsZHMudGltZVpvbmUudmFsdWUgPSBuZXh0LnRpbWVab25lO1xuICAgIGZpZWxkcy5lbmRwb2ludC52YWx1ZSA9IEpTT04uc3RyaW5naWZ5KG5leHQuZW5kcG9pbnQsIG51bGwsIDIpO1xuICAgIGVsPEhUTUxTcGFuRWxlbWVudD4oJ3RpbWVab25lTGFiZWwnKS50ZXh0Q29udGVudCA9IG5leHQudGltZVpvbmU7XG4gICAgZm9yIChjb25zdCBib3ggb2YgZGF5c0hvc3QucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50PignaW5wdXQnKSkge1xuICAgICAgICBib3guY2hlY2tlZCA9IG5leHQud2Vla2RheXMuaW5jbHVkZXMoYm94LnZhbHVlIGFzIFdlZWtkYXkpO1xuICAgIH1cbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBmb3JtIGJhY2sgaW50byBhIFNldHRpbmdzLlxuICpcbiAqIFRoZSBlbmRwb2ludCB0ZXh0YXJlYSBpcyB0aGUgb25lIGZpZWxkIHRoYXQgY2FuIGJlIG1pZC1lZGl0IGFuZCB1bnBhcnNlYWJsZS5cbiAqIEF1dG8tc2F2ZSBydW5zIG9uIGV2ZXJ5IGtleXN0cm9rZSwgc28gYSBoYWxmLXR5cGVkIGJyYWNlIG11c3Qgbm90IHRocm93IGF3YXlcbiAqIHRoZSB3b3JraW5nIGNvbmZpZzogdGhlIGxhc3QgZ29vZCB2YWx1ZSBpcyBrZXB0IGFuZCB0aGUgY2FsbGVyIGlzIHRvbGQuXG4gKi9cbmZ1bmN0aW9uIGNvbGxlY3QoKTogeyBzZXR0aW5nczogU2V0dGluZ3M7IGVuZHBvaW50RXJyb3I/OiBzdHJpbmcgfSB7XG4gICAgbGV0IGVuZHBvaW50OiBFbmRwb2ludENvbmZpZyA9IGN1cnJlbnQuZW5kcG9pbnQ7XG4gICAgbGV0IGVuZHBvaW50RXJyb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICB0cnkge1xuICAgICAgICBlbmRwb2ludCA9IEpTT04ucGFyc2UoZmllbGRzLmVuZHBvaW50LnZhbHVlKSBhcyBFbmRwb2ludENvbmZpZztcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgZW5kcG9pbnRFcnJvciA9IGBFbmRwb2ludCBjb25maWcgaXMgbm90IHZhbGlkIEpTT046ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICAgIHNldHRpbmdzOiB7XG4gICAgICAgICAgICAvLyBTYXZpbmcgc3RhbXBzIHRoZSB2ZXJzaW9uIHRoZSB1c2VyIGhhcyBhY3R1YWxseSBzZWVuLCBzbyBhIGxhdGVyXG4gICAgICAgICAgICAvLyBidWlsZCB3aXRoIGEgY29ycmVjdGVkIGNvbnRyYWN0IHN0aWxsIHN1cGVyc2VkZXMgdGhpcy5cbiAgICAgICAgICAgIGVuZHBvaW50VmVyc2lvbjogY3VycmVudC5lbmRwb2ludFZlcnNpb24sXG4gICAgICAgICAgICBlbmFibGVkOiBmaWVsZHMuZW5hYmxlZC5jaGVja2VkLFxuICAgICAgICAgICAgICAgIGRlc2tOYW1lOiBmaWVsZHMuZGVza05hbWUudmFsdWUudHJpbSgpLFxuICAgICAgICAgICAgZGVza0lkOiBmaWVsZHMuZGVza0lkLnZhbHVlLnRyaW0oKSxcbiAgICAgICAgICAgIGZsb29ySWQ6IE51bWJlcihmaWVsZHMuZmxvb3JJZC52YWx1ZSkgfHwgREVGQVVMVF9TRVRUSU5HUy5mbG9vcklkLFxuICAgICAgICAgICAgLy8gRml4ZWQ6IHRoZXJlIGlzIG9uZSBidWlsZGluZywgYW5kIGl0IGlzIHNob3duIGFzIHRleHQsIG5vdCBlZGl0ZWQuXG4gICAgICAgICAgICBidWlsZGluZ0lkOiBCVUlMRElORy5pZCxcbiAgICAgICAgICAgIHdlZWtkYXlzOiBzZWxlY3RlZERheXMoKSxcbiAgICAgICAgICAgIHNsb3Q6IGZpZWxkcy5zbG90LnZhbHVlIGFzIFNsb3QsXG4gICAgICAgICAgICBob3Jpem9uRGF5czogTnVtYmVyKGZpZWxkcy5ob3Jpem9uRGF5cy52YWx1ZSkgfHwgREVGQVVMVF9TRVRUSU5HUy5ob3Jpem9uRGF5cyxcbiAgICAgICAgICAgIC8vIE93bmVkIGJ5IHRoZSBjYWxlbmRhciwgbm90IGJ5IGFueSBmb3JtIGZpZWxkLiBQcnVuZWQgb24gZXZlcnlcbiAgICAgICAgICAgIC8vIHNhdmUgc28gbW9udGhzIG9mIHBhc3QgZW50cmllcyBkbyBub3QgcGlsZSB1cC5cbiAgICAgICAgICAgIGNhbmNlbERhdGVzOiBwcnVuZVBhc3RTa2lwRGF0ZXMoXG4gICAgICAgICAgICAgICAgY3VycmVudC5jYW5jZWxEYXRlcyxcbiAgICAgICAgICAgICAgICB0b0xvY2FsSVNPRGF0ZShuZXcgRGF0ZSgpLCBmaWVsZHMudGltZVpvbmUudmFsdWUudHJpbSgpIHx8IERFRkFVTFRfU0VUVElOR1MudGltZVpvbmUpLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIHNraXBEYXRlczogcHJ1bmVQYXN0U2tpcERhdGVzKFxuICAgICAgICAgICAgICAgIGN1cnJlbnQuc2tpcERhdGVzLFxuICAgICAgICAgICAgICAgIHRvTG9jYWxJU09EYXRlKG5ldyBEYXRlKCksIGZpZWxkcy50aW1lWm9uZS52YWx1ZS50cmltKCkgfHwgREVGQVVMVF9TRVRUSU5HUy50aW1lWm9uZSksXG4gICAgICAgICAgICApLFxuICAgICAgICAgICAgdGltZVpvbmU6IGZpZWxkcy50aW1lWm9uZS52YWx1ZS50cmltKCkgfHwgREVGQVVMVF9TRVRUSU5HUy50aW1lWm9uZSxcbiAgICAgICAgICAgIGVuZHBvaW50LFxuICAgICAgICB9LFxuICAgICAgICBlbmRwb2ludEVycm9yLFxuICAgIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMCB0aGUgYm9va2luZyBwbGFuIGNhbGVuZGFyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBwYWQgPSAodmFsdWU6IG51bWJlcik6IHN0cmluZyA9PiBTdHJpbmcodmFsdWUpLnBhZFN0YXJ0KDIsICcwJyk7XG5jb25zdCBpc29Gb3IgPSAoeWVhcjogbnVtYmVyLCBtb250aDogbnVtYmVyLCBkYXk6IG51bWJlcik6IHN0cmluZyA9PlxuICAgIGAke3llYXJ9LSR7cGFkKG1vbnRoICsgMSl9LSR7cGFkKGRheSl9YDtcblxuLyoqXG4gKiBUd28gbW9udGhzIG9mIGRheXMsIHdpdGggdGhlIG9uZXMgdGhhdCB3aWxsIGFjdHVhbGx5IGJlIGJvb2tlZCBoaWdobGlnaHRlZC5cbiAqXG4gKiBUaGlzIGlzIHRoZSBhbnN3ZXIgdG8gXCJ3aGF0IGlzIHRoaXMgZ29pbmcgdG8gZG9cIiwgd2hpY2ggaXMgd2h5IGl0IGRyYXdzIHRoZVxuICogd2hvbGUgaG9yaXpvbiByYXRoZXIgdGhhbiBvbmx5IHRoZSBleGNlcHRpb25zIHRvIGl0LiBDbGlja2luZyBhIHBsYW5uZWQgZGF5XG4gKiBtb3ZlcyBpdCBpbiBhbmQgb3V0IG9mIHNraXBEYXRlcy5cbiAqL1xuZnVuY3Rpb24gcmVuZGVyUGxhbigpOiB2b2lkIHtcbiAgICBjb25zdCBob3N0ID0gZWw8SFRNTERpdkVsZW1lbnQ+KCdjYWxlbmRhcicpO1xuICAgIGhvc3QudGV4dENvbnRlbnQgPSAnJztcblxuICAgIGNvbnN0IHRvZGF5ID0gdG9Mb2NhbElTT0RhdGUobmV3IERhdGUoKSwgY3VycmVudC50aW1lWm9uZSk7XG4gICAgY29uc3QgW3RvZGF5WWVhciwgdG9kYXlNb250aF0gPSB0b2RheS5zcGxpdCgnLScpLm1hcChOdW1iZXIpIGFzIFtudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcblxuICAgIC8vIENhbmRpZGF0ZXMgaWdub3Jpbmcgc2tpcERhdGVzLCBzbyBhIHNraXBwZWQgZGF5IGlzIHN0aWxsIGRyYXduIGFzIG9uZSBvZlxuICAgIC8vIHRoZSBwbGFubmVkIGRheXMgcmF0aGVyIHRoYW4gdmFuaXNoaW5nIGludG8gdGhlIGJhY2tncm91bmQuXG4gICAgbGV0IGNhbmRpZGF0ZXM6IFNldDxzdHJpbmc+O1xuICAgIHRyeSB7XG4gICAgICAgIGNhbmRpZGF0ZXMgPSBuZXcgU2V0KGRhdGVzVG9Cb29rKHtcbiAgICAgICAgICAgIHdlZWtkYXlzOiBjdXJyZW50LndlZWtkYXlzLFxuICAgICAgICAgICAgaG9yaXpvbkRheXM6IGN1cnJlbnQuaG9yaXpvbkRheXMsXG4gICAgICAgICAgICBza2lwRGF0ZXM6IFtdLFxuICAgICAgICAgICAgdGltZVpvbmU6IGN1cnJlbnQudGltZVpvbmUsXG4gICAgICAgIH0pKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgY2FuZGlkYXRlcyA9IG5ldyBTZXQoKTtcbiAgICB9XG5cbiAgICAvLyBXaGV0aGVyIGEgZGF0ZSBpcyBhIHdlZWtkYXkgeW91IGNvbWUgaW4sIGlnbm9yaW5nIHRoZSBob3Jpem9uIGVudGlyZWx5LlxuICAgIC8vIEtub3dpbmcgaW4gU2VwdGVtYmVyIHRoYXQgeW91IGFyZSBhd2F5IGluIE9jdG9iZXIgaXMgbm9ybWFsOyB0aGUgaG9yaXpvblxuICAgIC8vIGdvdmVybnMgd2hhdCBnZXRzIGJvb2tlZCwgYW5kIGhhcyBubyBidXNpbmVzcyBnb3Zlcm5pbmcgd2hhdCB5b3UgYXJlXG4gICAgLy8gYWxsb3dlZCB0byB0ZWxsIGl0IGluIGFkdmFuY2UuXG4gICAgY29uc3QgY2hvc2VuV2Vla2RheXMgPSBuZXcgU2V0KGN1cnJlbnQud2Vla2RheXMpO1xuICAgIGNvbnN0IGlzV29ya2RheSA9IChpc286IHN0cmluZyk6IGJvb2xlYW4gPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gTWlkZGF5IGF2b2lkcyBhbnkgY2hhbmNlIG9mIHRoZSBwYXJzZWQgaW5zdGFudCBsYW5kaW5nIG9uIHRoZVxuICAgICAgICAgICAgLy8gcHJldmlvdXMgZGF5IG9uY2Ugc2hpZnRlZCBpbnRvIHRoZSB0YXJnZXQgem9uZS5cbiAgICAgICAgICAgIHJldHVybiBjaG9zZW5XZWVrZGF5cy5oYXMobG9jYWxXZWVrZGF5KG5ldyBEYXRlKGAke2lzb31UMTI6MDA6MDBaYCksIGN1cnJlbnQudGltZVpvbmUpKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICB9O1xuICAgIGNvbnN0IHNraXBwZWQgPSBuZXcgU2V0KGN1cnJlbnQuc2tpcERhdGVzKTtcbiAgICBjb25zdCBtYXJrZWRGb3JDYW5jZWwgPSBuZXcgU2V0KGN1cnJlbnQuY2FuY2VsRGF0ZXMpO1xuXG4gICAgLy8gVGhlIHJ1biBkcm9wcyBhIGRheSB3aG9zZSBzbG90IGhhcyBhbHJlYWR5IHN0YXJ0ZWQsIHNvIHRoZSBwbGFuIG11c3Qgbm90XG4gICAgLy8ga2VlcCBkcmF3aW5nIGl0IGFzIGEgZGF5IHRoYXQgd2lsbCBiZSBib29rZWQuIFNhbWUgcnVsZSwgc2FtZSBzb3VyY2UsXG4gICAgLy8gcmF0aGVyIHRoYW4gdHdvIHBsYWNlcyBkZWNpZGluZyBzZXBhcmF0ZWx5IHdoYXQgdG9kYXkgbWVhbnMuXG4gICAgY29uc3Qgc2xvdFN0YXJ0ID0gU0xPVF9USU1FU1tjdXJyZW50LnNsb3RdLnN0YXJ0O1xuXG4gICAgLy8gV2hhdCB0aGUgbGFzdCBydW4gZm91bmQsIGJ5IGRhdGUuIGBib29rZWRgIGFuZCBgc2tpcHBlZGAgYm90aCBtZWFuIFwieW91XG4gICAgLy8gaG9sZCB0aGF0IGRheVwiIFx1MjAxNCBvbmUganVzdCBoYXBwZW5lZCBub3cgYW5kIHRoZSBvdGhlciBlYXJsaWVyLlxuICAgIGNvbnN0IG91dGNvbWUgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgIGZvciAoY29uc3Qgcm93IG9mIGxhc3RMb2c/LnJvd3MgPz8gW10pIHtcbiAgICAgICAgaWYgKHJvdy5zdGF0dXMgPT09ICdib29rZWQnIHx8IHJvdy5zdGF0dXMgPT09ICdza2lwcGVkJykgb3V0Y29tZS5zZXQocm93LmRhdGUsICdoYXZlJyk7XG4gICAgICAgIGVsc2UgaWYgKHJvdy5zdGF0dXMgPT09ICd1bmF2YWlsYWJsZScpIG91dGNvbWUuc2V0KHJvdy5kYXRlLCAndGFrZW4nKTtcbiAgICAgICAgZWxzZSBpZiAocm93LnN0YXR1cyA9PT0gJ2Vycm9yJykgb3V0Y29tZS5zZXQocm93LmRhdGUsICdmYWlsZWQnKTtcbiAgICB9XG5cbiAgICAvLyBBIHJ1biBmcm9tIGRheXMgYWdvIGNhbiBzdGlsbCBiZSBzaG93aW5nIGdyZWVuIGZvciBkYXlzIHRoYXQgaGF2ZSBzaW5jZVxuICAgIC8vIGJlZW4gZ2l2ZW4gYXdheSwgc28gdGhlIHBsYW4gc2F5cyBob3cgb2xkIGl0IGlzIHJhdGhlciB0aGFuIGltcGx5aW5nIGl0XG4gICAgLy8gaXMgbGl2ZS5cbiAgICBjb25zdCBhc09mID0gZWw8SFRNTFNwYW5FbGVtZW50PigncGxhbkFzT2YnKTtcbiAgICBhc09mLnRleHRDb250ZW50ID0gbGFzdExvZ1xuICAgICAgICA/IGBjb2xvdXJzIGZyb20gJHtuZXcgRGF0ZShsYXN0TG9nLmF0KS50b0xvY2FsZVN0cmluZygpfSBcdTAwQjcgY2xpY2sgYSBkYXkgdG8gc2tpcCBpdGBcbiAgICAgICAgOiAnY2xpY2sgYSBkYXkgdG8gc2tpcCBpdCc7XG5cbiAgICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPCAyOyBvZmZzZXQgKz0gMSkge1xuICAgICAgICBjb25zdCBtb250aCA9IHRvZGF5TW9udGggLSAxICsgb2Zmc2V0O1xuICAgICAgICBjb25zdCB5ZWFyID0gdG9kYXlZZWFyICsgTWF0aC5mbG9vcihtb250aCAvIDEyKTtcbiAgICAgICAgY29uc3Qgbm9ybWFsaXNlZCA9ICgobW9udGggJSAxMikgKyAxMikgJSAxMjtcblxuICAgICAgICBjb25zdCBibG9jayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBibG9jay5jbGFzc05hbWUgPSAnbW9udGgnO1xuXG4gICAgICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgbmFtZS5jbGFzc05hbWUgPSAnbW9udGgtbmFtZSc7XG4gICAgICAgIG5hbWUudGV4dENvbnRlbnQgPSBuZXcgRGF0ZShEYXRlLlVUQyh5ZWFyLCBub3JtYWxpc2VkLCAxKSlcbiAgICAgICAgICAgIC50b0xvY2FsZURhdGVTdHJpbmcodW5kZWZpbmVkLCB7IG1vbnRoOiAnbG9uZycsIHllYXI6ICdudW1lcmljJywgdGltZVpvbmU6ICdVVEMnIH0pO1xuICAgICAgICBibG9jay5hcHBlbmQobmFtZSk7XG5cbiAgICAgICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBncmlkLmNsYXNzTmFtZSA9ICdncmlkJztcbiAgICAgICAgZm9yIChjb25zdCBsYWJlbCBvZiBET1dfTEFCRUxTKSB7XG4gICAgICAgICAgICBjb25zdCBoZWFkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgICAgICBoZWFkLmNsYXNzTmFtZSA9ICdkb3cnO1xuICAgICAgICAgICAgaGVhZC50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICAgICAgZ3JpZC5hcHBlbmQoaGVhZCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBmaXJzdERheU9mV2VlayA9IG5ldyBEYXRlKERhdGUuVVRDKHllYXIsIG5vcm1hbGlzZWQsIDEpKS5nZXRVVENEYXkoKTtcbiAgICAgICAgLy8gZ2V0VVRDRGF5IGlzIFN1bmRheS1maXJzdDsgdGhlIGdyaWQgaXMgTW9uZGF5LWZpcnN0LlxuICAgICAgICBjb25zdCBsZWFkID0gKGZpcnN0RGF5T2ZXZWVrICsgNikgJSA3O1xuICAgICAgICBmb3IgKGxldCBibGFuayA9IDA7IGJsYW5rIDwgbGVhZDsgYmxhbmsgKz0gMSkgZ3JpZC5hcHBlbmQoZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2JykpO1xuXG4gICAgICAgIGNvbnN0IGRheXNJbk1vbnRoID0gbmV3IERhdGUoRGF0ZS5VVEMoeWVhciwgbm9ybWFsaXNlZCArIDEsIDApKS5nZXRVVENEYXRlKCk7XG4gICAgICAgIGZvciAobGV0IGRheSA9IDE7IGRheSA8PSBkYXlzSW5Nb250aDsgZGF5ICs9IDEpIHtcbiAgICAgICAgICAgIGNvbnN0IGlzbyA9IGlzb0Zvcih5ZWFyLCBub3JtYWxpc2VkLCBkYXkpO1xuICAgICAgICAgICAgY29uc3QgY2VsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICAgICAgY2VsbC5jbGFzc05hbWUgPSAnZGF5JztcbiAgICAgICAgICAgIGNlbGwudGV4dENvbnRlbnQgPSBTdHJpbmcoZGF5KTtcbiAgICAgICAgICAgIGNlbGwudHlwZSA9ICdidXR0b24nO1xuXG4gICAgICAgICAgICBpZiAoaXNvIDwgdG9kYXkpIGNlbGwuY2xhc3NMaXN0LmFkZCgncGFzdCcpO1xuICAgICAgICAgICAgaWYgKGlzbyA9PT0gdG9kYXkpIGNlbGwuY2xhc3NMaXN0LmFkZCgndG9kYXknKTtcblxuICAgICAgICAgICAgY29uc3QgcGxhbm5lZCA9IGNhbmRpZGF0ZXMuaGFzKGlzbyk7XG4gICAgICAgICAgICBjb25zdCBtYXJrYWJsZSA9IHBsYW5uZWQgfHwgKGlzbyA+PSB0b2RheSAmJiBpc1dvcmtkYXkoaXNvKSk7XG5cbiAgICAgICAgICAgIGlmIChtYXJrYWJsZSkge1xuICAgICAgICAgICAgICAgIC8vIFRoZSB1c2VyJ3Mgb3duIGNob2ljZSB0byBza2lwIG91dHJhbmtzIGFueXRoaW5nIGEgcnVuIGZvdW5kOlxuICAgICAgICAgICAgICAgIC8vIGl0IGlzIGFuIGluc3RydWN0aW9uLCBub3QgYW4gb2JzZXJ2YXRpb24uXG4gICAgICAgICAgICAgICAgLy8gQ2FuY2VsbGF0aW9uIGlzIHRoZSBzdHJvbmdlc3Qgc3RhdGVtZW50IGFib3V0IGEgZGF5LCBzbyBpdFxuICAgICAgICAgICAgICAgIC8vIHdpbnMgdGhlIGRpc3BsYXk6IGl0IGlzIGJvdGggYW4gaW5zdHJ1Y3Rpb24gYW5kIGRlc3RydWN0aXZlLFxuICAgICAgICAgICAgICAgIC8vIGFuZCBtdXN0IG5vdCBiZSBoaWRkZW4gYmVoaW5kIGEgXCJza2lwcGVkXCIgc3R5bGUuXG4gICAgICAgICAgICAgICAgLy8gUmFua2VkLCBtb3N0IGVtcGhhdGljIGZpcnN0LiBgbGF0ZWAgc2l0cyBiZWxvdyBhbnl0aGluZyB0aGVcbiAgICAgICAgICAgICAgICAvLyBsYXN0IHJ1biBmb3VuZDogYSBkYXkgeW91IGFscmVhZHkgaG9sZCBpcyB3b3J0aCBzaG93aW5nIGFzXG4gICAgICAgICAgICAgICAgLy8gaGVsZCBldmVuIG9uY2UgaXRzIHNsb3QgaGFzIHN0YXJ0ZWQuXG4gICAgICAgICAgICAgICAgY29uc3QgdG9vTGF0ZSA9IHBsYW5uZWQgJiYgaGFzU2xvdFN0YXJ0ZWQoaXNvLCBzbG90U3RhcnQsIGN1cnJlbnQudGltZVpvbmUpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gbWFya2VkRm9yQ2FuY2VsLmhhcyhpc28pXG4gICAgICAgICAgICAgICAgICAgID8gJ2NhbmNlbCdcbiAgICAgICAgICAgICAgICAgICAgOiBza2lwcGVkLmhhcyhpc28pXG4gICAgICAgICAgICAgICAgICAgICAgICA/ICdza2lwJ1xuICAgICAgICAgICAgICAgICAgICAgICAgOiBvdXRjb21lLmdldChpc28pID8/ICh0b29MYXRlID8gJ2xhdGUnIDogcGxhbm5lZCA/ICdib29rJyA6ICdsYXRlcicpO1xuICAgICAgICAgICAgICAgIC8vIE5vdGhpbmcgdG8gZGVjaWRlIGFib3V0IGEgZGF5IHRoYXQgY2Fubm90IGJlIGJvb2tlZCBlaXRoZXJcbiAgICAgICAgICAgICAgICAvLyB3YXksIHNvIGl0IGRvZXMgbm90IGludml0ZSBhIGNsaWNrLlxuICAgICAgICAgICAgICAgIGNlbGwuY2xhc3NMaXN0LmFkZChzdGF0ZSk7XG4gICAgICAgICAgICAgICAgaWYgKHN0YXRlICE9PSAnbGF0ZScpIGNlbGwuY2xhc3NMaXN0LmFkZCgnY2xpY2thYmxlJyk7XG4gICAgICAgICAgICAgICAgY2VsbC50aXRsZSA9IHtcbiAgICAgICAgICAgICAgICAgICAgc2tpcDogJ1NraXBwZWQgXHUyMDE0IGNsaWNrIHRvIGJvb2sgaXQnLFxuICAgICAgICAgICAgICAgICAgICBoYXZlOiAnWW91IGFscmVhZHkgaGF2ZSB0aGlzIGRheS4gQ2xpY2tpbmcgc3RvcHMgZnV0dXJlIHJ1bnMgcmUtYm9va2luZyBpdDsgJ1xuICAgICAgICAgICAgICAgICAgICAgICAgKyAnaXQgZG9lcyBub3QgY2FuY2VsIHRoZSBib29raW5nIGluIENvbWVlbi4nLFxuICAgICAgICAgICAgICAgICAgICB0YWtlbjogJ1NvbWVvbmUgZWxzZSBoYXMgdGhpcyBkZXNrIHRoYXQgZGF5LiBDbGlja2luZyBzdG9wcyBpdCBiZWluZyByZXRyaWVkLicsXG4gICAgICAgICAgICAgICAgICAgIGZhaWxlZDogJ1RoZSBsYXN0IGF0dGVtcHQgZmFpbGVkIG9uIHRoaXMgZGF5LiBPcGVuIExhc3QgcnVuIGZvciB0aGUgcmVhc29uLicsXG4gICAgICAgICAgICAgICAgICAgIGJvb2s6ICdDbGljayB0byBza2lwJyxcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXI6ICdCZXlvbmQgdGhlIGJvb2tpbmcgd2luZG93IGZvciBub3cuIENsaWNrIHRvIHNraXAgaXQgaW4gYWR2YW5jZSBcdTIwMTQgaXQgJ1xuICAgICAgICAgICAgICAgICAgICAgICAgKyAnd2lsbCBiZSByZW1lbWJlcmVkIHdoZW4gdGhlIHdpbmRvdyByZWFjaGVzIGl0LicsXG4gICAgICAgICAgICAgICAgICAgIGNhbmNlbDogJ1dpbGwgYmUgY2FuY2VsbGVkIGluIENvbWVlbiBvbiB0aGUgbmV4dCBydW4uIENsaWNrIHRvIGtlZXAgaXQuJyxcbiAgICAgICAgICAgICAgICAgICAgbGF0ZTogYFRvbyBsYXRlIFx1MjAxNCB0aGUgJHtjdXJyZW50LnNsb3QucmVwbGFjZSgnXycsICcgJyl9IHNsb3QgaGFzIGFscmVhZHkgYFxuICAgICAgICAgICAgICAgICAgICAgICAgKyAnc3RhcnRlZCwgYW5kIENvbWVlbiByZWZ1c2VzIGEgYm9va2luZyB3aG9zZSBzdGFydCB0aW1lIGhhcyBwYXNzZWQuICdcbiAgICAgICAgICAgICAgICAgICAgICAgICsgJ0Jvb2sgaXQgYnkgaGFuZCBpZiB5b3Ugc3RpbGwgbmVlZCBpdC4nLFxuICAgICAgICAgICAgICAgIH1bc3RhdGVdID8/ICdDbGljayB0byBza2lwJztcbiAgICAgICAgICAgICAgICBpZiAoc3RhdGUgPT09ICdsYXRlJykge1xuICAgICAgICAgICAgICAgICAgICBncmlkLmFwcGVuZChjZWxsKTtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY2VsbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN0YXRlID09PSAnY2FuY2VsJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gVW5kbzogc3RvcCBjYW5jZWxsaW5nLCBhbmQgc3RvcCBza2lwcGluZywgc2luY2UgdGhlXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBza2lwIHdhcyBvbmx5IGV2ZXIgdGhlcmUgdG8gcHJvdGVjdCB0aGUgY2FuY2VsbGF0aW9uLlxuICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudC5jYW5jZWxEYXRlcyA9IGN1cnJlbnQuY2FuY2VsRGF0ZXMuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkgIT09IGlzbyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50LnNraXBEYXRlcyA9IGN1cnJlbnQuc2tpcERhdGVzLmZpbHRlcigoZW50cnkpID0+IGVudHJ5ICE9PSBpc28pO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHN0YXRlID09PSAnaGF2ZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFlvdSBob2xkIHRoaXMgZGF5LCBzbyB0aGUgdXNlZnVsIGFjdGlvbiBpcyB0byBnaXZlIGl0XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyB1cCByYXRoZXIgdGhhbiBtZXJlbHkgdG8gc3RvcCByZS1ib29raW5nIGl0LiBTa2lwcGluZ1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gYXMgd2VsbCBpcyBub3Qgb3B0aW9uYWw6IHdpdGhvdXQgaXQsIHRoZSB2ZXJ5IG5leHQgcnVuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyB3b3VsZCBib29rIHN0cmFpZ2h0IGJhY2sgd2hhdCB0aGlzIG9uZSBjYW5jZWxsZWQuXG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50LmNhbmNlbERhdGVzID0gWy4uLmN1cnJlbnQuY2FuY2VsRGF0ZXMsIGlzb10uc29ydCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudC5za2lwRGF0ZXMgPSBbLi4ubmV3IFNldChbLi4uY3VycmVudC5za2lwRGF0ZXMsIGlzb10pXS5zb3J0KCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50LnNraXBEYXRlcyA9IHNraXBwZWQuaGFzKGlzbylcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IGN1cnJlbnQuc2tpcERhdGVzLmZpbHRlcigoZW50cnkpID0+IGVudHJ5ICE9PSBpc28pXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBbLi4uY3VycmVudC5za2lwRGF0ZXMsIGlzb10uc29ydCgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJlbmRlclBsYW4oKTtcbiAgICAgICAgICAgICAgICAgICAgcXVldWVTYXZlKCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGdyaWQuYXBwZW5kKGNlbGwpO1xuICAgICAgICB9XG5cbiAgICAgICAgYmxvY2suYXBwZW5kKGdyaWQpO1xuICAgICAgICBob3N0LmFwcGVuZChibG9jayk7XG4gICAgfVxufVxuXG4vKipcbiAqIFNob3cgd2hldGhlciB0aGUgZGVzayBuYW1lIGlzIHVzYWJsZSwgYW5kIHN0b3AgdGhlIGJ1dHRvbnMgaWYgaXQgaXMgbm90LlxuICpcbiAqIFRocmVlIHN0YXRlcyByYXRoZXIgdGhhbiB0d286IGVtcHR5IGlzIG5vdCBhbiBlcnJvciwgaXQgaXMgdGhlIHN0YXJ0aW5nXG4gKiBwb2ludCwgc28gaXQgZ2V0cyBhIHBsYWluIGhpbnQuIE9ubHkgc29tZXRoaW5nIHR5cGVkIGFuZCB3cm9uZyB0dXJucyByZWQuXG4gKiBTY29sZGluZyBzb21lb25lIGZvciBub3QgaGF2aW5nIGZpbGxlZCBhIGZpZWxkIGluIHlldCBpcyBob3cgYSBzZXR1cCBzY3JlZW5cbiAqIG1ha2VzIHBlb3BsZSBmZWVsIHN0dXBpZC5cbiAqL1xuZnVuY3Rpb24gcmVuZGVyRGVza1N0YXRlKCk6IHZvaWQge1xuICAgIGNvbnN0IHJhdyA9IGZpZWxkcy5kZXNrTmFtZS52YWx1ZS50cmltKCk7XG4gICAgY29uc3Qgbm90ZSA9IGVsPEhUTUxQYXJhZ3JhcGhFbGVtZW50PignZGVza05vdGUnKTtcbiAgICBjb25zdCB2YWxpZCA9IGlzVmFsaWREZXNrTmFtZShyYXcpO1xuXG4gICAgaWYgKHJhdyA9PT0gJycpIHtcbiAgICAgICAgbm90ZS50ZXh0Q29udGVudCA9ICdQaWNrIHlvdXIgZGVzayBmaXJzdCBcdTIwMTQgdGhlIG51bWJlciBwcmludGVkIG9uIGl0LCBsaWtlIDMtMjMuJztcbiAgICAgICAgbm90ZS5jbGFzc0xpc3QucmVtb3ZlKCdiYWQnKTtcbiAgICAgICAgZmllbGRzLmRlc2tOYW1lLmNsYXNzTGlzdC5yZW1vdmUoJ2JhZCcpO1xuICAgIH0gZWxzZSBpZiAodmFsaWQpIHtcbiAgICAgICAgbm90ZS50ZXh0Q29udGVudCA9ICdMb29rZWQgdXAgYnkgbmFtZSBvbiBldmVyeSBydW4sIHNvIHRoZSBJRCBzdGF5cyBlbXB0eS4nO1xuICAgICAgICBub3RlLmNsYXNzTGlzdC5yZW1vdmUoJ2JhZCcpO1xuICAgICAgICBmaWVsZHMuZGVza05hbWUuY2xhc3NMaXN0LnJlbW92ZSgnYmFkJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbm90ZS50ZXh0Q29udGVudCA9IGBcIiR7cmF3fVwiIGlzIG5vdCBhIGRlc2sgbnVtYmVyLiBJdCBzaG91bGQgYmUgZGlnaXRzLCBhIGRhc2gsIGRpZ2l0cyBcdTIwMTQgbGlrZSAzLTIzLmA7XG4gICAgICAgIG5vdGUuY2xhc3NMaXN0LmFkZCgnYmFkJyk7XG4gICAgICAgIGZpZWxkcy5kZXNrTmFtZS5jbGFzc0xpc3QuYWRkKCdiYWQnKTtcbiAgICB9XG5cbiAgICAvLyBBIGRlc2sgSUQgc2V0IGJ5IGhhbmQgaW4gQWR2YW5jZWQgaXMgYSBkZWxpYmVyYXRlIG92ZXJyaWRlLCBhbmQgc3RhbmRzIGluXG4gICAgLy8gZm9yIHRoZSBuYW1lLlxuICAgIGNvbnN0IHJ1bm5hYmxlID0gdmFsaWQgfHwgZmllbGRzLmRlc2tJZC52YWx1ZS50cmltKCkgIT09ICcnO1xuICAgIGZvciAoY29uc3QgaWQgb2YgWydydW5Ob3cnLCAnZHJ5UnVuJ10pIHtcbiAgICAgICAgZWw8SFRNTEJ1dHRvbkVsZW1lbnQ+KGlkKS5kaXNhYmxlZCA9ICFydW5uYWJsZTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHJlbmRlckF1dG9Ob3RlKCk6IHZvaWQge1xuICAgIGNvbnN0IG5vdGUgPSBlbDxIVE1MUGFyYWdyYXBoRWxlbWVudD4oJ2F1dG9Ob3RlJyk7XG4gICAgbm90ZS50ZXh0Q29udGVudCA9IGN1cnJlbnQuZW5hYmxlZFxuICAgICAgICA/IGBPbi4gQ2hlY2tzIGV2ZXJ5IDYgaG91cnMgYW5kIGJvb2tzIGFueSBtaXNzaW5nIGRheSBpbiB0aGUgbmV4dCAke2N1cnJlbnQuaG9yaXpvbkRheXN9IGBcbiAgICAgICAgICAgICsgJ2RheXMuIE9ubHkgcnVucyB3aGlsZSBDaHJvbWUgaXMgb3BlbiBcdTIwMTQgYSBjbG9zZWQgbGFwdG9wIGp1c3QgbWVhbnMgaXQgY2F0Y2hlcyB1cCBsYXRlci4nXG4gICAgICAgIDogJ09mZi4gTm90aGluZyBpcyBib29rZWQgdW5sZXNzIHlvdSBwcmVzcyBCb29rIG5vdy4nO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgc2F2aW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmbGFzaFNhdmVkKHRleHQgPSAnU2F2ZWQnKTogdm9pZCB7XG4gICAgY29uc3QgZmxhZyA9IGVsPEhUTUxTcGFuRWxlbWVudD4oJ3NhdmVkRmxhZycpO1xuICAgIGZsYWcudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgIGZsYWcuaGlkZGVuID0gZmFsc2U7XG4gICAgd2luZG93LnNldFRpbWVvdXQoKCkgPT4geyBmbGFnLmhpZGRlbiA9IHRydWU7IH0sIDFfMjAwKTtcbn1cblxubGV0IHNhdmVUaW1lcjogbnVtYmVyIHwgdW5kZWZpbmVkO1xuXG4vKipcbiAqIFRoZXJlIGlzIG5vIFNhdmUgYnV0dG9uOiBldmVyeSBjaGFuZ2UgcGVyc2lzdHMgb24gaXRzIG93biBhZnRlciBhIHNob3J0XG4gKiBwYXVzZS4gVGhlIHBhdXNlIGlzIHdoYXQga2VlcHMgYSB0eXBlZCBkZXNrIG5hbWUgZnJvbSB3cml0aW5nIHN0b3JhZ2Ugb25jZVxuICogcGVyIGtleXN0cm9rZS5cbiAqL1xuZnVuY3Rpb24gcXVldWVTYXZlKCk6IHZvaWQge1xuICAgIHdpbmRvdy5jbGVhclRpbWVvdXQoc2F2ZVRpbWVyKTtcbiAgICBzYXZlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgY29tbWl0KCk7IH0sIDMwMCk7XG59XG5cbi8qKiBTZXQgd2hpbGUgdGhpcyBwb3B1cCB3cml0ZXMsIHNvIGl0cyBvd24gc2F2ZSBkb2VzIG5vdCBib3VuY2UgYmFjayBhcyBhbiB1cGRhdGUuICovXG5sZXQgc2F2aW5nTG9jYWxseSA9IGZhbHNlO1xuXG5hc3luYyBmdW5jdGlvbiBjb21taXQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgeyBzZXR0aW5ncywgZW5kcG9pbnRFcnJvciB9ID0gY29sbGVjdCgpO1xuICAgIGN1cnJlbnQgPSBzZXR0aW5ncztcbiAgICBzYXZpbmdMb2NhbGx5ID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBzYXZlU2V0dGluZ3Moc2V0dGluZ3MpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIC8vIENsZWFyZWQgYWZ0ZXIgdGhlIGV2ZW50IGxvb3AgdHVybiwgc28gdGhlIGNoYW5nZSBldmVudCB0aGlzIHdyaXRlXG4gICAgICAgIC8vIHByb2R1Y2VzIGlzIHN0aWxsIHNlZW4gYXMgbG9jYWwuXG4gICAgICAgIHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHsgc2F2aW5nTG9jYWxseSA9IGZhbHNlOyB9LCAwKTtcbiAgICB9XG4gICAgcmVuZGVyUGxhbigpO1xuICAgIHJlbmRlckF1dG9Ob3RlKCk7XG4gICAgcmVuZGVyRGVza1N0YXRlKCk7XG4gICAgZmxhc2hTYXZlZChlbmRwb2ludEVycm9yID8gJ0VuZHBvaW50IEpTT04gaW52YWxpZCBcdTIwMTQgbm90IHNhdmVkJyA6ICdTYXZlZCcpO1xufVxuXG5mb3IgKGNvbnN0IGZpZWxkIG9mIFtcbiAgICBmaWVsZHMuZW5hYmxlZCwgZmllbGRzLmRlc2tOYW1lLCBmaWVsZHMuZGVza0lkLCBmaWVsZHMuZmxvb3JJZCxcbiAgICBmaWVsZHMuc2xvdCwgZmllbGRzLmhvcml6b25EYXlzLCBmaWVsZHMudGltZVpvbmUsIGZpZWxkcy5lbmRwb2ludCxcbl0pIHtcbiAgICBmaWVsZC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBxdWV1ZVNhdmUpO1xuICAgIGZpZWxkLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgcXVldWVTYXZlKTtcbn1cblxuLy8gVGhlIHNhdmUgaXMgZGVib3VuY2VkOyB0aGUgdmFsaWRhdGlvbiBtdXN0IG5vdCBiZSwgb3IgdGhlIGZpZWxkIHN0YXlzIHJlZCBmb3Jcbi8vIGEgdGhpcmQgb2YgYSBzZWNvbmQgYWZ0ZXIgeW91IGhhdmUgYWxyZWFkeSBmaXhlZCBpdC5cbmZvciAoY29uc3QgZmllbGQgb2YgW2ZpZWxkcy5kZXNrTmFtZSwgZmllbGRzLmRlc2tJZF0pIHtcbiAgICBmaWVsZC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIHJlbmRlckRlc2tTdGF0ZSk7XG59XG5kYXlzSG9zdC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBxdWV1ZVNhdmUpO1xuXG4vLyBcdTI1MDBcdTI1MDAgcnVuIGxvZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gcmVuZGVyTG9nKGxvZzogUnVuTG9nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gICAgY29uc3QgaG9zdCA9IGVsPEhUTUxQcmVFbGVtZW50PignbG9nJyk7XG4gICAgaG9zdC50ZXh0Q29udGVudCA9ICcnO1xuICAgIGlmICghbG9nKSB7XG4gICAgICAgIGhvc3QudGV4dENvbnRlbnQgPSAnTm8gcnVucyB5ZXQuJztcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHdoZW4gPSBuZXcgRGF0ZShsb2cuYXQpLnRvTG9jYWxlU3RyaW5nKCk7XG4gICAgY29uc3QgaGVhZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGhlYWQudGV4dENvbnRlbnQgPSBgJHt3aGVufSR7bG9nLmRyeVJ1biA/ICcgIChwcmV2aWV3IFx1MjAxNCBub3RoaW5nIHdhcyBib29rZWQpJyA6ICcnfWA7XG4gICAgaG9zdC5hcHBlbmQoaGVhZCk7XG5cbiAgICBpZiAobG9nLmVycm9yKSB7XG4gICAgICAgIGNvbnN0IHByb2JsZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgcHJvYmxlbS5jbGFzc05hbWUgPSAnc3QtZXJyb3InO1xuICAgICAgICBwcm9ibGVtLnRleHRDb250ZW50ID0gYGVycm9yOiAke2xvZy5lcnJvcn1gO1xuICAgICAgICBob3N0LmFwcGVuZChwcm9ibGVtKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IG5vdGUgb2YgbG9nLm5vdGVzKSB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgbGluZS5jbGFzc05hbWUgPSAnc3Qtc2tpcHBlZCc7XG4gICAgICAgIGxpbmUudGV4dENvbnRlbnQgPSBgXHUwMEI3ICR7bm90ZX1gO1xuICAgICAgICBob3N0LmFwcGVuZChsaW5lKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHJvdyBvZiBsb2cucm93cykge1xuICAgICAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIGxpbmUuY2xhc3NOYW1lID0gYHN0LSR7cm93LnN0YXR1c31gO1xuICAgICAgICBsaW5lLnRleHRDb250ZW50ID0gYCR7cm93LmRhdGV9ICAke3Jvdy5zdGF0dXN9JHtyb3cuZGV0YWlsID8gYCAgJHtyb3cuZGV0YWlsfWAgOiAnJ31gO1xuICAgICAgICBob3N0LmFwcGVuZChsaW5lKTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlbmRlckNhcHR1cmVzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHsgY2FwdHVyZXMgPSBbXSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdjYXB0dXJlcycpIGFzIHsgY2FwdHVyZXM/OiB1bmtub3duW10gfTtcbiAgICBjb25zdCBob3N0ID0gZWw8SFRNTFByZUVsZW1lbnQ+KCdjYXB0dXJlcycpO1xuICAgIGlmIChjYXB0dXJlcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgaG9zdC50ZXh0Q29udGVudCA9ICdOb3RoaW5nIHJlY29yZGVkIHlldC4nO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGhvc3QudGV4dENvbnRlbnQgPSBjYXB0dXJlcy5tYXAoKGNhcHR1cmUpID0+IEpTT04uc3RyaW5naWZ5KGNhcHR1cmUsIG51bGwsIDEpKS5qb2luKCdcXG5cXG4nKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIGxvYWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5yZW5kZXJTZXR0aW5ncyhjdXJyZW50KTtcbnJlbmRlclBsYW4oKTtcbnJlbmRlckF1dG9Ob3RlKCk7XG5yZW5kZXJEZXNrU3RhdGUoKTtcblxuY29uc3QgeyBydW5zID0gW10sIGxlYXJuTW9kZSA9IGZhbHNlIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoWydydW5zJywgJ2xlYXJuTW9kZSddKSBhcyB7XG4gICAgcnVucz86IFJ1bkxvZ1tdO1xuICAgIGxlYXJuTW9kZT86IGJvb2xlYW47XG59O1xuZmllbGRzLmxlYXJuTW9kZS5jaGVja2VkID0gbGVhcm5Nb2RlO1xubGFzdExvZyA9IHJ1bnNbMF07XG5yZW5kZXJMb2cocnVuc1swXSk7XG4vLyBUaGUgcGxhbiB3YXMgZHJhd24gYmVmb3JlIHRoZSBsb2cgd2FzIGxvYWRlZCwgc28gY29sb3VyIGl0IGluIG5vdy5cbnJlbmRlclBsYW4oKTtcblxuLyoqIFRlbGwgdGhlIGJhY2tncm91bmQgdGhlIGZhaWx1cmUgaGFzIGJlZW4gc2Vlbiwgc28gdGhlIGJhZGdlIHN0b3BzIHNob3V0aW5nLiAqL1xuZnVuY3Rpb24gbWFya1J1bnNSZWFkKCk6IHZvaWQge1xuICAgIHZvaWQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyB0eXBlOiAncnVucy1yZWFkJyB9KS5jYXRjaCgoKSA9PiB7IC8qIHdvcmtlciBhc2xlZXAgKi8gfSk7XG59XG5cbi8vIE9wZW5pbmcgdGhlIHBvcHVwIG1hcmtzIGEgZmFpbHVyZSBhcyByZWFkOyBzbyBkb2VzIHdhdGNoaW5nIG9uZSBoYXBwZW4uXG5tYXJrUnVuc1JlYWQoKTtcbmF3YWl0IHJlbmRlckNhcHR1cmVzKCk7XG5cbi8vIFx1MjUwMFx1MjUwMCBhY3Rpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiB0cmlnZ2VyUnVuKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIGRyeVJ1bjogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBidXR0b24udGV4dENvbnRlbnQ7XG4gICAgYnV0dG9uLnRleHRDb250ZW50ID0gZHJ5UnVuID8gJ0NoZWNraW5nXHUyMDI2JyA6ICdCb29raW5nXHUyMDI2JztcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBjb21taXQoKTtcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdydW4nLCBkcnlSdW4gfSkgYXMge1xuICAgICAgICAgICAgb2s6IGJvb2xlYW47XG4gICAgICAgICAgICBsb2c/OiBSdW5Mb2c7XG4gICAgICAgICAgICBlcnJvcj86IHN0cmluZztcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKHJlc3BvbnNlLm9rICYmIHJlc3BvbnNlLmxvZykge1xuICAgICAgICAgICAgbGFzdExvZyA9IHJlc3BvbnNlLmxvZztcbiAgICAgICAgICAgIHJlbmRlckxvZyhyZXNwb25zZS5sb2cpO1xuICAgICAgICAgICAgcmVuZGVyUGxhbigpO1xuICAgICAgICAgICAgLy8gWW91IGp1c3Qgd2F0Y2hlZCB0aGlzIGhhcHBlbiwgc28gaXQgaXMgbm90IHVucmVhZCBuZXdzLlxuICAgICAgICAgICAgbWFya1J1bnNSZWFkKCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZW5kZXJMb2coe1xuICAgICAgICAgICAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgICAgICAgZHJ5UnVuLFxuICAgICAgICAgICAgICAgIGRhdGVzOiBbXSxcbiAgICAgICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgICAgICBub3RlczogW10sXG4gICAgICAgICAgICAgICAgZXJyb3I6IHJlc3BvbnNlLmVycm9yID8/ICdVbmtub3duIGZhaWx1cmUnLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmVuZGVyTG9nKHtcbiAgICAgICAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgICBkcnlSdW4sXG4gICAgICAgICAgICBkYXRlczogW10sXG4gICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgIG5vdGVzOiBbXSxcbiAgICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IG9yaWdpbmFsO1xuICAgICAgICAvLyBOb3QgYGRpc2FibGVkID0gZmFsc2VgOiB3aGV0aGVyIHRoZXNlIGFyZSB1c2FibGUgaXMgcmVuZGVyRGVza1N0YXRlJ3NcbiAgICAgICAgLy8gZGVjaXNpb24sIGFuZCBhIHJ1biBkb2VzIG5vdCBjaGFuZ2UgaXQuXG4gICAgICAgIHJlbmRlckRlc2tTdGF0ZSgpO1xuICAgIH1cbn1cblxuZWw8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdydW5Ob3cnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4ge1xuICAgIHZvaWQgdHJpZ2dlclJ1bihldmVudC5jdXJyZW50VGFyZ2V0IGFzIEhUTUxCdXR0b25FbGVtZW50LCBmYWxzZSk7XG59KTtcblxuZWw8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdkcnlSdW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4ge1xuICAgIHZvaWQgdHJpZ2dlclJ1bihldmVudC5jdXJyZW50VGFyZ2V0IGFzIEhUTUxCdXR0b25FbGVtZW50LCB0cnVlKTtcbn0pO1xuXG5maWVsZHMubGVhcm5Nb2RlLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICB2b2lkIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IGxlYXJuTW9kZTogZmllbGRzLmxlYXJuTW9kZS5jaGVja2VkIH0pO1xufSk7XG5cbmVsPEhUTUxCdXR0b25FbGVtZW50PignY29weUNhcHR1cmVzJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICBjb25zdCB7IGNhcHR1cmVzID0gW10gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgnY2FwdHVyZXMnKSBhcyB7IGNhcHR1cmVzPzogdW5rbm93bltdIH07XG4gICAgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoSlNPTi5zdHJpbmdpZnkoY2FwdHVyZXMsIG51bGwsIDIpKTtcbiAgICBjb25zdCBidXR0b24gPSBldmVudC5jdXJyZW50VGFyZ2V0IGFzIEhUTUxCdXR0b25FbGVtZW50O1xuICAgIGNvbnN0IG9yaWdpbmFsID0gYnV0dG9uLnRleHRDb250ZW50O1xuICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9ICdDb3BpZWQnO1xuICAgIHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHsgYnV0dG9uLnRleHRDb250ZW50ID0gb3JpZ2luYWw7IH0sIDFfNDAwKTtcbn0pO1xuXG4vKipcbiAqIEZvbGxvdyBjaGFuZ2VzIHRoZSBwb3B1cCBkaWQgbm90IG1ha2UgaXRzZWxmLlxuICpcbiAqIEEgcnVuIHN0YXJ0ZWQgZnJvbSBoZXJlIGFscmVhZHkgcmVkcmF3cyBvbiBpdHMgcmVwbHkuIFRoaXMgaXMgZm9yIGV2ZXJ5dGhpbmdcbiAqIGVsc2U6IGFuIGF1dG9tYXRpYyBydW4gZmluaXNoaW5nIHdoaWxlIHRoZSBwYW5lbCBpcyBvcGVuLCBhbmQgdGhlIHNldHRpbmdzIHRoZVxuICogYmFja2dyb3VuZCB3cml0ZXMgb24gaXRzIG93biBcdTIwMTQgdGhlIHJlc29sdmVkIGRlc2sgaWQgaXQgY2FjaGVzLCB0aGUgY2FuY2VsXG4gKiBkYXRlcyBpdCBjbGVhcnMgb25jZSBkb25lLiBXaXRob3V0IHRoaXMgdGhlIHBhbmVsIHF1aWV0bHkgc2hvd3MgYSBzdGFsZVxuICogcGljdHVyZSBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBvcGVuLCB3aGljaCBpcyBleGFjdGx5IHdoZW4gc29tZW9uZSBpc1xuICogd2F0Y2hpbmcgaXQgdG8gc2VlIHdoZXRoZXIgdGhlIHRoaW5nIHdvcmtzLlxuICovXG5jaHJvbWUuc3RvcmFnZS5vbkNoYW5nZWQuYWRkTGlzdGVuZXIoKGNoYW5nZXMsIGFyZWEpID0+IHtcbiAgICBpZiAoYXJlYSAhPT0gJ2xvY2FsJykgcmV0dXJuO1xuXG4gICAgaWYgKGNoYW5nZXMucnVucykge1xuICAgICAgICBjb25zdCBydW5zID0gY2hhbmdlcy5ydW5zLm5ld1ZhbHVlIGFzIFJ1bkxvZ1tdIHwgdW5kZWZpbmVkO1xuICAgICAgICBsYXN0TG9nID0gcnVucz8uWzBdO1xuICAgICAgICByZW5kZXJMb2cobGFzdExvZyk7XG4gICAgICAgIHJlbmRlclBsYW4oKTtcbiAgICB9XG5cbiAgICAvLyBPbmx5IHJlLXJlbmRlciBmcm9tIGEgYmFja2dyb3VuZCB3cml0ZSwgbmV2ZXIgZnJvbSB0aGlzIHBvcHVwJ3Mgb3duIHNhdmUsXG4gICAgLy8gb3IgZXZlcnkga2V5c3Ryb2tlIHdvdWxkIHJld3JpdGUgdGhlIGZpZWxkIHVuZGVyIHRoZSBjdXJzb3IuXG4gICAgaWYgKGNoYW5nZXMuc2V0dGluZ3MgJiYgIXNhdmluZ0xvY2FsbHkpIHtcbiAgICAgICAgY3VycmVudCA9IG1lcmdlU2V0dGluZ3MoY2hhbmdlcy5zZXR0aW5ncy5uZXdWYWx1ZSBhcyBQYXJ0aWFsPFNldHRpbmdzPiB8IHVuZGVmaW5lZCk7XG4gICAgICAgIHJlbmRlclNldHRpbmdzKGN1cnJlbnQpO1xuICAgICAgICByZW5kZXJQbGFuKCk7XG4gICAgICAgIHJlbmRlckF1dG9Ob3RlKCk7XG4gICAgICAgIHJlbmRlckRlc2tTdGF0ZSgpO1xuICAgIH1cbn0pO1xuXG5lbDxIVE1MQnV0dG9uRWxlbWVudD4oJ2NsZWFyQ2FwdHVyZXMnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBjYXB0dXJlczogW10gfSk7XG4gICAgYXdhaXQgcmVuZGVyQ2FwdHVyZXMoKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQXNLTyxJQUFNLGFBQTJEO0FBQUEsRUFDcEUsU0FBUyxFQUFFLE9BQU8saUJBQWlCLEtBQUssZ0JBQWdCO0FBQUEsRUFDeEQsU0FBUyxFQUFFLE9BQU8saUJBQWlCLEtBQUssZ0JBQWdCO0FBQUEsRUFDeEQsV0FBVyxFQUFFLE9BQU8saUJBQWlCLEtBQUssZ0JBQWdCO0FBQzlEO0FBb0JPLElBQU0sbUJBQTZCO0FBQUE7QUFBQTtBQUFBLEVBR3RDLGlCQUFpQjtBQUFBLEVBQ2pCLFNBQVM7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQUlULFVBQVU7QUFBQSxFQUNWLFFBQVE7QUFBQSxFQUNSLFNBQVM7QUFBQSxFQUNULFlBQVk7QUFBQSxFQUNaLFVBQVUsQ0FBQyxVQUFVLFdBQVcsYUFBYSxZQUFZLFFBQVE7QUFBQSxFQUNqRSxNQUFNO0FBQUEsRUFDTixhQUFhO0FBQUEsRUFDYixXQUFXLENBQUM7QUFBQSxFQUNaLGFBQWEsQ0FBQztBQUFBLEVBQ2QsVUFBVTtBQUFBLEVBQ1YsVUFBVTtBQUFBLElBQ04sU0FBUztBQUFBLElBQ1QsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLElBQ3ZCLFNBQVM7QUFBQSxNQUNMLFFBQVE7QUFBQSxNQUNSLE1BQU07QUFBQSxNQUNOLE9BQU87QUFBQSxRQUNILFlBQVk7QUFBQSxRQUNaLFVBQVU7QUFBQSxNQUNkO0FBQUEsSUFDSjtBQUFBLElBQ0EsZ0JBQWdCLENBQUMsUUFBUSxTQUFTO0FBQUEsSUFDbEMsY0FBYyxDQUFDLFFBQVEs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
