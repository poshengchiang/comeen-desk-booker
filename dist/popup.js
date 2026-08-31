// src/core/config.ts
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
        const state = markedForCancel.has(iso) ? "cancel" : skipped.has(iso) ? "skip" : outcome.get(iso) ?? (planned ? "book" : "later");
        cell.classList.add(state, "clickable");
        cell.title = {
          skip: "Skipped \u2014 click to book it",
          have: "You already have this day. Clicking stops future runs re-booking it; it does not cancel the booking in Comeen.",
          taken: "Someone else has this desk that day. Clicking stops it being retried.",
          failed: "The last attempt failed on this day. Open Last run for the reason.",
          book: "Click to skip",
          later: "Beyond the booking window for now. Click to skip it in advance \u2014 it will be remembered when the window reaches it.",
          cancel: "Will be cancelled in Comeen on the next run. Click to keep it."
        }[state] ?? "Click to skip";
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvcmUvY29uZmlnLnRzIiwgIi4uL3NyYy9jb3JlL2RhdGVzLnRzIiwgIi4uL3NyYy9wb3B1cC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBXZWVrZGF5IH0gZnJvbSAnLi9kYXRlcy5qcyc7XG5cbmV4cG9ydCB0eXBlIFNsb3QgPSAnYWxsX2RheScgfCAnbW9ybmluZycgfCAnYWZ0ZXJub29uJztcblxuLyoqXG4gKiBIb3cgdGhlIGluLXBhZ2UgY29kZSBzaG91bGQgYXV0aGVudGljYXRlLlxuICpcbiAqIGBjb29raWVgICAgICAgIC0ganVzdCBzZW5kIGNyZWRlbnRpYWxzIHdpdGggdGhlIHJlcXVlc3QuIENvcnJlY3QgaWYgQ29tZWVuXG4gKiAgICAgICAgICAgICAgICAgIGF1dGhlbnRpY2F0ZXMgd2l0aCBhIHNlc3Npb24gY29va2llLlxuICogYGxvY2FsU3RvcmFnZWAgLSByZWFkIGEgdG9rZW4gb3V0IG9mIHRoZSBwYWdlJ3Mgb3duIGxvY2FsU3RvcmFnZSBhbmQgcHV0IGl0XG4gKiAgICAgICAgICAgICAgICAgIGluIGEgaGVhZGVyLiBDb3JyZWN0IGlmIENvbWVlbiB1c2VzIGEgYmVhcmVyIHRva2VuLlxuICpcbiAqIEVpdGhlciB3YXkgdGhlIHZhbHVlIGlzIHJlYWQgaW5zaWRlIHRoZSBwYWdlIGFuZCB1c2VkIHRoZXJlLiBJdCBpcyBuZXZlclxuICogY29waWVkIGludG8gZXh0ZW5zaW9uIHN0b3JhZ2UsIG5ldmVyIHBlcnNpc3RlZCwgYW5kIG5ldmVyIGxlYXZlcyB0aGUgdGFiLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhDb25maWcge1xuICAgIG1vZGU6ICdjb29raWUnIHwgJ2xvY2FsU3RvcmFnZSc7XG4gICAgLyoqIGxvY2FsU3RvcmFnZSBrZXkgaG9sZGluZyB0aGUgdG9rZW4uICovXG4gICAgc3RvcmFnZUtleT86IHN0cmluZztcbiAgICAvKiogRG90dGVkIHBhdGggaW5zaWRlIHRoZSBwYXJzZWQgSlNPTiwgZS5nLiBgc3RzVG9rZW5NYW5hZ2VyLmFjY2Vzc1Rva2VuYCAqL1xuICAgIGpzb25QYXRoPzogc3RyaW5nO1xuICAgIC8qKiBIZWFkZXIgdG8gc2V0LCBkZWZhdWx0IGBhdXRob3JpemF0aW9uYCAqL1xuICAgIGhlYWRlcj86IHN0cmluZztcbiAgICAvKiogUHJlZml4IGJlZm9yZSB0aGUgdG9rZW4sIGRlZmF1bHQgYEJlYXJlciBgICovXG4gICAgcHJlZml4Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlcXVlc3RUZW1wbGF0ZSB7XG4gICAgbWV0aG9kOiAnR0VUJyB8ICdQT1NUJyB8ICdQVVQnIHwgJ0RFTEVURSc7XG4gICAgLyoqIFBhdGggYXBwZW5kZWQgdG8gYXBpQmFzZS4gTWF5IGNvbnRhaW4gcGxhY2Vob2xkZXJzLiAqL1xuICAgIHBhdGg6IHN0cmluZztcbiAgICBxdWVyeT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgYm9keT86IHVua25vd247XG59XG5cbi8qKlxuICogSG93IHRoZSBcIndoYXQgZG8gSSBhbHJlYWR5IGhvbGRcIiByZXNwb25zZSBpcyBsYWlkIG91dC5cbiAqXG4gKiBgYXJyYXlgICAgICAgICAtIGEgZmxhdCBsaXN0IG9mIGJvb2tpbmdzLCBlYWNoIGNhcnJ5aW5nIGl0cyBvd24gZGF0ZSBmaWVsZCxcbiAqICAgICAgICAgICAgICAgICAgcmVhZCB2aWEgYGxpc3REYXRlRmllbGRzYC5cbiAqIGBkYXRlS2V5ZWRNYXBgIC0gYW4gb2JqZWN0IGtleWVkIGJ5IGBZWVlZLU1NLUREYCB3aG9zZSB2YWx1ZXMgYXJlIHRoYXQgZGF5J3NcbiAqICAgICAgICAgICAgICAgICAgZW50cmllcy4gQ29tZWVuIHJldHVybnMgdGhpcyBvbmUuIFRoZSBkYXRlIGlzIHRoZSAqa2V5Kiwgbm90XG4gKiAgICAgICAgICAgICAgICAgIGEgZmllbGQsIHNvIG5vIGFtb3VudCBvZiBzbmlmZmluZyBmaWVsZCBuYW1lcyB3b3VsZCBmaW5kIGl0IFx1MjAxNFxuICogICAgICAgICAgICAgICAgICB3aGljaCBpcyBleGFjdGx5IHdoeSB0aGUgc2hhcGUgaXMgY29uZmlndXJhdGlvbiByYXRoZXIgdGhhblxuICogICAgICAgICAgICAgICAgICBzb21ldGhpbmcgdGhlIGluLXBhZ2UgY29kZSBndWVzc2VzLlxuICovXG5leHBvcnQgdHlwZSBMaXN0U2hhcGUgPSAnYXJyYXknIHwgJ2RhdGVLZXllZE1hcCc7XG5cbi8qKlxuICogVGhlIHdob2xlIEFQSSBjb250cmFjdCBsaXZlcyBoZXJlIGFzIGRhdGEgc28gaXQgY2FuIGJlIGNvcnJlY3RlZCBmcm9tIHRoZVxuICogcG9wdXAgd2l0aG91dCByZWJ1aWxkaW5nLiBQbGFjZWhvbGRlcnMgYXZhaWxhYmxlIHRvIHBhdGhzLCBxdWVyaWVzIGFuZFxuICogYm9kaWVzOiB7e2RhdGV9fSwge3tkZXNrSWR9fSwge3tkZXNrTmFtZX19LCB7e3Nsb3R9fSwge3tzdGFydFRpbWV9fSxcbiAqIHt7ZW5kVGltZX19LCB7e2Zyb219fSwge3t0b319LCB7e3VzZXJJZH19LCB7e2Zsb29ySWR9fSwge3tidWlsZGluZ0lkfX0sXG4gKiB7e2FyZWFJZH19LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEVuZHBvaW50Q29uZmlnIHtcbiAgICBhcGlCYXNlOiBzdHJpbmc7XG4gICAgYXV0aDogQXV0aENvbmZpZztcbiAgICAvKipcbiAgICAgKiBMb29rIGEgZGVzayB1cCBieSBpdHMgaHVtYW4gbmFtZSBzbyBub2JvZHkgaGFzIHRvIGtub3cgaXRzIGludGVybmFsIGlkLlxuICAgICAqIFNldCB0byBudWxsIG9ubHkgaWYgeW91ciBDb21lZW4gaGFzIG5vIGRlc2stc2VhcmNoIGVuZHBvaW50LlxuICAgICAqL1xuICAgIHJlc29sdmU6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqIEZpZWxkIG5hbWVzIHRoYXQgbWlnaHQgaG9sZCBhIGRlc2sncyBodW1hbiBsYWJlbCBpbiBhIHNlYXJjaCByZXN1bHQuICovXG4gICAgZGVza05hbWVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKiBGaWVsZCBuYW1lcyB0aGF0IG1pZ2h0IGhvbGQgYSBkZXNrJ3MgaW50ZXJuYWwgaWQuIENvbWVlbiB1c2VzIGB1dWlkYC4gKi9cbiAgICBkZXNrSWRGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIEZpZWxkIG9uIGEgZGVzayByZWNvcmQgaG9sZGluZyB0aGF0IGRlc2sncyBvd24gYm9va2luZ3MgZm9yIHRoZSBxdWVyaWVkXG4gICAgICogd2luZG93LiBVc2VkIHRvIHRlbGwgeW91IGEgZGF5IGlzIGFscmVhZHkgdGFrZW4gKmJlZm9yZSogeW91IHByZXNzIEJvb2tcbiAgICAgKiBub3cuIFNldCB0byAnJyB0byBkaXNhYmxlLlxuICAgICAqL1xuICAgIGRlc2tTY2hlZHVsZUZpZWxkOiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogRGF0ZSBmaWVsZHMgdG8gcmVhZCBvZmYgb25lIG9mIHRob3NlIGVudHJpZXMsIGluIHByaW9yaXR5IG9yZGVyLCBmaXJzdFxuICAgICAqIG1hdGNoIHdpbnMuXG4gICAgICpcbiAgICAgKiBUaGUgb3JkZXIgbWF0dGVycyBtb3JlIHRoYW4gaXQgbG9va3M6IGFuIGVudHJ5IGFsbW9zdCBjZXJ0YWlubHkgYWxzb1xuICAgICAqIGNhcnJpZXMgY3JlYXRlZF9hdCBhbmQgdXBkYXRlZF9hdCwgd2hpY2ggYXJlIHdoZW4gdGhlIGJvb2tpbmcgd2FzIG1hZGUsXG4gICAgICogbm90IHRoZSBkYXkgYm9va2VkLiBMaXN0aW5nIG9ubHkgdGhlIGZpZWxkcyB0aGF0IG1lYW4gXCJ0aGUgZGF5IHRoaXMgaXNcbiAgICAgKiBmb3JcIiBpcyB3aGF0IHN0b3BzIGEgYm9va2luZyBtYWRlIHRocmVlIHdlZWtzIGFnbyBmcm9tIG1hcmtpbmcgdGhyZWVcbiAgICAgKiB3ZWVrcyBhZ28gYXMgdGFrZW4uXG4gICAgICovXG4gICAgZGVza1NjaGVkdWxlRGF0ZUZpZWxkczogc3RyaW5nW107XG4gICAgLyoqIFNldCB0byBudWxsIHRvIHNraXAgdGhlIFwid2hhdCBkbyBJIGFscmVhZHkgaGF2ZVwiIGNoZWNrLiAqL1xuICAgIGxpc3Q6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqIERvdHRlZCBwYXRoIHRvIHRoZSBjb250YWluZXIgaW5zaWRlIHRoZSBsaXN0IHJlc3BvbnNlLiAnJyBtZWFucyByb290LiAqL1xuICAgIGxpc3RSb290OiBzdHJpbmc7XG4gICAgbGlzdFNoYXBlOiBMaXN0U2hhcGU7XG4gICAgLyoqIE9ubHkgY29uc3VsdGVkIHdoZW4gbGlzdFNoYXBlIGlzICdhcnJheScuICovXG4gICAgbGlzdERhdGVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIERvdHRlZCBwYXRoIHRvIHRoZSBzaWduZWQtaW4gdXNlcidzIGlkIGluc2lkZSB0aGUgbGlzdCByZXNwb25zZS4gRW1wdHlcbiAgICAgKiBkaXNhYmxlcyB0aGUgbG9va3VwLCBhbmQge3t1c2VySWR9fSB0aGVuIHN0YXlzIHVuZmlsbGVkLlxuICAgICAqL1xuICAgIHVzZXJJZFBhdGg6IHN0cmluZztcbiAgICBjcmVhdGU6IFJlcXVlc3RUZW1wbGF0ZTtcbiAgICAvKipcbiAgICAgKiBDYW5jZWwgYSBib29raW5nLiBTZXQgdG8gbnVsbCB0byBkaXNhYmxlIGNhbmNlbGxpbmcgZW50aXJlbHkuXG4gICAgICpcbiAgICAgKiBUYWtlcyB7e2Jvb2tpbmdJZH19LCByZWFkIG9mZiB0aGUgbGlzdGVkIGJvb2tpbmcgdmlhIGxpc3RCb29raW5nSWRGaWVsZHMgXHUyMDE0XG4gICAgICogc28gY2FuY2VsbGluZyBkZXBlbmRzIG9uIGBsaXN0YCB3b3JraW5nLCB3aGljaCBpcyBjb3JyZWN0OiB5b3UgY2Fubm90XG4gICAgICogY2FuY2VsIHdoYXQgeW91IGhhdmUgbm90IGNvbmZpcm1lZCB5b3UgaG9sZC5cbiAgICAgKi9cbiAgICBjYW5jZWw6IFJlcXVlc3RUZW1wbGF0ZSB8IG51bGw7XG4gICAgLyoqXG4gICAgICogRmllbGRzIG9uIGEgbGlzdGVkIGJvb2tpbmcgdGhhdCBpZGVudGlmeSBpdCBmb3IgY2FuY2VsbGF0aW9uLCBpbiBwcmlvcml0eVxuICAgICAqIG9yZGVyLiBDb21lZW4gd2FudHMgdGhlIG51bWVyaWMgYGlkYCBoZXJlLCBOT1QgdGhlIGB1dWlkYCB0aGF0IHRoZSBzYW1lXG4gICAgICogZW50cnkgYWxzbyBjYXJyaWVzIGFuZCB0aGF0IHRoZSBjcmVhdGUgYm9keSB1c2VzIGZvciB0aGUgZGVzay4gR2V0dGluZ1xuICAgICAqIHRoaXMgd3JvbmcgaXMgYSA0MDQgYXQgYmVzdC5cbiAgICAgKi9cbiAgICBsaXN0Qm9va2luZ0lkRmllbGRzOiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5ncyB7XG4gICAgLyoqXG4gICAgICogQnVtcGVkIGluIERFRkFVTFRfU0VUVElOR1Mgd2hlbmV2ZXIgdGhlIHNoaXBwZWQgZW5kcG9pbnQgY29uZmlnIGlzXG4gICAgICogY29ycmVjdGVkLiBTZWUgbWVyZ2VTZXR0aW5nczogYSBzdG9yZWQgY29uZmlnIG9sZGVyIHRoYW4gdGhlIHNoaXBwZWQgb25lXG4gICAgICogaXMgcmVwbGFjZWQgcmF0aGVyIHRoYW4gbWVyZ2VkLCB3aGljaCBpcyB3aGF0IGxldHMgYSBmaXggYWN0dWFsbHkgcmVhY2hcbiAgICAgKiBwZW9wbGUgd2hvIGhhdmUgYWxyZWFkeSBzYXZlZCBzZXR0aW5ncyBvbmNlLlxuICAgICAqL1xuICAgIGVuZHBvaW50VmVyc2lvbjogbnVtYmVyO1xuICAgIGVuYWJsZWQ6IGJvb2xlYW47XG4gICAgZGVza05hbWU6IHN0cmluZztcbiAgICBkZXNrSWQ6IHN0cmluZztcbiAgICAvKipcbiAgICAgKiBUaGUgZmxvb3IgdGhlIGRlc2sgaXMgb24uIFRoaXMgb25lIGNhbm5vdCBiZSBkZXJpdmVkOiByZXNvbHZpbmcgYSBkZXNrIGJ5XG4gICAgICogbmFtZSBtZWFucyBsaXN0aW5nIGEgZmxvb3IncyBkZXNrcywgc28gdGhlIGZsb29yIGhhcyB0byBiZSBrbm93biBmaXJzdC5cbiAgICAgKiBWaXNpYmxlIGluIHRoZSBVUkwgb2YgQ29tZWVuJ3MgZmxvb3IgcGxhbiwgYW5kIGluIGBmbG9vcl9pZGAgb24gYW55IGRlc2suXG4gICAgICovXG4gICAgZmxvb3JJZDogbnVtYmVyO1xuICAgIC8qKlxuICAgICAqIFRoZSBidWlsZGluZyB0aGUgZmxvb3IgaXMgaW4uIEFsc28gbm90IGRlcml2YWJsZSBcdTIwMTQgYSBkZXNrIHJlY29yZCBjYXJyaWVzXG4gICAgICogYGZsb29yX2lkYCBhbmQgYGFyZWFfaWRgIGJ1dCBubyBgYnVpbGRpbmdfaWRgLCBhbmQgdGhlIG9ubHkgZW5kcG9pbnQgdGhhdFxuICAgICAqIG1hcHMgb25lIHRvIHRoZSBvdGhlciBuZWVkcyBhIHNwYWNlIFVVSUQgd2UgbmV2ZXIgb3RoZXJ3aXNlIGZldGNoLlxuICAgICAqL1xuICAgIGJ1aWxkaW5nSWQ6IG51bWJlcjtcbiAgICB3ZWVrZGF5czogV2Vla2RheVtdO1xuICAgIHNsb3Q6IFNsb3Q7XG4gICAgaG9yaXpvbkRheXM6IG51bWJlcjtcbiAgICBza2lwRGF0ZXM6IHN0cmluZ1tdO1xuICAgIC8qKlxuICAgICAqIERheXMgd2hvc2UgYm9va2luZyBzaG91bGQgYmUgY2FuY2VsbGVkIG9uIHRoZSBuZXh0IHJ1bi5cbiAgICAgKlxuICAgICAqIEEgb25lLXNob3QgaW5zdHJ1Y3Rpb24sIG5vdCBhIHByZWZlcmVuY2U6IGFuIGVudHJ5IGlzIHJlbW92ZWQgb25jZSB0aGVcbiAgICAgKiBjYW5jZWxsYXRpb24gc3VjY2VlZHMsIG9yIHRoZSBuZXh0IGF1dG9tYXRpYyBydW4gd291bGQga2VlcCB0cnlpbmcgdG9cbiAgICAgKiBkZWxldGUgc29tZXRoaW5nIGFscmVhZHkgZ29uZS4gQWRkaW5nIGEgZGF0ZSBoZXJlIGFsc28gYWRkcyBpdCB0b1xuICAgICAqIHNraXBEYXRlcyBcdTIwMTQgb3RoZXJ3aXNlIHRoZSBzYW1lIHJ1biB0aGF0IGNhbmNlbHMgaXQgYm9va3MgaXQgc3RyYWlnaHQgYmFjay5cbiAgICAgKi9cbiAgICBjYW5jZWxEYXRlczogc3RyaW5nW107XG4gICAgdGltZVpvbmU6IHN0cmluZztcbiAgICBlbmRwb2ludDogRW5kcG9pbnRDb25maWc7XG59XG5cbi8qKlxuICogQSBzbG90IGFzIHRoZSBuYWl2ZSBsb2NhbCB0aW1lcyBDb21lZW4gZXhwZWN0cy5cbiAqXG4gKiBDb21lZW4gc2VuZHMgZGF0ZXRpbWVzIGxpa2UgYDIwMjYtMDktMDFUMDA6MDA6MDAuMDAwWmAgYW5kIGVjaG9lcyB0aGVtIGJhY2tcbiAqIGFzIGAyMDI2LTA5LTAxVDAwOjAwOjAwYCBcdTIwMTQgYSBsb2NhbCB3YWxsLWNsb2NrIHRpbWUgd2VhcmluZyBhIGBaYC4gU28gdGhlIGRheVxuICogaXMgdXNlZCB2ZXJiYXRpbSBhbmQgbm8gdGltZXpvbmUgY29udmVyc2lvbiBoYXBwZW5zIGFueXdoZXJlIGluIHRoZSBib29raW5nXG4gKiBwYXRoLiBUaGUgZGF0ZSBsb2dpYyBpbiBkYXRlcy50cyBhbHJlYWR5IHByb2R1Y2VzIGV4YWN0bHkgdGhpcy5cbiAqXG4gKiBBbGwgdGhyZWUgY29uZmlybWVkIGFnYWluc3Qgd2hhdCBDb21lZW4ncyBvd24gd2ViIFVJIHNlbmRzLiBUaGUgaGFsZi1kYXlzXG4gKiB3ZXJlIGd1ZXNzZWQgZmlyc3QgYW5kIG9uZSBndWVzcyB3YXMgd3Jvbmc6IG1vcm5pbmcgZW5kcyBhdCAxMTo1OTo1OSwgbm90IGF0XG4gKiAxMjowMDowMCwgZm9sbG93aW5nIHRoZSBzYW1lIFwibGFzdCBzZWNvbmQgb2YgdGhlIHBlcmlvZFwiIHBhdHRlcm4gYXMgYWxsX2RheS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNMT1RfVElNRVM6IFJlY29yZDxTbG90LCB7IHN0YXJ0OiBzdHJpbmc7IGVuZDogc3RyaW5nIH0+ID0ge1xuICAgIGFsbF9kYXk6IHsgc3RhcnQ6ICcwMDowMDowMC4wMDBaJywgZW5kOiAnMjM6NTk6NTkuMDAwWicgfSxcbiAgICBtb3JuaW5nOiB7IHN0YXJ0OiAnMDA6MDA6MDAuMDAwWicsIGVuZDogJzExOjU5OjU5LjAwMFonIH0sXG4gICAgYWZ0ZXJub29uOiB7IHN0YXJ0OiAnMTI6MDA6MDAuMDAwWicsIGVuZDogJzIzOjU5OjU5LjAwMFonIH0sXG59O1xuXG4vKipcbiAqIENvbmZpcm1lZCBhZ2FpbnN0IGEgcmVhbCBzaWduZWQtaW4gc2Vzc2lvbiBpbiBBdWd1c3QgMjAyNiwgYnkgY2FwdHVyaW5nIHRoZVxuICogdHJhZmZpYyBvZiBvbmUgZGVzayBib29raW5nIG1hZGUgYnkgaGFuZC5cbiAqXG4gKiBOb3RlcyB3b3J0aCBrZWVwaW5nLCBiZWNhdXNlIGVhY2ggb25lIGNvbnRyYWRpY3RzIGEgcmVhc29uYWJsZSBndWVzczpcbiAqICAgLSBgYXBpQmFzZWAgaXMgbXkuY29tZWVuLmlvL2FwaSwgdGhlIFNQQSdzIG93biBvcmlnaW4sIE5PVCBhcGkuY29tZWVuLmlvXG4gKiAgICAgd2hlcmUgdGhlIHB1YmxpYyBkb2NzIGxpdmUuIEl0IGlzIGEgUmFpbHMgYmFja2VuZCBiZWhpbmQgYSBOdXh0IGZyb250IGVuZCxcbiAqICAgICB3aGljaCBpcyB3aHkgcGF0aHMgZW5kIGluIGAuanNvbmAuXG4gKiAgIC0gVGhlIEFQSSB2ZXJzaW9uIHZhcmllcyBwZXIgZW5kcG9pbnQgKC92MSwgL3YyLCAvdjJiZXRhKSwgc28gdGhlIHZlcnNpb25cbiAqICAgICBiZWxvbmdzIGluIGVhY2ggcGF0aCByYXRoZXIgdGhhbiBpbiBhcGlCYXNlLlxuICogICAtIEEgZGVzaydzIGlkIGlzIGB1dWlkYC4gVGhlcmUgaXMgbm8gYGlkYCBmaWVsZCBvbiBhIGRlc2sgYXQgYWxsLlxuICogICAtIFRoZSBib29raW5ncyBsaXN0IGlzIGtleWVkIGJ5IGRhdGU7IHRoZSBkYXRlIGlzIG5vdCBhIGZpZWxkIG9uIGFuIGVudHJ5LlxuICogICAtIEEgYm9va2luZyBpcyBhIFwid29yayBhY3Rpdml0eVwiIHdpdGggYSBkZXNrIGF0dGFjaGVkLCBub3QgYSBkZXNrIGJvb2tpbmdcbiAqICAgICBhcyBzdWNoLiBUaGF0IGlzIHdoeSB0aGUgcGF0aCBzYXlzIHdvcmtfYWN0aXZpdHlfc2NoZWR1bGUuXG4gKiAgIC0gQXV0aCBpcyB0aGUgc2Vzc2lvbiBjb29raWUuIEEgZmV0Y2ggZnJvbSB0aGUgcGFnZSB3aXRoIGNyZWRlbnRpYWxzXG4gKiAgICAgaW5jbHVkZWQgYW5kIG5vIEF1dGhvcml6YXRpb24gaGVhZGVyIHJldHVybnMgMjAwLCBzbyB0aGVyZSBpcyBubyB0b2tlbiB0b1xuICogICAgIHJlYWQgYW5kIG5vdGhpbmcgZm9yIHRoZSBleHRlbnNpb24gdG8gaG9sZC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFNldHRpbmdzID0ge1xuICAgIC8vIFx1MkIwNiBCVU1QIFRISVMgd2hlbmV2ZXIgeW91IGNvcnJlY3QgdGhlIGBlbmRwb2ludGAgYmxvY2sgYmVsb3csIG90aGVyd2lzZVxuICAgIC8vIGFueW9uZSB3aG8gYWxyZWFkeSBwcmVzc2VkIFNhdmUga2VlcHMgdGhlaXIgc3RhbGUgY29weSBmb3JldmVyLlxuICAgIGVuZHBvaW50VmVyc2lvbjogNCxcbiAgICBlbmFibGVkOiBmYWxzZSxcbiAgICAvLyBFbXB0eSBvbiBwdXJwb3NlLiBTaGlwcGluZyBhIHJlYWwgZGVzayBudW1iZXIgYXMgdGhlIGRlZmF1bHQgbWVhbnMgdGhlXG4gICAgLy8gZmlyc3QgcGVyc29uIHRvIGluc3RhbGwgdGhpcyBhbmQgcHJlc3MgQm9vayBub3cgdGFrZXMgc29tZWJvZHkgZWxzZSdzXG4gICAgLy8gc2VhdCwgaGF2aW5nIGRvbmUgbm90aGluZyB3cm9uZy4gTm90aGluZyBydW5zIHVudGlsIGEgZGVzayBpcyBjaG9zZW4uXG4gICAgZGVza05hbWU6ICcnLFxuICAgIGRlc2tJZDogJycsXG4gICAgZmxvb3JJZDogNDk1MixcbiAgICBidWlsZGluZ0lkOiA1MTUxLFxuICAgIHdlZWtkYXlzOiBbJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknXSxcbiAgICBzbG90OiAnYWxsX2RheScsXG4gICAgaG9yaXpvbkRheXM6IDE0LFxuICAgIHNraXBEYXRlczogW10sXG4gICAgY2FuY2VsRGF0ZXM6IFtdLFxuICAgIHRpbWVab25lOiAnRXVyb3BlL1ByYWd1ZScsXG4gICAgZW5kcG9pbnQ6IHtcbiAgICAgICAgYXBpQmFzZTogJ2h0dHBzOi8vbXkuY29tZWVuLmlvL2FwaScsXG4gICAgICAgIGF1dGg6IHsgbW9kZTogJ2Nvb2tpZScgfSxcbiAgICAgICAgcmVzb2x2ZToge1xuICAgICAgICAgICAgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgICAgIHBhdGg6ICcvdjEvZmxvb3JzL3t7Zmxvb3JJZH19L2Rlc2tzX3NjaGVkdWxlLmpzb24nLFxuICAgICAgICAgICAgcXVlcnk6IHtcbiAgICAgICAgICAgICAgICBzdGFydF9kYXRlOiAne3tmcm9tfX1UMDA6MDA6MDAuMDAwWicsXG4gICAgICAgICAgICAgICAgZW5kX2RhdGU6ICd7e3RvfX1UMjM6NTk6NTkuMDAwWicsXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBkZXNrTmFtZUZpZWxkczogWyduYW1lJywgJ3N5bmNfaWQnXSxcbiAgICAgICAgZGVza0lkRmllbGRzOiBbJ3V1aWQnLCAnaWQnXSxcbiAgICAgICAgZGVza1NjaGVkdWxlRmllbGQ6ICdzY2hlZHVsZScsXG4gICAgICAgIGRlc2tTY2hlZHVsZURhdGVGaWVsZHM6IFsnc3RhcnRfZGF0ZXRpbWUnLCAnc3RhcnRfZGF0ZScsICdkYXRlJywgJ2RheScsICdzdGFydCddLFxuICAgICAgICBsaXN0OiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICAgICAgcGF0aDogJy92MS91c2Vycy9tZS93b3JrX2FjdGl2aXR5X3NjaGVkdWxlLmpzb24nLFxuICAgICAgICAgICAgcXVlcnk6IHtcbiAgICAgICAgICAgICAgICBzdGFydF9kYXRlOiAne3tmcm9tfX1UMDA6MDA6MDAuMDAwWicsXG4gICAgICAgICAgICAgICAgZW5kX2RhdGU6ICd7e3RvfX1UMjM6NTk6NTkuMDAwWicsXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBsaXN0Um9vdDogJ3NjaGVkdWxlJyxcbiAgICAgICAgbGlzdFNoYXBlOiAnZGF0ZUtleWVkTWFwJyxcbiAgICAgICAgbGlzdERhdGVGaWVsZHM6IFsnc3RhcnRfZGF0ZXRpbWUnLCAnZGF0ZSddLFxuICAgICAgICB1c2VySWRQYXRoOiAndXNlci5pZCcsXG4gICAgICAgIGxpc3RCb29raW5nSWRGaWVsZHM6IFsnaWQnLCAndXVpZCddLFxuICAgICAgICBjcmVhdGU6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICAgICAgLy8gVGhlIGBtZWAgYWxpYXMgd29ya3MgZm9yIHJlYWRzOyB0aGUgYXBwIGl0c2VsZiB1c2VzIHRoZSBudW1lcmljXG4gICAgICAgICAgICAvLyBpZCB0byB3cml0ZSwgc28gdGhhdCBpcyB3aGF0IGlzIHVzZWQgaGVyZS5cbiAgICAgICAgICAgIHBhdGg6ICcvdjEvdXNlcnMve3t1c2VySWR9fS93b3JrX2FjdGl2aXR5X3NjaGVkdWxlLmpzb24nLFxuICAgICAgICAgICAgYm9keToge1xuICAgICAgICAgICAgICAgIHdvcmtfYWN0aXZpdHk6IHtcbiAgICAgICAgICAgICAgICAgICAgc3RhdGU6ICdvbl9zaXRlJyxcbiAgICAgICAgICAgICAgICAgICAgc3RhcnRfZGF0ZXRpbWU6ICd7e2RhdGV9fVR7e3N0YXJ0VGltZX19JyxcbiAgICAgICAgICAgICAgICAgICAgZW5kX2RhdGV0aW1lOiAne3tkYXRlfX1Ue3tlbmRUaW1lfX0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgcHJlc2VuY2U6IHtcbiAgICAgICAgICAgICAgICAgICAgYnVpbGRpbmdfaWQ6ICd7e2J1aWxkaW5nSWR9fScsXG4gICAgICAgICAgICAgICAgICAgIGZsb29yX2lkOiAne3tmbG9vcklkfX0nLFxuICAgICAgICAgICAgICAgICAgICBhcmVhX2lkOiAne3thcmVhSWR9fScsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBkZXNrX2Jvb2tpbmc6IHsgZGVza191dWlkOiAne3tkZXNrSWR9fScgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGNhbmNlbDoge1xuICAgICAgICAgICAgbWV0aG9kOiAnREVMRVRFJyxcbiAgICAgICAgICAgIC8vIE5vdGUgYC9tZS9gLCBub3QgYC91c2Vycy97e3VzZXJJZH19L2AgYXMgY3JlYXRlIHVzZXMsIGFuZCB0aGVcbiAgICAgICAgICAgIC8vIG51bWVyaWMgYm9va2luZyBpZCByYXRoZXIgdGhhbiBpdHMgdXVpZC4gQm90aCBjb25maXJtZWQgZnJvbSBhXG4gICAgICAgICAgICAvLyBjYXB0dXJlZCBjYW5jZWxsYXRpb247IG5laXRoZXIgaXMgd2hhdCB5b3Ugd291bGQgaGF2ZSBndWVzc2VkXG4gICAgICAgICAgICAvLyBmcm9tIHRoZSBjcmVhdGUgY2FsbC5cbiAgICAgICAgICAgIHBhdGg6ICcvdjEvbWUvd29ya19hY3Rpdml0eV9zY2hlZHVsZS97e2Jvb2tpbmdJZH19JyxcbiAgICAgICAgfSxcbiAgICB9LFxufTtcblxuLyoqXG4gKiBUaGUgb2ZmaWNlLCBhcyBjYXB0dXJlZCBpbiBBdWd1c3QgMjAyNi5cbiAqXG4gKiBIYXJkY29kZWQgcmF0aGVyIHRoYW4gZmV0Y2hlZC4gVGhlIGZsb29yIGRyb3Bkb3duIGhhcyB0byBiZSBwb3B1bGF0ZWQgYmVmb3JlXG4gKiBhbnkgbmV0d29yayBjYWxsIGhhcHBlbnMsIGFuIG9mZmljZSBsYXlvdXQgY2hhbmdlcyBhYm91dCBuZXZlciwgYW5kIGFcbiAqIGhhcmRjb2RlZCBmbG9vciB0aGF0IGlzIHdyb25nIGlzIGEgdmlzaWJsZSBtaXN0YWtlIHJhdGhlciB0aGFuIGEgc2lsZW50IG9uZS5cbiAqXG4gKiBUbyBhZGQgYSBmbG9vciwgcmVhZCB0aGUgaWRzIGZyb20gdGhlIHJlc3BvbnNlIG9mXG4gKiAvYXBpL3YyL3NwYWNlcy88c3BhY2UtdXVpZD4vYnVpbGRpbmdzLzxidWlsZGluZy1pZD4vZmxvb3JzLmpzb24gd2l0aCB0aGVcbiAqIGZsb29yIHBsYW4gb3Blbi5cbiAqL1xuZXhwb3J0IGNvbnN0IEJVSUxESU5HID0geyBpZDogNTE1MSwgbmFtZTogJzEwMHlhcmRzJyB9O1xuXG4vKipcbiAqIEEgZGVzayBuYW1lIGlzIGRpZ2l0cywgYSBkYXNoLCBkaWdpdHMgXHUyMDE0IGAzLTIzYCwgYDEyLTRgLlxuICpcbiAqIERlbGliZXJhdGVseSBub3QgdGlnaHRlbmVkIHRvIHR3byB6ZXJvLXBhZGRlZCBkaWdpdHMsIHdoaWNoIGlzIHdoYXQgdGhpc1xuICogb2ZmaWNlIGhhcHBlbnMgdG8gdXNlOiBhIGZsb29yIDEyIG9yIGEgZGVzayAxMDAgd291bGQgdGhlbiBiZSByZWplY3RlZCBmb3JcbiAqIGxvb2tpbmcgd3JvbmcgcmF0aGVyIHRoYW4gZm9yIGJlaW5nIHdyb25nLiBXaGF0IHRoaXMgY2F0Y2hlcyBpcyB0aGUgbWlzdGFrZVxuICogcGVvcGxlIGFjdHVhbGx5IG1ha2UgXHUyMDE0IHR5cGluZyBzb21ldGhpbmcgdGhhdCBpcyBub3QgYSBkZXNrIG51bWJlciBhdCBhbGw6IGFcbiAqIG5hbWUsIGEgcm9vbSwgYSBzdHJheSBzcGFjZS5cbiAqL1xuZXhwb3J0IGNvbnN0IERFU0tfTkFNRV9QQVRURVJOID0gL15cXGQrLVxcZCskLztcblxuLyoqIEVtcHR5IGlzIG5vdCB2YWxpZCwgYnV0IGl0IGlzIG5vdCBhbiBlcnJvciBlaXRoZXIgXHUyMDE0IHNlZSB0aGUgcG9wdXAuICovXG5leHBvcnQgZnVuY3Rpb24gaXNWYWxpZERlc2tOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBERVNLX05BTUVfUEFUVEVSTi50ZXN0KG5hbWUudHJpbSgpKTtcbn1cblxuLyoqXG4gKiBEcm9wIHNraXAgZGF0ZXMgdGhhdCBoYXZlIGFscmVhZHkgcGFzc2VkLlxuICpcbiAqIERheXMgY2FuIGJlIG1hcmtlZCBtb250aHMgYWhlYWQsIHNvIHdpdGhvdXQgdGhpcyB0aGUgbGlzdCBvbmx5IGV2ZXIgZ3Jvd3MgXHUyMDE0XG4gKiBhIHllYXIgb2YgXCJJIHdhcyBhd2F5IHRoYXQgVHVlc2RheVwiIGFjY3VtdWxhdGluZyBpbiBzdG9yYWdlIGFuZCBpbiB0aGVcbiAqIHNldHRpbmdzIEpTT04sIHdoZXJlIGl0IGlzIG5vaXNlIHRoYXQgbWFrZXMgdGhlIHJlYWwgZW50cmllcyBoYXJkIHRvIHJlYWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcnVuZVBhc3RTa2lwRGF0ZXMoc2tpcERhdGVzOiBzdHJpbmdbXSwgdG9kYXk6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gc2tpcERhdGVzLmZpbHRlcigoZGF0ZSkgPT4gZGF0ZSA+PSB0b2RheSk7XG59XG5cbmV4cG9ydCBjb25zdCBGTE9PUlM6IHsgaWQ6IG51bWJlcjsgbGFiZWw6IHN0cmluZyB9W10gPSBbXG4gICAgeyBpZDogNDk1MiwgbGFiZWw6ICdGbG9vciAzJyB9LFxuICAgIHsgaWQ6IDQ5NTMsIGxhYmVsOiAnRmxvb3IgNCcgfSxcbl07XG5cbmV4cG9ydCB0eXBlIFZhcnMgPSBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4vKipcbiAqIEEgcGxhY2Vob2xkZXIgdGhhdCBtYWtlcyB1cCB0aGUgKmVudGlyZSogdmFsdWUgYW5kIHJlc29sdmVzIHRvIGFuIGludGVnZXJcbiAqIGJlY29tZXMgYSBudW1iZXIuXG4gKlxuICogVGhpcyBtYXR0ZXJzIGJlY2F1c2UgSlNPTiBkaXN0aW5ndWlzaGVzIDUxNTEgZnJvbSBcIjUxNTFcIiBhbmQgQ29tZWVuJ3NcbiAqIHByZXNlbmNlIGJsb2NrIHdhbnRzIHRoZSBmb3JtZXIuIFBhcnRpYWwgaW50ZXJwb2xhdGlvbiBcdTIwMTQgXCIvdXNlcnMve3t1c2VySWR9fS94XCJcbiAqIFx1MjAxNCBhbHdheXMgeWllbGRzIGEgc3RyaW5nLCB3aGljaCBpcyB3aGF0IGEgcGF0aCBuZWVkcywgc28gdGhlIHR3byBjYXNlcyBuZXZlclxuICogY29sbGlkZS4gQSB1dWlkIG9yIGEgZGF0ZSBjb250YWlucyBub24tZGlnaXRzIGFuZCBzdGF5cyBhIHN0cmluZyBlaXRoZXIgd2F5LlxuICovXG5jb25zdCBXSE9MRV9QTEFDRUhPTERFUiA9IC9eXFx7XFx7KFxcdyspXFx9XFx9JC87XG5jb25zdCBJTlRFR0VSID0gL14tP1xcZCskLztcblxuLyoqIFJlcGxhY2Uge3twbGFjZWhvbGRlcnN9fSB0aHJvdWdob3V0IGEgSlNPTi1pc2ggdmFsdWUuICovXG5leHBvcnQgZnVuY3Rpb24gc3Vic3RpdHV0ZSh2YWx1ZTogdW5rbm93biwgdmFyczogVmFycyk6IHVua25vd24ge1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGNvbnN0IHdob2xlID0gV0hPTEVfUExBQ0VIT0xERVIuZXhlYyh2YWx1ZSk7XG4gICAgICAgIGlmICh3aG9sZSkge1xuICAgICAgICAgICAgY29uc3QgcmVwbGFjZW1lbnQgPSB2YXJzW3dob2xlWzFdID8/ICcnXTtcbiAgICAgICAgICAgIGlmIChyZXBsYWNlbWVudCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdmFsdWU7XG4gICAgICAgICAgICByZXR1cm4gSU5URUdFUi50ZXN0KHJlcGxhY2VtZW50KSA/IE51bWJlcihyZXBsYWNlbWVudCkgOiByZXBsYWNlbWVudDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmFsdWUucmVwbGFjZSgvXFx7XFx7KFxcdyspXFx9XFx9L2csIChtYXRjaCwga2V5OiBzdHJpbmcpID0+IHZhcnNba2V5XSA/PyBtYXRjaCk7XG4gICAgfVxuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICByZXR1cm4gdmFsdWUubWFwKChlbnRyeSkgPT4gc3Vic3RpdHV0ZShlbnRyeSwgdmFycykpO1xuICAgIH1cbiAgICBpZiAodmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgZW50cnldIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlKSkgb3V0W2tleV0gPSBzdWJzdGl0dXRlKGVudHJ5LCB2YXJzKTtcbiAgICAgICAgcmV0dXJuIG91dDtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKipcbiAqIE1lcmdlIHN0b3JlZCBzZXR0aW5ncyBvdmVyIHRoZSBzaGlwcGVkIGRlZmF1bHRzLlxuICpcbiAqIFBlcnNvbmFsIGNob2ljZXMgKGRlc2ssIHdlZWtkYXlzLCB0aW1lem9uZSkgYWx3YXlzIHdpbjogdGhleSBhcmUgdGhlIHVzZXIncy5cbiAqIFRoZSBlbmRwb2ludCBjb25maWcgaXMgZGlmZmVyZW50LiBJdCBpcyBub3QgYSBwcmVmZXJlbmNlLCBpdCBpcyBhIGZhY3QgYWJvdXRcbiAqIENvbWVlbidzIEFQSSB0aGF0IG9uZSBwZXJzb24gZGlzY292ZXJzIGFuZCBldmVyeW9uZSBlbHNlIGluaGVyaXRzLiBJZiBhXG4gKiBzdG9yZWQgY29weSBwcmVkYXRlcyB0aGUgc2hpcHBlZCBvbmUsIHRoZSBzaGlwcGVkIG9uZSByZXBsYWNlcyBpdCBvdXRyaWdodC5cbiAqIE1lcmdpbmcga2V5LWJ5LWtleSB3b3VsZCBiZSB3b3JzZSB0aGFuIHVzZWxlc3MgaGVyZTogYSBjb3JyZWN0ZWQgYGNyZWF0ZWBcbiAqIGJsb2NrIHdvdWxkIHNpdCBuZXh0IHRvIGEgc3RhbGUgYGxpc3RgIGJsb2NrIGFuZCBmYWlsIGluIGEgY29uZnVzaW5nIHdheS5cbiAqXG4gKiBQdXJlIGFuZCBzZXBhcmF0ZSBmcm9tIGNocm9tZS5zdG9yYWdlIHNvIGl0IGNhbiBiZSB0ZXN0ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZVNldHRpbmdzKHN0b3JlZDogUGFydGlhbDxTZXR0aW5ncz4gfCB1bmRlZmluZWQpOiBTZXR0aW5ncyB7XG4gICAgY29uc3Qgc3RvcmVkVmVyc2lvbiA9IHN0b3JlZD8uZW5kcG9pbnRWZXJzaW9uID8/IDA7XG4gICAgY29uc3Qgc2hpcHBlZElzTmV3ZXIgPSBzdG9yZWRWZXJzaW9uIDwgREVGQVVMVF9TRVRUSU5HUy5lbmRwb2ludFZlcnNpb247XG5cbiAgICByZXR1cm4ge1xuICAgICAgICAuLi5ERUZBVUxUX1NFVFRJTkdTLFxuICAgICAgICAuLi5zdG9yZWQsXG4gICAgICAgIGVuZHBvaW50VmVyc2lvbjogREVGQVVMVF9TRVRUSU5HUy5lbmRwb2ludFZlcnNpb24sXG4gICAgICAgIGVuZHBvaW50OiBzaGlwcGVkSXNOZXdlciB8fCAhc3RvcmVkPy5lbmRwb2ludFxuICAgICAgICAgICAgPyBERUZBVUxUX1NFVFRJTkdTLmVuZHBvaW50XG4gICAgICAgICAgICA6IHN0b3JlZC5lbmRwb2ludCxcbiAgICB9O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZFNldHRpbmdzKCk6IFByb21pc2U8U2V0dGluZ3M+IHtcbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoJ3NldHRpbmdzJyk7XG4gICAgcmV0dXJuIG1lcmdlU2V0dGluZ3Moc3RvcmVkLnNldHRpbmdzIGFzIFBhcnRpYWw8U2V0dGluZ3M+IHwgdW5kZWZpbmVkKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVTZXR0aW5ncyhzZXR0aW5nczogU2V0dGluZ3MpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBzZXR0aW5ncyB9KTtcbn1cbiIsICJleHBvcnQgdHlwZSBXZWVrZGF5ID1cbiAgICB8ICdtb25kYXknIHwgJ3R1ZXNkYXknIHwgJ3dlZG5lc2RheSdcbiAgICB8ICd0aHVyc2RheScgfCAnZnJpZGF5JyB8ICdzYXR1cmRheScgfCAnc3VuZGF5JztcblxuY29uc3QgV0VFS0RBWV9OQU1FUzogcmVhZG9ubHkgV2Vla2RheVtdID0gW1xuICAgICdzdW5kYXknLCAnbW9uZGF5JywgJ3R1ZXNkYXknLCAnd2VkbmVzZGF5JywgJ3RodXJzZGF5JywgJ2ZyaWRheScsICdzYXR1cmRheScsXG5dO1xuXG5mdW5jdGlvbiBpc1dlZWtkYXkodmFsdWU6IHN0cmluZyk6IHZhbHVlIGlzIFdlZWtkYXkge1xuICAgIHJldHVybiAoV0VFS0RBWV9OQU1FUyBhcyByZWFkb25seSBzdHJpbmdbXSkuaW5jbHVkZXModmFsdWUpO1xufVxuXG4vKiogRm9ybWF0IGEgRGF0ZSBhcyBZWVlZLU1NLUREIGFzIHNlZW4gaW4gYHRpbWVab25lYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b0xvY2FsSVNPRGF0ZShkYXRlOiBEYXRlLCB0aW1lWm9uZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLUNBJywge1xuICAgICAgICB0aW1lWm9uZSwgeWVhcjogJ251bWVyaWMnLCBtb250aDogJzItZGlnaXQnLCBkYXk6ICcyLWRpZ2l0JyxcbiAgICB9KS5mb3JtYXQoZGF0ZSk7XG59XG5cbi8qKiBXZWVrZGF5IG5hbWUgb2YgYGRhdGVgIGFzIHNlZW4gaW4gYHRpbWVab25lYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2NhbFdlZWtkYXkoZGF0ZTogRGF0ZSwgdGltZVpvbmU6IHN0cmluZyk6IFdlZWtkYXkge1xuICAgIGNvbnN0IG5hbWUgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tVVMnLCB7IHRpbWVab25lLCB3ZWVrZGF5OiAnbG9uZycgfSlcbiAgICAgICAgLmZvcm1hdChkYXRlKVxuICAgICAgICAudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAoIWlzV2Vla2RheShuYW1lKSkgdGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHdlZWtkYXkgZnJvbSBJbnRsOiBcIiR7bmFtZX1cImApO1xuICAgIHJldHVybiBuYW1lO1xufVxuXG4vKiogTG9jYWwgd2FsbC1jbG9jayB0aW1lIGFzIGBZWVlZLU1NLUREVEhIOm1tOnNzYCwgbWF0Y2hpbmcgd2hhdCBDb21lZW4gc2VuZHMuICovXG5leHBvcnQgZnVuY3Rpb24gdG9Mb2NhbElTT0RhdGVUaW1lKGRhdGU6IERhdGUsIHRpbWVab25lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IHBhcnRzID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLUNBJywge1xuICAgICAgICB0aW1lWm9uZSxcbiAgICAgICAgeWVhcjogJ251bWVyaWMnLCBtb250aDogJzItZGlnaXQnLCBkYXk6ICcyLWRpZ2l0JyxcbiAgICAgICAgaG91cjogJzItZGlnaXQnLCBtaW51dGU6ICcyLWRpZ2l0Jywgc2Vjb25kOiAnMi1kaWdpdCcsXG4gICAgICAgIGhvdXIxMjogZmFsc2UsXG4gICAgfSkuZm9ybWF0VG9QYXJ0cyhkYXRlKTtcbiAgICBjb25zdCBnZXQgPSAodHlwZTogc3RyaW5nKTogc3RyaW5nID0+IHBhcnRzLmZpbmQoKHBhcnQpID0+IHBhcnQudHlwZSA9PT0gdHlwZSk/LnZhbHVlID8/ICcwMCc7XG4gICAgLy8gSW50bCByZW5kZXJzIG1pZG5pZ2h0IGFzIDI0IGluIHNvbWUgbG9jYWxlcy9lbmdpbmVzLlxuICAgIGNvbnN0IGhvdXIgPSBnZXQoJ2hvdXInKSA9PT0gJzI0JyA/ICcwMCcgOiBnZXQoJ2hvdXInKTtcbiAgICByZXR1cm4gYCR7Z2V0KCd5ZWFyJyl9LSR7Z2V0KCdtb250aCcpfS0ke2dldCgnZGF5Jyl9VCR7aG91cn06JHtnZXQoJ21pbnV0ZScpfToke2dldCgnc2Vjb25kJyl9YDtcbn1cblxuLyoqXG4gKiBIYXMgdGhpcyBkYXkncyBzbG90IGFscmVhZHkgYmVndW4/XG4gKlxuICogQ29tZWVuIHJlZnVzZXMgYSBib29raW5nIHdob3NlIHN0YXJ0IHRpbWUgaXMgaW4gdGhlIHBhc3QgXHUyMDE0IHdpdGggYSA1MDAgcmF0aGVyXG4gKiB0aGFuIGFueXRoaW5nIGhlbHBmdWwsIGFuZCBpdCByZWZ1c2VzIGl0cyBvd24gd2ViIFVJIGp1c3QgdGhlIHNhbWUsIHNvIHRoaXNcbiAqIGlzIGl0cyBiZWhhdmlvdXIgYW5kIG5vdCBzb21ldGhpbmcgd2UgYXJlIGRvaW5nIHdyb25nLiBGb3IgYW4gYWxsLWRheSBzbG90XG4gKiB0aGUgc3RhcnQgaXMgbWlkbmlnaHQsIHNvIHRvZGF5IGlzIHVuYm9va2FibGUgZnJvbSBvbmUgc2Vjb25kIHBhc3QgbWlkbmlnaHRcbiAqIG9ud2FyZHMuIEZvciBhbiBhZnRlcm5vb24gc2xvdCwgdG9kYXkgc3RheXMgYm9va2FibGUgdW50aWwgbm9vbi5cbiAqXG4gKiBCb3RoIHNpZGVzIGFyZSBuYWl2ZSBsb2NhbCB3YWxsLWNsb2NrLCB3aGljaCBpcyB0aGUgd2hvbGUgY29udmVudGlvbiBDb21lZW5cbiAqIHVzZXMsIHNvIGEgc3RyaW5nIGNvbXBhcmlzb24gaXMgZXhhY3RseSByaWdodCBoZXJlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzU2xvdFN0YXJ0ZWQoXG4gICAgZGF0ZTogc3RyaW5nLFxuICAgIHN0YXJ0VGltZTogc3RyaW5nLFxuICAgIHRpbWVab25lOiBzdHJpbmcsXG4gICAgbm93ID0gbmV3IERhdGUoKSxcbik6IGJvb2xlYW4ge1xuICAgIGNvbnN0IHN0YXJ0ID0gYCR7ZGF0ZX1UJHtzdGFydFRpbWUucmVwbGFjZSgvXFwuXFxkK1o/JC8sICcnKS5yZXBsYWNlKC9aJC8sICcnKX1gO1xuICAgIHJldHVybiB0b0xvY2FsSVNPRGF0ZVRpbWUobm93LCB0aW1lWm9uZSkgPj0gc3RhcnQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGF0ZXNUb0Jvb2tPcHRpb25zIHtcbiAgICB3ZWVrZGF5czogc3RyaW5nW107XG4gICAgaG9yaXpvbkRheXM/OiBudW1iZXI7XG4gICAgc2tpcERhdGVzPzogc3RyaW5nW107XG4gICAgdGltZVpvbmU/OiBzdHJpbmc7XG4gICAgbm93PzogRGF0ZTtcbn1cblxuLyoqXG4gKiBFdmVyeSBkYXkgZnJvbSB0b2RheSAoaW5jbHVzaXZlKSB1cCB0byBgaG9yaXpvbkRheXNgIGFoZWFkIHdob3NlIHdlZWtkYXkgaXNcbiAqIGluIGB3ZWVrZGF5c2AsIG1pbnVzIGBza2lwRGF0ZXNgLlxuICpcbiAqIFRoZSAxNC1kYXkgZGVmYXVsdCBpcyB3aGF0IG1ha2VzIHVucmVsaWFibGUgc2NoZWR1bGluZyBhY2NlcHRhYmxlOiBlYWNoIHJ1blxuICogdG9wcyB0aGUgd2hvbGUgd2luZG93IGJhY2sgdXAsIHNvIG1pc3NpbmcgYSBkYXkgKGxhcHRvcCBzaHV0LCBDaHJvbWUgY2xvc2VkKVxuICogY29zdHMgbm90aGluZyBhcyBsb25nIGFzIHRoZSBleHRlbnNpb24gcnVucyBhZ2FpbiBiZWZvcmUgdGhlIHdpbmRvdyBkcmFpbnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYXRlc1RvQm9vayh7XG4gICAgd2Vla2RheXMsXG4gICAgaG9yaXpvbkRheXMgPSAxNCxcbiAgICBza2lwRGF0ZXMgPSBbXSxcbiAgICB0aW1lWm9uZSA9ICdFdXJvcGUvUHJhZ3VlJyxcbiAgICBub3cgPSBuZXcgRGF0ZSgpLFxufTogRGF0ZXNUb0Jvb2tPcHRpb25zKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IHdhbnRlZCA9IG5ldyBTZXQ8V2Vla2RheT4oKTtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiB3ZWVrZGF5cykge1xuICAgICAgICBjb25zdCBuYW1lID0gcmF3LnRvTG93ZXJDYXNlKCk7XG4gICAgICAgIGlmICghaXNXZWVrZGF5KG5hbWUpKSB0aHJvdyBuZXcgRXJyb3IoYE5vdCBhIHdlZWtkYXkgbmFtZTogXCIke3Jhd31cImApO1xuICAgICAgICB3YW50ZWQuYWRkKG5hbWUpO1xuICAgIH1cblxuICAgIGNvbnN0IHNraXAgPSBuZXcgU2V0KHNraXBEYXRlcyk7XG4gICAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgZm9yIChsZXQgb2Zmc2V0ID0gMDsgb2Zmc2V0IDw9IGhvcml6b25EYXlzOyBvZmZzZXQgKz0gMSkge1xuICAgICAgICBjb25zdCBkYXkgPSBuZXcgRGF0ZShub3cuZ2V0VGltZSgpICsgb2Zmc2V0ICogODZfNDAwXzAwMCk7XG4gICAgICAgIGNvbnN0IGlzbyA9IHRvTG9jYWxJU09EYXRlKGRheSwgdGltZVpvbmUpO1xuICAgICAgICBpZiAoIXdhbnRlZC5oYXMobG9jYWxXZWVrZGF5KGRheSwgdGltZVpvbmUpKSkgY29udGludWU7XG4gICAgICAgIGlmIChza2lwLmhhcyhpc28pKSBjb250aW51ZTtcbiAgICAgICAgb3V0LnB1c2goaXNvKTtcbiAgICB9XG5cbiAgICByZXR1cm4gb3V0O1xufVxuIiwgImltcG9ydCB7XG4gICAgQlVJTERJTkcsXG4gICAgREVGQVVMVF9TRVRUSU5HUyxcbiAgICBGTE9PUlMsXG4gICAgaXNWYWxpZERlc2tOYW1lLFxuICAgIGxvYWRTZXR0aW5ncyxcbiAgICBtZXJnZVNldHRpbmdzLFxuICAgIHBydW5lUGFzdFNraXBEYXRlcyxcbiAgICBzYXZlU2V0dGluZ3MsXG4gICAgdHlwZSBFbmRwb2ludENvbmZpZyxcbiAgICB0eXBlIFNldHRpbmdzLFxuICAgIHR5cGUgU2xvdCxcbn0gZnJvbSAnLi9jb3JlL2NvbmZpZy5qcyc7XG5pbXBvcnQgeyBkYXRlc1RvQm9vaywgbG9jYWxXZWVrZGF5LCB0b0xvY2FsSVNPRGF0ZSwgdHlwZSBXZWVrZGF5IH0gZnJvbSAnLi9jb3JlL2RhdGVzLmpzJztcbmltcG9ydCB0eXBlIHsgUnVuTG9nIH0gZnJvbSAnLi9iYWNrZ3JvdW5kLmpzJztcblxuY29uc3QgREFZUzogV2Vla2RheVtdID0gWydtb25kYXknLCAndHVlc2RheScsICd3ZWRuZXNkYXknLCAndGh1cnNkYXknLCAnZnJpZGF5JywgJ3NhdHVyZGF5JywgJ3N1bmRheSddO1xuXG4vKiogTW9uZGF5LWZpcnN0LCB0byBtYXRjaCBob3cgYSB3b3JraW5nIHdlZWsgaXMgcmVhZC4gKi9cbmNvbnN0IERPV19MQUJFTFMgPSBbJ01vJywgJ1R1JywgJ1dlJywgJ1RoJywgJ0ZyJywgJ1NhJywgJ1N1J107XG5cbmZ1bmN0aW9uIGVsPFQgZXh0ZW5kcyBIVE1MRWxlbWVudD4oaWQ6IHN0cmluZyk6IFQge1xuICAgIGNvbnN0IG5vZGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7XG4gICAgaWYgKCFub2RlKSB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgZWxlbWVudCAjJHtpZH1gKTtcbiAgICByZXR1cm4gbm9kZSBhcyBUO1xufVxuXG5jb25zdCBmaWVsZHMgPSB7XG4gICAgZW5hYmxlZDogZWw8SFRNTElucHV0RWxlbWVudD4oJ2VuYWJsZWQnKSxcbiAgICBkZXNrTmFtZTogZWw8SFRNTElucHV0RWxlbWVudD4oJ2Rlc2tOYW1lJyksXG4gICAgZGVza0lkOiBlbDxIVE1MSW5wdXRFbGVtZW50PignZGVza0lkJyksXG4gICAgZmxvb3JJZDogZWw8SFRNTFNlbGVjdEVsZW1lbnQ+KCdmbG9vcklkJyksXG4gICAgc2xvdDogZWw8SFRNTFNlbGVjdEVsZW1lbnQ+KCdzbG90JyksXG4gICAgaG9yaXpvbkRheXM6IGVsPEhUTUxJbnB1dEVsZW1lbnQ+KCdob3Jpem9uRGF5cycpLFxuICAgIHRpbWVab25lOiBlbDxIVE1MSW5wdXRFbGVtZW50PigndGltZVpvbmUnKSxcbiAgICBlbmRwb2ludDogZWw8SFRNTFRleHRBcmVhRWxlbWVudD4oJ2VuZHBvaW50JyksXG4gICAgbGVhcm5Nb2RlOiBlbDxIVE1MSW5wdXRFbGVtZW50PignbGVhcm5Nb2RlJyksXG59O1xuXG4vLyBcdTI1MDBcdTI1MDAgc3RhdGljIG9mZmljZSBmYWN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmVsPEhUTUxTcGFuRWxlbWVudD4oJ2J1aWxkaW5nTmFtZScpLnRleHRDb250ZW50ID0gQlVJTERJTkcubmFtZTtcblxuZm9yIChjb25zdCBmbG9vciBvZiBGTE9PUlMpIHtcbiAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICBvcHRpb24udmFsdWUgPSBTdHJpbmcoZmxvb3IuaWQpO1xuICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IGZsb29yLmxhYmVsO1xuICAgIGZpZWxkcy5mbG9vcklkLmFwcGVuZChvcHRpb24pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgd2Vla2RheSBjaGlwcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmNvbnN0IGRheXNIb3N0ID0gZWw8SFRNTERpdkVsZW1lbnQ+KCdkYXlzJyk7XG5mb3IgKGNvbnN0IGRheSBvZiBEQVlTKSB7XG4gICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpO1xuICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XG4gICAgYm94LnR5cGUgPSAnY2hlY2tib3gnO1xuICAgIGJveC52YWx1ZSA9IGRheTtcbiAgICBib3guZGF0YXNldC5kYXkgPSBkYXk7XG4gICAgbGFiZWwuYXBwZW5kKGJveCwgZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoZGF5LnNsaWNlKDAsIDMpKSk7XG4gICAgZGF5c0hvc3QuYXBwZW5kKGxhYmVsKTtcbn1cblxuZnVuY3Rpb24gc2VsZWN0ZWREYXlzKCk6IFdlZWtkYXlbXSB7XG4gICAgcmV0dXJuIFsuLi5kYXlzSG9zdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQ+KCdpbnB1dDpjaGVja2VkJyldXG4gICAgICAgIC5tYXAoKGJveCkgPT4gYm94LnZhbHVlIGFzIFdlZWtkYXkpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgc3RhdGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBTZXR0aW5ncyBhdXRvLXNhdmUsIHNvIHRoaXMgaXMgdGhlIGxpdmUgY29weSByYXRoZXIgdGhhbiBhIHNuYXBzaG90IHRha2VuIGF0XG4vLyBsb2FkLiBza2lwRGF0ZXMgaW4gcGFydGljdWxhciBpcyBtdXRhdGVkIGJ5IGNsaWNraW5nIHRoZSBjYWxlbmRhci5cbmxldCBjdXJyZW50OiBTZXR0aW5ncyA9IGF3YWl0IGxvYWRTZXR0aW5ncygpO1xuXG4vKipcbiAqIFRoZSBtb3N0IHJlY2VudCBydW4sIHNvIHRoZSBjYWxlbmRhciBjYW4gc2hvdyB3aGF0IHdhcyBhY3R1YWxseSBmb3VuZCByYXRoZXJcbiAqIHRoYW4gb25seSB3aGF0IGlzIHBsYW5uZWQuIENvbWVzIGZyb20gc3RvcmFnZSBvbiBvcGVuIGFuZCBpcyByZXBsYWNlZCBhZnRlclxuICogZXZlcnkgcnVuLlxuICovXG5sZXQgbGFzdExvZzogUnVuTG9nIHwgdW5kZWZpbmVkO1xuXG5mdW5jdGlvbiByZW5kZXJTZXR0aW5ncyhuZXh0OiBTZXR0aW5ncyk6IHZvaWQge1xuICAgIGZpZWxkcy5lbmFibGVkLmNoZWNrZWQgPSBuZXh0LmVuYWJsZWQ7XG4gICAgZmllbGRzLmRlc2tOYW1lLnZhbHVlID0gbmV4dC5kZXNrTmFtZTtcbiAgICBmaWVsZHMuZGVza0lkLnZhbHVlID0gbmV4dC5kZXNrSWQ7XG4gICAgZmllbGRzLmZsb29ySWQudmFsdWUgPSBTdHJpbmcobmV4dC5mbG9vcklkKTtcbiAgICBmaWVsZHMuc2xvdC52YWx1ZSA9IG5leHQuc2xvdDtcbiAgICBmaWVsZHMuaG9yaXpvbkRheXMudmFsdWUgPSBTdHJpbmcobmV4dC5ob3Jpem9uRGF5cyk7XG4gICAgZmllbGRzLnRpbWVab25lLnZhbHVlID0gbmV4dC50aW1lWm9uZTtcbiAgICBmaWVsZHMuZW5kcG9pbnQudmFsdWUgPSBKU09OLnN0cmluZ2lmeShuZXh0LmVuZHBvaW50LCBudWxsLCAyKTtcbiAgICBlbDxIVE1MU3BhbkVsZW1lbnQ+KCd0aW1lWm9uZUxhYmVsJykudGV4dENvbnRlbnQgPSBuZXh0LnRpbWVab25lO1xuICAgIGZvciAoY29uc3QgYm94IG9mIGRheXNIb3N0LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oJ2lucHV0JykpIHtcbiAgICAgICAgYm94LmNoZWNrZWQgPSBuZXh0LndlZWtkYXlzLmluY2x1ZGVzKGJveC52YWx1ZSBhcyBXZWVrZGF5KTtcbiAgICB9XG59XG5cbi8qKlxuICogUmVhZCB0aGUgZm9ybSBiYWNrIGludG8gYSBTZXR0aW5ncy5cbiAqXG4gKiBUaGUgZW5kcG9pbnQgdGV4dGFyZWEgaXMgdGhlIG9uZSBmaWVsZCB0aGF0IGNhbiBiZSBtaWQtZWRpdCBhbmQgdW5wYXJzZWFibGUuXG4gKiBBdXRvLXNhdmUgcnVucyBvbiBldmVyeSBrZXlzdHJva2UsIHNvIGEgaGFsZi10eXBlZCBicmFjZSBtdXN0IG5vdCB0aHJvdyBhd2F5XG4gKiB0aGUgd29ya2luZyBjb25maWc6IHRoZSBsYXN0IGdvb2QgdmFsdWUgaXMga2VwdCBhbmQgdGhlIGNhbGxlciBpcyB0b2xkLlxuICovXG5mdW5jdGlvbiBjb2xsZWN0KCk6IHsgc2V0dGluZ3M6IFNldHRpbmdzOyBlbmRwb2ludEVycm9yPzogc3RyaW5nIH0ge1xuICAgIGxldCBlbmRwb2ludDogRW5kcG9pbnRDb25maWcgPSBjdXJyZW50LmVuZHBvaW50O1xuICAgIGxldCBlbmRwb2ludEVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgICAgZW5kcG9pbnQgPSBKU09OLnBhcnNlKGZpZWxkcy5lbmRwb2ludC52YWx1ZSkgYXMgRW5kcG9pbnRDb25maWc7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGVuZHBvaW50RXJyb3IgPSBgRW5kcG9pbnQgY29uZmlnIGlzIG5vdCB2YWxpZCBKU09OOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YDtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBzZXR0aW5nczoge1xuICAgICAgICAgICAgLy8gU2F2aW5nIHN0YW1wcyB0aGUgdmVyc2lvbiB0aGUgdXNlciBoYXMgYWN0dWFsbHkgc2Vlbiwgc28gYSBsYXRlclxuICAgICAgICAgICAgLy8gYnVpbGQgd2l0aCBhIGNvcnJlY3RlZCBjb250cmFjdCBzdGlsbCBzdXBlcnNlZGVzIHRoaXMuXG4gICAgICAgICAgICBlbmRwb2ludFZlcnNpb246IGN1cnJlbnQuZW5kcG9pbnRWZXJzaW9uLFxuICAgICAgICAgICAgZW5hYmxlZDogZmllbGRzLmVuYWJsZWQuY2hlY2tlZCxcbiAgICAgICAgICAgICAgICBkZXNrTmFtZTogZmllbGRzLmRlc2tOYW1lLnZhbHVlLnRyaW0oKSxcbiAgICAgICAgICAgIGRlc2tJZDogZmllbGRzLmRlc2tJZC52YWx1ZS50cmltKCksXG4gICAgICAgICAgICBmbG9vcklkOiBOdW1iZXIoZmllbGRzLmZsb29ySWQudmFsdWUpIHx8IERFRkFVTFRfU0VUVElOR1MuZmxvb3JJZCxcbiAgICAgICAgICAgIC8vIEZpeGVkOiB0aGVyZSBpcyBvbmUgYnVpbGRpbmcsIGFuZCBpdCBpcyBzaG93biBhcyB0ZXh0LCBub3QgZWRpdGVkLlxuICAgICAgICAgICAgYnVpbGRpbmdJZDogQlVJTERJTkcuaWQsXG4gICAgICAgICAgICB3ZWVrZGF5czogc2VsZWN0ZWREYXlzKCksXG4gICAgICAgICAgICBzbG90OiBmaWVsZHMuc2xvdC52YWx1ZSBhcyBTbG90LFxuICAgICAgICAgICAgaG9yaXpvbkRheXM6IE51bWJlcihmaWVsZHMuaG9yaXpvbkRheXMudmFsdWUpIHx8IERFRkFVTFRfU0VUVElOR1MuaG9yaXpvbkRheXMsXG4gICAgICAgICAgICAvLyBPd25lZCBieSB0aGUgY2FsZW5kYXIsIG5vdCBieSBhbnkgZm9ybSBmaWVsZC4gUHJ1bmVkIG9uIGV2ZXJ5XG4gICAgICAgICAgICAvLyBzYXZlIHNvIG1vbnRocyBvZiBwYXN0IGVudHJpZXMgZG8gbm90IHBpbGUgdXAuXG4gICAgICAgICAgICBjYW5jZWxEYXRlczogcHJ1bmVQYXN0U2tpcERhdGVzKFxuICAgICAgICAgICAgICAgIGN1cnJlbnQuY2FuY2VsRGF0ZXMsXG4gICAgICAgICAgICAgICAgdG9Mb2NhbElTT0RhdGUobmV3IERhdGUoKSwgZmllbGRzLnRpbWVab25lLnZhbHVlLnRyaW0oKSB8fCBERUZBVUxUX1NFVFRJTkdTLnRpbWVab25lKSxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICBza2lwRGF0ZXM6IHBydW5lUGFzdFNraXBEYXRlcyhcbiAgICAgICAgICAgICAgICBjdXJyZW50LnNraXBEYXRlcyxcbiAgICAgICAgICAgICAgICB0b0xvY2FsSVNPRGF0ZShuZXcgRGF0ZSgpLCBmaWVsZHMudGltZVpvbmUudmFsdWUudHJpbSgpIHx8IERFRkFVTFRfU0VUVElOR1MudGltZVpvbmUpLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIHRpbWVab25lOiBmaWVsZHMudGltZVpvbmUudmFsdWUudHJpbSgpIHx8IERFRkFVTFRfU0VUVElOR1MudGltZVpvbmUsXG4gICAgICAgICAgICBlbmRwb2ludCxcbiAgICAgICAgfSxcbiAgICAgICAgZW5kcG9pbnRFcnJvcixcbiAgICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgdGhlIGJvb2tpbmcgcGxhbiBjYWxlbmRhciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgcGFkID0gKHZhbHVlOiBudW1iZXIpOiBzdHJpbmcgPT4gU3RyaW5nKHZhbHVlKS5wYWRTdGFydCgyLCAnMCcpO1xuY29uc3QgaXNvRm9yID0gKHllYXI6IG51bWJlciwgbW9udGg6IG51bWJlciwgZGF5OiBudW1iZXIpOiBzdHJpbmcgPT5cbiAgICBgJHt5ZWFyfS0ke3BhZChtb250aCArIDEpfS0ke3BhZChkYXkpfWA7XG5cbi8qKlxuICogVHdvIG1vbnRocyBvZiBkYXlzLCB3aXRoIHRoZSBvbmVzIHRoYXQgd2lsbCBhY3R1YWxseSBiZSBib29rZWQgaGlnaGxpZ2h0ZWQuXG4gKlxuICogVGhpcyBpcyB0aGUgYW5zd2VyIHRvIFwid2hhdCBpcyB0aGlzIGdvaW5nIHRvIGRvXCIsIHdoaWNoIGlzIHdoeSBpdCBkcmF3cyB0aGVcbiAqIHdob2xlIGhvcml6b24gcmF0aGVyIHRoYW4gb25seSB0aGUgZXhjZXB0aW9ucyB0byBpdC4gQ2xpY2tpbmcgYSBwbGFubmVkIGRheVxuICogbW92ZXMgaXQgaW4gYW5kIG91dCBvZiBza2lwRGF0ZXMuXG4gKi9cbmZ1bmN0aW9uIHJlbmRlclBsYW4oKTogdm9pZCB7XG4gICAgY29uc3QgaG9zdCA9IGVsPEhUTUxEaXZFbGVtZW50PignY2FsZW5kYXInKTtcbiAgICBob3N0LnRleHRDb250ZW50ID0gJyc7XG5cbiAgICBjb25zdCB0b2RheSA9IHRvTG9jYWxJU09EYXRlKG5ldyBEYXRlKCksIGN1cnJlbnQudGltZVpvbmUpO1xuICAgIGNvbnN0IFt0b2RheVllYXIsIHRvZGF5TW9udGhdID0gdG9kYXkuc3BsaXQoJy0nKS5tYXAoTnVtYmVyKSBhcyBbbnVtYmVyLCBudW1iZXIsIG51bWJlcl07XG5cbiAgICAvLyBDYW5kaWRhdGVzIGlnbm9yaW5nIHNraXBEYXRlcywgc28gYSBza2lwcGVkIGRheSBpcyBzdGlsbCBkcmF3biBhcyBvbmUgb2ZcbiAgICAvLyB0aGUgcGxhbm5lZCBkYXlzIHJhdGhlciB0aGFuIHZhbmlzaGluZyBpbnRvIHRoZSBiYWNrZ3JvdW5kLlxuICAgIGxldCBjYW5kaWRhdGVzOiBTZXQ8c3RyaW5nPjtcbiAgICB0cnkge1xuICAgICAgICBjYW5kaWRhdGVzID0gbmV3IFNldChkYXRlc1RvQm9vayh7XG4gICAgICAgICAgICB3ZWVrZGF5czogY3VycmVudC53ZWVrZGF5cyxcbiAgICAgICAgICAgIGhvcml6b25EYXlzOiBjdXJyZW50Lmhvcml6b25EYXlzLFxuICAgICAgICAgICAgc2tpcERhdGVzOiBbXSxcbiAgICAgICAgICAgIHRpbWVab25lOiBjdXJyZW50LnRpbWVab25lLFxuICAgICAgICB9KSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIGNhbmRpZGF0ZXMgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgLy8gV2hldGhlciBhIGRhdGUgaXMgYSB3ZWVrZGF5IHlvdSBjb21lIGluLCBpZ25vcmluZyB0aGUgaG9yaXpvbiBlbnRpcmVseS5cbiAgICAvLyBLbm93aW5nIGluIFNlcHRlbWJlciB0aGF0IHlvdSBhcmUgYXdheSBpbiBPY3RvYmVyIGlzIG5vcm1hbDsgdGhlIGhvcml6b25cbiAgICAvLyBnb3Zlcm5zIHdoYXQgZ2V0cyBib29rZWQsIGFuZCBoYXMgbm8gYnVzaW5lc3MgZ292ZXJuaW5nIHdoYXQgeW91IGFyZVxuICAgIC8vIGFsbG93ZWQgdG8gdGVsbCBpdCBpbiBhZHZhbmNlLlxuICAgIGNvbnN0IGNob3NlbldlZWtkYXlzID0gbmV3IFNldChjdXJyZW50LndlZWtkYXlzKTtcbiAgICBjb25zdCBpc1dvcmtkYXkgPSAoaXNvOiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIE1pZGRheSBhdm9pZHMgYW55IGNoYW5jZSBvZiB0aGUgcGFyc2VkIGluc3RhbnQgbGFuZGluZyBvbiB0aGVcbiAgICAgICAgICAgIC8vIHByZXZpb3VzIGRheSBvbmNlIHNoaWZ0ZWQgaW50byB0aGUgdGFyZ2V0IHpvbmUuXG4gICAgICAgICAgICByZXR1cm4gY2hvc2VuV2Vla2RheXMuaGFzKGxvY2FsV2Vla2RheShuZXcgRGF0ZShgJHtpc299VDEyOjAwOjAwWmApLCBjdXJyZW50LnRpbWVab25lKSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgfTtcbiAgICBjb25zdCBza2lwcGVkID0gbmV3IFNldChjdXJyZW50LnNraXBEYXRlcyk7XG4gICAgY29uc3QgbWFya2VkRm9yQ2FuY2VsID0gbmV3IFNldChjdXJyZW50LmNhbmNlbERhdGVzKTtcblxuICAgIC8vIFdoYXQgdGhlIGxhc3QgcnVuIGZvdW5kLCBieSBkYXRlLiBgYm9va2VkYCBhbmQgYHNraXBwZWRgIGJvdGggbWVhbiBcInlvdVxuICAgIC8vIGhvbGQgdGhhdCBkYXlcIiBcdTIwMTQgb25lIGp1c3QgaGFwcGVuZWQgbm93IGFuZCB0aGUgb3RoZXIgZWFybGllci5cbiAgICBjb25zdCBvdXRjb21lID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IHJvdyBvZiBsYXN0TG9nPy5yb3dzID8/IFtdKSB7XG4gICAgICAgIGlmIChyb3cuc3RhdHVzID09PSAnYm9va2VkJyB8fCByb3cuc3RhdHVzID09PSAnc2tpcHBlZCcpIG91dGNvbWUuc2V0KHJvdy5kYXRlLCAnaGF2ZScpO1xuICAgICAgICBlbHNlIGlmIChyb3cuc3RhdHVzID09PSAndW5hdmFpbGFibGUnKSBvdXRjb21lLnNldChyb3cuZGF0ZSwgJ3Rha2VuJyk7XG4gICAgICAgIGVsc2UgaWYgKHJvdy5zdGF0dXMgPT09ICdlcnJvcicpIG91dGNvbWUuc2V0KHJvdy5kYXRlLCAnZmFpbGVkJyk7XG4gICAgfVxuXG4gICAgLy8gQSBydW4gZnJvbSBkYXlzIGFnbyBjYW4gc3RpbGwgYmUgc2hvd2luZyBncmVlbiBmb3IgZGF5cyB0aGF0IGhhdmUgc2luY2VcbiAgICAvLyBiZWVuIGdpdmVuIGF3YXksIHNvIHRoZSBwbGFuIHNheXMgaG93IG9sZCBpdCBpcyByYXRoZXIgdGhhbiBpbXBseWluZyBpdFxuICAgIC8vIGlzIGxpdmUuXG4gICAgY29uc3QgYXNPZiA9IGVsPEhUTUxTcGFuRWxlbWVudD4oJ3BsYW5Bc09mJyk7XG4gICAgYXNPZi50ZXh0Q29udGVudCA9IGxhc3RMb2dcbiAgICAgICAgPyBgY29sb3VycyBmcm9tICR7bmV3IERhdGUobGFzdExvZy5hdCkudG9Mb2NhbGVTdHJpbmcoKX0gXHUwMEI3IGNsaWNrIGEgZGF5IHRvIHNraXAgaXRgXG4gICAgICAgIDogJ2NsaWNrIGEgZGF5IHRvIHNraXAgaXQnO1xuXG4gICAgZm9yIChsZXQgb2Zmc2V0ID0gMDsgb2Zmc2V0IDwgMjsgb2Zmc2V0ICs9IDEpIHtcbiAgICAgICAgY29uc3QgbW9udGggPSB0b2RheU1vbnRoIC0gMSArIG9mZnNldDtcbiAgICAgICAgY29uc3QgeWVhciA9IHRvZGF5WWVhciArIE1hdGguZmxvb3IobW9udGggLyAxMik7XG4gICAgICAgIGNvbnN0IG5vcm1hbGlzZWQgPSAoKG1vbnRoICUgMTIpICsgMTIpICUgMTI7XG5cbiAgICAgICAgY29uc3QgYmxvY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgYmxvY2suY2xhc3NOYW1lID0gJ21vbnRoJztcblxuICAgICAgICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIG5hbWUuY2xhc3NOYW1lID0gJ21vbnRoLW5hbWUnO1xuICAgICAgICBuYW1lLnRleHRDb250ZW50ID0gbmV3IERhdGUoRGF0ZS5VVEMoeWVhciwgbm9ybWFsaXNlZCwgMSkpXG4gICAgICAgICAgICAudG9Mb2NhbGVEYXRlU3RyaW5nKHVuZGVmaW5lZCwgeyBtb250aDogJ2xvbmcnLCB5ZWFyOiAnbnVtZXJpYycsIHRpbWVab25lOiAnVVRDJyB9KTtcbiAgICAgICAgYmxvY2suYXBwZW5kKG5hbWUpO1xuXG4gICAgICAgIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgZ3JpZC5jbGFzc05hbWUgPSAnZ3JpZCc7XG4gICAgICAgIGZvciAoY29uc3QgbGFiZWwgb2YgRE9XX0xBQkVMUykge1xuICAgICAgICAgICAgY29uc3QgaGVhZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICAgICAgaGVhZC5jbGFzc05hbWUgPSAnZG93JztcbiAgICAgICAgICAgIGhlYWQudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgICAgICAgIGdyaWQuYXBwZW5kKGhlYWQpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZmlyc3REYXlPZldlZWsgPSBuZXcgRGF0ZShEYXRlLlVUQyh5ZWFyLCBub3JtYWxpc2VkLCAxKSkuZ2V0VVRDRGF5KCk7XG4gICAgICAgIC8vIGdldFVUQ0RheSBpcyBTdW5kYXktZmlyc3Q7IHRoZSBncmlkIGlzIE1vbmRheS1maXJzdC5cbiAgICAgICAgY29uc3QgbGVhZCA9IChmaXJzdERheU9mV2VlayArIDYpICUgNztcbiAgICAgICAgZm9yIChsZXQgYmxhbmsgPSAwOyBibGFuayA8IGxlYWQ7IGJsYW5rICs9IDEpIGdyaWQuYXBwZW5kKGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpKTtcblxuICAgICAgICBjb25zdCBkYXlzSW5Nb250aCA9IG5ldyBEYXRlKERhdGUuVVRDKHllYXIsIG5vcm1hbGlzZWQgKyAxLCAwKSkuZ2V0VVRDRGF0ZSgpO1xuICAgICAgICBmb3IgKGxldCBkYXkgPSAxOyBkYXkgPD0gZGF5c0luTW9udGg7IGRheSArPSAxKSB7XG4gICAgICAgICAgICBjb25zdCBpc28gPSBpc29Gb3IoeWVhciwgbm9ybWFsaXNlZCwgZGF5KTtcbiAgICAgICAgICAgIGNvbnN0IGNlbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgICAgIGNlbGwuY2xhc3NOYW1lID0gJ2RheSc7XG4gICAgICAgICAgICBjZWxsLnRleHRDb250ZW50ID0gU3RyaW5nKGRheSk7XG4gICAgICAgICAgICBjZWxsLnR5cGUgPSAnYnV0dG9uJztcblxuICAgICAgICAgICAgaWYgKGlzbyA8IHRvZGF5KSBjZWxsLmNsYXNzTGlzdC5hZGQoJ3Bhc3QnKTtcbiAgICAgICAgICAgIGlmIChpc28gPT09IHRvZGF5KSBjZWxsLmNsYXNzTGlzdC5hZGQoJ3RvZGF5Jyk7XG5cbiAgICAgICAgICAgIGNvbnN0IHBsYW5uZWQgPSBjYW5kaWRhdGVzLmhhcyhpc28pO1xuICAgICAgICAgICAgY29uc3QgbWFya2FibGUgPSBwbGFubmVkIHx8IChpc28gPj0gdG9kYXkgJiYgaXNXb3JrZGF5KGlzbykpO1xuXG4gICAgICAgICAgICBpZiAobWFya2FibGUpIHtcbiAgICAgICAgICAgICAgICAvLyBUaGUgdXNlcidzIG93biBjaG9pY2UgdG8gc2tpcCBvdXRyYW5rcyBhbnl0aGluZyBhIHJ1biBmb3VuZDpcbiAgICAgICAgICAgICAgICAvLyBpdCBpcyBhbiBpbnN0cnVjdGlvbiwgbm90IGFuIG9ic2VydmF0aW9uLlxuICAgICAgICAgICAgICAgIC8vIENhbmNlbGxhdGlvbiBpcyB0aGUgc3Ryb25nZXN0IHN0YXRlbWVudCBhYm91dCBhIGRheSwgc28gaXRcbiAgICAgICAgICAgICAgICAvLyB3aW5zIHRoZSBkaXNwbGF5OiBpdCBpcyBib3RoIGFuIGluc3RydWN0aW9uIGFuZCBkZXN0cnVjdGl2ZSxcbiAgICAgICAgICAgICAgICAvLyBhbmQgbXVzdCBub3QgYmUgaGlkZGVuIGJlaGluZCBhIFwic2tpcHBlZFwiIHN0eWxlLlxuICAgICAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gbWFya2VkRm9yQ2FuY2VsLmhhcyhpc28pXG4gICAgICAgICAgICAgICAgICAgID8gJ2NhbmNlbCdcbiAgICAgICAgICAgICAgICAgICAgOiBza2lwcGVkLmhhcyhpc28pXG4gICAgICAgICAgICAgICAgICAgICAgICA/ICdza2lwJ1xuICAgICAgICAgICAgICAgICAgICAgICAgOiBvdXRjb21lLmdldChpc28pID8/IChwbGFubmVkID8gJ2Jvb2snIDogJ2xhdGVyJyk7XG4gICAgICAgICAgICAgICAgY2VsbC5jbGFzc0xpc3QuYWRkKHN0YXRlLCAnY2xpY2thYmxlJyk7XG4gICAgICAgICAgICAgICAgY2VsbC50aXRsZSA9IHtcbiAgICAgICAgICAgICAgICAgICAgc2tpcDogJ1NraXBwZWQgXHUyMDE0IGNsaWNrIHRvIGJvb2sgaXQnLFxuICAgICAgICAgICAgICAgICAgICBoYXZlOiAnWW91IGFscmVhZHkgaGF2ZSB0aGlzIGRheS4gQ2xpY2tpbmcgc3RvcHMgZnV0dXJlIHJ1bnMgcmUtYm9va2luZyBpdDsgJ1xuICAgICAgICAgICAgICAgICAgICAgICAgKyAnaXQgZG9lcyBub3QgY2FuY2VsIHRoZSBib29raW5nIGluIENvbWVlbi4nLFxuICAgICAgICAgICAgICAgICAgICB0YWtlbjogJ1NvbWVvbmUgZWxzZSBoYXMgdGhpcyBkZXNrIHRoYXQgZGF5LiBDbGlja2luZyBzdG9wcyBpdCBiZWluZyByZXRyaWVkLicsXG4gICAgICAgICAgICAgICAgICAgIGZhaWxlZDogJ1RoZSBsYXN0IGF0dGVtcHQgZmFpbGVkIG9uIHRoaXMgZGF5LiBPcGVuIExhc3QgcnVuIGZvciB0aGUgcmVhc29uLicsXG4gICAgICAgICAgICAgICAgICAgIGJvb2s6ICdDbGljayB0byBza2lwJyxcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXI6ICdCZXlvbmQgdGhlIGJvb2tpbmcgd2luZG93IGZvciBub3cuIENsaWNrIHRvIHNraXAgaXQgaW4gYWR2YW5jZSBcdTIwMTQgaXQgJ1xuICAgICAgICAgICAgICAgICAgICAgICAgKyAnd2lsbCBiZSByZW1lbWJlcmVkIHdoZW4gdGhlIHdpbmRvdyByZWFjaGVzIGl0LicsXG4gICAgICAgICAgICAgICAgICAgIGNhbmNlbDogJ1dpbGwgYmUgY2FuY2VsbGVkIGluIENvbWVlbiBvbiB0aGUgbmV4dCBydW4uIENsaWNrIHRvIGtlZXAgaXQuJyxcbiAgICAgICAgICAgICAgICB9W3N0YXRlXSA/PyAnQ2xpY2sgdG8gc2tpcCc7XG4gICAgICAgICAgICAgICAgY2VsbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN0YXRlID09PSAnY2FuY2VsJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gVW5kbzogc3RvcCBjYW5jZWxsaW5nLCBhbmQgc3RvcCBza2lwcGluZywgc2luY2UgdGhlXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBza2lwIHdhcyBvbmx5IGV2ZXIgdGhlcmUgdG8gcHJvdGVjdCB0aGUgY2FuY2VsbGF0aW9uLlxuICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudC5jYW5jZWxEYXRlcyA9IGN1cnJlbnQuY2FuY2VsRGF0ZXMuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkgIT09IGlzbyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50LnNraXBEYXRlcyA9IGN1cnJlbnQuc2tpcERhdGVzLmZpbHRlcigoZW50cnkpID0+IGVudHJ5ICE9PSBpc28pO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHN0YXRlID09PSAnaGF2ZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFlvdSBob2xkIHRoaXMgZGF5LCBzbyB0aGUgdXNlZnVsIGFjdGlvbiBpcyB0byBnaXZlIGl0XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyB1cCByYXRoZXIgdGhhbiBtZXJlbHkgdG8gc3RvcCByZS1ib29raW5nIGl0LiBTa2lwcGluZ1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gYXMgd2VsbCBpcyBub3Qgb3B0aW9uYWw6IHdpdGhvdXQgaXQsIHRoZSB2ZXJ5IG5leHQgcnVuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyB3b3VsZCBib29rIHN0cmFpZ2h0IGJhY2sgd2hhdCB0aGlzIG9uZSBjYW5jZWxsZWQuXG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50LmNhbmNlbERhdGVzID0gWy4uLmN1cnJlbnQuY2FuY2VsRGF0ZXMsIGlzb10uc29ydCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudC5za2lwRGF0ZXMgPSBbLi4ubmV3IFNldChbLi4uY3VycmVudC5za2lwRGF0ZXMsIGlzb10pXS5zb3J0KCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJyZW50LnNraXBEYXRlcyA9IHNraXBwZWQuaGFzKGlzbylcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IGN1cnJlbnQuc2tpcERhdGVzLmZpbHRlcigoZW50cnkpID0+IGVudHJ5ICE9PSBpc28pXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBbLi4uY3VycmVudC5za2lwRGF0ZXMsIGlzb10uc29ydCgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJlbmRlclBsYW4oKTtcbiAgICAgICAgICAgICAgICAgICAgcXVldWVTYXZlKCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGdyaWQuYXBwZW5kKGNlbGwpO1xuICAgICAgICB9XG5cbiAgICAgICAgYmxvY2suYXBwZW5kKGdyaWQpO1xuICAgICAgICBob3N0LmFwcGVuZChibG9jayk7XG4gICAgfVxufVxuXG4vKipcbiAqIFNob3cgd2hldGhlciB0aGUgZGVzayBuYW1lIGlzIHVzYWJsZSwgYW5kIHN0b3AgdGhlIGJ1dHRvbnMgaWYgaXQgaXMgbm90LlxuICpcbiAqIFRocmVlIHN0YXRlcyByYXRoZXIgdGhhbiB0d286IGVtcHR5IGlzIG5vdCBhbiBlcnJvciwgaXQgaXMgdGhlIHN0YXJ0aW5nXG4gKiBwb2ludCwgc28gaXQgZ2V0cyBhIHBsYWluIGhpbnQuIE9ubHkgc29tZXRoaW5nIHR5cGVkIGFuZCB3cm9uZyB0dXJucyByZWQuXG4gKiBTY29sZGluZyBzb21lb25lIGZvciBub3QgaGF2aW5nIGZpbGxlZCBhIGZpZWxkIGluIHlldCBpcyBob3cgYSBzZXR1cCBzY3JlZW5cbiAqIG1ha2VzIHBlb3BsZSBmZWVsIHN0dXBpZC5cbiAqL1xuZnVuY3Rpb24gcmVuZGVyRGVza1N0YXRlKCk6IHZvaWQge1xuICAgIGNvbnN0IHJhdyA9IGZpZWxkcy5kZXNrTmFtZS52YWx1ZS50cmltKCk7XG4gICAgY29uc3Qgbm90ZSA9IGVsPEhUTUxQYXJhZ3JhcGhFbGVtZW50PignZGVza05vdGUnKTtcbiAgICBjb25zdCB2YWxpZCA9IGlzVmFsaWREZXNrTmFtZShyYXcpO1xuXG4gICAgaWYgKHJhdyA9PT0gJycpIHtcbiAgICAgICAgbm90ZS50ZXh0Q29udGVudCA9ICdQaWNrIHlvdXIgZGVzayBmaXJzdCBcdTIwMTQgdGhlIG51bWJlciBwcmludGVkIG9uIGl0LCBsaWtlIDMtMjMuJztcbiAgICAgICAgbm90ZS5jbGFzc0xpc3QucmVtb3ZlKCdiYWQnKTtcbiAgICAgICAgZmllbGRzLmRlc2tOYW1lLmNsYXNzTGlzdC5yZW1vdmUoJ2JhZCcpO1xuICAgIH0gZWxzZSBpZiAodmFsaWQpIHtcbiAgICAgICAgbm90ZS50ZXh0Q29udGVudCA9ICdMb29rZWQgdXAgYnkgbmFtZSBvbiBldmVyeSBydW4sIHNvIHRoZSBJRCBzdGF5cyBlbXB0eS4nO1xuICAgICAgICBub3RlLmNsYXNzTGlzdC5yZW1vdmUoJ2JhZCcpO1xuICAgICAgICBmaWVsZHMuZGVza05hbWUuY2xhc3NMaXN0LnJlbW92ZSgnYmFkJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbm90ZS50ZXh0Q29udGVudCA9IGBcIiR7cmF3fVwiIGlzIG5vdCBhIGRlc2sgbnVtYmVyLiBJdCBzaG91bGQgYmUgZGlnaXRzLCBhIGRhc2gsIGRpZ2l0cyBcdTIwMTQgbGlrZSAzLTIzLmA7XG4gICAgICAgIG5vdGUuY2xhc3NMaXN0LmFkZCgnYmFkJyk7XG4gICAgICAgIGZpZWxkcy5kZXNrTmFtZS5jbGFzc0xpc3QuYWRkKCdiYWQnKTtcbiAgICB9XG5cbiAgICAvLyBBIGRlc2sgSUQgc2V0IGJ5IGhhbmQgaW4gQWR2YW5jZWQgaXMgYSBkZWxpYmVyYXRlIG92ZXJyaWRlLCBhbmQgc3RhbmRzIGluXG4gICAgLy8gZm9yIHRoZSBuYW1lLlxuICAgIGNvbnN0IHJ1bm5hYmxlID0gdmFsaWQgfHwgZmllbGRzLmRlc2tJZC52YWx1ZS50cmltKCkgIT09ICcnO1xuICAgIGZvciAoY29uc3QgaWQgb2YgWydydW5Ob3cnLCAnZHJ5UnVuJ10pIHtcbiAgICAgICAgZWw8SFRNTEJ1dHRvbkVsZW1lbnQ+KGlkKS5kaXNhYmxlZCA9ICFydW5uYWJsZTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHJlbmRlckF1dG9Ob3RlKCk6IHZvaWQge1xuICAgIGNvbnN0IG5vdGUgPSBlbDxIVE1MUGFyYWdyYXBoRWxlbWVudD4oJ2F1dG9Ob3RlJyk7XG4gICAgbm90ZS50ZXh0Q29udGVudCA9IGN1cnJlbnQuZW5hYmxlZFxuICAgICAgICA/IGBPbi4gQ2hlY2tzIGV2ZXJ5IDYgaG91cnMgYW5kIGJvb2tzIGFueSBtaXNzaW5nIGRheSBpbiB0aGUgbmV4dCAke2N1cnJlbnQuaG9yaXpvbkRheXN9IGBcbiAgICAgICAgICAgICsgJ2RheXMuIE9ubHkgcnVucyB3aGlsZSBDaHJvbWUgaXMgb3BlbiBcdTIwMTQgYSBjbG9zZWQgbGFwdG9wIGp1c3QgbWVhbnMgaXQgY2F0Y2hlcyB1cCBsYXRlci4nXG4gICAgICAgIDogJ09mZi4gTm90aGluZyBpcyBib29rZWQgdW5sZXNzIHlvdSBwcmVzcyBCb29rIG5vdy4nO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgc2F2aW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmbGFzaFNhdmVkKHRleHQgPSAnU2F2ZWQnKTogdm9pZCB7XG4gICAgY29uc3QgZmxhZyA9IGVsPEhUTUxTcGFuRWxlbWVudD4oJ3NhdmVkRmxhZycpO1xuICAgIGZsYWcudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgIGZsYWcuaGlkZGVuID0gZmFsc2U7XG4gICAgd2luZG93LnNldFRpbWVvdXQoKCkgPT4geyBmbGFnLmhpZGRlbiA9IHRydWU7IH0sIDFfMjAwKTtcbn1cblxubGV0IHNhdmVUaW1lcjogbnVtYmVyIHwgdW5kZWZpbmVkO1xuXG4vKipcbiAqIFRoZXJlIGlzIG5vIFNhdmUgYnV0dG9uOiBldmVyeSBjaGFuZ2UgcGVyc2lzdHMgb24gaXRzIG93biBhZnRlciBhIHNob3J0XG4gKiBwYXVzZS4gVGhlIHBhdXNlIGlzIHdoYXQga2VlcHMgYSB0eXBlZCBkZXNrIG5hbWUgZnJvbSB3cml0aW5nIHN0b3JhZ2Ugb25jZVxuICogcGVyIGtleXN0cm9rZS5cbiAqL1xuZnVuY3Rpb24gcXVldWVTYXZlKCk6IHZvaWQge1xuICAgIHdpbmRvdy5jbGVhclRpbWVvdXQoc2F2ZVRpbWVyKTtcbiAgICBzYXZlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgY29tbWl0KCk7IH0sIDMwMCk7XG59XG5cbi8qKiBTZXQgd2hpbGUgdGhpcyBwb3B1cCB3cml0ZXMsIHNvIGl0cyBvd24gc2F2ZSBkb2VzIG5vdCBib3VuY2UgYmFjayBhcyBhbiB1cGRhdGUuICovXG5sZXQgc2F2aW5nTG9jYWxseSA9IGZhbHNlO1xuXG5hc3luYyBmdW5jdGlvbiBjb21taXQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgeyBzZXR0aW5ncywgZW5kcG9pbnRFcnJvciB9ID0gY29sbGVjdCgpO1xuICAgIGN1cnJlbnQgPSBzZXR0aW5ncztcbiAgICBzYXZpbmdMb2NhbGx5ID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBzYXZlU2V0dGluZ3Moc2V0dGluZ3MpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIC8vIENsZWFyZWQgYWZ0ZXIgdGhlIGV2ZW50IGxvb3AgdHVybiwgc28gdGhlIGNoYW5nZSBldmVudCB0aGlzIHdyaXRlXG4gICAgICAgIC8vIHByb2R1Y2VzIGlzIHN0aWxsIHNlZW4gYXMgbG9jYWwuXG4gICAgICAgIHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHsgc2F2aW5nTG9jYWxseSA9IGZhbHNlOyB9LCAwKTtcbiAgICB9XG4gICAgcmVuZGVyUGxhbigpO1xuICAgIHJlbmRlckF1dG9Ob3RlKCk7XG4gICAgcmVuZGVyRGVza1N0YXRlKCk7XG4gICAgZmxhc2hTYXZlZChlbmRwb2ludEVycm9yID8gJ0VuZHBvaW50IEpTT04gaW52YWxpZCBcdTIwMTQgbm90IHNhdmVkJyA6ICdTYXZlZCcpO1xufVxuXG5mb3IgKGNvbnN0IGZpZWxkIG9mIFtcbiAgICBmaWVsZHMuZW5hYmxlZCwgZmllbGRzLmRlc2tOYW1lLCBmaWVsZHMuZGVza0lkLCBmaWVsZHMuZmxvb3JJZCxcbiAgICBmaWVsZHMuc2xvdCwgZmllbGRzLmhvcml6b25EYXlzLCBmaWVsZHMudGltZVpvbmUsIGZpZWxkcy5lbmRwb2ludCxcbl0pIHtcbiAgICBmaWVsZC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBxdWV1ZVNhdmUpO1xuICAgIGZpZWxkLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgcXVldWVTYXZlKTtcbn1cblxuLy8gVGhlIHNhdmUgaXMgZGVib3VuY2VkOyB0aGUgdmFsaWRhdGlvbiBtdXN0IG5vdCBiZSwgb3IgdGhlIGZpZWxkIHN0YXlzIHJlZCBmb3Jcbi8vIGEgdGhpcmQgb2YgYSBzZWNvbmQgYWZ0ZXIgeW91IGhhdmUgYWxyZWFkeSBmaXhlZCBpdC5cbmZvciAoY29uc3QgZmllbGQgb2YgW2ZpZWxkcy5kZXNrTmFtZSwgZmllbGRzLmRlc2tJZF0pIHtcbiAgICBmaWVsZC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIHJlbmRlckRlc2tTdGF0ZSk7XG59XG5kYXlzSG9zdC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBxdWV1ZVNhdmUpO1xuXG4vLyBcdTI1MDBcdTI1MDAgcnVuIGxvZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gcmVuZGVyTG9nKGxvZzogUnVuTG9nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gICAgY29uc3QgaG9zdCA9IGVsPEhUTUxQcmVFbGVtZW50PignbG9nJyk7XG4gICAgaG9zdC50ZXh0Q29udGVudCA9ICcnO1xuICAgIGlmICghbG9nKSB7XG4gICAgICAgIGhvc3QudGV4dENvbnRlbnQgPSAnTm8gcnVucyB5ZXQuJztcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHdoZW4gPSBuZXcgRGF0ZShsb2cuYXQpLnRvTG9jYWxlU3RyaW5nKCk7XG4gICAgY29uc3QgaGVhZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGhlYWQudGV4dENvbnRlbnQgPSBgJHt3aGVufSR7bG9nLmRyeVJ1biA/ICcgIChwcmV2aWV3IFx1MjAxNCBub3RoaW5nIHdhcyBib29rZWQpJyA6ICcnfWA7XG4gICAgaG9zdC5hcHBlbmQoaGVhZCk7XG5cbiAgICBpZiAobG9nLmVycm9yKSB7XG4gICAgICAgIGNvbnN0IHByb2JsZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgcHJvYmxlbS5jbGFzc05hbWUgPSAnc3QtZXJyb3InO1xuICAgICAgICBwcm9ibGVtLnRleHRDb250ZW50ID0gYGVycm9yOiAke2xvZy5lcnJvcn1gO1xuICAgICAgICBob3N0LmFwcGVuZChwcm9ibGVtKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IG5vdGUgb2YgbG9nLm5vdGVzKSB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgbGluZS5jbGFzc05hbWUgPSAnc3Qtc2tpcHBlZCc7XG4gICAgICAgIGxpbmUudGV4dENvbnRlbnQgPSBgXHUwMEI3ICR7bm90ZX1gO1xuICAgICAgICBob3N0LmFwcGVuZChsaW5lKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHJvdyBvZiBsb2cucm93cykge1xuICAgICAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIGxpbmUuY2xhc3NOYW1lID0gYHN0LSR7cm93LnN0YXR1c31gO1xuICAgICAgICBsaW5lLnRleHRDb250ZW50ID0gYCR7cm93LmRhdGV9ICAke3Jvdy5zdGF0dXN9JHtyb3cuZGV0YWlsID8gYCAgJHtyb3cuZGV0YWlsfWAgOiAnJ31gO1xuICAgICAgICBob3N0LmFwcGVuZChsaW5lKTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlbmRlckNhcHR1cmVzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHsgY2FwdHVyZXMgPSBbXSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdjYXB0dXJlcycpIGFzIHsgY2FwdHVyZXM/OiB1bmtub3duW10gfTtcbiAgICBjb25zdCBob3N0ID0gZWw8SFRNTFByZUVsZW1lbnQ+KCdjYXB0dXJlcycpO1xuICAgIGlmIChjYXB0dXJlcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgaG9zdC50ZXh0Q29udGVudCA9ICdOb3RoaW5nIHJlY29yZGVkIHlldC4nO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGhvc3QudGV4dENvbnRlbnQgPSBjYXB0dXJlcy5tYXAoKGNhcHR1cmUpID0+IEpTT04uc3RyaW5naWZ5KGNhcHR1cmUsIG51bGwsIDEpKS5qb2luKCdcXG5cXG4nKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIGxvYWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5yZW5kZXJTZXR0aW5ncyhjdXJyZW50KTtcbnJlbmRlclBsYW4oKTtcbnJlbmRlckF1dG9Ob3RlKCk7XG5yZW5kZXJEZXNrU3RhdGUoKTtcblxuY29uc3QgeyBydW5zID0gW10sIGxlYXJuTW9kZSA9IGZhbHNlIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoWydydW5zJywgJ2xlYXJuTW9kZSddKSBhcyB7XG4gICAgcnVucz86IFJ1bkxvZ1tdO1xuICAgIGxlYXJuTW9kZT86IGJvb2xlYW47XG59O1xuZmllbGRzLmxlYXJuTW9kZS5jaGVja2VkID0gbGVhcm5Nb2RlO1xubGFzdExvZyA9IHJ1bnNbMF07XG5yZW5kZXJMb2cocnVuc1swXSk7XG4vLyBUaGUgcGxhbiB3YXMgZHJhd24gYmVmb3JlIHRoZSBsb2cgd2FzIGxvYWRlZCwgc28gY29sb3VyIGl0IGluIG5vdy5cbnJlbmRlclBsYW4oKTtcblxuLy8gT3BlbmluZyB0aGUgcG9wdXAgaXMgd2hhdCBtYXJrcyBhIGZhaWx1cmUgYXMgcmVhZCwgc28gdGhlIGJhZGdlIGNsZWFycyBoZXJlXG4vLyByYXRoZXIgdGhhbiB3YWl0aW5nIGZvciB0aGUgbmV4dCBzdWNjZXNzZnVsIHJ1bi5cbnZvaWQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyB0eXBlOiAncG9wdXAtb3BlbmVkJyB9KS5jYXRjaCgoKSA9PiB7IC8qIHdvcmtlciBhc2xlZXAgKi8gfSk7XG5hd2FpdCByZW5kZXJDYXB0dXJlcygpO1xuXG4vLyBcdTI1MDBcdTI1MDAgYWN0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuYXN5bmMgZnVuY3Rpb24gdHJpZ2dlclJ1bihidXR0b246IEhUTUxCdXR0b25FbGVtZW50LCBkcnlSdW46IGJvb2xlYW4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBidXR0b24uZGlzYWJsZWQgPSB0cnVlO1xuICAgIGNvbnN0IG9yaWdpbmFsID0gYnV0dG9uLnRleHRDb250ZW50O1xuICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IGRyeVJ1biA/ICdDaGVja2luZ1x1MjAyNicgOiAnQm9va2luZ1x1MjAyNic7XG4gICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgY29tbWl0KCk7XG4gICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyB0eXBlOiAncnVuJywgZHJ5UnVuIH0pIGFzIHtcbiAgICAgICAgICAgIG9rOiBib29sZWFuO1xuICAgICAgICAgICAgbG9nPzogUnVuTG9nO1xuICAgICAgICAgICAgZXJyb3I/OiBzdHJpbmc7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChyZXNwb25zZS5vayAmJiByZXNwb25zZS5sb2cpIHtcbiAgICAgICAgICAgIGxhc3RMb2cgPSByZXNwb25zZS5sb2c7XG4gICAgICAgICAgICByZW5kZXJMb2cocmVzcG9uc2UubG9nKTtcbiAgICAgICAgICAgIHJlbmRlclBsYW4oKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlbmRlckxvZyh7XG4gICAgICAgICAgICAgICAgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICAgICAgICBkcnlSdW4sXG4gICAgICAgICAgICAgICAgZGF0ZXM6IFtdLFxuICAgICAgICAgICAgICAgIHJvd3M6IFtdLFxuICAgICAgICAgICAgICAgIG5vdGVzOiBbXSxcbiAgICAgICAgICAgICAgICBlcnJvcjogcmVzcG9uc2UuZXJyb3IgPz8gJ1Vua25vd24gZmFpbHVyZScsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZW5kZXJMb2coe1xuICAgICAgICAgICAgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICAgIGRyeVJ1bixcbiAgICAgICAgICAgIGRhdGVzOiBbXSxcbiAgICAgICAgICAgIHJvd3M6IFtdLFxuICAgICAgICAgICAgbm90ZXM6IFtdLFxuICAgICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgfSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgYnV0dG9uLnRleHRDb250ZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIC8vIE5vdCBgZGlzYWJsZWQgPSBmYWxzZWA6IHdoZXRoZXIgdGhlc2UgYXJlIHVzYWJsZSBpcyByZW5kZXJEZXNrU3RhdGUnc1xuICAgICAgICAvLyBkZWNpc2lvbiwgYW5kIGEgcnVuIGRvZXMgbm90IGNoYW5nZSBpdC5cbiAgICAgICAgcmVuZGVyRGVza1N0YXRlKCk7XG4gICAgfVxufVxuXG5lbDxIVE1MQnV0dG9uRWxlbWVudD4oJ3J1bk5vdycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGV2ZW50KSA9PiB7XG4gICAgdm9pZCB0cmlnZ2VyUnVuKGV2ZW50LmN1cnJlbnRUYXJnZXQgYXMgSFRNTEJ1dHRvbkVsZW1lbnQsIGZhbHNlKTtcbn0pO1xuXG5lbDxIVE1MQnV0dG9uRWxlbWVudD4oJ2RyeVJ1bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGV2ZW50KSA9PiB7XG4gICAgdm9pZCB0cmlnZ2VyUnVuKGV2ZW50LmN1cnJlbnRUYXJnZXQgYXMgSFRNTEJ1dHRvbkVsZW1lbnQsIHRydWUpO1xufSk7XG5cbmZpZWxkcy5sZWFybk1vZGUuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xuICAgIHZvaWQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgbGVhcm5Nb2RlOiBmaWVsZHMubGVhcm5Nb2RlLmNoZWNrZWQgfSk7XG59KTtcblxuZWw8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdjb3B5Q2FwdHVyZXMnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jIChldmVudCkgPT4ge1xuICAgIGNvbnN0IHsgY2FwdHVyZXMgPSBbXSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdjYXB0dXJlcycpIGFzIHsgY2FwdHVyZXM/OiB1bmtub3duW10gfTtcbiAgICBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dChKU09OLnN0cmluZ2lmeShjYXB0dXJlcywgbnVsbCwgMikpO1xuICAgIGNvbnN0IGJ1dHRvbiA9IGV2ZW50LmN1cnJlbnRUYXJnZXQgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBidXR0b24udGV4dENvbnRlbnQ7XG4gICAgYnV0dG9uLnRleHRDb250ZW50ID0gJ0NvcGllZCc7XG4gICAgd2luZG93LnNldFRpbWVvdXQoKCkgPT4geyBidXR0b24udGV4dENvbnRlbnQgPSBvcmlnaW5hbDsgfSwgMV80MDApO1xufSk7XG5cbi8qKlxuICogRm9sbG93IGNoYW5nZXMgdGhlIHBvcHVwIGRpZCBub3QgbWFrZSBpdHNlbGYuXG4gKlxuICogQSBydW4gc3RhcnRlZCBmcm9tIGhlcmUgYWxyZWFkeSByZWRyYXdzIG9uIGl0cyByZXBseS4gVGhpcyBpcyBmb3IgZXZlcnl0aGluZ1xuICogZWxzZTogYW4gYXV0b21hdGljIHJ1biBmaW5pc2hpbmcgd2hpbGUgdGhlIHBhbmVsIGlzIG9wZW4sIGFuZCB0aGUgc2V0dGluZ3MgdGhlXG4gKiBiYWNrZ3JvdW5kIHdyaXRlcyBvbiBpdHMgb3duIFx1MjAxNCB0aGUgcmVzb2x2ZWQgZGVzayBpZCBpdCBjYWNoZXMsIHRoZSBjYW5jZWxcbiAqIGRhdGVzIGl0IGNsZWFycyBvbmNlIGRvbmUuIFdpdGhvdXQgdGhpcyB0aGUgcGFuZWwgcXVpZXRseSBzaG93cyBhIHN0YWxlXG4gKiBwaWN0dXJlIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIG9wZW4sIHdoaWNoIGlzIGV4YWN0bHkgd2hlbiBzb21lb25lIGlzXG4gKiB3YXRjaGluZyBpdCB0byBzZWUgd2hldGhlciB0aGUgdGhpbmcgd29ya3MuXG4gKi9cbmNocm9tZS5zdG9yYWdlLm9uQ2hhbmdlZC5hZGRMaXN0ZW5lcigoY2hhbmdlcywgYXJlYSkgPT4ge1xuICAgIGlmIChhcmVhICE9PSAnbG9jYWwnKSByZXR1cm47XG5cbiAgICBpZiAoY2hhbmdlcy5ydW5zKSB7XG4gICAgICAgIGNvbnN0IHJ1bnMgPSBjaGFuZ2VzLnJ1bnMubmV3VmFsdWUgYXMgUnVuTG9nW10gfCB1bmRlZmluZWQ7XG4gICAgICAgIGxhc3RMb2cgPSBydW5zPy5bMF07XG4gICAgICAgIHJlbmRlckxvZyhsYXN0TG9nKTtcbiAgICAgICAgcmVuZGVyUGxhbigpO1xuICAgIH1cblxuICAgIC8vIE9ubHkgcmUtcmVuZGVyIGZyb20gYSBiYWNrZ3JvdW5kIHdyaXRlLCBuZXZlciBmcm9tIHRoaXMgcG9wdXAncyBvd24gc2F2ZSxcbiAgICAvLyBvciBldmVyeSBrZXlzdHJva2Ugd291bGQgcmV3cml0ZSB0aGUgZmllbGQgdW5kZXIgdGhlIGN1cnNvci5cbiAgICBpZiAoY2hhbmdlcy5zZXR0aW5ncyAmJiAhc2F2aW5nTG9jYWxseSkge1xuICAgICAgICBjdXJyZW50ID0gbWVyZ2VTZXR0aW5ncyhjaGFuZ2VzLnNldHRpbmdzLm5ld1ZhbHVlIGFzIFBhcnRpYWw8U2V0dGluZ3M+IHwgdW5kZWZpbmVkKTtcbiAgICAgICAgcmVuZGVyU2V0dGluZ3MoY3VycmVudCk7XG4gICAgICAgIHJlbmRlclBsYW4oKTtcbiAgICAgICAgcmVuZGVyQXV0b05vdGUoKTtcbiAgICAgICAgcmVuZGVyRGVza1N0YXRlKCk7XG4gICAgfVxufSk7XG5cbmVsPEhUTUxCdXR0b25FbGVtZW50PignY2xlYXJDYXB0dXJlcycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IGNhcHR1cmVzOiBbXSB9KTtcbiAg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LEdBQUc7QUFBQSxJQUMxRCxDQUFDO0FBQUEsRUFDTCxVQUFFO0FBQ0UsV0FBTyxjQUFjO0FBR3JCLG9CQUFnQjtBQUFBLEVBQ3BCO0FBQ0o7QUFFQSxHQUFzQixRQUFRLEVBQUUsaUJBQWlCLFNBQVMsQ0FBQyxVQUFVO0FBQ2pFLE9BQUssV0FBVyxNQUFNLGVBQW9DLEtBQUs7QUFDbkUsQ0FBQztBQUVELEdBQXNCLFFBQVEsRUFBRSxpQkFBaUIsU0FBUyxDQUFDLFVBQVU7QUFDakUsT0FBSyxXQUFXLE1BQU0sZUFBb0MsSUFBSTtBQUNsRSxDQUFDO0FBRUQsT0FBTyxVQUFVLGlCQUFpQixVQUFVLE1BQU07QUFDOUMsT0FBSyxPQUFPLFFBQVEsTUFBTSxJQUFJLEVBQUUsV0FBVyxPQUFPLFVBQVUsUUFBUSxDQUFDO0FBQ3pFLENBQUM7QUFFRCxHQUFzQixjQUFjLEVBQUUsaUJBQWlCLFNBQVMsT0FBTyxVQUFVO0FBQzdFLFFBQU0sRUFBRSxXQUFXLENBQUMsRUFBRSxJQUFJLE1BQU0sT0FBTyxRQUFRLE1BQU0sSUFBSSxVQUFVO0FBQ25FLFFBQU0sVUFBVSxVQUFVLFVBQVUsS0FBSyxVQUFVLFVBQVUsTUFBTSxDQUFDLENBQUM7QUFDckUsUUFBTSxTQUFTLE1BQU07QUFDckIsUUFBTSxXQUFXLE9BQU87QUFDeEIsU0FBTyxjQUFjO0FBQ3JCLFNBQU8sV0FBVyxNQUFNO0FBQUUsV0FBTyxjQUFjO0FBQUEsRUFBVSxHQUFHLElBQUs7QUFDckUsQ0FBQztBQVlELE9BQU8sUUFBUSxVQUFVLFlBQVksQ0FBQyxTQUFTLFNBQVM7QUFDcEQsTUFBSSxTQUFTLFFBQVM7QUFFdEIsTUFBSSxRQUFRLE1BQU07QUFDZCxVQUFNQSxRQUFPLFFBQVEsS0FBSztBQUMxQixjQUFVQSxRQUFPLENBQUM7QUFDbEIsY0FBVSxPQUFPO0FBQ2pCLGVBQVc7QUFBQSxFQUNmO0FBSUEsTUFBSSxRQUFRLFlBQVksQ0FBQyxlQUFlO0FBQ3BDLGNBQVUsY0FBYyxRQUFRLFNBQVMsUUFBeUM7QUFDbEYsbUJBQWUsT0FBTztBQUN0QixlQUFXO0FBQ1gsbUJBQWU7QUFDZixvQkFBZ0I7QUFBQSxFQUNwQjtBQUNKLENBQUM7QUFFRCxHQUFzQixlQUFlLEVBQUUsaUJBQWlCLFNBQVMsWUFBWTtBQUN6RSxRQUFNLE9BQU8sUUFBUSxNQUFNLElBQUksRUFBRSxVQUFVLENBQUMsRUFBRSxDQUFDO0FBQy9DLFFBQU0sZUFBZTtBQUN6QixDQUFDOyIsCiAgIm5hbWVzIjogWyJydW5zIl0KfQo=
