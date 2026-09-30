/* Git Graph Explorer - front end. No dependencies, no network beyond our own
   localhost API. Talks to server.py, draws the commit graph, files and diffs. */
'use strict';

/* Must agree with the matching custom properties in app.css. */
var ROW_H = 26, FILE_H = 24, LANE_W = 14, LANE_PAD = 11;
var BUFFER = 8;          // extra rows rendered above and below the viewport
var PAGE = 2000;         // commits fetched per request

var LANE_COLORS = [
  '#4a9eff', '#e2c08d', '#4ec9b0', '#c586c0',
  '#f48771', '#9cdcfe', '#b5cea8', '#d7ba7d'
];

var $ = function (id) { return document.getElementById(id); };
var el = {
  repoPath: $('repoPath'), recents: $('recents'), openBtn: $('openBtn'),
  reloadBtn: $('reloadBtn'), repoMeta: $('repoMeta'), banner: $('banner'),
  branchSel: $('branchSel'),
  search: $('search'), matchCount: $('matchCount'),
  prevMatch: $('prevMatch'), nextMatch: $('nextMatch'), filterOnly: $('filterOnly'),
  scroller: $('scroller'), spacer: $('spacer'), rows: $('rows'),
  moreWrap: $('moreWrap'), moreBtn: $('moreBtn'),
  splitter: $('splitter'), leftPane: $('leftPane'), detail: $('detail')
};

var state = {
  repo: '',            // validated work-tree root
  info: null,          // { name, branch, head, total }
  refs: [],            // branches and tags offered in the picker
  ref: '',             // which one is graphed; '' means every branch
  commits: [],         // every loaded commit, newest first, with layout data
  byIndex: {},         // sha -> position in commits
  view: [],            // commits currently listed (all, or only matches)
  maxLanes: 1,
  graphW: 24,
  selSha: '',          // selected commit
  selPos: -1,          // its position in view, or -1
  files: null,         // file list of the selected commit, null while loading
  fileErr: '',
  activeFile: '',      // file whose diff is shown
  query: '',
  matches: [],         // positions in commits of matching entries
  matchAt: -1,
  reqToken: 0          // guards against out-of-order async responses
};

/* ------------------------------------------------------------------ utils */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* Escape, then wrap every occurrence of the query in <mark>. */
function mark(text, query) {
  var safe = esc(text);
  if (!query) return safe;
  var needle = esc(query).toLowerCase();
  if (!needle) return safe;
  var out = '', low = safe.toLowerCase(), i = 0;
  while (true) {
    var at = low.indexOf(needle, i);
    if (at < 0) { out += safe.slice(i); break; }
    out += safe.slice(i, at) + '<mark>' +
           safe.slice(at, at + needle.length) + '</mark>';
    i = at + needle.length;
  }
  return out;
}

function shortDate(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return iso || '';
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function banner(msg, kind) {
  if (!msg) { el.banner.hidden = true; el.banner.textContent = ''; return; }
  el.banner.hidden = false;
  el.banner.textContent = msg;
  el.banner.className = 'banner' + (kind === 'info' ? ' info' : '');
}

function api(path, params) {
  var qs = Object.keys(params || {}).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  return fetch(path + (qs ? '?' + qs : ''), { cache: 'no-store' })
    .then(function (res) {
      return res.json().catch(function () {
        throw new Error('The server sent a reply we could not read.');
      }).then(function (data) {
        if (!res.ok || data.error) {
          throw new Error(data.error || ('Request failed (' + res.status + ')'));
        }
        return data;
      });
    });
}

/* ----------------------------------------------------------- lane layout */

/* Walk the commits newest-first, keeping `lanes[k]` = the sha lane k is
   waiting for. Each commit takes a lane, collapses any other lane waiting
   for it, and hands its lanes on to its parents. */
function layout(commits) {
  var lanes = [], maxLanes = 1;

  for (var i = 0; i < commits.length; i++) {
    var c = commits[i], k;

    var incoming = [];
    for (k = 0; k < lanes.length; k++) {
      if (lanes[k] === c.sha) incoming.push(k);
    }

    var lane;
    if (incoming.length) {
      lane = incoming[0];
    } else {
      lane = lanes.indexOf(null);
      if (lane < 0) { lane = lanes.length; lanes.push(null); }
    }

    /* Lanes that neither hold this commit nor are empty simply carry on
       straight through this row. */
    var through = [];
    for (k = 0; k < lanes.length; k++) {
      if (lanes[k] && incoming.indexOf(k) < 0) through.push(k);
    }

    for (var n = 0; n < incoming.length; n++) lanes[incoming[n]] = null;
    lanes[lane] = null;

    /* Hand the lanes on: first parent keeps this lane, extra parents (a
       merge) take an existing lane already waiting for them, or a new one. */
    var down = [];
    for (var p = 0; p < c.parents.length; p++) {
      var parent = c.parents[p];
      var at = lanes.indexOf(parent);
      if (at < 0) {
        if (p === 0 && lanes[lane] === null) {
          at = lane;
        } else {
          at = lanes.indexOf(null);
          if (at < 0) { at = lanes.length; lanes.push(null); }
        }
        lanes[at] = parent;
      }
      if (down.indexOf(at) < 0) down.push(at);
    }

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    c.lane = lane;
    c.up = incoming;      // lanes entering the dot from above
    c.down = down;        // lanes leaving the dot below
    c.through = through;  // lanes passing this row untouched
    c.isTip = incoming.length === 0;

    var used = Math.max(lanes.length, lane + 1);
    for (k = 0; k < through.length; k++) used = Math.max(used, through[k] + 1);
    if (used > maxLanes) maxLanes = used;
  }

  state.maxLanes = Math.max(1, maxLanes);
  state.graphW = LANE_PAD * 2 + (state.maxLanes - 1) * LANE_W;
}

function laneX(lane) { return LANE_PAD + lane * LANE_W; }
function laneColor(lane) { return LANE_COLORS[lane % LANE_COLORS.length]; }

/* One small inline SVG per row: pass-throughs, merge curves, and the dot. */
function graphSvg(c) {
  var w = state.graphW, h = ROW_H, cy = h / 2, parts = [], i;

  function line(x1, y1, x2, y2, color) {
    if (x1 === x2) {
      parts.push('<path d="M' + x1 + ' ' + y1 + 'V' + y2 + '" stroke="' +
                 color + '"/>');
    } else {
      var m1 = y1 + (y2 - y1) * 0.45, m2 = y1 + (y2 - y1) * 0.55;
      parts.push('<path d="M' + x1 + ' ' + y1 + 'C' + x1 + ' ' + m1 + ' ' +
                 x2 + ' ' + m2 + ' ' + x2 + ' ' + y2 + '" stroke="' +
                 color + '"/>');
    }
  }

  for (i = 0; i < c.through.length; i++) {
    var t = c.through[i];
    line(laneX(t), 0, laneX(t), h, laneColor(t));
  }
  for (i = 0; i < c.up.length; i++) {
    line(laneX(c.up[i]), 0, laneX(c.lane), cy, laneColor(c.up[i]));
  }
  for (i = 0; i < c.down.length; i++) {
    line(laneX(c.lane), cy, laneX(c.down[i]), h, laneColor(c.down[i]));
  }

  var color = laneColor(c.lane), x = laneX(c.lane);
  var isHead = state.info && c.sha === state.info.head;
  if (isHead) {
    parts.push('<circle cx="' + x + '" cy="' + cy + '" r="6" fill="none" ' +
               'stroke="' + color + '" stroke-width="1.5"/>');
  }
  parts.push('<circle cx="' + x + '" cy="' + cy + '" r="' +
             (c.parents.length > 1 ? 3.6 : 4.2) + '" fill="' +
             (c.parents.length > 1 ? '#1e1e1e' : color) + '" stroke="' +
             color + '" stroke-width="' + (c.parents.length > 1 ? 2 : 1) + '"/>');

  return '<svg class="graph" width="' + w + '" height="' + h +
         '" viewBox="0 0 ' + w + ' ' + h + '" fill="none" stroke-width="1.6" ' +
         'stroke-linecap="round">' + parts.join('') + '</svg>';
}

/* ------------------------------------------------------- virtual list */

function expandH() {
  if (state.selPos < 0) return 0;
  var rows = state.files ? Math.max(state.files.length, 1) : 1;
  return rows * FILE_H + 2;
}

function rowTop(pos) {
  var extra = (state.selPos >= 0 && pos > state.selPos) ? expandH() : 0;
  return pos * ROW_H + extra;
}

function totalH() { return state.view.length * ROW_H + expandH(); }

/* Inverse of rowTop: which row sits at pixel y. */
function posAt(y) {
  var sel = state.selPos;
  if (sel < 0) return Math.floor(y / ROW_H);
  var selTop = sel * ROW_H;
  if (y < selTop) return Math.floor(y / ROW_H);
  if (y < selTop + ROW_H + expandH()) return sel;
  return Math.floor((y - expandH()) / ROW_H);
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function rowHtml(c, pos) {
  var cls = 'row';
  if (c.sha === state.selSha) cls += ' selected';
  if (state.query && !state.filter && !c._hit) cls += ' dimmed';
  if (state.query && c._hit && state.matchAt >= 0 &&
      state.matches[state.matchAt] === state.byIndex[c.sha]) cls += ' current';

  var badges = '';
  for (var i = 0; i < c.refs.length; i++) {
    badges += '<span class="badge ' + c.refs[i].kind + '" title="' +
              esc(c.refs[i].name) + '">' + esc(c.refs[i].name) + '</span>';
  }

  return '<div class="' + cls + '" style="top:' + rowTop(pos) + 'px" ' +
         'data-sha="' + c.sha + '">' +
         graphSvg(c) +
         badges +
         '<span class="subject">' + mark(c.subject, state.query) + '</span>' +
         '<span class="author">' + mark(c.author, state.query) + '</span>' +
         '<span class="sha">' + mark(c.sha.slice(0, 8), state.query) + '</span>' +
         '</div>';
}

function filesHtml() {
  var top = state.selPos * ROW_H + ROW_H;
  var inner = '';

  if (state.fileErr) {
    inner = '<div class="file"><span class="dir err">' +
            esc(state.fileErr) + '</span></div>';
  } else if (!state.files) {
    inner = '<div class="file"><span class="dir">reading changed files...</span></div>';
  } else if (!state.files.length) {
    inner = '<div class="file"><span class="dir">No file changes in this commit.</span></div>';
  } else {
    for (var i = 0; i < state.files.length; i++) {
      var f = state.files[i];
      var cut = f.path.lastIndexOf('/');
      var name = cut < 0 ? f.path : f.path.slice(cut + 1);
      var dir = cut < 0 ? '' : f.path.slice(0, cut);
      var num = f.binary ? '<span class="dir">binary</span>' :
        '<span class="p">+' + f.add + '</span> <span class="m">−' + f.del + '</span>';
      inner += '<div class="file' + (f.path === state.activeFile ? ' active' : '') +
        '" data-file="' + esc(f.path) + '" title="' + esc(f.path) + '">' +
        '<span class="filedot">◇</span>' +
        '<span class="name">' + esc(name) + '</span>' +
        '<span class="dir">' + esc(dir) + (f.old ? ' ← ' + esc(f.old) : '') + '</span>' +
        '<span class="num">' + num + '</span>' +
        '<span class="st st-' + esc(f.status) + '" title="' + esc(f.status) + '">' +
        esc(f.status) + '</span></div>';
    }
  }
  return '<div class="files" style="top:' + top + 'px;height:' + expandH() +
         'px">' + inner + '</div>';
}

function render() {
  el.spacer.style.height = totalH() + 'px';
  if (!state.view.length) {
    el.rows.innerHTML = '';
    return;
  }
  var top = el.scroller.scrollTop, h = el.scroller.clientHeight || 600;
  var first = clamp(posAt(top) - BUFFER, 0, state.view.length - 1);
  var last = clamp(posAt(top + h) + BUFFER, 0, state.view.length - 1);

  var html = '';
  for (var pos = first; pos <= last; pos++) {
    html += rowHtml(state.view[pos], pos);
  }
  if (state.selPos >= 0) {
    var pTop = state.selPos * ROW_H + ROW_H;
    if (pTop + expandH() > top - 300 && pTop < top + h + 300) html += filesHtml();
  }
  el.rows.innerHTML = html;
}

function scrollToPos(pos) {
  var top = rowTop(pos), h = el.scroller.clientHeight;
  var cur = el.scroller.scrollTop;
  if (top < cur + 4 || top + ROW_H > cur + h - 4) {
    el.scroller.scrollTop = Math.max(0, top - Math.round(h / 3));
  }
  render();
}

/* ------------------------------------------------------------- selection */

function computeSelPos() {
  state.selPos = -1;
  if (!state.selSha) return;
  for (var i = 0; i < state.view.length; i++) {
    if (state.view[i].sha === state.selSha) { state.selPos = i; return; }
  }
}

function select(sha, keepDiff) {
  if (!sha) return;
  state.selSha = sha;
  state.files = null;
  state.fileErr = '';
  if (!keepDiff) state.activeFile = '';
  computeSelPos();
  render();
  showCommit();

  var token = ++state.reqToken;
  api('/api/commit', { path: state.repo, sha: sha }).then(function (data) {
    if (token !== state.reqToken) return;
    state.files = data.files;
    state.stats = data;
    computeSelPos();
    render();
    showCommit();
    /* Open the first file's diff straight away, like GitLens does. */
    if (!state.activeFile && data.files.length) showDiff(data.files[0].path);
  }).catch(function (err) {
    if (token !== state.reqToken) return;
    state.files = [];
    state.fileErr = err.message;
    render();
  });
}

function commit(sha) {
  var i = state.byIndex[sha];
  return i === undefined ? null : state.commits[i];
}

function showCommit() {
  var c = commit(state.selSha);
  if (!c) return;
  var s = state.files && state.stats ? state.stats : null;
  var parents = c.parents.map(function (p) {
    return '<a data-goto="' + p + '" title="' + esc(p) + '">' +
           esc(p.slice(0, 8)) + '</a>';
  }).join(', ');

  var head =
    '<div class="dhead">' +
      '<h2>' + mark(c.subject, state.query) + '</h2>' +
      '<div class="dmeta">' +
        '<span class="dsha" id="copySha" title="Click to copy the full id">' +
          esc(c.sha.slice(0, 10)) + '</span>' +
        '<span>' + esc(c.author) + '</span>' +
        '<span>' + esc(shortDate(c.date)) + '</span>' +
      '</div>' +
      (c.body ? '<div class="dbody">' + mark(c.body, state.query) + '</div>' : '') +
    '</div>' +
    '<div class="dstat">' +
      (s ? (s.files.length + (s.files.length === 1 ? ' file' : ' files') +
            '  <span class="p">+' + s.add + '</span> ' +
            '<span class="m">−' + s.del + '</span>' +
            (s.merge ? ' <span class="hint" title="A merge is compared with' +
             ' its first parent, the way git show does.">vs first parent</span>'
             : ''))
         : 'reading changed files...') +
      (parents ? '<span class="parents">   parent: ' + parents + '</span>' : '') +
    '</div>';

  el.detail.innerHTML = head + '<div id="diffArea">' +
    (state.activeFile ? '' :
      '<p class="note">Select a file under the commit to see its diff.</p>') +
    '</div>';

  var copy = $('copySha');
  if (copy) {
    copy.onclick = function () {
      var text = c.sha;
      var done = function () {
        copy.textContent = 'copied';
        setTimeout(function () { copy.textContent = text.slice(0, 10); }, 900);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* nothing to do */ }
        document.body.removeChild(ta);
        done();
      }
    };
  }
  if (state.activeFile && state.lastPatch) {
    paintDiff(state.activeFile, state.lastPatch.patch, state.lastPatch.truncated);
  }
}

/* ------------------------------------------------------------------ diff */

function showDiff(path) {
  state.activeFile = path;
  state.lastPatch = null;
  render();
  var area = $('diffArea');
  if (area) area.innerHTML = '<p class="note">reading diff...</p>';

  var token = ++state.reqToken;
  api('/api/diff', { path: state.repo, sha: state.selSha, file: path })
    .then(function (data) {
      if (token !== state.reqToken) return;
      state.lastPatch = data;
      paintDiff(path, data.patch, data.truncated);
    }).catch(function (err) {
      if (token !== state.reqToken) return;
      var a = $('diffArea');
      if (a) a.innerHTML = '<p class="note err">' + esc(err.message) + '</p>';
    });
}

function diffLine(cls, oldN, newN, text) {
  return '<div class="dl ' + cls + '"><span class="g">' + (oldN || '') +
         '</span><span class="g">' + (newN || '') + '</span><span class="t">' +
         (esc(text) || ' ') + '</span></div>';
}

/* Header lines worth showing; the filename already sits in the diff header,
   so `diff --git`, `index`, `---` and `+++` are just noise and are dropped. */
var SHOW_META = ['new file', 'deleted file', 'old mode', 'new mode',
                 'similarity ', 'dissimilarity ', 'rename ', 'copy ',
                 'Binary files', 'GIT binary patch'];

function metaShown(line) {
  for (var i = 0; i < SHOW_META.length; i++) {
    if (line.indexOf(SHOW_META[i]) === 0) return true;
  }
  return false;
}

function paintDiff(path, patch, truncated) {
  var area = $('diffArea');
  if (!area) return;
  if (!patch || !patch.trim()) {
    area.innerHTML = '<div class="diffhead">' + esc(path) + '</div>' +
      '<p class="note">No textual diff \u2014 the file may be binary, or only ' +
      'its mode changed.</p>';
    return;
  }

  var lines = patch.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  var out = [], oldN = 0, newN = 0, inHunk = false;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];

    if (ln.indexOf('@@') === 0) {
      var m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
      if (m) { oldN = +m[1]; newN = +m[2]; }
      inHunk = true;
      out.push(diffLine('hunk', '', '', ln));
      continue;
    }

    /* Everything before the first @@ is the file header. Once inside a hunk a
       leading -, + or space is content, even if it looks like "---". */
    if (!inHunk) {
      if (metaShown(ln)) out.push(diffLine('meta', '', '', ln));
      continue;
    }

    var first = ln.charAt(0);
    if (first === '+') out.push(diffLine('add', '', newN++, ln));
    else if (first === '-') out.push(diffLine('del', oldN++, '', ln));
    else if (first === '\\') out.push(diffLine('meta', '', '', ln));
    else out.push(diffLine('ctx', oldN++, newN++, ln));
  }

  if (!out.length) {
    area.innerHTML = '<div class="diffhead">' + esc(path) + '</div>' +
      '<p class="note">No line changes to show for this file.</p>';
    return;
  }

  area.innerHTML = '<div class="diffhead">' + esc(path) + '</div>' +
    (truncated ? '<p class="note">This diff is very large and was cut short.</p>' : '') +
    '<div class="diff">' + out.join('') + '</div>';
}

/* ---------------------------------------------------------------- search */

function matchesQuery(c, q) {
  if (c.sha.toLowerCase().indexOf(q) === 0) return true;
  if (c.sha.toLowerCase().indexOf(q) >= 0) return true;
  if (c.subject.toLowerCase().indexOf(q) >= 0) return true;
  if (c.body.toLowerCase().indexOf(q) >= 0) return true;
  if (c.author.toLowerCase().indexOf(q) >= 0) return true;
  for (var i = 0; i < c.refs.length; i++) {
    if (c.refs[i].name.toLowerCase().indexOf(q) >= 0) return true;
  }
  return false;
}

function runSearch() {
  var q = el.search.value.trim().toLowerCase();
  state.query = q;
  state.filter = el.filterOnly.checked;
  state.matches = [];

  for (var i = 0; i < state.commits.length; i++) {
    var c = state.commits[i];
    c._hit = q ? matchesQuery(c, q) : false;
    if (c._hit) state.matches.push(i);
  }

  state.view = (q && state.filter)
    ? state.matches.map(function (i) { return state.commits[i]; })
    : state.commits.slice();

  state.matchAt = state.matches.length ? 0 : -1;
  computeSelPos();
  updateMatchUi();
  render();
  if (q && state.matches.length) jumpToMatch(0);
}

function updateMatchUi() {
  var n = state.matches.length;
  if (!state.query) {
    el.matchCount.textContent = '';
  } else {
    el.matchCount.textContent = n
      ? (state.matchAt + 1) + '/' + n
      : 'no match';
  }
  el.prevMatch.disabled = el.nextMatch.disabled = n < 1;
}

function jumpToMatch(at) {
  var n = state.matches.length;
  if (!n) return;
  state.matchAt = ((at % n) + n) % n;
  var c = state.commits[state.matches[state.matchAt]];
  updateMatchUi();
  select(c.sha);
  computeSelPos();
  if (state.selPos >= 0) scrollToPos(state.selPos);
}

/* ------------------------------------------------------------------ load */

function setRecents(path) {
  var list = [];
  try { list = JSON.parse(localStorage.getItem('gge.recents') || '[]'); }
  catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  list = list.filter(function (p) { return p !== path; });
  list.unshift(path);
  list = list.slice(0, 12);
  try { localStorage.setItem('gge.recents', JSON.stringify(list)); }
  catch (e) { /* private mode: not being able to remember is fine */ }
  drawRecents(list);
}

function drawRecents(list) {
  el.recents.innerHTML = list.map(function (p) {
    return '<option value="' + esc(p) + '"></option>';
  }).join('');
}

function loadRecents() {
  var list = [];
  try { list = JSON.parse(localStorage.getItem('gge.recents') || '[]'); }
  catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  drawRecents(list);
  return list;
}

function openRepo(path) {
  banner('');
  el.openBtn.disabled = true;
  state.reqToken++;
  api('/api/repo', { path: path }).then(function (info) {
    state.repo = info.root;
    state.info = info;
    el.repoPath.value = info.root;
    setRecents(info.root);
    el.repoMeta.innerHTML = '<b>' + esc(info.name) + '</b> &middot; ' +
      esc(info.branch || 'detached') + ' &middot; ' + info.total +
      (info.total === 1 ? ' commit' : ' commits');
    state.commits = [];
    state.byIndex = {};
    state.view = [];
    state.selSha = '';
    state.selPos = -1;
    state.files = null;
    state.activeFile = '';
    state.lastPatch = null;
    el.detail.innerHTML = '<p class="placeholder">Pick a commit on the left.</p>';
    if (!info.total) {
      banner('This repository has no commits yet.', 'info');
      state.refs = [];
      drawBranches();
      render();
      return;
    }
    return api('/api/refs', { path: state.repo }).then(function (data) {
      state.refs = data.refs || [];
      /* keep the chosen ref across a reload, but not across repositories */
      var keep = false;
      for (var i = 0; i < state.refs.length; i++) {
        if (state.refs[i].name === state.ref) keep = true;
      }
      if (!keep) state.ref = '';
      drawBranches();
      return fetchPage(0);
    });
  }).catch(function (err) {
    banner(err.message);
    el.repoMeta.textContent = '';
  }).then(function () {
    el.openBtn.disabled = false;
  });
}

function fetchPage(skip) {
  el.moreBtn.disabled = true;
  return api('/api/log',
             { path: state.repo, limit: PAGE, skip: skip, ref: state.ref })
    .then(function (data) {
      for (var i = 0; i < data.commits.length; i++) {
        var c = data.commits[i];
        c.subject = c.subject || '(no message)';
        state.byIndex[c.sha] = state.commits.length;
        state.commits.push(c);
      }
      layout(state.commits);
      el.moreWrap.hidden = !data.has_more;
      el.moreBtn.disabled = false;
      runSearch();
      if (!state.selSha && state.commits.length) select(state.commits[0].sha);
      else render();
    });
}

/* ----------------------------------------------------------- branch picker */

function drawBranches() {
  var groups = [
    ['local', 'Local branches'],
    ['remote', 'Remote branches'],
    ['tag', 'Tags']
  ];
  var html = '<option value="">All branches</option>';
  for (var g = 0; g < groups.length; g++) {
    var kind = groups[g][0], items = [];
    for (var i = 0; i < state.refs.length; i++) {
      if (state.refs[i].kind === kind) items.push(state.refs[i]);
    }
    if (!items.length) continue;
    html += '<optgroup label="' + groups[g][1] + '">';
    for (var j = 0; j < items.length; j++) {
      html += '<option value="' + esc(items[j].name) + '">' +
              esc(items[j].name) + (items[j].current ? '  (current)' : '') +
              '</option>';
    }
    html += '</optgroup>';
  }
  el.branchSel.innerHTML = html;
  el.branchSel.value = state.ref;
}

/* Reload the graph for whichever ref is picked. This only changes what is
   drawn - it never checks anything out, so the working tree is untouched. */
function showRef(ref) {
  state.ref = ref;
  state.commits = [];
  state.byIndex = {};
  state.view = [];
  state.selSha = '';
  state.selPos = -1;
  state.files = null;
  state.activeFile = '';
  state.lastPatch = null;
  el.detail.innerHTML = '<p class="placeholder">Pick a commit on the left.</p>';
  banner('');
  fetchPage(0).catch(function (err) { banner(err.message); });
}

/* ---------------------------------------------------------------- events */

el.openBtn.onclick = function () { openRepo(el.repoPath.value); };
el.repoPath.onkeydown = function (e) {
  if (e.key === 'Enter') openRepo(el.repoPath.value);
};
el.reloadBtn.onclick = function () {
  if (state.repo) openRepo(state.repo);
};
el.moreBtn.onclick = function () { fetchPage(state.commits.length); };
el.branchSel.onchange = function () { showRef(el.branchSel.value); };

el.scroller.addEventListener('scroll', render, { passive: true });
window.addEventListener('resize', render);

el.rows.addEventListener('click', function (e) {
  var file = e.target.closest ? e.target.closest('.file') : null;
  if (file && file.dataset.file) { showDiff(file.dataset.file); return; }
  var row = e.target.closest ? e.target.closest('.row') : null;
  if (row && row.dataset.sha) {
    if (row.dataset.sha === state.selSha) {
      /* clicking the selected commit again collapses its file list */
      state.selSha = '';
      state.selPos = -1;
      state.files = null;
      render();
    } else {
      select(row.dataset.sha);
    }
  }
});

el.detail.addEventListener('click', function (e) {
  var link = e.target.closest ? e.target.closest('[data-goto]') : null;
  if (!link) return;
  var sha = link.dataset.goto;
  if (!commit(sha)) {
    banner('That parent is not in the loaded history yet - load older commits.',
           'info');
    return;
  }
  select(sha);
  computeSelPos();
  if (state.selPos >= 0) scrollToPos(state.selPos);
});

var searchTimer = null;
el.search.addEventListener('input', function () {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 140);
});
el.search.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    if (state.query !== el.search.value.trim().toLowerCase()) runSearch();
    else jumpToMatch(state.matchAt + (e.shiftKey ? -1 : 1));
  } else if (e.key === 'Escape') {
    el.search.value = '';
    runSearch();
    el.scroller.focus();
  }
});
el.filterOnly.onchange = runSearch;
el.nextMatch.onclick = function () { jumpToMatch(state.matchAt + 1); };
el.prevMatch.onclick = function () { jumpToMatch(state.matchAt - 1); };

document.addEventListener('keydown', function (e) {
  var typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
    return;
  }
  if (typing) return;
  if (e.key === 'r' && state.repo) { openRepo(state.repo); return; }
  if (e.key === 'Escape') {
    el.search.value = '';
    runSearch();
    return;
  }
  var step = 0;
  if (e.key === 'ArrowDown' || e.key === 'j') step = 1;
  else if (e.key === 'ArrowUp' || e.key === 'k') step = -1;
  else if (e.key === 'PageDown') step = 12;
  else if (e.key === 'PageUp') step = -12;
  else return;
  e.preventDefault();
  if (!state.view.length) return;
  var pos = clamp((state.selPos < 0 ? 0 : state.selPos + step),
                  0, state.view.length - 1);
  select(state.view[pos].sha);
  computeSelPos();
  if (state.selPos >= 0) scrollToPos(state.selPos);
});

/* draggable splitter */
(function () {
  var dragging = false;
  el.splitter.addEventListener('mousedown', function (e) {
    dragging = true;
    document.body.classList.add('dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var box = el.leftPane.parentNode.getBoundingClientRect();
    var pct = ((e.clientX - box.left) / box.width) * 100;
    el.leftPane.style.flex = '0 0 ' + clamp(pct, 20, 85) + '%';
    render();
  });
  document.addEventListener('mouseup', function () {
    dragging = false;
    document.body.classList.remove('dragging');
  });
})();

/* ------------------------------------------------------------------ init */

(function () {
  var recents = loadRecents();
  updateMatchUi();
  api('/api/default', {}).then(function (d) {
    var start = d.path || recents[0] || '';
    if (start) { el.repoPath.value = start; openRepo(start); }
  }).catch(function () {
    if (recents[0]) { el.repoPath.value = recents[0]; openRepo(recents[0]); }
  });
})();
