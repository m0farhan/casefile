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

## [Unreleased]

### Added

- **Defang from the right-click menu.** In a case's description, select text and right-click: Defang selection, Refang selection, or Copy defanged. In the description preview, the comments and the phishing report, right-click a selection for Copy or Copy defanged. It defangs a labelled line (`Source Address : 172.16.17.56`) and, inside prose, the tokens that can be nothing else: IP addresses, URLs with a scheme and email addresses. A dotted word in a sentence (`e.g.`, `report.pdf`) is left as written

### Fixed

- The toolbox's Defang bracketed an already-defanged value again (`172[[.]]16…`); a second defang now changes nothing

- **Nothing in the phishing analysis could be selected or copied** (headers, URLs, hashes, the body). Obsidian turns text selection off app-wide and the report never turned it back on. It does now; the hash labels stay out of a copy, as intended, so copying a hash row copies the hash alone

## [2.42.0] - 2026-09-27

### Added

- **Attach files to a case:** the Evidence section has an Attach button, and files dropped on it attach too. Each file goes into the case's own attachments folder (the one Archive moves with the note), and its link goes on the end of the description before a single byte is copied, so no save, close, archive or panel switch while a large file copies can lose it. The file lands in the case's folder as it is when the copy finishes (archived or retitled meanwhile, it follows; deleted meanwhile, nothing is written), Evidence redraws once it is there, and clicking its link before then says it is still copying rather than making an empty note of that name. A copy that fails leaves its link listed as missing under Evidence and names the link to remove. Pictures are embedded and show inline; anything else is only ever a link, never an embed (it may be the sample). The section now shows on every saved case, with "No files attached" when there are none; a new case offers Attach once it has been created and has a folder

### Changed

- **Done cards read as done:** in a complete column the card eases back to 65% (90% under the pointer, to read it), and everything under the title is lightly struck through. The title stays whole so the card still says what it was, and so do avatars
- **Attachment names are unique across the vault.** A case links its files by bare name, which Obsidian resolves by name: with two files of one name (two cases each attaching `email.eml`) it picked the other case's. The second now saves as `email 1.eml`. Names are compared the way Obsidian stores them (a macOS screenshot's narrow no-break space is a plain space), and a name whose copy failed stays taken, so its dangling link can never come to point at another file. A name with no letter extension (a hash-named sample, `.env`, `image.001`) gets `.bin`, or Obsidian could not resolve its link and Evidence reported no file attached
- The comment box has no resize grip: it grows as you type, and a dragged size lasted only until the next keystroke

### Fixed

- A file dropped or pasted on the description was always embedded, so a dropped note rendered in the preview and loaded its remote images, and its name was not cleaned (`a#b.pdf` linked a heading). It now follows the Evidence rule above
- Side panel: an edit made while the previous autosave was still writing (a second comment deleted, a subtask removed) was marked saved but never written
- A card created in the board's Unassigned swimlane was assigned to the current user and jumped to their lane
- Done cards struck through the avatar initials
- A subtask card let long chips spill past its border and the column scrolled sideways; a sub-subtask was drawn as a sibling of its own parent subtask; and while a card was dragged the connector lines pointed at the wrong cards (they now hide until the drop)
- A restored multi-line comment draft jumped the modal or panel on redraw, and a comment box in a hidden pane collapsed to 2px
- The task-form progress handle: a phone or tablet keeps Obsidian's own finger-sized handle (a capsule on iOS); under a light theme the track no longer paints a near-white bar on the dark surface

## [2.41.0] - 2026-09-27

### Added

- **Tomorrow bucket** between Today and This week, everywhere buckets appear (task form, backlog groups, lanes, the Move to bucket menu, `bucket:tomorrow` in search)
- **New work is yours by default:** with Settings → Current user set, every new case, task or subtask (the task form, the column's + Create, alert intake, phishing analysis, a note turned into a case, the Subtasks panel) starts assigned to you. A template or an assignee swimlane that names its own people still wins, and the form shows it before you save
- **Reorder team members** in Settings with up/down arrows; the assignee picker and the bulk Set assignee menu follow that order (team first, then anyone else already assigned, A to Z)
- **Delete a comment:** each journal entry has a delete button (shown on hover, always on touch), behind a confirm
- **Done looks done (Jira):** a card in a complete column keeps full strength instead of fading, leads with a green check, and has its issue key struck through

### Changed

- Subtasks sit straight under the description, in the task form and the side panel alike
- The comment box grows as you type (up to 40% of the window, then scrolls); pictures, tables and code in a comment fit its width, the wide ones scroll inside it; on a narrow panel the Add button wraps under the box

### Fixed

- **Dragging a card into another column snapped it back**, most of all when dropped on an empty column's "No items" box. A drop zone only accepted `dragover`, never `dragenter`; on the move that brings the pointer onto a new element Chromium fires only `dragenter`, and uncancelled it leaves the drop refused. The board even causes that move itself (the first `dragover` hides "No items" and slides the card in under the pointer). Columns, the collapsed strip, settings list rows and Gantt label rows now accept the entry too
- The progress slider in the task form: Obsidian 1.13 fills a `.slider` from `--slider-fill-ratio`, which only its own slider component sets, so a sliver of colour sat at the left whatever the value (and the macOS handle is a 30×18 white pill). The value now sets the ratio, and the handle is a small accent dot, all through Obsidian's own slider variables
- Subtask connector lines on the board never showed: the card clipped everything outside its box twice over (`overflow: hidden` and the paint containment `content-visibility` brings). A nested card now draws its elbow to the parent, and a run of subtasks hangs off one continuous stem

## [2.40.0] - 2026-09-27

### Added — alert kinds you can see, record and edit

- On a case board, an incident with no kind tag now shows the kind its title names. A case made
  by hand, such as `77 - SOC138 - Detected Suspicious Xls File`, used to show
  the generic incident siren everywhere; it now shows Suspicious file, drawn
  faded with a dashed ring so it cannot be taken for a recorded kind. The
  tooltip gives the word that matched and says the kind is not recorded on the
  case. Nothing is written to the case, and a kind its tags record always wins.
  The board card, the table row, the side panel and the case dialog header all
  draw the same icon; the dialog header did not show one before.
  **Derive the alert kind from the title** (on by default) turns this off.
- An **Alert kind** property on incidents on case boards, in the case dialog
  and the side panel. The list shows each kind with its icon, plus None.
  Choosing a kind records it as the case's one kind tag and removes any other
  tag that names a kind; None removes the kind tags. A kind that is only
  derived from the title shows as, say, "Suspicious file (derived from title)"
  in the muted unset style until one is chosen.
- A **Settings → Alert kinds** section to edit the kinds themselves: label, tag
  ID, colour, icon and match words, one card per kind. Kinds can be added,
  reordered by dragging or with the arrows (the order is precedence: when a
  case matches several kinds, the first wins) and deleted. Deleting a kind
  asks first and never edits a case. A tag ID another kind already answers
  to, or one with a space in it, is refused, and so is a label or match word
  another kind already answers to — the notice names that kind — so one word
  never names two kinds and no existing case changes kind behind your back.
  Open boards redraw as you edit. A kind's icon can also be an emoji.
- An icon picker for the kinds: a search over Obsidian's own icons, each one
  drawn in the list.
- A new built-in kind, **Suspicious connection**, for outbound and inbound
  connections, connection attempts and blocked connections. Your saved list
  is never rewritten on its own, so an existing vault gets it from **Add
  missing built-in kinds**, which adds each shipped kind your list lacks at
  the end and leaves the rest exactly as it is. A built-in that a kind in your
  list already answers to (a renamed Phishing, say) is skipped, and the notice
  says why.

### Added — reset the Reports tab

- **Reset reports** on the Reports tab makes every chart and headline number
  count only cases created from that moment. Nothing is deleted and nothing
  is asked: the cases stay on the board and **Show all time** puts them back.
  The moment is stored on the board note, so each board keeps its own.
- The bar above the numbers says what is counted and what is left out —
  cases created earlier, cases with no readable creation time — and how many
  of those are still open, because a zero after a reset reads exactly like a
  quiet week. Weeks before the reset are not drawn, and **Open incidents by
  severity** says when open incidents are left out rather than that there are
  none.
- A save that fails puts the old value back, so the screen never shows a
  reset the board note does not hold.

### Added — severity on plain boards

- Severity is the one urgency dial, and a plain board — goals, projects — had
  no way to say which card matters most. It now shows in the task form, on
  the card with its coloured edge, in the side panel and as a table column on
  every board. Plain boards still run no response clocks and record no
  verdicts or indicators, so their table sorts that column by severity only,
  with no Breach sort.

### Added — see inside an attachment without opening it

- A PDF attachment shows the JPEG pictures it carries, drawn from their own
  bytes. A QR-code phish whose code is a JPEG is one page-sized picture with
  nothing else in it; it is now on screen. Only JPEG (`/DCTDecode`) and
  JPEG 2000 (`/JPXDecode`) image streams are lifted out, and a JPEG 2000
  picture is listed and hashed but not drawn. A picture stored any other way —
  `/FlateDecode`, which is how most PNG-sourced pictures are stored — is not
  read, and when nothing was lifted out the card says which streams are, so an
  empty space is not taken for a PDF without pictures. A stream whose own
  bytes are not a picture — a program stored under `/DCTDecode` — is called a
  stream, not a picture ("Stream at …" on the card, "embedded stream" in the
  report), and says what its bytes begin as.
- Alongside the pictures: the links the PDF declares (`/URI`, escapes and hex
  strings decoded, then defanged, and listed once), a count of the action
  names in it (`/JavaScript`, `/OpenAction`, …), and where the scan is blind,
  said in words.
- A PDF with bytes in front of its `%PDF` header — a space, a byte-order mark,
  or a program, JPEG or GIF stub in front of a real PDF — is read as a PDF
  when the header is within its first kilobyte, as Acrobat reads it. The card
  says where the header is, and if the reader breaks it says it was the PDF
  reader that stopped.
- A Word, Excel or PowerPoint file, or any other ZIP, shows the PNG, JPEG and
  GIF pictures it holds, wherever they sit in the archive — the "enable content
  to view this document" banner is a picture. An entry is drawn only when it is
  named as a picture, its bytes begin as one, and it was read whole at the size
  the ZIP directory declares; one named as a picture whose bytes are something
  else is listed as a file. Alongside the pictures: the external targets
  its relationships declare (a remote template, a linked object), and any entry
  named like a macro project, an OLE object, an external workbook link, an
  ActiveX control, an embedded file, an executable or script, a file type that
  can carry script (`.chm`, `.msc`), a shortcut-style file (`.url`, `.iqy`,
  `.library-ms`, …), a disk image, or a web page, SVG or OneNote file. The
  entry list sits behind a disclosure headed by how many entries were read
  from the ZIP directory — not how many it declares, because a listing that
  stopped early is not the archive's whole contents — and each entry says
  whether it is encrypted.
- The other files inside a ZIP — in a plain archive every file that is not a
  picture, in an Office document every part that is not XML, such as
  `vbaProject.bin` — are typed from their own first bytes and, when read
  whole, hashed. A program named `Invoice.pdf` or `photo.jpg` inside
  `files.zip` is caught by its bytes: "named .jpg but the bytes begin as
  Windows executable (MZ)", and its hash reaches Indicators and the case. A
  file too large to read whole gets what its first bytes are and no hash,
  because a hash of part of a file is not that file's hash. An empty file is
  left out, so the empty-file SHA-256 never reaches Indicators. Archives
  inside archives are not opened, and an archive, compound file or PDF found
  inside one says its own contents are not listed.
- The ZIP reader opens at most 24 entries and reads at most 32 MB out of one
  file. One message's attachments share 64 MB between them for pictures and
  inner files, PDF pictures included, read in order. What was not read is
  counted in a note that says why — a budget used up by what was read before
  it, encryption, damage, an entry named as a picture that holds 0 bytes —
  with one note per reason rather than one per entry.
- A legacy `.doc`, `.xls`, `.ppt` or `.msg` lists what its compound-file
  directory holds, storages and streams, and names the entries that say what
  they are: `Macros`, `VBA`, `_VBA_PROJECT`, `_VBA_PROJECT_CUR` and `PROJECT`
  as VBA macro storage, `\x01Ole10Native` as an embedded OLE package,
  `ObjectPool` as embedded objects, and `EncryptedPackage` as an encrypted
  Office package whose contents cannot be read here — which is what a
  password-protected `.docx`, `.xlsx` or `.pptx` is. No stream is opened. The
  card used to show only the 512-byte header, where no name ever appears.
- A Windows shortcut, a OneNote file and a cabinet are recognised by their
  headers, so a shortcut named `Invoice.pdf` says "named .pdf but the bytes
  begin as Windows shortcut (LNK)". JPEG 2000 is recognised too, and named JP2
  or J2K rather than JPEG, which it is not. A file whose name promises a
  format (`.pdf`, `.docx`, `.jpg` and the rest), or whose declared type is a
  PDF, and whose first bytes match no signature this knows, now says so
  instead of saying nothing.
- Plain ASCII text stored as UTF-16 — a shortcut's command line, the text of a
  `.msg` or a OneNote file — is scanned for indicators too, even when it starts
  at an odd byte. A shortcut's own strings are read by the lengths it records,
  so the link or command it holds is found whole rather than glued to the
  string after it.
- Every attachment is scanned for indicators whole up to 2,000,000 bytes, and
  past that at both ends — at most the first and the last 1,000,000 — with a
  fact giving the exact bytes the text scan read and skipped, and naming the
  PDF, ZIP or compound-file reader when one read the file separately. An HTML
  smuggling page puts a megabyte of base64 first and its script last, and only
  the head used to be read. A file read as text also gets a count of any script
  and markup names in it — `<script`, `atob(`, `new Blob`, `createObjectURL`,
  `.download`, `window.location`, … — counted as text, not parsed, and the line
  says so. An RTF file gets a count of its `\object`, `\objdata` and DDEAUTO
  markers over the same bytes, not only over the 20,000 characters the preview
  shows, with the first `\objclass` named when it is a short plain class name.
- The list of what was found inside a file stops at 100 and says how many more
  there were, so the hundredth line is not read as the last.
- A disk image (`.iso`, `.img`, `.vhd`, `.vhdx`) is called a disk image whose
  files are not listed, not an executable. One whose bytes are a ZIP says the
  entries listed are the ZIP directory's, and that a disk-image file system in
  the same bytes is not read. A `.zip` whose entries were listed no longer also
  says its contents are not visible.
- A forwarded message attached as `.eml` has "Analyse this message in a new
  tab", so its own Received chain and authentication results are read as
  headers rather than as body text.
- The readers are bounded so a hostile file cannot stall the analyser: a PDF
  built so that every search for `endstream` fails is read in one pass, every
  byte a ZIP inflates counts against its budget whether it is kept or not, a
  `.docx` whose relationships repeat `<!DOCTYPE>` thousands of times is read
  in linear time, and each byte of a PDF goes into at most one picture.

### Changed — the phishing analyser is a tab

- The analyser opens in its own workspace tab instead of a dialog. A modal
  covered the board, capped the report at half the screen, and had to close
  before the case it produced could be looked at. As a tab it takes the whole
  pane: the report fills the height and scrolls on its own while the paste
  box, the pane switcher and the actions stay put.
- Every open is a NEW tab, so a reported mail can sit beside the one that
  arrived an hour earlier. Reusing one tab would have thrown the first away.
  The tab and the pane's own title read "Phish: " and the subject — escaped,
  and cut to 40 characters — so two analyses can be told apart, and go back
  to "Phishing analysis" after Reset.
- Creating a case from the analyser no longer closes it. The case opens on
  top, and the evidence stays on screen while it is written up.
- **Reset** clears the message and its analysis to start another. Nothing is
  asked first: nothing here was saved, and a loaded `.eml` is untouched.
- A `.eml` loaded from the vault is analysed in full but no longer copied
  into the paste box, where a large mail cost seconds of layout before the
  analysis began and again on every keystroke. A line under the box names the
  file and its size and says it was analysed in full and is not shown; typing
  a paste or Reset clears it.
- The layout is fitted to a tab rather than carried over from the dialog. The
  pane switcher no longer sits on the paste box's bottom edge. "asserted by"
  follows the result it qualifies instead of being pushed to the far edge,
  which in a full-width tab put 550px between a claim and its source. Hop
  timestamps never split inside themselves in a narrow pane — the text beside
  them wraps instead. The dialog-era caps on body text (180px) and images
  (420px) are lifted, so a message body is no longer a scroll box inside a
  scroll box. In a pane narrower than about 550px the buttons wrap instead of
  sliding off the left edge, and long values wrap instead of running past the
  card or the report.
- The section headings are banded. IDENTITIES, AUTHENTICATION, PATH,
  OBSERVATIONS and SENDER DOMAIN were drawn in the same colour as the field
  labels beneath them, so a section title and "Subject" were the same shade
  and the whole report read as one long list. Each heading now sits on its own
  surface with an accent edge and white text, so the report reads as blocks you
  can jump between. The accent carries no meaning: in this panel amber marks a
  fact that differs, and green and red are the words an authentication header
  actually stated, so furniture stays out of those three.

### Changed — the attachment card

- The card reads top down in the order the questions come: the name; the
  declared type beside what the bytes begin as, and the size; the button to
  analyse an attached message; the facts; SHA-256, SHA-1 and MD5, each on its
  own row; what was found inside the file; then what the reader found, then
  the pictures, then the reader's own notes. The pictures used to come first,
  and at up to 60% of the window's height each they pushed `/OpenAction` and
  the remote template out of view.
- A hash's label cannot be selected, so copying a row copies the hash alone.
  MD5 is on the card now, as it already was in the report.
- Flagged entries, PDF links, external targets and inner files stop at 50
  lines, on the card and in the copied report: the card keeps the rest behind
  "N more", and the report counts them. The found-inside list does the same on
  the card. A ZIP of 200 encrypted programs was some four hundred flagged
  lines, and the next attachment was screens away. Past 50 attachments the
  rest wait behind "N more" too, and hidden rows and entry lists are drawn
  only when opened, so a mail of thousands of parts opens its Attachments tab
  at once.
- The PDF line says "/Encrypt present", as the report does. It used to turn one
  matched name into a claim about what the scan could see.
- "No whole picture was found in this file to draw" is gone. It appeared on
  files whose pictures the readers never look for, and headed every ZIP card
  that had none. Each reader now says in its own terms what it reads.
- Names the sender wrote — the attachment's own, entry and inner-file names,
  relationship sources, picture locations — are shown with control, format
  and direction characters written out as `<U+XXXX>`, on the card and in the
  copied report. A right-to-left override could reverse the tool's own
  sentence around a name, and a newline in an entry name drew a row for an
  entry that does not exist.
- "Analyse this message in a new tab" sits under the type line, has a
  tooltip, and looks like a button. It was filled in the card's own colour
  with no visible edge, so it read as plain text. In a narrow pane its label
  wraps inside the card.
- The Attachments tab counts inline images in words — "Attachments (3,
  1 inline)", not "(3+1)" — and their heading says only what is known:
  "Inline images — marked inline or given a Content-ID by their own headers".

### Changed — case descriptions read the same while you edit them

- Clicking into a case description no longer moves the text. The preview and
  the editor used to lay it out differently — different heading sizes, the
  list text 30px apart, tighter lines, a smaller box under an extra toolbar
  row — so the whole section jumped on every click. Both now share one layout
  read from Obsidian's own typography settings, and headings, paragraphs,
  lists, checkboxes, quotes and code blocks stay where they were. Links and
  embeds still show as source while you edit, and tables and lists inside
  quotes are not matched exactly.
- The description is set in your note text font and size, as a note is,
  instead of the smaller interface type it used before.
- Lists hang their bullet, checkbox or number where the preview draws it, and
  nested items indent by their real depth. The raw `- ` shown on the line the
  cursor is on sits exactly where the dot was. Blank lines between blocks
  give the same space in both modes, and a line wraps at the same word.
  Heading lines still shift their text by the `### ` marker when the cursor
  is on them, as Obsidian's own live preview does.
- A checkbox with any mark in it draws as a checkbox in the editor too,
  ticked for anything but a space; only `x` is struck through, in both modes.
- The format toolbar sits in the section's heading row, so switching to edit
  adds no row above the text. Beside it, an **Edit description** button opens
  a description that already has text from the keyboard.

### Changed — defanging, scanning and previews

- Every scheme except http and https loses its colon when defanged —
  `ftp[:]`, `ms-msdt[:]`, `search-ms[:]`, `ms-word[:]` — where a list of six
  names used to decide. An IPv6 address keeps its colons. A leading UNC `\\`
  becomes `[\\]`, so a dotless `\\fileserver\share` is inert too. A row typed
  as a hash is defanged by its value like any other, so a pasted
  `javascript:` in a hash row no longer stays live. Refanging reverses all of
  it.
- The Links tab shows each link, and its derived domain, in the same defanged
  form as the report and the Indicators tab — `hxxps://`, and `[:]` for the
  colon of any other scheme. It only bracketed the dots.
- An indicator scan stops a URL at a control character, `{`, `}`, a
  backslash and the replacement character, so an RTF template
  `{\*\template http://evil.example/t.dotm}` yields exactly that URL, and NUL
  padding no longer rides along on the end.
- An RTF file or a script with a `#!` line previews as text when it is text,
  not as a hex dump.
- Reading a large paste does less work: the header reader no longer scans the
  whole raw message for a list of indicators nothing used, and MD5 is several
  times faster.

### Changed — documentation

- The README and INSTALL describe what the plugin does today: one folder per
  board, where boards are found, the features that write, move or read case
  data, and the minimum Obsidian version.
- The shipped `main.js` carries the MIT licence notices of the date and time
  library it bundles.

### Fixed — boards filed outside the default folder

- 2.39.0 let a board live in any folder, but every screen still looked for
  boards only in the default folder, so a board filed elsewhere vanished from
  the boards list, notifications, the shift handover and the dashboard at
  once. Boards are now also found through every note Obsidian has indexed as
  a board, and every board opened or saved this session, without reading any
  file to find them. A board that arrives by Sync outside the default folder
  appears once Obsidian has indexed it.
- The Boards pane redraws when a board outside the default folder changes.

### Fixed — boards and cases

- A change made outside the open board — a colleague's edit arriving by
  Sync, a hand edit to a case note, a folder dragged in the file explorer —
  now refreshes the board in place. Before, the board view, the side panel,
  the case dialog and the SLA check could each hold an older copy of the
  board, and the next save from one of them erased what the other had
  written: breach entries, activity rows, journal entries, a changed status.
- The board settings dialog edits a draft and saves the board itself. Saving
  it could revert settings, erase breach entries, lose a description edit and
  bring back an old board.
- A board note renamed or moved in the file explorer is followed: the open
  board, its tab and its view mode move with it. It used to detach every case
  and bring back the old paths. A board whose cases folder is missing says
  "Cases not found", takes no new case and is never saved over, so the list of
  cases it records is kept.
- Deleting a board no longer trashes another board filed inside its folder,
  and creating or moving a board into another board's folder is refused with
  the reason. After Delete board, a side panel still open can no longer
  recreate the board.
- Properties you add to a board note by hand — tags, aliases, cssclasses —
  are kept when the board is saved. The board description is no longer copied
  into the board note again on every save.
- A property such as `Ticket: ref` on a case no longer breaks it on the next
  save, and a list property with an empty item no longer blocks every later
  save of the board. A value of the wrong kind written by hand — a number as a
  title, a single tag that is not a list — is read as written instead of
  hiding the board or failing its saves. A note saved with Windows line
  endings loads instead of vanishing.
- Two case notes with the same id — "Make a copy", a sync-conflict copy — no
  longer hide the original and block every save of the board: the note whose
  name matches its title wins, and the others are named once in a notice and
  never written. A subtask loop no longer makes a board unloadable, and a case
  listed twice shows once.
- A new case or a rename that collides with an existing note is refused
  before anything changes, and says why. It used to leave a ghost card that
  failed every later save of the board.
- Case keys are never handed out twice: the next key skips past every key
  already on the board, and running **Adopt issue keys for a board** again
  never reissues a deleted case's key. The command asks which prefix to use
  first, and a CVE or APT id in a title is no longer taken for a key and cut
  out of the title.
- Retitling, moving or archiving a case renames its note with Obsidian's
  link-aware rename. It used to create a new note and delete the old one, which
  broke links you had written to it and closed its open tab.
- A case titled `Archive` or `attachments` gets ` (task)` in its file name, so
  deleting it can no longer trash the board's Archive.
- The subtasks of an archived parent stay with it in and out of Archive.
- A case file name is never cut in the middle of an emoji, and a tab or line
  break in a title becomes a space in the file name.
- A due date shows its own day for analysts west of UTC; it read a day early.
- A case whose note records no creation time is treated as unknown, not as
  created at load time. It no longer shows as updated today, counts as opened
  this week, or restarts its SLA clock on every load.
- An incident moved from a closing status back to an open one has its
  resolution time cleared, and the change logged, so its clock runs again and
  can breach; it used to stay "met" for good. Hand edits to a case's lifecycle
  times — occurred, detected, responded, contained, resolved — and to its type
  are recorded in the activity log, since they decide SLA outcomes.
- An investigation journal can no longer be taken over by a `## Comments` line
  in a pasted description, and a line inside an entry that looks like a time
  stamp stays in that entry instead of splitting off as a back-dated one.
- Hand-written `Project: [[…]]` or `Parent: [[…]]` lines in a description are
  kept on save; only the link the plugin writes itself is removed. **Remove
  board backlinks from task notes** no longer skips notes.
- **Import notes as tasks** imports into the board you are looking at, not the
  first one open, and names it. It no longer offers board notes or case notes,
  and a board note is never turned into a case. An imported note keeps its own
  properties and tags, TaskNotes time entries come across as time logs, a
  notice names any property a move had to replace, and a note that opens with
  a `---` rule keeps its first paragraph. The picker draws at most 200 rows and
  says how many more match. A TaskNotes task that repeats on several days of
  the week is imported without a repeat rather than as "Repeats weekly".
- A board in the old single-note layout is labelled with the folder it is in,
  not "Vault root", and **Move each board into its own folder** moves each
  board in place instead of back to the vault root, and keeps your default
  folder setting.
- A default folder you deleted is no longer recreated every few minutes, and
  startup no longer reads every note at the vault root from disk.
- Board colours from a board note accept only hex values and colour names, so
  a board note cannot make the dashboard fetch a remote address.

### Fixed — the board, table and Gantt

- Changing a filter no longer clears the board's swimlanes. A saved view
  keeps its own copy of its filter, so clicking a filter no longer rewrites
  the saved view on disk, and its sort order is applied. Renaming or moving a
  board keeps the view you had open.
- A case renamed or created outside the board shows up on it; dragging a card
  afterwards used to recreate the old file as a duplicate case.
- Clicking away from the board title with it empty or unchanged no longer
  saves it.
- Search matches every free word, not the words as one phrase. On a Sunday,
  **This week** and `due:this-week` no longer take in the whole next week.
  `due:!<date>` no longer hides every undated task, and a word such as
  `constructor:` is not read as a field.
- A column's WIP limit counts every unarchived case in that status, not only
  those in the lane and filter on screen, and shows both numbers when they
  differ.
- A card dropped into another swimlane keeps its new status and says that
  lanes follow the case's field, instead of silently snapping back.
- Undoing a bulk close or a drag into a closing status restores the completion
  date and the response and resolution times exactly, so the SLA clock runs
  again.
- A plain board never asks for or writes a verdict: no prompt on close, no
  **Set verdict** in the bulk bar, no Verdict filter. On a case board, a bulk
  verdict change touches incidents only, and a bulk close asks "Verdict for
  these N incidents?" rather than "this incident".
- The table forgets a case deleted from its row menu, so bulk counts are true.
  Shift-click after the range anchor has gone selects the row it ticks. Enter
  and Backspace on a focused button do what the button does instead of opening
  or deleting the row. Clicking a due date that carries a time, then clicking
  away, no longer erases it.
- A card whose description holds a long hostile paste no longer stalls the
  board on every render.
- Gantt: Cmd/Ctrl+Z in a text field or a dialog undoes the typing, not the
  last date drag. The left handle cannot drag a start past the due date. A
  mistyped year no longer makes the chart loop over tens of thousands of days;
  a date far outside the chart is stated in words at its edge ("Outside the
  chart range: due 2206-09-26"). A link that would make a dependency loop is
  refused. Arrows reach due-only tasks and milestones where they are drawn,
  and **+ milestone** saves only a due date.
- Undoing a date drag shows one message, which names the case and the board,
  and, when auto-scheduling had moved other tasks, says how many so their
  dates can be checked. The commands are now **Undo last gantt date change**
  and **Redo last gantt date change**, which is all they ever undid; they say
  what they reverted, are hidden when there is nothing to undo, and refuse
  when the case is no longer on the board.
- The Gantt label column takes at most 45% of the width, where a fixed 280px
  left a phone about 90px of timeline, and its resize handle works by touch.

### Fixed — the case dialog and side panel

- The side panel's autosave never writes a close you have not answered the
  verdict prompt for. It used to stamp a resolution that never happened.
- The side panel saves every edit: assignees, tags, dependencies, multi-select
  fields and checkbox ticks were lost when nothing scheduled an autosave.
  Ticking a box in the description preview starts the autosave. After the
  first save, subtask ticks are written and indicator and assignee changes are
  logged.
- The dialog and panel no longer revert subtask changes made on the board,
  delete their activity rows, or bring deleted subtasks back as empty cards.
- Archive and Unarchive in the case dialog run the same checks as Save,
  verdict prompt included, and ticking an incident subtask's checkbox asks
  for its verdict and stamps its resolution.
- After a failed Archive, later saves in the dialog land. Shift+Enter in the
  title saves again instead of adding a line break. Closing the dialog with a
  title that collides keeps the old title and says why, instead of discarding
  every other edit.
- Closing a new case you have typed into — the X, Esc, a click outside, Open
  as note, an indicator pivot, a subtask or a linked case — asks first.
- The date picker never erases a date on close: only Clear clears, and a date
  with a time survives opening the picker.
- Clearing a number field removes it; it used to be saved as the text "NaN".
- A severity the board's list does not know shows its id — on the card, in the
  table, the dialog, the panel and Reports — instead of reading as no
  severity. Its badge says "Not in the severity list".
- Evidence opens from a case only when Obsidian can show the file itself.
  Anything else — a dropped executable, an archive — offers **Copy path —
  opens outside Obsidian**, and a link or embed to such a file in a
  description or comment copies its path instead of handing it to the system.
- A description or journal comment that could load anything remote — raw
  HTML, a `![](…)` image — is shown as its source in the case views, every
  byte kept and none of it rendered. 2.39.0 cut a list of tags and remote
  markdown images out before rendering, and lists are what get bypassed: a
  styled background, `<image>`, `<input type=image>`, inline SVG and
  reference-style images all walked past it. The price is that a description
  holding ordinary HTML or a markdown image shows as source too.
  `![[embeds]]` are unaffected.
- The lifecycle panel no longer says the clock "runs from case creation" when
  there is no creation time or no clock; it says the SLA has no start.

### Fixed — case reports, handover, reports and notifications

- A case report or shift handover writes case titles and indicator notes
  escaped, so a sender-written title can no longer turn into a live image,
  embed or link in the note it opens. Indicator values sit in code spans, so a
  UNC path keeps its backslashes and underscores are not read as emphasis.
- The handover prints status, severity and verdict names instead of their
  ids, defangs indicator values in its activity rows, and prints "(unset)" for
  an empty side. The case timeline defangs them too, and sorts Completed at the
  close instead of at midnight UTC, usually before the case was even created.
- The case report says "Target set — no clock" or "not computable" when a
  target exists but a time is missing or unreadable, where it used to say "No
  target set." or "met (NaNm inside target)". It notes that journal entry
  times are local and carry no time zone, and its footer says the date is UTC.
  On a plain board it gives its refusal sentence instead of "Something went
  wrong".
- An SLA target of 0 runs no clock, rather than breaching every incident at
  that severity the moment it is created.
- A missed target is logged in the case's activity even with notifications
  off. More than three notices at once fold into one summary, and archived
  cases no longer raise overdue notices.
- Reports: a late response counts as a breach in **Targets met**, even when
  the case was resolved in time. Weeks follow your local calendar, so a case
  can no longer close a week before it opened. **Time in open statuses**
  (renamed from Time in status) measures every case the same way and leaves
  closing statuses out. The "no detection time" notes say how many incidents
  they are out of.
- The SLA chip's tooltip says a running clock never pauses, whatever the
  status.

### Fixed — indicators and reputation

- A UNC path is judged by its server, so `\\10.0.0.5\c$\evil.exe` is one of
  your own assets and is never sent to VirusTotal or URLhaus. An owned domain
  written in Unicode or with an ideographic dot matches its rule, so it is not
  sent either. A value with no address, host or hash shape — a local path, a
  bracketed address — is never sent, and **Check reputation** says "Not an
  address, host or hash a provider can look up — nothing sent" instead of
  asking for keys you already have.
- **Check all indicators** asks again for rows whose last lookup was
  rate-limited or failed on the network.
- AbuseIPDB marks an address clean only when it is whitelisted; a low score
  with abuse reports stays unknown and keeps its numbers. An abuse.ch reply
  that was read correctly names the provider's answer instead of saying
  "unreadable response".
- The indicator scan is linear on hostile text; a 160 KB paste froze
  Obsidian for about 40 seconds and ran again on every keystroke. The
  Indicators section finds sightings in other cases in one pass per render.
- A defanged value can no longer lie about where it goes: `paypal。com.evil。co`
  has every dot bracketed, ideographic and fullwidth full stops included; bidi
  overrides are stripped; `javascript:` and `data:` lose their colon, even
  behind a control character.
- Pasted `[dot]`, `(dot)` and `[://]` are read, and a URL with `(.)` in it is
  no longer cut short. A bare URL no longer carries a closing curly quote or
  sentence punctuation. Two URLs that differ only in the case of their path
  are both kept.
- Indicator values in the activity log and the handover are shown defanged.
- Toolbox: read-as-timestamp no longer makes up dates — a syslog stamp without
  a year, a version string or `09/10/2026` gives no reading, and each reading
  says whether its zone was stated. Refang and defang handle lists and
  `label: value` lines whole. Percent-decoding decodes what it can when one
  escape is malformed, and says so.

### Fixed — alert intake

- A pasted alert that quotes markup is fenced when the case is written, every
  byte kept and none of it rendered, so it is inert in the plugin, in reading
  view and in an exported file. Markdown and reference-style images, embeds,
  code fences (`dataviewjs` included) and inline `$=` queries are fenced too;
  they used to reach the case note live. Alerts without markup stay prose.
- A time with no zone is marked in the preview as read in your local time;
  it used to be taken as a definite instant without a word. A date with no
  time is not taken as a time at all, rather than given an invented midnight.
- A paste with long runs of spaces no longer hangs the dialog, and a title is
  never cut in the middle of an emoji. A bulleted `- Key : Value` paste has its
  rule, event time and severity read.
- The suggested kind follows the title as you edit it, and the dialog names
  the board the case goes to ("New case on …"). A case the board refuses says
  why.

### Fixed — the phishing analyser

- An ordinary attachment with a Content-ID — Gmail gives them one, and Apple
  Mail sends a PDF as `inline; filename=` — was filed as an inline image, so
  its lure reached neither Indicators, the report nor the case, and a mail
  whose only attachment it was said "Attachments: None". Only a part whose own
  bytes are a picture this draws, and whose own headers do not say attachment,
  is an inline image now. A part that would not decode is an attachment that
  says "size not recorded", never "0 bytes". Inline parts and attachments are
  split by position, so a real attachment sharing a name with the inline logo
  is no longer hidden.
- A forwarded message attached to the report keeps its own text. Its body
  sits under "Text of the attached message", followed by its name, on the Body
  tab and in the report; its links say "in the body of" it, the files inside it
  say "inside" it, and the sender and originating IP in its headers reach
  Indicators and the case, noted "in the headers of" it — each time with its
  name as written. Before, its text and links were merged into the reporter's
  with no mark, and its headers never reached Indicators.
- Create case carries exactly the indicators the Indicators tab lists, from
  one collector: the links the PDF and Office readers found, the hashes of
  inline parts and of files inside archives, the addresses and domains in the
  text of an HTML-only mail, and hosts in remote templates and PDF links
  written as `file://` or UNC shares. It used to drop some of these and could
  drop a URL that differed from another only in case. Create case also takes
  its title, indicators and description from one message, and Copy report,
  Copy indicators and Create case wait while a new message is analysed.
- The sender look-alike check reads the From address as written, before
  encoded words are decoded. An encoded word could make the analyser read a
  different From domain from the one the mail carries, call it aligned with
  the Return-Path, and skip the look-alike check. `Return-Path: <>` is
  reported as a null sender, not a missing header.
- Authentication-Results names the host that asserted it, including for
  Microsoft 365 and ARC headers, and says "no asserting host stated" when
  there is none. A Received hop shows its from-clause as the receiving server
  wrote it, with the address that server recorded, where it used to show the
  sender's HELO literal as the hop's address.
- Encoded subjects and file names no longer gain spaces the mail client never
  shows, so a double extension split across encoded words is caught.
  Quoted-printable text keeps its non-ASCII letters instead of inventing a URL
  that is not in the mail (`pаypal` read as `p0ypal`). A charset that cannot be
  decoded says so instead of being read as UTF-8 without a word, and a
  multipart whose boundary never appears says so instead of "headers only".
- MIME parameters honour quoted strings, so a sender cannot hide a second
  boundary or file name inside one, and a file name split into several pieces
  is joined the way mail clients join it.
- A paste that starts with a blank line keeps its headers and attachments.
- A hash over a part rebuilt from its text — no transfer encoding, or
  quoted-printable with hard line breaks — says its size and hashes may not
  match the file as sent, on the card and in the case note. The hash line
  reads "hashes computed here".
- The HTML text pane dropped text with no attacker involved: `<head` matched
  `<header`, so a mail lost its header block and usually the lure, and an
  attribute holding `<script>` swallowed the rest of the message. Quoted
  attribute values are now skipped whole.
- The Links tab and the report head their list "Links in the message text"
  and point to Attachments whenever there are any, so a lure inside a PDF no
  longer sits under "None found." The domain beside a link is labelled
  "derived domain", with a note that it is the host's last two or three labels
  and names the platform under a hosting service such as `pages.dev`.
- The double-extension fact says only what the name shows, and not at all for
  `Invoice.pdf.pdf`. `.vbe`, `.cpl`, `.pif`, `.apk`, `.xll`, `.url`, `.iqy`,
  `.library-ms`, `.chm` and `.msc` get the same facts at the top level and
  inside a ZIP. A compound file is called "OLE compound file", not "legacy
  Office document".
- Sender-written text — header values, hop names, parser notes, the case
  title, copied indicators — is shown with control, format and direction
  characters written out as `<U+XXXX>`, on screen and in the copied report, so
  a direction override can no longer reverse the tool's own sentences. The
  report's Inline images block carries each part's facts and what was found
  inside it, as the card does.
- Parser notes sit under their own heading on the Indicators tab, not under
  "Not in this paste". A hop flagged as earlier than the one before it no
  longer collapses into a column of single letters.
- Clearing the paste box clears the previous message's tabs and counts.
- Large and hostile mails no longer freeze the analyser: link scans, the MIME
  reader, Proofpoint unwrapping and header parsing each ran for seconds to
  minutes on crafted input and are now linear.

### Fixed — settings

- Deleting a status, verdict, severity or type asks first and says how many
  cases use it. A deleted status's cases move to another status of the same
  kind — closing to closing — and the last status of a kind cannot be
  deleted; the move is logged but stamps no completion, response or
  resolution time. The board settings dialog does the same for a board's own
  statuses.
- Dragging a palette entry onto another list is ignored; it could put an empty
  entry there that stopped the plugin loading. Each entry also has up and down
  buttons.
- Clearing every SLA target or deleting every incident template is kept after
  a restart; the defaults used to come back. An SLA row with one side blank is
  refused with a hint, since it saved a 0-minute target.
- The auto-archive days field saves when you leave it: typing `400` saved 40
  and `1.5` saved 1.
- A board's type can be changed in its settings, which alert intake already
  told you to do. Renaming and moving a board at once is checked before
  either happens.
- Setting descriptions say what the settings do: the SLA clock counts
  calendar time and never pauses, not even in User Response; notifications
  cover missed targets, which are logged either way; **Save tasks on close**
  covers existing cases, since a new case is created only by its button; and
  the auto-archive, handover and Gantt settings say exactly what they change.
- The incident template editor has a border, a background and a focus ring.
- Notices, commands and the boards pane say board, not project.

### Fixed — accessibility and narrow panes

- Every icon button works with Enter and Space. The Activity log header is one
  keyboard button, and the subtask collapse toggles can be reached and
  operated by keyboard.
- Board cards, backlog rows, Gantt titles and **Open as note** can be focused
  and opened from the keyboard, and Shift+F10 or the menu key opens a board
  card's menu.
- Filter and select lists move focus into their options, arrow keys step
  through them, and focus goes back to the button on close.
- The phishing analyser's pane tabs say which one is selected and keep focus
  when chosen from the keyboard, and its disclosures show a focus ring.
- Obsidian's light theme no longer leaks into the plugin's dark surfaces,
  where it left an invisible caret, unreadable selects on hover and faint
  icons. Information text, report figures included, meets 4.5:1 contrast.
- In the right sidebar, property values, indicator values and the lifecycle
  Now and Clear buttons no longer collapse or run off-screen. Reports and the
  bulk action bar wrap in narrow panes instead of scrolling sideways.
- Controls that appear on hover show on touch screens, the table's row
  checkbox shows when it has keyboard focus, and **Remove link** in Linked
  cases appears on hover as it was meant to.

### Fixed — found by the final verification pass

- Adding a journal entry to a case from the side panel no longer silently
  fails after the board refreshes itself (after an archive, or a Sync or git
  change), and editing the description in that state no longer wipes the
  case's journal.
- Archiving or restoring a case no longer makes the open board reload every
  other case.
- Saving board settings, a saved view or a collapsed column while the board
  note has been changed elsewhere (Sync, git, a hand edit) keeps that outside
  change, such as a team member added on another device.
- Adding or renaming a subtask in its parent's editor to the name of a note
  that already exists is refused up front, instead of leaving the board unable
  to save.
- Moving tasks in from TaskNotes keeps their links to project and blocker
  notes and any time entry still running, and logged time lands on the local
  day it was worked.
- Table: a half-typed due date left by clicking away keeps the old date instead
  of erasing it.
- Board settings: saving redraws the filter bar, and a board switched to plain
  drops a verdict filter it can no longer show.
- Gantt: Day view draws bars for cases far from today again, and a hovered task
  title stays readable.
- Keyboard: the Tags, Assignees and Depends-on pickers keep focus after a pick,
  and expanding or collapsing subtasks keeps focus on the toggle.
- The description editor no longer stalls on a very long pasted line.
- Alert intake fences a quoted, called-out or indented code block exactly like
  a top-level one, so no pasted `dataviewjs` block can run in a case note.
- A hostile run of `![` in a description no longer freezes the case on open.
- A responded or resolved time earlier than the clock's start is reported as
  not computable, not as met, in the case report and in compliance.
- A value starting with `=` or `$=` in any report or handover code span shows
  its `=` as `<U+003D>`, so opening the note can never run it as a Dataview
  query or JavaScript.
- A UNC path or `domain\user` value is no longer sent to VirusTotal or URLhaus,
  and a private IPv4 written in fullwidth digits is recognised as your own.
- Read as a timestamp labels a short offset such as `GMT+2` as a stated zone and
  gives no reading for a day that does not exist (2026-02-30).
- A crafted email whose Received comment runs to many megabytes produces a
  report instead of crashing.
- Phishing analyser: Create case says why when a case cannot be created, a long
  subject never ends the title in half an emoji, the .eml picker escapes hidden
  direction characters in file names, and the Links tab points to finds inside
  inline images.

## [2.39.0] - 2026-09-24

### Fixed — a board can live anywhere in the vault

- Boards are found wherever they sit. The scan used to walk exactly one folder
  deep from the configured root, so a board filed inside another folder —
  `Incident Response/Goals/Goals.md` — simply vanished from the plugin, along
  with every case in it. It now recurses, and a board is identified by its
  `pm-project` frontmatter rather than by its depth. Nothing about the file
  format changed: move a board's folder in the file explorer and it keeps
  working, cases and all.
- The boards list shows where each board lives, and a right-click offers
  "Move to folder…" — so a board's path is visible and changeable from the
  screen that lists them, not only from inside the board.
- Every board has a Folder field in its own settings (the gear on the board
  toolbar, or Edit board in the boards list). On a new board it is where the
  board is created; on an existing one, changing it MOVES the board there —
  board note, cases, archive and attachments — in one link-aware rename, so
  wiki-links keep resolving and saved views keep pointing at it.
- The settings entry is now named "Default folder for new boards", because
  that is what it does. It never was a fence and now it does not read like one.


### Changed — the case card reads at a glance

- SLA countdowns roll into days past 24 hours. A breached case showed
  `Resolve +476h 46m`, which is nineteen and a half days and reads as
  nothing at all; it now says `+19d 20h`. Applies everywhere the duration
  is printed — cards, table, case report, handover, reports.
- The countdown is drawn with the same chip primitive as the severity badge
  beside it. It was the one hand-rolled chip left on the card: monospace, its
  own radius, its own padding, so the loudest thing on the board matched
  nothing else on it. Fixed-width digits are kept, so the row still cannot
  shuffle sideways when the clock ticks.
- Only the countdown is filled, and only while it wants something: a healthy
  clock is quiet grey, at-risk is amber, breached is red. An overdue due date
  is red text rather than a second red block competing with it.
- Severity rides the card's left edge as a three-pixel spine, so a column
  answers "how bad is any of this" before a single title is read. The word
  still renders beside the clock: a colour on its own is not a label.
- With the spine carrying it, the severity badge on a card is a coloured word
  rather than a filled box, and a card's tags are a dot and a muted word
  rather than a bordered pill each. One filled thing per card, and it is the
  countdown.
- Card tags are drawn at the size of the chips they share the row with.

## [2.38.0] - 2026-09-22

### Changed — the plugin is called Responder

Every name the analyst sees: the entry in Community plugins, the settings tab,
the prefix on every command in the palette, and every notice the plugin
raises. The description was rewritten too — it still led with "Jira-style" and
issue keys, which stopped being the point several releases ago; it now names
what the thing actually does, phishing analyser included.

**The plugin id and folder stay `casefile`, deliberately.** Obsidian keys your
settings, your assigned hotkeys and the plugin folder on the id, so changing
it orphans all three — and `responder` is already taken by a separate, parked
plugin in this vault. The id is invisible in normal use; nothing on screen
says Casefile any more.

## [2.37.0] - 2026-09-22

### Added — parity with PhishTool's parsed model

Read from PhishTool's own public API schema, field by field, and closed the
gaps that were worth closing.

- **MD5 beside SHA-256 and SHA-1.** WebCrypto does not implement it, so it is
  hand-written from RFC 1321 and checked against that document's own test
  vectors plus the padding boundaries at 55, 56 and 64 bytes — a hash that is
  subtly wrong is worse than none, because it looks like an answer. Verified
  again end to end: the digest the plugin computes for an attachment is
  byte-identical to what the system `md5` reports for the same extracted file.
  It is not a security claim; it is the key a lot of the lookup world still
  uses.
- **Sender, Cc, In-Reply-To and References** join the identity list. Nothing
  read the thread headers before.
- **A stated thread claim.** When a message names a parent, the analysis says
  so — and says plainly that nothing in the headers tells a genuine reply apart
  from a thread someone else joined, and that checking whether the conversation
  is yours is the analyst's job. It does not guess.
- **The hop id and the envelope recipient** now show on each Received hop: the
  id is what a mail admin searches their own logs by, and the `for` clause is
  often the only place an alias appears.
- **The registrable domain beside the host** on every link — `login.paypa1.co.uk`
  states `paypa1.co.uk` — because that is what a block list is written against
  and what two links have in common when they share an owner.
- **Inline images are listed apart from attachments**, as PhishTool separates
  them. A signature logo among four files made the mail read as heavier than it
  was; the tab now counts them separately, as `Attachments (2+1)`.

### Still deliberately absent

QR codes, sandbox submission and per-artifact verdict labels. The first needs a
decoder under the zero-dependency rule; the second needs the network; the third
is a verdict this tool has no business reaching.

## [2.36.0] - 2026-09-22

### Added — read the mail the way the victim read it

A third section in the Body tab: **Text extracted from the HTML — not
rendered**. Most phishing is HTML-only, and on those mails that tab printed
"Not recorded." for plain text and then several kilobytes of markup. Real
phishing HTML opens with a stylesheet and table scaffolding, so at a
4,000-character preview the lure's first sentence was frequently not on screen
at all — the only way to read it was to create the case first and open the
note, which is deciding after filing.

It is not a render and not a parse. Nothing reaches a DOM, nothing is fetched,
no stylesheet applies and no script exists — the same inert string treatment
every other part of this module gives hostile markup, just made legible.

Three things it has to get right, none of which the existing tag-strip did:

- **Strip, then decode.** `extractLinks` decodes entities FIRST so an href
  written in `&#x2F;` is still found. This does the opposite, because
  `&lt;click here&gt;` is text the victim SAW — decoding before the strip turns
  it into a tag and deletes it.
- **Drop `<script>` and `<style>` contents**, not just their tags, or the
  readable pane opens with the stylesheet and the lure is buried again. Done by
  scanning with `indexOf` rather than a lazy regex, which stays linear on a
  multi-megabyte body full of unterminated opens.
- **Remove comments in their own pass.** `<[^>]*>` closes early on a comment
  containing `>`, and Outlook writes `<!--[if mso]>…<![endif]-->` on nearly
  every message it sends, so that is the common case.

Source newlines and indentation collapse the way a renderer collapses them;
only block boundaries become line breaks. The extracted text is carried into
the copied report and the case too, so the screen, the clipboard and the note
say the same thing.

It says **nothing** about whether any of that text was styled invisible.
Preheader text is legitimate and on nearly every marketing-shaped mail, so a
hidden-text flag would fire constantly — and it would be a verdict wearing a
fact's clothes, which is the thing this analyser refuses to do.

## [2.35.1] - 2026-09-22

### Changed

- **The analyser's marked lines are yellow, and coloured again.** 2.34.1 had
  taken the colour off the text and left it only on the rule; the lines are
  yellow text with a yellow rule now. The rule stays because it is what stops a
  run of them reading as one block — it gives each line a left edge — while the
  colour is what makes them findable at a glance, which is the point of marking
  them. A matched observation keeps its green rule with muted text, so the two
  outcomes still read apart.

## [2.35.0] - 2026-09-21

### Fixed — an audit of everything built this session

Six auditors read the 14 commits and three skeptics judged every finding.
Thirty-three held up. The ones that mattered:

- **Auto-archive had lost the guard that says a case must have been finished.**
  Moving the clock onto the activity log made the log answer two questions at
  once — when it landed, and whether it was ever really closed — and that
  quietly dropped the "no completion date, never archive" rule. A case dragged
  to Done with its date cleared became archivable on a timer that renames its
  file without asking. The date is checked first again. **This one was live.**
- **A case title could break out of the wiki-link the board index writes it
  into.** A title is the subject line of a pasted alert, so it is
  sender-controlled: `Invoice ]] ![[private]] <img src=…>` closed the link and
  the rest rendered as markdown — an embed and a beacon that fires when the
  note is opened. Brackets are now neutralised in the alias at all four sites,
  in the serializer, where every title path goes through.
- **The Google-redirect gateway matched `google.<anything>`**, so a link to
  `google.evil.com/url?q=…` was reported as unwrapping to whatever the attacker
  put in the parameter — the attacker chose the destination the report named.
- **Unwrapping percent-decoded a target the gateway had already decoded**, so
  the reported host could differ from the host the gateway actually redirects
  to. Only the two Proofpoint shapes decode now.
- **Dropping decoy anchor text was deleting real destinations.** A URL a mail
  tells you to type is clickable in a plain-text client; when the same string
  was also an anchor label it vanished from the links, the indicators and the
  case. A label is dropped only when nothing else found it.
- **The screen said the copied report carried the rest of a long body. It
  carried none of it** — no body section existed. The body is now carried,
  fenced, so a case records the mail and not just the analysis of it.
- The copied report had **two different "Indicators" sections** and the first
  was the raw-paste scan the module's own docs call the wrong source.
- The sender's domain was parsed by hand instead of through the hardened
  reader, so the RFC 5322 comment evasion closed in 2.32.0 was still open for
  the look-alike check.
- One un-archivable case **silently stopped the sweep** for every case after
  it. Each case is guarded now and failures are reported.
- **Create case failed silently** when two mails shared a subject.
- Hashes over a part that carried no transfer encoding **say so**: they are of
  the decoded text, not of the bytes as sent, and will not match the sender's
  copy.
- `defang`/`refang` corrupted any value containing `$&` or `$1`, because
  `String.replace` expands those inside the replacement.
- The wide-row label rule **never applied** — it lost on CSS specificity, so a
  three-line tag block left its label floating in the middle of the chips.
- The analyser's tab strip scrolled away with the pane it switches, and a
  pending parse could fire after the modal closed.
- **manifest.json and package.json were still 2.30.0** while the changelog and
  versions.json had gone to 2.34.1.

### Added

- Tests that can actually fail: an attachment digest pinned to a value computed
  outside this codebase rather than to a 64-hex shape, the undecodable-part
  case asserting the empty-file hash is never printed, and an unwrap-bound test
  whose old form passed whether or not any bound existed.

## [2.34.1] - 2026-09-21

### Changed (the analyser stops shouting)

- **Section headings speak the plugin's own language** — small, uppercase,
  muted, exactly like DESCRIPTION and INDICATORS in the case editor. They were
  bright indigo with a rule under each, which made five headings compete with
  the content they exist to organise, and made this one screen look like a
  different application.
- **An observation is marked, not painted.** Three lines of solid amber is a
  wall nobody reads, and it made every observation look equally urgent. The
  sentence is now normal ink with a thin rule beside it — amber where the
  comparison differs, green where it matches — so the eye catches the marker
  and reads the line calmly.
- Flags get the same treatment: muted text, amber rule.
- `pass` and `fail` keep their colour. On a single stated word the hue IS the
  information; on a whole sentence it is not.
- The active tab reads as selected without competing, and the monospace detail
  behind an authentication result sits back a shade so the result word leads.

## [2.34.0] - 2026-09-21

### Added — tabs, and an attachment pane that shows you the file

The analyser is five panes now — **Message · Links · Attachments · Body ·
Indicators** — with counts on the tabs. A phishing analysis is five different
questions, and answering them in one scroll means the first gets read and the
rest get scrolled past.

**Attachments** gives each file a card: name, declared type, size, both hashes
computed here, what the bytes say it is, every stated fact, the indicators
found inside it — and a preview.

The preview rule is the part worth knowing, because "nothing is rendered" is
this screen's promise and an image on it looks like an exception:

- **A raster image is drawn — but only when its own BYTES say it is one.** Not
  when the filename says so, not when the Content-Type says so; both are
  written by the sender. It is drawn from a `data:` URL built out of the bytes
  already in the message, so there is nothing in it to fetch and nothing to
  run, and the card says so underneath.
- **SVG and HTML are read as source, never drawn.** An SVG is a picture to a
  person and a script container to a browser. A tracking pixel inside one is
  reported as an indicator instead of being requested.
- **Everything else falls back to its header bytes** — offset, hex, ASCII —
  which is where the answer usually is when nothing else can be said honestly.

So a PE named `receipt.png` and declared `image/png` is not drawn: it is
flagged *named .png but the bytes begin as Windows executable (MZ)*, its C2 URL
is listed as found inside the file, and its first bytes are laid out to read.

## [2.33.1] - 2026-09-21

### Removed

- **The classification tick boxes are gone from the analyser.** Twenty-three
  chips over five rows sat between the paste box and the buttons and pushed the
  analysis — the part you actually read — off the bottom of the modal. The
  analysis now gets the whole pane: identities, authentication, path,
  observations and the sender domain are all visible without scrolling.
- The setting, the shipped taxonomy and the stored list went with it. Every one
  of them existed only to feed those chips, and a setting with no consumer is
  worse than no setting. A case still takes any tag you type.

## [2.33.0] - 2026-09-21

### Changed (the analyser is readable at a glance now)

Colour was added where it renders **what the headers state**, and nowhere
else. The analyser still has no score, no verdict and no opinion about whether
a message is malicious — a test still asserts that no such word appears in its
output.

- Section headings carry the accent and a rule, so the panes separate.
- An authentication result is coloured as the word the header states: `pass`
  green, `fail`/`softfail`/`permerror`/`reject` amber, anything else neutral.
  An SPF fail really is a fail; showing it in the colour of one is a faithful
  reading, not a judgement on the mail.
- An observation is coloured from **its own outcome**, carried as data rather
  than grepped out of its wording — a view that reads its own prose for the
  word "differ" breaks the first time the sentence is reworded.
- Every flag is amber with a left rule. `hostFacts` and `attachmentFacts` emit
  nothing at all when a host or a file is unremarkable, so the class marks
  "read this line", never "this mail is bad".
- URLs and hashes are cyan monospace, so an indicator is distinguishable from
  the sentence describing it.
- **"not recorded" is faint italic**: an absence is not a value and should not
  read like one.
- The analysis pane gets more of the modal and the paste box less, because the
  analysis is what gets read and the paste box is a doorway.

## [2.32.2] - 2026-09-21

### Changed

- **The phishing analyser is on the board toolbar and the ribbon**, not just in
  the command palette. It sits next to the paste door because both are intake:
  one takes the alert a tool raised, the other the mail a user reported. The
  ribbon entry is there because the analyser is vault-wide and you may have no
  board open when a report lands.

## [2.32.1] - 2026-09-21

### Changed (the property grid lines up now)

- **Labels are centred in their row instead of nudged down by a fixed
  padding.** The old `padding-top: 6px` only lined up against a control of one
  particular height, so the slider, a chip and a date button each sat off their
  label by a different amount and no two rows agreed.
- **An inline control's text starts flush with its column.** The negative
  margin cancelled only half the border and padding, leaving every dropdown
  4px right of the chips and sliders beside it — small enough to look like
  nothing, big enough to make the grid read as crooked.
- One row height throughout, both halves on the same label width, and
  `minmax(0, …)` tracks so one long tag list can no longer widen its own column
  and knock the other half out of line. A full-width row (tags, links) tops its
  label against the block it labels, since that block wraps.
- The progress slider is capped rather than filling its half, so the reading
  beside it no longer sits hard against the next column's label.

## [2.32.0] - 2026-09-21

### Fixed — the phishing analyser, after an adversarial review of it

Six reviewers attacked the analyser from different angles and three
independent skeptics judged every finding. Forty-eight held up. These are the
ones that mattered; each has a test built from the exact mail that defeated
the old code.

**Content that was hidden from the analyst.** A `Content-Disposition: inline`
with a `filename` moved the whole HTML body out of the body — the client still
rendered it, while the analysis reported no links at all. RFC 2231
`filename*=` now wins over the plain `filename`, because it is the name the
victim's client saves: `invoice.pdf"; filename*=UTF-8''invoice.pdf.exe` used
to print `invoice.pdf` and, since every attachment check keys off the name,
silently dropped "executable" and "double extension" with it. A forwarded
`message/rfc822` is now opened and walked — forward-as-attachment is how most
reported phish reaches a SOC, and the payload inside it was never hashed,
never flagged and never an indicator.

**A fabricated fact.** `atob` is strict; mail clients are not. One stray byte
in a base64 attachment made the part decode to nothing, and the empty file's
SHA-256 was printed under "computed here, from the bytes in the file" — a
digest that reads as a clean result in any sandbox for a payload nobody had
looked at. Stray bytes are now ignored as RFC 2045 says, and a part that
genuinely cannot be read records its size, hashes and type as **not recorded**.

**Misleading attribution.** An address parked in an RFC 5322 comment —
`From: (<helpdesk@paypal.test>) security@paypa1.test` — beat the real mailbox,
so the pane reported From/Return-Path alignment on a mail that had none.
`Authentication-Results` is now attributed to the host that asserted it, since
a sender can write that header themselves and it parsed identically to the
receiving MTA's; ARC results are marked as relayed claims. A pass is reported
**with the domain it passed for**, so SPF and DKIM passing for a bulk relay no
longer reads as authenticating the name in the From line. Duplicate From,
Return-Path, Reply-To, Subject and Authentication-Results headers are called
out rather than silently collapsed to the first.

**Links that pointed somewhere else.** Gateway unwrapping matched the gateway
name anywhere in the URL, so `evil.test/?x=safelinks.protection.outlook.com&url=…`
was reported as unwrapping to a brand domain. It now matches on the host.
Unquoted attributes, HTML character references beyond `&amp;`, `action`,
`srcset`, CSS `url()` and non-http schemes were all dropped — a mail whose
only link was `data:` or an entity-encoded href reported "None found." Look-alike
folding ran on the parsed host, which `new URL()` had already punycoded, so it
could never match a Unicode homoglyph; it now folds the authority as written.
`brandLabel` understands two-part suffixes, so a look-alike under `.co.uk` is
compared against the right label.

**Safety.** Every sender-controlled value in the report is quarantined in
inline code before it reaches a note Obsidian renders — a subject of
`<img src="http://beacon.test/x.gif">` fired a request when the case was
opened, which is precisely what this feature exists to prevent, and
`![[note]]` embedded another note into the case. Decoded RFC 2047 words can no
longer carry newlines, which had let a Subject forge whole report sections and
timestamped comments.

**Robustness.** The anchor matcher was quadratic — twenty thousand unclosed
anchors froze the UI thread; every scan is now bounded. The modal debounces
and drops stale runs, so a slow parse cannot paint over a newer one. Notes are
de-duplicated and links capped, with the remainder **counted, not hidden**.

### Added

- **What a file actually is**, from its first bytes, and a stated fact when
  that disagrees with its name or its declared type: *declared application/pdf
  but the bytes begin as Windows executable (MZ)*.
- **Indicators found inside an attachment's bytes**, listed separately from
  the message's own — where an indicator was found is half of what it means.
- **The sender's domain** gets the same look-alike folding the links get.
  A brand entry may now be a domain (`paypal.test`) as well as a name, which
  is what lets the tool tell the real site from the same name on another TLD.
- Indicators are built once from the **parsed** message and shared by the
  panel, the copy button and the case, so the three cannot disagree. They used
  to be scanned out of the raw paste, which meant base64 noise and a phishing
  URL cut in half by a quoted-printable soft line break.

## [2.31.1] - 2026-09-21

### Added

- **PhishTool's classification taxonomy**, offered as tick boxes when the
  analyser opens a case, each tick written as an ordinary tag. The ids are
  PhishTool's own codes, read from its public API schema, so a case closed here
  counts the same way as one closed there; the labels are this plugin's
  expansion of those codes and not PhishTool's wording, which the settings copy
  says out loud. Editable in **Settings → Phishing analyser**.
- **SHA-1 alongside SHA-256** on every attachment, both computed here from the
  bytes. MD5 is deliberately absent: WebCrypto does not implement it, and
  hand-rolling a broken hash to save one paste is not a trade worth making.

## [2.31.0] - 2026-09-21

### Added — a phishing analyser, built in

`Analyse a phishing email` takes a pasted header block, a whole pasted
message, or a `.eml` already in the vault, and reads it offline. It replaces
and subsumes the header reader added in 2.30.0 (the command keeps its id, so
any hotkey you set still works).

- **The message, taken apart.** Nested multiparts, quoted-printable and base64
  bodies, RFC 2047 filenames and subjects, attachments decoded to their true
  size. The MIME boundary is matched as a whole delimiter line, as RFC 2046
  requires, and not as a substring — a crafted inner boundary that merely
  *starts* with the outer one would otherwise swallow the split and hide an
  attachment from the one tool whose job is to show you everything in the file.
- **Links, unwrapped.** Microsoft Safe Links, Proofpoint URL Defense v2 and
  v3, Barracuda LinkProtect and Google redirects are unwrapped back to the
  address the sender wrote, bounded so a link wrapped ten times cannot spin.
  Mimecast is named as the wrapper rather than pretended to be unwrapped,
  because its target is an opaque id. Anchor text that is itself a URL is
  compared against where the link really goes.
- **Look-alike hosts**, folded across digit and Cyrillic confusables, so
  `paypa1.test` and `раypal.test` both read as `paypal`; also one-character
  differences, punycode hosts, and links to a bare IP. All of it against
  **your** brand list in **Settings → Phishing analyser**, which ships empty on
  purpose: which brands matter is your call, not the plugin's.
- **Attachments** get a SHA-256 computed here from the bytes, never a hash
  quoted from a tool, and the type facts an analyst reads first — macro-capable,
  executable, archive, double extension, right-to-left override in the name.
- **Nothing is rendered.** The HTML body is shown as source. No remote image is
  fetched, no link is resolved, no link on screen is clickable, and every link
  in the copied report is defanged. Opening a phishing mail to analyse it must
  not be what tells the sender you opened it.
- **Create case** opens a case carrying the report verbatim, with the links,
  addresses and attachment hashes already typed as indicators. Severity and
  verdict are left unset deliberately: this screen has no opinion, and a case
  born with a verdict is a case nobody judged.

Not a verdict engine, and not by accident: there is no score and no word like
"suspicious" anywhere in its output, and a test asserts that.

## [2.30.0] - 2026-09-21

### Added (two things the editor could not do before)

- **Analyst toolbox on the selection** — right-click, or the command palette.
  Defang and refang indicators, decode base64, percent-escapes or hex, read a
  number as a timestamp, and hash the selection. It offers only the transforms
  that actually APPLY to what you selected, each showing the result before you
  pick it, so it never hands back rubbish from a decode that was never going to
  work. base64 is tried as UTF-8 **and UTF-16LE**, because PowerShell's own
  `-EncodedCommand` is UTF-16LE and a UTF-8-only decoder returns every other
  character as a NUL on the commonest thing you will paste into it. A number
  gets every reading it could plausibly be — Unix seconds, milliseconds,
  microseconds, Windows FILETIME, the WebKit epoch — each labelled with the
  epoch it assumes, and readings landing outside 1990–2100 are dropped rather
  than listed. The result is INSERTED below the selection in a `Derived`
  callout, never substituted for it: the note keeps the thing that was decoded
  next to what it decoded to. Decoded text is fenced and quoted line by line,
  so content that is itself markdown cannot break out and rewrite the note.
  Entirely offline — the toolbox never asks anything about a value, it only
  rewrites what you already have.
- **Analyse email headers** — paste a header block and read what it says.
  Received chain reversed so hop 1 is the origin, with the delay at each hop;
  SPF, DKIM and DMARC exactly as the headers state them; From, Return-Path and
  Reply-To compared; RFC 2047 encoded subjects decoded; and every indicator
  extracted, defanged and marked when it is one of your own assets, ready to
  copy into a case. It reports and never concludes: there is no score, no
  colour-coded verdict and no word like "suspicious" anywhere in the output.
  A header the paste does not contain is listed under "Not in this paste",
  because a missing SPF result is not an SPF pass. It reads the display name
  separately from the real address — `"PayPal Security <service@paypal.test>"
  <billing@paypa1.test>` is a live trick, and the address a mail client shows
  you is the decoration.

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

### Fixed (the launch pass was walking an empty vault)

- **The notification and auto-archive pass that runs at launch did nothing at
  all.** It was started from `onload()`, before Obsidian had finished indexing
  the vault, so the project walk came back with zero boards and both passes
  returned having found nothing to do. It now waits for layout. This is why
  auto-archive appeared not to work even with a window set: the launch sweep
  was dead and the only live passes were the five-minute ticks. Due-date and
  SLA-breach notices were missing their launch pass for the same reason.
- **A failure in the notification pass no longer takes the archive sweep down
  with it.** They ran in one chain, so a throw in the first skipped the second
  silently. They are independent now, and a failure is logged rather than
  swallowed.

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
