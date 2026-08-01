# Casefile

Jira-style case & SOC incident tracking, natively in your Obsidian vault.
Cases and tasks are plain markdown with YAML frontmatter — portable,
searchable, version-controllable, fully offline. No services, no accounts.

Built for a solo SOC analyst's daily shift: triage fast, keep an honest audit
trail, hand over cleanly.

## What's inside

**Case tracking**

- Issue keys (`SOC-12`) — stable, immutable case addresses, with a global
  **Open case…** command (fuzzy search over every key + recently opened cases)
- Issue types with epic pills; per-project statuses, priorities, custom fields
- Kanban with swimlanes, WIP limits (editable in settings), collapsible
  columns that still accept drops, and buckets + backlog for planning
- Table view with sorting, inline editing, and bulk actions — including bulk
  set-severity / set-verdict for alert storms
- Query bar with a JQL-lite grammar (`sev:>=sev2 sla:breached ioc:evil[.]com`),
  a built-in syntax popover, live match counts, and saved views
- Right-leaf task detail panel with debounced autosave; Gantt and dashboard
  views for the bigger picture

**SOC pack**

- Severity (≠ priority) and verdict, with a close-guard so incidents can't be
  closed without a verdict
- Per-severity SLA policies with live countdown chips (board, table, detail
  panel and modal) and breach notices
- IOC table: bulk paste straight from a report (defanged values are refanged,
  typed, and deduplicated automatically), rendered defanged everywhere,
  one-click defanged block export, and an `ioc:` pivot to find an indicator
  across cases
- Incident lifecycle stamps (detected / responded / contained / resolved) with
  an append-only, per-task activity timeline — nothing edits history
- Comments, kept structurally separate from factual fields
- Reports: status/severity breakdowns, SLA compliance, and mean/median
  time-to-respond / contain / resolve per severity (archived cases included —
  archiving never erases history)
- One-command shift handover note, including each open incident's defanged
  indicators

## Data format

One case/task = one markdown file (`pm-project` / `pm-task` frontmatter),
stored under `Cases/` and `Tasks/<case>/`. The format is compatible with the
Project Manager plugin lineage this tool grew from — if that community plugin
is ever installed in the same vault, keep it disabled while Casefile is
enabled: both would write the same files.

Works alongside SOC Toolkit: descriptions are plain notes, so its defang and
IP-reputation commands work inside them.

## Install

See [INSTALL.md](INSTALL.md) — `corepack pnpm package` builds a portable
offline bundle for any vault on any machine.

## Credits

Casefile is based on [Project Manager](https://github.com/StepanKropachev/obsidian-pm)
by Stepan Kropachev (MIT — upstream license retained in [LICENSE](LICENSE)),
heavily extended and restyled. See [CHANGELOG.md](CHANGELOG.md).
