# Timeline styles, Insert timeline, User and Host kinds — design

Approved by the user on the mockup canvas (screens 7–10, "Responder timeline
mockups"), building on `2026-10-16-note-timeline-design.md` (that contract
still holds for everything not changed here). The user's words: "it shouldn't
always start with time, it should be an option"; "add timeline whenever I want
without highlighting or selecting"; "it is also missing User and Host". Open
choices settled by default: the facts row comes from a last `Details` bullet;
chain colours follow the user's screenshot (orange root, red children).

## Note format (what is saved)

Three marker lines, each alone on its line (surrounding whitespace allowed,
the style word case-insensitive), hidden in Live Preview and Reading view:

| marker | style |
|---|---|
| `%% timeline %%` | `events` (unchanged: time first, gaps) |
| `%% timeline steps %%` | `steps` |
| `%% timeline chain %%` | `chain` |

Any other `%% timeline … %%` text is not a marker. The block rules
(readBlock: top-level bullets, details, one blank line, fences, the bullet
character) are the same for every style.

### Steps (screen 8)

```
## Alert story
%% timeline steps %%
- 21:34 Alert fired: Potential Recon Activity Via Nltest.EXE
- On host: DESKTOP1.domain.local
- User context: domain\user1
- Process launch: nltest.exe
- Command executed: nltest /domain_trusts
- Artifact path: C:\Users\user1\Downloads\
- Details
    - Alert ID: SEC-2023-0704-0001
    - Time: 2023-07-04 21:34 UTC
    - Host: DESKTOP1.domain.local
      192.168.56.95
```

- Each top-level bullet is a step, numbered 1… in order.
- Optional leading time: the same leading-time reader as events (lead words,
  clock, date, carry-forward). Shown as a small chip on the label row when
  written; when absent NOTHING is shown (no "time not recorded" in steps).
- Label/value: the text (after the time phrase) splits at the first `: ` when
  the part before it reads as a name (`/^\p{L}[\p{L}\p{N} ._()#/&'’,+-]{0,39}$/u`,
  the Details NAME_LIKE rule). A bullet ending in `:` is a label with an empty
  value. Otherwise the whole text is the value, with no label.
- Value kind: `detectDetailField(value)` (Email, IP, URL, Domain, Hash, File
  path, Registry key, User, Command line, Message-ID, or null). Non-null →
  monospace; null → body font. Move the pure detection code out of
  `src/soc/DetailsSection.ts` into a pure module `src/soc/detailKind.ts`
  (no `obsidian` import) and re-export from DetailsSection so nothing else
  changes.
- Facts: when the LAST top-level bullet's text (no time) is exactly `Details`
  or `Facts` (case-insensitive, optional trailing `:`) and it has detail
  lines, it is not a step: its detail lines are facts. A detail bullet
  `Key: value` starts a fact; a following non-bullet detail line (deeper,
  no marker) is an extra line of the fact above (the IP under Host).
- Indicators are still found in every line for the Defang count; in steps
  values render as plain text (monospace by kind), no indicator chips.
- Empty step (`- `): ghost hint `Label: what you saw` (display only).
- Header: `list-ordered` icon, `STEPS`, meta `6 steps` (+ ` · details below`
  when facts exist), the live-indicator Defang pill, the menu button.

### Process chain (screen 9)

```
## Process chain
%% timeline chain %%
- Initial process: cmd.exe
    - Terminal process: nltest.exe
        - User context: domain\user1
            - Execution: nltest /domain_trusts
```

- Every bullet in the block is a link: top-level bullets are roots (depth 0);
  a bullet in an event's details is a child of the nearest link above it
  with a smaller indent (depth = that link's depth + 1). A non-bullet detail
  line is a note under the link above it.
- Label/value split and value kind as in steps. Role: depth 0 `Root process`,
  else `Spawned child` (derived, display only).
- Look: each link a card with a 3px left bar (root `--color-orange`, child
  `--color-red`), label coloured and bold, role muted, value monospace with an
  icon by kind (process/command `terminal` for the root, `activity` for a
  child command/process, `user` for User, `globe` for URL/Domain/IP, `file`
  for File path, else `circle-dot`). Between a parent and each child a
  connector `Spawns ↓` (muted, dashed guide). Indent per depth.
- Empty link: ghost hint `Label: process or command`.
- Header: `git-fork` icon, `PROCESS CHAIN`, meta `4 links · 3 spawns`.

### Events: User and Host kinds (screen 10)

- `EventKind` gains `user` and `host`. Kind words: `User`, `Account` → user;
  `Host`, `Workstation`, `Endpoint`, `Server`, `Device` → host.
- Derived (when no explicit kind): `user` when the text holds a `DOMAIN\user`
  token and no higher kind applies. Precedence execution > file > web > email
  > user. `host` is never derived.
- Colours: user `--color-pink`, host `--color-blue`. Icons: `user`,
  `monitor`. Kind picker lists Observed, Web, Execution, File / Download,
  Email, User, Host, Detection, Response.

## Editing actions (pure, `src/timeline/actions.ts`, one undo step each)

- `insertTimeline(lines, line, style)`: a new timeline at the caret, with no
  selection. Null inside a timeline, the frontmatter or a code fence. On a
  blank line: that line becomes the marker plus one empty item `- `. On a
  text line (paragraph, heading): inserted after it; a blank line before the
  marker when the line above is neither blank nor a heading; a blank line
  after the item when the next line is not blank. If the new block would take
  in a list below (one blank line then a bullet), add the second blank line;
  the parser has the last word: the new block must hold exactly one empty
  event. Caret at the end of the new item.
- `setStyle(lines, line, style)`: rewrites the marker of the timeline at
  `line` (indent kept); null when it already has that style.
- `makeTimeline(lines, from, to, style = 'events')`: as now, writing the
  style's marker.
- Chain: `addChild(lines, line)` inserts an empty bullet one indent deeper
  under the link at `line`, after its own details (indent unit: the first
  deeper bullet's extra indent in the block, else a tab); `addEventBelow`
  adds a sibling at the same depth.
- Sort by time is offered for `events` only. Move up/down, delete, defang,
  back to plain list (removes the marker, any style) work for every style;
  for chain, moving or deleting a link takes its subtree.
- `copyForTicket` by style (defanged by the caller as now): steps → a title
  line `Steps (N)` then `1. Label: value (21:34)` lines, then facts
  `Key: value`; chain → `Process chain (N links)` then each link
  `value (label)` indented two spaces per depth with `→ ` before children.

## Menu and commands (`src/timeline/menu.ts`)

- Outside a timeline, caret on a list or a selection that Make timeline can
  turn into one: `Make timeline ›` with a submenu Events / Steps / Process
  chain (setSubmenu, the cast already used in TaskContextMenu.ts).
- Anywhere else outside a timeline (not frontmatter, not code): `Insert
  timeline ›` with the same submenu.
- Inside a timeline: the existing items (labels per style: `Add step below`,
  `Add child`, `Add link below`), `Style ›` submenu (the current style
  checked), sort only for events.
- Commands (editorCheckCallback, no default hotkeys): `timeline-insert`,
  `timeline-insert-steps`, `timeline-insert-chain`, `timeline-make-steps`,
  `timeline-make-chain`, `timeline-style-events/steps/chain`; existing ids
  stay. Command names in sentence case.

## Views

Live Preview (`livePreview.ts`) and Reading view (`reading.ts`, `dom.ts`)
draw all three styles, following the original constraints: theme variables
only (`--color-orange/red/pink/blue`, `--background-*`, `--text-*`), no
`innerHTML`, no block widgets or vertical margins from the ViewPlugin (line
decorations with padding, inline widgets, mark decorations), the marker an
atomic range, the native bullet hidden, every card drawn while the caret is
in it. Steps: the number node replaces the bullet visually; the label sits on
its own row above the value (a mark decoration styled `display:
inline-block; width: 100%` is the intended way; if caret movement breaks,
fall back to the label just before the value on one row in Live Preview
only); facts render as rows in Live Preview and as a grid in Reading view.
Chain: the connector is an inline widget at the start of a child's line with
the line padded to make room (the gap-band technique). Links in a timeline
stay neutralised; Copy is defanged.

## Constraints

Zero runtime dependencies; no network; no regex lookbehind; sentence-case UI
strings; `window.setTimeout`; eslint-plugin-obsidianmd type-checked at zero
warnings, oxlint, oxfmt, tsc clean; every behaviour has a test; existing tests
keep passing.
