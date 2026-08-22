# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
