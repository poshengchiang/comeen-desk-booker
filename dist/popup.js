// src/core/config.ts
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
var BUILDING = { id: 5151, name: "100yards" };
var DESK_NAME_PATTERN = /^\d+-\d+$/;
function isValidDeskName(name) {
  return DESK_NAME_PATTERN.test(name.trim());
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
      // Owned by the calendar, not by any form field.
      skipDates: current.skipDates,
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
  const skipped = new Set(current.skipDates);
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
      if (candidates.has(iso)) {
        cell.classList.add(skipped.has(iso) ? "skip" : "book", "clickable");
        cell.title = skipped.has(iso) ? "Skipped \u2014 click to book it" : "Click to skip";
        cell.addEventListener("click", () => {
          current.skipDates = skipped.has(iso) ? current.skipDates.filter((entry) => entry !== iso) : [...current.skipDates, iso].sort();
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
async function commit() {
  const { settings, endpointError } = collect();
  current = settings;
  await saveSettings(settings);
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
renderLog(runs[0]);
await renderCaptures();
async function triggerRun(button, dryRun) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = dryRun ? "Checking\u2026" : "Booking\u2026";
  try {
    await commit();
    const response = await chrome.runtime.sendMessage({ type: "run", dryRun });
    if (response.ok && response.log) {
      renderLog(response.log);
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
el("clearCaptures").addEventListener("click", async () => {
  await chrome.storage.local.set({ captures: [] });
  await renderCaptures();
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvcmUvY29uZmlnLnRzIiwgIi4uL3NyYy9jb3JlL2RhdGVzLnRzIiwgIi4uL3NyYy9wb3B1cC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBXZWVrZGF5IH0gZnJvbSAnLi9kYXRlcy5qcyc7XG5cbmV4cG9ydCB0eXBlIFNsb3QgPSAnYWxsX2RheScgfCAnbW9ybmluZycgfCAnYWZ0ZXJub29uJztcblxuLyoqXG4gKiBIb3cgdGhlIGluLXBhZ2UgY29kZSBzaG91bGQgYXV0aGVudGljYXRlLlxuICpcbiAqIGBjb29raWVgICAgICAgIC0ganVzdCBzZW5kIGNyZWRlbnRpYWxzIHdpdGggdGhlIHJlcXVlc3QuIENvcnJlY3QgaWYgQ29tZWVuXG4gKiAgICAgICAgICAgICAgICAgIGF1dGhlbnRpY2F0ZXMgd2l0aCBhIHNlc3Npb24gY29va2llLlxuICogYGxvY2FsU3RvcmFnZWAgLSByZWFkIGEgdG9rZW4gb3V0IG9mIHRoZSBwYWdlJ3Mgb3duIGxvY2FsU3RvcmFnZSBhbmQgcHV0IGl0XG4gKiAgICAgICAgICAgICAgICAgIGluIGEgaGVhZGVyLiBDb3JyZWN0IGlmIENvbWVlbiB1c2VzIGEgYmVhcmVyIHRva2VuLlxuICpcbiAqIEVpdGhlciB3YXkgdGhlIHZhbHVlIGlzIHJlYWQgaW5zaWRlIHRoZSBwYWdlIGFuZCB1c2VkIHRoZXJlLiBJdCBpcyBuZXZlclxuICogY29waWVkIGludG8gZXh0ZW5zaW9uIHN0b3JhZ2UsIG5ldmVyIHBlcnNpc3RlZCwgYW5kIG5ldmVyIGxlYXZlcyB0aGUgdGFiLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhDb25maWcge1xuICAgIG1vZGU6ICdjb29raWUnIHwgJ2xvY2FsU3RvcmFnZSc7XG4gICAgLyoqIGxvY2FsU3RvcmFnZSBrZXkgaG9sZGluZyB0aGUgdG9rZW4uICovXG4gICAgc3RvcmFnZUtleT86IHN0cmluZztcbiAgICAvKiogRG90dGVkIHBhdGggaW5zaWRlIHRoZSBwYXJzZWQgSlNPTiwgZS5nLiBgc3RzVG9rZW5NYW5hZ2VyLmFjY2Vzc1Rva2VuYCAqL1xuICAgIGpzb25QYXRoPzogc3RyaW5nO1xuICAgIC8qKiBIZWFkZXIgdG8gc2V0LCBkZWZhdWx0IGBhdXRob3JpemF0aW9uYCAqL1xuICAgIGhlYWRlcj86IHN0cmluZztcbiAgICAvKiogUHJlZml4IGJlZm9yZSB0aGUgdG9rZW4sIGRlZmF1bHQgYEJlYXJlciBgICovXG4gICAgcHJlZml4Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlcXVlc3RUZW1wbGF0ZSB7XG4gICAgbWV0aG9kOiAnR0VUJyB8ICdQT1NUJyB8ICdQVVQnO1xuICAgIC8qKiBQYXRoIGFwcGVuZGVkIHRvIGFwaUJhc2UuIE1heSBjb250YWluIHBsYWNlaG9sZGVycy4gKi9cbiAgICBwYXRoOiBzdHJpbmc7XG4gICAgcXVlcnk/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgIGJvZHk/OiB1bmtub3duO1xufVxuXG4vKipcbiAqIEhvdyB0aGUgXCJ3aGF0IGRvIEkgYWxyZWFkeSBob2xkXCIgcmVzcG9uc2UgaXMgbGFpZCBvdXQuXG4gKlxuICogYGFycmF5YCAgICAgICAgLSBhIGZsYXQgbGlzdCBvZiBib29raW5ncywgZWFjaCBjYXJyeWluZyBpdHMgb3duIGRhdGUgZmllbGQsXG4gKiAgICAgICAgICAgICAgICAgIHJlYWQgdmlhIGBsaXN0RGF0ZUZpZWxkc2AuXG4gKiBgZGF0ZUtleWVkTWFwYCAtIGFuIG9iamVjdCBrZXllZCBieSBgWVlZWS1NTS1ERGAgd2hvc2UgdmFsdWVzIGFyZSB0aGF0IGRheSdzXG4gKiAgICAgICAgICAgICAgICAgIGVudHJpZXMuIENvbWVlbiByZXR1cm5zIHRoaXMgb25lLiBUaGUgZGF0ZSBpcyB0aGUgKmtleSosIG5vdFxuICogICAgICAgICAgICAgICAgICBhIGZpZWxkLCBzbyBubyBhbW91bnQgb2Ygc25pZmZpbmcgZmllbGQgbmFtZXMgd291bGQgZmluZCBpdCBcdTIwMTRcbiAqICAgICAgICAgICAgICAgICAgd2hpY2ggaXMgZXhhY3RseSB3aHkgdGhlIHNoYXBlIGlzIGNvbmZpZ3VyYXRpb24gcmF0aGVyIHRoYW5cbiAqICAgICAgICAgICAgICAgICAgc29tZXRoaW5nIHRoZSBpbi1wYWdlIGNvZGUgZ3Vlc3Nlcy5cbiAqL1xuZXhwb3J0IHR5cGUgTGlzdFNoYXBlID0gJ2FycmF5JyB8ICdkYXRlS2V5ZWRNYXAnO1xuXG4vKipcbiAqIFRoZSB3aG9sZSBBUEkgY29udHJhY3QgbGl2ZXMgaGVyZSBhcyBkYXRhIHNvIGl0IGNhbiBiZSBjb3JyZWN0ZWQgZnJvbSB0aGVcbiAqIHBvcHVwIHdpdGhvdXQgcmVidWlsZGluZy4gUGxhY2Vob2xkZXJzIGF2YWlsYWJsZSB0byBwYXRocywgcXVlcmllcyBhbmRcbiAqIGJvZGllczoge3tkYXRlfX0sIHt7ZGVza0lkfX0sIHt7ZGVza05hbWV9fSwge3tzbG90fX0sIHt7c3RhcnRUaW1lfX0sXG4gKiB7e2VuZFRpbWV9fSwge3tmcm9tfX0sIHt7dG99fSwge3t1c2VySWR9fSwge3tmbG9vcklkfX0sIHt7YnVpbGRpbmdJZH19LFxuICoge3thcmVhSWR9fS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBFbmRwb2ludENvbmZpZyB7XG4gICAgYXBpQmFzZTogc3RyaW5nO1xuICAgIGF1dGg6IEF1dGhDb25maWc7XG4gICAgLyoqXG4gICAgICogTG9vayBhIGRlc2sgdXAgYnkgaXRzIGh1bWFuIG5hbWUgc28gbm9ib2R5IGhhcyB0byBrbm93IGl0cyBpbnRlcm5hbCBpZC5cbiAgICAgKiBTZXQgdG8gbnVsbCBvbmx5IGlmIHlvdXIgQ29tZWVuIGhhcyBubyBkZXNrLXNlYXJjaCBlbmRwb2ludC5cbiAgICAgKi9cbiAgICByZXNvbHZlOiBSZXF1ZXN0VGVtcGxhdGUgfCBudWxsO1xuICAgIC8qKiBGaWVsZCBuYW1lcyB0aGF0IG1pZ2h0IGhvbGQgYSBkZXNrJ3MgaHVtYW4gbGFiZWwgaW4gYSBzZWFyY2ggcmVzdWx0LiAqL1xuICAgIGRlc2tOYW1lRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKiogRmllbGQgbmFtZXMgdGhhdCBtaWdodCBob2xkIGEgZGVzaydzIGludGVybmFsIGlkLiBDb21lZW4gdXNlcyBgdXVpZGAuICovXG4gICAgZGVza0lkRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKipcbiAgICAgKiBGaWVsZCBvbiBhIGRlc2sgcmVjb3JkIGhvbGRpbmcgdGhhdCBkZXNrJ3Mgb3duIGJvb2tpbmdzIGZvciB0aGUgcXVlcmllZFxuICAgICAqIHdpbmRvdy4gVXNlZCB0byB0ZWxsIHlvdSBhIGRheSBpcyBhbHJlYWR5IHRha2VuICpiZWZvcmUqIHlvdSBwcmVzcyBCb29rXG4gICAgICogbm93LiBTZXQgdG8gJycgdG8gZGlzYWJsZS5cbiAgICAgKi9cbiAgICBkZXNrU2NoZWR1bGVGaWVsZDogc3RyaW5nO1xuICAgIC8qKlxuICAgICAqIERhdGUgZmllbGRzIHRvIHJlYWQgb2ZmIG9uZSBvZiB0aG9zZSBlbnRyaWVzLCBpbiBwcmlvcml0eSBvcmRlciwgZmlyc3RcbiAgICAgKiBtYXRjaCB3aW5zLlxuICAgICAqXG4gICAgICogVGhlIG9yZGVyIG1hdHRlcnMgbW9yZSB0aGFuIGl0IGxvb2tzOiBhbiBlbnRyeSBhbG1vc3QgY2VydGFpbmx5IGFsc29cbiAgICAgKiBjYXJyaWVzIGNyZWF0ZWRfYXQgYW5kIHVwZGF0ZWRfYXQsIHdoaWNoIGFyZSB3aGVuIHRoZSBib29raW5nIHdhcyBtYWRlLFxuICAgICAqIG5vdCB0aGUgZGF5IGJvb2tlZC4gTGlzdGluZyBvbmx5IHRoZSBmaWVsZHMgdGhhdCBtZWFuIFwidGhlIGRheSB0aGlzIGlzXG4gICAgICogZm9yXCIgaXMgd2hhdCBzdG9wcyBhIGJvb2tpbmcgbWFkZSB0aHJlZSB3ZWVrcyBhZ28gZnJvbSBtYXJraW5nIHRocmVlXG4gICAgICogd2Vla3MgYWdvIGFzIHRha2VuLlxuICAgICAqL1xuICAgIGRlc2tTY2hlZHVsZURhdGVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKiBTZXQgdG8gbnVsbCB0byBza2lwIHRoZSBcIndoYXQgZG8gSSBhbHJlYWR5IGhhdmVcIiBjaGVjay4gKi9cbiAgICBsaXN0OiBSZXF1ZXN0VGVtcGxhdGUgfCBudWxsO1xuICAgIC8qKiBEb3R0ZWQgcGF0aCB0byB0aGUgY29udGFpbmVyIGluc2lkZSB0aGUgbGlzdCByZXNwb25zZS4gJycgbWVhbnMgcm9vdC4gKi9cbiAgICBsaXN0Um9vdDogc3RyaW5nO1xuICAgIGxpc3RTaGFwZTogTGlzdFNoYXBlO1xuICAgIC8qKiBPbmx5IGNvbnN1bHRlZCB3aGVuIGxpc3RTaGFwZSBpcyAnYXJyYXknLiAqL1xuICAgIGxpc3REYXRlRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKipcbiAgICAgKiBEb3R0ZWQgcGF0aCB0byB0aGUgc2lnbmVkLWluIHVzZXIncyBpZCBpbnNpZGUgdGhlIGxpc3QgcmVzcG9uc2UuIEVtcHR5XG4gICAgICogZGlzYWJsZXMgdGhlIGxvb2t1cCwgYW5kIHt7dXNlcklkfX0gdGhlbiBzdGF5cyB1bmZpbGxlZC5cbiAgICAgKi9cbiAgICB1c2VySWRQYXRoOiBzdHJpbmc7XG4gICAgY3JlYXRlOiBSZXF1ZXN0VGVtcGxhdGU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ3Mge1xuICAgIC8qKlxuICAgICAqIEJ1bXBlZCBpbiBERUZBVUxUX1NFVFRJTkdTIHdoZW5ldmVyIHRoZSBzaGlwcGVkIGVuZHBvaW50IGNvbmZpZyBpc1xuICAgICAqIGNvcnJlY3RlZC4gU2VlIG1lcmdlU2V0dGluZ3M6IGEgc3RvcmVkIGNvbmZpZyBvbGRlciB0aGFuIHRoZSBzaGlwcGVkIG9uZVxuICAgICAqIGlzIHJlcGxhY2VkIHJhdGhlciB0aGFuIG1lcmdlZCwgd2hpY2ggaXMgd2hhdCBsZXRzIGEgZml4IGFjdHVhbGx5IHJlYWNoXG4gICAgICogcGVvcGxlIHdobyBoYXZlIGFscmVhZHkgc2F2ZWQgc2V0dGluZ3Mgb25jZS5cbiAgICAgKi9cbiAgICBlbmRwb2ludFZlcnNpb246IG51bWJlcjtcbiAgICBlbmFibGVkOiBib29sZWFuO1xuICAgIGRlc2tOYW1lOiBzdHJpbmc7XG4gICAgZGVza0lkOiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogVGhlIGZsb29yIHRoZSBkZXNrIGlzIG9uLiBUaGlzIG9uZSBjYW5ub3QgYmUgZGVyaXZlZDogcmVzb2x2aW5nIGEgZGVzayBieVxuICAgICAqIG5hbWUgbWVhbnMgbGlzdGluZyBhIGZsb29yJ3MgZGVza3MsIHNvIHRoZSBmbG9vciBoYXMgdG8gYmUga25vd24gZmlyc3QuXG4gICAgICogVmlzaWJsZSBpbiB0aGUgVVJMIG9mIENvbWVlbidzIGZsb29yIHBsYW4sIGFuZCBpbiBgZmxvb3JfaWRgIG9uIGFueSBkZXNrLlxuICAgICAqL1xuICAgIGZsb29ySWQ6IG51bWJlcjtcbiAgICAvKipcbiAgICAgKiBUaGUgYnVpbGRpbmcgdGhlIGZsb29yIGlzIGluLiBBbHNvIG5vdCBkZXJpdmFibGUgXHUyMDE0IGEgZGVzayByZWNvcmQgY2Fycmllc1xuICAgICAqIGBmbG9vcl9pZGAgYW5kIGBhcmVhX2lkYCBidXQgbm8gYGJ1aWxkaW5nX2lkYCwgYW5kIHRoZSBvbmx5IGVuZHBvaW50IHRoYXRcbiAgICAgKiBtYXBzIG9uZSB0byB0aGUgb3RoZXIgbmVlZHMgYSBzcGFjZSBVVUlEIHdlIG5ldmVyIG90aGVyd2lzZSBmZXRjaC5cbiAgICAgKi9cbiAgICBidWlsZGluZ0lkOiBudW1iZXI7XG4gICAgd2Vla2RheXM6IFdlZWtkYXlbXTtcbiAgICBzbG90OiBTbG90O1xuICAgIGhvcml6b25EYXlzOiBudW1iZXI7XG4gICAgc2tpcERhdGVzOiBzdHJpbmdbXTtcbiAgICB0aW1lWm9uZTogc3RyaW5nO1xuICAgIGVuZHBvaW50OiBFbmRwb2ludENvbmZpZztcbn1cblxuLyoqXG4gKiBBIHNsb3QgYXMgdGhlIG5haXZlIGxvY2FsIHRpbWVzIENvbWVlbiBleHBlY3RzLlxuICpcbiAqIENvbWVlbiBzZW5kcyBkYXRldGltZXMgbGlrZSBgMjAyNi0wOS0wMVQwMDowMDowMC4wMDBaYCBhbmQgZWNob2VzIHRoZW0gYmFja1xuICogYXMgYDIwMjYtMDktMDFUMDA6MDA6MDBgIFx1MjAxNCBhIGxvY2FsIHdhbGwtY2xvY2sgdGltZSB3ZWFyaW5nIGEgYFpgLiBTbyB0aGUgZGF5XG4gKiBpcyB1c2VkIHZlcmJhdGltIGFuZCBubyB0aW1lem9uZSBjb252ZXJzaW9uIGhhcHBlbnMgYW55d2hlcmUgaW4gdGhlIGJvb2tpbmdcbiAqIHBhdGguIFRoZSBkYXRlIGxvZ2ljIGluIGRhdGVzLnRzIGFscmVhZHkgcHJvZHVjZXMgZXhhY3RseSB0aGlzLlxuICpcbiAqIFx1MjZBMFx1RkUwRiBPbmx5IGBhbGxfZGF5YCBpcyBjb25maXJtZWQgYWdhaW5zdCBhIHJlYWwgYm9va2luZy4gVGhlIGhhbGYtZGF5cyBhcmUgYVxuICogcmVhc29uYWJsZSByZWFkaW5nIG9mIHRoZSBzYW1lIHNjaGVtZSwgbm90IGFuIG9ic2VydmVkIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNMT1RfVElNRVM6IFJlY29yZDxTbG90LCB7IHN0YXJ0OiBzdHJpbmc7IGVuZDogc3RyaW5nIH0+ID0ge1xuICAgIGFsbF9kYXk6IHsgc3RhcnQ6ICcwMDowMDowMC4wMDBaJywgZW5kOiAnMjM6NTk6NTkuMDAwWicgfSxcbiAgICBtb3JuaW5nOiB7IHN0YXJ0OiAnMDA6MDA6MDAuMDAwWicsIGVuZDogJzEyOjAwOjAwLjAwMFonIH0sXG4gICAgYWZ0ZXJub29uOiB7IHN0YXJ0OiAnMTI6MDA6MDAuMDAwWicsIGVuZDogJzIzOjU5OjU5LjAwMFonIH0sXG59O1xuXG4vKipcbiAqIENvbmZpcm1lZCBhZ2FpbnN0IGEgcmVhbCBzaWduZWQtaW4gc2Vzc2lvbiBpbiBBdWd1c3QgMjAyNiwgYnkgY2FwdHVyaW5nIHRoZVxuICogdHJhZmZpYyBvZiBvbmUgZGVzayBib29raW5nIG1hZGUgYnkgaGFuZC5cbiAqXG4gKiBOb3RlcyB3b3J0aCBrZWVwaW5nLCBiZWNhdXNlIGVhY2ggb25lIGNvbnRyYWRpY3RzIGEgcmVhc29uYWJsZSBndWVzczpcbiAqICAgLSBgYXBpQmFzZWAgaXMgbXkuY29tZWVuLmlvL2FwaSwgdGhlIFNQQSdzIG93biBvcmlnaW4sIE5PVCBhcGkuY29tZWVuLmlvXG4gKiAgICAgd2hlcmUgdGhlIHB1YmxpYyBkb2NzIGxpdmUuIEl0IGlzIGEgUmFpbHMgYmFja2VuZCBiZWhpbmQgYSBOdXh0IGZyb250IGVuZCxcbiAqICAgICB3aGljaCBpcyB3aHkgcGF0aHMgZW5kIGluIGAuanNvbmAuXG4gKiAgIC0gVGhlIEFQSSB2ZXJzaW9uIHZhcmllcyBwZXIgZW5kcG9pbnQgKC92MSwgL3YyLCAvdjJiZXRhKSwgc28gdGhlIHZlcnNpb25cbiAqICAgICBiZWxvbmdzIGluIGVhY2ggcGF0aCByYXRoZXIgdGhhbiBpbiBhcGlCYXNlLlxuICogICAtIEEgZGVzaydzIGlkIGlzIGB1dWlkYC4gVGhlcmUgaXMgbm8gYGlkYCBmaWVsZCBvbiBhIGRlc2sgYXQgYWxsLlxuICogICAtIFRoZSBib29raW5ncyBsaXN0IGlzIGtleWVkIGJ5IGRhdGU7IHRoZSBkYXRlIGlzIG5vdCBhIGZpZWxkIG9uIGFuIGVudHJ5LlxuICogICAtIEEgYm9va2luZyBpcyBhIFwid29yayBhY3Rpdml0eVwiIHdpdGggYSBkZXNrIGF0dGFjaGVkLCBub3QgYSBkZXNrIGJvb2tpbmdcbiAqICAgICBhcyBzdWNoLiBUaGF0IGlzIHdoeSB0aGUgcGF0aCBzYXlzIHdvcmtfYWN0aXZpdHlfc2NoZWR1bGUuXG4gKiAgIC0gQXV0aCBpcyB0aGUgc2Vzc2lvbiBjb29raWUuIEEgZmV0Y2ggZnJvbSB0aGUgcGFnZSB3aXRoIGNyZWRlbnRpYWxzXG4gKiAgICAgaW5jbHVkZWQgYW5kIG5vIEF1dGhvcml6YXRpb24gaGVhZGVyIHJldHVybnMgMjAwLCBzbyB0aGVyZSBpcyBubyB0b2tlbiB0b1xuICogICAgIHJlYWQgYW5kIG5vdGhpbmcgZm9yIHRoZSBleHRlbnNpb24gdG8gaG9sZC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFNldHRpbmdzID0ge1xuICAgIC8vIFx1MkIwNiBCVU1QIFRISVMgd2hlbmV2ZXIgeW91IGNvcnJlY3QgdGhlIGBlbmRwb2ludGAgYmxvY2sgYmVsb3csIG90aGVyd2lzZVxuICAgIC8vIGFueW9uZSB3aG8gYWxyZWFkeSBwcmVzc2VkIFNhdmUga2VlcHMgdGhlaXIgc3RhbGUgY29weSBmb3JldmVyLlxuICAgIGVuZHBvaW50VmVyc2lvbjogMyxcbiAgICBlbmFibGVkOiBmYWxzZSxcbiAgICAvLyBFbXB0eSBvbiBwdXJwb3NlLiBTaGlwcGluZyBhIHJlYWwgZGVzayBudW1iZXIgYXMgdGhlIGRlZmF1bHQgbWVhbnMgdGhlXG4gICAgLy8gZmlyc3QgcGVyc29uIHRvIGluc3RhbGwgdGhpcyBhbmQgcHJlc3MgQm9vayBub3cgdGFrZXMgc29tZWJvZHkgZWxzZSdzXG4gICAgLy8gc2VhdCwgaGF2aW5nIGRvbmUgbm90aGluZyB3cm9uZy4gTm90aGluZyBydW5zIHVudGlsIGEgZGVzayBpcyBjaG9zZW4uXG4gICAgZGVza05hbWU6ICcnLFxuICAgIGRlc2tJZDogJycsXG4gICAgZmxvb3JJZDogNDk1MixcbiAgICBidWlsZGluZ0lkOiA1MTUxLFxuICAgIHdlZWtkYXlzOiBbJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknXSxcbiAgICBzbG90OiAnYWxsX2RheScsXG4gICAgaG9yaXpvbkRheXM6IDE0LFxuICAgIHNraXBEYXRlczogW10sXG4gICAgdGltZVpvbmU6ICdFdXJvcGUvUHJhZ3VlJyxcbiAgICBlbmRwb2ludDoge1xuICAgICAgICBhcGlCYXNlOiAnaHR0cHM6Ly9teS5jb21lZW4uaW8vYXBpJyxcbiAgICAgICAgYXV0aDogeyBtb2RlOiAnY29va2llJyB9LFxuICAgICAgICByZXNvbHZlOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICAgICAgcGF0aDogJy92MS9mbG9vcnMve3tmbG9vcklkfX0vZGVza3Nfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGU6ICd7e2Zyb219fVQwMDowMDowMC4wMDBaJyxcbiAgICAgICAgICAgICAgICBlbmRfZGF0ZTogJ3t7dG99fVQyMzo1OTo1OS4wMDBaJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGRlc2tOYW1lRmllbGRzOiBbJ25hbWUnLCAnc3luY19pZCddLFxuICAgICAgICBkZXNrSWRGaWVsZHM6IFsndXVpZCcsICdpZCddLFxuICAgICAgICBkZXNrU2NoZWR1bGVGaWVsZDogJ3NjaGVkdWxlJyxcbiAgICAgICAgZGVza1NjaGVkdWxlRGF0ZUZpZWxkczogWydzdGFydF9kYXRldGltZScsICdzdGFydF9kYXRlJywgJ2RhdGUnLCAnZGF5JywgJ3N0YXJ0J10sXG4gICAgICAgIGxpc3Q6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgICAgICBwYXRoOiAnL3YxL3VzZXJzL21lL3dvcmtfYWN0aXZpdHlfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGU6ICd7e2Zyb219fVQwMDowMDowMC4wMDBaJyxcbiAgICAgICAgICAgICAgICBlbmRfZGF0ZTogJ3t7dG99fVQyMzo1OTo1OS4wMDBaJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGxpc3RSb290OiAnc2NoZWR1bGUnLFxuICAgICAgICBsaXN0U2hhcGU6ICdkYXRlS2V5ZWRNYXAnLFxuICAgICAgICBsaXN0RGF0ZUZpZWxkczogWydzdGFydF9kYXRldGltZScsICdkYXRlJ10sXG4gICAgICAgIHVzZXJJZFBhdGg6ICd1c2VyLmlkJyxcbiAgICAgICAgY3JlYXRlOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICAgIC8vIFRoZSBgbWVgIGFsaWFzIHdvcmtzIGZvciByZWFkczsgdGhlIGFwcCBpdHNlbGYgdXNlcyB0aGUgbnVtZXJpY1xuICAgICAgICAgICAgLy8gaWQgdG8gd3JpdGUsIHNvIHRoYXQgaXMgd2hhdCBpcyB1c2VkIGhlcmUuXG4gICAgICAgICAgICBwYXRoOiAnL3YxL3VzZXJzL3t7dXNlcklkfX0vd29ya19hY3Rpdml0eV9zY2hlZHVsZS5qc29uJyxcbiAgICAgICAgICAgIGJvZHk6IHtcbiAgICAgICAgICAgICAgICB3b3JrX2FjdGl2aXR5OiB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXRlOiAnb25fc2l0ZScsXG4gICAgICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGV0aW1lOiAne3tkYXRlfX1Ue3tzdGFydFRpbWV9fScsXG4gICAgICAgICAgICAgICAgICAgIGVuZF9kYXRldGltZTogJ3t7ZGF0ZX19VHt7ZW5kVGltZX19JyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHByZXNlbmNlOiB7XG4gICAgICAgICAgICAgICAgICAgIGJ1aWxkaW5nX2lkOiAne3tidWlsZGluZ0lkfX0nLFxuICAgICAgICAgICAgICAgICAgICBmbG9vcl9pZDogJ3t7Zmxvb3JJZH19JyxcbiAgICAgICAgICAgICAgICAgICAgYXJlYV9pZDogJ3t7YXJlYUlkfX0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgZGVza19ib29raW5nOiB7IGRlc2tfdXVpZDogJ3t7ZGVza0lkfX0nIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgIH0sXG59O1xuXG4vKipcbiAqIFRoZSBvZmZpY2UsIGFzIGNhcHR1cmVkIGluIEF1Z3VzdCAyMDI2LlxuICpcbiAqIEhhcmRjb2RlZCByYXRoZXIgdGhhbiBmZXRjaGVkLiBUaGUgZmxvb3IgZHJvcGRvd24gaGFzIHRvIGJlIHBvcHVsYXRlZCBiZWZvcmVcbiAqIGFueSBuZXR3b3JrIGNhbGwgaGFwcGVucywgYW4gb2ZmaWNlIGxheW91dCBjaGFuZ2VzIGFib3V0IG5ldmVyLCBhbmQgYVxuICogaGFyZGNvZGVkIGZsb29yIHRoYXQgaXMgd3JvbmcgaXMgYSB2aXNpYmxlIG1pc3Rha2UgcmF0aGVyIHRoYW4gYSBzaWxlbnQgb25lLlxuICpcbiAqIFRvIGFkZCBhIGZsb29yLCByZWFkIHRoZSBpZHMgZnJvbSB0aGUgcmVzcG9uc2Ugb2ZcbiAqIC9hcGkvdjIvc3BhY2VzLzxzcGFjZS11dWlkPi9idWlsZGluZ3MvPGJ1aWxkaW5nLWlkPi9mbG9vcnMuanNvbiB3aXRoIHRoZVxuICogZmxvb3IgcGxhbiBvcGVuLlxuICovXG5leHBvcnQgY29uc3QgQlVJTERJTkcgPSB7IGlkOiA1MTUxLCBuYW1lOiAnMTAweWFyZHMnIH07XG5cbi8qKlxuICogQSBkZXNrIG5hbWUgaXMgZGlnaXRzLCBhIGRhc2gsIGRpZ2l0cyBcdTIwMTQgYDMtMjNgLCBgMTItNGAuXG4gKlxuICogRGVsaWJlcmF0ZWx5IG5vdCB0aWdodGVuZWQgdG8gdHdvIHplcm8tcGFkZGVkIGRpZ2l0cywgd2hpY2ggaXMgd2hhdCB0aGlzXG4gKiBvZmZpY2UgaGFwcGVucyB0byB1c2U6IGEgZmxvb3IgMTIgb3IgYSBkZXNrIDEwMCB3b3VsZCB0aGVuIGJlIHJlamVjdGVkIGZvclxuICogbG9va2luZyB3cm9uZyByYXRoZXIgdGhhbiBmb3IgYmVpbmcgd3JvbmcuIFdoYXQgdGhpcyBjYXRjaGVzIGlzIHRoZSBtaXN0YWtlXG4gKiBwZW9wbGUgYWN0dWFsbHkgbWFrZSBcdTIwMTQgdHlwaW5nIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBhIGRlc2sgbnVtYmVyIGF0IGFsbDogYVxuICogbmFtZSwgYSByb29tLCBhIHN0cmF5IHNwYWNlLlxuICovXG5leHBvcnQgY29uc3QgREVTS19OQU1FX1BBVFRFUk4gPSAvXlxcZCstXFxkKyQvO1xuXG4vKiogRW1wdHkgaXMgbm90IHZhbGlkLCBidXQgaXQgaXMgbm90IGFuIGVycm9yIGVpdGhlciBcdTIwMTQgc2VlIHRoZSBwb3B1cC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ZhbGlkRGVza05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIERFU0tfTkFNRV9QQVRURVJOLnRlc3QobmFtZS50cmltKCkpO1xufVxuXG5leHBvcnQgY29uc3QgRkxPT1JTOiB7IGlkOiBudW1iZXI7IGxhYmVsOiBzdHJpbmcgfVtdID0gW1xuICAgIHsgaWQ6IDQ5NTIsIGxhYmVsOiAnRmxvb3IgMycgfSxcbiAgICB7IGlkOiA0OTUzLCBsYWJlbDogJ0Zsb29yIDQnIH0sXG5dO1xuXG5leHBvcnQgdHlwZSBWYXJzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuLyoqXG4gKiBBIHBsYWNlaG9sZGVyIHRoYXQgbWFrZXMgdXAgdGhlICplbnRpcmUqIHZhbHVlIGFuZCByZXNvbHZlcyB0byBhbiBpbnRlZ2VyXG4gKiBiZWNvbWVzIGEgbnVtYmVyLlxuICpcbiAqIFRoaXMgbWF0dGVycyBiZWNhdXNlIEpTT04gZGlzdGluZ3Vpc2hlcyA1MTUxIGZyb20gXCI1MTUxXCIgYW5kIENvbWVlbidzXG4gKiBwcmVzZW5jZSBibG9jayB3YW50cyB0aGUgZm9ybWVyLiBQYXJ0aWFsIGludGVycG9sYXRpb24gXHUyMDE0IFwiL3VzZXJzL3t7dXNlcklkfX0veFwiXG4gKiBcdTIwMTQgYWx3YXlzIHlpZWxkcyBhIHN0cmluZywgd2hpY2ggaXMgd2hhdCBhIHBhdGggbmVlZHMsIHNvIHRoZSB0d28gY2FzZXMgbmV2ZXJcbiAqIGNvbGxpZGUuIEEgdXVpZCBvciBhIGRhdGUgY29udGFpbnMgbm9uLWRpZ2l0cyBhbmQgc3RheXMgYSBzdHJpbmcgZWl0aGVyIHdheS5cbiAqL1xuY29uc3QgV0hPTEVfUExBQ0VIT0xERVIgPSAvXlxce1xceyhcXHcrKVxcfVxcfSQvO1xuY29uc3QgSU5URUdFUiA9IC9eLT9cXGQrJC87XG5cbi8qKiBSZXBsYWNlIHt7cGxhY2Vob2xkZXJzfX0gdGhyb3VnaG91dCBhIEpTT04taXNoIHZhbHVlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1YnN0aXR1dGUodmFsdWU6IHVua25vd24sIHZhcnM6IFZhcnMpOiB1bmtub3duIHtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICBjb25zdCB3aG9sZSA9IFdIT0xFX1BMQUNFSE9MREVSLmV4ZWModmFsdWUpO1xuICAgICAgICBpZiAod2hvbGUpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlcGxhY2VtZW50ID0gdmFyc1t3aG9sZVsxXSA/PyAnJ107XG4gICAgICAgICAgICBpZiAocmVwbGFjZW1lbnQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHZhbHVlO1xuICAgICAgICAgICAgcmV0dXJuIElOVEVHRVIudGVzdChyZXBsYWNlbWVudCkgPyBOdW1iZXIocmVwbGFjZW1lbnQpIDogcmVwbGFjZW1lbnQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZhbHVlLnJlcGxhY2UoL1xce1xceyhcXHcrKVxcfVxcfS9nLCAobWF0Y2gsIGtleTogc3RyaW5nKSA9PiB2YXJzW2tleV0gPz8gbWF0Y2gpO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlLm1hcCgoZW50cnkpID0+IHN1YnN0aXR1dGUoZW50cnksIHZhcnMpKTtcbiAgICB9XG4gICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSkpIG91dFtrZXldID0gc3Vic3RpdHV0ZShlbnRyeSwgdmFycyk7XG4gICAgICAgIHJldHVybiBvdXQ7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbn1cblxuLyoqXG4gKiBNZXJnZSBzdG9yZWQgc2V0dGluZ3Mgb3ZlciB0aGUgc2hpcHBlZCBkZWZhdWx0cy5cbiAqXG4gKiBQZXJzb25hbCBjaG9pY2VzIChkZXNrLCB3ZWVrZGF5cywgdGltZXpvbmUpIGFsd2F5cyB3aW46IHRoZXkgYXJlIHRoZSB1c2VyJ3MuXG4gKiBUaGUgZW5kcG9pbnQgY29uZmlnIGlzIGRpZmZlcmVudC4gSXQgaXMgbm90IGEgcHJlZmVyZW5jZSwgaXQgaXMgYSBmYWN0IGFib3V0XG4gKiBDb21lZW4ncyBBUEkgdGhhdCBvbmUgcGVyc29uIGRpc2NvdmVycyBhbmQgZXZlcnlvbmUgZWxzZSBpbmhlcml0cy4gSWYgYVxuICogc3RvcmVkIGNvcHkgcHJlZGF0ZXMgdGhlIHNoaXBwZWQgb25lLCB0aGUgc2hpcHBlZCBvbmUgcmVwbGFjZXMgaXQgb3V0cmlnaHQuXG4gKiBNZXJnaW5nIGtleS1ieS1rZXkgd291bGQgYmUgd29yc2UgdGhhbiB1c2VsZXNzIGhlcmU6IGEgY29ycmVjdGVkIGBjcmVhdGVgXG4gKiBibG9jayB3b3VsZCBzaXQgbmV4dCB0byBhIHN0YWxlIGBsaXN0YCBibG9jayBhbmQgZmFpbCBpbiBhIGNvbmZ1c2luZyB3YXkuXG4gKlxuICogUHVyZSBhbmQgc2VwYXJhdGUgZnJvbSBjaHJvbWUuc3RvcmFnZSBzbyBpdCBjYW4gYmUgdGVzdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWVyZ2VTZXR0aW5ncyhzdG9yZWQ6IFBhcnRpYWw8U2V0dGluZ3M+IHwgdW5kZWZpbmVkKTogU2V0dGluZ3Mge1xuICAgIGNvbnN0IHN0b3JlZFZlcnNpb24gPSBzdG9yZWQ/LmVuZHBvaW50VmVyc2lvbiA/PyAwO1xuICAgIGNvbnN0IHNoaXBwZWRJc05ld2VyID0gc3RvcmVkVmVyc2lvbiA8IERFRkFVTFRfU0VUVElOR1MuZW5kcG9pbnRWZXJzaW9uO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgLi4uREVGQVVMVF9TRVRUSU5HUyxcbiAgICAgICAgLi4uc3RvcmVkLFxuICAgICAgICBlbmRwb2ludFZlcnNpb246IERFRkFVTFRfU0VUVElOR1MuZW5kcG9pbnRWZXJzaW9uLFxuICAgICAgICBlbmRwb2ludDogc2hpcHBlZElzTmV3ZXIgfHwgIXN0b3JlZD8uZW5kcG9pbnRcbiAgICAgICAgICAgID8gREVGQVVMVF9TRVRUSU5HUy5lbmRwb2ludFxuICAgICAgICAgICAgOiBzdG9yZWQuZW5kcG9pbnQsXG4gICAgfTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRTZXR0aW5ncygpOiBQcm9taXNlPFNldHRpbmdzPiB7XG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdzZXR0aW5ncycpO1xuICAgIHJldHVybiBtZXJnZVNldHRpbmdzKHN0b3JlZC5zZXR0aW5ncyBhcyBQYXJ0aWFsPFNldHRpbmdzPiB8IHVuZGVmaW5lZCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlU2V0dGluZ3Moc2V0dGluZ3M6IFNldHRpbmdzKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgc2V0dGluZ3MgfSk7XG59XG4iLCAiZXhwb3J0IHR5cGUgV2Vla2RheSA9XG4gICAgfCAnbW9uZGF5JyB8ICd0dWVzZGF5JyB8ICd3ZWRuZXNkYXknXG4gICAgfCAndGh1cnNkYXknIHwgJ2ZyaWRheScgfCAnc2F0dXJkYXknIHwgJ3N1bmRheSc7XG5cbmNvbnN0IFdFRUtEQVlfTkFNRVM6IHJlYWRvbmx5IFdlZWtkYXlbXSA9IFtcbiAgICAnc3VuZGF5JywgJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknLCAnc2F0dXJkYXknLFxuXTtcblxuZnVuY3Rpb24gaXNXZWVrZGF5KHZhbHVlOiBzdHJpbmcpOiB2YWx1ZSBpcyBXZWVrZGF5IHtcbiAgICByZXR1cm4gKFdFRUtEQVlfTkFNRVMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKHZhbHVlKTtcbn1cblxuLyoqIEZvcm1hdCBhIERhdGUgYXMgWVlZWS1NTS1ERCBhcyBzZWVuIGluIGB0aW1lWm9uZWAuICovXG5leHBvcnQgZnVuY3Rpb24gdG9Mb2NhbElTT0RhdGUoZGF0ZTogRGF0ZSwgdGltZVpvbmU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1DQScsIHtcbiAgICAgICAgdGltZVpvbmUsIHllYXI6ICdudW1lcmljJywgbW9udGg6ICcyLWRpZ2l0JywgZGF5OiAnMi1kaWdpdCcsXG4gICAgfSkuZm9ybWF0KGRhdGUpO1xufVxuXG4vKiogV2Vla2RheSBuYW1lIG9mIGBkYXRlYCBhcyBzZWVuIGluIGB0aW1lWm9uZWAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYWxXZWVrZGF5KGRhdGU6IERhdGUsIHRpbWVab25lOiBzdHJpbmcpOiBXZWVrZGF5IHtcbiAgICBjb25zdCBuYW1lID0gbmV3IEludGwuRGF0ZVRpbWVGb3JtYXQoJ2VuLVVTJywgeyB0aW1lWm9uZSwgd2Vla2RheTogJ2xvbmcnIH0pXG4gICAgICAgIC5mb3JtYXQoZGF0ZSlcbiAgICAgICAgLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKCFpc1dlZWtkYXkobmFtZSkpIHRocm93IG5ldyBFcnJvcihgVW5leHBlY3RlZCB3ZWVrZGF5IGZyb20gSW50bDogXCIke25hbWV9XCJgKTtcbiAgICByZXR1cm4gbmFtZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEYXRlc1RvQm9va09wdGlvbnMge1xuICAgIHdlZWtkYXlzOiBzdHJpbmdbXTtcbiAgICBob3Jpem9uRGF5cz86IG51bWJlcjtcbiAgICBza2lwRGF0ZXM/OiBzdHJpbmdbXTtcbiAgICB0aW1lWm9uZT86IHN0cmluZztcbiAgICBub3c/OiBEYXRlO1xufVxuXG4vKipcbiAqIEV2ZXJ5IGRheSBmcm9tIHRvZGF5IChpbmNsdXNpdmUpIHVwIHRvIGBob3Jpem9uRGF5c2AgYWhlYWQgd2hvc2Ugd2Vla2RheSBpc1xuICogaW4gYHdlZWtkYXlzYCwgbWludXMgYHNraXBEYXRlc2AuXG4gKlxuICogVGhlIDE0LWRheSBkZWZhdWx0IGlzIHdoYXQgbWFrZXMgdW5yZWxpYWJsZSBzY2hlZHVsaW5nIGFjY2VwdGFibGU6IGVhY2ggcnVuXG4gKiB0b3BzIHRoZSB3aG9sZSB3aW5kb3cgYmFjayB1cCwgc28gbWlzc2luZyBhIGRheSAobGFwdG9wIHNodXQsIENocm9tZSBjbG9zZWQpXG4gKiBjb3N0cyBub3RoaW5nIGFzIGxvbmcgYXMgdGhlIGV4dGVuc2lvbiBydW5zIGFnYWluIGJlZm9yZSB0aGUgd2luZG93IGRyYWlucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRhdGVzVG9Cb29rKHtcbiAgICB3ZWVrZGF5cyxcbiAgICBob3Jpem9uRGF5cyA9IDE0LFxuICAgIHNraXBEYXRlcyA9IFtdLFxuICAgIHRpbWVab25lID0gJ0V1cm9wZS9QcmFndWUnLFxuICAgIG5vdyA9IG5ldyBEYXRlKCksXG59OiBEYXRlc1RvQm9va09wdGlvbnMpOiBzdHJpbmdbXSB7XG4gICAgY29uc3Qgd2FudGVkID0gbmV3IFNldDxXZWVrZGF5PigpO1xuICAgIGZvciAoY29uc3QgcmF3IG9mIHdlZWtkYXlzKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSByYXcudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgaWYgKCFpc1dlZWtkYXkobmFtZSkpIHRocm93IG5ldyBFcnJvcihgTm90IGEgd2Vla2RheSBuYW1lOiBcIiR7cmF3fVwiYCk7XG4gICAgICAgIHdhbnRlZC5hZGQobmFtZSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoc2tpcERhdGVzKTtcbiAgICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG5cbiAgICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPD0gaG9yaXpvbkRheXM7IG9mZnNldCArPSAxKSB7XG4gICAgICAgIGNvbnN0IGRheSA9IG5ldyBEYXRlKG5vdy5nZXRUaW1lKCkgKyBvZmZzZXQgKiA4Nl80MDBfMDAwKTtcbiAgICAgICAgY29uc3QgaXNvID0gdG9Mb2NhbElTT0RhdGUoZGF5LCB0aW1lWm9uZSk7XG4gICAgICAgIGlmICghd2FudGVkLmhhcyhsb2NhbFdlZWtkYXkoZGF5LCB0aW1lWm9uZSkpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNraXAuaGFzKGlzbykpIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaChpc28pO1xuICAgIH1cblxuICAgIHJldHVybiBvdXQ7XG59XG4iLCAiaW1wb3J0IHtcbiAgICBCVUlMRElORyxcbiAgICBERUZBVUxUX1NFVFRJTkdTLFxuICAgIEZMT09SUyxcbiAgICBpc1ZhbGlkRGVza05hbWUsXG4gICAgbG9hZFNldHRpbmdzLFxuICAgIHNhdmVTZXR0aW5ncyxcbiAgICB0eXBlIEVuZHBvaW50Q29uZmlnLFxuICAgIHR5cGUgU2V0dGluZ3MsXG4gICAgdHlwZSBTbG90LFxufSBmcm9tICcuL2NvcmUvY29uZmlnLmpzJztcbmltcG9ydCB7IGRhdGVzVG9Cb29rLCB0b0xvY2FsSVNPRGF0ZSwgdHlwZSBXZWVrZGF5IH0gZnJvbSAnLi9jb3JlL2RhdGVzLmpzJztcbmltcG9ydCB0eXBlIHsgUnVuTG9nIH0gZnJvbSAnLi9iYWNrZ3JvdW5kLmpzJztcblxuY29uc3QgREFZUzogV2Vla2RheVtdID0gWydtb25kYXknLCAndHVlc2RheScsICd3ZWRuZXNkYXknLCAndGh1cnNkYXknLCAnZnJpZGF5JywgJ3NhdHVyZGF5JywgJ3N1bmRheSddO1xuXG4vKiogTW9uZGF5LWZpcnN0LCB0byBtYXRjaCBob3cgYSB3b3JraW5nIHdlZWsgaXMgcmVhZC4gKi9cbmNvbnN0IERPV19MQUJFTFMgPSBbJ01vJywgJ1R1JywgJ1dlJywgJ1RoJywgJ0ZyJywgJ1NhJywgJ1N1J107XG5cbmZ1bmN0aW9uIGVsPFQgZXh0ZW5kcyBIVE1MRWxlbWVudD4oaWQ6IHN0cmluZyk6IFQge1xuICAgIGNvbnN0IG5vZGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7XG4gICAgaWYgKCFub2RlKSB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgZWxlbWVudCAjJHtpZH1gKTtcbiAgICByZXR1cm4gbm9kZSBhcyBUO1xufVxuXG5jb25zdCBmaWVsZHMgPSB7XG4gICAgZW5hYmxlZDogZWw8SFRNTElucHV0RWxlbWVudD4oJ2VuYWJsZWQnKSxcbiAgICBkZXNrTmFtZTogZWw8SFRNTElucHV0RWxlbWVudD4oJ2Rlc2tOYW1lJyksXG4gICAgZGVza0lkOiBlbDxIVE1MSW5wdXRFbGVtZW50PignZGVza0lkJyksXG4gICAgZmxvb3JJZDogZWw8SFRNTFNlbGVjdEVsZW1lbnQ+KCdmbG9vcklkJyksXG4gICAgc2xvdDogZWw8SFRNTFNlbGVjdEVsZW1lbnQ+KCdzbG90JyksXG4gICAgaG9yaXpvbkRheXM6IGVsPEhUTUxJbnB1dEVsZW1lbnQ+KCdob3Jpem9uRGF5cycpLFxuICAgIHRpbWVab25lOiBlbDxIVE1MSW5wdXRFbGVtZW50PigndGltZVpvbmUnKSxcbiAgICBlbmRwb2ludDogZWw8SFRNTFRleHRBcmVhRWxlbWVudD4oJ2VuZHBvaW50JyksXG4gICAgbGVhcm5Nb2RlOiBlbDxIVE1MSW5wdXRFbGVtZW50PignbGVhcm5Nb2RlJyksXG59O1xuXG4vLyBcdTI1MDBcdTI1MDAgc3RhdGljIG9mZmljZSBmYWN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmVsPEhUTUxTcGFuRWxlbWVudD4oJ2J1aWxkaW5nTmFtZScpLnRleHRDb250ZW50ID0gQlVJTERJTkcubmFtZTtcblxuZm9yIChjb25zdCBmbG9vciBvZiBGTE9PUlMpIHtcbiAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICBvcHRpb24udmFsdWUgPSBTdHJpbmcoZmxvb3IuaWQpO1xuICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IGZsb29yLmxhYmVsO1xuICAgIGZpZWxkcy5mbG9vcklkLmFwcGVuZChvcHRpb24pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgd2Vla2RheSBjaGlwcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmNvbnN0IGRheXNIb3N0ID0gZWw8SFRNTERpdkVsZW1lbnQ+KCdkYXlzJyk7XG5mb3IgKGNvbnN0IGRheSBvZiBEQVlTKSB7XG4gICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpO1xuICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XG4gICAgYm94LnR5cGUgPSAnY2hlY2tib3gnO1xuICAgIGJveC52YWx1ZSA9IGRheTtcbiAgICBib3guZGF0YXNldC5kYXkgPSBkYXk7XG4gICAgbGFiZWwuYXBwZW5kKGJveCwgZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoZGF5LnNsaWNlKDAsIDMpKSk7XG4gICAgZGF5c0hvc3QuYXBwZW5kKGxhYmVsKTtcbn1cblxuZnVuY3Rpb24gc2VsZWN0ZWREYXlzKCk6IFdlZWtkYXlbXSB7XG4gICAgcmV0dXJuIFsuLi5kYXlzSG9zdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQ+KCdpbnB1dDpjaGVja2VkJyldXG4gICAgICAgIC5tYXAoKGJveCkgPT4gYm94LnZhbHVlIGFzIFdlZWtkYXkpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgc3RhdGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBTZXR0aW5ncyBhdXRvLXNhdmUsIHNvIHRoaXMgaXMgdGhlIGxpdmUgY29weSByYXRoZXIgdGhhbiBhIHNuYXBzaG90IHRha2VuIGF0XG4vLyBsb2FkLiBza2lwRGF0ZXMgaW4gcGFydGljdWxhciBpcyBtdXRhdGVkIGJ5IGNsaWNraW5nIHRoZSBjYWxlbmRhci5cbmxldCBjdXJyZW50OiBTZXR0aW5ncyA9IGF3YWl0IGxvYWRTZXR0aW5ncygpO1xuXG5mdW5jdGlvbiByZW5kZXJTZXR0aW5ncyhuZXh0OiBTZXR0aW5ncyk6IHZvaWQge1xuICAgIGZpZWxkcy5lbmFibGVkLmNoZWNrZWQgPSBuZXh0LmVuYWJsZWQ7XG4gICAgZmllbGRzLmRlc2tOYW1lLnZhbHVlID0gbmV4dC5kZXNrTmFtZTtcbiAgICBmaWVsZHMuZGVza0lkLnZhbHVlID0gbmV4dC5kZXNrSWQ7XG4gICAgZmllbGRzLmZsb29ySWQudmFsdWUgPSBTdHJpbmcobmV4dC5mbG9vcklkKTtcbiAgICBmaWVsZHMuc2xvdC52YWx1ZSA9IG5leHQuc2xvdDtcbiAgICBmaWVsZHMuaG9yaXpvbkRheXMudmFsdWUgPSBTdHJpbmcobmV4dC5ob3Jpem9uRGF5cyk7XG4gICAgZmllbGRzLnRpbWVab25lLnZhbHVlID0gbmV4dC50aW1lWm9uZTtcbiAgICBmaWVsZHMuZW5kcG9pbnQudmFsdWUgPSBKU09OLnN0cmluZ2lmeShuZXh0LmVuZHBvaW50LCBudWxsLCAyKTtcbiAgICBlbDxIVE1MU3BhbkVsZW1lbnQ+KCd0aW1lWm9uZUxhYmVsJykudGV4dENvbnRlbnQgPSBuZXh0LnRpbWVab25lO1xuICAgIGZvciAoY29uc3QgYm94IG9mIGRheXNIb3N0LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oJ2lucHV0JykpIHtcbiAgICAgICAgYm94LmNoZWNrZWQgPSBuZXh0LndlZWtkYXlzLmluY2x1ZGVzKGJveC52YWx1ZSBhcyBXZWVrZGF5KTtcbiAgICB9XG59XG5cbi8qKlxuICogUmVhZCB0aGUgZm9ybSBiYWNrIGludG8gYSBTZXR0aW5ncy5cbiAqXG4gKiBUaGUgZW5kcG9pbnQgdGV4dGFyZWEgaXMgdGhlIG9uZSBmaWVsZCB0aGF0IGNhbiBiZSBtaWQtZWRpdCBhbmQgdW5wYXJzZWFibGUuXG4gKiBBdXRvLXNhdmUgcnVucyBvbiBldmVyeSBrZXlzdHJva2UsIHNvIGEgaGFsZi10eXBlZCBicmFjZSBtdXN0IG5vdCB0aHJvdyBhd2F5XG4gKiB0aGUgd29ya2luZyBjb25maWc6IHRoZSBsYXN0IGdvb2QgdmFsdWUgaXMga2VwdCBhbmQgdGhlIGNhbGxlciBpcyB0b2xkLlxuICovXG5mdW5jdGlvbiBjb2xsZWN0KCk6IHsgc2V0dGluZ3M6IFNldHRpbmdzOyBlbmRwb2ludEVycm9yPzogc3RyaW5nIH0ge1xuICAgIGxldCBlbmRwb2ludDogRW5kcG9pbnRDb25maWcgPSBjdXJyZW50LmVuZHBvaW50O1xuICAgIGxldCBlbmRwb2ludEVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgICAgZW5kcG9pbnQgPSBKU09OLnBhcnNlKGZpZWxkcy5lbmRwb2ludC52YWx1ZSkgYXMgRW5kcG9pbnRDb25maWc7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGVuZHBvaW50RXJyb3IgPSBgRW5kcG9pbnQgY29uZmlnIGlzIG5vdCB2YWxpZCBKU09OOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YDtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBzZXR0aW5nczoge1xuICAgICAgICAgICAgLy8gU2F2aW5nIHN0YW1wcyB0aGUgdmVyc2lvbiB0aGUgdXNlciBoYXMgYWN0dWFsbHkgc2Vlbiwgc28gYSBsYXRlclxuICAgICAgICAgICAgLy8gYnVpbGQgd2l0aCBhIGNvcnJlY3RlZCBjb250cmFjdCBzdGlsbCBzdXBlcnNlZGVzIHRoaXMuXG4gICAgICAgICAgICBlbmRwb2ludFZlcnNpb246IGN1cnJlbnQuZW5kcG9pbnRWZXJzaW9uLFxuICAgICAgICAgICAgZW5hYmxlZDogZmllbGRzLmVuYWJsZWQuY2hlY2tlZCxcbiAgICAgICAgICAgICAgICBkZXNrTmFtZTogZmllbGRzLmRlc2tOYW1lLnZhbHVlLnRyaW0oKSxcbiAgICAgICAgICAgIGRlc2tJZDogZmllbGRzLmRlc2tJZC52YWx1ZS50cmltKCksXG4gICAgICAgICAgICBmbG9vcklkOiBOdW1iZXIoZmllbGRzLmZsb29ySWQudmFsdWUpIHx8IERFRkFVTFRfU0VUVElOR1MuZmxvb3JJZCxcbiAgICAgICAgICAgIC8vIEZpeGVkOiB0aGVyZSBpcyBvbmUgYnVpbGRpbmcsIGFuZCBpdCBpcyBzaG93biBhcyB0ZXh0LCBub3QgZWRpdGVkLlxuICAgICAgICAgICAgYnVpbGRpbmdJZDogQlVJTERJTkcuaWQsXG4gICAgICAgICAgICB3ZWVrZGF5czogc2VsZWN0ZWREYXlzKCksXG4gICAgICAgICAgICBzbG90OiBmaWVsZHMuc2xvdC52YWx1ZSBhcyBTbG90LFxuICAgICAgICAgICAgaG9yaXpvbkRheXM6IE51bWJlcihmaWVsZHMuaG9yaXpvbkRheXMudmFsdWUpIHx8IERFRkFVTFRfU0VUVElOR1MuaG9yaXpvbkRheXMsXG4gICAgICAgICAgICAvLyBPd25lZCBieSB0aGUgY2FsZW5kYXIsIG5vdCBieSBhbnkgZm9ybSBmaWVsZC5cbiAgICAgICAgICAgIHNraXBEYXRlczogY3VycmVudC5za2lwRGF0ZXMsXG4gICAgICAgICAgICB0aW1lWm9uZTogZmllbGRzLnRpbWVab25lLnZhbHVlLnRyaW0oKSB8fCBERUZBVUxUX1NFVFRJTkdTLnRpbWVab25lLFxuICAgICAgICAgICAgZW5kcG9pbnQsXG4gICAgICAgIH0sXG4gICAgICAgIGVuZHBvaW50RXJyb3IsXG4gICAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIHRoZSBib29raW5nIHBsYW4gY2FsZW5kYXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IHBhZCA9ICh2YWx1ZTogbnVtYmVyKTogc3RyaW5nID0+IFN0cmluZyh2YWx1ZSkucGFkU3RhcnQoMiwgJzAnKTtcbmNvbnN0IGlzb0ZvciA9ICh5ZWFyOiBudW1iZXIsIG1vbnRoOiBudW1iZXIsIGRheTogbnVtYmVyKTogc3RyaW5nID0+XG4gICAgYCR7eWVhcn0tJHtwYWQobW9udGggKyAxKX0tJHtwYWQoZGF5KX1gO1xuXG4vKipcbiAqIFR3byBtb250aHMgb2YgZGF5cywgd2l0aCB0aGUgb25lcyB0aGF0IHdpbGwgYWN0dWFsbHkgYmUgYm9va2VkIGhpZ2hsaWdodGVkLlxuICpcbiAqIFRoaXMgaXMgdGhlIGFuc3dlciB0byBcIndoYXQgaXMgdGhpcyBnb2luZyB0byBkb1wiLCB3aGljaCBpcyB3aHkgaXQgZHJhd3MgdGhlXG4gKiB3aG9sZSBob3Jpem9uIHJhdGhlciB0aGFuIG9ubHkgdGhlIGV4Y2VwdGlvbnMgdG8gaXQuIENsaWNraW5nIGEgcGxhbm5lZCBkYXlcbiAqIG1vdmVzIGl0IGluIGFuZCBvdXQgb2Ygc2tpcERhdGVzLlxuICovXG5mdW5jdGlvbiByZW5kZXJQbGFuKCk6IHZvaWQge1xuICAgIGNvbnN0IGhvc3QgPSBlbDxIVE1MRGl2RWxlbWVudD4oJ2NhbGVuZGFyJyk7XG4gICAgaG9zdC50ZXh0Q29udGVudCA9ICcnO1xuXG4gICAgY29uc3QgdG9kYXkgPSB0b0xvY2FsSVNPRGF0ZShuZXcgRGF0ZSgpLCBjdXJyZW50LnRpbWVab25lKTtcbiAgICBjb25zdCBbdG9kYXlZZWFyLCB0b2RheU1vbnRoXSA9IHRvZGF5LnNwbGl0KCctJykubWFwKE51bWJlcikgYXMgW251bWJlciwgbnVtYmVyLCBudW1iZXJdO1xuXG4gICAgLy8gQ2FuZGlkYXRlcyBpZ25vcmluZyBza2lwRGF0ZXMsIHNvIGEgc2tpcHBlZCBkYXkgaXMgc3RpbGwgZHJhd24gYXMgb25lIG9mXG4gICAgLy8gdGhlIHBsYW5uZWQgZGF5cyByYXRoZXIgdGhhbiB2YW5pc2hpbmcgaW50byB0aGUgYmFja2dyb3VuZC5cbiAgICBsZXQgY2FuZGlkYXRlczogU2V0PHN0cmluZz47XG4gICAgdHJ5IHtcbiAgICAgICAgY2FuZGlkYXRlcyA9IG5ldyBTZXQoZGF0ZXNUb0Jvb2soe1xuICAgICAgICAgICAgd2Vla2RheXM6IGN1cnJlbnQud2Vla2RheXMsXG4gICAgICAgICAgICBob3Jpem9uRGF5czogY3VycmVudC5ob3Jpem9uRGF5cyxcbiAgICAgICAgICAgIHNraXBEYXRlczogW10sXG4gICAgICAgICAgICB0aW1lWm9uZTogY3VycmVudC50aW1lWm9uZSxcbiAgICAgICAgfSkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICBjYW5kaWRhdGVzID0gbmV3IFNldCgpO1xuICAgIH1cbiAgICBjb25zdCBza2lwcGVkID0gbmV3IFNldChjdXJyZW50LnNraXBEYXRlcyk7XG5cbiAgICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPCAyOyBvZmZzZXQgKz0gMSkge1xuICAgICAgICBjb25zdCBtb250aCA9IHRvZGF5TW9udGggLSAxICsgb2Zmc2V0O1xuICAgICAgICBjb25zdCB5ZWFyID0gdG9kYXlZZWFyICsgTWF0aC5mbG9vcihtb250aCAvIDEyKTtcbiAgICAgICAgY29uc3Qgbm9ybWFsaXNlZCA9ICgobW9udGggJSAxMikgKyAxMikgJSAxMjtcblxuICAgICAgICBjb25zdCBibG9jayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBibG9jay5jbGFzc05hbWUgPSAnbW9udGgnO1xuXG4gICAgICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgbmFtZS5jbGFzc05hbWUgPSAnbW9udGgtbmFtZSc7XG4gICAgICAgIG5hbWUudGV4dENvbnRlbnQgPSBuZXcgRGF0ZShEYXRlLlVUQyh5ZWFyLCBub3JtYWxpc2VkLCAxKSlcbiAgICAgICAgICAgIC50b0xvY2FsZURhdGVTdHJpbmcodW5kZWZpbmVkLCB7IG1vbnRoOiAnbG9uZycsIHllYXI6ICdudW1lcmljJywgdGltZVpvbmU6ICdVVEMnIH0pO1xuICAgICAgICBibG9jay5hcHBlbmQobmFtZSk7XG5cbiAgICAgICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBncmlkLmNsYXNzTmFtZSA9ICdncmlkJztcbiAgICAgICAgZm9yIChjb25zdCBsYWJlbCBvZiBET1dfTEFCRUxTKSB7XG4gICAgICAgICAgICBjb25zdCBoZWFkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgICAgICBoZWFkLmNsYXNzTmFtZSA9ICdkb3cnO1xuICAgICAgICAgICAgaGVhZC50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICAgICAgZ3JpZC5hcHBlbmQoaGVhZCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBmaXJzdERheU9mV2VlayA9IG5ldyBEYXRlKERhdGUuVVRDKHllYXIsIG5vcm1hbGlzZWQsIDEpKS5nZXRVVENEYXkoKTtcbiAgICAgICAgLy8gZ2V0VVRDRGF5IGlzIFN1bmRheS1maXJzdDsgdGhlIGdyaWQgaXMgTW9uZGF5LWZpcnN0LlxuICAgICAgICBjb25zdCBsZWFkID0gKGZpcnN0RGF5T2ZXZWVrICsgNikgJSA3O1xuICAgICAgICBmb3IgKGxldCBibGFuayA9IDA7IGJsYW5rIDwgbGVhZDsgYmxhbmsgKz0gMSkgZ3JpZC5hcHBlbmQoZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2JykpO1xuXG4gICAgICAgIGNvbnN0IGRheXNJbk1vbnRoID0gbmV3IERhdGUoRGF0ZS5VVEMoeWVhciwgbm9ybWFsaXNlZCArIDEsIDApKS5nZXRVVENEYXRlKCk7XG4gICAgICAgIGZvciAobGV0IGRheSA9IDE7IGRheSA8PSBkYXlzSW5Nb250aDsgZGF5ICs9IDEpIHtcbiAgICAgICAgICAgIGNvbnN0IGlzbyA9IGlzb0Zvcih5ZWFyLCBub3JtYWxpc2VkLCBkYXkpO1xuICAgICAgICAgICAgY29uc3QgY2VsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICAgICAgY2VsbC5jbGFzc05hbWUgPSAnZGF5JztcbiAgICAgICAgICAgIGNlbGwudGV4dENvbnRlbnQgPSBTdHJpbmcoZGF5KTtcbiAgICAgICAgICAgIGNlbGwudHlwZSA9ICdidXR0b24nO1xuXG4gICAgICAgICAgICBpZiAoaXNvIDwgdG9kYXkpIGNlbGwuY2xhc3NMaXN0LmFkZCgncGFzdCcpO1xuICAgICAgICAgICAgaWYgKGlzbyA9PT0gdG9kYXkpIGNlbGwuY2xhc3NMaXN0LmFkZCgndG9kYXknKTtcblxuICAgICAgICAgICAgaWYgKGNhbmRpZGF0ZXMuaGFzKGlzbykpIHtcbiAgICAgICAgICAgICAgICBjZWxsLmNsYXNzTGlzdC5hZGQoc2tpcHBlZC5oYXMoaXNvKSA/ICdza2lwJyA6ICdib29rJywgJ2NsaWNrYWJsZScpO1xuICAgICAgICAgICAgICAgIGNlbGwudGl0bGUgPSBza2lwcGVkLmhhcyhpc28pID8gJ1NraXBwZWQgXHUyMDE0IGNsaWNrIHRvIGJvb2sgaXQnIDogJ0NsaWNrIHRvIHNraXAnO1xuICAgICAgICAgICAgICAgIGNlbGwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGN1cnJlbnQuc2tpcERhdGVzID0gc2tpcHBlZC5oYXMoaXNvKVxuICAgICAgICAgICAgICAgICAgICAgICAgPyBjdXJyZW50LnNraXBEYXRlcy5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeSAhPT0gaXNvKVxuICAgICAgICAgICAgICAgICAgICAgICAgOiBbLi4uY3VycmVudC5za2lwRGF0ZXMsIGlzb10uc29ydCgpO1xuICAgICAgICAgICAgICAgICAgICByZW5kZXJQbGFuKCk7XG4gICAgICAgICAgICAgICAgICAgIHF1ZXVlU2F2ZSgpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBncmlkLmFwcGVuZChjZWxsKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGJsb2NrLmFwcGVuZChncmlkKTtcbiAgICAgICAgaG9zdC5hcHBlbmQoYmxvY2spO1xuICAgIH1cbn1cblxuLyoqXG4gKiBTaG93IHdoZXRoZXIgdGhlIGRlc2sgbmFtZSBpcyB1c2FibGUsIGFuZCBzdG9wIHRoZSBidXR0b25zIGlmIGl0IGlzIG5vdC5cbiAqXG4gKiBUaHJlZSBzdGF0ZXMgcmF0aGVyIHRoYW4gdHdvOiBlbXB0eSBpcyBub3QgYW4gZXJyb3IsIGl0IGlzIHRoZSBzdGFydGluZ1xuICogcG9pbnQsIHNvIGl0IGdldHMgYSBwbGFpbiBoaW50LiBPbmx5IHNvbWV0aGluZyB0eXBlZCBhbmQgd3JvbmcgdHVybnMgcmVkLlxuICogU2NvbGRpbmcgc29tZW9uZSBmb3Igbm90IGhhdmluZyBmaWxsZWQgYSBmaWVsZCBpbiB5ZXQgaXMgaG93IGEgc2V0dXAgc2NyZWVuXG4gKiBtYWtlcyBwZW9wbGUgZmVlbCBzdHVwaWQuXG4gKi9cbmZ1bmN0aW9uIHJlbmRlckRlc2tTdGF0ZSgpOiB2b2lkIHtcbiAgICBjb25zdCByYXcgPSBmaWVsZHMuZGVza05hbWUudmFsdWUudHJpbSgpO1xuICAgIGNvbnN0IG5vdGUgPSBlbDxIVE1MUGFyYWdyYXBoRWxlbWVudD4oJ2Rlc2tOb3RlJyk7XG4gICAgY29uc3QgdmFsaWQgPSBpc1ZhbGlkRGVza05hbWUocmF3KTtcblxuICAgIGlmIChyYXcgPT09ICcnKSB7XG4gICAgICAgIG5vdGUudGV4dENvbnRlbnQgPSAnUGljayB5b3VyIGRlc2sgZmlyc3QgXHUyMDE0IHRoZSBudW1iZXIgcHJpbnRlZCBvbiBpdCwgbGlrZSAzLTIzLic7XG4gICAgICAgIG5vdGUuY2xhc3NMaXN0LnJlbW92ZSgnYmFkJyk7XG4gICAgICAgIGZpZWxkcy5kZXNrTmFtZS5jbGFzc0xpc3QucmVtb3ZlKCdiYWQnKTtcbiAgICB9IGVsc2UgaWYgKHZhbGlkKSB7XG4gICAgICAgIG5vdGUudGV4dENvbnRlbnQgPSAnTG9va2VkIHVwIGJ5IG5hbWUgb24gZXZlcnkgcnVuLCBzbyB0aGUgSUQgc3RheXMgZW1wdHkuJztcbiAgICAgICAgbm90ZS5jbGFzc0xpc3QucmVtb3ZlKCdiYWQnKTtcbiAgICAgICAgZmllbGRzLmRlc2tOYW1lLmNsYXNzTGlzdC5yZW1vdmUoJ2JhZCcpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIG5vdGUudGV4dENvbnRlbnQgPSBgXCIke3Jhd31cIiBpcyBub3QgYSBkZXNrIG51bWJlci4gSXQgc2hvdWxkIGJlIGRpZ2l0cywgYSBkYXNoLCBkaWdpdHMgXHUyMDE0IGxpa2UgMy0yMy5gO1xuICAgICAgICBub3RlLmNsYXNzTGlzdC5hZGQoJ2JhZCcpO1xuICAgICAgICBmaWVsZHMuZGVza05hbWUuY2xhc3NMaXN0LmFkZCgnYmFkJyk7XG4gICAgfVxuXG4gICAgLy8gQSBkZXNrIElEIHNldCBieSBoYW5kIGluIEFkdmFuY2VkIGlzIGEgZGVsaWJlcmF0ZSBvdmVycmlkZSwgYW5kIHN0YW5kcyBpblxuICAgIC8vIGZvciB0aGUgbmFtZS5cbiAgICBjb25zdCBydW5uYWJsZSA9IHZhbGlkIHx8IGZpZWxkcy5kZXNrSWQudmFsdWUudHJpbSgpICE9PSAnJztcbiAgICBmb3IgKGNvbnN0IGlkIG9mIFsncnVuTm93JywgJ2RyeVJ1biddKSB7XG4gICAgICAgIGVsPEhUTUxCdXR0b25FbGVtZW50PihpZCkuZGlzYWJsZWQgPSAhcnVubmFibGU7XG4gICAgfVxufVxuXG5mdW5jdGlvbiByZW5kZXJBdXRvTm90ZSgpOiB2b2lkIHtcbiAgICBjb25zdCBub3RlID0gZWw8SFRNTFBhcmFncmFwaEVsZW1lbnQ+KCdhdXRvTm90ZScpO1xuICAgIG5vdGUudGV4dENvbnRlbnQgPSBjdXJyZW50LmVuYWJsZWRcbiAgICAgICAgPyBgT24uIENoZWNrcyBldmVyeSA2IGhvdXJzIGFuZCBib29rcyBhbnkgbWlzc2luZyBkYXkgaW4gdGhlIG5leHQgJHtjdXJyZW50Lmhvcml6b25EYXlzfSBgXG4gICAgICAgICAgICArICdkYXlzLiBPbmx5IHJ1bnMgd2hpbGUgQ2hyb21lIGlzIG9wZW4gXHUyMDE0IGEgY2xvc2VkIGxhcHRvcCBqdXN0IG1lYW5zIGl0IGNhdGNoZXMgdXAgbGF0ZXIuJ1xuICAgICAgICA6ICdPZmYuIE5vdGhpbmcgaXMgYm9va2VkIHVubGVzcyB5b3UgcHJlc3MgQm9vayBub3cuJztcbn1cblxuLy8gXHUyNTAwXHUyNTAwIHNhdmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZmxhc2hTYXZlZCh0ZXh0ID0gJ1NhdmVkJyk6IHZvaWQge1xuICAgIGNvbnN0IGZsYWcgPSBlbDxIVE1MU3BhbkVsZW1lbnQ+KCdzYXZlZEZsYWcnKTtcbiAgICBmbGFnLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICBmbGFnLmhpZGRlbiA9IGZhbHNlO1xuICAgIHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHsgZmxhZy5oaWRkZW4gPSB0cnVlOyB9LCAxXzIwMCk7XG59XG5cbmxldCBzYXZlVGltZXI6IG51bWJlciB8IHVuZGVmaW5lZDtcblxuLyoqXG4gKiBUaGVyZSBpcyBubyBTYXZlIGJ1dHRvbjogZXZlcnkgY2hhbmdlIHBlcnNpc3RzIG9uIGl0cyBvd24gYWZ0ZXIgYSBzaG9ydFxuICogcGF1c2UuIFRoZSBwYXVzZSBpcyB3aGF0IGtlZXBzIGEgdHlwZWQgZGVzayBuYW1lIGZyb20gd3JpdGluZyBzdG9yYWdlIG9uY2VcbiAqIHBlciBrZXlzdHJva2UuXG4gKi9cbmZ1bmN0aW9uIHF1ZXVlU2F2ZSgpOiB2b2lkIHtcbiAgICB3aW5kb3cuY2xlYXJUaW1lb3V0KHNhdmVUaW1lcik7XG4gICAgc2F2ZVRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4geyB2b2lkIGNvbW1pdCgpOyB9LCAzMDApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjb21taXQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgeyBzZXR0aW5ncywgZW5kcG9pbnRFcnJvciB9ID0gY29sbGVjdCgpO1xuICAgIGN1cnJlbnQgPSBzZXR0aW5ncztcbiAgICBhd2FpdCBzYXZlU2V0dGluZ3Moc2V0dGluZ3MpO1xuICAgIHJlbmRlclBsYW4oKTtcbiAgICByZW5kZXJBdXRvTm90ZSgpO1xuICAgIHJlbmRlckRlc2tTdGF0ZSgpO1xuICAgIGZsYXNoU2F2ZWQoZW5kcG9pbnRFcnJvciA/ICdFbmRwb2ludCBKU09OIGludmFsaWQgXHUyMDE0IG5vdCBzYXZlZCcgOiAnU2F2ZWQnKTtcbn1cblxuZm9yIChjb25zdCBmaWVsZCBvZiBbXG4gICAgZmllbGRzLmVuYWJsZWQsIGZpZWxkcy5kZXNrTmFtZSwgZmllbGRzLmRlc2tJZCwgZmllbGRzLmZsb29ySWQsXG4gICAgZmllbGRzLnNsb3QsIGZpZWxkcy5ob3Jpem9uRGF5cywgZmllbGRzLnRpbWVab25lLCBmaWVsZHMuZW5kcG9pbnQsXG5dKSB7XG4gICAgZmllbGQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVldWVTYXZlKTtcbiAgICBmaWVsZC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIHF1ZXVlU2F2ZSk7XG59XG5cbi8vIFRoZSBzYXZlIGlzIGRlYm91bmNlZDsgdGhlIHZhbGlkYXRpb24gbXVzdCBub3QgYmUsIG9yIHRoZSBmaWVsZCBzdGF5cyByZWQgZm9yXG4vLyBhIHRoaXJkIG9mIGEgc2Vjb25kIGFmdGVyIHlvdSBoYXZlIGFscmVhZHkgZml4ZWQgaXQuXG5mb3IgKGNvbnN0IGZpZWxkIG9mIFtmaWVsZHMuZGVza05hbWUsIGZpZWxkcy5kZXNrSWRdKSB7XG4gICAgZmllbGQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCByZW5kZXJEZXNrU3RhdGUpO1xufVxuZGF5c0hvc3QuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgcXVldWVTYXZlKTtcblxuLy8gXHUyNTAwXHUyNTAwIHJ1biBsb2cgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHJlbmRlckxvZyhsb2c6IFJ1bkxvZyB8IHVuZGVmaW5lZCk6IHZvaWQge1xuICAgIGNvbnN0IGhvc3QgPSBlbDxIVE1MUHJlRWxlbWVudD4oJ2xvZycpO1xuICAgIGhvc3QudGV4dENvbnRlbnQgPSAnJztcbiAgICBpZiAoIWxvZykge1xuICAgICAgICBob3N0LnRleHRDb250ZW50ID0gJ05vIHJ1bnMgeWV0Lic7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB3aGVuID0gbmV3IERhdGUobG9nLmF0KS50b0xvY2FsZVN0cmluZygpO1xuICAgIGNvbnN0IGhlYWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBoZWFkLnRleHRDb250ZW50ID0gYCR7d2hlbn0ke2xvZy5kcnlSdW4gPyAnICAocHJldmlldyBcdTIwMTQgbm90aGluZyB3YXMgYm9va2VkKScgOiAnJ31gO1xuICAgIGhvc3QuYXBwZW5kKGhlYWQpO1xuXG4gICAgaWYgKGxvZy5lcnJvcikge1xuICAgICAgICBjb25zdCBwcm9ibGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIHByb2JsZW0uY2xhc3NOYW1lID0gJ3N0LWVycm9yJztcbiAgICAgICAgcHJvYmxlbS50ZXh0Q29udGVudCA9IGBlcnJvcjogJHtsb2cuZXJyb3J9YDtcbiAgICAgICAgaG9zdC5hcHBlbmQocHJvYmxlbSk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBub3RlIG9mIGxvZy5ub3Rlcykge1xuICAgICAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIGxpbmUuY2xhc3NOYW1lID0gJ3N0LXNraXBwZWQnO1xuICAgICAgICBsaW5lLnRleHRDb250ZW50ID0gYFx1MDBCNyAke25vdGV9YDtcbiAgICAgICAgaG9zdC5hcHBlbmQobGluZSk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCByb3cgb2YgbG9nLnJvd3MpIHtcbiAgICAgICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBsaW5lLmNsYXNzTmFtZSA9IGBzdC0ke3Jvdy5zdGF0dXN9YDtcbiAgICAgICAgbGluZS50ZXh0Q29udGVudCA9IGAke3Jvdy5kYXRlfSAgJHtyb3cuc3RhdHVzfSR7cm93LmRldGFpbCA/IGAgICR7cm93LmRldGFpbH1gIDogJyd9YDtcbiAgICAgICAgaG9zdC5hcHBlbmQobGluZSk7XG4gICAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiByZW5kZXJDYXB0dXJlcygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IGNhcHR1cmVzID0gW10gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgnY2FwdHVyZXMnKSBhcyB7IGNhcHR1cmVzPzogdW5rbm93bltdIH07XG4gICAgY29uc3QgaG9zdCA9IGVsPEhUTUxQcmVFbGVtZW50PignY2FwdHVyZXMnKTtcbiAgICBpZiAoY2FwdHVyZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGhvc3QudGV4dENvbnRlbnQgPSAnTm90aGluZyByZWNvcmRlZCB5ZXQuJztcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBob3N0LnRleHRDb250ZW50ID0gY2FwdHVyZXMubWFwKChjYXB0dXJlKSA9PiBKU09OLnN0cmluZ2lmeShjYXB0dXJlLCBudWxsLCAxKSkuam9pbignXFxuXFxuJyk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBsb2FkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxucmVuZGVyU2V0dGluZ3MoY3VycmVudCk7XG5yZW5kZXJQbGFuKCk7XG5yZW5kZXJBdXRvTm90ZSgpO1xucmVuZGVyRGVza1N0YXRlKCk7XG5cbmNvbnN0IHsgcnVucyA9IFtdLCBsZWFybk1vZGUgPSBmYWxzZSB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFsncnVucycsICdsZWFybk1vZGUnXSkgYXMge1xuICAgIHJ1bnM/OiBSdW5Mb2dbXTtcbiAgICBsZWFybk1vZGU/OiBib29sZWFuO1xufTtcbmZpZWxkcy5sZWFybk1vZGUuY2hlY2tlZCA9IGxlYXJuTW9kZTtcbnJlbmRlckxvZyhydW5zWzBdKTtcbmF3YWl0IHJlbmRlckNhcHR1cmVzKCk7XG5cbi8vIFx1MjUwMFx1MjUwMCBhY3Rpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiB0cmlnZ2VyUnVuKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIGRyeVJ1bjogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBidXR0b24udGV4dENvbnRlbnQ7XG4gICAgYnV0dG9uLnRleHRDb250ZW50ID0gZHJ5UnVuID8gJ0NoZWNraW5nXHUyMDI2JyA6ICdCb29raW5nXHUyMDI2JztcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBjb21taXQoKTtcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdydW4nLCBkcnlSdW4gfSkgYXMge1xuICAgICAgICAgICAgb2s6IGJvb2xlYW47XG4gICAgICAgICAgICBsb2c/OiBSdW5Mb2c7XG4gICAgICAgICAgICBlcnJvcj86IHN0cmluZztcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKHJlc3BvbnNlLm9rICYmIHJlc3BvbnNlLmxvZykge1xuICAgICAgICAgICAgcmVuZGVyTG9nKHJlc3BvbnNlLmxvZyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZW5kZXJMb2coe1xuICAgICAgICAgICAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgICAgICAgZHJ5UnVuLFxuICAgICAgICAgICAgICAgIGRhdGVzOiBbXSxcbiAgICAgICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgICAgICBub3RlczogW10sXG4gICAgICAgICAgICAgICAgZXJyb3I6IHJlc3BvbnNlLmVycm9yID8/ICdVbmtub3duIGZhaWx1cmUnLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmVuZGVyTG9nKHtcbiAgICAgICAgICAgIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgICAgICBkcnlSdW4sXG4gICAgICAgICAgICBkYXRlczogW10sXG4gICAgICAgICAgICByb3dzOiBbXSxcbiAgICAgICAgICAgIG5vdGVzOiBbXSxcbiAgICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IG9yaWdpbmFsO1xuICAgICAgICAvLyBOb3QgYGRpc2FibGVkID0gZmFsc2VgOiB3aGV0aGVyIHRoZXNlIGFyZSB1c2FibGUgaXMgcmVuZGVyRGVza1N0YXRlJ3NcbiAgICAgICAgLy8gZGVjaXNpb24sIGFuZCBhIHJ1biBkb2VzIG5vdCBjaGFuZ2UgaXQuXG4gICAgICAgIHJlbmRlckRlc2tTdGF0ZSgpO1xuICAgIH1cbn1cblxuZWw8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdydW5Ob3cnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4ge1xuICAgIHZvaWQgdHJpZ2dlclJ1bihldmVudC5jdXJyZW50VGFyZ2V0IGFzIEhUTUxCdXR0b25FbGVtZW50LCBmYWxzZSk7XG59KTtcblxuZWw8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdkcnlSdW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4ge1xuICAgIHZvaWQgdHJpZ2dlclJ1bihldmVudC5jdXJyZW50VGFyZ2V0IGFzIEhUTUxCdXR0b25FbGVtZW50LCB0cnVlKTtcbn0pO1xuXG5maWVsZHMubGVhcm5Nb2RlLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICB2b2lkIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IGxlYXJuTW9kZTogZmllbGRzLmxlYXJuTW9kZS5jaGVja2VkIH0pO1xufSk7XG5cbmVsPEhUTUxCdXR0b25FbGVtZW50PignY29weUNhcHR1cmVzJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICBjb25zdCB7IGNhcHR1cmVzID0gW10gfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgnY2FwdHVyZXMnKSBhcyB7IGNhcHR1cmVzPzogdW5rbm93bltdIH07XG4gICAgYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoSlNPTi5zdHJpbmdpZnkoY2FwdHVyZXMsIG51bGwsIDIpKTtcbiAgICBjb25zdCBidXR0b24gPSBldmVudC5jdXJyZW50VGFyZ2V0IGFzIEhUTUxCdXR0b25FbGVtZW50O1xuICAgIGNvbnN0IG9yaWdpbmFsID0gYnV0dG9uLnRleHRDb250ZW50O1xuICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9ICdDb3BpZWQnO1xuICAgIHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHsgYnV0dG9uLnRleHRDb250ZW50ID0gb3JpZ2luYWw7IH0sIDFfNDAwKTtcbn0pO1xuXG5lbDxIVE1MQnV0dG9uRWxlbWVudD4oJ2NsZWFyQ2FwdHVyZXMnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBjYXB0dXJlczogW10gfSk7XG4gICAgYXdhaXQgcmVuZGVyQ2FwdHVyZXMoKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQXFLTyxJQUFNLG1CQUE2QjtBQUFBO0FBQUE7QUFBQSxFQUd0QyxpQkFBaUI7QUFBQSxFQUNqQixTQUFTO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFJVCxVQUFVO0FBQUEsRUFDVixRQUFRO0FBQUEsRUFDUixTQUFTO0FBQUEsRUFDVCxZQUFZO0FBQUEsRUFDWixVQUFVLENBQUMsVUFBVSxXQUFXLGFBQWEsWUFBWSxRQUFRO0FBQUEsRUFDakUsTUFBTTtBQUFBLEVBQ04sYUFBYTtBQUFBLEVBQ2IsV0FBVyxDQUFDO0FBQUEsRUFDWixVQUFVO0FBQUEsRUFDVixVQUFVO0FBQUEsSUFDTixTQUFTO0FBQUEsSUFDVCxNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsSUFDdkIsU0FBUztBQUFBLE1BQ0wsUUFBUTtBQUFBLE1BQ1IsTUFBTTtBQUFBLE1BQ04sT0FBTztBQUFBLFFBQ0gsWUFBWTtBQUFBLFFBQ1osVUFBVTtBQUFBLE1BQ2Q7QUFBQSxJQUNKO0FBQUEsSUFDQSxnQkFBZ0IsQ0FBQyxRQUFRLFNBQVM7QUFBQSxJQUNsQyxjQUFjLENBQUMsUUFBUSxJQUFJO0FBQUEsSUFDM0IsbUJBQW1CO0FBQUEsSUFDbkIsd0JBQXdCLENBQUMsa0JBQWtCLGNBQWMsUUFBUSxPQUFPLE9BQU87QUFBQSxJQUMvRSxNQUFNO0FBQUEsTUFDRixRQUFRO0FBQUEsTUFDUixNQUFNO0FBQUEsTUFDTixPQUFPO0FBQUEsUUFDSCxZQUFZO0FBQUEsUUFDWixVQUFVO0FBQUEsTUFDZDtBQUFBLElBQ0o7QUFBQSxJQUNBLFVBQVU7QUFBQSxJQUNWLFdBQVc7QUFBQSxJQUNYLGdCQUFnQixDQUFDLGtCQUFrQixNQUFNO0FBQUEsSUFDekMsWUFBWTtBQUFBLElBQ1osUUFBUTtBQUFBLE1BQ0osUUFBUTtBQUFBO0FBQUE7QUFBQSxNQUdSLE1BQU07QUFBQSxNQUNOLE1BQU07QUFBQSxRQUNGLGVBQWU7QUFBQSxVQUNYLE9BQU87QUFBQSxVQUNQLGdCQUFnQjtBQUFBLFVBQ2hCLGNBQWM7QUFBQSxRQUNsQjtBQUFBLFFBQ0EsVUFBVTtBQUFBLFVBQ04sYUFBYTtBQUFBLFVBQ2IsVUFBVTtBQUFBLFVBQ1YsU0FBUztBQUFBLFFBQ2I7QUFBQSxRQUNBLGNBQWMsRUFBRSxXQUFXLGFBQWE7QUFBQSxNQUM1QztBQUFBLElBQ0o7QUFBQSxFQUNKO0FBQ0o7QUFhTyxJQUFNLFdBQVcsRUFBRSxJQUFJLE1BQU0sTUFBTSxXQUFXO0FBVzlDLElBQU0sb0JBQW9CO0FBRzFCLFNBQVMsZ0JBQWdCLE1BQXVCO0FBQ25ELFNBQU8sa0JBQWtCLEtBQUssS0FBSyxLQUFLLENBQUM7QUFDN0M7QUFFTyxJQUFNLFNBQTBDO0FBQUEsRUFDbkQsRUFBRSxJQUFJLE1BQU0sT0FBTyxVQUFVO0FBQUEsRUFDN0IsRUFBRSxJQUFJLE1BQU0sT0FBTyxVQUFVO0FBQ2pDO0FBa0RPLFNBQVMsY0FBYyxRQUFpRDtBQUMzRSxRQUFNLGdCQUFnQixRQUFRLG1CQUFtQjtBQUNqRCxRQUFNLGlCQUFpQixnQkFBZ0IsaUJBQWlCO0FBRXhELFNBQU87QUFBQSxJQUNILEdBQUc7QUFBQSxJQUNILEdBQUc7QUFBQSxJQUNILGlCQUFpQixpQkFBaUI7QUFBQSxJQUNsQyxVQUFVLGtCQUFrQixDQUFDLFFBQVEsV0FDL0IsaUJBQWlCLFdBQ2pCLE9BQU87QUFBQSxFQUNqQjtBQUNKO0FBRUEsZUFBc0IsZUFBa0M7QUFDcEQsUUFBTSxTQUFTLE1BQU0sT0FBTyxRQUFRLE1BQU0sSUFBSSxVQUFVO0FBQ3hELFNBQU8sY0FBYyxPQUFPLFFBQXlDO0FBQ3pFO0FBRUEsZUFBc0IsYUFBYSxVQUFtQztBQUNsRSxRQUFNLE9BQU8sUUFBUSxNQUFNLElBQUksRUFBRSxTQUFTLENBQUM7QUFDL0M7OztBQzFVQSxJQUFNLGdCQUFvQztBQUFBLEVBQ3RDO0FBQUEsRUFBVTtBQUFBLEVBQVU7QUFBQSxFQUFXO0FBQUEsRUFBYTtBQUFBLEVBQVk7QUFBQSxFQUFVO0FBQ3RFO0FBRUEsU0FBUyxVQUFVLE9BQWlDO0FBQ2hELFNBQVEsY0FBb0MsU0FBUyxLQUFLO0FBQzlEO0FBR08sU0FBUyxlQUFlLE1BQVksVUFBMEI7QUFDakUsU0FBTyxJQUFJLEtBQUssZUFBZSxTQUFTO0FBQUEsSUFDcEM7QUFBQSxJQUFVLE1BQU07QUFBQSxJQUFXLE9BQU87QUFBQSxJQUFXLEtBQUs7QUFBQSxFQUN0RCxDQUFDLEVBQUUsT0FBTyxJQUFJO0FBQ2xCO0FBR08sU0FBUyxhQUFhLE1BQVksVUFBMkI7QUFDaEUsUUFBTSxPQUFPLElBQUksS0FBSyxlQUFlLFNBQVMsRUFBRSxVQUFVLFNBQVMsT0FBTyxDQUFDLEVBQ3RFLE9BQU8sSUFBSSxFQUNYLFlBQVk7QUFDakIsTUFBSSxDQUFDLFVBQVUsSUFBSSxFQUFHLE9BQU0sSUFBSSxNQUFNLGtDQUFrQyxJQUFJLEdBQUc7QUFDL0UsU0FBTztBQUNYO0FBa0JPLFNBQVMsWUFBWTtBQUFBLEVBQ3hCO0FBQUEsRUFDQSxjQUFjO0FBQUEsRUFDZCxZQUFZLENBQUM7QUFBQSxFQUNiLFdBQVc7QUFBQSxFQUNYLE1BQU0sb0JBQUksS0FBSztBQUNuQixHQUFpQztBQUM3QixRQUFNLFNBQVMsb0JBQUksSUFBYTtBQUNoQyxhQUFXLE9BQU8sVUFBVTtBQUN4QixVQUFNLE9BQU8sSUFBSSxZQUFZO0FBQzdCLFFBQUksQ0FBQyxVQUFVLElBQUksRUFBRyxPQUFNLElBQUksTUFBTSx3QkFBd0IsR0FBRyxHQUFHO0FBQ3BFLFdBQU8sSUFBSSxJQUFJO0FBQUEsRUFDbkI7QUFFQSxRQUFNLE9BQU8sSUFBSSxJQUFJLFNBQVM7QUFDOUIsUUFBTSxNQUFnQixDQUFDO0FBRXZCLFdBQVMsU0FBUyxHQUFHLFVBQVUsYUFBYSxVQUFVLEdBQUc7QUFDckQsVUFBTSxNQUFNLElBQUksS0FBSyxJQUFJLFFBQVEsSUFBSSxTQUFTLEtBQVU7QUFDeEQsVUFBTSxNQUFNLGVBQWUsS0FBSyxRQUFRO0FBQ3hDLFFBQUksQ0FBQyxPQUFPLElBQUksYUFBYSxLQUFLLFFBQVEsQ0FBQyxFQUFHO0FBQzlDLFFBQUksS0FBSyxJQUFJLEdBQUcsRUFBRztBQUNuQixRQUFJLEtBQUssR0FBRztBQUFBLEVBQ2hCO0FBRUEsU0FBTztBQUNYOzs7QUN4REEsSUFBTSxPQUFrQixDQUFDLFVBQVUsV0FBVyxhQUFhLFlBQVksVUFBVSxZQUFZLFFBQVE7QUFHckcsSUFBTSxhQUFhLENBQUMsTUFBTSxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sSUFBSTtBQUU1RCxTQUFTLEdBQTBCLElBQWU7QUFDOUMsUUFBTSxPQUFPLFNBQVMsZUFBZSxFQUFFO0FBQ3ZDLE1BQUksQ0FBQyxLQUFNLE9BQU0sSUFBSSxNQUFNLG9CQUFvQixFQUFFLEVBQUU7QUFDbkQsU0FBTztBQUNYO0FBRUEsSUFBTSxTQUFTO0FBQUEsRUFDWCxTQUFTLEdBQXFCLFNBQVM7QUFBQSxFQUN2QyxVQUFVLEdBQXFCLFVBQVU7QUFBQSxFQUN6QyxRQUFRLEdBQXFCLFFBQVE7QUFBQSxFQUNyQyxTQUFTLEdBQXNCLFNBQVM7QUFBQSxFQUN4QyxNQUFNLEdBQXNCLE1BQU07QUFBQSxFQUNsQyxhQUFhLEdBQXFCLGFBQWE7QUFBQSxFQUMvQyxVQUFVLEdBQXFCLFVBQVU7QUFBQSxFQUN6QyxVQUFVLEdBQXdCLFVBQVU7QUFBQSxFQUM1QyxXQUFXLEdBQXFCLFdBQVc7QUFDL0M7QUFHQSxHQUFvQixjQUFjLEVBQUUsY0FBYyxTQUFTO0FBRTNELFdBQVcsU0FBUyxRQUFRO0FBQ3hCLFFBQU0sU0FBUyxTQUFTLGNBQWMsUUFBUTtBQUM5QyxTQUFPLFFBQVEsT0FBTyxNQUFNLEVBQUU7QUFDOUIsU0FBTyxjQUFjLE1BQU07QUFDM0IsU0FBTyxRQUFRLE9BQU8sTUFBTTtBQUNoQztBQUdBLElBQU0sV0FBVyxHQUFtQixNQUFNO0FBQzFDLFdBQVcsT0FBTyxNQUFNO0FBQ3BCLFFBQU0sUUFBUSxTQUFTLGNBQWMsT0FBTztBQUM1QyxRQUFNLE1BQU0sU0FBUyxjQUFjLE9BQU87QUFDMUMsTUFBSSxPQUFPO0FBQ1gsTUFBSSxRQUFRO0FBQ1osTUFBSSxRQUFRLE1BQU07QUFDbEIsUUFBTSxPQUFPLEtBQUssU0FBUyxlQUFlLElBQUksTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzFELFdBQVMsT0FBTyxLQUFLO0FBQ3pCO0FBRUEsU0FBUyxlQUEwQjtBQUMvQixTQUFPLENBQUMsR0FBRyxTQUFTLGlCQUFtQyxlQUFlLENBQUMsRUFDbEUsSUFBSSxDQUFDLFFBQVEsSUFBSSxLQUFnQjtBQUMxQztBQUtBLElBQUksVUFBb0IsTUFBTSxhQUFhO0FBRTNDLFNBQVMsZUFBZSxNQUFzQjtBQUMxQyxTQUFPLFFBQVEsVUFBVSxLQUFLO0FBQzlCLFNBQU8sU0FBUyxRQUFRLEtBQUs7QUFDN0IsU0FBTyxPQUFPLFFBQVEsS0FBSztBQUMzQixTQUFPLFFBQVEsUUFBUSxPQUFPLEtBQUssT0FBTztBQUMxQyxTQUFPLEtBQUssUUFBUSxLQUFLO0FBQ3pCLFNBQU8sWUFBWSxRQUFRLE9BQU8sS0FBSyxXQUFXO0FBQ2xELFNBQU8sU0FBUyxRQUFRLEtBQUs7QUFDN0IsU0FBTyxTQUFTLFFBQVEsS0FBSyxVQUFVLEtBQUssVUFBVSxNQUFNLENBQUM7QUFDN0QsS0FBb0IsZUFBZSxFQUFFLGNBQWMsS0FBSztBQUN4RCxhQUFXLE9BQU8sU0FBUyxpQkFBbUMsT0FBTyxHQUFHO0FBQ3BFLFFBQUksVUFBVSxLQUFLLFNBQVMsU0FBUyxJQUFJLEtBQWdCO0FBQUEsRUFDN0Q7QUFDSjtBQVNBLFNBQVMsVUFBMEQ7QUFDL0QsTUFBSSxXQUEyQixRQUFRO0FBQ3ZDLE1BQUk7QUFDSixNQUFJO0FBQ0EsZUFBVyxLQUFLLE1BQU0sT0FBTyxTQUFTLEtBQUs7QUFBQSxFQUMvQyxTQUFTLEtBQUs7QUFDVixvQkFBZ0Isc0NBQXVDLElBQWMsT0FBTztBQUFBLEVBQ2hGO0FBRUEsU0FBTztBQUFBLElBQ0gsVUFBVTtBQUFBO0FBQUE7QUFBQSxNQUdOLGlCQUFpQixRQUFRO0FBQUEsTUFDekIsU0FBUyxPQUFPLFFBQVE7QUFBQSxNQUNwQixVQUFVLE9BQU8sU0FBUyxNQUFNLEtBQUs7QUFBQSxNQUN6QyxRQUFRLE9BQU8sT0FBTyxNQUFNLEtBQUs7QUFBQSxNQUNqQyxTQUFTLE9BQU8sT0FBTyxRQUFRLEtBQUssS0FBSyxpQkFBaUI7QUFBQTtBQUFBLE1BRTFELFlBQVksU0FBUztBQUFBLE1BQ3JCLFVBQVUsYUFBYTtBQUFBLE1BQ3ZCLE1BQU0sT0FBTyxLQUFLO0FBQUEsTUFDbEIsYUFBYSxPQUFPLE9BQU8sWUFBWSxLQUFLLEtBQUssaUJBQWlCO0FBQUE7QUFBQSxNQUVsRSxXQUFXLFFBQVE7QUFBQSxNQUNuQixVQUFVLE9BQU8sU0FBUyxNQUFNLEtBQUssS0FBSyxpQkFBaUI7QUFBQSxNQUMzRDtBQUFBLElBQ0o7QUFBQSxJQUNBO0FBQUEsRUFDSjtBQUNKO0FBSUEsSUFBTSxNQUFNLENBQUMsVUFBMEIsT0FBTyxLQUFLLEVBQUUsU0FBUyxHQUFHLEdBQUc7QUFDcEUsSUFBTSxTQUFTLENBQUMsTUFBYyxPQUFlLFFBQ3pDLEdBQUcsSUFBSSxJQUFJLElBQUksUUFBUSxDQUFDLENBQUMsSUFBSSxJQUFJLEdBQUcsQ0FBQztBQVN6QyxTQUFTLGFBQW1CO0FBQ3hCLFFBQU0sT0FBTyxHQUFtQixVQUFVO0FBQzFDLE9BQUssY0FBYztBQUVuQixRQUFNLFFBQVEsZUFBZSxvQkFBSSxLQUFLLEdBQUcsUUFBUSxRQUFRO0FBQ3pELFFBQU0sQ0FBQyxXQUFXLFVBQVUsSUFBSSxNQUFNLE1BQU0sR0FBRyxFQUFFLElBQUksTUFBTTtBQUkzRCxNQUFJO0FBQ0osTUFBSTtBQUNBLGlCQUFhLElBQUksSUFBSSxZQUFZO0FBQUEsTUFDN0IsVUFBVSxRQUFRO0FBQUEsTUFDbEIsYUFBYSxRQUFRO0FBQUEsTUFDckIsV0FBVyxDQUFDO0FBQUEsTUFDWixVQUFVLFFBQVE7QUFBQSxJQUN0QixDQUFDLENBQUM7QUFBQSxFQUNOLFFBQVE7QUFDSixpQkFBYSxvQkFBSSxJQUFJO0FBQUEsRUFDekI7QUFDQSxRQUFNLFVBQVUsSUFBSSxJQUFJLFFBQVEsU0FBUztBQUV6QyxXQUFTLFNBQVMsR0FBRyxTQUFTLEdBQUcsVUFBVSxHQUFHO0FBQzFDLFVBQU0sUUFBUSxhQUFhLElBQUk7QUFDL0IsVUFBTSxPQUFPLFlBQVksS0FBSyxNQUFNLFFBQVEsRUFBRTtBQUM5QyxVQUFNLGNBQWUsUUFBUSxLQUFNLE1BQU07QUFFekMsVUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFVBQU0sWUFBWTtBQUVsQixVQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsU0FBSyxZQUFZO0FBQ2pCLFNBQUssY0FBYyxJQUFJLEtBQUssS0FBSyxJQUFJLE1BQU0sWUFBWSxDQUFDLENBQUMsRUFDcEQsbUJBQW1CLFFBQVcsRUFBRSxPQUFPLFFBQVEsTUFBTSxXQUFXLFVBQVUsTUFBTSxDQUFDO0FBQ3RGLFVBQU0sT0FBTyxJQUFJO0FBRWpCLFVBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxTQUFLLFlBQVk7QUFDakIsZUFBVyxTQUFTLFlBQVk7QUFDNUIsWUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLFdBQUssWUFBWTtBQUNqQixXQUFLLGNBQWM7QUFDbkIsV0FBSyxPQUFPLElBQUk7QUFBQSxJQUNwQjtBQUVBLFVBQU0saUJBQWlCLElBQUksS0FBSyxLQUFLLElBQUksTUFBTSxZQUFZLENBQUMsQ0FBQyxFQUFFLFVBQVU7QUFFekUsVUFBTSxRQUFRLGlCQUFpQixLQUFLO0FBQ3BDLGFBQVMsUUFBUSxHQUFHLFFBQVEsTUFBTSxTQUFTLEVBQUcsTUFBSyxPQUFPLFNBQVMsY0FBYyxLQUFLLENBQUM7QUFFdkYsVUFBTSxjQUFjLElBQUksS0FBSyxLQUFLLElBQUksTUFBTSxhQUFhLEdBQUcsQ0FBQyxDQUFDLEVBQUUsV0FBVztBQUMzRSxhQUFTLE1BQU0sR0FBRyxPQUFPLGFBQWEsT0FBTyxHQUFHO0FBQzVDLFlBQU0sTUFBTSxPQUFPLE1BQU0sWUFBWSxHQUFHO0FBQ3hDLFlBQU0sT0FBTyxTQUFTLGNBQWMsUUFBUTtBQUM1QyxXQUFLLFlBQVk7QUFDakIsV0FBSyxjQUFjLE9BQU8sR0FBRztBQUM3QixXQUFLLE9BQU87QUFFWixVQUFJLE1BQU0sTUFBTyxNQUFLLFVBQVUsSUFBSSxNQUFNO0FBQzFDLFVBQUksUUFBUSxNQUFPLE1BQUssVUFBVSxJQUFJLE9BQU87QUFFN0MsVUFBSSxXQUFXLElBQUksR0FBRyxHQUFHO0FBQ3JCLGFBQUssVUFBVSxJQUFJLFFBQVEsSUFBSSxHQUFHLElBQUksU0FBUyxRQUFRLFdBQVc7QUFDbEUsYUFBSyxRQUFRLFFBQVEsSUFBSSxHQUFHLElBQUksb0NBQStCO0FBQy9ELGFBQUssaUJBQWlCLFNBQVMsTUFBTTtBQUNqQyxrQkFBUSxZQUFZLFFBQVEsSUFBSSxHQUFHLElBQzdCLFFBQVEsVUFBVSxPQUFPLENBQUMsVUFBVSxVQUFVLEdBQUcsSUFDakQsQ0FBQyxHQUFHLFFBQVEsV0FBVyxHQUFHLEVBQUUsS0FBSztBQUN2QyxxQkFBVztBQUNYLG9CQUFVO0FBQUEsUUFDZCxDQUFDO0FBQUEsTUFDTDtBQUVBLFdBQUssT0FBTyxJQUFJO0FBQUEsSUFDcEI7QUFFQSxVQUFNLE9BQU8sSUFBSTtBQUNqQixTQUFLLE9BQU8sS0FBSztBQUFBLEVBQ3JCO0FBQ0o7QUFVQSxTQUFTLGtCQUF3QjtBQUM3QixRQUFNLE1BQU0sT0FBTyxTQUFTLE1BQU0sS0FBSztBQUN2QyxRQUFNLE9BQU8sR0FBeUIsVUFBVTtBQUNoRCxRQUFNLFFBQVEsZ0JBQWdCLEdBQUc7QUFFakMsTUFBSSxRQUFRLElBQUk7QUFDWixTQUFLLGNBQWM7QUFDbkIsU0FBSyxVQUFVLE9BQU8sS0FBSztBQUMzQixXQUFPLFNBQVMsVUFBVSxPQUFPLEtBQUs7QUFBQSxFQUMxQyxXQUFXLE9BQU87QUFDZCxTQUFLLGNBQWM7QUFDbkIsU0FBSyxVQUFVLE9BQU8sS0FBSztBQUMzQixXQUFPLFNBQVMsVUFBVSxPQUFPLEtBQUs7QUFBQSxFQUMxQyxPQUFPO0FBQ0gsU0FBSyxjQUFjLElBQUksR0FBRztBQUMxQixTQUFLLFVBQVUsSUFBSSxLQUFLO0FBQ3hCLFdBQU8sU0FBUyxVQUFVLElBQUksS0FBSztBQUFBLEVBQ3ZDO0FBSUEsUUFBTSxXQUFXLFNBQVMsT0FBTyxPQUFPLE1BQU0sS0FBSyxNQUFNO0FBQ3pELGFBQVcsTUFBTSxDQUFDLFVBQVUsUUFBUSxHQUFHO0FBQ25DLE9BQXNCLEVBQUUsRUFBRSxXQUFXLENBQUM7QUFBQSxFQUMxQztBQUNKO0FBRUEsU0FBUyxpQkFBdUI7QUFDNUIsUUFBTSxPQUFPLEdBQXlCLFVBQVU7QUFDaEQsT0FBSyxjQUFjLFFBQVEsVUFDckIsa0VBQWtFLFFBQVEsV0FBVyxpR0FFckY7QUFDVjtBQUlBLFNBQVMsV0FBVyxPQUFPLFNBQWU7QUFDdEMsUUFBTSxPQUFPLEdBQW9CLFdBQVc7QUFDNUMsT0FBSyxjQUFjO0FBQ25CLE9BQUssU0FBUztBQUNkLFNBQU8sV0FBVyxNQUFNO0FBQUUsU0FBSyxTQUFTO0FBQUEsRUFBTSxHQUFHLElBQUs7QUFDMUQ7QUFFQSxJQUFJO0FBT0osU0FBUyxZQUFrQjtBQUN2QixTQUFPLGFBQWEsU0FBUztBQUM3QixjQUFZLE9BQU8sV0FBVyxNQUFNO0FBQUUsU0FBSyxPQUFPO0FBQUEsRUFBRyxHQUFHLEdBQUc7QUFDL0Q7QUFFQSxlQUFlLFNBQXdCO0FBQ25DLFFBQU0sRUFBRSxVQUFVLGNBQWMsSUFBSSxRQUFRO0FBQzVDLFlBQVU7QUFDVixRQUFNLGFBQWEsUUFBUTtBQUMzQixhQUFXO0FBQ1gsaUJBQWU7QUFDZixrQkFBZ0I7QUFDaEIsYUFBVyxnQkFBZ0IsMkNBQXNDLE9BQU87QUFDNUU7QUFFQSxXQUFXLFNBQVM7QUFBQSxFQUNoQixPQUFPO0FBQUEsRUFBUyxPQUFPO0FBQUEsRUFBVSxPQUFPO0FBQUEsRUFBUSxPQUFPO0FBQUEsRUFDdkQsT0FBTztBQUFBLEVBQU0sT0FBTztBQUFBLEVBQWEsT0FBTztBQUFBLEVBQVUsT0FBTztBQUM3RCxHQUFHO0FBQ0MsUUFBTSxpQkFBaUIsVUFBVSxTQUFTO0FBQzFDLFFBQU0saUJBQWlCLFNBQVMsU0FBUztBQUM3QztBQUlBLFdBQVcsU0FBUyxDQUFDLE9BQU8sVUFBVSxPQUFPLE1BQU0sR0FBRztBQUNsRCxRQUFNLGlCQUFpQixTQUFTLGVBQWU7QUFDbkQ7QUFDQSxTQUFTLGlCQUFpQixVQUFVLFNBQVM7QUFJN0MsU0FBUyxVQUFVLEtBQStCO0FBQzlDLFFBQU0sT0FBTyxHQUFtQixLQUFLO0FBQ3JDLE9BQUssY0FBYztBQUNuQixNQUFJLENBQUMsS0FBSztBQUNOLFNBQUssY0FBYztBQUNuQjtBQUFBLEVBQ0o7QUFFQSxRQUFNLE9BQU8sSUFBSSxLQUFLLElBQUksRUFBRSxFQUFFLGVBQWU7QUFDN0MsUUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLE9BQUssY0FBYyxHQUFHLElBQUksR0FBRyxJQUFJLFNBQVMsMENBQXFDLEVBQUU7QUFDakYsT0FBSyxPQUFPLElBQUk7QUFFaEIsTUFBSSxJQUFJLE9BQU87QUFDWCxVQUFNLFVBQVUsU0FBUyxjQUFjLEtBQUs7QUFDNUMsWUFBUSxZQUFZO0FBQ3BCLFlBQVEsY0FBYyxVQUFVLElBQUksS0FBSztBQUN6QyxTQUFLLE9BQU8sT0FBTztBQUFBLEVBQ3ZCO0FBRUEsYUFBVyxRQUFRLElBQUksT0FBTztBQUMxQixVQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsU0FBSyxZQUFZO0FBQ2pCLFNBQUssY0FBYyxRQUFLLElBQUk7QUFDNUIsU0FBSyxPQUFPLElBQUk7QUFBQSxFQUNwQjtBQUVBLGFBQVcsT0FBTyxJQUFJLE1BQU07QUFDeEIsVUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLFNBQUssWUFBWSxNQUFNLElBQUksTUFBTTtBQUNqQyxTQUFLLGNBQWMsR0FBRyxJQUFJLElBQUksS0FBSyxJQUFJLE1BQU0sR0FBRyxJQUFJLFNBQVMsS0FBSyxJQUFJLE1BQU0sS0FBSyxFQUFFO0FBQ25GLFNBQUssT0FBTyxJQUFJO0FBQUEsRUFDcEI7QUFDSjtBQUVBLGVBQWUsaUJBQWdDO0FBQzNDLFFBQU0sRUFBRSxXQUFXLENBQUMsRUFBRSxJQUFJLE1BQU0sT0FBTyxRQUFRLE1BQU0sSUFBSSxVQUFVO0FBQ25FLFFBQU0sT0FBTyxHQUFtQixVQUFVO0FBQzFDLE1BQUksU0FBUyxXQUFXLEdBQUc7QUFDdkIsU0FBSyxjQUFjO0FBQ25CO0FBQUEsRUFDSjtBQUNBLE9BQUssY0FBYyxTQUFTLElBQUksQ0FBQyxZQUFZLEtBQUssVUFBVSxTQUFTLE1BQU0sQ0FBQyxDQUFDLEVBQUUsS0FBSyxNQUFNO0FBQzlGO0FBR0EsZUFBZSxPQUFPO0FBQ3RCLFdBQVc7QUFDWCxlQUFlO0FBQ2YsZ0JBQWdCO0FBRWhCLElBQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxZQUFZLE1BQU0sSUFBSSxNQUFNLE9BQU8sUUFBUSxNQUFNLElBQUksQ0FBQyxRQUFRLFdBQVcsQ0FBQztBQUk3RixPQUFPLFVBQVUsVUFBVTtBQUMzQixVQUFVLEtBQUssQ0FBQyxDQUFDO0FBQ2pCLE1BQU0sZUFBZTtBQUlyQixlQUFlLFdBQVcsUUFBMkIsUUFBZ0M7QUFDakYsU0FBTyxXQUFXO0FBQ2xCLFFBQU0sV0FBVyxPQUFPO0FBQ3hCLFNBQU8sY0FBYyxTQUFTLG1CQUFjO0FBQzVDLE1BQUk7QUFDQSxVQUFNLE9BQU87QUFDYixVQUFNLFdBQVcsTUFBTSxPQUFPLFFBQVEsWUFBWSxFQUFFLE1BQU0sT0FBTyxPQUFPLENBQUM7QUFLekUsUUFBSSxTQUFTLE1BQU0sU0FBUyxLQUFLO0FBQzdCLGdCQUFVLFNBQVMsR0FBRztBQUFBLElBQzFCLE9BQU87QUFDSCxnQkFBVTtBQUFBLFFBQ04sS0FBSSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLFFBQzNCO0FBQUEsUUFDQSxPQUFPLENBQUM7QUFBQSxRQUNSLE1BQU0sQ0FBQztBQUFBLFFBQ1AsT0FBTyxDQUFDO0FBQUEsUUFDUixPQUFPLFNBQVMsU0FBUztBQUFBLE1BQzdCLENBQUM7QUFBQSxJQUNMO0FBQUEsRUFDSixTQUFTLEtBQUs7QUFDVixjQUFVO0FBQUEsTUFDTixLQUFJLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsTUFDM0I7QUFBQSxNQUNBLE9BQU8sQ0FBQztBQUFBLE1BQ1IsTUFBTSxDQUFDO0FBQUEsTUFDUCxPQUFPLENBQUM7QUFBQSxNQUNSLE9BQU8sZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFBQSxJQUMxRCxDQUFDO0FBQUEsRUFDTCxVQUFFO0FBQ0UsV0FBTyxjQUFjO0FBR3JCLG9CQUFnQjtBQUFBLEVBQ3BCO0FBQ0o7QUFFQSxHQUFzQixRQUFRLEVBQUUsaUJBQWlCLFNBQVMsQ0FBQyxVQUFVO0FBQ2pFLE9BQUssV0FBVyxNQUFNLGVBQW9DLEtBQUs7QUFDbkUsQ0FBQztBQUVELEdBQXNCLFFBQVEsRUFBRSxpQkFBaUIsU0FBUyxDQUFDLFVBQVU7QUFDakUsT0FBSyxXQUFXLE1BQU0sZUFBb0MsSUFBSTtBQUNsRSxDQUFDO0FBRUQsT0FBTyxVQUFVLGlCQUFpQixVQUFVLE1BQU07QUFDOUMsT0FBSyxPQUFPLFFBQVEsTUFBTSxJQUFJLEVBQUUsV0FBVyxPQUFPLFVBQVUsUUFBUSxDQUFDO0FBQ3pFLENBQUM7QUFFRCxHQUFzQixjQUFjLEVBQUUsaUJBQWlCLFNBQVMsT0FBTyxVQUFVO0FBQzdFLFFBQU0sRUFBRSxXQUFXLENBQUMsRUFBRSxJQUFJLE1BQU0sT0FBTyxRQUFRLE1BQU0sSUFBSSxVQUFVO0FBQ25FLFFBQU0sVUFBVSxVQUFVLFVBQVUsS0FBSyxVQUFVLFVBQVUsTUFBTSxDQUFDLENBQUM7QUFDckUsUUFBTSxTQUFTLE1BQU07QUFDckIsUUFBTSxXQUFXLE9BQU87QUFDeEIsU0FBTyxjQUFjO0FBQ3JCLFNBQU8sV0FBVyxNQUFNO0FBQUUsV0FBTyxjQUFjO0FBQUEsRUFBVSxHQUFHLElBQUs7QUFDckUsQ0FBQztBQUVELEdBQXNCLGVBQWUsRUFBRSxpQkFBaUIsU0FBUyxZQUFZO0FBQ3pFLFFBQU0sT0FBTyxRQUFRLE1BQU0sSUFBSSxFQUFFLFVBQVUsQ0FBQyxFQUFFLENBQUM7QUFDL0MsUUFBTSxlQUFlO0FBQ3pCLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
