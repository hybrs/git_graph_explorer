# Handoff — Git Graph Explorer

*Paste this as the first message of a fresh chat to pick the work up.*

---

You are continuing work on **Git Graph Explorer**, a browser app that explores a
local git repository's commit graph, in the style of the GitLens VS Code
sidebar. Working directory:

```
/Users/msalinas/CMCC Dropbox/Mario Salinas/myData/code/_utils/git_graph_explorer
```

**Read `README.md` there first** — it is thorough and current (200 lines:
usage, HTTP API, the lane algorithm, the git traps, security, limitations).
This file covers only what the README deliberately leaves out: why things are
the way they are, and what is left to do.

## Goal

Explore a local repo's commit graph in the browser: pick a folder, see an
explorable graph, see each commit's changed files and their diffs, search by
commit id or message text, and switch branches. HTML + CSS + JS with no external
dependencies, working fully offline. `example.png` in the folder is the GitLens
screenshot that set the visual target.

## Current state — feature-complete and verified

Nothing is known broken. Everything the user asked for is built and tested:

- graph with lanes, merge curves, ref badges, `HEAD` ring
- click a commit → its changed files expand inline (GitLens-style)
- click a file → unified diff with line numbers in the right pane
- search over commit id / subject / body / author / ref name, with match
  counter, next/prev cycling, dim-vs-filter modes
- branch & tag picker (draws only — never checks out)
- virtualised list, draggable splitter, keyboard nav, recents in `localStorage`

| file | lines | |
|---|---|---|
| `server.py` | 449 | stdlib-only HTTP server, all git plumbing |
| `app.js` | 859 | lane layout, virtual list, search, diff rendering |
| `app.css` | 399 | dark theme; row/lane geometry in `:root` |
| `index.html` | 59 | the page |
| `README.md` | 200 | full documentation |
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

Also: `ROW_H` / `FILE_H` / `LANE_W` / `LANE_PAD` at the top of `app.js` must stay
in sync with the matching custom properties in `app.css`. The virtual list
computes offsets from the JS copies while the browser lays out from the CSS
ones, so changing one alone breaks scrolling in a way that looks like a
rendering bug.

## Repo state — needs attention

- The folder is a git repo on branch **`master`** with one commit,
  `8bc5092 " first commit"`, containing only `.gitignore`.
- The app files (`server.py`, `app.js`, `app.css`, `index.html`,
  `environment.yml`) are **staged but not committed**. The user staged them
  themselves; no commit has been made on their behalf.
- **`.gitignore` contains `*.md` and `*.png`**, so `README.md`, this
  `HANDOFF.md` and `example.png` are all currently ignored and will not be
  committed. This was left as-is rather than edited unilaterally. If the user
  wants the docs tracked, the fix is to append negations:

  ```gitignore
  !README.md
  !HANDOFF.md
  !example.png
  ```
- `visir-brain/` is an unrelated repo used only as test data. It shows as
  untracked; it should not be committed (or should become a submodule if it
  really belongs here).
- No remote is configured.

## Next steps

Nothing is required — the app works. These are the open choices, roughly in
order of value:

1. **Decide the `.gitignore` / commit question above**, then commit the app.
2. **Branch-stable lane colours.** Colours currently follow lane *position*, so
   a trunk can change colour where branches converge. Lines stay continuous and
   correct, so this is purely cosmetic, but it is the most visible gap versus
   GitLens. Would mean tracking a colour per branch head through `layout()`
   instead of `LANE_COLORS[lane % 8]`.
3. Features deliberately not built, none requested: working-tree/staged view,
   whole-commit combined patch, side-by-side diff, blame, server-side search
   across unloaded commits (search currently covers loaded commits only —
   history pages in at 2000 at a time).

## How this was tested — worth recreating before a risky change

The Claude-in-Chrome extension was **not connected** in the original session.
What worked instead, with no dependencies:

- **Headless screenshots:** `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  --headless=new --disable-gpu --user-data-dir=<tmp> --virtual-time-budget=5000
  --screenshot=<out.png> <url>`. Note it produces correct output but often does
  not exit — wrap it in `timeout 30` and `pkill` afterwards.
- **Real interaction:** launch that Chrome with `--remote-debugging-port=9222`,
  then drive it from a small node script using node's **built-in** `WebSocket`
  against the CDP endpoint from `http://127.0.0.1:9222/json/list`
  (`Runtime.evaluate` to poke `state`, call `runSearch()`, `select()`,
  `showDiff()`; `Runtime.exceptionThrown` to catch console errors;
  `Page.captureScreenshot`). **Poll for state** (`state.commits.length > 0`)
  rather than sleeping — fixed sleeps produced false failures.
- **Lane algorithm:** `eval()` the `layout()` function straight out of `app.js`
  in node and assert invariants on real `/api/log` output. The load-bearing one
  is **continuity**: the lanes leaving a row's bottom (`through` ∪ `down`) must
  equal the lanes entering the next row's top (`through` ∪ `up`). Careful — a
  tempting but *wrong* invariant is that a parent's `up` contains each child's
  own lane; `up` lists lanes entering the row, which is not the same thing.
- **Ground truth:** build a scratch repo with two merges, two side branches, a
  rename and a binary file, then compare every commit's file list against
  `git show --numstat --format= --first-parent -M <sha>`. This is what caught
  the merge bug.

All of the above lived in the session scratchpad and is gone; recreate as
needed. These test files were never added to the project, since the user asked
for a minimal app.

## Verified results, for comparison after changes

- `visir-brain`: 44 commits across all refs; `main` 43, `origin/mc_dev` 44,
  `origin/main` 43. Commit `6b6f0c7` → exactly 2 files, `HANDOFF.md` +4 −2 and
  `docs/ACCURACY.md` +14 −0. Searching `docs` → 16 matches (confirmed
  independently against the raw log).
- Error paths: `/tmp` → "is not a git repository."; a missing folder → "is not a
  folder."; relative paths resolve against the server's cwd.
- Security: the `Host`-header rebinding guard, static-file whitelist (traversal
  → 404), and option-injection rejection (`sha`/`ref` values like
  `--output=/tmp/pwned`) all hold.
- Page console was clean — no errors, no exceptions — through every flow.
