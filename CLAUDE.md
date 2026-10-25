# CLAUDE.md — Git Graph Explorer

GitLens-style commit graph for a local git repo, in the browser. Offline, no
dependencies: `server.py` (Python 3.7+ stdlib) shells out to read-only `git`
and serves `index.html` / `app.css` / `app.js` (vanilla JS, no CDN, no build).

**`README.md` is the full reference** (usage, HTTP API, lane algorithm, git
traps, security, limitations). Read the relevant section before changing code.
`HANDOFF.md` holds design rationale, test recipes and verified results.
`.gitignore` ignores `*.md`: a new doc needs a `!NAME.md` negation.

## Run

```sh
python3 server.py [--repo PATH] [--port 8787] [--no-browser] [--no-picker] [-v]
```

Front-end edits need only a browser refresh; `server.py` edits need a restart.

## Files

| file | role |
|---|---|
| `server.py` | HTTP server, git plumbing, native folder dialog (`/api/pick`) |
| `app.js` | `layout()` lanes, `graphSvg()`, virtual list (`rowTop`/`posAt`), file tree (`buildTree`/`flatNodes`/`setFiles`), search, `paintDiff()` |
| `app.css` | dark theme; row/lane geometry in `:root` |
| `index.html` | the page |
| `environment.yml` | optional conda env (interpreter + git only) |

## Hard constraints

- **Python 3.7 compatible**: stdlib only, no walrus, no `dict | dict`, no
  builtin generics in annotations, no `functools.cache`. No `requirements.txt`.
- **Front end**: no frameworks, no external resources, must work offline.
- **Read-only**: never add `git checkout` or any mutating git command without
  asking. The branch picker only changes what is drawn.
- **Security** (see README): bind `127.0.0.1` only, `Host` header guard, every
  folder through `git rev-parse --absolute-git-dir`, arg lists never
  `shell=True`, validate sha/ref (reject leading `-`), `--` before paths,
  static-file whitelist, timeouts on every git call.

## Settled decisions — don't reopen without reason

- A Python server exists by design (pure-JS packfile reader rejected).
- Graph shows all refs (`git log --all`) by default.
- Search dims non-matching rows by default; `hide non-matching` filters.
- Merges diff against first parent, labelled *vs first parent*.
- File tree only when files span >1 folder; single-child chains compacted;
  folders first, A–Z; folders start open, collapsed paths kept in
  `state.collapsed` for the session; folder rows show summed `+/−`;
  `expand all · collapse all` header row.

## Traps — do not regress

- **Merge diffs**: use `<sha>^1 <sha>` two-tree form, `--root` for root commits.
  Never `diff-tree -m --first-parent` (concatenates diffs vs every parent).
  See `diff_cmd()`.
- `--raw -z`: `R`/`C` statuses carry two NUL-terminated paths.
- `git log -z`: records NUL-separated, fields `0x1f`-separated; `%B` first line
  is the subject.
- `paintDiff()` treats `---`/`+++` as headers only before the first `@@`
  (`inHunk` flag).
- Decode git output with `errors="replace"`.
- `ROW_H`, `FILE_H`, `LANE_W`, `LANE_PAD` in `app.js` **must match** the
  `app.css` `:root` properties, or scrolling silently breaks.
- `expandH()` counts `state.nodes` (visible tree rows). Anything that changes
  visibility must rebuild it with `flatNodes()` before `render()`, or rows
  below the expanded commit overlap / leave a gap.
- **Picker**: `MIN_DIALOG_SECONDS = 0.4` — an AppleScript `-128` "cancel"
  faster than that means the dialog could not open; fall through to the next
  picker (osascript → PowerShell → zenity/kdialog → tkinter). Matcher accepts
  "cancelled"/"canceled"/`-128`. Tk runs in a subprocess (macOS main-thread
  rule). Test the picker by clicking in a real browser — `osascript` from a
  non-interactive tool shell fails misleadingly.

## Testing (no test files in repo — recreate in scratchpad)

- **Lane invariant**: `eval` `layout()` from `app.js` in node, run on real
  `/api/log` output, assert continuity: row bottom (`through ∪ down`) == next
  row top (`through ∪ up`).
- **Ground truth**: scratch repo with two merges, side branches, a rename and a
  binary; compare each commit's file list to
  `git show --numstat --format= --first-parent -M <sha>`.
- **File tree**: extract `buildTree`/`flatNodes`/… from `app.js` by brace
  matching, eval in node with stub `state`/`render`; in the browser, check the
  `.files` block bottom equals the next `.row` top after every toggle.
- **Browser**: Claude-in-Chrome (`openRepo(path)` + dispatched clicks; see
  HANDOFF for races), or headless Chrome `--remote-debugging-port=9222` driven via node's
  built-in `WebSocket` over CDP (`Runtime.evaluate` on `state`, `runSearch()`,
  `select()`, `showDiff()`; watch `Runtime.exceptionThrown`). Poll for state,
  don't sleep. Headless Chrome often won't exit: wrap in `timeout 30`, then
  `pkill`.
- **API smoke**: `curl '127.0.0.1:8787/api/log?path=…'`; error paths (`/tmp` →
  "is not a git repository.", missing → "is not a folder."), traversal → 404,
  `sha=--output=/tmp/x` rejected, bad `Host` rejected.

## Open work (none required)

1. Branch-stable lane colours (currently `LANE_COLORS[lane % 8]` by position;
   track a colour per branch head through `layout()`).
2. Unrequested ideas: list/tree toggle, keyboard nav in the file list,
   working-tree/staged view, whole-commit patch,
   side-by-side diff, blame, server-side search over unloaded commits
   (history pages in 2000 at a time).
