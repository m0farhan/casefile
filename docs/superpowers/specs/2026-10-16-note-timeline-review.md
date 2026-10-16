# Note timeline — review findings to fix before release

Four-lens review (data, live preview, hostile content, Obsidian fit), each
finding checked by two skeptics. CONFIRMED = both could not refute it.
Fix each with a regression test, then release (the user approved pushing to
prod once these are fixed).

## Confirmed

Data / actions (src/timeline/actions.ts, parse.ts, menu.ts)
- A selection ending at column 0 of the next line also converts that unselected line (Make timeline).
- Delete event in a loose list leaves two blank lines, which splits the timeline.
- Fenced code inside an event ends the timeline early; Add event writes into the code block; Delete event leaves half of it.
- Make timeline is offered inside YAML frontmatter and writes the marker there, breaking the case's properties.
- Make timeline over a selection containing a fenced code block prefixes '- ' to the fences and code lines.
- Set event kind on a bare '-' bullet produces '-Detection: ' (no longer a bullet).
- Set event kind on a task bullet writes the kind before the checkbox and destroys the task.
- Sort moves a time-only event above the bullet that states a numeric date and detaches it from that date.

Live preview (src/timeline/livePreview.ts, menu.ts, CSS)
- Header is a block-level div inside the marker line: CodeMirror's widget buffers add blank rows; clicks land oddly.
- Clicking a kind word opens the kind picker on mousedown and Obsidian closes it on the same click (open it on click/mouseup, or defer).
- '+ Add event' does not focus the editor, so typing after the click goes elsewhere.
- Link guard: misses Obsidian's mousedown open path, middle-click, Android tap, and popout windows (register per window via workspace 'window-open').
- Link guard also blocks internal [[links]] and tag-like underlines in timeline cards (should only stop external/bare URLs and emails).
- Right-clicking a timeline widget runs the editor menu on the caret's line, not the event clicked.

Reading view (src/timeline/reading.ts)
- Reading view is not redrawn when only the marker line is added or removed.
- Embedded notes inside a timeline card skip link neutralising and defanging.

Hostile content / parser (src/timeline/parse.ts, actions.ts)
- Copy timeline for ticket leaves live domains that the live count and Defang treat as live.
- Live-indicator count does not match what Defang timeline changes.
- Copy for ticket drops or misplaces stated dates when numeric and named dates mix.
- Dotted meridiem ("2:29 P.M.", "12:30 a.m.") is read as a 24-hour time.
- Gaps, span and Sort compare clocks written in different zones as if the same zone (refuse across differing zones).

## Refuted (no change)
- Reading view has no timeline menu on mobile (by design: commands cover it).
- A live URL nested inside a defanged URL (not a real case).
- Link neutralising trusting tag/internal-link classes from raw HTML (pre-existing, shared code).

## Split vote (look again)
- Reading view draws nothing when Markdown's list runs past the parser's block (1 of 2 confirmed).
- A folded event with details loses its card bottom and Add row (1 of 2 confirmed).
- Right-click on a node/header opens the menu for the caret's event (1 confirmed, 1 pending).
