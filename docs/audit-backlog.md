# Responder audit → Responder port checklist

> Moved here from the parked Responder repo on 2026-09-20, when Farhan chose to improve Responder itself
> rather than replace it. This is the roadmap: 111 findings from the full 2.20 audit, 21 of them already
> closed in 2.21.0. ★ marks a finding hand-verified against the source.
>
> Note on phase labels: "phase 1" was Responder's build phase for that item. Read it as "open".

Generated 2026-09-19 from the 8-lens audit of Responder 2.20 (111 findings). Verification agents died on a spend limit; items marked ★ were verified against source by hand, the rest are auditor-reported. Items marked ✓2.21 were fixed in Responder 2.21.0 and must not regress in the port; everything else is a phase-1 requirement (the port fixes it by construction) unless marked "port as-is".

Full evidence and fixes per finding: session scratchpad `casefile-audit-findings.md` (copy into docs/ if the scratchpad is gone).

## ux-workflow

Protect (port verbatim where possible):
- Every task-open path routes through one factory that honours the modal/panel setting and stamps recents
- Verdict guard runs on every terminal-status path, not just the Save button: modal Esc/backdrop close
- Alert intake never guesses: unparsed fields stay '' and the preview says 'Not found in paste'
- Undo-notice pattern for fat-finger actions restores exact prior values: board drop and archive
- Reputation honesty: providers without a key render an explicit 'no key in settings' chip so silence never reads as a verdict
- Detail panel persists only the fields it changed (`diffTaskPatch`, src/views/TaskDetailView.ts:78-87, 224-261) and syncs store-side stamps back to the clone
- Draft preservation across rebuilds: comment draft + focus + scroll restored in both hosts
- IOC handling: bulk paste splits/refangs/types/dedups in one commit
- Case report says 'not recorded' / 'None recorded.' per section rather than inventing values, renders indicators defanged, and never overwrites a prior report
- Popover primitive mounts inside the modal to defeat Obsidian's focus trap and becomes a bottom sheet on phones

| id | sev | title | status |
|---|---|---|---|
| UX-01 | blocker | Modal X button and Archive/Unarchive menu discard visually-committed edits silently, while Esc saves them | ★ ✓2.21 |
| UX-02 | blocker | 'Delete project' trashes the whole case folder from a right-click with no confirmation | ★ ✓2.21 |
| UX-03 | major | 'Create case from pasted alert' and 'Import notes' target the FIRST open project view, not the active one | ✓2.21 |
| UX-04 | major | Reputation results are wiped by any property change or comment — a 15 s/lookup paced run has to be re-spent | phase 1 |
| UX-05 | major | Auto-stamped respondedAt/resolvedAt are shown as recorded facts; any status move (including to Cancelled) 'res | phase 1 |
| UX-06 | major | Two disconnected undo systems: palette 'Undo last action' only knows Gantt drags; table/context-menu status an | phase 1 |
| UX-07 | major | Vocabulary is split three ways: 'case' means task in the UI but project in the README/file layout, and PM-era  | phase 1 |
| UX-08 | major | Creating an incident is the hard path: primary CTA makes a plain task; templates are palette-only and three mo | phase 1 |
| UX-09 | major | 'Seen before' / 'Also in' are project-scoped, but the indicator pivot they link to is vault-wide — the warning | phase 1 |
| UX-10 | minor | Alert intake re-parses on every keystroke in the paste box and overwrites the analyst's manual title/severity  | phase 1 |
| UX-11 | minor | Detail panel gives no save feedback, can lose an in-flight title on leaf close, and lacks the modal's Archive/ | phase 1 |
| UX-12 | minor | Empty states blame the wrong cause: Backlog says 'No tasks match the current filter' with no filter set; panel | phase 1 |
| UX-13 | minor | Hidden and inconsistent affordances / keyboard paths: right-click-only saved-view actions, dblclick inline edi | phase 1 |
| UX-14 | minor | Copy honesty: activity/handover/timeline show raw ids (sev1, in-progress), README overclaims the close-guard,  | phase 1 |

## onboarding-for-all

Protect (port verbatim where possible):
- Honest empty/refusal states everywhere on the first-run path: `openCaseSwitcher` and every project-picker command refuse with a plain Notice instead of an empty
- Settings loading is defensive and migration-aware: every palette falls back to defaults when empty, retired verdicts are pruned, `ganttHideDone` is migrated int
- Layout migrations are link-aware and consent-first: `fileManager.renameFile` so wikilinks follow, `confirmDialog` with real counts before moving, path-keyed set
- Real keyboard support on the dense surfaces: kanban cards are `role=button tabindex=0` with Enter/Space
- Motion respects both the OS and the user: every animation sits under `@media (prefers-reduced-motion: no-preference)`
- Popover already degrades correctly on phones
- Network posture is stated where the key is typed: password-type inputs, 'the key stays in this vault; the indicator value is sent … only when you click the butt
- Community-submission hygiene is already real, not aspirational: `eslint-plugin-obsidianmd` recommended config + sentence-case rule (eslint.config.mjs:6, 24), `c
- INSTALL.md gives an honest, tested-looking upgrade path for the `greysurface-pm` → `casefile` id rename, including the 'never run two writers' warning (INSTALL.

| id | sev | title | status |
|---|---|---|---|
| OB-1 | blocker | Delete project on the first screen has no confirmation and no undo | ★ ✓2.21 |
| OB-2 | major | First-run vocabulary is 'project', and 'case' means two different things in the same command palette | phase 1 |
| OB-3 | major | Fresh vault gets one top-level folder per case at the vault root, and README / INSTALL / settings each describ | phase 1 |
| OB-4 | major | Notification storm on every launch when installed into a vault with overdue tasks | ★ ✓2.21 |
| OB-5 | major | Comments and activity carry no author — team use produces an anonymous audit trail | phase 1 |
| OB-6 | major | Mobile is declared supported but every move/reorder is HTML5 drag-and-drop and key actions are right-click-onl | phase 1 |
| OB-7 | major | Issue keys — the README's first feature — are off by default, and the later opt-in renames files | phase 1 |
| OB-8 | major | Default palettes fail text contrast on the light theme (measured) | ★ phase 1 |
| OB-9 | minor | Startup legacy-format scan reads every root-level note from disk on every launch | phase 1 |
| OB-10 | minor | Unlabeled controls and an editable heading in the forms a new user meets first | phase 1 |
| OB-11 | minor | Settings page is one 13-section scroll with one-person placeholders and rarely-used rows first | phase 1 |
| OB-12 | minor | Community-review readiness nits: version drift, undocumented bundled polyfill, dangling doc links, no mobile s | phase 1 |
| OB-13 | idea | Empty state could teach the three decisions it currently hides | phase 1 |
| OB-14 | idea | i18n: no string table; dates are already locale-aware, copy is not | phase 1 |

## security-trust

Protect (port verbatim where possible):
- Single network call site, twice gated: `requestUrl` appears only at src/soc/IocSection.ts:170, reached only from a per-row click (:305) or Check-all (:254), and
- Absence is never clean: abuse.ch not-listed → 'unknown' (reputation.ts:211-218), 404 → 'not found' (:197-202), VT with no stats → 'no analysis available' (:272)
- No raw-HTML sinks: grep over src finds zero innerHTML/outerHTML/insertAdjacentHTML/eval/new Function/string timers; every element is createEl/createSpan with `t
- IOC values are defanged at every display point (IocSection.ts:274-278 row text, caseReport.ts:135 table, handover.ts:78 via formatIocLine, clipboard block :94) 
- Hydration validates shape and drops garbage rather than coercing it for iocs/links/activity/project config (YamlHydrator.ts:38-84, 248-326); the writer always d
- Keys are entered through `type='password'` inputs (settings.ts:362,379,397) and the setting copy tells the user exactly when the indicator is sent.
- Repo and release hygiene: main.js/dist/backups are gitignored, no data.json or key material anywhere in the tree (grep for key-shaped strings and settings-key J
- Attachments land in the task's own `attachments/` folder with collision-safe naming (ProjectStore.ts:1572-1592); file names come from the browser's File.name or

| id | sev | title | status |
|---|---|---|---|
| ST-1 | major | External links in the description preview are live click-throughs to the analyst's browser | ✓2.21 |
| ST-2 | major | file:// links are deliberately made to launch via window.open | ★ ✓2.21 |
| ST-3 | major | Remote images/iframes in pasted text fetch automatically on open — contradicts 'no network unless clicked' | ✓2.21 |
| ST-4 | major | Check-all sends auto-extracted internal IPs and the org's own domains to third parties | ★ ✓2.24 |
| ST-5 | major | API keys live in plaintext data.json — the one file Sync, iCloud and git-committed vaults replicate | ★ ✓2.21 |
| ST-6 | major | A pasted `## Comments` heading forges or displaces append-only journal entries | phase 1 |
| ST-7 | minor | Hydrator casts nine string fields without a typeof guard — YAML coercion on the slow path can break saves or b | phase 1 |
| ST-8 | minor | Vendor-page links are built from unvalidated response fields | phase 1 |
| ST-9 | minor | Colors from project frontmatter flow unvalidated into inline styles (CSS url() = network on render in shared v | phase 1 |
| ST-10 | minor | Project-title path sanitizer is weaker than the task one (dotfile, trailing-dot, `..`, unbounded length) | phase 1 |
| ST-11 | minor | README overstates the network guarantee; say what is actually true | ✓2.21 |
| ST-12 | idea | No CSV surface exists yet — when the Export epic lands, formula-prefix escaping must be a first-class rule | phase 1 |

## soc-depth

Protect (port verbatim where possible):
- One SLA clock, injected `now`, no drift: `slaState`
- Reputation module is network-free and quota-honest: request builders + parsers are pure (reputation.ts header, vitest-covered), keyless providers that DO cover 
- Append-only log is store-owned: `stampActivity` merges entries onto the LIVE task's log and drops the patch's stale copy (ProjectStore.ts ~L1091-1099), IOC add/
- Case report is honest by construction: every section falls back to 'not recorded'/'None recorded' (caseReport.ts:73,81,131,157,166), values only ever defanged (
- Timeline invents nothing: one event per stored fact, unparseable stamps sort last with the raw value preserved (timeline.ts:56-62), and date-only stamps are sho
- Alert intake keeps the paste verbatim as the description so nothing is lost (alertIntake.ts:64), leaves unparsed fields empty rather than guessed (alertIntake.t
- Verdict guard runs on every close path
- Evidence section lists dangling refs as 'missing' instead of hiding them (AttachmentsSection.ts:60-63); comments live in the note body as blockquotes with hand-

| id | sev | title | status |
|---|---|---|---|
| SD-01 | major | Absence reads as clean: AbuseIPDB 'no reports' and VT 'undetected-only' both return verdict `clean` | ★ ✓2.21 |
| SD-02 | major | Reputation results are session-only — never recorded on the case, absent from report, handover and timeline | phase 1 |
| SD-03 | major | Alert intake stores the alert's Event Time as `detectedAt`, so an old alert from the queue is born breached an | ★ ✓2.23 |
| SD-04 | major | The four lifecycle stamps decide SLA compliance yet are the only tracked-worthy fields NOT in the append-only  | ★ phase 1 |
| SD-05 | major | No asset/IOC boundary: the extractor emits the org's own mail domain and internal IPs as indicators, the intak | ★ ✓2.24 |
| SD-06 | major | Bulk paste has no shape gate — labels like 'IP:', 'Hash:', 'Sender' become `domain` indicator rows | ★ ✓2.24 |
| SD-07 | major | SLA breach log entry is stamped when Obsidian noticed, not when the breach happened | ★ ✓2.21 |
| SD-08 | major | No actor on the audit trail or comments, and comments carry zone-less local time while everything else is UTC  | phase 1 |
| SD-09 | major | Shift handover is overwritten every run and carries no owner, journal or next action for open incidents | phase 1 |
| SD-10 | minor | Case report omits evidence refs, the activity log, assignees/tags and ATT&CK; `task.attack` is a dead field no | phase 1 |
| SD-11 | minor | SLA semantics are calendar-minutes, global-per-severity, never pause, and three surfaces apply two different c | phase 1 |
| SD-12 | minor | Defang dialect gaps: `[dot]`, `(dot)`, `{.}`, `[://]`, `\.`, space-padded ` [.] ` are not refanged, and `hxxps | phase 1 |
| SD-13 | minor | Timeline: date-only `completed` sorts at UTC midnight, so 'Completed' precedes same-day 'Resolved' | phase 1 |
| SD-14 | idea | IR primitives absent for the 'for all' plugin: IOC type coverage, lifecycle phases, evidence custody, typed ac | phase 1 |

## competitive-parity

Protect (port verbatim where possible):
- Verdict close-guard is applied on every single-item path through one function: board drop
- Activity log is store-owned and cannot be overwritten by a stale editor clone: src/store/ProjectStore.ts:1092-1100 merges entries onto the LIVE log and deletes 
- Derived data is labelled derived and never stored: indicator-overlap link rows carry a 'derived' chip and are computed live
- Board ergonomics beat Jira: inline '+ Create' per column with half-typed drafts surviving full rebuilds
- Filtering beats Jira's board filter bar: stay-open multi-select popovers
- Alert intake is honest by construction: unparsed fields stay empty with 'Not found in paste', seen-before indicators name the other cases and pre-check a relate
- Defang-everywhere with two copy affordances (defanged text click vs real-value button) and a one-click defanged block
- Virtualised table with one-time row-height calibration
- Generated artifacts are deterministic and say 'not recorded' rather than inventing values

| id | sev | title | status |
|---|---|---|---|
| CP-01 | major | Bulk 'Set status' closes incidents without a verdict — the only path the README's close-guard does not cover | ★ ✓2.21 |
| CP-02 | major | Audit log skips lifecycle timestamps, so SLA outcomes can be changed without a trace (plus title/tags/links/at | ★ phase 1 |
| CP-03 | major | Free-text search never looks at the description or journal, and nothing says so | phase 1 |
| CP-04 | major | Custom fields are display-only: native controls, no sort, no filter, no query field, no inline edit, no histor | phase 1 |
| CP-05 | major | Observable model is five types; anything else becomes a 'domain' and gets defanged ("invoice[.]docx") | phase 1 |
| CP-06 | major | Case timeline records when the analyst typed, never when the event happened — no analyst-authored dated events | phase 1 |
| CP-07 | major | No cross-project queue — the landing page is a project grid; SLA-breached work in another project is invisible | phase 1 |
| CP-09 | major | Keyboard depth is table-only and the command palette cannot act on the case in front of you (Linear parity gap | phase 1 |
| CP-11 | major | Shift+Enter inside the modal's comment composer saves and closes the case, discarding the half-typed journal e | ✓2.21 |
| CP-12 | major | Exported case report mixes UTC lifecycle stamps with zone-less local journal stamps for the same moments | phase 1 |
| CP-08 | minor | Undo is uneven: 3 of 9 bulk actions have it, two undo systems don't know each other, and the changelog overcla | phase 1 |
| CP-10 | minor | Saved views lose the swimlane grouping, can't be renamed, and new projects ship with zero quick filters the gr | phase 1 |
| CP-13 | minor | Template flow: a floating Menu at hardcoded screen coordinates after a searchable modal; templates can't seed  | phase 1 |
| CP-14 | idea | No in-app activity stream or inbox: notifications are fire-and-forget toasts and 'what changed today' exists o | phase 1 |

## visual-design

Protect (port verbatim where possible):
- Semantic token layer, consumed as aliases not raw hues: variables.css:66-88 defines --gs-sev*/--gs-sla-*/--gs-verdict-*/--gs-ioc-*/--gs-issue-*, and IocSection.
- Motion system is clinical and fully guarded: motion.css:1-6 states the spec (150–250ms, ease-out only, no bounce), every transform/opacity rule sits behind both
- One scoped focus treatment: utilities.css:2-7 applies the DS ring to every focusable inside .pm-root/.pm-modal/.pm-pop and kills the UA outline
- Data-driven color handled once: table.css:315-319 tints any chip via `color-mix(in srgb, var(--pm-chip-color) 15%, var(--gs-surface-1))` so palette-editable sta
- Visual idioms for honesty already exist: derived link rows are dashed + italic (task-modal.css:374-379), missing evidence is an explicit italic label (widgets.c
- Kanban drop feedback uses an inset ring, not a border, so nothing shifts while dragging (kanban.css:97-106), and the dragstart snapshot is captured at grabbed s
- Popover degrades to a bottom sheet on phones with safe-area padding (Popover.ts:31-32,55; task-editor.css:32-58)
- Timeline is genuinely quiet: hairline spine, outlined milestone dots, small faint annotation dots, mono timestamps with tabular-nums (timeline.css:1-4, 33-57).
- Stylesheet is scoped to plugin mounts only (variables.css:20-26) and bundled from split files by lightningcss (scripts/build-styles.mjs:15-19); nothing leaks in
- Kanban column header already made the right call in 2.12.0: sentence-quiet label + 7px status dot + count, color moved off the header bars (kanban.css:55-72, CH

| id | sev | title | status |
|---|---|---|---|
| VD-01 | major | Hard-coded dark ladder ignores the user's theme and font; native menus/settings stay theme-colored | ★ phase 1 |
| VD-02 | major | Hover-reveal controls are invisible or unreachable on touch (manifest declares mobile support) | phase 1 |
| VD-03 | major | The same severity value renders three different ways (board vs table vs header) via a parallel badge implement | ✓2.21 |
| VD-04 | major | Nine sibling 'chip' styles with five radii, four font sizes, six paddings and two line-heights; one card foote | phase 1 |
| VD-05 | major | Board density: four stacked header rows, cards that can carry ~15 metadata elements inside three nested border | phase 1 |
| VD-06 | major | Color semantics collide: red means five things, amber three, the severity ramp is not ordinal, and status uses | phase 1 |
| VD-07 | minor | Contrast failures on exactly the text that carries honesty (missing/empty/derived), avatars, gantt labels and  | phase 1 |
| VD-08 | minor | No type scale: 25 font-size values, weights 650/700 beside 500/600, ten uppercase-tracked label styles, and 'S | phase 1 |
| VD-09 | minor | Spacing has no rhythm: odd paddings (3/5/7/9px), gaps of 7px, section insets that disagree between modal, pane | phase 1 |
| VD-10 | minor | Nested-subtask elbow connector is clipped by the card's own overflow:hidden and never renders | phase 1 |
| VD-11 | minor | Table and board disagree on the same metadata vocabulary; table title cell is a flex `<td>` that wraps unlimit | phase 1 |
| VD-12 | minor | Dead and contradicting CSS, plus a styleguide that links to five files that do not exist — the design language | phase 1 |
| VD-14 | minor | Editor chrome details: redundant severity strip, primary-button hover fill fails contrast, mismatched button/i | phase 1 |
| VD-13 | idea | Design direction: one token sheet, 4-pt spacing, 5-step type, 20px chip, 3-row card — Linear density on Obsidi | phase 1 |

## performance-scale

Protect (port verbatim where possible):
- TableRenderer virtual window
- metadataCache fast path + lazy bodies
- TaskIndex
- Dirty-tracking save path
- Self-write markers with a time window and size-bounded sweep
- parseQuery single-entry memo
- SLA chip tick updates text/class only, never re-renders
- Scheduler is Kahn's O(N+E) with downstream scoping
- Check-all reputation pacing
- diffTaskPatch

| id | sev | title | status |
|---|---|---|---|
| PS-01 | blocker | 5,000-row IOC paste hangs: per-row cross-case scan inside renderRows | ★ phase 1 |
| PS-02 | blocker | 'Open case…' with no recents renders every task in the vault, with three tree walks per suggestion row | ★ ✓2.21 |
| PS-03 | blocker | Kanban: no card cap or windowing, full DOM rebuild on every unthrottled search keystroke, plus a second full f | ★ ✓2.21 |
| PS-04 | major | configFor flattens the whole task tree three times per call, and it sits on scroll-frame, keydown, per-saved-f | ✓2.21 |
| PS-05 | major | Any external touch of one task file reloads the whole project and rebuilds the whole view; the trigger fires b | phase 1 |
| PS-06 | major | Every task save rewrites the project note (taskIds + a '## Tasks' line per top-level case) | phase 1 |
| PS-07 | major | Notifier loads every project at onload, before layout/metadataCache are ready, and keeps all of them resident  | phase 1 |
| PS-08 | major | SLA ticker is owned by ProjectView but the registry is global: no board open → frozen countdowns and leaked ch | ★ ✓2.21 |
| PS-09 | major | Task editor rebuilds everything on every property change; option pickers render the full task list on open | phase 1 |
| PS-10 | major | Archive/unarchive rename files without markSelfWrite → the store drops its own cache → two live copies of the  | phase 1 |
| PS-11 | major | Kanban dragover reads getBoundingClientRect for every card in the column on every pointer move and live-moves  | phase 1 |
| PS-12 | major | Gantt renders every row into one giant SVG with per-bar listeners; two inner loops are O(N·D) and O(M·N) despi | phase 1 |
| PS-13 | major | Board checklist counter (2.20.0) depends on whether the task body happened to be loaded this session — absence | phase 1 |
| PS-14 | minor | O(N) work where O(1) or O(1)-per-item exists: sort comparators recompute per comparison, tree mutators walk de | phase 1 |
| PS-15 | idea | temporal-polyfill is the only bundled third-party code and `today()` (Temporal.Now) runs once per card/row/tas | phase 1 |

## architecture-code

Protect (port verbatim where possible):
- DirtyKind ('fm' | 'full') routing
- Save serialisation is done correctly: per-project promise chain (548-566), dirty map snapshotted and detached BEFORE any await (571-572, with the comment explai
- Hydration copies every container instead of aliasing Obsidian's live metadataCache object (YamlHydrator.ts:155-176, 232-235; extraFrontmatter JSON-cloned at 209
- User-owned frontmatter keys survive the round-trip (KNOWN_TASK_FRONTMATTER_KEYS + extraFrontmatter, YamlSerializer.ts:98-138, 184-188) and comments are emitted 
- mergeMissingSubtasks + explicit removedSubtaskIds (TaskTreeOps.ts:167-186; ProjectStore.ts:1124-1131)
- Activity log is store-owned and rebased on the LIVE task, dropping the patch's copy (ProjectStore.ts:1092-1100)
- Honest hydration: malformed iocs/links/activity entries are dropped, `flagged` hydrates true only when literally true (YamlHydrator.ts:38-84, 141); nothing is i
- Issue-key assignment has a single choke point (doSaveProject 577-585) so every creation path gets keys with zero per-path code.
- QueryParser is a pure, Obsidian-free module with a data-driven FIELD_MATCHERS registry and FIELD_HELP that a test keeps in sync (QueryParser.ts:156-256); `garba
- Cycle guards exist at both layers (moveTask wouldCreateCycle ProjectStore.ts:977-980; Scheduler.wouldCreateCycle 39-63 with Kahn's sort reporting cycles instead
- diffTaskPatch (TaskDetailView.ts:78-87) is the right primitive: field-level diff against a pristine snapshot. It exists, it is exported, it just isn't used ever

| id | sev | title | status |
|---|---|---|---|
| A1 | major | Panel autosave marks in-flight edits as persisted without writing them | phase 1 |
| A2 | major | TaskModal still saves the whole stale clone; the panel's diff-patch fix was never ported | ★ ✓2.21 |
| A3 | major | Cache invalidation cannot reach handed-out Project objects; a later save from a stale holder re-installs it as | phase 1 |
| A4 | major | Renaming a case note or its folder in Obsidian's file explorer makes the case disappear from Responder | ★ phase 1 |
| A5 | major | Duplicate task ids on disk are collapsed silently — one file becomes invisible and is never cleaned up | phase 1 |
| A6 | minor | Retired `priority` is still emitted into every NEW task file and threaded through 29 source files | phase 1 |
| A7 | minor | Issue-key sequence can hand out the same key twice; nothing detects it on load | phase 1 |
| A8 | minor | Hydrator type guards are inconsistent — a number-typed frontmatter value crashes the whole board render | phase 1 |
| A9 | minor | Text-layer round-trip hazards: CRLF defeats the generated-line strippers, and two string encoders plus a dual- | phase 1 |
| A10 | minor | Every task edit rewrites the project note and re-renders the dashboard | phase 1 |
| A11 | minor | TaskSource has exactly one implementation and main.ts narrows with instanceof at four call sites | phase 1 |
| A12 | minor | ProjectStore.ts (1,647 lines) carries ~250 lines of one-shot migrations; path helpers and palette hydrators ar | phase 1 |
| A13 | minor | Test coverage gaps sit exactly where the concurrency findings live; the fake vault never exercises the product | phase 1 |
| A14 | minor | Settings defaults are shared mutable references — the first palette edit on a fresh install mutates the module | phase 1 |

