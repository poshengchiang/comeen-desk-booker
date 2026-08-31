# Comeen desk booker

Books your desk in [Comeen](https://my.comeen.io/) for the coming weekdays, so you stop clicking
through the floor plan every week. Comeen's own recurring-presence feature auto-assigns a desk and
cannot pin a specific one — this can.

---

## Setup

**You do not need to install any developer tools.** No Node, no terminal, no build step. The
ready-to-load files are already in this repository. Ten minutes, once.

### 1. Download the code

On this repository's GitHub page: green **Code** button → **Download ZIP**.

Unzip it, then **move the folder somewhere permanent** — your home folder or Documents is fine.
Chrome loads the extension from wherever this folder sits and keeps reading from it, so if you
leave it in Downloads and later clear that out, the extension stops working.

Inside you will find a folder called `dist`. That is the one Chrome wants. Do not go looking
inside it.

### 2. Open Chrome's extensions page

Type `chrome://extensions` in the address bar and press Enter. (It will not work from a
bookmark or a link — Chrome only opens it if you type it.)

### 3. Turn on Developer mode

Top right of that page, there is a switch labelled **Developer mode**. Turn it on. Three new
buttons appear along the top left.

This is normal. It is what Chrome calls loading an extension that did not come from its store.

### 4. Load the extension

Click **Load unpacked** (top left), then select the **`dist`** folder from step 1 and confirm.

**What you should see:** a card appears titled *Comeen desk booker*, version 0.1.0, with a blue
square icon showing a desk. If instead you get *"Manifest file is missing or unreadable"*, you
selected the wrong folder — go back and pick `dist` itself, not the folder containing it.

### 5. Pin it to the toolbar

Click the jigsaw-piece icon at the right end of Chrome's toolbar, find **Comeen desk booker**, and
click the pin next to it. The blue desk icon now sits in your toolbar.

### 6. Sign in to Comeen

Open [my.comeen.io](https://my.comeen.io/) in this same Chrome and sign in as you normally would.

This matters: the extension has no password of its own and never asks for one. It books using the
session you are already signed into. If you are not signed in, it cannot do anything — and it will
tell you so rather than failing quietly.

### 7. Set it up

Click the blue desk icon to open the panel.

| Field | What to put |
|---|---|
| **Desk** | The number printed on your desk, like `3-23`. Digits, a dash, digits. |
| **Floor** | Pick from the list. |
| **Building** | Shown for information; there is only one. |
| **Weekdays** | Tick the days you *actually* come in. See the note at the very bottom. |
| **Slot** | Leave on *All day* unless you want half a day. |
| **Book ahead** | How far in advance to book. 14 days is a sensible default. |

There is no Save button — everything saves itself as you type, and a small *Saved* flashes at the
top when it does.

If the desk number is wrong you will see it turn red with an explanation, and the buttons stay
greyed out until it is a real desk number. Nothing can be booked by accident.

### 8. Look at the booking plan

Under the fields is a two-month calendar. **Blue squares are the days it is going to book.** Check
they look right.

Going away for a week? Click those days and they grey out and get crossed through — those are now
skipped. Click again to bring them back. **Days beyond the booking window can be marked too** — if
you already know you are away in six weeks, mark it now and it will be remembered when the window
reaches it.

Once a run has happened the colours also show what was actually found: **green** is a day you
already hold, **amber** a day somebody else has, **red** a day that failed. The line above the
calendar says when those colours were taken, since a run from days ago can still show green for a
desk since given away.

**To give up a day you have booked**, click its green square. It keeps the green fill and gains a
red outline: that booking will be cancelled on the next run, and the day is skipped so nothing
re-books it. Click again to keep it after all. Nothing is cancelled until a run happens, and
**Preview** will tell you what it is about to remove without removing anything.

### 9. Preview, then book

Press **Preview**. Nothing gets booked; it just reports what would happen. You should see a line
per day. Statuses mean:

| Status | Meaning |
|---|---|
| `dry-run` | Free, would be booked |
| `skipped` | You already have that day |
| `unavailable` | Somebody else has your desk that day |
| `cancelled` | A booking you asked to give up has been removed |
| `error` | Something went wrong; the line says what |

Happy with it? Press **Book now**. Then open Comeen in a tab and confirm the days really are
there — trust it once you have seen it work, not before.

### 10. Turn on Book automatically

Flip the **Book automatically** switch. From now on it tops up your bookings by itself, about every
six hours.

It only runs while Chrome is open. That is fine and it is by design: each run re-books the whole
window and skips days you already have, so a closed laptop over a weekend just means it catches up
on Monday. Nothing is lost.

---

## Two things that will happen, and are not faults

**Chrome will warn you about developer mode.** Every so often on startup you may get *"Disable
developer mode extensions"*. Click the **x** to dismiss it. Do not click Disable. This happens to
every extension not installed from the Chrome Web Store.

**Do not delete or move the folder.** Chrome reads the extension from that exact path every time it
starts. Moving it means loading it again from step 4.

## When something is wrong

The extension tells you, in three places, so you never have to wonder whether it is still working:

- **A red `!` on the icon** means the last run failed. Open the panel and look at **Last run**.
- **A notification** appears if your Comeen session has expired. Click it to sign in.
- **Last run** in the panel always holds the detail of the most recent attempt.

| What you see | What it means | What to do |
|---|---|---|
| *Not signed in to Comeen* | Your session expired | Open my.comeen.io and sign in. **It then retries on its own** — you do not need to press anything. |
| *Pick your desk in the popup first* | No desk set | Fill in the Desk field. |
| `unavailable` on some days | Someone else booked your desk | Nothing to fix. Book a different desk that day, by hand, if you need one. |
| Nothing happens at all | Automatic is off | Turn on **Book automatically**. |
| Panel will not open | The extension was unloaded | Redo step 4. |

---

## For developers

`dist/` is committed precisely so nobody needs this section to *use* the thing. To change it:

```bash
npm install
npm run build      # or: npm run watch
npm test           # 49 tests
npm run typecheck
```

Then reload the extension in `chrome://extensions` — and reload any open Comeen tab, or its
already-injected content scripts keep running the previous build and complain about an invalidated
context.

### Why an extension rather than a script

Comeen only offers Google SSO, so there is no password a script can use. A server-side or cron
version therefore has to store a long-lived credential scraped out of the browser — which routes
around the SSO controls that exist for central revocation and MFA, and survives offboarding
invisibly. That is the part worth avoiding.

This extension never stores a credential. The booking requests run **inside the Comeen tab, in the
page's own JavaScript world**, so the session is simply ambient. It is read there, used there, and
discarded there — never returned to the extension, never written to `chrome.storage`, never leaving
the tab. The extension holds configuration only.

The trade is that it can only run while Chrome is running, which the booking horizon makes
harmless.

### Desk resolution

The desk ID is looked up from the desk name on every run, so nobody needs to know the internal
UUID — leave that field empty. Resolving every time rather than caching also means the lookup can
supply the desk's `area_id`, which the booking body needs, and a renumbered desk corrects itself.

## Where the API contract came from

Comeen publishes a Workplace API v2, but its OpenAPI spec is served as a binary download that is
not publicly readable, and `my.comeen.io` redirects to the login page server-side when signed out.
So the contract was recovered the only way left: by capturing a real booking.

**It is now verified** (August 2026) and shipped in `DEFAULT_SETTINGS`. Nobody needs to repeat this
unless Comeen changes something. If they do:

1. In your normal Chrome, on `my.comeen.io`, open DevTools → **Network** and tick **Preserve log**.
2. Hard-reload, open the floor plan, and book one day by hand.
3. Right-click the request list → **Export HAR (sanitized)**.
4. `node tools/har.mjs ~/Downloads/my.comeen.io.har && node tools/analyze.mjs`

The analyzer prints one section per unknown — apiBase, auth mode, create, list/resolve — and you
edit `DEFAULT_SETTINGS.endpoint` from it. **Bump `endpointVersion` in the same edit**, or anyone who
has ever pressed Save keeps their stale copy forever. A test covers exactly that.

`tools/har.mjs` re-redacts credential headers on the way in and refuses to be quiet about it if the
HAR was exported unsanitized, so `.discovery/` never holds a token even by accident.

Do not reach for browser automation here. Playwright can only attach to a Chrome it launched with a
debugging port, and Chrome ≥136 refuses to enable remote debugging on the default profile — that is
the anti-cookie-theft measure, and it means your signed-in window is off limits by design. A fresh
profile gets past that and then fails Google's risk check instead. The reasoning is written out at
the top of `tools/har.mjs`.

The popup's **Learn mode** captures the same requests from inside Chrome and still works — Comeen's
API lives at `my.comeen.io/api/...`, which its filter matches. It redacts Authorization and Cookie
values before storing, keeps captures in `chrome.storage.local` only, and truncates bodies to 2 KB.

## Endpoint config

The whole API contract is data, not code, so you can fix it from the popup without rebuilding.
Placeholders: `{{date}}`, `{{deskId}}`, `{{deskName}}`, `{{slot}}`, `{{startTime}}`, `{{endTime}}`,
`{{from}}`, `{{to}}`, `{{userId}}`, `{{floorId}}`, `{{buildingId}}`, `{{areaId}}`.

A placeholder that makes up the *entire* value and resolves to an integer is emitted as a JSON
number, because Comeen wants `building_id: 5151` and not `"5151"`. Interpolation into a longer
string always stays a string, which is what a URL path needs.

```json
{
  "apiBase": "https://my.comeen.io/api",
  "auth": { "mode": "cookie" },
  "resolve": {
    "method": "GET",
    "path": "/v1/floors/{{floorId}}/desks_schedule.json",
    "query": { "start_date": "{{from}}T00:00:00.000Z", "end_date": "{{to}}T23:59:59.000Z" }
  },
  "deskNameFields": ["name", "sync_id"],
  "deskIdFields": ["uuid", "id"],
  "list": {
    "method": "GET",
    "path": "/v1/users/me/work_activity_schedule.json",
    "query": { "start_date": "{{from}}T00:00:00.000Z", "end_date": "{{to}}T23:59:59.000Z" }
  },
  "listRoot": "schedule",
  "listShape": "dateKeyedMap",
  "userIdPath": "user.id",
  "create": {
    "method": "POST",
    "path": "/v1/users/{{userId}}/work_activity_schedule.json",
    "body": {
      "work_activity": {
        "state": "on_site",
        "start_datetime": "{{date}}T{{startTime}}",
        "end_datetime": "{{date}}T{{endTime}}"
      },
      "presence": { "building_id": "{{buildingId}}", "floor_id": "{{floorId}}", "area_id": "{{areaId}}" },
      "desk_booking": { "desk_uuid": "{{deskId}}" }
    }
  }
}
```

Four things about this are worth knowing, because each contradicts a reasonable guess:

- `apiBase` is the SPA's **own origin**, not `api.comeen.io` where the public docs live. It is a
  Rails backend behind a Nuxt front end, hence the `.json` suffixes.
- The API version varies per endpoint, so it lives in each path rather than in `apiBase`.
- A desk's id is `uuid`. Desks have no `id` field at all.
- The bookings list is **keyed by date** — the date is not a field on an entry — which is what
  `listShape: "dateKeyedMap"` is for. Sniffing field names would never have found it.
- Datetimes go out as `2026-09-01T00:00:00.000Z` and come back as `2026-09-01T00:00:00`: a local
  wall-clock time wearing a `Z`. The day is used verbatim and nothing converts timezones.

A booking is really a *work activity* with a desk attached, not a desk booking as such.

If Comeen ever moves to a bearer token in `localStorage` rather than a cookie, switch `auth` to:

```json
{
  "mode": "localStorage",
  "storageKey": "<key>",
  "jsonPath": "<dotted.path.to.token>",
  "header": "authorization",
  "prefix": "Bearer "
}
```

That value is still read inside the page and used there. It is not copied anywhere.

## When it runs, and what it needs

`chrome.alarms` fires **every 6 hours**, plus once on browser startup so a fresh Chrome catches up
immediately. **Book now** ignores the automatic switch and runs on demand.

There is no retry ladder. A failed run logs and waits for the next tick — the next scheduled run is
the retry. That is affordable precisely because of the 14-day horizon and idempotency: you would
have to miss about two weeks of runs before actually losing a day.

**You do not need a Comeen tab open.** If none exists the extension opens one in the background,
waits for it to load, runs, and closes it again. It only ever closes tabs it opened itself; an
existing Comeen tab is reused and left alone.

**If your session has expired**, both paths say so plainly rather than failing obscurely:

- the background tab redirects to sign-in, and the run stops with *"Not signed in to Comeen (the
  page redirected to sign-in)"* — `accounts.comeen.io` is deliberately absent from
  `host_permissions`, so this is caught by checking the URL rather than by widening the
  extension's reach;
- an API call that comes back 401/403, redirected to the accounts host, or carrying an HTML login
  page under a 200, is reported as *"Not signed in to Comeen. Open https://my.comeen.io/, sign in,
  then run again."*

That last case is the one worth having a test for. A login page served with 200 parses to `null`,
which downstream looks exactly like an empty result — so the old behaviour was to announce "No desk
called 3-23", sending you to look in entirely the wrong place.

### Being told about it

Writing a failure into storage and rendering it only if someone opens the popup is the same as not
reporting it. An automatic run that fails at 3am has to surface somewhere, or you quietly stop
having a desk booked and never find out why. So:

- **Badge.** Any failed run puts a red `!` on the extension icon; the next successful run clears it.
  No new permission — the action icon was already there.
- **Notification** on an expired session, with a fixed id so a session that stays dead replaces its
  own notification instead of stacking. Clicking it opens Comeen. This is what `notifications` in
  the manifest is for, and the only reason the extension needs an icon file at all.
- **Automatic retry.** When a Comeen page finishes loading after a signed-out failure, the missed
  run happens by itself. You sign in the way you always would, and it catches up — no button to
  find. Only the automatic path self-heals: with automatic off, every run is one you asked for, and
  a surprise booking would not be.

Runs are also serialised behind a single in-flight promise. Two overlapping runs would each read the
bookings list before the other had written anything, conclude the same day was free, and both try to
book it.

## What is verified, and what is not

Verified: the API contract, against a real captured booking. The date planning (UTC-midnight
boundary, October DST change), placeholder substitution including the number/string rule, settings
merging across an `endpointVersion` bump, and the whole in-page booking path — desk resolution by
uuid, date-keyed idempotency, contention, expired sessions, and failure handling — under 49 unit
tests, including the desk-name format rule the popup and the background script both enforce.
TypeScript strict mode. Bundle shape: content scripts as classic IIFEs, and `bookInPage` self-contained after
bundling.

`auth.mode: "cookie"` is confirmed too, though not from the capture — Chrome's HAR sanitizer strips
`Cookie` and `Authorization` outright rather than blanking them, so their absence proved nothing
either way. It was settled by calling the list endpoint from the page console with
`credentials: "include"` and no auth header, which returned 200.

Not verified: the `morning` and `afternoon` slots. Only `all_day` was captured; the half-day
times in `SLOT_TIMES` are a reading of the same scheme, not an observed one.

## Layout

```
src/background.ts        alarms, tab handling, orchestration
src/injected.ts          runs in the page world — the credential never leaves here
src/content-recorder.ts  learn mode: patches fetch/XHR in the page world
src/content-bridge.ts    learn mode: relays captures to extension storage
src/core/dates.ts        weekday/horizon/timezone maths (shared with the Actor version)
src/core/config.ts       settings, endpoint config, placeholder substitution
src/popup.ts             the UI
tools/har.mjs            DevTools HAR → capture format
tools/analyze.mjs        capture → the five answers the endpoint config needs
tools/make-icons.mjs     regenerates the icon PNGs from a few numbers
```

```bash
npm run typecheck
npm test        # 49 tests
npm run watch   # rebuild on change; still needs a reload in chrome://extensions
```

## One caveat that is not technical

Booking five days a week when you come in three is what desk-hoarding rules exist to stop. Comeen
can auto-release a desk you do not check into, which softens it, but the honest fix is to set
**Weekdays** to the days you actually come in.
