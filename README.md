# Responder

SOC case and incident response, natively in your Obsidian vault: kanban
boards, SLA timers, alert intake, a phishing analyser, indicator handling,
reports and shift handover. Boards, cases and tasks are plain markdown with
YAML frontmatter — portable, searchable, version-controllable, fully offline.
No services, no accounts.

Built for a solo SOC analyst's daily shift: triage fast, keep an honest audit
trail, hand over cleanly.

## What's inside

**Case tracking**

- Two board types: a case board (severity, response clocks, verdicts,
  indicators, the incident timeline, alert intake and case reports) and a
  plain board (columns, cards and severity only). A plain board only hides
  the SOC fields; whatever is already in the files stays there.
- Issue keys (`SOC-12`), opt-in per board: set an issue key prefix on the
  board (an empty prefix means no keys), and a one-time command gives a
  board's existing cases their keys. Keys are stable, immutable case
  addresses.
- A global **Open case…** command: fuzzy search over every case by key or
  title, with recently opened cases listed first
- Issue types with epic pills; per-board statuses and custom fields
- Kanban with swimlanes, WIP limits (editable in settings), collapsible
  columns that still accept drops, and buckets + backlog for planning
- Table view with sorting, inline editing, and bulk actions — including bulk
  set-severity / set-verdict for alert storms
- Query bar with a JQL-lite grammar (`sev:>=high sla:breached ioc:evil[.]com`),
  a built-in syntax popover, live match counts, and saved views
- Right-leaf task detail panel with debounced autosave; Gantt and dashboard
  views for the bigger picture
- Auto-archive: closed cases move into their board's `Tasks/Archive/` folder a
  set number of days after they were closed. Off by default (0 days); the
  file is moved, never deleted, and a case with no completion date is never
  moved.

**SOC pack**

- Severity (the single urgency dial, on any task type) and verdict, with a
  close-guard that prompts for a verdict whenever an incident on a case board
  is closed — on every path, bulk close included
- Per-severity SLA policies with live countdown chips (board, table, detail
  panel and modal) and breach notices
- IOC table: bulk paste straight from a report (defanged values are refanged,
  typed, and deduplicated automatically), rendered defanged everywhere,
  one-click defanged block export, and an `ioc:` pivot to find an indicator
  across cases
- Optional live reputation checks on indicator rows — VirusTotal (IP, domain,
  hash, URL; an email is checked by its domain), AbuseIPDB (IP), and the
  abuse.ch platforms, which share one free auth key from auth.abuse.ch:
  MalwareBazaar (hashes, via mb-api.abuse.ch), URLhaus (URLs and domains, via
  urlhaus-api.abuse.ch) and ThreatFox (IPs, via threatfox-api.abuse.ch). Off
  until you add your own API keys in settings (stored on this device only,
  never in the vault or `data.json`); the indicator value is sent to the
  provider only when you click the check button, never automatically.
  Values inside your **Asset boundary** (the domains, addresses and IPv4
  ranges you list in settings, plus private, loopback and link-local
  addresses) are never sent to any provider or searched across cases; they
  are still recorded on the case and marked ASSET.
  Responder itself makes exactly that one kind of request. Its case views
  never open links or load remote images from case text — a click on a link
  copies it defanged instead; opening the same note directly in Obsidian
  follows Obsidian's normal behaviour.
- Incident lifecycle stamps (occurred / detected / responded / contained /
  resolved) with an append-only, per-task activity timeline — nothing edits
  history — and a case timeline pane that tells one case's story in order
- Comments, kept structurally separate from factual fields
- Reports: status/severity breakdowns, SLA compliance, and mean/median
  time-to-respond / contain / resolve per severity (archived cases included —
  archiving never erases history)
- One-command shift handover note, including each open incident's defanged
  indicators
- Case report for a single case on a case board, written to a new note beside
  it or copied to the clipboard (right-click the case)
- Alert intake: paste an alert and it becomes a case, with the title,
  severity, indicators and times the alert states read from its text. The
  detection stamp is taken only from a field the alert labels as the alert
  or detection time, never from the event's own time.
- Phishing analyser: paste an email's headers or the whole message, or load
  a `.eml` from the vault, and read it in its own tab. It is read offline as
  data: its HTML is shown as source, no link is resolved, and nothing in it
  is fetched or run. Attached PDFs, Office files and ZIP archives are read the
  same way: their links, scripts, embedded files and page text are listed,
  never opened or rendered, and anything it could not read is reported as
  unread rather than absent. It states what the message says and never
  reaches a verdict; that stays with you, on the case it can create.
- Analyst toolbox on a selection (defang, refang, decode, read a timestamp,
  hash), entirely offline

## Data format

One board or task = one markdown file (`pm-project` for a board, `pm-task`
for each case or task). Each board keeps everything it owns in one folder
named after it: `<Board>/<Board>.md` is the board, and its cases and tasks
sit under `<Board>/Tasks/` (archived ones in `<Board>/Tasks/Archive/`). New
boards go in the vault root unless you set **Default folder for new boards**
in settings. Boards are found by their frontmatter wherever they sit, so a
board folder can be moved in the file explorer. Vaults from older versions
(`Cases/<Name>.md` with `Tasks/<Name>/`, or `<Name>.md` with `<Name>_tasks/`)
still load as they are, and the migration commands convert them.

If any other plugin that reads the same `pm-project`/`pm-task` frontmatter is
ever installed in the same vault, keep it disabled while Responder is enabled:
both would write the same files.

Works alongside SOC Toolkit: descriptions are plain notes, so its defang and
IP-reputation commands work inside them.

## Install

Requires Obsidian 1.8.7 or newer (device-local key storage). See
[INSTALL.md](INSTALL.md) — `corepack pnpm package` builds a portable
offline bundle for any vault on any machine.

## License

MIT — see [LICENSE](LICENSE). Release history in [CHANGELOG.md](CHANGELOG.md).

`main.js` bundles
[temporal-polyfill](https://github.com/fullcalendar/temporal-polyfill) and its
temporal-utils helpers (MIT, © Adam Shaw); their licence text is at the top of
`main.js`.
