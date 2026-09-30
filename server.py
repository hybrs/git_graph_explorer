#!/usr/bin/env python3
"""Git Graph Explorer - a tiny stdlib-only server behind a browser GitLens.

Serves the static app and exposes git history over a handful of JSON endpoints.
No third-party packages, no network access: it only shells out to `git`.

    python3 server.py [--port 8787] [--repo /path/to/repo] [--no-browser]
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))

# Only these files are ever served from disk, so no path traversal is possible.
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
}

GIT_TIMEOUT = 60        # seconds per git invocation
MAX_PATCH = 400 * 1024  # bytes of patch text sent to the browser
US = "\x1f"             # field separator inside a log record

LOG_FORMAT = US.join(["%H", "%P", "%an", "%ae", "%aI", "%D", "%B"])

SHA_RE = re.compile(r"^[0-9a-fA-F]{4,40}$")

# git-check-ref-format forbids whitespace and ~^:?*[\ in ref names, so this
# is permissive without ever letting a leading "-" be read as an option.
REF_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._/+@-]*$")


class GitError(Exception):
    """A git command failed, or the folder is not a repository."""


def git(repo, args):
    """Run git in `repo` and return stdout. Never uses a shell."""
    try:
        proc = subprocess.run(
            ["git", "-C", repo] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=GIT_TIMEOUT,
        )
    except FileNotFoundError:
        raise GitError("git is not installed, or not on PATH.")
    except subprocess.TimeoutExpired:
        raise GitError("git took longer than %ds and was stopped." % GIT_TIMEOUT)
    if proc.returncode != 0:
        msg = proc.stderr.decode("utf-8", "replace").strip()
        raise GitError(msg or ("git exited with code %d" % proc.returncode))
    return proc.stdout.decode("utf-8", "replace")


def resolve_repo(raw):
    """Validate a caller-supplied folder and return its work-tree root."""
    if not raw or not raw.strip():
        raise GitError("No folder given.")
    path = os.path.abspath(os.path.expanduser(raw.strip()))
    if not os.path.isdir(path):
        raise GitError("%s is not a folder." % path)
    try:
        git(path, ["rev-parse", "--absolute-git-dir"])
    except GitError:
        raise GitError("%s is not a git repository." % path)
    top = git(path, ["rev-parse", "--show-toplevel"]).strip()
    return top or path


def check_sha(sha):
    if not sha or not SHA_RE.match(sha):
        raise GitError("%r is not a commit id." % sha)
    return sha


def check_ref(repo, ref):
    """Validate a branch/tag name the caller asked to see."""
    if not ref:
        return ""
    if ".." in ref or not REF_RE.match(ref):
        raise GitError("%r is not a branch or tag name." % ref)
    try:
        git(repo, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"])
    except GitError:
        raise GitError("This repository has no branch or tag called %r." % ref)
    return ref


def read_refs(repo):
    """Every local branch, remote branch and tag, newest first.

    A tab is a safe separator: git forbids whitespace in ref names.
    """
    fmt = "%(refname:short)%09%(refname)%09%(objectname)%09%(committerdate:short)"
    try:
        out = git(repo, ["for-each-ref", "--sort=-committerdate",
                         "--format=" + fmt,
                         "refs/heads", "refs/remotes", "refs/tags"])
    except GitError:
        return []
    try:
        current = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).strip()
    except GitError:
        current = ""

    refs = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        short, full, sha, date = parts[0], parts[1], parts[2], parts[3]
        if full.startswith("refs/heads/"):
            kind = "local"
        elif full.startswith("refs/tags/"):
            kind = "tag"
        else:
            kind = "remote"
        # refs/remotes/origin/HEAD is just a pointer; it only adds noise.
        if full.endswith("/HEAD"):
            continue
        refs.append({
            "name": short,
            "kind": kind,
            "sha": sha,
            "date": date,
            "current": kind == "local" and short == current,
        })
    return refs


def repo_info(repo):
    try:
        branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).strip()
    except GitError:
        branch = ""
    try:
        head = git(repo, ["rev-parse", "HEAD"]).strip()
        total = int(git(repo, ["rev-list", "--all", "--count"]).strip() or 0)
    except GitError:
        head, total = "", 0  # a repo with no commits yet
    return {
        "root": repo,
        "name": os.path.basename(repo.rstrip(os.sep)) or repo,
        "branch": "HEAD" if branch == "HEAD" else branch,
        "head": head,
        "total": total,
    }


def parse_refs(decoration):
    """Turn git's %D into badge descriptors."""
    refs = []
    for piece in decoration.split(", "):
        name = piece.strip()
        if not name:
            continue
        kind = "branch"
        if name.startswith("HEAD -> "):
            name, kind = name[len("HEAD -> "):], "head"
        elif name == "HEAD":
            kind = "head"
        elif name.startswith("tag: "):
            name, kind = name[len("tag: "):], "tag"
        elif "/" in name:
            kind = "remote"
        refs.append({"name": name, "kind": kind})
    return refs


def read_log(repo, limit, skip, ref=""):
    """Commits newest-first, in --date-order.

    Without a ref the graph spans every branch and tag (--all); with one it
    shows just that ref's history. One extra commit is fetched so the caller
    can tell whether older ones remain.
    """
    args = ["log", "--date-order", "-z",
            "--max-count=%d" % (limit + 1), "--skip=%d" % skip,
            "--format=" + LOG_FORMAT]
    args.append(ref if ref else "--all")
    out = git(repo, args)
    commits = []
    for record in out.split("\0"):
        if not record.strip():
            continue
        fields = record.split(US)
        if len(fields) < 7:
            continue
        sha, parents, author, email, date, decoration, message = fields[:7]
        body = message.strip("\n")
        newline = body.find("\n")
        commits.append({
            "sha": sha,
            "parents": parents.split() if parents.strip() else [],
            "author": author,
            "email": email,
            "date": date,
            "refs": parse_refs(decoration),
            "subject": body if newline < 0 else body[:newline],
            "body": "" if newline < 0 else body[newline + 1:].strip("\n"),
        })
    has_more = len(commits) > limit
    return commits[:limit], has_more


def commit_parents(repo, sha):
    """The parents of one commit, in order."""
    out = git(repo, ["rev-list", "--parents", "-1", sha]).split()
    return out[1:] if out else []


def diff_cmd(repo, sha, parents, fmt_flags, pathspec=None):
    """Diff a commit against its first parent.

    The two-tree form `<sha>^1 <sha>` is deliberate. `diff-tree -m
    --first-parent` looks equivalent but emits the diff against *every*
    parent concatenated, which makes a merge list files it never touched and
    doubles its line counts. A root commit has no `^1`, so it is diffed
    against the empty tree with --root instead.
    """
    args = ["diff-tree", "-r", "--no-commit-id", "-M"] + fmt_flags
    if parents:
        args += [sha + "^1", sha]
    else:
        args += ["--root", sha]
    if pathspec is not None:
        args += ["--", pathspec]
    return git(repo, args)


def read_files(repo, sha):
    """Changed files for one commit: statuses from --raw, counts from --numstat."""
    parents = commit_parents(repo, sha)
    raw = diff_cmd(repo, sha, parents, ["--raw", "-z"]).split("\0")
    files, i = [], 0
    while i < len(raw):
        chunk = raw[i]
        if not chunk.startswith(":"):
            i += 1
            continue
        status = chunk.split(" ")[-1].strip()
        # R and C are followed by two paths (old, new); everything else by one.
        if status[:1] in ("R", "C") and i + 2 < len(raw):
            old, path, i = raw[i + 1], raw[i + 2], i + 3
        elif i + 1 < len(raw):
            old, path, i = "", raw[i + 1], i + 2
        else:
            break
        files.append({
            "status": status[:1],
            "score": status[1:],
            "path": path,
            "old": old,
            "add": 0,
            "del": 0,
            "binary": False,
        })

    counts = {}
    nums = diff_cmd(repo, sha, parents, ["--numstat", "-z"]).split("\0")
    i = 0
    while i < len(nums):
        entry = nums[i]
        i += 1
        if not entry.strip():
            continue
        parts = entry.split("\t")
        if len(parts) < 3:
            continue
        added, deleted, path = parts[0], parts[1], parts[2]
        if not path and i + 1 < len(nums):
            # Renames under -z put the two paths in the following fields.
            path, i = nums[i + 1], i + 2
        binary = added == "-" or deleted == "-"
        counts[path] = {
            "add": 0 if binary else int(added or 0),
            "del": 0 if binary else int(deleted or 0),
            "binary": binary,
        }

    total_add = total_del = 0
    for entry in files:
        stat = counts.get(entry["path"])
        if stat:
            entry.update(stat)
        total_add += entry["add"]
        total_del += entry["del"]
    files.sort(key=lambda f: f["path"])
    return {
        "files": files,
        "add": total_add,
        "del": total_del,
        "merge": len(parents) > 1,
    }


def read_diff(repo, sha, path):
    if not path:
        raise GitError("No file given.")
    parents = commit_parents(repo, sha)
    patch = diff_cmd(repo, sha, parents, ["-p"], path)
    truncated = len(patch) > MAX_PATCH
    if truncated:
        patch = patch[:MAX_PATCH]
    return {"patch": patch, "truncated": truncated}


class Handler(BaseHTTPRequestHandler):
    server_version = "GitGraphExplorer"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if self.server.verbose:
            sys.stderr.write("  %s\n" % (fmt % args))

    # --- plumbing ---------------------------------------------------------
    def send_bytes(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, payload, code=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_bytes(code, body, "application/json; charset=utf-8")

    def local_host(self):
        """Guard against DNS rebinding: only localhost may talk to us."""
        host = self.headers.get("Host", "")
        name = host.rsplit(":", 1)[0].strip("[]").lower()
        return name in ("localhost", "127.0.0.1", "::1", "")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.local_host():
            self.send_json({"error": "Only localhost may use this server."}, 403)
            return
        url = urlparse(self.path)
        query = parse_qs(url.query)

        def arg(key, default=""):
            return query.get(key, [default])[0]

        if url.path in STATIC:
            name, ctype = STATIC[url.path]
            try:
                with open(os.path.join(HERE, name), "rb") as handle:
                    self.send_bytes(200, handle.read(), ctype)
            except OSError:
                self.send_bytes(404, b"not found", "text/plain; charset=utf-8")
            return

        if not url.path.startswith("/api/"):
            self.send_json({"error": "No such endpoint."}, 404)
            return

        try:
            if url.path == "/api/default":
                # The folder given on the command line, if any.
                self.send_json({"path": self.server.default_repo or ""})
                return

            repo = resolve_repo(arg("path"))

            if url.path == "/api/repo":
                self.send_json(repo_info(repo))
            elif url.path == "/api/refs":
                self.send_json({"refs": read_refs(repo)})
            elif url.path == "/api/log":
                limit = max(1, min(20000, int(arg("limit", "2000") or 2000)))
                skip = max(0, int(arg("skip", "0") or 0))
                ref = check_ref(repo, arg("ref"))
                commits, has_more = read_log(repo, limit, skip, ref)
                self.send_json({
                    "commits": commits,
                    "skip": skip,
                    "limit": limit,
                    "ref": ref,
                    "has_more": has_more,
                })
            elif url.path == "/api/commit":
                self.send_json(read_files(repo, check_sha(arg("sha"))))
            elif url.path == "/api/diff":
                self.send_json(
                    read_diff(repo, check_sha(arg("sha")), arg("file")))
            else:
                self.send_json({"error": "No such endpoint."}, 404)
        except GitError as exc:
            self.send_json({"error": str(exc)}, 400)
        except ValueError:
            self.send_json({"error": "Bad query parameter."}, 400)
        except Exception as exc:  # keep the server alive, report the fault
            self.send_json({"error": "%s: %s" % (type(exc).__name__, exc)}, 500)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--repo", default=None,
                        help="folder to preselect in the UI")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    opts = parser.parse_args()

    default_repo = ""
    if opts.repo:
        try:
            default_repo = resolve_repo(opts.repo)
        except GitError as exc:
            print("warning: --repo ignored (%s)" % exc)

    # 127.0.0.1 only: never expose someone's filesystem to the network.
    server = ThreadingHTTPServer(("127.0.0.1", opts.port), Handler)
    server.daemon_threads = True
    server.default_repo = default_repo
    server.verbose = opts.verbose

    url = "http://127.0.0.1:%d/" % opts.port
    print("Git Graph Explorer -> %s" % url)
    if default_repo:
        print("  repo: %s" % default_repo)
    print("  (ctrl-c to stop)")
    if not opts.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
