# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Folded in across 2.2.x–2.4.x

Everything in this section shipped long ago (it predated the versioned
entries below and was mislabelled "Unreleased" until 2026-09-14).

### Changed (severity replaces priority)

- Severity is the single urgency dial: renamed to Critical/High/Medium/Low and available on every task type (SLA clocks still run on incidents only)
- The query bar accepts severity labels as well as ids (`sev:>=high` and `sev:>=sev2` both work)
- Priority is gone from the UI (editors, board, table, filters, settings); existing files and saved `prio:` queries keep working unchanged

### Added

- Priorities can be added, renamed, recolored, and reordered in settings
- Status and priority icons accept emoji or any icon available in Obsidian, including Lucide icons and icons added by other plugins, with suggestions while typing in settings
- TaskNotes tasks can be imported with their dates, dependencies, subtasks, tags, and archive state
- Statuses and priorities can be imported from TaskNotes in settings
- Projects can define their own statuses and priorities in the project settings, replacing the global ones
- Projects can override the default view, auto-scheduling, and the board display options in the project settings
- The completed date shows whether a task finished on time or how many days late it was

### Changed

- Add buttons in the table, Gantt, project editor, and settings share one quiet style
- Remove buttons in the task editor, project editor, and settings are icon buttons with tooltips
- The import dialog uses Obsidian's native buttons
- The Gantt zoom control uses Obsidian's native buttons
- Filter and saved-view buttons match Obsidian's native buttons, with an accent tint when active
- The cursor lands where a task description was clicked when the editor opens

### Fixed

- Start and completed dates were labelled overdue in the task editor
- The due date of a done task was labelled overdue in the task editor
- The due date of a done task was highlighted as urgent in the table
- Text and images in a task description could not be selected or copied
- A task description rewrapped its text when clicked for editing
- Searching for a task by its id found nothing
- The import dialog offered the built-in statuses and priorities instead of the configured ones

## [2.29.1] - 2026-09-21

### Changed

- **The assignee avatar moved to the bottom-right of the card.** It rides the
  end of the chip row rather than sitting beside the title, so it lands in the
  card's corner however the chips above it wrap, the title gets the full card
  width back (two-line titles often become one), and the card is no taller for
  it. A due date, which travelled with the avatar, moves with it.

- **Auto-archive counts from the moment a case landed in a closing status**,
  read off the append-only log, which carries a full datetime. A two-day
  window is now 48 hours from the move. It used to be whole calendar days from
  the completion date, so a case closed at 23:50 was swept about 25 hours
  later. Moving a case between two closing statuses restarts the clock, and a
  case whose log never recorded the move still falls back to its completion
  date. Still off until you set a window (`0` = off), in **Settings →
  Auto-archive**.

### Fixed (two things a live pass through the boards turned up)

- **Opening a case and closing it again no longer claims you edited it.** The
  time-tracking panel created the empty log list while it was drawing itself,
  so the case differed from the copy the editor opened with before you touched
  anything: Cancel asked "discard unsaved changes?" on every case, and with
  *Save on close* on, shutting an untouched case wrote the note and stamped it.
  The panel now reads the list without creating it; the Log time button still
  creates it when there is a row to put in it.
- **A case that is already past its deadline counts as breached in Reports,
  not as still running.** Compliance asked "has the clock stopped?" before "has
  the deadline passed?", so a live overdue case fell out of the denominator
  entirely — a board whose every open case was hours overdue still read
  **100% targets met**. A deadline that has gone by is a fact, not a pending
  outcome, so it now counts where it happened. On the LetsDefend board this
  moves the tile from 100% to 80%.

## [2.29.0] - 2026-09-20

### Changed (two bits of furniture you can now turn off)

- **The `Project: [[Board]]` line at the foot of every task note is gone by
  default.** It was only an Obsidian backlink — the plugin finds a task's board
  from its folder, never from that line — so losing it costs the graph edge and
  nothing else. Notes that already have it keep it until each one is next
  saved, and the reader still strips the line either way, so nothing breaks in
  the meantime. **Settings → Note layout** turns it back on.
- **The incident timeline panel is hidden by default.** Since intake stopped
  inventing a detection time, most cases have all five stamps empty, so the
  panel was five empty date fields under every ticket. The stamps are
  unaffected: they still drive the response clock and still print in the case
  timeline and the case report. Turn the panel on in **Settings → Note layout**
  to set one by hand.

### Fixed

- The task detail panel showed the severity badge and the indicators section on
  a plain board. Both are case-board chrome; 2.28.0 gated the modal and the
  board but missed the panel.

## [2.28.0] - 2026-09-20

### Added (board types)

- A board now declares what kind it is when you create it.
  - **Case board** — the full kit: severity, response clocks, verdicts,
    indicators, the incident timeline and alert intake.
  - **Plain board** — columns and cards only. Use it for goals, investigations
    and anything that is not a case queue.
- **Hiding is not deleting.** A plain board hides the SOC fields; it never
  strips them. A note that already carries a severity, a verdict or indicators
  keeps them in its frontmatter, and switching the board back to Case shows
  them again. There is a test for exactly this.
- Every board that already exists is a Case board. No key is written for one,
  so existing board notes are byte-identical and nothing is migrated.
- A plain board also drops the Severity column from the table, the four
  incident charts from Reports, and refuses alert intake and case reports with
  a sentence saying why rather than producing an artifact full of
  "not recorded".
- The shift handover leaves plain boards out of **Open incidents** only, and
  says so inside that section. Every other section still walks every board,
  because "Waiting" and "Changed in the last Nh" are not SOC-specific.

### Added (switching boards)

- The board icon in the toolbar is now the **board menu**: every board, the one
  you are on ticked, switching in the leaf you are already standing in. New
  board and Edit this board are in the same menu. It used to open the settings
  dialog that the gear two controls away already opened.
- **Switch board** is also a palette command.

### Changed (a board is called a board)

- The palette, the boards pane, the create dialog and the board toolbar now say
  "board" instead of "project". Command IDs, folder names and frontmatter keys
  are unchanged, so hotkeys, saved views and existing notes are unaffected.
- The new-board dialog no longer pre-fills the name with "New Project", which
  had the side effect of creating a vault folder literally called that if you
  clicked straight through.

## [2.27.1] - 2026-09-20

### Changed

- The board card has a little more room again: vertical padding and the gap
  between its two rows are up, so a one-line card sits at about 76px and a
  two-line one at about 100px. The side padding is deliberately unchanged —
  in a narrow column the chips sit close to the wrap threshold, and content
  width is worth more there than symmetry.

## [2.27.0] - 2026-09-20

### Added (closed cases file themselves away)

- **Settings → Auto-archive → Archive closed cases after (days)**. A case moves
  into its project's Archive folder that many days after the date it was
  completed. **0 turns it off, and 0 is the default** — this moves your files,
  so it does not start without you asking.
- What it will never do, deliberately:
  - move a case with no completion date, or one it cannot read, or one dated in
    the future. The clock has to be a recorded fact.
  - decide "closed" from the id `done`. It reads the terminal flag on your own
    status list, so a closing status you renamed or added still counts.
  - take a case twice. Every archive and unarchive now writes an entry in the
    case timeline, and that entry is what disarms the sweep: **a case you
    unarchive is never taken again**, it stays on the board until you archive
    it by hand.
  - drag open work into Archive. Archiving a parent carries its subtree, so a
    case whose subtree still holds an open task is held back.
- Every move is announced with a count and is reversible from the case menu.
- Archiving by hand is now recorded in the case timeline too, which it never
  was before.

## [2.26.0] - 2026-09-20

### Fixed (your alerts parse now — this was losing data on every paste)

- Real alerts arrive already formatted, as `**Rule :** \`SOC138 - …\``. The
  field parser read the key as `**rule`, so it matched nothing: **the title,
  the severity and the event time were all being dropped on every formatted
  paste**, and the case title fell back to whatever the first line happened to
  be. Emphasis and code ticks are now stripped from both the key and the value.
  Underscores are deliberately left alone, because they live inside real
  hostnames and filenames.

### Added (an icon that says what kind of alert it is)

- Every incident drew the same siren, which says nothing on a SOC board. A case
  that records its kind now shows that kind's glyph: phishing, malware,
  suspicious file, credential compromise, web attack, suspicious network. The
  kinds are an editable catalog and the tooltip still names the issue type.
- The kind is a plain tag on the case, so nothing new is stored and the note
  stays portable. A case with no matching tag keeps the siren: the kind is then
  not recorded, and guessing one at render time would be a claim about meaning.
- Alert intake suggests a kind from the title and shows **the exact word that
  matched**, so you can see why. It becomes a tag only when you create the case,
  and it can be cleared.
- **Tag alert kinds on this project** in the palette does the same for cases you
  already have. It lists every proposed tag with its matching word, writes only
  on confirm, never overwrites a kind you already set, and counts the cases it
  could not name instead of guessing at them.

### Changed (four default statuses)

- A fresh vault now ships **To Do · In Progress · User Response · Done**.
- Existing vaults are upgraded by **insertion only**: User Response is added
  before your first terminal status and *nothing is removed, renamed or
  reordered*. A status you edited or kept on purpose survives, and no case is
  ever left pointing at an id your list no longer defines. It runs once, so a
  User Response you delete is not resurrected.
- The handover's **Blocked** section is now **Waiting**, and it lists both the
  new status and the old `blocked` id that older vaults still use, by its
  configured label rather than the raw id.

## [2.25.1] - 2026-09-20

### Added (the shift handover you can actually find)

- The handover existed only as a palette command whose name you had to already
  know, and it wrote the note first and showed it second. It now opens a
  preview: the exact markdown, on screen, before anything is written.
- Three ways in: the ribbon icon, a **Shift handover** button in the board
  header, and the palette command (renamed from "Generate shift handover").
- **Copy** puts the same string on the clipboard that you just read. **Write**
  saves it to the configured note and opens it. Nothing is written until you
  choose one.
- Vault-wide on purpose, and board filters deliberately do not apply — a
  filtered handover would silently drop incidents the next shift owns.
- It composes once on open, so what you read and what the buttons emit cannot
  drift apart.

### Fixed

- 2.25.0 shipped the handover wiring without the file it imports, so the plugin
  did not build from a clean checkout. Corrected here.

## [2.25.0] - 2026-09-20

### Changed (the board gets its space back)

- The card was cut too far in 2.22 and read as cramped. Padding and the gap
  between the two rows are back up; a typical card sits at about 72px instead
  of 64px, against 119px before 2.22.
- The swimlanes row is gone. It cost every board a permanent 39px strip to say
  "Lanes: None". Grouping now lives in the palette as **Group board by…**, and
  a compact chip appears above the board only while a grouping is active, with
  a Clear beside it, so a split board is never a mystery.

## [2.24.0] - 2026-09-20

### Fixed (your own estate stops going to third parties)

- There was no boundary between your network and the adversary's. The indicator
  extractor emitted your own mail domain and internal addresses as indicators,
  those linked every case to every other through the seen-before pivot, and
  **Check all sent them to VirusTotal, AbuseIPDB and abuse.ch** — the org
  telling a third party about its own estate.
- New **Asset boundary** setting: your own domains and IPv4 ranges, one per
  line. Nothing is guessed. Private, loopback and link-local ranges are covered
  without listing anything, including IPv4-mapped IPv6 forms like
  `::ffff:10.0.0.5`.
- The gate is in one place, on the way out. Building a request for an asset
  returns nothing before a single URL, header or key is assembled, and the
  boundary argument is required, so no future call site can forget it.
- The boundary is judged on the value's shape, not the row's declared type, so
  re-typing a row cannot walk an internal address past it.
- An asset is still **recorded** on the case as evidence. It is marked ASSET in
  the indicator list, in the case report, in the copied block, in the handover
  note and in the indicator search, so a reader can tell it from adversary
  infrastructure.
- Entries the boundary cannot match are named back to you in settings rather
  than silently ignored.

### Fixed (a pasted label is not an indicator)

- Bulk paste had no shape gate, so `SHA256:`, `Sender` and a date all fell
  through to the final "it must be a domain" branch and became indicator rows.
- Pasting now reports two counts separately and names what it dropped:
  `Added 4 indicators · 2 not indicator-shaped ("SHA256:", "Sender") · 1 already
  recorded`.

### Changed (silence no longer reads as a finding)

- An asset's row says cross-case sightings are not computed for it, instead of
  drawing nothing where "never seen anywhere else" would be read.
- The intake preview counts the indicators it actually searched and says how
  many it did not.
- The links panel says how many of a case's indicators were excluded as assets,
  so a case whose only overlap was an asset does not read as having nothing in
  common with anything.

## [2.23.0] - 2026-09-20

### Fixed (an alert off the queue is no longer born breached)

- Alert intake wrote the alert's own Event Time into the detection field, and
  the SLA clock anchors there. An alert picked up two days after it fired was
  therefore already breached before anyone looked at it.
- Intake now reads two separate key lists. Event-time keys fill a new
  **Occurred** stamp; only a key that names an alert or a detection can reach
  the SLA anchor. One named time fills one field, and neither is ever copied
  into the other.
- A value must carry a four-digit year and a date separator or month name
  before it is parsed at all. `Detected : 3` is a count, not a time, and used
  to become the year 2001 and anchor the clock there.

### Added (the clock says where it starts)

- **Occurred** is a first-class lifecycle stamp: its own row in the incident
  timeline with Now and Clear, its own timeline event, its own report line,
  and its own frontmatter key.
- One shared anchor function decides where the SLA starts, and every surface
  that states a clock now discloses it when there is no detection time: the
  incident panel, the case report, the handover note, the breach entry in the
  append-only log, both report sections, and the board chip's tooltip.
- The incident panel's response, containment and resolution durations are
  measured from that same anchor, so the panel and the chip beside it can no
  longer report different clocks.

### Changed

- Picking an incident template from the menu no longer stamps a detection
  time. Nothing had been typed yet; the clock falls back to case creation and
  now says so.

### Note for existing vaults

Cases created before 2.23 still carry the alert's event time in **Detected**.
Nothing is rewritten. If one of them is anchored wrongly, move the value to
**Occurred** by hand in the incident timeline panel and the clock corrects
itself.

## [2.22.0] - 2026-09-20

### Changed (the board card is half the height, with nothing dropped)

- The kanban card is two rows instead of six. It carried the same facts down a
  stack of one-item rows — parent, title, soc chips, time, tags, progress,
  subtasks, footer — so a routine incident card ran about 130px and a column
  held three of them.
- The title now shares its row with the assignee avatars and the due chip,
  which were a row of their own in the footer.
- Every counter is a chip in one wrapping row: issue type, key, severity, SLA,
  indicators, checklist, subtasks, time, epic, tags, flag, repeat. The
  "3/7 subtasks" sentence became a chip of the same shape as the checklist one,
  with the same words kept in its tooltip.
- Progress is a hairline on the card's own bottom edge rather than a row with
  margins. The adjustable slider keeps an 8px hit target over a 3px track.
- The title clamps at two lines; a third belongs in the case note.
- Measured on the LetsDefend board: a two-line card with two chips went from
  119px to 74px, and the busiest card on the board from 130px to 99px.

## [2.21.0] - 2026-09-16

Safety release from a full audit of 2.20. Nothing here changes the file
format. Requires Obsidian 1.8.7 (device-local key storage).

### Fixed

- **The editor's X button and its Archive/Unarchive items no longer throw
  away edits.** X now saves on close exactly like Esc; Archive persists the
  open edits first; only the footer Cancel discards — and it asks when there
  is something to lose.
- **Delete project asks first.** It trashes the whole case folder and had no
  confirmation; every task delete already did.
- **Bulk "Set status" runs the verdict guard.** One prompt covers every
  selected incident without a verdict; Cancel drops the whole bulk change.
  The README's promise is now true on every path.
- **Absence is never clean.** VirusTotal with nothing but "undetected" and
  AbuseIPDB with zero reports both read "unknown"; "clean" needs a vendor to
  have positively said so.
- **SLA breaches are logged at the deadline**, not at the moment the
  background check happened to notice (which could be the next morning).
- **The editor saves only what you changed** (the side panel already did):
  an edit that landed on disk while the dialog was open — Sync, git, another
  device — is no longer reverted by the dialog's stale copy.
- **Shift+Enter inside the journal composer is a newline**, not
  save-and-close.
- **Commands that act on "the open board" use the active one**, not the
  first tab that happens to be open.
- **SLA countdown chips tick everywhere.** The tick was owned by the board
  view, so a chip in a dialog opened with no board open never moved.

### Changed (trust)

- **Case views never open links.** Clicking an external link in a
  description or journal — `file://` included — copies it defanged instead;
  the special-case `file://` launcher is gone. Remote images and iframes in
  pasted text are not loaded in the preview (the note on disk is untouched).
- **API keys moved out of `data.json`** into device-local storage, so they no
  longer travel with Sync, iCloud or a committed `.obsidian/`. Keys typed
  into an older build migrate on first load.
- **One toast instead of a storm** when more than three tasks are overdue or
  due soon on launch.

### Changed (performance)

- Search on the board is debounced; off-screen cards skip layout and paint.
- "Open case…" and the indicator search cap their lists at 50 rows and
  resolve each project's config once instead of per row.
- Config resolution walks the task index instead of re-flattening the tree
  (it ran on every scroll frame and keystroke in the table).

### Changed (look)

- Severity is one `Chip` everywhere — cards, dialog, panel and table used to
  render the same value three different ways.

## [2.20.0] - 2026-09-15

### Added

- **Playbook progress on cards.** A case whose description carries a
  checklist (the incident templates ship one) shows a quiet "2/6" counter
  on its board card — the same checkboxes you tick in the editor.
- **abuse.ch reputation checks.** One free auth key (from auth.abuse.ch)
  adds MalwareBazaar for hashes, URLhaus for URLs and domains, and
  ThreatFox for IPs next to the VirusTotal and AbuseIPDB chips. A value
  the platforms don't know stays "unknown" — absence is never reported
  as clean. As before, nothing is sent anywhere until you click a check
  button.
- **Case timeline.** Right-click a case → "Open case timeline" for the
  chronological story of the investigation in a side panel: created,
  detected, responded, contained, resolved, every recorded field change
  and comment, in order. Read-only, built only from what the case
  actually recorded.

## [2.19.2] - 2026-09-15

### Changed

- **The two-column layout is gone.** The task editor returns to its
  single-column view at the previous width — the wide layout didn't earn
  its keep. Stay-open filter menus and the recurring-task marker remain.

## [2.19.1] - 2026-09-15

### Fixed

- **The wide layout's properties rail is now a proper Details card.** The
  plain divider was invisible against the modal background, leaving the
  fields floating loose; the rail now sits in a quietly bordered panel.
  Timeline rows fit inside it (labels above their inputs, nothing clipped
  at the modal edge), and the rail scrolls with the page — previously a
  tall incident rail could pin itself and leave its lower rows unreachable.

## [2.19.0] - 2026-09-15

### Changed

- **Two-column issue layout.** The task editor now reads like a Jira issue:
  description, evidence, indicators, subtasks, linked cases, comments and
  activity flow down the left; a properties rail on the right carries the
  fields, the incident timeline and time tracking, and stays in view while
  the page scrolls. In narrow panes (the side-by-side detail panel) the rail
  stacks on top, so nothing gets cramped.
- **Filters stay open.** The status, severity, verdict, assignee and tag
  filter menus no longer close after every click — pick several options in
  one visit while the board updates live behind the menu, then click away
  or press Escape to dismiss.

### Added

- **Recurring-task marker.** Cards with a repeat schedule show a quiet
  repeat glyph beside the flag, with the schedule in its tooltip ("Repeats
  every 2 weeks").

## [2.18.0] - 2026-09-14

### Added

- **Check all indicators.** One button runs the reputation check over every
  indicator, paced to VirusTotal's free tier (a lookup every ~15 seconds),
  with live progress and an honest final count — already-checked and
  uncovered rows are skipped and said so.
- **Seen-before warnings.** The alert-paste preview warns when extracted
  indicators already exist in other cases ("2 of 6 seen before — SOC282")
  and, with a checkbox on by default, links the new case to them as
  "relates to" on creation. Indicator rows show an "Also in SOC282" hint
  that jumps into the cross-case search.
- **Insert playbook.** A button in the description toolbar drops any
  incident template's playbook markdown at the cursor.
- **Copy case report** — the case-report composer, straight to the
  clipboard, for pasting into an answer box.

## [2.17.0] - 2026-09-14

### Added

- **Linked cases.** Mark a case as blocking, relating to, or duplicating
  another — the other case shows the inverse automatically ("Blocked by…").
  Below the explicit links, cases sharing indicators appear as derived
  rows ("Shares 3 indicators", labeled derived, computed from real IOC
  overlap — never stored as an assertion). Links round-trip in frontmatter.
- **Evidence section.** Every screenshot and file embedded in the
  description or journal, listed with type icons, sizes, and open buttons.
  Dangling references stay listed as "missing" — a broken evidence link is
  worth seeing.
- **Case report.** Right-click → "Generate case report" writes a markdown
  writeup next to the case file: summary, incident timeline, response-target
  outcomes, a defanged indicator table, linked cases, the journal, and the
  description verbatim — every value from recorded fields, empty sections
  saying "not recorded", indicator values only ever defanged.

## [2.16.0] - 2026-09-14

### Added

- **Create a case from a pasted alert.** A clipboard button next to add-task
  (and a command-palette entry) opens a paste box: drop in a monitoring
  alert and the title (from its Rule line), severity, detected time,
  description, and every indicator are extracted into an editable preview —
  anything that can't be parsed stays empty, never guessed. One click
  creates the incident and opens it.
- **Undo.** Moving a card to another column, archiving (menu or drop), and
  bulk edits now show a toast with an Undo button that restores the exact
  previous values.
- **Flag.** Right-click → Flag marks a case with a red flag on its card and
  table row (Jira's impediment marker). Stored in the file, shown in the
  activity log, searchable with `flag:true`.
- **Updated column** in the table — the newest recorded change per task,
  sortable, newest first.

### Fixed

- Escape now cancels an inline date edit in the table instead of committing
  a half-typed value; the incident timeline's timestamp fields revert on
  invalid input and each gained a clear button.

## [2.15.1] - 2026-09-14

### Fixed (full-plugin audit — 19 verified defects)

- **Picking a task's own subtask as its parent hung Obsidian** in an endless
  loop. The picker no longer offers descendants, and the store refuses the
  move outright as a second line of defense.
- **The side panel's autosave could quietly undo other changes**: it saved
  its whole stale copy, which could revert a status changed on the board,
  delete a subtask created elsewhere, and erase SLA-breach entries from the
  activity log. The panel now saves only the fields it actually changed;
  removing a subtask is an explicit operation; the activity log is owned by
  the store and can no longer be overwritten by an editor's stale copy.
- **Hand-written content in notes survives saves**: text below the generated
  sections of a task note, the body of the project note, and any frontmatter
  keys you added yourself (aliases, cssclasses, …) are all preserved now.
- **Closing the dialog with Esc respects the verdict guard** — a move to a
  done status prompts for a verdict on every path, not just the Save button.
  Clearing a title then closing keeps the old title and saves the rest
  instead of silently discarding everything.
- **Side-panel button edits actually save**: removing a subtask, ticking its
  checkbox, and adding or removing a time log now schedule the autosave.
  Ticking a subtask also stamps its completion date.
- **Inline board create**: Enter can no longer double-create; creating inside
  a severity/bucket/assignee swimlane lands in that lane (epic lanes only
  offer create in the no-epic lane); creating under an active filter says
  "Created — hidden by the active filter"; a half-typed title survives board
  rebuilds and column collapse.
- **Read-mode checkboxes toggle the right line** with capital `[X]`, custom
  states, and checkbox-looking lines inside code fences.
- Duplicating a closed incident no longer clones the closed status without
  its verdict — a duplicate starts as open work.
- Reports no longer count archived, never-closed cases as open.
- "Subtask of…" can no longer save a parentless subtask, and the side panel
  (where the parent picker doesn't apply) no longer offers it.

## [2.15.0] - 2026-08-22

### Changed

- **One type control**, like Jira. The separate "Type" and "Issue type" rows
  merged into a single dropdown: the issue types plus Milestone and
  "Subtask of…" as structural choices. Picking "No parent" on a subtask
  turns it back into a plain task. Files are untouched — both fields still
  round-trip exactly as before.

## [2.14.0] - 2026-08-22

### Added

- **Reports read as a dashboard.** A headline row of stat tiles — open
  cases, incidents, closed this week, true positives, targets met — sits
  above the sections, which now tile the window as cards (one column on a
  narrow pane). New **open incidents by severity** section with
  severity-colored bars. The weekly chart gained hover tooltips
  ("2026-W34 · 3 opened"). Every number reuses the same reducers as the
  sections below it, so the tiles can never disagree with the details.

## [2.13.1] - 2026-08-22

### Fixed

- Reports fill the window instead of stopping at a 720px column; the weekly
  chart scales up with the page (capped so it stays readable).
- The lifecycle section explains itself when empty: durations are measured
  from the detected time, so a case with responded/resolved but no detected
  time no longer produces a bare "no data" that reads as a broken report.

## [2.13.0] - 2026-08-22

### Added

- **Today bucket**, first in the list — triage order runs Today, This week,
  Next, Later, Someday. It appears everywhere buckets do: the task dialog,
  the right-click move menu, the backlog columns, board swimlanes, and
  reports.

## [2.12.2] - 2026-08-22

### Fixed

- A reputation check now says when a provider was skipped for lack of a key
  ("AbuseIPDB · no key in settings") instead of silently omitting it — a
  missing chip read as if the provider had been consulted and said nothing.

## [2.12.1] - 2026-08-22

### Changed

- Issue-type icons return to the quiet tinted glyphs — the solid colored
  squares from 2.12.0 read too bright on the dark board.

## [2.12.0] - 2026-08-22

### Changed (Jira parity wave — from a full four-lens audit)

- **Boards look like Jira.** Column headers are quiet uppercase labels with a
  small status dot and count — the colored bars and borders are gone; color
  lives on cards and lozenges now. Cards restructured: title first, then a
  footer with the issue-type icon, a plain monospace key, and the severity
  badge; the M/Sub/R letter chips are gone and cards hug their content. In a
  Done column the key is struck through, not the title.
- **Issue-type icons are solid colored rounded squares** (Jira's idiom),
  everywhere at once.
- **Status is one click from anywhere**: a clickable status lozenge in the
  issue header (dialog and side panel), a "Move to status" submenu in the
  right-click menu, and a clickable status lozenge in the backlog — all
  through the same verdict guard as the board drop.
- **Inline "+ Create" at the bottom of every column**: type a title, Enter
  creates the card in that column's status and reopens the input for the
  next one. Escape cancels.
- **Table sorts by time to SLA breach** (service-desk queue order): closest
  to breach first, no-clock after, resolved last. Sortable headers gained
  keyboard access and correct sort indicators.

### Fixed

- Creating a task with an empty title is blocked with a visible message —
  no more accidental "New Task" files.
- Changing any property no longer snaps the issue view's scroll to the top,
  and a half-typed comment now survives property changes.
- Board cards are keyboard-focusable (Enter/Space opens).

## [2.11.1] - 2026-08-22

### Fixed

- A long unbroken string in a comment or description — a VirusTotal link, a
  file hash — no longer overflows the dialog; it wraps inside its box.

## [2.11.0] - 2026-08-13

### Changed

- **Subtasks read like Jira children.** On the board, a subtask card sitting
  directly under its parent indents with an elbow connector; a subtask in a
  different column carries a "↳ parent" breadcrumb (key when the parent has
  one, title otherwise — hover shows the full title). In the task view, each
  subtask row now shows a nesting connector, the subtask's key, and a colored
  status pill with its real status, alongside the existing checkbox and
  click-to-open title.

## [2.10.1] - 2026-08-12

### Fixed

- Indicator values can now be copied as displayed: clicking the defanged
  value copies it defanged (green flash confirms), and the text is
  selectable again — the app-wide selection block had made it ungrabbable.
  The row's copy button still copies the real value.

## [2.10.0] - 2026-08-12

### Added

- **Live reputation checks on indicator rows.** A check button on each
  indicator queries VirusTotal (IP, domain, hash, URL — an email is checked
  by its domain, shown on the chip) and AbuseIPDB (IP), rendering verdict
  chips (malicious / suspicious / clean / unknown) with vendor counts; each
  chip links to the vendor's page. Defanged values are refanged before
  querying. Off until you add your own API keys in settings — keys stay in
  this vault, are never logged, and the indicator value is sent to the
  provider only when you click the button, never automatically. Errors
  degrade honestly (rate limited, not found, key rejected).

## [2.9.0] - 2026-08-04

### Changed

- **One view while editing a description.** The separate "Preview" panel under
  the editor is gone — the editor itself now renders like a note tab:
  headings, quotes, bullet and numbered lists, clickable checkboxes, and
  monospaced code fences, on top of the existing bold/italic/code. Markers
  reveal as raw markdown only on the line you're editing, exactly like
  Obsidian's Live Preview. Links and image embeds render in read mode as
  before.

## [2.8.0] - 2026-08-03

### Changed

- Kanban columns now resize with the window: To Do / In Progress / Done /
  Archive share the available width instead of sitting at a fixed 280px.
  On narrow windows they shrink to a readable minimum, then the board
  scrolls horizontally as before. Collapsed columns stay a fixed strip.

## [2.7.0] - 2026-08-03

### Added

- **Informational severity** (gray), below Low — the standard five-level SOC
  scale. It ships with no SLA policy, so informational findings run no
  response/resolution clocks; targets can be set in settings like any other
  severity. `sev:` queries rank it lowest automatically.

### Changed

- Severity colours: Critical stays red, High is now yellow, Medium blue,
  Low sky blue. Custom severity colours are untouched.

## [2.6.4] - 2026-08-02

### Changed

- Default status colours retuned for SOC / incident-response reading: To Do
  is amber (open, waiting for triage), In Progress is blue (active
  investigation), In Review takes purple; Blocked stays red, Done stays
  green, Cancelled stays grey. Custom status colours are untouched.

## [2.6.3] - 2026-08-02

### Fixed

- Dragging a board card's progress slider showed Obsidian's default thumb (a
  large white oval floating above the track): Obsidian styles the thumb's
  hover and drag states with higher specificity than a plain class. The thumb
  is now a small accent dot in every state, growing slightly while dragging.
- The task editor's progress slider rendered with Obsidian's default track
  and thumb instead of the plugin's styling, for the same reason.

## [2.6.2] - 2026-08-02

### Fixed

- The board card's progress slider was stuck at the browser default width
  (~150px): Obsidian's built-in range-input styling outranked the plugin's
  class. The slider now truly spans the card.

## [2.6.1] - 2026-08-02

### Changed

- Removed the Duplicate verdict; the list is now True Positive / False
  Positive / True Positive - Security Testing / Anomalous Safe

### Fixed

- Retired verdicts (Pending, Duplicate) are pruned when settings load, so an
  older running build re-saving its stale settings can no longer resurrect
  them
- The board card's progress slider track is now visible all the way to the
  card edge (the unfilled portion was too faint to see)

## [2.6.0] - 2026-08-02

### Changed

- **Live formatting in the description editor.** Editing now uses a real
  editor (CodeMirror): `**bold**`, `*italic*` and `` `code` `` render styled
  with their markers hidden — the raw markers reveal only where your cursor
  is, like editing a normal note. Undo/redo history included. Image paste,
  file drop, `[[` autocomplete, the formatting toolbar and Cmd+B/I/E,
  click-to-position and autosave all carry over; headings and checklists
  still render fully in the preview panel below and in read mode.

## [2.5.2] - 2026-08-02

### Added

- Adjustable progress on board cards: the thin progress track is now a slider
  (25% steps) you can drag right on the card — no need to open the case. The
  thumb appears on hover; card dragging and click-to-open are unaffected.
  Archive cards stay read-only.

## [2.5.1] - 2026-08-02

### Added

- Live preview while editing a description: the formatted result (bold,
  italic, code, headings, checklists) renders beneath the textarea as you
  type, updating in real time

## [2.5.0] - 2026-08-01

### Added

- **Extract indicators from the note.** A scan button on the Indicators header
  reads the case description and comments, finds indicators (IPs, URLs,
  hashes, emails, domains — defanged or real), skips ones already recorded,
  and adds the rest in one step

### Fixed

- Editing any dropdown in the task modal no longer steals focus back to the
  title field

## [2.4.1] - 2026-08-01

### Fixed

- Pressing Delete/Backspace on a selected table row deleted the case file (and
  its subtask files) with no confirmation — it now asks first, like the bulk
  and modal delete paths always did

## [2.4.0] - 2026-08-01

### Added

- **Cross-case indicator search.** The find-this-indicator button on an IOC row
  now opens a search over every case in every project (defang-insensitive),
  showing case, task, status and note per hit — choosing one opens that case.
  Type in it to hunt any other indicator.
- Done columns render settled: cards muted like Archive with crossed-off titles
- Kanban board polish: cards fade in when new, hover lift, a dashed insertion
  slot that follows the drag across columns, instant drop-target highlighting
  on the whole column, quiet empty-column drop hints — all honoring reduced
  motion

### Fixed

- Cross-column drops now land exactly where the insertion slot showed instead
  of appending at the end
- Releasing a drag outside any column snaps the card back cleanly

## [2.3.1] - 2026-08-01

### Changed

- Removed the Pending verdict — an open verdict is simply the empty state

## [2.3.0] - 2026-08-01

### Changed

- **Severity replaces priority.** Severity (relabeled Critical / High / Medium /
  Low) is the single urgency dial, editable on every task type; priority is
  retired from the UI while staying in the file format for round-trip. Query
  values match labels too (`sev:>=high`); old `sev:>=sev2` and saved `prio:`
  views keep working. SLA clocks remain incident-only.
- **Task files keep their exact title** ("SOC166 - Javascript Code Detected in
  Requested URL.md") — no more lowercase-dash slugs. Existing files stay where
  they are and adopt the exact name only when their title changes.
- Verdicts: *Benign True Positive* replaced by **True Positive - Security
  Testing**; new **Anomalous Safe** verdict.

### Added

- **Archive column** on the kanban board, always visible after the status
  columns: drop a card in to archive it (its file moves to the project's
  `Tasks/Archive/` folder automatically), drag it out to restore — the verdict
  close-guard still applies. Archived cards render muted; the column collapses
  like any other.
- Description formatting: bold / italic / inline-code toolbar in edit mode and
  Cmd+B / Cmd+I / Cmd+E hotkeys that wrap or unwrap the selection.

## [2.2.1] - 2026-08-01

### Changed

- Neutral example issue keys in docs, comments, and dialog text

## [2.2.0] - 2026-08-01

### Changed

- **Self-contained project folders.** Creating a project now creates one folder
  named after it (at the vault root by default) holding the project file and
  its whole `Tasks/` tree — no shared parent folder. The projects-folder
  setting still works; leaving it empty means the vault root. Existing vaults
  keep loading unchanged.

### Added

- Command **Move each case into its own folder** — converts an existing vault
  to the new layout (link-aware, idempotent, leaves unrelated notes alone)

## [2.1.2] - 2026-07-31

### Changed

- Directory-review cleanups: the drop-landing border override uses card-scoped
  specificity instead of `!important`; the property grid uses the `gap`
  shorthand; a hint div uses `createDiv`. No behavior changes.

## [2.1.1] - 2026-07-31

### Changed

- Manifest description no longer contains the word "Obsidian" (community
  directory review rule); no functional changes

## [2.1.0] - 2026-07-31 — Casefile

### Changed

- **Renamed to Casefile.** Plugin id `greysurface-pm` → `casefile` (new install
  folder — see INSTALL.md for the one-time switchover incl. `data.json`),
  display name, view types, and all user-facing text. Data format unchanged.
- README rewritten for Casefile; the appended legacy README (whose links,
  badges and feature claims no longer matched this plugin) was removed.

### Added

- `sla:` and `ioc:` query fields (breached/warn/ok/none; defang-insensitive
  indicator search), severity and verdict filter dropdowns, a query-syntax
  popover on the search bar, and a live "N of M" match count
- IOC smart intake: bulk paste from reports (splits, refangs, auto-types,
  deduplicates), auto-type detection on single values, copy-all-as-defanged-
  block, and a per-indicator pivot that searches it across cases
- Shift handover notes now list each open incident's defanged indicators
- Global **Open case…** command: fuzzy switcher over every issue key, with
  recently opened cases on empty query
- Bulk set-severity and set-verdict in the table's bulk-action bar
- Reports: mean/median time-to-respond / time-to-contain / time-to-resolve
  tiles per severity; lifecycle panel shows containment time
- Per-task activity timeline (collapsed, read-only) in the detail panel and
  task modal; bucket moves and IOC add/remove are now activity-stamped
- SLA countdown chip + severity badge on the detail panel and task modal
- Kanban: collapsed columns accept drops; WIP limits editable in settings
- Subtask files now nest inside their parent task's folder
  (`Tasks/<case>/<parent>/<subtask>.md`) instead of landing flat beside it;
  renames and re-parenting move the files along. New command **Nest subtasks
  under their parent tasks** migrates an existing vault (link-aware,
  idempotent); flat vaults keep loading unchanged without it

### Fixed

- Reports no longer exclude archived cases — archiving a closed case must not
  erase it from historical metrics
- The detail panel's debounced autosave could overwrite store-side stamps
  (activity entries, respond/resolve timestamps, completion) with stale clone
  values; it now syncs them back after every save

## [2.0.0] - 2026-07-31 — GreySurface PM

GreySurface PM: Jira-style project and SOC incident tracking, restyled with
the GreySurface Linear design system. Data stays 100% compatible with the
pre-existing pm-project/pm-task markdown format.

### Added

- Issue keys (PREFIX-N, immutable, auto-assigned on save) with a one-time
  "Adopt issue keys" migration that lifts keys embedded in titles
- Issue types (epic/story/task/bug/incident, configurable palette) with
  colored icons, monospace key chips, and epic context pills
- Query bar grammar in the search box: field:value terms (status, type,
  priority, severity, verdict, assignee:me, tag, due:<7d, bucket, progress,
  key), quoting, negation, ordering — free text still works
- Kanban swimlanes (epic/assignee/priority/bucket), persisted card order,
  soft WIP limits, collapsible columns, saved views as one-click chips
- Right-leaf task detail panel with debounced autosave (titles save on blur)
- Planning buckets (This week / Next / Later / Someday) + Backlog view
- SOC incident pack: severity separate from priority, per-severity
  response/resolution targets with live countdown chips and breach
  notifications, incident timeline (detected/responded/contained/resolved
  with auto-stamps), verdict with a soft close guard, defanged indicator
  table, MITRE ATT&CK technique tagging (bundled list, CC BY 4.0)
- Append-only activity log on every tracked field change; append-only
  comments journal stored in the note body
- Reports view: opened-vs-closed per week, time in status, verdict
  breakdown, target compliance — raw counts, no interpolation
- Shift handover note generator and incident templates (3 seeded playbooks)
- GreySurface Linear reskin (dark, token-driven) with a FLIP motion system,
  reduced-motion support (OS + setting), and a runtime contrast self-check
  in the dev styleguide
- Portable packaging: `pnpm package` produces an offline-installable zip

### Changed

- Progress is editable in the task editor (slider, 25% steps)
- Notifier checks every 5 minutes (was hourly) to catch target breaches

## [1.8.0] - 2026-07-03

### Added

- The gantt timeline header stays pinned to the top when scrolling through tasks
- Selected text in a note can be turned into a task from the right-click menu or the "Create task from selection" command

## [1.7.0] - 2026-07-02

### Added

- New setting "Show tag colors" (default on) controls the presence of a colored dot on tags
- Copy the task ID or file path to the clipboard by clicking the corresponding header or footer text in the task editor

### Changed

- Design overhaul of the task modal, with improved UX and unified components
- Status, priority, type, and dates on a task are now changed via a value picker
- Tags, assignees, and dependencies are edited through a new searchable picker
- Repeat and dependencies are hidden by default and added to a task on demand from an "Add property" menu
- Archive, delete, and opening a task as a note are grouped under a single menu in the task editor
- Subtask progress is calculated only from completed subtasks
- Assignee avatars stack when more than one person is assigned
- Checkbox style now matches the one on the task table
- Task priority is shown with a colored chevron instead of a dot
- A value picker in the task editor sizes to its options instead of a fixed width
- Tags in the task table and on kanban cards show a colored dot, matching the task editor
- Logged time is shown the same way in the task table and on kanban cards

### Fixed

- The task editor's priority strip is now displayed along the top edge of the window
- The task editor title showed an input background when hovered or focused
- Time tracking shows the over-estimate state once logged time passes the estimate

## [1.6.3] - 2026-06-17

### Fixed

- The project view was empty when Pane Relief or Hover Editor was enabled

## [1.6.2] - 2026-06-17

### Changed

- Task note filenames keep more of the task title before shortening

### Fixed

- Subtasks added in the task editor were lost on reload
- The app froze when duplicating a task with a long title
- The project list showed stale task counts until the view was reopened

## [1.6.1] - 2026-06-15

### Changed

- Task and project modals follow Obsidian's native border, shadow, and corner styling
- Status, priority, and tag labels follow Obsidian's native styling
- The accent color follows the Obsidian theme
- Gantt elements follow the Obsidian theme: the today marker, the milestone and subtask buttons, and the row selection and hover highlights
- Kanban cards align the assignee and due date to the bottom of the card

### Fixed

- Subtasks created from the subtasks list or the add-subtask buttons were not set to the subtask type
- An assignee written as a note link (`[[People/Jane Doe]]`) showed the link path on its avatar instead of the person's name

## [1.6.0] - 2026-06-12

### Added

- Completing a task records a completion date that can be edited in the task modal
- Setting "Show description preview on board" (default off) shows the first three lines of each task's description on its kanban card

### Changed

- Saving a task updates only the affected task notes instead of every note in the project
- Projects open faster, and reopening a project is instant. Edits made outside the plugin are still detected and reloaded
- The table stays responsive in large projects
- Views update in place after an edit, keeping the scroll position and selection
- Select all in the table selects every task matching the current filter, not just the visible rows
- Collapsing or expanding a subtree no longer changes any task notes
- The expand/collapse subtasks toggle looks the same in the table and Gantt views
- Gantt task bars show stronger contrast between completed and remaining work
- Gantt task bars no longer show a stripe on tasks that have subtasks

### Fixed

- Images pasted or dropped onto a task were saved to the vault root instead of the task's own folder. The folder follows the task when it is renamed or archived, and is removed with the task
- Duplicating a task with its subtasks failed with a "note already exists" error and dropped the subtasks
- Progress bar labels showed 0% instead of the actual value in some views
- The subtasks toggle did not respond in the Gantt view

## [1.5.0] - 2026-05-25

### Added

- Setting "Save tasks on close" (default on). When off, closing the task modal by X or click-outside discards edits, so only the Save button keeps them
- "Open as note" button in the task modal header opens the task's note in a new tab
- Pasting a screenshot or dragging a file onto the task description saves it to the vault attachments folder and embeds it at the cursor
- Search box, filters (status, priority, assignee, tag, due date, archived), and saved views appear above every view, not just the table
- Filter state persists per project across plugin reloads
- Saved views remember the view mode they were created in, and selecting one switches the project to that mode
- Gantt lifts a matching task to the top level when its parent is filtered out, so search reveals deeply nested matches
- Release artifacts carry GitHub build provenance attestations; `gh attestation verify <file> --owner m0farhan` confirms a download was built from this repo

### Changed

- The UI follows the Obsidian theme: accent color, near and overdue colors, badges, and avatars
- Toolbar, Gantt, filter, and bulk-action buttons render at Obsidian's native size
- Saved-view tabs match the styling of the filter pills
- The "save view" and inline add buttons render as native Obsidian buttons
- Status and priority badges in the task modal are no longer keyboard-focusable
- The delete confirmation uses Obsidian's native warning style
- Primary buttons in light theme use a solid accent fill
- The project header gear, bulk-action clear, remove, and table row buttons use Obsidian's icons
- Remove buttons on tags, assignees, and dependencies turn red on hover
- Project-card and kanban-card progress bars are 3px tall
- The filter row collapses when no filters are active, and the Filter pill expands it
- Toggling a filter pill no longer moves focus out of the search box
- Gantt milestone labels and dependency arrows follow the active filter
- View switcher buttons show only an icon
- Assignee avatar initials use the first letter of the first two words, so "Michael Jordan" shows "MJ" instead of "MI"
- New task notes are named after the task title. Existing notes keep their name until the task is renamed

### Removed

- The Gantt "Hide completed" button; the Status filter excludes Done and Cancelled instead, and existing settings migrate automatically
- The inline quick-add input above the table; the toolbar "add task" button opens the task modal instead

### Fixed

- A solo avatar had extra spacing on its right in the project edit modal
- Kanban cards dropped the fourth and later assignees
- Duplicate task entries appeared when creating a task
- A saved-view pill stayed highlighted after its filter was changed
- An assignee stored as a wiki link (`[[Wiki Link]]`) showed garbled avatar initials
- Renaming a task to a title already used by another note shows an inline error instead of failing silently

## [1.4.0] - 2026-04-29

### Breaking Changes

- Clicking a project file no longer auto-opens the project view. The new "Open current file as project" command restores the old behavior when bound to a hotkey

### Added

- Duplicate task action in the table and Kanban context menus
- "Open current file as project" command

### Fixed

- "Today" rolled over in the evening west of UTC
- Clicking a project from a task tab hijacked the tab
- Opening a project created duplicate tabs
- The ribbon button opened a duplicate project list pane
- The table scroll position was lost across opening and closing the task modal
- Project folders errored on case-insensitive vaults

## [1.3.2] - 2026-04-21

### Fixed

- `file://` links in task descriptions did not open on click

## [1.3.1] - 2026-04-21

### Added

- Redo for Gantt drag actions (Cmd+Shift+Z, Cmd+Y, or the "Redo last action" command)

### Fixed

- Cmd+Z no longer hijacks undo in unrelated notes when a project tab is open

## [1.3.0] - 2026-04-18

### Added

- Custom task statuses, added and removed from settings
- Subtasks as draggable cards on the Kanban board
- Undo for Gantt drag operations (Ctrl/Cmd+Z)
- Interactive checkboxes in the task description preview
- "Hide completed tasks" toggle in Gantt
- Bulk set-parent and remove-parent in the table view

### Removed

- The emoji placeholder in the custom status icon input

### Fixed

- The bulk action bar flickered when toggling filters
- Orphaned subtasks reattach to their parent on load
- Orphaned tasks are remapped when a custom status is deleted

## [1.2.0] - 2026-04-14

### Added

- Import notes as tasks: batch-import vault notes into a project through a multi-file picker
- Click-to-link dependencies on Gantt
- Drag Gantt task bars to reposition them
- Click an empty Gantt row to set start and due dates
- Dependency-based auto-scheduling
- Type `[[` in the description field to link vault notes
- Markdown preview in task descriptions, with a toggle between edit and rendered
- Shift+click range selection for table checkboxes
- Gantt week labels: week number, date range, or both

### Changed

- The dependency picker filters out cycles
- Cross-links to canvases and databases work in task descriptions
- Bulk checkboxes stay hidden until the row is hovered
- Task modal buttons show the Shift+Enter shortcut hint

### Fixed

- Dependent tasks lost a day on each reschedule
- The Gantt scroll position was lost on re-render
- The import modal wrote tasks to the wrong folder
- Subtasks did not render when added through the parent task modal
- Deleting dependent tasks crashed the plugin
- The task modal jumped while typing long descriptions
- Import modal checkboxes responded slowly and double-toggled

## [1.1.1] - 2026-04-11

No release notes.

## [1.1.0] - 2026-04-08

First stable release.

### Added

- Gantt: drag-to-reschedule, snap-to-grid, resizable sidebar, milestones, and week/month/quarter scales
- Kanban: drag-and-drop board grouped by status
- Table: sort, filter, saved views, inline date editing, and a quick-add bar
- Task modal: subtasks panel, time tracking, custom fields, and auto-save on dismiss
- Bulk actions: multi-select for status changes, deletion, and archive/unarchive
- Custom fields per project: text, number, date, checkbox, select, and multi-select
- Archive system with a toggle to show archived tasks
- Command palette: create tasks and open projects from anywhere
- Tasks stored as YAML frontmatter in Markdown files

## [1.0.0-beta] - 2026-03-30

Initial beta.
