# Note timeline — design

Approved by the user on the mockup canvas (screens 1, 2, 3, 5, 6; screen 4's
time column was the alternative not chosen). Builders: this is the contract.

## Intent

A SOC analyst writes an incident's sequence of events as plain bullets in the
case note ("## Findings"). He wants those bullets drawn as a polished event
timeline right in the note, reached by right-click like "Defang selection", and
he wants to **edit the box itself, not type special characters**. Nothing goes
into the ticket (no case fields, no frontmatter, nothing in the side panel).

## The note format (what is saved)

```
## Findings:
%% timeline %%
- On 3 May 2025, 11:04 the user was observed using Microsoft Edge …
- At 11:05:40, the user was observed visiting hxxps://eemmbryequo[.]shop/ (…).
    - Following the navigation, the webpage hosted a script …
- At 11:06:12, Execution: the user opened Run (Win+R) and pasted `powershell …` (T1204.004)
- At 11:06:15, Download: the payload was fetched from promptcraft[.]online.
    - Source: EDR process tree
- At 11:31, Detection: XDR raised "Suspicious PowerShell download cradle" on corp-wks-102.
- Response: the SOC isolated corp-wks-102 from the network.
```

- The marker line `%% timeline %%` (an Obsidian comment, exact text, optional
  surrounding whitespace) turns on the timeline for the list directly below it.
  The block runs from the first `- `/`* `/`+ ` bullet line after the marker
  until the first line that is not a bullet, an indented sub-bullet or
  continuation, or a single blank line followed by another bullet. A heading or
  two blank lines end it.
- Each top-level bullet is one event; indented lines under it are its details.
- With the plugin off it is an ordinary bullet list; the marker is invisible in
  Reading view. The analyst never has to type the marker: the menu adds it.

## Reading a bullet (pure parser, `src/timeline/parse.ts`)

- **Time**: only a time the bullet STARTS with (after optional lead words
  `On`, `At`, `Around`, `About`, `Approx.`, `Approximately`, `~`, `By`,
  case-insensitive). A time in the middle of a sentence is never used.
  Accepted: `3 May 2025, 11:04`, `May 3, 2025 11:04`, `2025-05-03 11:04[:00]`,
  `2025-05-03T11:04:00Z`, `11:05`, `11:05:40`, `11:05:40.123`, `11:04 AM/PM`,
  ranges `11:06–11:08` / `11:06-11:08`, optional zone `UTC|GMT|Z|±HH:MM`
  (kept as written, never converted). A date-only start (`On 3 May 2025,`)
  gives a date with no time. The time phrase ends at `,`, ` -`, ` –`, `:`
  followed by space, or a space. Numeric slash dates (`03/05/2025`) are NOT
  read (day/month order unknown): the bullet counts as "time not recorded" and
  gets `unread` = the token.
- A stated date carries forward to the time-only bullets after it.
- `approx` when lead word is Around/About/Approx./Approximately/`~`.
- No time → "time not recorded" (display only, never written). A leading token
  that looks like a time but is not valid (`11:4`, `25:10`) sets `unread`.
- **Kind** (explicit): a word + `:` right after the time phrase (or at the
  start when untimed), case-insensitive: Detection|Alert → detection;
  Response|Containment|Action → response; Execution → execution; Web → web;
  File|Download → file; Email → email. Its character span is reported.
- **Kind** (derived, only when none explicit): inline code span or a shell /
  LOLBin word (powershell, pwsh, cmd, mshta, rundll32, regsvr32, certutil,
  wscript, cscript, bitsadmin) or an executable extension (.exe .ps1 .hta
  .dll .bat .vbs .js .scr) → execution; a hash or a Windows/Unix path → file;
  a URL, domain or IP → web; an email address → email; else observed.
  Precedence execution > file > web > email. Detection/Response are never
  derived. Use `extractIocsFromText`/`detectIocType`/`hasIocShape`/`refangIoc`
  from `src/soc/ioc.ts`.
- **Indicators**: character spans of URLs/domains/IPs/hashes/emails in the
  bullet text (defanged or not), each with `live: boolean` = defangText would
  change it. **ATT&CK**: spans of `T####` / `T####.###`.
- **Key event**: the bullet text (after the time phrase/kind) starts with
  `**…**`.
- **Source footer**: a detail line whose text starts with `Source:`.
- **Gaps** (derived, between consecutive timed events): precision is the
  coarser of the two times (seconds only if both have seconds); label `+32 s`,
  `+1 min`, `+1 h 5 min`, `same minute`; `≈` prefix if either is approx;
  `long` when ≥ 15 min (label `25 min later`); `outOfOrder` when the later
  event's time is earlier (label `earlier than the event above`, no number);
  across a date change: `13 h later` style with a day band. Never across an
  untimed event; never assume midnight rollover (time-only going backwards =
  outOfOrder).
- **Summary**: event count, first stated date, first/last time, span label
  (derived), untimed count, live-indicator count.

## Look (Live Preview and Reading view; CSS `src/styles/note-timeline.css`)

Prefix every class `cf-ntl-`. Build only from Obsidian theme variables
(`--background-primary/secondary`, `--background-modifier-border(-hover)`,
`--text-normal/muted/faint`, `--color-red/orange/green/cyan/purple/yellow`,
`--color-*-rgb`, `--font-monospace`, `--interactive-accent`) so light and dark
both work; never the plugin's dark-only `--gs-*` tokens. Matches mockup
screen 2 (dark).

- Header (the marker line): 28–32px strip with bottom hairline: lucide
  `git-commit-vertical` icon, `TIMELINE` (11px, 700, letter-spacing .08em,
  muted), meta `6 events · 3 May 2025 · 11:04 → 11:31 · 27 min span [derived] ·
  1 without a time` (12.5px, faint), a live-indicator pill `1 live indicator ·
  Defang` when any, and a `more-horizontal` button (aria-label "Timeline
  menu") opening the timeline menu.
- Rail: 2px line at x=15px through all events; node 22px circle on the rail
  level with the card's first line. Observed: 10px hollow faint ring. Derived
  kind: outlined ring + icon in the kind colour. Explicit kind: filled with the
  kind colour, icon in `--background-primary`. Icons (lucide via `setIcon`):
  web `globe`, execution `terminal`, file `file`, email `mail`, detection
  `siren`, response `shield-check`. Key event: larger node + 3px accent bar.
- Card: `--background-secondary`, 1px border, radius 8px, padding 9px 13px,
  note font, `overflow-wrap:anywhere`. Detection card tinted red with a 3px
  red inset left edge; Response tinted green likewise.
- Time chip: monospace, tabular-nums, 0.85em, bg `--background-modifier-hover`;
  seconds a step smaller and muted; lead words (On/At) and the comma muted;
  approx → dashed chip border; untimed → italic dashed chip "time not
  recorded".
- Kind tag: the kind word in small caps (11px, 700, .07em) in the kind
  colour (light theme: `color-mix(in srgb, var(--color-x) 65%, var(--text-normal))`
  for 4.5:1); the colon faint.
- Indicator chip: monospace, subtle bg + border, type icon; a live one gets a
  wavy yellow underline (Live Preview) and is shown defanged in Reading view.
  ATT&CK: outline pill, no link.
- Gap band above each card: dashed pill (`+32 s`); long gap: taller band, rail
  break mark, italic `25 min later`; out of order: yellow pill with arrow-up;
  date change: day band `4 MAY 2025 · 13 h later [derived]`.
- Source footer: dashed hairline, `file-search` icon, muted 12.5px.
- Active card (Live Preview, caret inside): accent border + soft glow.
- `+ Add event` row under the last card (dashed, faint) — click adds an event.
- Narrow (< 520px or `body.is-mobile`): 24px indent, 18px nodes, header wraps,
  touch targets ≥ 44px. Print: `break-inside: avoid` on cards, no tints.
- Hover: card border tinted kind colour; 120ms; none under
  `prefers-reduced-motion`.

## Editing — "edit the box itself"

- Live Preview keeps every card drawn while the caret is inside it (no raw
  reveal). The native list bullet is hidden with `visibility:hidden` (width
  kept, caret positions unchanged). The marker line is replaced by the header
  widget and is an atomic range, so the caret never lands in `%%`.
- Typing in a card edits the bullet text; Enter at the end of an event makes a
  new event (Obsidian's list continuation); Tab makes a detail line.
- Click the node or the kind tag → kind picker menu (Auto (from the text),
  Detection, Response, Execution, Web, File / Download, Email). Picking writes
  or replaces the kind word + `: ` after the time phrase (`At 11:06:12,
  Execution: …`); Auto removes it. One undo step.
- Click `+ Add event` → inserts `- ` after the last event's last detail line
  and puts the caret there; the empty card shows the ghost hint
  `11:07  what happened…` (display only).

## Menu (editor right-click, beside "Defang selection"; same section)

Outside a timeline, caret in a bullet list or a selection: **Make timeline**
(inserts the marker line directly above the list's first line; selected
non-bullet lines are prefixed `- `; one undo step).

Inside a timeline (caret on the marker or any event line): **Add event
below**, **Move event up** (hidden on the first), **Move event down** (hidden
on the last), **Set event kind…** (the picker), **Sort events by time** (only
when out of order; disabled with a reason when an event has no time or day
order is unknown), **Delete event**, **Defang timeline** (defangText over event
lines, notice like defangInPlace), **Copy timeline for ticket**, **Back to plain
list** (removes only the marker line). Every item is also a command with
`editorCheckCallback` (no default hotkeys) for mobile toolbars.

**Copy timeline for ticket** (mockup screen 6): plain text, defanged via
`copyDefanged`, marker and bullet syntax stripped:

```
Timeline, 3 May 2025 (6 events)
11:04      User observed using Microsoft Edge …
11:05:40   User observed visiting hxxps://eemmbryequo[.]shop/ (…).
           Following the navigation, the webpage hosted a script …
11:06:12   Execution: user opened Run …
--:--      Response: SOC isolated corp-wks-102 from the network. (time not recorded)
```
(The time column is the time as written; the text is the bullet with its
leading time phrase and lead word removed; detail lines indent under it;
`Source:` lines join the event line.)

## Constraints

- Zero runtime dependencies; CM6 from Obsidian's externals only.
- No `innerHTML`; DOM via `createEl/createSpan/setIcon`; no network; nothing
  fetched; links in a timeline in Reading view are neutralised (a click copies
  defanged, never opens).
- Lint: eslint-plugin-obsidianmd type-checked at zero warnings; oxlint; oxfmt;
  sentence-case UI strings; `window.setTimeout`; no regex lookbehind.
- The CM6 extension applies to Obsidian's markdown editors only (not the
  plugin's own description editor) and never uses vertical margins or block
  widgets from a ViewPlugin (padding/transparent borders + inline widgets).
- Different name, icon and CSS prefix from the existing read-only "Case
  timeline" pane (`history`, `pm-tl-`).

## Left out (not built now)

Alternating sides, drag-and-drop, writing anything to the ticket, a "log
response now" clock command, a day/month setting for numeric dates, "copy as
table".
