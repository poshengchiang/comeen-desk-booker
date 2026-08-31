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
        const state = skipped.has(iso) ? "skip" : outcome.get(iso) ?? (planned ? "book" : "later");
        cell.classList.add(state, "clickable");
        cell.title = {
          skip: "Skipped \u2014 click to book it",
          have: "You already have this day. Clicking stops future runs re-booking it; it does not cancel the booking in Comeen.",
          taken: "Someone else has this desk that day. Clicking stops it being retried.",
          failed: "The last attempt failed on this day. Open Last run for the reason.",
          book: "Click to skip",
          later: "Beyond the booking window for now. Click to skip it in advance \u2014 it will be remembered when the window reaches it."
        }[state] ?? "Click to skip";
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
el("clearCaptures").addEventListener("click", async () => {
  await chrome.storage.local.set({ captures: [] });
  await renderCaptures();
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvcmUvY29uZmlnLnRzIiwgIi4uL3NyYy9jb3JlL2RhdGVzLnRzIiwgIi4uL3NyYy9wb3B1cC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBXZWVrZGF5IH0gZnJvbSAnLi9kYXRlcy5qcyc7XG5cbmV4cG9ydCB0eXBlIFNsb3QgPSAnYWxsX2RheScgfCAnbW9ybmluZycgfCAnYWZ0ZXJub29uJztcblxuLyoqXG4gKiBIb3cgdGhlIGluLXBhZ2UgY29kZSBzaG91bGQgYXV0aGVudGljYXRlLlxuICpcbiAqIGBjb29raWVgICAgICAgIC0ganVzdCBzZW5kIGNyZWRlbnRpYWxzIHdpdGggdGhlIHJlcXVlc3QuIENvcnJlY3QgaWYgQ29tZWVuXG4gKiAgICAgICAgICAgICAgICAgIGF1dGhlbnRpY2F0ZXMgd2l0aCBhIHNlc3Npb24gY29va2llLlxuICogYGxvY2FsU3RvcmFnZWAgLSByZWFkIGEgdG9rZW4gb3V0IG9mIHRoZSBwYWdlJ3Mgb3duIGxvY2FsU3RvcmFnZSBhbmQgcHV0IGl0XG4gKiAgICAgICAgICAgICAgICAgIGluIGEgaGVhZGVyLiBDb3JyZWN0IGlmIENvbWVlbiB1c2VzIGEgYmVhcmVyIHRva2VuLlxuICpcbiAqIEVpdGhlciB3YXkgdGhlIHZhbHVlIGlzIHJlYWQgaW5zaWRlIHRoZSBwYWdlIGFuZCB1c2VkIHRoZXJlLiBJdCBpcyBuZXZlclxuICogY29waWVkIGludG8gZXh0ZW5zaW9uIHN0b3JhZ2UsIG5ldmVyIHBlcnNpc3RlZCwgYW5kIG5ldmVyIGxlYXZlcyB0aGUgdGFiLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhDb25maWcge1xuICAgIG1vZGU6ICdjb29raWUnIHwgJ2xvY2FsU3RvcmFnZSc7XG4gICAgLyoqIGxvY2FsU3RvcmFnZSBrZXkgaG9sZGluZyB0aGUgdG9rZW4uICovXG4gICAgc3RvcmFnZUtleT86IHN0cmluZztcbiAgICAvKiogRG90dGVkIHBhdGggaW5zaWRlIHRoZSBwYXJzZWQgSlNPTiwgZS5nLiBgc3RzVG9rZW5NYW5hZ2VyLmFjY2Vzc1Rva2VuYCAqL1xuICAgIGpzb25QYXRoPzogc3RyaW5nO1xuICAgIC8qKiBIZWFkZXIgdG8gc2V0LCBkZWZhdWx0IGBhdXRob3JpemF0aW9uYCAqL1xuICAgIGhlYWRlcj86IHN0cmluZztcbiAgICAvKiogUHJlZml4IGJlZm9yZSB0aGUgdG9rZW4sIGRlZmF1bHQgYEJlYXJlciBgICovXG4gICAgcHJlZml4Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlcXVlc3RUZW1wbGF0ZSB7XG4gICAgbWV0aG9kOiAnR0VUJyB8ICdQT1NUJyB8ICdQVVQnO1xuICAgIC8qKiBQYXRoIGFwcGVuZGVkIHRvIGFwaUJhc2UuIE1heSBjb250YWluIHBsYWNlaG9sZGVycy4gKi9cbiAgICBwYXRoOiBzdHJpbmc7XG4gICAgcXVlcnk/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgIGJvZHk/OiB1bmtub3duO1xufVxuXG4vKipcbiAqIEhvdyB0aGUgXCJ3aGF0IGRvIEkgYWxyZWFkeSBob2xkXCIgcmVzcG9uc2UgaXMgbGFpZCBvdXQuXG4gKlxuICogYGFycmF5YCAgICAgICAgLSBhIGZsYXQgbGlzdCBvZiBib29raW5ncywgZWFjaCBjYXJyeWluZyBpdHMgb3duIGRhdGUgZmllbGQsXG4gKiAgICAgICAgICAgICAgICAgIHJlYWQgdmlhIGBsaXN0RGF0ZUZpZWxkc2AuXG4gKiBgZGF0ZUtleWVkTWFwYCAtIGFuIG9iamVjdCBrZXllZCBieSBgWVlZWS1NTS1ERGAgd2hvc2UgdmFsdWVzIGFyZSB0aGF0IGRheSdzXG4gKiAgICAgICAgICAgICAgICAgIGVudHJpZXMuIENvbWVlbiByZXR1cm5zIHRoaXMgb25lLiBUaGUgZGF0ZSBpcyB0aGUgKmtleSosIG5vdFxuICogICAgICAgICAgICAgICAgICBhIGZpZWxkLCBzbyBubyBhbW91bnQgb2Ygc25pZmZpbmcgZmllbGQgbmFtZXMgd291bGQgZmluZCBpdCBcdTIwMTRcbiAqICAgICAgICAgICAgICAgICAgd2hpY2ggaXMgZXhhY3RseSB3aHkgdGhlIHNoYXBlIGlzIGNvbmZpZ3VyYXRpb24gcmF0aGVyIHRoYW5cbiAqICAgICAgICAgICAgICAgICAgc29tZXRoaW5nIHRoZSBpbi1wYWdlIGNvZGUgZ3Vlc3Nlcy5cbiAqL1xuZXhwb3J0IHR5cGUgTGlzdFNoYXBlID0gJ2FycmF5JyB8ICdkYXRlS2V5ZWRNYXAnO1xuXG4vKipcbiAqIFRoZSB3aG9sZSBBUEkgY29udHJhY3QgbGl2ZXMgaGVyZSBhcyBkYXRhIHNvIGl0IGNhbiBiZSBjb3JyZWN0ZWQgZnJvbSB0aGVcbiAqIHBvcHVwIHdpdGhvdXQgcmVidWlsZGluZy4gUGxhY2Vob2xkZXJzIGF2YWlsYWJsZSB0byBwYXRocywgcXVlcmllcyBhbmRcbiAqIGJvZGllczoge3tkYXRlfX0sIHt7ZGVza0lkfX0sIHt7ZGVza05hbWV9fSwge3tzbG90fX0sIHt7c3RhcnRUaW1lfX0sXG4gKiB7e2VuZFRpbWV9fSwge3tmcm9tfX0sIHt7dG99fSwge3t1c2VySWR9fSwge3tmbG9vcklkfX0sIHt7YnVpbGRpbmdJZH19LFxuICoge3thcmVhSWR9fS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBFbmRwb2ludENvbmZpZyB7XG4gICAgYXBpQmFzZTogc3RyaW5nO1xuICAgIGF1dGg6IEF1dGhDb25maWc7XG4gICAgLyoqXG4gICAgICogTG9vayBhIGRlc2sgdXAgYnkgaXRzIGh1bWFuIG5hbWUgc28gbm9ib2R5IGhhcyB0byBrbm93IGl0cyBpbnRlcm5hbCBpZC5cbiAgICAgKiBTZXQgdG8gbnVsbCBvbmx5IGlmIHlvdXIgQ29tZWVuIGhhcyBubyBkZXNrLXNlYXJjaCBlbmRwb2ludC5cbiAgICAgKi9cbiAgICByZXNvbHZlOiBSZXF1ZXN0VGVtcGxhdGUgfCBudWxsO1xuICAgIC8qKiBGaWVsZCBuYW1lcyB0aGF0IG1pZ2h0IGhvbGQgYSBkZXNrJ3MgaHVtYW4gbGFiZWwgaW4gYSBzZWFyY2ggcmVzdWx0LiAqL1xuICAgIGRlc2tOYW1lRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKiogRmllbGQgbmFtZXMgdGhhdCBtaWdodCBob2xkIGEgZGVzaydzIGludGVybmFsIGlkLiBDb21lZW4gdXNlcyBgdXVpZGAuICovXG4gICAgZGVza0lkRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKipcbiAgICAgKiBGaWVsZCBvbiBhIGRlc2sgcmVjb3JkIGhvbGRpbmcgdGhhdCBkZXNrJ3Mgb3duIGJvb2tpbmdzIGZvciB0aGUgcXVlcmllZFxuICAgICAqIHdpbmRvdy4gVXNlZCB0byB0ZWxsIHlvdSBhIGRheSBpcyBhbHJlYWR5IHRha2VuICpiZWZvcmUqIHlvdSBwcmVzcyBCb29rXG4gICAgICogbm93LiBTZXQgdG8gJycgdG8gZGlzYWJsZS5cbiAgICAgKi9cbiAgICBkZXNrU2NoZWR1bGVGaWVsZDogc3RyaW5nO1xuICAgIC8qKlxuICAgICAqIERhdGUgZmllbGRzIHRvIHJlYWQgb2ZmIG9uZSBvZiB0aG9zZSBlbnRyaWVzLCBpbiBwcmlvcml0eSBvcmRlciwgZmlyc3RcbiAgICAgKiBtYXRjaCB3aW5zLlxuICAgICAqXG4gICAgICogVGhlIG9yZGVyIG1hdHRlcnMgbW9yZSB0aGFuIGl0IGxvb2tzOiBhbiBlbnRyeSBhbG1vc3QgY2VydGFpbmx5IGFsc29cbiAgICAgKiBjYXJyaWVzIGNyZWF0ZWRfYXQgYW5kIHVwZGF0ZWRfYXQsIHdoaWNoIGFyZSB3aGVuIHRoZSBib29raW5nIHdhcyBtYWRlLFxuICAgICAqIG5vdCB0aGUgZGF5IGJvb2tlZC4gTGlzdGluZyBvbmx5IHRoZSBmaWVsZHMgdGhhdCBtZWFuIFwidGhlIGRheSB0aGlzIGlzXG4gICAgICogZm9yXCIgaXMgd2hhdCBzdG9wcyBhIGJvb2tpbmcgbWFkZSB0aHJlZSB3ZWVrcyBhZ28gZnJvbSBtYXJraW5nIHRocmVlXG4gICAgICogd2Vla3MgYWdvIGFzIHRha2VuLlxuICAgICAqL1xuICAgIGRlc2tTY2hlZHVsZURhdGVGaWVsZHM6IHN0cmluZ1tdO1xuICAgIC8qKiBTZXQgdG8gbnVsbCB0byBza2lwIHRoZSBcIndoYXQgZG8gSSBhbHJlYWR5IGhhdmVcIiBjaGVjay4gKi9cbiAgICBsaXN0OiBSZXF1ZXN0VGVtcGxhdGUgfCBudWxsO1xuICAgIC8qKiBEb3R0ZWQgcGF0aCB0byB0aGUgY29udGFpbmVyIGluc2lkZSB0aGUgbGlzdCByZXNwb25zZS4gJycgbWVhbnMgcm9vdC4gKi9cbiAgICBsaXN0Um9vdDogc3RyaW5nO1xuICAgIGxpc3RTaGFwZTogTGlzdFNoYXBlO1xuICAgIC8qKiBPbmx5IGNvbnN1bHRlZCB3aGVuIGxpc3RTaGFwZSBpcyAnYXJyYXknLiAqL1xuICAgIGxpc3REYXRlRmllbGRzOiBzdHJpbmdbXTtcbiAgICAvKipcbiAgICAgKiBEb3R0ZWQgcGF0aCB0byB0aGUgc2lnbmVkLWluIHVzZXIncyBpZCBpbnNpZGUgdGhlIGxpc3QgcmVzcG9uc2UuIEVtcHR5XG4gICAgICogZGlzYWJsZXMgdGhlIGxvb2t1cCwgYW5kIHt7dXNlcklkfX0gdGhlbiBzdGF5cyB1bmZpbGxlZC5cbiAgICAgKi9cbiAgICB1c2VySWRQYXRoOiBzdHJpbmc7XG4gICAgY3JlYXRlOiBSZXF1ZXN0VGVtcGxhdGU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ3Mge1xuICAgIC8qKlxuICAgICAqIEJ1bXBlZCBpbiBERUZBVUxUX1NFVFRJTkdTIHdoZW5ldmVyIHRoZSBzaGlwcGVkIGVuZHBvaW50IGNvbmZpZyBpc1xuICAgICAqIGNvcnJlY3RlZC4gU2VlIG1lcmdlU2V0dGluZ3M6IGEgc3RvcmVkIGNvbmZpZyBvbGRlciB0aGFuIHRoZSBzaGlwcGVkIG9uZVxuICAgICAqIGlzIHJlcGxhY2VkIHJhdGhlciB0aGFuIG1lcmdlZCwgd2hpY2ggaXMgd2hhdCBsZXRzIGEgZml4IGFjdHVhbGx5IHJlYWNoXG4gICAgICogcGVvcGxlIHdobyBoYXZlIGFscmVhZHkgc2F2ZWQgc2V0dGluZ3Mgb25jZS5cbiAgICAgKi9cbiAgICBlbmRwb2ludFZlcnNpb246IG51bWJlcjtcbiAgICBlbmFibGVkOiBib29sZWFuO1xuICAgIGRlc2tOYW1lOiBzdHJpbmc7XG4gICAgZGVza0lkOiBzdHJpbmc7XG4gICAgLyoqXG4gICAgICogVGhlIGZsb29yIHRoZSBkZXNrIGlzIG9uLiBUaGlzIG9uZSBjYW5ub3QgYmUgZGVyaXZlZDogcmVzb2x2aW5nIGEgZGVzayBieVxuICAgICAqIG5hbWUgbWVhbnMgbGlzdGluZyBhIGZsb29yJ3MgZGVza3MsIHNvIHRoZSBmbG9vciBoYXMgdG8gYmUga25vd24gZmlyc3QuXG4gICAgICogVmlzaWJsZSBpbiB0aGUgVVJMIG9mIENvbWVlbidzIGZsb29yIHBsYW4sIGFuZCBpbiBgZmxvb3JfaWRgIG9uIGFueSBkZXNrLlxuICAgICAqL1xuICAgIGZsb29ySWQ6IG51bWJlcjtcbiAgICAvKipcbiAgICAgKiBUaGUgYnVpbGRpbmcgdGhlIGZsb29yIGlzIGluLiBBbHNvIG5vdCBkZXJpdmFibGUgXHUyMDE0IGEgZGVzayByZWNvcmQgY2Fycmllc1xuICAgICAqIGBmbG9vcl9pZGAgYW5kIGBhcmVhX2lkYCBidXQgbm8gYGJ1aWxkaW5nX2lkYCwgYW5kIHRoZSBvbmx5IGVuZHBvaW50IHRoYXRcbiAgICAgKiBtYXBzIG9uZSB0byB0aGUgb3RoZXIgbmVlZHMgYSBzcGFjZSBVVUlEIHdlIG5ldmVyIG90aGVyd2lzZSBmZXRjaC5cbiAgICAgKi9cbiAgICBidWlsZGluZ0lkOiBudW1iZXI7XG4gICAgd2Vla2RheXM6IFdlZWtkYXlbXTtcbiAgICBzbG90OiBTbG90O1xuICAgIGhvcml6b25EYXlzOiBudW1iZXI7XG4gICAgc2tpcERhdGVzOiBzdHJpbmdbXTtcbiAgICB0aW1lWm9uZTogc3RyaW5nO1xuICAgIGVuZHBvaW50OiBFbmRwb2ludENvbmZpZztcbn1cblxuLyoqXG4gKiBBIHNsb3QgYXMgdGhlIG5haXZlIGxvY2FsIHRpbWVzIENvbWVlbiBleHBlY3RzLlxuICpcbiAqIENvbWVlbiBzZW5kcyBkYXRldGltZXMgbGlrZSBgMjAyNi0wOS0wMVQwMDowMDowMC4wMDBaYCBhbmQgZWNob2VzIHRoZW0gYmFja1xuICogYXMgYDIwMjYtMDktMDFUMDA6MDA6MDBgIFx1MjAxNCBhIGxvY2FsIHdhbGwtY2xvY2sgdGltZSB3ZWFyaW5nIGEgYFpgLiBTbyB0aGUgZGF5XG4gKiBpcyB1c2VkIHZlcmJhdGltIGFuZCBubyB0aW1lem9uZSBjb252ZXJzaW9uIGhhcHBlbnMgYW55d2hlcmUgaW4gdGhlIGJvb2tpbmdcbiAqIHBhdGguIFRoZSBkYXRlIGxvZ2ljIGluIGRhdGVzLnRzIGFscmVhZHkgcHJvZHVjZXMgZXhhY3RseSB0aGlzLlxuICpcbiAqIFx1MjZBMFx1RkUwRiBPbmx5IGBhbGxfZGF5YCBpcyBjb25maXJtZWQgYWdhaW5zdCBhIHJlYWwgYm9va2luZy4gVGhlIGhhbGYtZGF5cyBhcmUgYVxuICogcmVhc29uYWJsZSByZWFkaW5nIG9mIHRoZSBzYW1lIHNjaGVtZSwgbm90IGFuIG9ic2VydmVkIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFNMT1RfVElNRVM6IFJlY29yZDxTbG90LCB7IHN0YXJ0OiBzdHJpbmc7IGVuZDogc3RyaW5nIH0+ID0ge1xuICAgIGFsbF9kYXk6IHsgc3RhcnQ6ICcwMDowMDowMC4wMDBaJywgZW5kOiAnMjM6NTk6NTkuMDAwWicgfSxcbiAgICBtb3JuaW5nOiB7IHN0YXJ0OiAnMDA6MDA6MDAuMDAwWicsIGVuZDogJzEyOjAwOjAwLjAwMFonIH0sXG4gICAgYWZ0ZXJub29uOiB7IHN0YXJ0OiAnMTI6MDA6MDAuMDAwWicsIGVuZDogJzIzOjU5OjU5LjAwMFonIH0sXG59O1xuXG4vKipcbiAqIENvbmZpcm1lZCBhZ2FpbnN0IGEgcmVhbCBzaWduZWQtaW4gc2Vzc2lvbiBpbiBBdWd1c3QgMjAyNiwgYnkgY2FwdHVyaW5nIHRoZVxuICogdHJhZmZpYyBvZiBvbmUgZGVzayBib29raW5nIG1hZGUgYnkgaGFuZC5cbiAqXG4gKiBOb3RlcyB3b3J0aCBrZWVwaW5nLCBiZWNhdXNlIGVhY2ggb25lIGNvbnRyYWRpY3RzIGEgcmVhc29uYWJsZSBndWVzczpcbiAqICAgLSBgYXBpQmFzZWAgaXMgbXkuY29tZWVuLmlvL2FwaSwgdGhlIFNQQSdzIG93biBvcmlnaW4sIE5PVCBhcGkuY29tZWVuLmlvXG4gKiAgICAgd2hlcmUgdGhlIHB1YmxpYyBkb2NzIGxpdmUuIEl0IGlzIGEgUmFpbHMgYmFja2VuZCBiZWhpbmQgYSBOdXh0IGZyb250IGVuZCxcbiAqICAgICB3aGljaCBpcyB3aHkgcGF0aHMgZW5kIGluIGAuanNvbmAuXG4gKiAgIC0gVGhlIEFQSSB2ZXJzaW9uIHZhcmllcyBwZXIgZW5kcG9pbnQgKC92MSwgL3YyLCAvdjJiZXRhKSwgc28gdGhlIHZlcnNpb25cbiAqICAgICBiZWxvbmdzIGluIGVhY2ggcGF0aCByYXRoZXIgdGhhbiBpbiBhcGlCYXNlLlxuICogICAtIEEgZGVzaydzIGlkIGlzIGB1dWlkYC4gVGhlcmUgaXMgbm8gYGlkYCBmaWVsZCBvbiBhIGRlc2sgYXQgYWxsLlxuICogICAtIFRoZSBib29raW5ncyBsaXN0IGlzIGtleWVkIGJ5IGRhdGU7IHRoZSBkYXRlIGlzIG5vdCBhIGZpZWxkIG9uIGFuIGVudHJ5LlxuICogICAtIEEgYm9va2luZyBpcyBhIFwid29yayBhY3Rpdml0eVwiIHdpdGggYSBkZXNrIGF0dGFjaGVkLCBub3QgYSBkZXNrIGJvb2tpbmdcbiAqICAgICBhcyBzdWNoLiBUaGF0IGlzIHdoeSB0aGUgcGF0aCBzYXlzIHdvcmtfYWN0aXZpdHlfc2NoZWR1bGUuXG4gKiAgIC0gQXV0aCBpcyB0aGUgc2Vzc2lvbiBjb29raWUuIEEgZmV0Y2ggZnJvbSB0aGUgcGFnZSB3aXRoIGNyZWRlbnRpYWxzXG4gKiAgICAgaW5jbHVkZWQgYW5kIG5vIEF1dGhvcml6YXRpb24gaGVhZGVyIHJldHVybnMgMjAwLCBzbyB0aGVyZSBpcyBubyB0b2tlbiB0b1xuICogICAgIHJlYWQgYW5kIG5vdGhpbmcgZm9yIHRoZSBleHRlbnNpb24gdG8gaG9sZC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFNldHRpbmdzID0ge1xuICAgIC8vIFx1MkIwNiBCVU1QIFRISVMgd2hlbmV2ZXIgeW91IGNvcnJlY3QgdGhlIGBlbmRwb2ludGAgYmxvY2sgYmVsb3csIG90aGVyd2lzZVxuICAgIC8vIGFueW9uZSB3aG8gYWxyZWFkeSBwcmVzc2VkIFNhdmUga2VlcHMgdGhlaXIgc3RhbGUgY29weSBmb3JldmVyLlxuICAgIGVuZHBvaW50VmVyc2lvbjogMyxcbiAgICBlbmFibGVkOiBmYWxzZSxcbiAgICAvLyBFbXB0eSBvbiBwdXJwb3NlLiBTaGlwcGluZyBhIHJlYWwgZGVzayBudW1iZXIgYXMgdGhlIGRlZmF1bHQgbWVhbnMgdGhlXG4gICAgLy8gZmlyc3QgcGVyc29uIHRvIGluc3RhbGwgdGhpcyBhbmQgcHJlc3MgQm9vayBub3cgdGFrZXMgc29tZWJvZHkgZWxzZSdzXG4gICAgLy8gc2VhdCwgaGF2aW5nIGRvbmUgbm90aGluZyB3cm9uZy4gTm90aGluZyBydW5zIHVudGlsIGEgZGVzayBpcyBjaG9zZW4uXG4gICAgZGVza05hbWU6ICcnLFxuICAgIGRlc2tJZDogJycsXG4gICAgZmxvb3JJZDogNDk1MixcbiAgICBidWlsZGluZ0lkOiA1MTUxLFxuICAgIHdlZWtkYXlzOiBbJ21vbmRheScsICd0dWVzZGF5JywgJ3dlZG5lc2RheScsICd0aHVyc2RheScsICdmcmlkYXknXSxcbiAgICBzbG90OiAnYWxsX2RheScsXG4gICAgaG9yaXpvbkRheXM6IDE0LFxuICAgIHNraXBEYXRlczogW10sXG4gICAgdGltZVpvbmU6ICdFdXJvcGUvUHJhZ3VlJyxcbiAgICBlbmRwb2ludDoge1xuICAgICAgICBhcGlCYXNlOiAnaHR0cHM6Ly9teS5jb21lZW4uaW8vYXBpJyxcbiAgICAgICAgYXV0aDogeyBtb2RlOiAnY29va2llJyB9LFxuICAgICAgICByZXNvbHZlOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICAgICAgcGF0aDogJy92MS9mbG9vcnMve3tmbG9vcklkfX0vZGVza3Nfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGU6ICd7e2Zyb219fVQwMDowMDowMC4wMDBaJyxcbiAgICAgICAgICAgICAgICBlbmRfZGF0ZTogJ3t7dG99fVQyMzo1OTo1OS4wMDBaJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGRlc2tOYW1lRmllbGRzOiBbJ25hbWUnLCAnc3luY19pZCddLFxuICAgICAgICBkZXNrSWRGaWVsZHM6IFsndXVpZCcsICdpZCddLFxuICAgICAgICBkZXNrU2NoZWR1bGVGaWVsZDogJ3NjaGVkdWxlJyxcbiAgICAgICAgZGVza1NjaGVkdWxlRGF0ZUZpZWxkczogWydzdGFydF9kYXRldGltZScsICdzdGFydF9kYXRlJywgJ2RhdGUnLCAnZGF5JywgJ3N0YXJ0J10sXG4gICAgICAgIGxpc3Q6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgICAgICBwYXRoOiAnL3YxL3VzZXJzL21lL3dvcmtfYWN0aXZpdHlfc2NoZWR1bGUuanNvbicsXG4gICAgICAgICAgICBxdWVyeToge1xuICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGU6ICd7e2Zyb219fVQwMDowMDowMC4wMDBaJyxcbiAgICAgICAgICAgICAgICBlbmRfZGF0ZTogJ3t7dG99fVQyMzo1OTo1OS4wMDBaJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGxpc3RSb290OiAnc2NoZWR1bGUnLFxuICAgICAgICBsaXN0U2hhcGU6ICdkYXRlS2V5ZWRNYXAnLFxuICAgICAgICBsaXN0RGF0ZUZpZWxkczogWydzdGFydF9kYXRldGltZScsICdkYXRlJ10sXG4gICAgICAgIHVzZXJJZFBhdGg6ICd1c2VyLmlkJyxcbiAgICAgICAgY3JlYXRlOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICAgIC8vIFRoZSBgbWVgIGFsaWFzIHdvcmtzIGZvciByZWFkczsgdGhlIGFwcCBpdHNlbGYgdXNlcyB0aGUgbnVtZXJpY1xuICAgICAgICAgICAgLy8gaWQgdG8gd3JpdGUsIHNvIHRoYXQgaXMgd2hhdCBpcyB1c2VkIGhlcmUuXG4gICAgICAgICAgICBwYXRoOiAnL3YxL3VzZXJzL3t7dXNlcklkfX0vd29ya19hY3Rpdml0eV9zY2hlZHVsZS5qc29uJyxcbiAgICAgICAgICAgIGJvZHk6IHtcbiAgICAgICAgICAgICAgICB3b3JrX2FjdGl2aXR5OiB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXRlOiAnb25fc2l0ZScsXG4gICAgICAgICAgICAgICAgICAgIHN0YXJ0X2RhdGV0aW1lOiAne3tkYXRlfX1Ue3tzdGFydFRpbWV9fScsXG4gICAgICAgICAgICAgICAgICAgIGVuZF9kYXRldGltZTogJ3t7ZGF0ZX19VHt7ZW5kVGltZX19JyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHByZXNlbmNlOiB7XG4gICAgICAgICAgICAgICAgICAgIGJ1aWxkaW5nX2lkOiAne3tidWlsZGluZ0lkfX0nLFxuICAgICAgICAgICAgICAgICAgICBmbG9vcl9pZDogJ3t7Zmxvb3JJZH19JyxcbiAgICAgICAgICAgICAgICAgICAgYXJlYV9pZDogJ3t7YXJlYUlkfX0nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgZGVza19ib29raW5nOiB7IGRlc2tfdXVpZDogJ3t7ZGVza0lkfX0nIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgIH0sXG59O1xuXG4vKipcbiAqIFRoZSBvZmZpY2UsIGFzIGNhcHR1cmVkIGluIEF1Z3VzdCAyMDI2LlxuICpcbiAqIEhhcmRjb2RlZCByYXRoZXIgdGhhbiBmZXRjaGVkLiBUaGUgZmxvb3IgZHJvcGRvd24gaGFzIHRvIGJlIHBvcHVsYXRlZCBiZWZvcmVcbiAqIGFueSBuZXR3b3JrIGNhbGwgaGFwcGVucywgYW4gb2ZmaWNlIGxheW91dCBjaGFuZ2VzIGFib3V0IG5ldmVyLCBhbmQgYVxuICogaGFyZGNvZGVkIGZsb29yIHRoYXQgaXMgd3JvbmcgaXMgYSB2aXNpYmxlIG1pc3Rha2UgcmF0aGVyIHRoYW4gYSBzaWxlbnQgb25lLlxuICpcbiAqIFRvIGFkZCBhIGZsb29yLCByZWFkIHRoZSBpZHMgZnJvbSB0aGUgcmVzcG9uc2Ugb2ZcbiAqIC9hcGkvdjIvc3BhY2VzLzxzcGFjZS11dWlkPi9idWlsZGluZ3MvPGJ1aWxkaW5nLWlkPi9mbG9vcnMuanNvbiB3aXRoIHRoZVxuICogZmxvb3IgcGxhbiBvcGVuLlxuICovXG5leHBvcnQgY29uc3QgQlVJTERJTkcgPSB7IGlkOiA1MTUxLCBuYW1lOiAnMTAweWFyZHMnIH07XG5cbi8qKlxuICogQSBkZXNrIG5hbWUgaXMgZGlnaXRzLCBhIGRhc2gsIGRpZ2l0cyBcdTIwMTQgYDMtMjNgLCBgMTItNGAuXG4gKlxuICogRGVsaWJlcmF0ZWx5IG5vdCB0aWdodGVuZWQgdG8gdHdvIHplcm8tcGFkZGVkIGRpZ2l0cywgd2hpY2ggaXMgd2hhdCB0aGlzXG4gKiBvZmZpY2UgaGFwcGVucyB0byB1c2U6IGEgZmxvb3IgMTIgb3IgYSBkZXNrIDEwMCB3b3VsZCB0aGVuIGJlIHJlamVjdGVkIGZvclxuICogbG9va2luZyB3cm9uZyByYXRoZXIgdGhhbiBmb3IgYmVpbmcgd3JvbmcuIFdoYXQgdGhpcyBjYXRjaGVzIGlzIHRoZSBtaXN0YWtlXG4gKiBwZW9wbGUgYWN0dWFsbHkgbWFrZSBcdTIwMTQgdHlwaW5nIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBhIGRlc2sgbnVtYmVyIGF0IGFsbDogYVxuICogbmFtZSwgYSByb29tLCBhIHN0cmF5IHNwYWNlLlxuICovXG5leHBvcnQgY29uc3QgREVTS19OQU1FX1BBVFRFUk4gPSAvXlxcZCstXFxkKyQvO1xuXG4vKiogRW1wdHkgaXMgbm90IHZhbGlkLCBidXQgaXQgaXMgbm90IGFuIGVycm9yIGVpdGhlciBcdTIwMTQgc2VlIHRoZSBwb3B1cC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ZhbGlkRGVza05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIERFU0tfTkFNRV9QQVRURVJOLnRlc3QobmFtZS50cmltKCkpO1xufVxuXG4vKipcbiAqIERyb3Agc2tpcCBkYXRlcyB0aGF0IGhhdmUgYWxyZWFkeSBwYXNzZWQuXG4gKlxuICogRGF5cyBjYW4gYmUgbWFya2VkIG1vbnRocyBhaGVhZCwgc28gd2l0aG91dCB0aGlzIHRoZSBsaXN0IG9ubHkgZXZlciBncm93cyBcdTIwMTRcbiAqIGEgeWVhciBvZiBcIkkgd2FzIGF3YXkgdGhhdCBUdWVzZGF5XCIgYWNjdW11bGF0aW5nIGluIHN0b3JhZ2UgYW5kIGluIHRoZVxuICogc2V0dGluZ3MgSlNPTiwgd2hlcmUgaXQgaXMgbm9pc2UgdGhhdCBtYWtlcyB0aGUgcmVhbCBlbnRyaWVzIGhhcmQgdG8gcmVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBydW5lUGFzdFNraXBEYXRlcyhza2lwRGF0ZXM6IHN0cmluZ1tdLCB0b2RheTogc3RyaW5nKTogc3RyaW5nW10ge1xuICAgIHJldHVybiBza2lwRGF0ZXMuZmlsdGVyKChkYXRlKSA9PiBkYXRlID49IHRvZGF5KTtcbn1cblxuZXhwb3J0IGNvbnN0IEZMT09SUzogeyBpZDogbnVtYmVyOyBsYWJlbDogc3RyaW5nIH1bXSA9IFtcbiAgICB7IGlkOiA0OTUyLCBsYWJlbDogJ0Zsb29yIDMnIH0sXG4gICAgeyBpZDogNDk1MywgbGFiZWw6ICdGbG9vciA0JyB9LFxuXTtcblxuZXhwb3J0IHR5cGUgVmFycyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbi8qKlxuICogQSBwbGFjZWhvbGRlciB0aGF0IG1ha2VzIHVwIHRoZSAqZW50aXJlKiB2YWx1ZSBhbmQgcmVzb2x2ZXMgdG8gYW4gaW50ZWdlclxuICogYmVjb21lcyBhIG51bWJlci5cbiAqXG4gKiBUaGlzIG1hdHRlcnMgYmVjYXVzZSBKU09OIGRpc3Rpbmd1aXNoZXMgNTE1MSBmcm9tIFwiNTE1MVwiIGFuZCBDb21lZW4nc1xuICogcHJlc2VuY2UgYmxvY2sgd2FudHMgdGhlIGZvcm1lci4gUGFydGlhbCBpbnRlcnBvbGF0aW9uIFx1MjAxNCBcIi91c2Vycy97e3VzZXJJZH19L3hcIlxuICogXHUyMDE0IGFsd2F5cyB5aWVsZHMgYSBzdHJpbmcsIHdoaWNoIGlzIHdoYXQgYSBwYXRoIG5lZWRzLCBzbyB0aGUgdHdvIGNhc2VzIG5ldmVyXG4gKiBjb2xsaWRlLiBBIHV1aWQgb3IgYSBkYXRlIGNvbnRhaW5zIG5vbi1kaWdpdHMgYW5kIHN0YXlzIGEgc3RyaW5nIGVpdGhlciB3YXkuXG4gKi9cbmNvbnN0IFdIT0xFX1BMQUNFSE9MREVSID0gL15cXHtcXHsoXFx3KylcXH1cXH0kLztcbmNvbnN0IElOVEVHRVIgPSAvXi0/XFxkKyQvO1xuXG4vKiogUmVwbGFjZSB7e3BsYWNlaG9sZGVyc319IHRocm91Z2hvdXQgYSBKU09OLWlzaCB2YWx1ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdWJzdGl0dXRlKHZhbHVlOiB1bmtub3duLCB2YXJzOiBWYXJzKTogdW5rbm93biB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgY29uc3Qgd2hvbGUgPSBXSE9MRV9QTEFDRUhPTERFUi5leGVjKHZhbHVlKTtcbiAgICAgICAgaWYgKHdob2xlKSB7XG4gICAgICAgICAgICBjb25zdCByZXBsYWNlbWVudCA9IHZhcnNbd2hvbGVbMV0gPz8gJyddO1xuICAgICAgICAgICAgaWYgKHJlcGxhY2VtZW50ID09PSB1bmRlZmluZWQpIHJldHVybiB2YWx1ZTtcbiAgICAgICAgICAgIHJldHVybiBJTlRFR0VSLnRlc3QocmVwbGFjZW1lbnQpID8gTnVtYmVyKHJlcGxhY2VtZW50KSA6IHJlcGxhY2VtZW50O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9cXHtcXHsoXFx3KylcXH1cXH0vZywgKG1hdGNoLCBrZXk6IHN0cmluZykgPT4gdmFyc1trZXldID8/IG1hdGNoKTtcbiAgICB9XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZS5tYXAoKGVudHJ5KSA9PiBzdWJzdGl0dXRlKGVudHJ5LCB2YXJzKSk7XG4gICAgfVxuICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCBlbnRyeV0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUpKSBvdXRba2V5XSA9IHN1YnN0aXR1dGUoZW50cnksIHZhcnMpO1xuICAgICAgICByZXR1cm4gb3V0O1xuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG5cbi8qKlxuICogTWVyZ2Ugc3RvcmVkIHNldHRpbmdzIG92ZXIgdGhlIHNoaXBwZWQgZGVmYXVsdHMuXG4gKlxuICogUGVyc29uYWwgY2hvaWNlcyAoZGVzaywgd2Vla2RheXMsIHRpbWV6b25lKSBhbHdheXMgd2luOiB0aGV5IGFyZSB0aGUgdXNlcidzLlxuICogVGhlIGVuZHBvaW50IGNvbmZpZyBpcyBkaWZmZXJlbnQuIEl0IGlzIG5vdCBhIHByZWZlcmVuY2UsIGl0IGlzIGEgZmFjdCBhYm91dFxuICogQ29tZWVuJ3MgQVBJIHRoYXQgb25lIHBlcnNvbiBkaXNjb3ZlcnMgYW5kIGV2ZXJ5b25lIGVsc2UgaW5oZXJpdHMuIElmIGFcbiAqIHN0b3JlZCBjb3B5IHByZWRhdGVzIHRoZSBzaGlwcGVkIG9uZSwgdGhlIHNoaXBwZWQgb25lIHJlcGxhY2VzIGl0IG91dHJpZ2h0LlxuICogTWVyZ2luZyBrZXktYnkta2V5IHdvdWxkIGJlIHdvcnNlIHRoYW4gdXNlbGVzcyBoZXJlOiBhIGNvcnJlY3RlZCBgY3JlYXRlYFxuICogYmxvY2sgd291bGQgc2l0IG5leHQgdG8gYSBzdGFsZSBgbGlzdGAgYmxvY2sgYW5kIGZhaWwgaW4gYSBjb25mdXNpbmcgd2F5LlxuICpcbiAqIFB1cmUgYW5kIHNlcGFyYXRlIGZyb20gY2hyb21lLnN0b3JhZ2Ugc28gaXQgY2FuIGJlIHRlc3RlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlU2V0dGluZ3Moc3RvcmVkOiBQYXJ0aWFsPFNldHRpbmdzPiB8IHVuZGVmaW5lZCk6IFNldHRpbmdzIHtcbiAgICBjb25zdCBzdG9yZWRWZXJzaW9uID0gc3RvcmVkPy5lbmRwb2ludFZlcnNpb24gPz8gMDtcbiAgICBjb25zdCBzaGlwcGVkSXNOZXdlciA9IHN0b3JlZFZlcnNpb24gPCBERUZBVUxUX1NFVFRJTkdTLmVuZHBvaW50VmVyc2lvbjtcblxuICAgIHJldHVybiB7XG4gICAgICAgIC4uLkRFRkFVTFRfU0VUVElOR1MsXG4gICAgICAgIC4uLnN0b3JlZCxcbiAgICAgICAgZW5kcG9pbnRWZXJzaW9uOiBERUZBVUxUX1NFVFRJTkdTLmVuZHBvaW50VmVyc2lvbixcbiAgICAgICAgZW5kcG9pbnQ6IHNoaXBwZWRJc05ld2VyIHx8ICFzdG9yZWQ/LmVuZHBvaW50XG4gICAgICAgICAgICA/IERFRkFVTFRfU0VUVElOR1MuZW5kcG9pbnRcbiAgICAgICAgICAgIDogc3RvcmVkLmVuZHBvaW50LFxuICAgIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTxTZXR0aW5ncz4ge1xuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgnc2V0dGluZ3MnKTtcbiAgICByZXR1cm4gbWVyZ2VTZXR0aW5ncyhzdG9yZWQuc2V0dGluZ3MgYXMgUGFydGlhbDxTZXR0aW5ncz4gfCB1bmRlZmluZWQpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2F2ZVNldHRpbmdzKHNldHRpbmdzOiBTZXR0aW5ncyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IHNldHRpbmdzIH0pO1xufVxuIiwgImV4cG9ydCB0eXBlIFdlZWtkYXkgPVxuICAgIHwgJ21vbmRheScgfCAndHVlc2RheScgfCAnd2VkbmVzZGF5J1xuICAgIHwgJ3RodXJzZGF5JyB8ICdmcmlkYXknIHwgJ3NhdHVyZGF5JyB8ICdzdW5kYXknO1xuXG5jb25zdCBXRUVLREFZX05BTUVTOiByZWFkb25seSBXZWVrZGF5W10gPSBbXG4gICAgJ3N1bmRheScsICdtb25kYXknLCAndHVlc2RheScsICd3ZWRuZXNkYXknLCAndGh1cnNkYXknLCAnZnJpZGF5JywgJ3NhdHVyZGF5Jyxcbl07XG5cbmZ1bmN0aW9uIGlzV2Vla2RheSh2YWx1ZTogc3RyaW5nKTogdmFsdWUgaXMgV2Vla2RheSB7XG4gICAgcmV0dXJuIChXRUVLREFZX05BTUVTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyh2YWx1ZSk7XG59XG5cbi8qKiBGb3JtYXQgYSBEYXRlIGFzIFlZWVktTU0tREQgYXMgc2VlbiBpbiBgdGltZVpvbmVgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvTG9jYWxJU09EYXRlKGRhdGU6IERhdGUsIHRpbWVab25lOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiBuZXcgSW50bC5EYXRlVGltZUZvcm1hdCgnZW4tQ0EnLCB7XG4gICAgICAgIHRpbWVab25lLCB5ZWFyOiAnbnVtZXJpYycsIG1vbnRoOiAnMi1kaWdpdCcsIGRheTogJzItZGlnaXQnLFxuICAgIH0pLmZvcm1hdChkYXRlKTtcbn1cblxuLyoqIFdlZWtkYXkgbmFtZSBvZiBgZGF0ZWAgYXMgc2VlbiBpbiBgdGltZVpvbmVgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2FsV2Vla2RheShkYXRlOiBEYXRlLCB0aW1lWm9uZTogc3RyaW5nKTogV2Vla2RheSB7XG4gICAgY29uc3QgbmFtZSA9IG5ldyBJbnRsLkRhdGVUaW1lRm9ybWF0KCdlbi1VUycsIHsgdGltZVpvbmUsIHdlZWtkYXk6ICdsb25nJyB9KVxuICAgICAgICAuZm9ybWF0KGRhdGUpXG4gICAgICAgIC50b0xvd2VyQ2FzZSgpO1xuICAgIGlmICghaXNXZWVrZGF5KG5hbWUpKSB0aHJvdyBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgd2Vla2RheSBmcm9tIEludGw6IFwiJHtuYW1lfVwiYCk7XG4gICAgcmV0dXJuIG5hbWU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGF0ZXNUb0Jvb2tPcHRpb25zIHtcbiAgICB3ZWVrZGF5czogc3RyaW5nW107XG4gICAgaG9yaXpvbkRheXM/OiBudW1iZXI7XG4gICAgc2tpcERhdGVzPzogc3RyaW5nW107XG4gICAgdGltZVpvbmU/OiBzdHJpbmc7XG4gICAgbm93PzogRGF0ZTtcbn1cblxuLyoqXG4gKiBFdmVyeSBkYXkgZnJvbSB0b2RheSAoaW5jbHVzaXZlKSB1cCB0byBgaG9yaXpvbkRheXNgIGFoZWFkIHdob3NlIHdlZWtkYXkgaXNcbiAqIGluIGB3ZWVrZGF5c2AsIG1pbnVzIGBza2lwRGF0ZXNgLlxuICpcbiAqIFRoZSAxNC1kYXkgZGVmYXVsdCBpcyB3aGF0IG1ha2VzIHVucmVsaWFibGUgc2NoZWR1bGluZyBhY2NlcHRhYmxlOiBlYWNoIHJ1blxuICogdG9wcyB0aGUgd2hvbGUgd2luZG93IGJhY2sgdXAsIHNvIG1pc3NpbmcgYSBkYXkgKGxhcHRvcCBzaHV0LCBDaHJvbWUgY2xvc2VkKVxuICogY29zdHMgbm90aGluZyBhcyBsb25nIGFzIHRoZSBleHRlbnNpb24gcnVucyBhZ2FpbiBiZWZvcmUgdGhlIHdpbmRvdyBkcmFpbnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYXRlc1RvQm9vayh7XG4gICAgd2Vla2RheXMsXG4gICAgaG9yaXpvbkRheXMgPSAxNCxcbiAgICBza2lwRGF0ZXMgPSBbXSxcbiAgICB0aW1lWm9uZSA9ICdFdXJvcGUvUHJhZ3VlJyxcbiAgICBub3cgPSBuZXcgRGF0ZSgpLFxufTogRGF0ZXNUb0Jvb2tPcHRpb25zKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IHdhbnRlZCA9IG5ldyBTZXQ8V2Vla2RheT4oKTtcbiAgICBmb3IgKGNvbnN0IHJhdyBvZiB3ZWVrZGF5cykge1xuICAgICAgICBjb25zdCBuYW1lID0gcmF3LnRvTG93ZXJDYXNlKCk7XG4gICAgICAgIGlmICghaXNXZWVrZGF5KG5hbWUpKSB0aHJvdyBuZXcgRXJyb3IoYE5vdCBhIHdlZWtkYXkgbmFtZTogXCIke3Jhd31cImApO1xuICAgICAgICB3YW50ZWQuYWRkKG5hbWUpO1xuICAgIH1cblxuICAgIGNvbnN0IHNraXAgPSBuZXcgU2V0KHNraXBEYXRlcyk7XG4gICAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgZm9yIChsZXQgb2Zmc2V0ID0gMDsgb2Zmc2V0IDw9IGhvcml6b25EYXlzOyBvZmZzZXQgKz0gMSkge1xuICAgICAgICBjb25zdCBkYXkgPSBuZXcgRGF0ZShub3cuZ2V0VGltZSgpICsgb2Zmc2V0ICogODZfNDAwXzAwMCk7XG4gICAgICAgIGNvbnN0IGlzbyA9IHRvTG9jYWxJU09EYXRlKGRheSwgdGltZVpvbmUpO1xuICAgICAgICBpZiAoIXdhbnRlZC5oYXMobG9jYWxXZWVrZGF5KGRheSwgdGltZVpvbmUpKSkgY29udGludWU7XG4gICAgICAgIGlmIChza2lwLmhhcyhpc28pKSBjb250aW51ZTtcbiAgICAgICAgb3V0LnB1c2goaXNvKTtcbiAgICB9XG5cbiAgICByZXR1cm4gb3V0O1xufVxuIiwgImltcG9ydCB7XG4gICAgQlVJTERJTkcsXG4gICAgREVGQVVMVF9TRVRUSU5HUyxcbiAgICBGTE9PUlMsXG4gICAgaXNWYWxpZERlc2tOYW1lLFxuICAgIGxvYWRTZXR0aW5ncyxcbiAgICBwcnVuZVBhc3RTa2lwRGF0ZXMsXG4gICAgc2F2ZVNldHRpbmdzLFxuICAgIHR5cGUgRW5kcG9pbnRDb25maWcsXG4gICAgdHlwZSBTZXR0aW5ncyxcbiAgICB0eXBlIFNsb3QsXG59IGZyb20gJy4vY29yZS9jb25maWcuanMnO1xuaW1wb3J0IHsgZGF0ZXNUb0Jvb2ssIGxvY2FsV2Vla2RheSwgdG9Mb2NhbElTT0RhdGUsIHR5cGUgV2Vla2RheSB9IGZyb20gJy4vY29yZS9kYXRlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFJ1bkxvZyB9IGZyb20gJy4vYmFja2dyb3VuZC5qcyc7XG5cbmNvbnN0IERBWVM6IFdlZWtkYXlbXSA9IFsnbW9uZGF5JywgJ3R1ZXNkYXknLCAnd2VkbmVzZGF5JywgJ3RodXJzZGF5JywgJ2ZyaWRheScsICdzYXR1cmRheScsICdzdW5kYXknXTtcblxuLyoqIE1vbmRheS1maXJzdCwgdG8gbWF0Y2ggaG93IGEgd29ya2luZyB3ZWVrIGlzIHJlYWQuICovXG5jb25zdCBET1dfTEFCRUxTID0gWydNbycsICdUdScsICdXZScsICdUaCcsICdGcicsICdTYScsICdTdSddO1xuXG5mdW5jdGlvbiBlbDxUIGV4dGVuZHMgSFRNTEVsZW1lbnQ+KGlkOiBzdHJpbmcpOiBUIHtcbiAgICBjb25zdCBub2RlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpO1xuICAgIGlmICghbm9kZSkgdGhyb3cgbmV3IEVycm9yKGBNaXNzaW5nIGVsZW1lbnQgIyR7aWR9YCk7XG4gICAgcmV0dXJuIG5vZGUgYXMgVDtcbn1cblxuY29uc3QgZmllbGRzID0ge1xuICAgIGVuYWJsZWQ6IGVsPEhUTUxJbnB1dEVsZW1lbnQ+KCdlbmFibGVkJyksXG4gICAgZGVza05hbWU6IGVsPEhUTUxJbnB1dEVsZW1lbnQ+KCdkZXNrTmFtZScpLFxuICAgIGRlc2tJZDogZWw8SFRNTElucHV0RWxlbWVudD4oJ2Rlc2tJZCcpLFxuICAgIGZsb29ySWQ6IGVsPEhUTUxTZWxlY3RFbGVtZW50PignZmxvb3JJZCcpLFxuICAgIHNsb3Q6IGVsPEhUTUxTZWxlY3RFbGVtZW50Pignc2xvdCcpLFxuICAgIGhvcml6b25EYXlzOiBlbDxIVE1MSW5wdXRFbGVtZW50PignaG9yaXpvbkRheXMnKSxcbiAgICB0aW1lWm9uZTogZWw8SFRNTElucHV0RWxlbWVudD4oJ3RpbWVab25lJyksXG4gICAgZW5kcG9pbnQ6IGVsPEhUTUxUZXh0QXJlYUVsZW1lbnQ+KCdlbmRwb2ludCcpLFxuICAgIGxlYXJuTW9kZTogZWw8SFRNTElucHV0RWxlbWVudD4oJ2xlYXJuTW9kZScpLFxufTtcblxuLy8gXHUyNTAwXHUyNTAwIHN0YXRpYyBvZmZpY2UgZmFjdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5lbDxIVE1MU3BhbkVsZW1lbnQ+KCdidWlsZGluZ05hbWUnKS50ZXh0Q29udGVudCA9IEJVSUxESU5HLm5hbWU7XG5cbmZvciAoY29uc3QgZmxvb3Igb2YgRkxPT1JTKSB7XG4gICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgb3B0aW9uLnZhbHVlID0gU3RyaW5nKGZsb29yLmlkKTtcbiAgICBvcHRpb24udGV4dENvbnRlbnQgPSBmbG9vci5sYWJlbDtcbiAgICBmaWVsZHMuZmxvb3JJZC5hcHBlbmQob3B0aW9uKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIHdlZWtkYXkgY2hpcHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5jb25zdCBkYXlzSG9zdCA9IGVsPEhUTUxEaXZFbGVtZW50PignZGF5cycpO1xuZm9yIChjb25zdCBkYXkgb2YgREFZUykge1xuICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGFiZWwnKTtcbiAgICBjb25zdCBib3ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xuICAgIGJveC50eXBlID0gJ2NoZWNrYm94JztcbiAgICBib3gudmFsdWUgPSBkYXk7XG4gICAgYm94LmRhdGFzZXQuZGF5ID0gZGF5O1xuICAgIGxhYmVsLmFwcGVuZChib3gsIGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKGRheS5zbGljZSgwLCAzKSkpO1xuICAgIGRheXNIb3N0LmFwcGVuZChsYWJlbCk7XG59XG5cbmZ1bmN0aW9uIHNlbGVjdGVkRGF5cygpOiBXZWVrZGF5W10ge1xuICAgIHJldHVybiBbLi4uZGF5c0hvc3QucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50PignaW5wdXQ6Y2hlY2tlZCcpXVxuICAgICAgICAubWFwKChib3gpID0+IGJveC52YWx1ZSBhcyBXZWVrZGF5KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIHN0YXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gU2V0dGluZ3MgYXV0by1zYXZlLCBzbyB0aGlzIGlzIHRoZSBsaXZlIGNvcHkgcmF0aGVyIHRoYW4gYSBzbmFwc2hvdCB0YWtlbiBhdFxuLy8gbG9hZC4gc2tpcERhdGVzIGluIHBhcnRpY3VsYXIgaXMgbXV0YXRlZCBieSBjbGlja2luZyB0aGUgY2FsZW5kYXIuXG5sZXQgY3VycmVudDogU2V0dGluZ3MgPSBhd2FpdCBsb2FkU2V0dGluZ3MoKTtcblxuLyoqXG4gKiBUaGUgbW9zdCByZWNlbnQgcnVuLCBzbyB0aGUgY2FsZW5kYXIgY2FuIHNob3cgd2hhdCB3YXMgYWN0dWFsbHkgZm91bmQgcmF0aGVyXG4gKiB0aGFuIG9ubHkgd2hhdCBpcyBwbGFubmVkLiBDb21lcyBmcm9tIHN0b3JhZ2Ugb24gb3BlbiBhbmQgaXMgcmVwbGFjZWQgYWZ0ZXJcbiAqIGV2ZXJ5IHJ1bi5cbiAqL1xubGV0IGxhc3RMb2c6IFJ1bkxvZyB8IHVuZGVmaW5lZDtcblxuZnVuY3Rpb24gcmVuZGVyU2V0dGluZ3MobmV4dDogU2V0dGluZ3MpOiB2b2lkIHtcbiAgICBmaWVsZHMuZW5hYmxlZC5jaGVja2VkID0gbmV4dC5lbmFibGVkO1xuICAgIGZpZWxkcy5kZXNrTmFtZS52YWx1ZSA9IG5leHQuZGVza05hbWU7XG4gICAgZmllbGRzLmRlc2tJZC52YWx1ZSA9IG5leHQuZGVza0lkO1xuICAgIGZpZWxkcy5mbG9vcklkLnZhbHVlID0gU3RyaW5nKG5leHQuZmxvb3JJZCk7XG4gICAgZmllbGRzLnNsb3QudmFsdWUgPSBuZXh0LnNsb3Q7XG4gICAgZmllbGRzLmhvcml6b25EYXlzLnZhbHVlID0gU3RyaW5nKG5leHQuaG9yaXpvbkRheXMpO1xuICAgIGZpZWxkcy50aW1lWm9uZS52YWx1ZSA9IG5leHQudGltZVpvbmU7XG4gICAgZmllbGRzLmVuZHBvaW50LnZhbHVlID0gSlNPTi5zdHJpbmdpZnkobmV4dC5lbmRwb2ludCwgbnVsbCwgMik7XG4gICAgZWw8SFRNTFNwYW5FbGVtZW50PigndGltZVpvbmVMYWJlbCcpLnRleHRDb250ZW50ID0gbmV4dC50aW1lWm9uZTtcbiAgICBmb3IgKGNvbnN0IGJveCBvZiBkYXlzSG9zdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQ+KCdpbnB1dCcpKSB7XG4gICAgICAgIGJveC5jaGVja2VkID0gbmV4dC53ZWVrZGF5cy5pbmNsdWRlcyhib3gudmFsdWUgYXMgV2Vla2RheSk7XG4gICAgfVxufVxuXG4vKipcbiAqIFJlYWQgdGhlIGZvcm0gYmFjayBpbnRvIGEgU2V0dGluZ3MuXG4gKlxuICogVGhlIGVuZHBvaW50IHRleHRhcmVhIGlzIHRoZSBvbmUgZmllbGQgdGhhdCBjYW4gYmUgbWlkLWVkaXQgYW5kIHVucGFyc2VhYmxlLlxuICogQXV0by1zYXZlIHJ1bnMgb24gZXZlcnkga2V5c3Ryb2tlLCBzbyBhIGhhbGYtdHlwZWQgYnJhY2UgbXVzdCBub3QgdGhyb3cgYXdheVxuICogdGhlIHdvcmtpbmcgY29uZmlnOiB0aGUgbGFzdCBnb29kIHZhbHVlIGlzIGtlcHQgYW5kIHRoZSBjYWxsZXIgaXMgdG9sZC5cbiAqL1xuZnVuY3Rpb24gY29sbGVjdCgpOiB7IHNldHRpbmdzOiBTZXR0aW5nczsgZW5kcG9pbnRFcnJvcj86IHN0cmluZyB9IHtcbiAgICBsZXQgZW5kcG9pbnQ6IEVuZHBvaW50Q29uZmlnID0gY3VycmVudC5lbmRwb2ludDtcbiAgICBsZXQgZW5kcG9pbnRFcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICAgIGVuZHBvaW50ID0gSlNPTi5wYXJzZShmaWVsZHMuZW5kcG9pbnQudmFsdWUpIGFzIEVuZHBvaW50Q29uZmlnO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBlbmRwb2ludEVycm9yID0gYEVuZHBvaW50IGNvbmZpZyBpcyBub3QgdmFsaWQgSlNPTjogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgc2V0dGluZ3M6IHtcbiAgICAgICAgICAgIC8vIFNhdmluZyBzdGFtcHMgdGhlIHZlcnNpb24gdGhlIHVzZXIgaGFzIGFjdHVhbGx5IHNlZW4sIHNvIGEgbGF0ZXJcbiAgICAgICAgICAgIC8vIGJ1aWxkIHdpdGggYSBjb3JyZWN0ZWQgY29udHJhY3Qgc3RpbGwgc3VwZXJzZWRlcyB0aGlzLlxuICAgICAgICAgICAgZW5kcG9pbnRWZXJzaW9uOiBjdXJyZW50LmVuZHBvaW50VmVyc2lvbixcbiAgICAgICAgICAgIGVuYWJsZWQ6IGZpZWxkcy5lbmFibGVkLmNoZWNrZWQsXG4gICAgICAgICAgICAgICAgZGVza05hbWU6IGZpZWxkcy5kZXNrTmFtZS52YWx1ZS50cmltKCksXG4gICAgICAgICAgICBkZXNrSWQ6IGZpZWxkcy5kZXNrSWQudmFsdWUudHJpbSgpLFxuICAgICAgICAgICAgZmxvb3JJZDogTnVtYmVyKGZpZWxkcy5mbG9vcklkLnZhbHVlKSB8fCBERUZBVUxUX1NFVFRJTkdTLmZsb29ySWQsXG4gICAgICAgICAgICAvLyBGaXhlZDogdGhlcmUgaXMgb25lIGJ1aWxkaW5nLCBhbmQgaXQgaXMgc2hvd24gYXMgdGV4dCwgbm90IGVkaXRlZC5cbiAgICAgICAgICAgIGJ1aWxkaW5nSWQ6IEJVSUxESU5HLmlkLFxuICAgICAgICAgICAgd2Vla2RheXM6IHNlbGVjdGVkRGF5cygpLFxuICAgICAgICAgICAgc2xvdDogZmllbGRzLnNsb3QudmFsdWUgYXMgU2xvdCxcbiAgICAgICAgICAgIGhvcml6b25EYXlzOiBOdW1iZXIoZmllbGRzLmhvcml6b25EYXlzLnZhbHVlKSB8fCBERUZBVUxUX1NFVFRJTkdTLmhvcml6b25EYXlzLFxuICAgICAgICAgICAgLy8gT3duZWQgYnkgdGhlIGNhbGVuZGFyLCBub3QgYnkgYW55IGZvcm0gZmllbGQuIFBydW5lZCBvbiBldmVyeVxuICAgICAgICAgICAgLy8gc2F2ZSBzbyBtb250aHMgb2YgcGFzdCBlbnRyaWVzIGRvIG5vdCBwaWxlIHVwLlxuICAgICAgICAgICAgc2tpcERhdGVzOiBwcnVuZVBhc3RTa2lwRGF0ZXMoXG4gICAgICAgICAgICAgICAgY3VycmVudC5za2lwRGF0ZXMsXG4gICAgICAgICAgICAgICAgdG9Mb2NhbElTT0RhdGUobmV3IERhdGUoKSwgZmllbGRzLnRpbWVab25lLnZhbHVlLnRyaW0oKSB8fCBERUZBVUxUX1NFVFRJTkdTLnRpbWVab25lKSxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICB0aW1lWm9uZTogZmllbGRzLnRpbWVab25lLnZhbHVlLnRyaW0oKSB8fCBERUZBVUxUX1NFVFRJTkdTLnRpbWVab25lLFxuICAgICAgICAgICAgZW5kcG9pbnQsXG4gICAgICAgIH0sXG4gICAgICAgIGVuZHBvaW50RXJyb3IsXG4gICAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIHRoZSBib29raW5nIHBsYW4gY2FsZW5kYXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IHBhZCA9ICh2YWx1ZTogbnVtYmVyKTogc3RyaW5nID0+IFN0cmluZyh2YWx1ZSkucGFkU3RhcnQoMiwgJzAnKTtcbmNvbnN0IGlzb0ZvciA9ICh5ZWFyOiBudW1iZXIsIG1vbnRoOiBudW1iZXIsIGRheTogbnVtYmVyKTogc3RyaW5nID0+XG4gICAgYCR7eWVhcn0tJHtwYWQobW9udGggKyAxKX0tJHtwYWQoZGF5KX1gO1xuXG4vKipcbiAqIFR3byBtb250aHMgb2YgZGF5cywgd2l0aCB0aGUgb25lcyB0aGF0IHdpbGwgYWN0dWFsbHkgYmUgYm9va2VkIGhpZ2hsaWdodGVkLlxuICpcbiAqIFRoaXMgaXMgdGhlIGFuc3dlciB0byBcIndoYXQgaXMgdGhpcyBnb2luZyB0byBkb1wiLCB3aGljaCBpcyB3aHkgaXQgZHJhd3MgdGhlXG4gKiB3aG9sZSBob3Jpem9uIHJhdGhlciB0aGFuIG9ubHkgdGhlIGV4Y2VwdGlvbnMgdG8gaXQuIENsaWNraW5nIGEgcGxhbm5lZCBkYXlcbiAqIG1vdmVzIGl0IGluIGFuZCBvdXQgb2Ygc2tpcERhdGVzLlxuICovXG5mdW5jdGlvbiByZW5kZXJQbGFuKCk6IHZvaWQge1xuICAgIGNvbnN0IGhvc3QgPSBlbDxIVE1MRGl2RWxlbWVudD4oJ2NhbGVuZGFyJyk7XG4gICAgaG9zdC50ZXh0Q29udGVudCA9ICcnO1xuXG4gICAgY29uc3QgdG9kYXkgPSB0b0xvY2FsSVNPRGF0ZShuZXcgRGF0ZSgpLCBjdXJyZW50LnRpbWVab25lKTtcbiAgICBjb25zdCBbdG9kYXlZZWFyLCB0b2RheU1vbnRoXSA9IHRvZGF5LnNwbGl0KCctJykubWFwKE51bWJlcikgYXMgW251bWJlciwgbnVtYmVyLCBudW1iZXJdO1xuXG4gICAgLy8gQ2FuZGlkYXRlcyBpZ25vcmluZyBza2lwRGF0ZXMsIHNvIGEgc2tpcHBlZCBkYXkgaXMgc3RpbGwgZHJhd24gYXMgb25lIG9mXG4gICAgLy8gdGhlIHBsYW5uZWQgZGF5cyByYXRoZXIgdGhhbiB2YW5pc2hpbmcgaW50byB0aGUgYmFja2dyb3VuZC5cbiAgICBsZXQgY2FuZGlkYXRlczogU2V0PHN0cmluZz47XG4gICAgdHJ5IHtcbiAgICAgICAgY2FuZGlkYXRlcyA9IG5ldyBTZXQoZGF0ZXNUb0Jvb2soe1xuICAgICAgICAgICAgd2Vla2RheXM6IGN1cnJlbnQud2Vla2RheXMsXG4gICAgICAgICAgICBob3Jpem9uRGF5czogY3VycmVudC5ob3Jpem9uRGF5cyxcbiAgICAgICAgICAgIHNraXBEYXRlczogW10sXG4gICAgICAgICAgICB0aW1lWm9uZTogY3VycmVudC50aW1lWm9uZSxcbiAgICAgICAgfSkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICBjYW5kaWRhdGVzID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIC8vIFdoZXRoZXIgYSBkYXRlIGlzIGEgd2Vla2RheSB5b3UgY29tZSBpbiwgaWdub3JpbmcgdGhlIGhvcml6b24gZW50aXJlbHkuXG4gICAgLy8gS25vd2luZyBpbiBTZXB0ZW1iZXIgdGhhdCB5b3UgYXJlIGF3YXkgaW4gT2N0b2JlciBpcyBub3JtYWw7IHRoZSBob3Jpem9uXG4gICAgLy8gZ292ZXJucyB3aGF0IGdldHMgYm9va2VkLCBhbmQgaGFzIG5vIGJ1c2luZXNzIGdvdmVybmluZyB3aGF0IHlvdSBhcmVcbiAgICAvLyBhbGxvd2VkIHRvIHRlbGwgaXQgaW4gYWR2YW5jZS5cbiAgICBjb25zdCBjaG9zZW5XZWVrZGF5cyA9IG5ldyBTZXQoY3VycmVudC53ZWVrZGF5cyk7XG4gICAgY29uc3QgaXNXb3JrZGF5ID0gKGlzbzogc3RyaW5nKTogYm9vbGVhbiA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBNaWRkYXkgYXZvaWRzIGFueSBjaGFuY2Ugb2YgdGhlIHBhcnNlZCBpbnN0YW50IGxhbmRpbmcgb24gdGhlXG4gICAgICAgICAgICAvLyBwcmV2aW91cyBkYXkgb25jZSBzaGlmdGVkIGludG8gdGhlIHRhcmdldCB6b25lLlxuICAgICAgICAgICAgcmV0dXJuIGNob3NlbldlZWtkYXlzLmhhcyhsb2NhbFdlZWtkYXkobmV3IERhdGUoYCR7aXNvfVQxMjowMDowMFpgKSwgY3VycmVudC50aW1lWm9uZSkpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgIH07XG4gICAgY29uc3Qgc2tpcHBlZCA9IG5ldyBTZXQoY3VycmVudC5za2lwRGF0ZXMpO1xuXG4gICAgLy8gV2hhdCB0aGUgbGFzdCBydW4gZm91bmQsIGJ5IGRhdGUuIGBib29rZWRgIGFuZCBgc2tpcHBlZGAgYm90aCBtZWFuIFwieW91XG4gICAgLy8gaG9sZCB0aGF0IGRheVwiIFx1MjAxNCBvbmUganVzdCBoYXBwZW5lZCBub3cgYW5kIHRoZSBvdGhlciBlYXJsaWVyLlxuICAgIGNvbnN0IG91dGNvbWUgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgIGZvciAoY29uc3Qgcm93IG9mIGxhc3RMb2c/LnJvd3MgPz8gW10pIHtcbiAgICAgICAgaWYgKHJvdy5zdGF0dXMgPT09ICdib29rZWQnIHx8IHJvdy5zdGF0dXMgPT09ICdza2lwcGVkJykgb3V0Y29tZS5zZXQocm93LmRhdGUsICdoYXZlJyk7XG4gICAgICAgIGVsc2UgaWYgKHJvdy5zdGF0dXMgPT09ICd1bmF2YWlsYWJsZScpIG91dGNvbWUuc2V0KHJvdy5kYXRlLCAndGFrZW4nKTtcbiAgICAgICAgZWxzZSBpZiAocm93LnN0YXR1cyA9PT0gJ2Vycm9yJykgb3V0Y29tZS5zZXQocm93LmRhdGUsICdmYWlsZWQnKTtcbiAgICB9XG5cbiAgICAvLyBBIHJ1biBmcm9tIGRheXMgYWdvIGNhbiBzdGlsbCBiZSBzaG93aW5nIGdyZWVuIGZvciBkYXlzIHRoYXQgaGF2ZSBzaW5jZVxuICAgIC8vIGJlZW4gZ2l2ZW4gYXdheSwgc28gdGhlIHBsYW4gc2F5cyBob3cgb2xkIGl0IGlzIHJhdGhlciB0aGFuIGltcGx5aW5nIGl0XG4gICAgLy8gaXMgbGl2ZS5cbiAgICBjb25zdCBhc09mID0gZWw8SFRNTFNwYW5FbGVtZW50PigncGxhbkFzT2YnKTtcbiAgICBhc09mLnRleHRDb250ZW50ID0gbGFzdExvZ1xuICAgICAgICA/IGBjb2xvdXJzIGZyb20gJHtuZXcgRGF0ZShsYXN0TG9nLmF0KS50b0xvY2FsZVN0cmluZygpfSBcdTAwQjcgY2xpY2sgYSBkYXkgdG8gc2tpcCBpdGBcbiAgICAgICAgOiAnY2xpY2sgYSBkYXkgdG8gc2tpcCBpdCc7XG5cbiAgICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPCAyOyBvZmZzZXQgKz0gMSkge1xuICAgICAgICBjb25zdCBtb250aCA9IHRvZGF5TW9udGggLSAxICsgb2Zmc2V0O1xuICAgICAgICBjb25zdCB5ZWFyID0gdG9kYXlZZWFyICsgTWF0aC5mbG9vcihtb250aCAvIDEyKTtcbiAgICAgICAgY29uc3Qgbm9ybWFsaXNlZCA9ICgobW9udGggJSAxMikgKyAxMikgJSAxMjtcblxuICAgICAgICBjb25zdCBibG9jayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBibG9jay5jbGFzc05hbWUgPSAnbW9udGgnO1xuXG4gICAgICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgbmFtZS5jbGFzc05hbWUgPSAnbW9udGgtbmFtZSc7XG4gICAgICAgIG5hbWUudGV4dENvbnRlbnQgPSBuZXcgRGF0ZShEYXRlLlVUQyh5ZWFyLCBub3JtYWxpc2VkLCAxKSlcbiAgICAgICAgICAgIC50b0xvY2FsZURhdGVTdHJpbmcodW5kZWZpbmVkLCB7IG1vbnRoOiAnbG9uZycsIHllYXI6ICdudW1lcmljJywgdGltZVpvbmU6ICdVVEMnIH0pO1xuICAgICAgICBibG9jay5hcHBlbmQobmFtZSk7XG5cbiAgICAgICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBncmlkLmNsYXNzTmFtZSA9ICdncmlkJztcbiAgICAgICAgZm9yIChjb25zdCBsYWJlbCBvZiBET1dfTEFCRUxTKSB7XG4gICAgICAgICAgICBjb25zdCBoZWFkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgICAgICBoZWFkLmNsYXNzTmFtZSA9ICdkb3cnO1xuICAgICAgICAgICAgaGVhZC50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICAgICAgZ3JpZC5hcHBlbmQoaGVhZCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBmaXJzdERheU9mV2VlayA9IG5ldyBEYXRlKERhdGUuVVRDKHllYXIsIG5vcm1hbGlzZWQsIDEpKS5nZXRVVENEYXkoKTtcbiAgICAgICAgLy8gZ2V0VVRDRGF5IGlzIFN1bmRheS1maXJzdDsgdGhlIGdyaWQgaXMgTW9uZGF5LWZpcnN0LlxuICAgICAgICBjb25zdCBsZWFkID0gKGZpcnN0RGF5T2ZXZWVrICsgNikgJSA3O1xuICAgICAgICBmb3IgKGxldCBibGFuayA9IDA7IGJsYW5rIDwgbGVhZDsgYmxhbmsgKz0gMSkgZ3JpZC5hcHBlbmQoZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2JykpO1xuXG4gICAgICAgIGNvbnN0IGRheXNJbk1vbnRoID0gbmV3IERhdGUoRGF0ZS5VVEMoeWVhciwgbm9ybWFsaXNlZCArIDEsIDApKS5nZXRVVENEYXRlKCk7XG4gICAgICAgIGZvciAobGV0IGRheSA9IDE7IGRheSA8PSBkYXlzSW5Nb250aDsgZGF5ICs9IDEpIHtcbiAgICAgICAgICAgIGNvbnN0IGlzbyA9IGlzb0Zvcih5ZWFyLCBub3JtYWxpc2VkLCBkYXkpO1xuICAgICAgICAgICAgY29uc3QgY2VsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICAgICAgY2VsbC5jbGFzc05hbWUgPSAnZGF5JztcbiAgICAgICAgICAgIGNlbGwudGV4dENvbnRlbnQgPSBTdHJpbmcoZGF5KTtcbiAgICAgICAgICAgIGNlbGwudHlwZSA9ICdidXR0b24nO1xuXG4gICAgICAgICAgICBpZiAoaXNvIDwgdG9kYXkpIGNlbGwuY2xhc3NMaXN0LmFkZCgncGFzdCcpO1xuICAgICAgICAgICAgaWYgKGlzbyA9PT0gdG9kYXkpIGNlbGwuY2xhc3NMaXN0LmFkZCgndG9kYXknKTtcblxuICAgICAgICAgICAgY29uc3QgcGxhbm5lZCA9IGNhbmRpZGF0ZXMuaGFzKGlzbyk7XG4gICAgICAgICAgICBjb25zdCBtYXJrYWJsZSA9IHBsYW5uZWQgfHwgKGlzbyA+PSB0b2RheSAmJiBpc1dvcmtkYXkoaXNvKSk7XG5cbiAgICAgICAgICAgIGlmIChtYXJrYWJsZSkge1xuICAgICAgICAgICAgICAgIC8vIFRoZSB1c2VyJ3Mgb3duIGNob2ljZSB0byBza2lwIG91dHJhbmtzIGFueXRoaW5nIGEgcnVuIGZvdW5kOlxuICAgICAgICAgICAgICAgIC8vIGl0IGlzIGFuIGluc3RydWN0aW9uLCBub3QgYW4gb2JzZXJ2YXRpb24uXG4gICAgICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSBza2lwcGVkLmhhcyhpc28pXG4gICAgICAgICAgICAgICAgICAgID8gJ3NraXAnXG4gICAgICAgICAgICAgICAgICAgIDogb3V0Y29tZS5nZXQoaXNvKSA/PyAocGxhbm5lZCA/ICdib29rJyA6ICdsYXRlcicpO1xuICAgICAgICAgICAgICAgIGNlbGwuY2xhc3NMaXN0LmFkZChzdGF0ZSwgJ2NsaWNrYWJsZScpO1xuICAgICAgICAgICAgICAgIGNlbGwudGl0bGUgPSB7XG4gICAgICAgICAgICAgICAgICAgIHNraXA6ICdTa2lwcGVkIFx1MjAxNCBjbGljayB0byBib29rIGl0JyxcbiAgICAgICAgICAgICAgICAgICAgaGF2ZTogJ1lvdSBhbHJlYWR5IGhhdmUgdGhpcyBkYXkuIENsaWNraW5nIHN0b3BzIGZ1dHVyZSBydW5zIHJlLWJvb2tpbmcgaXQ7ICdcbiAgICAgICAgICAgICAgICAgICAgICAgICsgJ2l0IGRvZXMgbm90IGNhbmNlbCB0aGUgYm9va2luZyBpbiBDb21lZW4uJyxcbiAgICAgICAgICAgICAgICAgICAgdGFrZW46ICdTb21lb25lIGVsc2UgaGFzIHRoaXMgZGVzayB0aGF0IGRheS4gQ2xpY2tpbmcgc3RvcHMgaXQgYmVpbmcgcmV0cmllZC4nLFxuICAgICAgICAgICAgICAgICAgICBmYWlsZWQ6ICdUaGUgbGFzdCBhdHRlbXB0IGZhaWxlZCBvbiB0aGlzIGRheS4gT3BlbiBMYXN0IHJ1biBmb3IgdGhlIHJlYXNvbi4nLFxuICAgICAgICAgICAgICAgICAgICBib29rOiAnQ2xpY2sgdG8gc2tpcCcsXG4gICAgICAgICAgICAgICAgICAgIGxhdGVyOiAnQmV5b25kIHRoZSBib29raW5nIHdpbmRvdyBmb3Igbm93LiBDbGljayB0byBza2lwIGl0IGluIGFkdmFuY2UgXHUyMDE0IGl0ICdcbiAgICAgICAgICAgICAgICAgICAgICAgICsgJ3dpbGwgYmUgcmVtZW1iZXJlZCB3aGVuIHRoZSB3aW5kb3cgcmVhY2hlcyBpdC4nLFxuICAgICAgICAgICAgICAgIH1bc3RhdGVdID8/ICdDbGljayB0byBza2lwJztcbiAgICAgICAgICAgICAgICBjZWxsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBjdXJyZW50LnNraXBEYXRlcyA9IHNraXBwZWQuaGFzKGlzbylcbiAgICAgICAgICAgICAgICAgICAgICAgID8gY3VycmVudC5za2lwRGF0ZXMuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkgIT09IGlzbylcbiAgICAgICAgICAgICAgICAgICAgICAgIDogWy4uLmN1cnJlbnQuc2tpcERhdGVzLCBpc29dLnNvcnQoKTtcbiAgICAgICAgICAgICAgICAgICAgcmVuZGVyUGxhbigpO1xuICAgICAgICAgICAgICAgICAgICBxdWV1ZVNhdmUoKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZ3JpZC5hcHBlbmQoY2VsbCk7XG4gICAgICAgIH1cblxuICAgICAgICBibG9jay5hcHBlbmQoZ3JpZCk7XG4gICAgICAgIGhvc3QuYXBwZW5kKGJsb2NrKTtcbiAgICB9XG59XG5cbi8qKlxuICogU2hvdyB3aGV0aGVyIHRoZSBkZXNrIG5hbWUgaXMgdXNhYmxlLCBhbmQgc3RvcCB0aGUgYnV0dG9ucyBpZiBpdCBpcyBub3QuXG4gKlxuICogVGhyZWUgc3RhdGVzIHJhdGhlciB0aGFuIHR3bzogZW1wdHkgaXMgbm90IGFuIGVycm9yLCBpdCBpcyB0aGUgc3RhcnRpbmdcbiAqIHBvaW50LCBzbyBpdCBnZXRzIGEgcGxhaW4gaGludC4gT25seSBzb21ldGhpbmcgdHlwZWQgYW5kIHdyb25nIHR1cm5zIHJlZC5cbiAqIFNjb2xkaW5nIHNvbWVvbmUgZm9yIG5vdCBoYXZpbmcgZmlsbGVkIGEgZmllbGQgaW4geWV0IGlzIGhvdyBhIHNldHVwIHNjcmVlblxuICogbWFrZXMgcGVvcGxlIGZlZWwgc3R1cGlkLlxuICovXG5mdW5jdGlvbiByZW5kZXJEZXNrU3RhdGUoKTogdm9pZCB7XG4gICAgY29uc3QgcmF3ID0gZmllbGRzLmRlc2tOYW1lLnZhbHVlLnRyaW0oKTtcbiAgICBjb25zdCBub3RlID0gZWw8SFRNTFBhcmFncmFwaEVsZW1lbnQ+KCdkZXNrTm90ZScpO1xuICAgIGNvbnN0IHZhbGlkID0gaXNWYWxpZERlc2tOYW1lKHJhdyk7XG5cbiAgICBpZiAocmF3ID09PSAnJykge1xuICAgICAgICBub3RlLnRleHRDb250ZW50ID0gJ1BpY2sgeW91ciBkZXNrIGZpcnN0IFx1MjAxNCB0aGUgbnVtYmVyIHByaW50ZWQgb24gaXQsIGxpa2UgMy0yMy4nO1xuICAgICAgICBub3RlLmNsYXNzTGlzdC5yZW1vdmUoJ2JhZCcpO1xuICAgICAgICBmaWVsZHMuZGVza05hbWUuY2xhc3NMaXN0LnJlbW92ZSgnYmFkJyk7XG4gICAgfSBlbHNlIGlmICh2YWxpZCkge1xuICAgICAgICBub3RlLnRleHRDb250ZW50ID0gJ0xvb2tlZCB1cCBieSBuYW1lIG9uIGV2ZXJ5IHJ1biwgc28gdGhlIElEIHN0YXlzIGVtcHR5Lic7XG4gICAgICAgIG5vdGUuY2xhc3NMaXN0LnJlbW92ZSgnYmFkJyk7XG4gICAgICAgIGZpZWxkcy5kZXNrTmFtZS5jbGFzc0xpc3QucmVtb3ZlKCdiYWQnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBub3RlLnRleHRDb250ZW50ID0gYFwiJHtyYXd9XCIgaXMgbm90IGEgZGVzayBudW1iZXIuIEl0IHNob3VsZCBiZSBkaWdpdHMsIGEgZGFzaCwgZGlnaXRzIFx1MjAxNCBsaWtlIDMtMjMuYDtcbiAgICAgICAgbm90ZS5jbGFzc0xpc3QuYWRkKCdiYWQnKTtcbiAgICAgICAgZmllbGRzLmRlc2tOYW1lLmNsYXNzTGlzdC5hZGQoJ2JhZCcpO1xuICAgIH1cblxuICAgIC8vIEEgZGVzayBJRCBzZXQgYnkgaGFuZCBpbiBBZHZhbmNlZCBpcyBhIGRlbGliZXJhdGUgb3ZlcnJpZGUsIGFuZCBzdGFuZHMgaW5cbiAgICAvLyBmb3IgdGhlIG5hbWUuXG4gICAgY29uc3QgcnVubmFibGUgPSB2YWxpZCB8fCBmaWVsZHMuZGVza0lkLnZhbHVlLnRyaW0oKSAhPT0gJyc7XG4gICAgZm9yIChjb25zdCBpZCBvZiBbJ3J1bk5vdycsICdkcnlSdW4nXSkge1xuICAgICAgICBlbDxIVE1MQnV0dG9uRWxlbWVudD4oaWQpLmRpc2FibGVkID0gIXJ1bm5hYmxlO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gcmVuZGVyQXV0b05vdGUoKTogdm9pZCB7XG4gICAgY29uc3Qgbm90ZSA9IGVsPEhUTUxQYXJhZ3JhcGhFbGVtZW50PignYXV0b05vdGUnKTtcbiAgICBub3RlLnRleHRDb250ZW50ID0gY3VycmVudC5lbmFibGVkXG4gICAgICAgID8gYE9uLiBDaGVja3MgZXZlcnkgNiBob3VycyBhbmQgYm9va3MgYW55IG1pc3NpbmcgZGF5IGluIHRoZSBuZXh0ICR7Y3VycmVudC5ob3Jpem9uRGF5c30gYFxuICAgICAgICAgICAgKyAnZGF5cy4gT25seSBydW5zIHdoaWxlIENocm9tZSBpcyBvcGVuIFx1MjAxNCBhIGNsb3NlZCBsYXB0b3AganVzdCBtZWFucyBpdCBjYXRjaGVzIHVwIGxhdGVyLidcbiAgICAgICAgOiAnT2ZmLiBOb3RoaW5nIGlzIGJvb2tlZCB1bmxlc3MgeW91IHByZXNzIEJvb2sgbm93Lic7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBzYXZpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGZsYXNoU2F2ZWQodGV4dCA9ICdTYXZlZCcpOiB2b2lkIHtcbiAgICBjb25zdCBmbGFnID0gZWw8SFRNTFNwYW5FbGVtZW50Pignc2F2ZWRGbGFnJyk7XG4gICAgZmxhZy50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgZmxhZy5oaWRkZW4gPSBmYWxzZTtcbiAgICB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7IGZsYWcuaGlkZGVuID0gdHJ1ZTsgfSwgMV8yMDApO1xufVxuXG5sZXQgc2F2ZVRpbWVyOiBudW1iZXIgfCB1bmRlZmluZWQ7XG5cbi8qKlxuICogVGhlcmUgaXMgbm8gU2F2ZSBidXR0b246IGV2ZXJ5IGNoYW5nZSBwZXJzaXN0cyBvbiBpdHMgb3duIGFmdGVyIGEgc2hvcnRcbiAqIHBhdXNlLiBUaGUgcGF1c2UgaXMgd2hhdCBrZWVwcyBhIHR5cGVkIGRlc2sgbmFtZSBmcm9tIHdyaXRpbmcgc3RvcmFnZSBvbmNlXG4gKiBwZXIga2V5c3Ryb2tlLlxuICovXG5mdW5jdGlvbiBxdWV1ZVNhdmUoKTogdm9pZCB7XG4gICAgd2luZG93LmNsZWFyVGltZW91dChzYXZlVGltZXIpO1xuICAgIHNhdmVUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBjb21taXQoKTsgfSwgMzAwKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY29tbWl0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHsgc2V0dGluZ3MsIGVuZHBvaW50RXJyb3IgfSA9IGNvbGxlY3QoKTtcbiAgICBjdXJyZW50ID0gc2V0dGluZ3M7XG4gICAgYXdhaXQgc2F2ZVNldHRpbmdzKHNldHRpbmdzKTtcbiAgICByZW5kZXJQbGFuKCk7XG4gICAgcmVuZGVyQXV0b05vdGUoKTtcbiAgICByZW5kZXJEZXNrU3RhdGUoKTtcbiAgICBmbGFzaFNhdmVkKGVuZHBvaW50RXJyb3IgPyAnRW5kcG9pbnQgSlNPTiBpbnZhbGlkIFx1MjAxNCBub3Qgc2F2ZWQnIDogJ1NhdmVkJyk7XG59XG5cbmZvciAoY29uc3QgZmllbGQgb2YgW1xuICAgIGZpZWxkcy5lbmFibGVkLCBmaWVsZHMuZGVza05hbWUsIGZpZWxkcy5kZXNrSWQsIGZpZWxkcy5mbG9vcklkLFxuICAgIGZpZWxkcy5zbG90LCBmaWVsZHMuaG9yaXpvbkRheXMsIGZpZWxkcy50aW1lWm9uZSwgZmllbGRzLmVuZHBvaW50LFxuXSkge1xuICAgIGZpZWxkLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIHF1ZXVlU2F2ZSk7XG4gICAgZmllbGQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCBxdWV1ZVNhdmUpO1xufVxuXG4vLyBUaGUgc2F2ZSBpcyBkZWJvdW5jZWQ7IHRoZSB2YWxpZGF0aW9uIG11c3Qgbm90IGJlLCBvciB0aGUgZmllbGQgc3RheXMgcmVkIGZvclxuLy8gYSB0aGlyZCBvZiBhIHNlY29uZCBhZnRlciB5b3UgaGF2ZSBhbHJlYWR5IGZpeGVkIGl0LlxuZm9yIChjb25zdCBmaWVsZCBvZiBbZmllbGRzLmRlc2tOYW1lLCBmaWVsZHMuZGVza0lkXSkge1xuICAgIGZpZWxkLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgcmVuZGVyRGVza1N0YXRlKTtcbn1cbmRheXNIb3N0LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIHF1ZXVlU2F2ZSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBydW4gbG9nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiByZW5kZXJMb2cobG9nOiBSdW5Mb2cgfCB1bmRlZmluZWQpOiB2b2lkIHtcbiAgICBjb25zdCBob3N0ID0gZWw8SFRNTFByZUVsZW1lbnQ+KCdsb2cnKTtcbiAgICBob3N0LnRleHRDb250ZW50ID0gJyc7XG4gICAgaWYgKCFsb2cpIHtcbiAgICAgICAgaG9zdC50ZXh0Q29udGVudCA9ICdObyBydW5zIHlldC4nO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgd2hlbiA9IG5ldyBEYXRlKGxvZy5hdCkudG9Mb2NhbGVTdHJpbmcoKTtcbiAgICBjb25zdCBoZWFkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgaGVhZC50ZXh0Q29udGVudCA9IGAke3doZW59JHtsb2cuZHJ5UnVuID8gJyAgKHByZXZpZXcgXHUyMDE0IG5vdGhpbmcgd2FzIGJvb2tlZCknIDogJyd9YDtcbiAgICBob3N0LmFwcGVuZChoZWFkKTtcblxuICAgIGlmIChsb2cuZXJyb3IpIHtcbiAgICAgICAgY29uc3QgcHJvYmxlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBwcm9ibGVtLmNsYXNzTmFtZSA9ICdzdC1lcnJvcic7XG4gICAgICAgIHByb2JsZW0udGV4dENvbnRlbnQgPSBgZXJyb3I6ICR7bG9nLmVycm9yfWA7XG4gICAgICAgIGhvc3QuYXBwZW5kKHByb2JsZW0pO1xuICAgIH1cblxuICAgIGZvciAoY29uc3Qgbm90ZSBvZiBsb2cubm90ZXMpIHtcbiAgICAgICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBsaW5lLmNsYXNzTmFtZSA9ICdzdC1za2lwcGVkJztcbiAgICAgICAgbGluZS50ZXh0Q29udGVudCA9IGBcdTAwQjcgJHtub3RlfWA7XG4gICAgICAgIGhvc3QuYXBwZW5kKGxpbmUpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3Qgcm93IG9mIGxvZy5yb3dzKSB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgbGluZS5jbGFzc05hbWUgPSBgc3QtJHtyb3cuc3RhdHVzfWA7XG4gICAgICAgIGxpbmUudGV4dENvbnRlbnQgPSBgJHtyb3cuZGF0ZX0gICR7cm93LnN0YXR1c30ke3Jvdy5kZXRhaWwgPyBgICAke3Jvdy5kZXRhaWx9YCA6ICcnfWA7XG4gICAgICAgIGhvc3QuYXBwZW5kKGxpbmUpO1xuICAgIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVuZGVyQ2FwdHVyZXMoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgeyBjYXB0dXJlcyA9IFtdIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoJ2NhcHR1cmVzJykgYXMgeyBjYXB0dXJlcz86IHVua25vd25bXSB9O1xuICAgIGNvbnN0IGhvc3QgPSBlbDxIVE1MUHJlRWxlbWVudD4oJ2NhcHR1cmVzJyk7XG4gICAgaWYgKGNhcHR1cmVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBob3N0LnRleHRDb250ZW50ID0gJ05vdGhpbmcgcmVjb3JkZWQgeWV0Lic7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaG9zdC50ZXh0Q29udGVudCA9IGNhcHR1cmVzLm1hcCgoY2FwdHVyZSkgPT4gSlNPTi5zdHJpbmdpZnkoY2FwdHVyZSwgbnVsbCwgMSkpLmpvaW4oJ1xcblxcbicpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgbG9hZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbnJlbmRlclNldHRpbmdzKGN1cnJlbnQpO1xucmVuZGVyUGxhbigpO1xucmVuZGVyQXV0b05vdGUoKTtcbnJlbmRlckRlc2tTdGF0ZSgpO1xuXG5jb25zdCB7IHJ1bnMgPSBbXSwgbGVhcm5Nb2RlID0gZmFsc2UgfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbJ3J1bnMnLCAnbGVhcm5Nb2RlJ10pIGFzIHtcbiAgICBydW5zPzogUnVuTG9nW107XG4gICAgbGVhcm5Nb2RlPzogYm9vbGVhbjtcbn07XG5maWVsZHMubGVhcm5Nb2RlLmNoZWNrZWQgPSBsZWFybk1vZGU7XG5sYXN0TG9nID0gcnVuc1swXTtcbnJlbmRlckxvZyhydW5zWzBdKTtcbi8vIFRoZSBwbGFuIHdhcyBkcmF3biBiZWZvcmUgdGhlIGxvZyB3YXMgbG9hZGVkLCBzbyBjb2xvdXIgaXQgaW4gbm93LlxucmVuZGVyUGxhbigpO1xuXG4vLyBPcGVuaW5nIHRoZSBwb3B1cCBpcyB3aGF0IG1hcmtzIGEgZmFpbHVyZSBhcyByZWFkLCBzbyB0aGUgYmFkZ2UgY2xlYXJzIGhlcmVcbi8vIHJhdGhlciB0aGFuIHdhaXRpbmcgZm9yIHRoZSBuZXh0IHN1Y2Nlc3NmdWwgcnVuLlxudm9pZCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdwb3B1cC1vcGVuZWQnIH0pLmNhdGNoKCgpID0+IHsgLyogd29ya2VyIGFzbGVlcCAqLyB9KTtcbmF3YWl0IHJlbmRlckNhcHR1cmVzKCk7XG5cbi8vIFx1MjUwMFx1MjUwMCBhY3Rpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiB0cmlnZ2VyUnVuKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIGRyeVJ1bjogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBidXR0b24udGV4dENvbnRlbnQ7XG4gICAgYnV0dG9uLnRleHRDb250ZW50ID0gZHJ5UnVuID8gJ0NoZWNraW5nXHUyMDI2JyA6ICdCb29raW5nXHUyMDI2JztcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBjb21taXQoKTtcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdydW4nLCBkcnlSdW4gfSkgYXMge1xuICAgICAgICAgICAgb2s6IGJvb2xlYW47XG4gICAgICAgICAgICBsb2c/OiBSdW5Mb2c7XG4gICAgICAgICAgICBlcnJvcj86IHN0cmluZztcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKHJlc3BvbnNlLm9rICYmIHJlc3BvbnNlLmxvZykge1xuICAgICAgICAgICAgbGFzdExvZyA9IHJlc3BvbnNlLmxvZztcbiAgICAgICAgICAgIHJlbmRlckxvZyhyZXNwb25zZS5sb2cpO1xuICAgICAgICAgICAgcmVuZGVyUGxhbigpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmVuZGVyTG9nKHtcbiAgICAgICAgICAgICAgICBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICAgICAgICAgIGRyeVJ1bixcbiAgICAgICAgICAgICAgICBkYXRlczogW10sXG4gICAgICAgICAgICAgICAgcm93czogW10sXG4gICAgICAgICAgICAgICAgbm90ZXM6IFtdLFxuICAgICAgICAgICAgICAgIGVycm9yOiByZXNwb25zZS5lcnJvciA/PyAnVW5rbm93biBmYWlsdXJlJyxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJlbmRlckxvZyh7XG4gICAgICAgICAgICBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICAgICAgZHJ5UnVuLFxuICAgICAgICAgICAgZGF0ZXM6IFtdLFxuICAgICAgICAgICAgcm93czogW10sXG4gICAgICAgICAgICBub3RlczogW10sXG4gICAgICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBidXR0b24udGV4dENvbnRlbnQgPSBvcmlnaW5hbDtcbiAgICAgICAgLy8gTm90IGBkaXNhYmxlZCA9IGZhbHNlYDogd2hldGhlciB0aGVzZSBhcmUgdXNhYmxlIGlzIHJlbmRlckRlc2tTdGF0ZSdzXG4gICAgICAgIC8vIGRlY2lzaW9uLCBhbmQgYSBydW4gZG9lcyBub3QgY2hhbmdlIGl0LlxuICAgICAgICByZW5kZXJEZXNrU3RhdGUoKTtcbiAgICB9XG59XG5cbmVsPEhUTUxCdXR0b25FbGVtZW50PigncnVuTm93JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHtcbiAgICB2b2lkIHRyaWdnZXJSdW4oZXZlbnQuY3VycmVudFRhcmdldCBhcyBIVE1MQnV0dG9uRWxlbWVudCwgZmFsc2UpO1xufSk7XG5cbmVsPEhUTUxCdXR0b25FbGVtZW50PignZHJ5UnVuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHtcbiAgICB2b2lkIHRyaWdnZXJSdW4oZXZlbnQuY3VycmVudFRhcmdldCBhcyBIVE1MQnV0dG9uRWxlbWVudCwgdHJ1ZSk7XG59KTtcblxuZmllbGRzLmxlYXJuTW9kZS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgdm9pZCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBsZWFybk1vZGU6IGZpZWxkcy5sZWFybk1vZGUuY2hlY2tlZCB9KTtcbn0pO1xuXG5lbDxIVE1MQnV0dG9uRWxlbWVudD4oJ2NvcHlDYXB0dXJlcycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKGV2ZW50KSA9PiB7XG4gICAgY29uc3QgeyBjYXB0dXJlcyA9IFtdIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoJ2NhcHR1cmVzJykgYXMgeyBjYXB0dXJlcz86IHVua25vd25bXSB9O1xuICAgIGF3YWl0IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KEpTT04uc3RyaW5naWZ5KGNhcHR1cmVzLCBudWxsLCAyKSk7XG4gICAgY29uc3QgYnV0dG9uID0gZXZlbnQuY3VycmVudFRhcmdldCBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbiAgICBjb25zdCBvcmlnaW5hbCA9IGJ1dHRvbi50ZXh0Q29udGVudDtcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSAnQ29waWVkJztcbiAgICB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7IGJ1dHRvbi50ZXh0Q29udGVudCA9IG9yaWdpbmFsOyB9LCAxXzQwMCk7XG59KTtcblxuZWw8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdjbGVhckNhcHR1cmVzJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgY2FwdHVyZXM6IFtdIH0pO1xuICAgIGF3YWl0IHJlbmRlckNhcHR1cmVzKCk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFxS08sSUFBTSxtQkFBNkI7QUFBQTtBQUFBO0FBQUEsRUFHdEMsaUJBQWlCO0FBQUEsRUFDakIsU0FBUztBQUFBO0FBQUE7QUFBQTtBQUFBLEVBSVQsVUFBVTtBQUFBLEVBQ1YsUUFBUTtBQUFBLEVBQ1IsU0FBUztBQUFBLEVBQ1QsWUFBWTtBQUFBLEVBQ1osVUFBVSxDQUFDLFVBQVUsV0FBVyxhQUFhLFlBQVksUUFBUTtBQUFBLEVBQ2pFLE1BQU07QUFBQSxFQUNOLGFBQWE7QUFBQSxFQUNiLFdBQVcsQ0FBQztBQUFBLEVBQ1osVUFBVTtBQUFBLEVB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
