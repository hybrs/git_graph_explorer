# Git Graph Explorer

A GitLens-style commit graph for any local git repository, in the browser.
Plain HTML, CSS and JavaScript — no frameworks, no CDNs, no build step, no
`pip install`, no network access of any kind. It works fully offline.

## Requirements

`git`, and **Python 3.7 or newer** — nothing else. There is nothing to install
and nothing to pin: `server.py` imports only the standard library (`argparse`,
`http.server`, `json`, `os`, `re`, `subprocess`, `sys`, `threading`,
`urllib.parse`, `webbrowser`) and the front end has no dependencies at all. A
`requirements.txt` for this project would be empty, so there isn't one.

3.7 is the floor because that is when `http.server.ThreadingHTTPServer` was
added; it is the only version-sensitive thing in the code. Verified working on
**3.7.3, 3.8.2 and 3.9.6**, against git 2.50.1. Keep the source 3.7-compatible:
no f-strings are needed, no walrus operator, no `dict | dict`, no builtin
generics in annotations, no `functools.cache`.

`environment.yml` is there only if you would rather have conda pin the
interpreter and git for you:

```sh
conda env create -f environment.yml && conda activate git-graph-explorer
```

Any system Python 3.7+ with git on `PATH` works just as well — no virtualenv
required.

## Run it

```sh
python3 server.py
```

That opens <http://127.0.0.1:8787> in your browser. Press **Browse…** to pick a
folder in the usual file dialog, or type the path in the box and press
**Open**. Picking any subfolder of a repository works — git resolves it to the
repository root.

To skip the typing, name the repository up front:

```sh
python3 server.py --repo <PATH_TO_GIT_REPO>
```

| option | |
|---|---|
| `--port 8787` | port to listen on |
| `--repo PATH` | folder to preselect in the UI |
| `--no-browser` | do not open a browser window |
| `--no-picker` | disable the native folder dialog |
| `-v` | log each request to stderr |

`server.py` holds no state, so editing `index.html`, `app.css` or `app.js` only
needs a browser refresh. Editing `server.py` needs a restart.

## Using it

| | |
|---|---|
| **Browse…** | pick a folder in the operating system's own file dialog |
| Path box | type or paste a path; remembers what you have opened |
| Branch picker | choose one branch or tag, or **All branches** |
| Click a commit | expands its changed files underneath, GitLens-style |
| Click a file | shows its unified diff on the right |
| Click the commit again | collapses the file list |
| Search box | commit id, message, body, author or ref name |
| `Enter` / `Shift+Enter` | jump to the next / previous match |
| `hide non-matching` | filter the list instead of dimming it |
| `j` `k` or arrows | move between commits |
| `/` | focus the search box |
| `Esc` | clear the search |
| `r` | reload history |
| Click the short id | copy the full commit id |
| Drag the divider | resize the two panes |

The graph shows **all refs** (`git log --all`) by default, so every local and
remote branch is visible. The picker in the toolbar narrows it to a single
branch or tag. Lanes are coloured by position; a merge commit is drawn as a
hollow dot, and `HEAD` gets a ring around it.

The picker only changes **what is drawn** — it never runs `git checkout`, so
your working tree and current branch are left exactly as they were. Nothing in
this tool writes to the repository; every git command it runs is read-only.

History is loaded 2000 commits at a time — **Load older commits** appears at
the bottom of the list when there are more. Search covers the commits that are
loaded, not the ones still on disk.

## Why there is a server at all

A page opened from `file://` cannot run `git` or read a folder you choose — the
browser sandbox forbids both. A pure-JavaScript reader was considered and
rejected: a normal repository keeps its objects in packfiles, so it would have
needed an idx-v2 parser, `OFS_DELTA`/`REF_DELTA` resolution and its own diff
algorithm, all to reimplement what git already does correctly.

`server.py` is therefore the smallest possible bridge: standard library only,
it shells out to `git` and serves the three static files.

## How **Browse…** works, and why it needs the server

A web page cannot tell anyone which folder you chose. `<input type="file"
webkitdirectory>` and `showDirectoryPicker()` both hand JavaScript the folder's
*name* and the paths of files *relative* to it — never the absolute path the
server needs. That is a deliberate sandbox rule, not an oversight.

So `/api/pick` asks the server, which runs on your machine, to open the real
dialog and report back the path. It tries, in order:

| platform | dialog |
|---|---|
| macOS | `osascript` → AppleScript `choose folder` (the Finder dialog) |
| Windows | PowerShell `FolderBrowserDialog` |
| Linux | `zenity`, then `kdialog` |
| anywhere | `tkinter.filedialog` — ships with Python, so it always exists |

Two details make that chain trustworthy:

- **A dialog that cannot open is not a cancel.** Some machines make
  `osascript` fail instantly with AppleScript's `-128`, which is the same code
  a real cancel produces. A "cancel" arriving in under
  `MIN_DIALOG_SECONDS` (0.4 s) is therefore treated as *this tool does not
  work here* and the next one is tried; nobody dismisses a dialog that fast.
  Without this the fallback chain would never run.
- **Tk runs in a subprocess**, never in the server process: on macOS Tk demands
  the main thread, and requests are served on worker threads.

Only one dialog can be open at a time, the rest of the app keeps working while
it is open, and cancelling is silent — no error, nothing changed.

Since the dialog appears on whatever machine runs `server.py`, **Browse…** is
only useful when that is your own desktop. Over SSH, or in a container, use the
path box (or `--no-picker` to hide the button's behaviour entirely). Note also
that the dialog can open *behind* the browser window.

## Layout

| | |
|---|---|
| `server.py` | stdlib-only HTTP server; all the git plumbing |
| `index.html` | the page |
| `app.css` | dark theme; the row/lane geometry lives in `:root` |
| `app.js` | lane layout, virtual list, search, diff rendering |
| `environment.yml` | optional conda env; pins the interpreter and git, no packages |
| `visir-brain/` | an unrelated repository, handy as test data |

`ROW_H`, `FILE_H`, `LANE_W` and `LANE_PAD` at the top of `app.js` **must** match
the matching custom properties in `app.css` — the virtual list computes pixel
offsets from the JavaScript copies while the browser lays rows out from the CSS
ones, so they silently drift apart if only one is changed.

## HTTP API

Every endpoint is `GET`, returns JSON, and takes `path` (the repository folder).
Errors come back as `{"error": "a sentence you can show a user"}` with status
400, so the UI can put the text straight in its banner.

| endpoint | returns |
|---|---|
| `/api/default` | `{path}` — the `--repo` folder, if one was given |
| `/api/pick` | `{path, via}`, or `{cancelled: true}`; opens the native folder dialog. Takes `start` |
| `/api/repo` | `{root, name, branch, head, total}` |
| `/api/refs` | `{refs: [{name, kind, sha, date, current}]}`, `kind` is `local`/`remote`/`tag` |
| `/api/log` | `{commits, skip, limit, ref, has_more}`; takes `limit`, `skip`, `ref` |
| `/api/commit` | `{files: [{status, score, path, old, add, del, binary}], add, del, merge}`; takes `sha` |
| `/api/diff` | `{patch, truncated}`; takes `sha` and `file` |

## How the graph is drawn

`layout()` in `app.js` walks the commits newest-first, keeping `lanes[k]` = the
sha that lane `k` is waiting for. For each commit it takes a lane, collapses any
other lane waiting for the same commit, then hands its lane on to its first
parent and gives extra parents (a merge) a lane of their own. Each row records
three things, and `graphSvg()` turns them into one small inline `<svg>`:

- `up` — lanes entering the row from above, curving into the dot
- `down` — lanes leaving the dot downwards, one per distinct parent lane
- `through` — lanes crossing the row untouched, drawn as straight verticals

The invariant that keeps the picture honest is **continuity**: the lanes leaving
the bottom of a row are exactly the lanes entering the top of the next one, so
no line ever dangles.

The list is virtualised — only the visible rows plus a small buffer exist in the
DOM. Because at most one commit is expanded at a time, row offsets stay O(1):
`rowTop()` adds the file list's height to every row below the selected one, and
`posAt()` inverts it.

## Traps worth knowing before you change anything

Each of these was found the hard way; the code carries a comment where it
matters.

- **Merge diffs.** `git diff-tree -m --first-parent` looks like it shows a merge
  against its first parent. It does not — it emits the diff against *every*
  parent concatenated, so merges list files they never touched and their line
  counts double. Use the explicit two-tree form `<sha>^1 <sha>`, and `--root`
  for a root commit, which has no `^1`. See `diff_cmd()` in `server.py`.
- **`--root` is not optional.** Without it a root commit shows no files at all.
- **Renames.** Under `--raw -z`, an `R` or `C` status is followed by **two**
  NUL-terminated paths (old, then new); every other status by one.
- **`git log -z`.** Records are NUL-separated and fields `0x1f`-separated,
  because commit bodies contain newlines. `%B` is the whole message; its first
  line is the subject.
- **`for-each-ref` separators.** A tab is safe: `git check-ref-format` forbids
  whitespace in ref names.
- **Diff header lines.** `---` and `+++` are only headers *before* the first
  `@@`. Inside a hunk a removed line reading `--` renders as `---`, so
  `paintDiff()` switches on an `inHunk` flag rather than on the prefix alone.
- **Encoding.** git output is not guaranteed UTF-8; it is decoded with
  `errors="replace"`.

## Security

The server executes `git` in a folder supplied over HTTP, so it is deliberately
narrow:

- binds `127.0.0.1` only, never `0.0.0.0`;
- rejects any request whose `Host` header is not localhost (DNS-rebinding
  guard);
- every folder goes through `git rev-parse --absolute-git-dir` before anything
  else runs;
- git is always invoked with an argument list, never `shell=True`;
- commit ids and ref names are validated, so a value like `--output=/tmp/x`
  cannot be read as an option, and `--` precedes user-supplied paths;
- static files come from a fixed whitelist of names, so no path traversal;
- each git call has a timeout.

## Known limitations

- Lane **colours** follow lane position, not branch identity, so a trunk can
  change colour where branches converge. The lines stay continuous and correct;
  it is cosmetic.
- No working-tree or staged view — committed history only.
- **Browse…** needs a desktop on the machine running the server; see above.
- Search only covers loaded commits (see **Load older commits** above).
- Single-file diffs only; there is no whole-commit combined patch view.
- Per-file diffs are capped at 400 KB, and the UI says so when it truncates.
