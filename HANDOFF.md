# Handoff — Git Graph Explorer

*Paste this as the first message of a fresh chat to pick the work up.
`CLAUDE.md` is the short version that Claude Code loads automatically.*

---

You are continuing work on **Git Graph Explorer**, a browser app that explores a
local git repository's commit graph, in the style of the GitLens VS Code
sidebar. Working directory:

```
/Users/msalinas/Library/CloudStorage/Dropbox-CMCC/Mario Salinas/myData/code/_utils/git_graph_explorer
```

**Read `README.md` there first** — it is thorough and current (usage, the
folder picker, the file tree, HTTP API, the lane algorithm, the git traps,
security, limitations). This file covers only what the README deliberately
leaves out: why things are the way they are, and what is left to do.

## Goal

Explore a local repo's commit graph in the browser: pick a folder, see an
explorable graph, see each commit's changed files and their diffs, search by
commit id or message text, and switch branches. HTML + CSS + JS with no external
dependencies, working fully offline. The visual target was a GitLens
screenshot (`example.png`, no longer in the folder).

## Current state — feature-complete and verified

Nothing is known broken. Everything the user asked for is built and tested:

- graph with lanes, merge curves, ref badges, `HEAD` ring
- click a commit → its changed files expand inline (GitLens-style)
- **collapsible file tree** when those files span more than one folder
  (added 2026-10-25, commit `c2a3682`)
- click a file → unified diff with line numbers in the right pane
- search over commit id / subject / body / author / ref name, with match
  counter, next/prev cycling, dim-vs-filter modes
- branch & tag picker (draws only — never checks out)
- **Browse…** button opening the operating system's own folder dialog
- virtualised list, draggable splitter, keyboard nav, recents in `localStorage`

| file | lines | |
|---|---|---|
| `server.py` | 594 | stdlib-only HTTP server, git plumbing, folder dialog |
| `app.js` | 1003 | lane layout, virtual list, file tree, search, diff rendering |
| `app.css` | 407 | dark theme; row/lane geometry in `:root` |
| `index.html` | 60 | the page |
| `README.md` | 258 | full documentation |
| `CLAUDE.md` | 104 | condensed brief for Claude Code sessions |
| `environment.yml` | 27 | optional conda env |

Run it with `python3 server.py` → <http://127.0.0.1:8787>.

## Key decisions — settled, please don't reopen without reason

- **There is a Python server, by design.** A `file://` page cannot run `git` or
  read a folder the user picks. A pure-JS `.git` reader was considered and
  rejected: repos keep objects in packfiles, so it would have needed an idx-v2
  parser, `OFS_DELTA`/`REF_DELTA` resolution and a JS diff implementation. The
  user was asked and chose the server. It is stdlib-only, so "no external
  dependencies" still holds.
- **No dependencies to pin.** `server.py` imports only stdlib; the front end
  imports nothing. There is deliberately no `requirements.txt` because it would
  be empty. `environment.yml` exists only to pin the interpreter and git for
  conda users. Floor is **Python 3.7** (`ThreadingHTTPServer`), verified on
  3.7.3, 3.8.2 and 3.9.6.
- **Graph shows all refs by default** (`git log --all`); the user chose this over
  current-branch-only.
- **The branch picker only changes what is drawn.** It never runs `git
  checkout`. Every git command in the server is read-only. Verified that `HEAD`
  and `git status` are unchanged after cycling every branch. Don't add checkout
  without asking — it would turn a read-only explorer into something that
  mutates the user's tree.
- **Search dims non-matching rows by default** rather than filtering, so graph
  topology stays readable; `hide non-matching` switches to filtering.
- **Merge commits are diffed against their first parent**, like `git show`, and
  the UI labels it *vs first parent*.
- **File tree** (all chosen by the user):
  - shown only when files span >1 folder, otherwise the flat list;
  - single-child folder chains compacted (`src/core/io`);
  - folders first, then files, case-insensitive A–Z; the auto-opened diff is
    the first file in that order;
  - folders start expanded, and collapsed folders are remembered by path in
    `state.collapsed` for the session (in memory, not `localStorage`);
  - folder rows show summed `+/−` (binary files excluded);
  - an `expand all · collapse all` header row sits at the top of the tree.
  It is pure front end (`buildTree`, `flatNodes`, `setFiles`,
  `setAllCollapsed` in `app.js`); `server.py` was not touched.

## The folder picker — the subtle bit

`/api/pick` exists because a browser physically cannot hand over an absolute
path: `webkitdirectory` and `showDirectoryPicker()` expose only the folder's
name. The server opens the real dialog instead and reports the path back.

The non-obvious part, which took a round of debugging: on this machine
`osascript`'s `choose folder` sometimes returns AppleScript error **-128
instantly** — the very same code a genuine user cancel produces. The first
implementation therefore reported a cancel the user never made and never fell
through to the working `tkinter` dialog. The fix is `MIN_DIALOG_SECONDS = 0.4`
in `server.py`: a "cancel" faster than that means the tool could not display,
so the next picker in the chain is tried. Don't remove it.

Also note macOS spells it "User cancel**led**", not "canceled" — the matcher
accepts both plus the `-128` code.

Empirically: the native Finder dialog *does* work when spawned by the server
process, but fails instantly when `osascript` is run straight from a
non-interactive tool shell. So testing the picker from a script is misleading;
click the button in a browser to judge it.

## The one bug found and fixed — do not regress it

The original plan used `git diff-tree -m --first-parent` for a commit's file
list. That looks correct but emits the diff against **every** parent
concatenated: merges listed files they never touched and their line counts
doubled (a test merge showed 3 files instead of 1). It is now the explicit
two-tree form `<sha>^1 <sha>`, with `--root` for root commits, which have no
`^1`. See `diff_cmd()` in `server.py`, which carries this explanation inline.

The README's **"Traps worth knowing"** section lists the other git-plumbing
gotchas (why `--root` is mandatory, `R`/`C` renames emitting two paths under
`-z`, NUL-separated log records, the `---` inside-a-hunk ambiguity, the tab
separator for `for-each-ref`). Read it before touching the parsing.

Two virtual-list rules:

- `ROW_H` / `FILE_H` / `LANE_W` / `LANE_PAD` at the top of `app.js` must stay
  in sync with the matching custom properties in `app.css`. The virtual list
  computes offsets from the JS copies while the browser lays out from the CSS
  ones, so changing one alone breaks scrolling in a way that looks like a
  rendering bug.
- `expandH()` counts `state.nodes` (visible tree rows), not `state.files`. Any
  change to what is visible must rebuild `state.nodes` (`flatNodes()`) before
  `render()`; `setFiles()` does it for a new commit.

## Repo state

- Branch **`master`**, no remote. App, `README.md`, `HANDOFF.md`, `CLAUDE.md`
  are all tracked; working tree clean after each step.
- `.gitignore` ignores `*.md`, `*.png`, `*.csv`, `.DS_Store`, with negations
  `!README.md`, `!HANDOFF.md`, `!CLAUDE.md`. Any new doc needs its own
  negation line.
- `visir-brain/` (the old test-data repo) is no longer in the folder.

## Next steps

Nothing is required — the app works. Open choices, roughly in order of value:

1. **Branch-stable lane colours.** Colours currently follow lane *position*, so
   a trunk can change colour where branches converge. Lines stay continuous and
   correct, so this is purely cosmetic, but it is the most visible gap versus
   GitLens. Would mean tracking a colour per branch head through `layout()`
   instead of `LANE_COLORS[lane % 8]`.
2. Features deliberately not built, none requested: list/tree toggle, keyboard
   navigation inside the file list, working-tree/staged view, whole-commit
   combined patch, side-by-side diff, blame, server-side search across unloaded
   commits (search covers loaded commits only — history pages in at 2000 at a
   time).

## How this was tested — worth recreating before a risky change

None of these test files live in the project (the user asked for a minimal
app); recreate them in the session scratchpad.

- **Claude-in-Chrome** (connected in the 2026-10-25 session): start
  `python3 server.py --port 8799 --no-browser`, open the page, call
  `openRepo(path)` and drive real clicks with
  `el.dispatchEvent(new MouseEvent('click', {bubbles:true}))` from
  `javascript_tool`; read `state` and DOM to assert. Gotchas: wait for
  `.row` elements, not just `state.commits`, before clicking; clicking an
  already-selected commit *deselects* it; after a reload the page auto-opens
  the last recent repo, which races a scripted `openRepo()`.
- **Headless fallback:** `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  --headless=new --disable-gpu --user-data-dir=<tmp> --virtual-time-budget=5000
  --screenshot=<out.png> <url>`; often does not exit — wrap in `timeout 30` and
  `pkill`. For interaction, add `--remote-debugging-port=9222` and drive CDP
  from node's built-in `WebSocket` (`Runtime.evaluate`,
  `Runtime.exceptionThrown`). **Poll for state** rather than sleeping.
- **Lane algorithm:** `eval()` `layout()` out of `app.js` in node and assert
  **continuity** on real `/api/log` output: lanes leaving a row's bottom
  (`through` ∪ `down`) equal lanes entering the next row's top (`through` ∪
  `up`). A tempting but *wrong* invariant is that a parent's `up` contains each
  child's own lane.
- **File tree:** extract `byName`, `dirNode`, `buildTree`, `flatNodes`,
  `setFiles`, `setAllCollapsed` from `app.js` by brace matching, `eval` them in
  node with a stub `state`/`render`, and assert: single folder → `tree === null`;
  compaction; folders-first sort; summed counts skip binaries; collapsing hides
  descendants; collapse-all leaves header + top-level folders + root files.
- **Geometry after toggling:** with a tree commit that has rows below it, the
  `.files` block's bottom (`top + offsetHeight`) must equal the next `.row`'s
  `top` after every toggle, and `el.spacer` height must equal `totalH()`.
- **Ground truth:** scratch repo with two merges, two side branches, a rename and
  a binary file; compare every commit's file list against
  `git show --numstat --format= --first-parent -M <sha>`. This caught the merge
  bug.

## Verified results, for comparison after changes

- **Tree** (scratch repo: commit 1 adds `src/core/io/{r,w}.py`, `docs/x.md`,
  `README`; commit 2 moves `docs/x.md` → `src/core/x.md` and edits `r.py`;
  commit 3 edits both `io` files):
  - commit 1 → header, `docs/` > `x.md`, `src/core/io/` (+2) > `r.py`, `w.py`,
    then `README`; auto-opened diff `docs/x.md`;
  - commit 2 → `src/core/` > `io/` > `r.py`, then `x.md ← docs/x.md` (R);
  - commit 3 → flat list, `tree === null`;
  - a collapsed `docs` stayed in `state.collapsed` across commits; geometry
    lined up after every toggle (block bottom 174 → 150 → 102 → 174 = next row
    top); console clean.
- Earlier, on `visir-brain` (no longer present): 44 commits across all refs;
  commit `6b6f0c7` → 2 files; searching `docs` → 16 matches.
- Error paths: `/tmp` → "is not a git repository."; a missing folder → "is not a
  folder."; relative paths resolve against the server's cwd.
- Picker: error → banner, loaded repo kept; `{"cancelled":true}` → nothing
  changes; a returned path switches repositories completely. The lock rejects a
  second click with "A folder dialog is already open."
- Security: `Host`-header rebinding guard, static-file whitelist (traversal →
  404), and option-injection rejection (`sha`/`ref` like `--output=/tmp/pwned`)
  all hold.
