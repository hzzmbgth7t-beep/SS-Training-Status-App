/* SS Training Status — read-only viewer. Data source: Training Status Master - LIVE (via Supabase). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var cfg = window.SS_CONFIG || {};
  if (!window.supabase || !cfg.SUPABASE_URL || /YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY)) {
    $('fatal').textContent = 'App is not configured yet (config.js) or the Supabase library failed to load.';
    $('fatal').hidden = false;
    return;
  }
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  var state = { trainings: [], trainers: [], view: 'trainings', loaded: false };
  var DONE = /^(completed?|cancell?ed|closed|done|not included)$/i;
  var FILTER_KEY = 'ssts.filters.v1';

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) { u = String(u || '').trim(); return /^https?:\/\//i.test(u) ? u : ''; }
  function todayIso() {
    var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtRange(t) {
    if (!t.start_date && !t.end_date) return '<span class="muted">No date</span>';
    if (!t.end_date || t.end_date === t.start_date) return fmtDate(t.start_date || t.end_date);
    if (!t.start_date) return 'until ' + fmtDate(t.end_date);
    return fmtDate(t.start_date) + ' – ' + fmtDate(t.end_date);
  }
  function catClass(c) {
    c = String(c || '').toLowerCase();
    if (c.indexOf('free') === 0) return 'cat-free';
    if (c.indexOf('paid') === 0) return 'cat-paid';
    if (c.indexOf('rms') >= 0) return 'cat-rms';
    if (c.indexOf('qm') >= 0) return 'cat-qm';
    if (c.indexOf('sting') >= 0) return 'cat-sting';
    if (c.indexOf('product') === 0) return 'cat-product';
    return 'cat-other';
  }
  function isDone(t) { return DONE.test(String(t.status || '').trim()); }
  function endOf(t) { return t.end_date || t.start_date || ''; }
  function inProgress(t, today) { return t.start_date && t.start_date <= today && endOf(t) >= today && !isDone(t); }
  // "Current" = not finished: ends today or later, or undated and not marked done.
  function isCurrent(t, today) { var e = endOf(t); return e ? e >= today && !isDone(t) : !isDone(t); }
  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (v) { v = String(v || '').trim(); if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); } });
    return out.sort(function (a, b) { return a.localeCompare(b); });
  }

  // ---------- auth ----------
  var CHOICE_KEY = 'ssts.chosen';
  function only(view) {
    ['loginView', 'gateView', 'appView'].forEach(function (id) { $(id).hidden = id !== view; });
  }
  function showLogin() { state.access = null; only('loginView'); $('loginForm').hidden = false; $('resetForm').hidden = true; }
  function showReset() { only('loginView'); $('loginForm').hidden = true; $('resetForm').hidden = false; }
  function gateMsg(html) { only('gateView'); $('gateMsg').innerHTML = html; }
  function choose(app) { try { sessionStorage.setItem(CHOICE_KEY, app); } catch (e) { /* ignore */ } }
  function chosen() { try { return sessionStorage.getItem(CHOICE_KEY); } catch (e) { return null; } }
  function openConference() { choose('conference'); location.href = cfg.CONFERENCE_URL; }

  // Decide which app this person sees: anyone with Training Status goes straight in (no app choice on the
  // training address, Ronnie 11/26); conference only -> Conference Tracker.
  function routeSession(session) {
    $('userEmail').textContent = session.user.email || '';
    $('gateEmail').textContent = session.user.email || '';
    if (state.access) return enterTraining();
    gateMsg('Checking your access…');
    sb.rpc('my_app_access').then(function (r) {
      if (r.error) throw r.error;
      var a = state.access = r.data || {};
      updateSwitch();
      if (a.training) {
        enterTraining();
      } else if (a.conference) {
        gateMsg('Opening Conference Tracker…');
        location.replace(cfg.CONFERENCE_URL);
      } else {
        gateMsg('Your account does not have access to Training Status or Conference Tracker yet. Ask Ronnie Brigman to add you.');
      }
    }).catch(function (err) {
      state.access = null;
      gateMsg('Could not check your access: ' + esc(err.message || err));
    });
  }
  function enterTraining() {
    choose('training'); only('appView');
    if (!state.loaded) loadData();
    maybeStartTiles();
  }
  // Switch App: administrators with both apps only; goes straight to the Conference Tracker (Ronnie 11/18).
  $('switchApp').addEventListener('click', function () { openConference(); });
  $('gateSignOut').addEventListener('click', function () { sb.auth.signOut(); });

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = $('loginMsg'); msg.className = 'msg'; msg.textContent = 'Signing in…';
    sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value }).then(function (r) {
      if (r.error) { msg.textContent = 'Sign-in failed: ' + r.error.message; return; }
      msg.textContent = '';
    });
  });
  $('forgotBtn').addEventListener('click', function () {
    var msg = $('loginMsg'); var email = $('email').value.trim();
    if (!email) { msg.className = 'msg'; msg.textContent = 'Enter your email above first.'; return; }
    sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(function (r) {
      msg.className = r.error ? 'msg' : 'msg ok';
      msg.textContent = r.error ? r.error.message : 'If that email is on the team list, a reset link is on its way.';
    });
  });
  $('resetForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = $('resetMsg');
    sb.auth.updateUser({ password: $('newPassword').value }).then(function (r) {
      if (r.error) { msg.className = 'msg'; msg.textContent = r.error.message; return; }
      msg.className = 'msg ok'; msg.textContent = 'Password saved.';
      sb.auth.getSession().then(function (s) { if (s.data.session) routeSession(s.data.session); });
    });
  });
  $('signOut').addEventListener('click', function () {
    try { sessionStorage.removeItem(CHOICE_KEY); } catch (e) { /* ignore */ }
    sb.auth.signOut();
  });

  var recovering = /type=(recovery|invite)/.test(location.hash);
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === 'PASSWORD_RECOVERY' || (recovering && session && event === 'SIGNED_IN')) { recovering = false; showReset(); return; }
    if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
    if (session) routeSession(session);
    else { state.loaded = false; showLogin(); }
  });

  // ---------- data ----------
  function fetchAll(table, order) {
    var page = 1000, out = [];
    function next(from) {
      return sb.from(table).select('*').order(order).range(from, from + page - 1).then(function (r) {
        if (r.error) throw r.error;
        out = out.concat(r.data);
        return r.data.length === page ? next(from + page) : out;
      });
    }
    return next(0);
  }
  function loadData() {
    state.loaded = true;
    $('agencyList').innerHTML = '<div class="empty">Loading…</div>';
    Promise.resolve().then(function () {
      return Promise.all([
      fetchAll('ts_trainings', 'training_id'),
      fetchAll('ts_trainers', 'name'),
      sb.from('ts_sync_log').select('synced_at,note').order('synced_at', { ascending: false }).limit(1)
    ]);
    }).then(function (res) {
      if (!res) return;
      state.trainings = res[0]; state.trainers = res[1];
      var last = res[2].data && res[2].data[0];
      $('syncInfo').textContent = last
        ? 'Synced from master sheet ' + new Date(last.synced_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : 'Not synced yet';
      buildFilterOptions(); restoreFilters(); render();
    }).catch(function (err) {
      state.loaded = false;
      $('agencyList').innerHTML = '<div class="empty">Could not load data: ' + esc(err.message || err) + '</div>';
    });
  }

  // ---------- filters ----------
  var F = ['fDate', 'fFrom', 'fTo', 'fState', 'fTrainer', 'fCategory', 'fProduct', 'fStatus', 'fPM', 'fSearch', 'fSort', 'fSortDir'];
function pmList(t) { return String(t.pm || '').split(/[,;\/]| and /i).map(function (s) { return s.trim(); }).filter(String); }
  function fillSelect(id, label, values) {
    var el = $(id), cur = el.value;
    el.innerHTML = '<option value="">All ' + esc(label) + '</option>' +
      values.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');
    if (cur && values.indexOf(cur) >= 0) el.value = cur;
  }
  function buildFilterOptions() {
    var T = state.trainings;
    fillSelect('fState', 'states', uniq(T.map(function (t) { return t.state; })));
    var names = [].concat.apply([], T.map(function (t) { return t.trainer_list || []; }))
      .concat(state.trainers.filter(function (r) { return r.active; }).map(function (r) { return r.name; }));
    fillSelect('fTrainer', 'trainers', uniq(names));
    $('fTrainer').insertAdjacentHTML('beforeend', '<option value="__none">— Unassigned —</option>');
    fillSelect('fCategory', 'categories', uniq(['Free', 'Paid', 'Nucleus RMS Upgrade', 'Nucleus QM Upgrade', 'STING Upgrade', 'Product', 'Other']
      .concat(T.map(function (t) { return t.category; }))));
    fillSelect('fProduct', 'products', uniq(T.map(function (t) { return t.product; })));
    fillSelect('fStatus', 'statuses', uniq(T.map(function (t) { return t.status; })));
fillSelect('fPM', 'PMs', uniq([].concat.apply([], T.map(pmList))));
  }
  function saveFilters() {
    var o = {}; F.forEach(function (id) { o[id] = $(id).value; });
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
  }
  function restoreFilters() {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); } catch (e) { o = null; }
    if (o) F.forEach(function (id) {
      if (o[id] == null) return;
      var el = $(id);
      if (el.tagName === 'SELECT' && !Array.prototype.some.call(el.options, function (op) { return op.value === o[id]; })) return;
      el.value = o[id];
    });
    toggleRange();
  }
  function toggleRange() {
    var on = $('fDate').value === 'range';
    document.querySelectorAll('.range').forEach(function (l) { l.hidden = !on; });
  }
  F.forEach(function (id) {
    $(id).addEventListener(id === 'fSearch' ? 'input' : 'change', function () { toggleRange(); saveFilters(); render(); });
  });
  $('clearFilters').addEventListener('click', function () {
    F.forEach(function (id) { $(id).value = ''; }); $('fDate').value = 'current';
    toggleRange(); saveFilters(); render();
  });

  function matchDate(t, mode, today) {
    var s = t.start_date || t.end_date, e = endOf(t);
    switch (mode) {
      case 'all': return true;
      case 'current': return isCurrent(t, today);
      case 'past': return !!e && e < today;
      case 'nodate': return !s;
      case 'month': {
        var m0 = today.slice(0, 8) + '01', m1 = addDays(addDays(m0, 32).slice(0, 8) + '01', -1);
        return !!s && s <= m1 && e >= m0;
      }
      case 'next30': return !!s && s <= addDays(today, 30) && e >= today;
      case 'range': {
        var from = $('fFrom').value, to = $('fTo').value;
        if (!s) return false;
        return (!from || e >= from) && (!to || s <= to);
      }
    }
    return true;
  }
  function filtered() {
    var today = todayIso(), v = {
      date: $('fDate').value || 'current', state: $('fState').value, trainer: $('fTrainer').value,
      cat: $('fCategory').value, prod: $('fProduct').value, status: $('fStatus').value, pm: $('fPM').value,
      q: $('fSearch').value.trim().toLowerCase()
    };
    var lc = function (x) { return String(x || '').toLowerCase(); };
    var page = state.view === 'completed' ? 'completed' : 'active';
    return state.trainings.filter(function (t) {
      if ((page === 'completed') !== COMPLETE.test(String(t.status || '').trim())) return false;
      if (!matchDate(t, page === 'completed' && v.date === 'current' ? 'all' : v.date, today)) return false;
      if (state.mine && !(t.trainer_list || []).some(function (n) { return state.mine.indexOf(lc(n)) >= 0; })) return false;
      if (v.state && lc(t.state) !== lc(v.state)) return false;
      if (v.cat && lc(t.category) !== lc(v.cat)) return false;
      if (v.prod && lc(t.product) !== lc(v.prod)) return false;
      if (v.status && lc(t.status) !== lc(v.status)) return false;
if (v.pm && !pmList(t).some(function (n) { return lc(n) === lc(v.pm); })) return false;
      if (v.trainer === '__none') { if ((t.trainer_list || []).length) return false; }
      else if (v.trainer && !(t.trainer_list || []).some(function (n) { return lc(n) === lc(v.trainer); })) return false;
      if (v.q) {
        var hay = [t.training_id, t.agency, t.agency_std, t.state, t.category, t.product, t.trainers, t.status, t.notes, t.portal_project, t.source_ref, t.pm].join(' ').toLowerCase();
        if (hay.indexOf(v.q) < 0) return false;
      }
      return true;
    });
  }

  // ---------- render ----------
  function render() {
    if (state.view === 'trainings' || state.view === 'completed') renderTrainings(); else renderTrainers();
  }
  function trainingRow(t, today) {
    var links = [];
    var dl = safeUrl(t.drive_link); if (dl) links.push('<a href="' + esc(dl) + '" target="_blank" rel="noopener">Drive</a>');
    var pp = safeUrl(t.portal_project);
    if (pp) links.push('<a href="' + esc(pp) + '" target="_blank" rel="noopener">Portal</a>');
    else if (/^y(es)?$/i.test(String(t.portal_project).trim())) links.push('<span class="muted">In portal</span>');
    else if (t.portal_project) links.push('<span class="muted">Portal: ' + esc(t.portal_project) + '</span>');
    return '<tr class="t-row" title="Tap to show notes">' +
      '<td class="nowrap"><span class="tw"></span>' + fmtRange(t) + (inProgress(t, today) ? ' <span class="chip badge-now">Now</span>' : '') + '</td>' +
      '<td>' + (t.category ? '<span class="chip cat ' + catClass(t.category) + '">' + esc(t.category) + '</span>' : '') + '</td>' +
      '<td>' + esc(t.product) + '</td>' +
      '<td>' + (t.trainers ? esc(t.trainers) : '<span class="warn">Unassigned</span>') + '</td>' +
      '<td>' + esc(t.status) + '</td>' +
      '<td>' + esc(t.pm) + '</td>' +
      '<td>' + esc(t.delivery) + '</td>' +
      '<td class="nowrap small">' + links.join(' · ') + '<div class="muted">' + esc(t.training_id) + '</div></td>' +
      '</tr><tr class="t-detail" hidden><td colspan="8">' + notesBox(t) + '</td></tr>';
  }
  function renderTrainings() {
    var list = filtered(), today = todayIso();
    var groups = {};
    list.forEach(function (t) { var k = (t.agency_std || t.agency || '(No agency)') + (t.state ? ' (' + t.state + ')' : ''); (groups[k] = groups[k] || []).push(t); });
    Object.keys(groups).forEach(function (k) { groups[k].sort(cmpTrain); });
    var names = Object.keys(groups).sort(cmpGroups(groups));
    $('tSummary').textContent = list.length + ' training' + (list.length === 1 ? '' : 's') + ' across ' +
      names.length + ' agenc' + (names.length === 1 ? 'y' : 'ies') + ' (of ' + state.trainings.length + ' total)';
    if (!names.length) {
      $('agencyList').innerHTML = '<div class="empty card">' + (state.trainings.length
        ? 'No trainings match these filters.' : 'No data yet — the master sheet has not been synced.') + '</div>';
      return;
    }
    var open = names.length <= 8;
    $('agencyList').innerHTML = names.map(function (n) {
      var rows = groups[n];
      var st = uniq(rows.map(function (t) { return t.state; })).join(', ');
      var cats = uniq(rows.map(function (t) { return t.category; }));
      return '<details class="agency card"' + (open ? ' open' : '') + '><summary>' +
        '<span class="agency-name">' + esc(n) + '</span>' +
        (st ? '<span class="chip">' + esc(st) + '</span>' : '') +
        '<span class="muted small">' + rows.length + ' training' + (rows.length === 1 ? '' : 's') + '</span>' +
        cats.map(function (c) { return '<span class="chip cat ' + catClass(c) + '">' + esc(c) + '</span>'; }).join('') +
        '</summary><div class="table-wrap"><table><thead><tr>' +
        '<th>Date</th><th>Category</th><th>Product</th><th>Trainer(s)</th><th>Status</th><th>PM</th><th>Onsite/Remote</th><th>Links / ID</th>' +
        '</tr></thead><tbody>' + rows.map(function (t) { return trainingRow(t, today); }).join('') + '</tbody></table></div></details>';
    }).join('');
  }
  $('expandAll').addEventListener('click', function () { document.querySelectorAll('details.agency').forEach(function (d) { d.open = true; }); });
  $('collapseAll').addEventListener('click', function () { document.querySelectorAll('details.agency').forEach(function (d) { d.open = false; }); });

// Trainers page: one collapsible card per trainer (Ronnie 11/15).
function renderTrainers() {
var today = todayIso(), showInactive = $('showInactive').checked;
var byName = {};
state.trainers.forEach(function (r) { byName[r.name.toLowerCase()] = { info: r, items: [] }; });
state.trainings.forEach(function (t) {
if (!isCurrent(t, today)) return;
(t.trainer_list || []).forEach(function (n) {
var k = n.toLowerCase();
if (!byName[k]) byName[k] = { info: { name: n, active: true, missing: true }, items: [] };
byName[k].items.push(t);
});
});
var people = Object.keys(byName).map(function (k) { return byName[k]; })
.filter(function (p) { return showInactive || p.info.active || p.items.length; })
.filter(function (p) { return !state.mine || state.mine.indexOf(p.info.name.toLowerCase()) >= 0; })
.sort(function (a, b) { return b.items.length - a.items.length || a.info.name.localeCompare(b.info.name); });
var busy = people.filter(function (p) { return p.items.length; }).length;
$('rSummary').textContent = people.length + ' trainers · ' + busy + ' with current assignments';
if (!people.length) { $('trainerList').innerHTML = '<div class="empty card">No trainers yet — the master sheet has not been synced.</div>'; return; }
$('trainerList').innerHTML = people.map(function (p) {
var r = p.info;
var items = p.items.sort(function (a, b) { return (a.start_date || '9999').localeCompare(b.start_date || '9999'); });
var now = items.filter(function (t) { return inProgress(t, today); }).length;
return '<details class="agency card trainer"><summary>' +
'<span class="agency-name">' + esc(r.name) + '</span>' +
'<span class="chip">' + items.length + ' current</span>' +
(now ? '<span class="chip badge-now">' + now + ' now</span>' : '') +
(r.active === false ? '<span class="chip">Inactive</span>' : '') +
(r.missing ? '<span class="warn">Not on the Trainers tab</span>' : '') +
'</summary><div class="trainer-body">' +
'<div class="meta">' + [r.email ? '<a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a>' : '', esc(r.products)].filter(String).join(' · ') +
(r.missing ? '<div class="warn">Named on a training but not on the Trainers tab of the master sheet</div>' : '') + '</div>' +
(items.length ? '<ul>' + items.map(function (t) {
return '<li><div class="line1"><strong>' + esc(t.agency_std || t.agency) + '</strong><span class="small">' + fmtRange(t) +
(inProgress(t, today) ? ' <span class="chip badge-now">Now</span>' : '') + '</span></div>' +
'<div class="line2">' + [t.category ? '<span class="chip cat ' + catClass(t.category) + '">' + esc(t.category) + '</span>' : '',
esc(t.product), esc(t.state), esc(t.delivery), esc(t.status)].filter(String).join(' · ') + '</div></li>';
}).join('') + '</ul>' : '<div class="muted small">No current assignments.</div>') + '</div></details>';
}).join('');
}
  $('showInactive').addEventListener('change', renderTrainers);
  $('trExpand').addEventListener('click', function () { document.querySelectorAll('details.trainer').forEach(function (d) { d.open = true; }); });
  $('trCollapse').addEventListener('click', function () { document.querySelectorAll('details.trainer').forEach(function (d) { d.open = false; }); });

  // ---------- tabs ----------
  function setView(v) {
    state.view = v;
    document.querySelectorAll('.tab').forEach(function (b) {
      var on = b.dataset.view === v; b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
    });
    $('trainingsView').hidden = v !== 'trainings' && v !== 'completed';
    $('trainersView').hidden = v !== 'trainers';
    if (location.hash !== '#' + v && !/access_token|type=/.test(location.hash)) history.replaceState(null, '', '#' + v);
    if (state.loaded) render();
  }
  document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { setView(b.dataset.view); }); });
  setView({ '#trainers': 'trainers', '#completed': 'completed' }[location.hash] || 'trainings');
// ---------- Face ID / passkey sign-in and Help (added 2026-11-15) ----------
var canPasskey = !!(window.PublicKeyCredential && sb.auth.signInWithPasskey && sb.auth.registerPasskey);
if (!canPasskey) { $('passkeyBtn').hidden = true; $('passkeySetup').hidden = true; }
function pkCancelled(err) { return /abort|notallowed|cancel/i.test(String(err.code || '') + ' ' + err.message); }
$('passkeyBtn').addEventListener('click', function () {
var msg = $('loginMsg'); msg.className = 'msg'; msg.textContent = 'Waiting for Face ID or passkey…';
sb.auth.signInWithPasskey().then(function (r) {
if (r.error) {
msg.textContent = pkCancelled(r.error) ? 'Face ID / passkey sign-in was cancelled.'
: 'Face ID / passkey sign-in did not work on this device. Sign in with your password, then tap Set up Face ID.';
return;
}
msg.textContent = '';
}).catch(function (err) { msg.textContent = 'Face ID / passkey sign-in did not work: ' + (err.message || err); });
});
$('passkeySetup').addEventListener('click', function () {
var m = $('pkMsg'); m.className = 'small'; m.textContent = 'Setting up…';
sb.auth.registerPasskey().then(function (r) {
if (r.error) {
var t = String(r.error.code || '') + ' ' + r.error.message;
m.className = 'small warn';
m.textContent = pkCancelled(r.error) ? 'Set-up was cancelled.'
: /disabled|not enabled|not_found|404/i.test(t) ? 'Face ID / passkey sign-in is not turned on for this app yet.'
: 'Face ID / passkey could not be set up on this device.';
return;
}
m.textContent = 'Done. Next time, tap "Sign in with Face ID or Passkey".';
}).catch(function (err) { m.className = 'small warn'; m.textContent = 'Could not set up: ' + (err.message || err); });
});

sb.auth.onAuthStateChange(function (event) {
if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') $('helpPage').hidden = true;
});
var helpReturn = null;
function openHelp() {
helpReturn = ['loginView', 'gateView', 'appView'].filter(function (id) { return !$(id).hidden; })[0] || 'loginView';
$(helpReturn).hidden = true; $('helpPage').hidden = false; window.scrollTo(0, 0);
}
$('helpBtn').addEventListener('click', openHelp);
$('helpLink').addEventListener('click', openHelp);
$('helpBack').addEventListener('click', function () {
$('helpPage').hidden = true; $(helpReturn || 'loginView').hidden = false; window.scrollTo(0, 0);
});
// ---------- Users: managed in the Conference Tracker (Ronnie 11/15) ----------
// The owner's Users page is now a link to the shared Users page in the Conference Tracker (Menu > Admin > Users).
function setOwner(on) {
$('usersTab').hidden = !on;
if (!on) { $('usersView').hidden = true; if (state.view === 'users') setView('trainings'); }
}
sb.auth.onAuthStateChange(function (event, session) {
if (!session) { setOwner(false); return; }
if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
sb.rpc('is_owner_user').then(function (r) { setOwner(!r.error && r.data === true); });
}
});
document.querySelectorAll('.tab').forEach(function (b) {
b.addEventListener('click', function () { $('usersView').hidden = b.dataset.view !== 'users'; });
});

// ---------- Menu button and Day / Night (added 2026-11-15) ----------
var THEME_KEY = 'ssts.theme';
var darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function themeChoice() { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { return 'light'; } }
function applyTheme(choice) {
if (choice) { try { localStorage.setItem(THEME_KEY, choice); } catch (e) { /* ignore */ } } else { choice = themeChoice(); }
var night = choice === 'dark' || (choice === 'auto' && darkMq && darkMq.matches);
document.documentElement.setAttribute('data-theme', night ? 'dark' : 'light');
$('themeBtn').textContent = night ? '☀︎' : '☾';
$('themeBtn').title = night ? 'Switch to Day' : 'Switch to Night';
document.querySelectorAll('[data-theme-choice]').forEach(function (b) { b.classList.toggle('on', b.dataset.themeChoice === choice); });
}
if (darkMq && darkMq.addEventListener) darkMq.addEventListener('change', function () { if (themeChoice() === 'auto') applyTheme(); });
$('themeBtn').addEventListener('click', function () {
applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});
document.querySelectorAll('[data-theme-choice]').forEach(function (b) {
b.addEventListener('click', function () { applyTheme(b.dataset.themeChoice); });
});
applyTheme();

var PAGE_NAMES = { trainings: 'Trainings', trainers: 'Trainers', users: 'Users' };
function openMenu(on) {
$('menuPanel').hidden = !on;
$('menuBtn').setAttribute('aria-expanded', on ? 'true' : 'false');
}
$('menuBtn').addEventListener('click', function (e) { e.stopPropagation(); openMenu($('menuPanel').hidden); });
document.addEventListener('click', function (e) {
if (!$('menuPanel').hidden && !$('menuPanel').contains(e.target) && e.target !== $('menuBtn')) openMenu(false);
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') openMenu(false); });
document.querySelectorAll('.tab').forEach(function (b) {
b.addEventListener('click', function () { $('pageName').textContent = PAGE_NAMES[b.dataset.view] || ''; openMenu(false); window.scrollTo(0, 0); });
});
$('pageName').textContent = PAGE_NAMES[state.view] || '';
$('helpBtn').addEventListener('click', function () { openMenu(false); });
$('signOut').addEventListener('click', function () { openMenu(false); });
$('switchApp').addEventListener('click', function () { openMenu(false); });

$('changePwBtn').addEventListener('click', function () { $('pwForm').hidden = !$('pwForm').hidden; $('pwMsg').textContent = ''; });
$('pwForm').addEventListener('submit', function (e) {
e.preventDefault();
var m = $('pwMsg'); m.className = 'msg'; m.textContent = 'Saving…';
sb.auth.updateUser({ password: $('pwNew').value }).then(function (r) {
if (r.error) { m.textContent = 'Not changed: ' + r.error.message; return; }
m.className = 'msg ok'; m.textContent = 'Password changed.'; $('pwNew').value = '';
});
});
// ---------- Active PM Projects page (added 2026-11-15) ----------
// Active = status not Complete/Completed/Cancelled/Closed/Done/Not Included and not On Hold (Ronnie 11/9, 1B). Dates ignored.
PAGE_NAMES.pm = 'Active PM Projects';
var pmState = { rows: [], loaded: false };
var PM_HIDE = /^(completed?|cancell?ed|closed|done|not included)$|hold/i;
function pmActive(r) { return !PM_HIDE.test(String(r.project_status || '').trim()); }
function loadPm() {
$('pmList').innerHTML = '<div class="empty">Loading…</div>';
sb.from('ts_pm_projects').select('*').order('project').then(function (r) {
if (r.error) throw r.error;
pmState.rows = r.data || []; pmState.loaded = true;
var act = pmState.rows.filter(pmActive);
fillSelect('pmState', 'states', uniq(act.map(function (x) { return x.state; })));
fillSelect('pmStatus', 'statuses', uniq(act.map(function (x) { return x.project_status; })));
fillSelect('pmPM', 'PMs', uniq(act.map(function (x) { return x.project_manager; })));
renderPm();
}).catch(function (err) {
$('pmList').innerHTML = '<div class="empty card">Could not load projects: ' + esc(err.message || err) + '</div>';
});
}
function pmField(label, v) {
v = String(v == null ? '' : v).trim();
if (!v || /^other or na$/i.test(v)) return '';
return '<div class="pm-f"><span class="muted small">' + esc(label) + '</span><div>' + esc(v) + '</div></div>';
}
function renderPm() {
var lc = function (x) { return String(x || '').toLowerCase(); };
var st = $('pmState').value, ss = $('pmStatus').value, pm = $('pmPM').value, q = $('pmSearch').value.trim().toLowerCase();
var act = pmState.rows.filter(pmActive);
var list = act.filter(function (r) {
if (st && lc(r.state) !== lc(st)) return false;
if (ss && lc(r.project_status) !== lc(ss)) return false;
if (pm && lc(r.project_manager) !== lc(pm)) return false;
if (state.mine && !state.mine.some(function (n) { return [r.cad_trainer, r.rms_trainer, r.jms_trainer, r.mdis_trainer].join(' | ').toLowerCase().indexOf(n) >= 0; })) return false;
if (q && [r.project, r.state, r.deliverables, r.project_status, r.project_manager, r.account_manager, r.it_staff, r.cad_trainer, r.rms_trainer, r.jms_trainer, r.mdis_trainer, r.hardware, r.notes].join(' ').toLowerCase().indexOf(q) < 0) return false;
return true;
}).sort(function (a, b) { return String(a.project).localeCompare(String(b.project)); });
var hidden = pmState.rows.length - act.length;
$('pmSummary').textContent = list.length + ' project' + (list.length === 1 ? '' : 's') + ' (of ' + act.length + ' active' +
(hidden ? '; ' + hidden + ' on hold or finished not shown' : '') + ')';
if (!list.length) { $('pmList').innerHTML = '<div class="empty card">' + (pmState.rows.length ? 'No projects match these filters.' : 'No projects yet - the master sheet has not been synced.') + '</div>'; return; }
$('pmList').innerHTML = list.map(function (r) {
return '<details class="agency card"><summary>' +
'<span class="agency-name">' + esc(r.project) + '</span>' +
(r.state ? '<span class="chip">' + esc(r.state) + '</span>' : '') +
(r.project_status ? '<span class="chip badge-now">' + esc(r.project_status) + '</span>' : '') +
'<span class="muted small">PM: ' + esc(r.project_manager || 'not set') + '</span>' +
'</summary><div class="pm-body">' +
pmField('Deliverables', r.deliverables) + pmField('Date received', r.date_received ? fmtDate(r.date_received) : '') +
pmField('Account manager', r.account_manager) + pmField('IT staff', r.it_staff) +
pmField('CAD trainer', r.cad_trainer) + pmField('RMS trainer', r.rms_trainer) + pmField('JMS trainer', r.jms_trainer) +
pmField('MDIS trainer', r.mdis_trainer) + pmField('Hardware', r.hardware) +
'<div class="pm-f pm-notes"><span class="muted small">Notes</span><div>' + (esc(r.notes) || '<span class="muted">None</span>') + '</div></div>' +
'<div class="pm-f pm-notes muted small">Board last updated: ' + esc(r.last_updated_report || 'not shown') + '</div>' +
'</div></details>';
}).join('');
}
['pmState', 'pmStatus', 'pmPM'].forEach(function (id) { $(id).addEventListener('change', renderPm); });
$('pmSearch').addEventListener('input', renderPm);
$('pmClear').addEventListener('click', function () { ['pmState', 'pmStatus', 'pmPM', 'pmSearch'].forEach(function (id) { $(id).value = ''; }); renderPm(); });
document.querySelectorAll('.tab').forEach(function (b) {
b.addEventListener('click', function () {
var on = b.dataset.view === 'pm';
$('pmView').hidden = !on;
if (on) loadPm();
});
});

// ---------- Day / Night saved with the account (added 2026-11-15) ----------
var themeUser = null;
function saveTheme() {
if (!themeUser) return;
sb.from('ts_user_settings').upsert({ user_id: themeUser, theme: themeChoice(), updated_at: new Date().toISOString() }).then(function () { /* best effort */ });
}
$('themeBtn').addEventListener('click', saveTheme);
document.querySelectorAll('[data-theme-choice]').forEach(function (b) { b.addEventListener('click', saveTheme); });
sb.auth.onAuthStateChange(function (event, session) {
if (!session) { themeUser = null; return; }
if (event !== 'SIGNED_IN' && event !== 'INITIAL_SESSION') return;
themeUser = session.user.id;
sb.from('ts_user_settings').select('theme').eq('user_id', themeUser).maybeSingle().then(function (r) {
if (r.error) return;
if (r.data && r.data.theme) { if (r.data.theme !== themeChoice()) applyTheme(r.data.theme); }
else saveTheme();
});
});

// ---------- List order, my defaults, Reset, notes box, Completed page, My Projects (Ronnie 11/15) ----------
// Sort fields come from new master-sheet date columns (requested from the Compiler, 1A); until they exist, items without the date go last, by start date.
var SORTS = {
alpha: { label: 'Alphabetical' },
signed: { label: 'Date signed', f: 'date_signed' },
assigned: { label: 'Date assigned', f: 'date_assigned' },
kickoff: { label: 'Kickoff Meeting', f: 'kickoff_date' },
admin: { label: 'Admin Training', f: 'admin_training_date' },
user: { label: 'User Training', f: 'user_training_date' },
golive: { label: 'Go Live', f: 'go_live_date' }
};
var COMPLETE = /^(completed?|closed)$/i; // Completed page = Complete or Closed (Ronnie 11/15, 3A)
var prefs = { sort_default: 'signed', sort_dir: 'asc', notes_order: 'newest' };
var lastChange = null;
var me = { id: null, email: '', admin: false };
state.mine = null;
PAGE_NAMES.completed = 'Completed';
function lcs(x) { return String(x || '').toLowerCase(); }
function sortOptions() {
return Object.keys(SORTS).map(function (k) { return '<option value="' + k + '">' + esc(SORTS[k].label) + '</option>'; }).join('');
}
$('fSort').innerHTML = sortOptions(); $('dSort').innerHTML = sortOptions();
function sortKey(t) { var s = SORTS[$('fSort').value]; return s && s.f ? String(t[s.f] || '') : ''; }
function sortDir() { return $('fSortDir').value === 'desc' ? -1 : 1; }
function cmpTrain(a, b) {
var d = sortDir(), ka = sortKey(a), kb = sortKey(b);
if (ka && kb && ka !== kb) return ka < kb ? -d : d;
if (ka && !kb) return -1;
if (!ka && kb) return 1;
return (a.start_date || '9999').localeCompare(b.start_date || '9999');
}
function cmpGroups(groups) {
return function (a, b) {
if ($('fSort').value === 'alpha') return sortDir() * a.localeCompare(b);
return cmpTrain(groups[a][0], groups[b][0]) || a.localeCompare(b);
};
}

// Notes box: split notes into dated entries. Lines from the Compiler (one entry per line, 2A) or, until then, sentences starting with a date (2B).
function isoFrom(m, d, y, ref) {
var yr = y ? (String(y).length === 2 ? 2000 + +y : +y) : +String(ref).slice(0, 4);
var iso = yr + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
if (!y && iso > addDays(ref, 1)) iso = (yr - 1) + iso.slice(4);
return iso;
}
function noteEntries(t) {
var txt = String(t.notes || '').trim(); if (!txt) return [];
var ref = /^\d{4}-\d{2}-\d{2}/.test(String(t.last_updated)) ? String(t.last_updated).slice(0, 10) : todayIso();
var dated = [], undated = [], n = 0;
txt.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(String).forEach(function (line) {
var re = /(^|[.;]\s+)\(?(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?)(?=[\s:,)\-])/g, cuts = [], m;
while ((m = re.exec(line))) cuts.push({ at: m.index + m[1].length, iso: m[2] ? m[2] + '-' + m[3] + '-' + m[4] : isoFrom(m[5], m[6], m[7], ref) });
if (!cuts.length || cuts[0].at > 0) undated.push(line.slice(0, cuts.length ? cuts[0].at : line.length).trim());
cuts.forEach(function (c, i) {
var s = line.slice(c.at, i + 1 < cuts.length ? cuts[i + 1].at : line.length).trim();
if (s) dated.push({ iso: c.iso, text: s, n: n++ });
});
});
var dir = prefs.notes_order === 'oldest' ? 1 : -1;
dated.sort(function (a, b) { return a.iso === b.iso ? a.n - b.n : (a.iso < b.iso ? -dir : dir); });
undated = undated.filter(String);
if (undated.length) dated.push({ iso: '', text: undated.join(' ') });
return dated;
}
function notesBox(t) {
var f = [];
if (t.agency && t.agency_std && t.agency !== t.agency_std) f.push('Agency in tracker: ' + esc(t.agency));
if (t.source) f.push('Source: ' + esc(t.source) + (t.source_ref ? ' (' + esc(t.source_ref) + ')' : ''));
if (t.last_updated) f.push('Last updated: ' + esc(fmtDate(String(t.last_updated).slice(0, 10))));
var ents = noteEntries(t);
return '<div class="nbox">' + (f.length ? '<div class="nfields">' + f.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div>' : '') +
(ents.length ? ents.map(function (e) {
return '<div class="nentry"><div class="ndate">' + (e.iso ? esc(fmtDate(e.iso)) : '<span class="muted">Undated</span>') + '</div><div class="ntext">' + esc(e.text) + '</div></div>';
}).join('') : '<div class="muted small">No notes.</div>') + '</div>';
}
$('agencyList').addEventListener('click', function (e) {
if (e.target.closest('a')) return;
var tr = e.target.closest('tr.t-row'); if (!tr) return;
var d = tr.nextElementSibling; if (!d || !d.classList.contains('t-detail')) return;
d.hidden = !d.hidden; tr.classList.toggle('open', !d.hidden);
});

// Reset = put the last changed control back to its default; Reset all = your default settings.
function defaultFor(id) {
if (id === 'fDate') return 'current';
if (id === 'fSort') return prefs.sort_default;
if (id === 'fSortDir') return prefs.sort_dir;
return '';
}
F.forEach(function (id) { $(id).addEventListener(id === 'fSearch' ? 'input' : 'change', function () { lastChange = id; }); });
$('resetLast').addEventListener('click', function () {
if (!lastChange) return;
if (lastChange === 'mine') setMine(null);
else { $(lastChange).value = defaultFor(lastChange); toggleRange(); saveFilters(); render(); }
lastChange = null;
});
$('clearFilters').addEventListener('click', function () {
$('fSort').value = prefs.sort_default; $('fSortDir').value = prefs.sort_dir;
lastChange = null; saveFilters(); setMine(null);
});
(function () { // first visit on this device: start from the default order
var saved = null; try { saved = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); } catch (e) { saved = null; }
if (!saved || !saved.fSort) { $('fSort').value = prefs.sort_default; $('fSortDir').value = prefs.sort_dir; }
})();

// My defaults (saved with the account)
function showPrefs() { $('dSort').value = prefs.sort_default; $('dSortDir').value = prefs.sort_dir; $('dNotes').value = prefs.notes_order; }
function savePrefs() {
prefs = { sort_default: $('dSort').value, sort_dir: $('dSortDir').value, notes_order: $('dNotes').value };
var m = $('dMsg'); m.textContent = 'Saving…';
if (!me.id) { m.textContent = 'Not saved: not signed in.'; return; }
sb.from('ts_user_settings').upsert({ user_id: me.id, sort_default: prefs.sort_default, sort_dir: prefs.sort_dir, notes_order: prefs.notes_order, updated_at: new Date().toISOString() })
.then(function (r) { m.textContent = r.error ? 'Not saved: ' + r.error.message : 'Saved. Reset all now uses these.'; });
if (state.loaded) render();
}
['dSort', 'dSortDir', 'dNotes'].forEach(function (id) { $(id).addEventListener('change', savePrefs); });
showPrefs();

// Switch App shows only for administrators (owner or Training Admin) who also have the Conference Tracker.
function updateSwitch() { var a = state.access || {}; $('switchApp').hidden = !(me && me.admin && a.training && a.conference); }

// Show My Projects / Select Trainer(s)
function myNames() { return state.trainers.filter(function (r) { return r.email && lcs(r.email) === me.email; }).map(function (r) { return lcs(r.name); }); }
function mineLabel() {
if (me.admin) return state.mine ? 'Trainers: ' + state.mine.length + ' selected' : 'Select Trainer(s)';
return state.mine ? 'Show All Projects' : 'Show My Projects';
}
function setMine(list) {
state.mine = list && list.length ? list : null;
document.querySelectorAll('.mine-btn').forEach(function (b) { b.textContent = mineLabel(); b.classList.toggle('on', !!state.mine); });
if (state.loaded) render();
if (state.view === 'pm' && pmState.loaded) renderPm();
}
function openPick() {
var names = uniq(state.trainers.map(function (r) { return r.name; })
.concat([].concat.apply([], state.trainings.map(function (t) { return t.trainer_list || []; }))));
$('pickList').innerHTML = names.map(function (n) {
var on = state.mine && state.mine.indexOf(lcs(n)) >= 0;
return '<label><input type="checkbox" value="' + esc(n) + '"' + (on ? ' checked' : '') + '> ' + esc(n) + '</label>';
}).join('') || '<div class="muted small">No trainers yet.</div>';
$('trPick').hidden = false;
}
document.querySelectorAll('.mine-btn').forEach(function (b) {
b.addEventListener('click', function () {
if (me.admin) { openPick(); return; }
if (state.mine) { lastChange = 'mine'; setMine(null); return; }
var mine = myNames();
if (!mine.length) { b.textContent = 'Your email is not on the Trainers tab'; setTimeout(function () { b.textContent = mineLabel(); }, 3500); return; }
lastChange = 'mine'; setMine(mine);
});
});
$('pickApply').addEventListener('click', function () {
var list = Array.prototype.map.call($('pickList').querySelectorAll('input:checked'), function (i) { return lcs(i.value); });
$('trPick').hidden = true; lastChange = 'mine'; setMine(list);
});
$('pickAll').addEventListener('click', function () { $('pickList').querySelectorAll('input').forEach(function (i) { i.checked = false; }); });
$('pickCancel').addEventListener('click', function () { $('trPick').hidden = true; });

sb.auth.onAuthStateChange(function (event, session) {
if (!session) { me = { id: null, email: '', admin: false }; setMine(null); updateSwitch(); return; }
if (event !== 'SIGNED_IN' && event !== 'INITIAL_SESSION') return;
me.id = session.user.id; me.email = lcs(session.user.email);
sb.rpc('ts_is_admin').then(function (r) { me.admin = !r.error && r.data === true; setMine(state.mine); updateSwitch(); });
sb.from('ts_user_settings').select('sort_default,sort_dir,notes_order').eq('user_id', me.id).maybeSingle().then(function (r) {
if (r.error || !r.data) return;
var hadDefault = $('fSort').value === prefs.sort_default && $('fSortDir').value === prefs.sort_dir;
prefs = { sort_default: r.data.sort_default || prefs.sort_default, sort_dir: r.data.sort_dir || prefs.sort_dir, notes_order: r.data.notes_order || prefs.notes_order };
showPrefs();
if (hadDefault) { $('fSort').value = prefs.sort_default; $('fSortDir').value = prefs.sort_dir; saveFilters(); }
if (state.loaded) render();
});
});

// ---------- Card Reader (Ronnie 11/21-22) ----------
// Own ts_ tables, separate from the Conference Tracker. Agency replaces the conference field (Ronnie 11/21, 1).
PAGE_NAMES.cards = 'Card Reader';
var CF = ['first_name', 'last_name', 'title', 'agency', 'department', 'work_email', 'mobile', 'office_phone', 'office_ext',
  'city', 'state', 'website', 'linkedin', 'badge_code', 'date_met', 'notes'];
var cards = { list: [], reasons: [], exp: {}, shares: {}, loaded: false, editing: null, image: null, otherReason: null, pendingSave: null };
var TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
var JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
function loadScript(url) {
  return new Promise(function (ok, bad) {
    if (document.querySelector('script[src="' + url + '"]')) return ok();
    var s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = function () { bad(new Error('Could not load ' + url)); };
    document.head.appendChild(s);
  });
}
function cMe() { return (me && me.email) || ''; }
function cName(c) { return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.work_email || '(no name)'; }
function cIsNew(c) { var e = cards.exp[c.id]; return !e || e < c.updated_at; }
function cDigits(s) { return String(s || '').replace(/\D/g, '').slice(-10); }
function cMsg(t, ok) { var m = $('cfMsg'); m.className = 'msg' + (ok ? ' ok' : ''); m.textContent = t || ''; }

// ---- load and list ----
function loadCards() {
  if (!me.id) return Promise.resolve();
  return Promise.all([
    sb.from('ts_contacts').select('*').order('updated_at', { ascending: false }),
    sb.from('ts_card_reasons').select('reason,active').order('reason'),
    sb.from('ts_contact_exports').select('contact_id,exported_at'),
    sb.from('ts_contact_shares').select('contact_id,email')
  ]).then(function (r) {
    var err = r.filter(function (x) { return x.error; })[0];
    if (err) throw err.error;
    cards.list = r[0].data || [];
    cards.reasons = (r[1].data || []).filter(function (x) { return x.active !== false; }).map(function (x) { return x.reason; });
    cards.inactive = (r[1].data || []).filter(function (x) { return x.active === false; }).map(function (x) { return x.reason; });
    cards.exp = {}; (r[2].data || []).forEach(function (x) { cards.exp[x.contact_id] = x.exported_at; });
    cards.shares = {}; (r[3].data || []).forEach(function (x) { (cards.shares[x.contact_id] = cards.shares[x.contact_id] || []).push(x.email); });
    cards.loaded = true;
    cardCounts(); renderCards();
  }).catch(function (e) {
    $('cardList').innerHTML = '<div class="empty card">Could not load cards: ' + esc(e.message || e) + '</div>';
  });
}
function cardCounts() {
  var n = cards.list.filter(cIsNew), mine = n.filter(function (c) { return c.created_by_email === cMe(); }).length;
  $('cardCounts').innerHTML = (mine ? '<span class="chip">' + mine + ' mine</span>' : '') + (n.length ? '<span class="chip">' + n.length + ' all</span>' : '');
  $('tileCount').textContent = mine ? mine + ' of yours not exported' : ''; $('tileCount').hidden = !mine;
}
function renderCards() {
  var q = $('cSearch').value.trim().toLowerCase(), show = $('cShow').value;
  var list = cards.list.filter(function (c) {
    if (show === 'mine' && c.created_by_email !== cMe()) return false;
    if (show === 'new' && !cIsNew(c)) return false;
    if (q && [cName(c), c.title, c.agency, c.department, c.work_email, c.mobile, c.office_phone, c.city, c.state, c.reason, (c.tags || []).join(' '), c.notes]
      .join(' ').toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  var newCount = cards.list.filter(cIsNew).length;
  $('cSummary').textContent = list.length + ' card' + (list.length === 1 ? '' : 's') + ' shown · ' + newCount + ' not exported yet';
  $('cBackup').hidden = !me.admin;
  if (!list.length) { $('cardList').innerHTML = '<div class="empty card">' + (cards.list.length ? 'No cards match.' : 'No cards yet. Tap Add Card.') + '</div>'; return; }
  $('cardList').innerHTML = list.map(function (c) {
    return '<div class="card c-row" data-id="' + esc(c.id) + '"><div class="c-line1"><strong>' + esc(cName(c)) + '</strong>' +
      (c.reason ? '<span class="chip">' + esc(c.reason) + '</span>' : '') + (cIsNew(c) ? '<span class="chip badge-now">New</span>' : '') +
      (c.visibility === 'only_me' ? '<span class="chip">Only me</span>' : c.visibility === 'selected' ? '<span class="chip">Shared</span>' : '') + '</div>' +
      '<div class="small">' + [esc(c.title), esc(c.agency), esc(c.department)].filter(String).join(' · ') + '</div>' +
      '<div class="small muted">' + [esc(c.work_email), esc(c.mobile), esc(c.office_phone) + (c.office_ext ? ' x' + esc(c.office_ext) : '')].filter(function (x) { return x && x !== ' x'; }).join(' · ') +
      ' · saved by ' + esc(c.created_by_email) + '</div></div>';
  }).join('');
}
$('cardList').addEventListener('click', function (e) {
  var r = e.target.closest('.c-row'); if (!r) return;
  var c = cards.list.filter(function (x) { return x.id === r.dataset.id; })[0]; if (c) openCardForm(c);
});
$('cSearch').addEventListener('input', renderCards);
$('cShow').addEventListener('change', renderCards);
document.querySelectorAll('.tab').forEach(function (b) {
  b.addEventListener('click', function () {
    var on = b.dataset.view === 'cards';
    $('cardsView').hidden = !on;
    if (on) { $('cardList').innerHTML = cards.loaded ? $('cardList').innerHTML : '<div class="empty">Loading…</div>'; loadCards(); }
  });
});

// ---- form (matches the Conference Tracker's Add Card, v3.8.22; Ronnie 11/26) ----
var ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
var GRID_F = ['first_name', 'last_name', 'title', 'agency', 'department', 'work_email', 'mobile', 'office_phone', 'office_ext', 'city', 'state', 'website', 'linkedin'];
var F_LABEL = { first_name: 'First name', last_name: 'Last name', title: 'Title', agency: 'Agency', department: 'Department', work_email: 'Work email', mobile: 'Mobile phone',
  office_phone: 'Office phone', office_ext: 'Ext.', city: 'City', state: 'State', website: 'Website', linkedin: 'LinkedIn', badge_code: 'Badge / code', tags: 'Tags' };
var cf = { editing: null, image: null, reads: [], hideBlank: false, touched: {}, base: '', dupOf: null, saved: false };
function fillReasons(sel) {
  var list = cards.reasons.slice();
  $('cf_reason').innerHTML = '<option value="">Choose…</option>' + list.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') +
    (sel && list.indexOf(sel) < 0 ? '<option value="' + esc(sel) + '">' + esc(sel) + ((cards.inactive || []).indexOf(sel) >= 0 ? ' (inactive)' : ' (this card only)') + '</option>' : '') +
    '<option value="__other">Other…</option>';
  $('cf_reason').value = sel || '';
}
function agencyList() {
  $('cfAgencies').innerHTML = uniq(state.trainings.map(function (t) { return t.agency_std || t.agency; })).map(function (a) { return '<option value="' + esc(a) + '">'; }).join('');
}
function setMark(f, m) {
  var el = document.querySelector('[data-mark="' + f + '"]'); if (!el) return;
  el.textContent = m === 'read' ? 'read' : m === 'check' ? 'check this' : ''; el.className = 'mark ' + (m || '');
}
function setMarks(marks) { CF.forEach(function (f) { setMark(f, marks && marks[f]); }); }
function formSnapshot() {
  var o = {}; CF.concat(['tags', 'reason', 'vis', 'share']).forEach(function (k) { var el = $('cf_' + k); o[k] = el ? el.value : ''; }); return JSON.stringify(o);
}
function cfDirty() { return !cf.saved && (formSnapshot() !== cf.base || !!$('cfText').value.trim()); }
function cfShow(which) { $('cfMain').hidden = which !== 'main'; $('cfDupView').hidden = which !== 'dup'; $('cfSavedView').hidden = which !== 'saved'; }
function cfButtons() {
  var ok = !!$('cf_reason').value && $('cf_reason').value !== '__other' && (!!$('cf_last_name').value.trim() || !!$('cf_agency').value.trim());
  $('cfSave').disabled = !ok; $('cfNeeds').hidden = ok;
  $('cfFillBtn').disabled = !$('cfText').value.trim();
  $('cfCancel').textContent = cfDirty() ? 'Cancel' : 'Back to Previous Page';
}
function cfFieldView() {
  var hidden = 0, anyVal = false;
  GRID_F.forEach(function (f) {
    var v = !!$('cf_' + f).value.trim(); if (v) anyVal = true;
    var hide = cf.hideBlank && !v && !cf.touched[f]; if (hide) hidden++;
    var lab = document.querySelector('[data-f="' + f + '"]'); if (lab) lab.hidden = hide;
  });
  var t = $('cfFieldsToggle'), marked = !!document.querySelector('#cfGrid .mark.read, #cfGrid .mark.check');
  if (cf.hideBlank && hidden) { t.hidden = false; t.textContent = 'Show All Fields (' + hidden + ' hidden)'; }
  else if (!cf.hideBlank && anyVal && marked) { t.hidden = false; t.textContent = 'Hide Blank Fields'; }
  else t.hidden = true;
}
$('cfFieldsToggle').addEventListener('click', function () {
  if (cf.hideBlank) cf.hideBlank = false; else { cf.touched = {}; cf.hideBlank = true; }
  cfFieldView();
});
function openCardForm(c) {
  cf = { editing: c || null, image: null, reads: [], hideBlank: false, touched: {}, base: '', dupOf: null, saved: false };
  $('cfTitle').textContent = c ? 'Edit Card' : 'Add Card';
  CF.forEach(function (f) { $('cf_' + f).value = c ? (c[f] == null ? '' : c[f]) : ''; });
  if (!c) $('cf_date_met').value = todayIso();
  $('cf_tags').value = c ? (c.tags || []).join(', ') : '';
  fillReasons(c ? c.reason : '');
  $('cf_vis').value = c ? c.visibility : 'everyone';
  $('cf_share').value = c ? (cards.shares[c.id] || []).join(', ') : '';
  var mine = !c || c.created_by_email === cMe();
  $('cf_vis').disabled = !mine; $('cf_share').disabled = !mine;
  $('cfShareRow').hidden = $('cf_vis').value !== 'selected';
  $('cfOther').hidden = true; $('cfAsk').hidden = true; $('cfReasonMsg').hidden = true; cMsg('');
  $('cfScanBox').hidden = !!c; $('cfText').value = ''; $('cfPicKept').hidden = true; cfBusy('');
  $('cfDelete').hidden = !(c && (c.created_by_email === cMe() || me.admin));
  $('cfViewImg').hidden = !c; $('cfImg').hidden = true; $('cfImg').src = '';
  $('cfSaved').textContent = c ? 'Saved by ' + c.created_by_email + (c.updated_by_email ? ' · last edit ' + c.updated_by_email : '') : '';
  $('cfSave').textContent = c ? 'Save Changes' : 'Save Card';
  agencyList(); setMarks(null);
  cf.base = formSnapshot(); cfFieldView(); cfButtons(); cfShow('main');
  $('cardForm').hidden = false; $('cardForm').scrollTop = 0;
}
function closeCardForm() { $('cardForm').hidden = true; $('cfLeave').hidden = true; stopCam(); }
$('cAdd').addEventListener('click', function () { openCardForm(null); });
$('cfCancel').addEventListener('click', function () { if (cfDirty()) $('cfLeave').hidden = false; else closeCardForm(); });
$('cfStay').addEventListener('click', function () { $('cfLeave').hidden = true; });
$('cfLeaveYes').addEventListener('click', closeCardForm);
$('cf_vis').addEventListener('change', function () { $('cfShareRow').hidden = $('cf_vis').value !== 'selected'; cfButtons(); });
$('cfMain').addEventListener('input', function (e) {
  var id = e.target.id || ''; if (id.indexOf('cf_') === 0) { var f = id.slice(3); setMark(f, null); cf.touched[f] = true; }
  cfButtons();
});
$('cf_reason').addEventListener('change', function () {
  $('cfAsk').hidden = true; $('cfReasonMsg').hidden = true;
  if ($('cf_reason').value !== '__other') { $('cfOther').hidden = true; cfButtons(); return; }
  $('cfOther').hidden = false; $('cfOtherText').value = ''; $('cfOtherText').focus();
  $('cfAddList').hidden = !me.admin; $('cfUseOnce').className = me.admin ? 'ghost small' : 'primary small'; cfButtons();
});
function reasonMsg(t) { $('cfReasonMsg').textContent = t; $('cfReasonMsg').hidden = !t; }
function useOther(addToList) {
  var r = $('cfOtherText').value.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!r) { reasonMsg('Type a reason.'); return; }
  if (addToList) {
    var hit = cards.reasons.filter(function (x) { return x.toLowerCase() === r.toLowerCase(); })[0];
    if (hit) { fillReasons(hit); $('cfOther').hidden = true; cfButtons(); return; }
    var off = (cards.inactive || []).filter(function (x) { return x.toLowerCase() === r.toLowerCase(); })[0];
    if (off) { fillReasons(off); $('cfOther').hidden = true; reasonMsg('"' + off + '" is set inactive, so it is used on this card only. An admin can reactivate it in the Conference Tracker Admin page.'); cfButtons(); return; }
    sb.from('ts_card_reasons').insert({ reason: r, added_by_email: cMe() }).then(function (x) {
      if (x.error) { reasonMsg('The reason could not be added to the list.'); return; }
      cards.reasons.push(r); cards.reasons.sort(); fillReasons(r); $('cfOther').hidden = true; reasonMsg('"' + r + '" was added to the Reason list.'); cfButtons();
    });
  } else {
    fillReasons(r); $('cfOther').hidden = true;
    if (!me.admin) { $('cfAskText').textContent = r; $('cfAsk').hidden = false; }
    cfButtons();
  }
}
$('cfAddList').addEventListener('click', function () { useOther(true); });
$('cfUseOnce').addEventListener('click', function () { useOther(false); });
$('cfOtherCancel').addEventListener('click', function () { $('cfOther').hidden = true; $('cf_reason').value = ''; cfButtons(); });
$('cfAskYes').addEventListener('click', function () {
  var r = $('cfAskText').textContent; $('cfAsk').hidden = true;
  sb.from('ts_reason_requests').insert({ reason: r, requested_by_email: cMe() }).then(function (x) {
    reasonMsg(x.error ? 'The request could not be sent.' : 'Request sent. A Training Admin will see it in the Conference Tracker: Admin → Training Status: Card Reader Reasons.');
  });
});
$('cfAskNo').addEventListener('click', function () { $('cfAsk').hidden = true; });

function formValues() {
  var o = {};
  CF.forEach(function (f) { var v = $('cf_' + f).value.trim(); o[f] = v || null; });
  if (o.work_email) o.work_email = o.work_email.toLowerCase();
  if (o.state) o.state = o.state.toUpperCase().slice(0, 2);
  o.tags = $('cf_tags').value.split(',').map(function (s) { return s.trim(); }).filter(String);
  o.reason = $('cf_reason').value === '__other' ? '' : $('cf_reason').value;
  o.visibility = $('cf_vis').value;
  return o;
}
// Duplicate score (same as the Conference Tracker): 35 or more = possible duplicate.
function nrm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function nPhone(s) { return String(s || '').replace(/\D+/g, '').replace(/^1(?=\d{10}$)/, ''); }
function nUrl(s) { return nrm(s).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, ''); }
function dupScore(a, b) {
  var n = 0;
  if (a.work_email && nrm(a.work_email) === nrm(b.work_email)) n += 55;
  var pa = [a.mobile, a.office_phone].map(nPhone).filter(String), pb = [b.mobile, b.office_phone].map(nPhone).filter(String);
  if (pa.some(function (x) { return pb.indexOf(x) >= 0; })) n += 45;
  if (a.linkedin && nUrl(a.linkedin) === nUrl(b.linkedin)) n += 50;
  if (nrm(a.first_name) && nrm(a.last_name) && nrm(a.first_name) === nrm(b.first_name) && nrm(a.last_name) === nrm(b.last_name)) n += 25;
  if (nrm(a.agency) && nrm(a.agency) === nrm(b.agency)) n += 20;
  if (nrm(a.city) && nrm(a.city) === nrm(b.city) && nrm(a.state) === nrm(b.state)) n += 10;
  return n;
}
function dupRows(fresh, old) {
  return GRID_F.concat(['badge_code', 'tags']).map(function (k) {
    var e = k === 'tags' ? (old.tags || []).join(', ') : String(old[k] == null ? '' : old[k]);
    var f = k === 'tags' ? (fresh.tags || []).join(', ') : String(fresh[k] == null ? '' : fresh[k]);
    return { key: k, label: F_LABEL[k], existing: e, fresh: f, ticked: !e.trim() };
  }).filter(function (r) { return r.fresh.trim() && nrm(r.fresh) !== nrm(r.existing); });
}
$('cfSave').addEventListener('click', function () { trySave(false); });
function trySave(asNew) {
  var o = formValues(); cMsg('');
  if (!cf.editing && !asNew) {
    var best = cards.list.map(function (c) { return [c, dupScore(o, c)]; }).filter(function (x) { return x[1] >= 35; })
      .sort(function (a, b) { return b[1] - a[1]; })[0];
    if (best) { showDup(best[0], o); return; }
  }
  saveCard(o, cf.editing);
}
function saveShares(c, o) {
  var shareList = $('cf_share').value.split(/[,;\s]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return /@/.test(s); });
  return sb.from('ts_contact_shares').delete().eq('contact_id', c.id).then(function () {
    if (o.visibility === 'selected' && shareList.length)
      return sb.from('ts_contact_shares').insert(shareList.map(function (e) { return { contact_id: c.id, email: e }; }));
  });
}
function saveCard(o, existing) {
  cfBusy('Saving…');
  var p = existing
    ? sb.from('ts_contacts').update(o).eq('id', existing.id).select().single()
    : sb.from('ts_contacts').insert(Object.assign({ created_by_email: cMe() }, o)).select().single();
  var withPic = false;
  p.then(function (r) {
    if (r.error) throw r.error;
    var c = r.data, jobs = [];
    if (c.created_by_email === cMe()) {
      jobs.push(saveShares(c, o));
      if (cf.image && !existing) { withPic = true; jobs.push(sb.from('ts_card_images').insert({ contact_id: c.id, image: cf.image, created_by: cMe() })); }
    }
    return Promise.all(jobs).then(function () { return c; });
  }).then(function (c) {
    cfBusy(''); readFinish(c);
    showSaved(existing ? 'Card updated.' : withPic ? 'Card saved, with its picture.' : 'Card saved.', c);
    loadCards();
  }).catch(function (e) { cfBusy(''); cMsg('The card could not be saved. ' + (e.message || e)); });
}
function showSaved(msg, c) {
  cf.saved = true; cf.image = null;
  $('cfSavedMsg').textContent = msg;
  var line2 = [c.title, c.agency].filter(Boolean).join(' · '), line3 = [c.work_email, c.mobile || c.office_phone].filter(Boolean).join(' · ');
  $('cfSavedSummary').innerHTML = '<div class="strong">' + esc(cName(c) === '(no name)' ? (c.agency || '') : cName(c)) + '</div>' +
    (line2 ? '<div class="small muted">' + esc(line2) + '</div>' : '') + (line3 ? '<div class="small muted">' + esc(line3) + '</div>' : '');
  $('cfTitle').textContent = cf.editing ? 'Edit Card' : 'Add Card';
  $('cfCancel').textContent = 'Back to Previous Page';
  cfShow('saved'); $('cardForm').scrollTop = 0;
}
$('cfAnother').addEventListener('click', function () { openCardForm(null); });
$('cfSavedBack').addEventListener('click', closeCardForm);
// Possible duplicate: side by side, like the Conference Tracker.
function showDup(c, o) {
  cf.dupOf = c; cf.dupNew = o;
  var rows = cf.dupRows = dupRows(o, c);
  $('cfDupName').textContent = cName(c) === '(no name)' ? (c.agency || '') : cName(c);
  $('cfDupAgency').textContent = c.agency ? ', ' + c.agency : '';
  $('cfDupTable').innerHTML = rows.length ? '<table><thead><tr><th>Field</th><th>Existing</th><th>New card</th><th>Update</th></tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr><td class="strong">' + esc(r.label) + '</td><td class="muted">' + (r.existing ? esc(r.existing) : '<em>empty</em>') + '</td><td>' + esc(r.fresh) +
        '</td><td><input type="checkbox" data-f="' + r.key + '"' + (r.ticked ? ' checked' : '') + '></td></tr>';
    }).join('') + '</tbody></table>' : '<p class="small muted">The new card has nothing that differs from the existing card.</p>';
  $('cfDupAll').hidden = !rows.length; $('cfDupUpdate').hidden = !rows.length; $('cfDupMsg').textContent = '';
  dupTickState(); cfShow('dup'); $('cardForm').scrollTop = 0;
}
function dupTickState() { $('cfDupUpdate').disabled = !$('cfDupTable').querySelector('input[data-f]:checked'); }
$('cfDupTable').addEventListener('change', dupTickState);
function dupApply(all) {
  var c = cf.dupOf, upd = {};
  cf.dupRows.forEach(function (r) {
    var box = $('cfDupTable').querySelector('input[data-f="' + r.key + '"]');
    if (all || (box && box.checked)) upd[r.key] = r.key === 'tags' ? cf.dupNew.tags : cf.dupNew[r.key];
  });
  $('cfDupAll').disabled = $('cfDupUpdate').disabled = true;
  sb.from('ts_contacts').update(upd).eq('id', c.id).select().single().then(function (r) {
    $('cfDupAll').disabled = false; dupTickState();
    if (r.error) { $('cfDupMsg').textContent = 'The card could not be saved.'; return; }
    readFinish(r.data); showSaved('Existing card updated.', r.data); loadCards();
  });
}
$('cfDupAll').addEventListener('click', function () { dupApply(true); });
$('cfDupUpdate').addEventListener('click', function () { dupApply(false); });
$('cfDupUse').addEventListener('click', function () { openCardForm(cf.dupOf); });
$('cfDupNew').addEventListener('click', function () { cfShow('main'); trySave(true); });
$('cfDupBack').addEventListener('click', function () { cfShow('main'); });
$('cfDelete').addEventListener('click', function () {
  var c = cf.editing; if (!c) return;
  if (!$('cfDelete').dataset.armed) { $('cfDelete').dataset.armed = '1'; $('cfDelete').textContent = 'Tap again to delete'; return; }
  delete $('cfDelete').dataset.armed; $('cfDelete').textContent = 'Delete';
  sb.from('ts_contacts').delete().eq('id', c.id).then(function (r) {
    if (r.error) { cMsg('Not deleted: ' + r.error.message); return; }
    closeCardForm(); loadCards();
  });
});
$('cfViewImg').addEventListener('click', function () {
  var c = cf.editing; if (!c) return;
  sb.from('ts_card_images').select('image').eq('contact_id', c.id).maybeSingle().then(function (r) {
    if (r.error || !r.data) { cMsg('No card picture (it is removed once the saver exports the card).'); return; }
    $('cfImg').src = r.data.image; $('cfImg').hidden = false;
  });
});

// ---- reading-quality record (admin only to read; like the Conference Tracker's card_reads) ----
function readStart(source, text, filled) {
  var f = {}; Object.keys(filled || {}).forEach(function (k) { if (filled[k] != null && String(filled[k]).trim()) f[k] = filled[k]; });
  sb.rpc('ts_add_card_read', { p_source: source, p_text: String(text || '').slice(0, 8000), p_filled: f }).then(function (r) {
    if (!r.error && r.data != null) cf.reads.push(r.data);
  }, function () { /* never blocks the card */ });
}
function readFinish(c) {
  var ids = cf.reads; cf.reads = []; if (!ids.length || !c) return;
  var saved = {}; CF.concat(['reason']).forEach(function (k) { var v = c[k]; if (v != null && String(v).trim()) saved[k] = v; });
  if (c.tags && c.tags.length) saved.tags = c.tags.join(', ');
  ids.forEach(function (id) { sb.rpc('ts_finish_card_read', { p_id: id, p_saved: saved, p_contact_id: c.id }).then(function () { }, function () { }); });
}

// ---- reading text into fields (the Conference Tracker's reader, same rules) ----
var US_ST = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
var RX_EMAIL = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, RX_WEB = /(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9.-]+\.(?:com|org|net|gov|us|edu|info|biz|io|co)(?:\/[^\s,;]*)?/gi,
  RX_PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d+)?/gi;
function toUrl(e) { var t = e.trim().replace(/[.,;)]+$/, '').replace(/^https?:\/\//i, ''); return 'https://' + (/^www\./i.test(t) || /linkedin\.com/i.test(t) ? t : 'www.' + t); }
var AG_STRONG = ["sheriff's office", 'sheriffs office', 'sheriff’s office', 'police department', 'police dept', 'county', 'parish', 'city of', 'town of', 'village of', 'e911', 'communications district', 'university', 'college', 'inc', 'llc', 'corporation', 'authority', 'commission', 'association'],
  AG_WEAK = ['911', 'department', 'office', 'services', 'communications', 'state', 'agency', 'company', 'group', 'solutions', 'district', 'corp', 'police'],
  DEPT_W = ['division', 'unit', 'bureau', 'section', 'investigations', 'information technology', 'emergency communications', 'operations', 'patrol', 'records division'],
  TITLE_W = ['sheriff', 'chief', 'captain', 'lieutenant', 'sergeant', 'deputy', 'officer', 'director', 'manager', 'coordinator', 'supervisor', 'president', 'administrator', 'analyst', 'specialist', 'commander', 'major', 'colonel', 'detective', 'investigator', 'dispatcher', 'telecommunicator', 'owner', 'engineer', 'consultant', 'ceo', 'cfo', 'cto', 'technician', 'superintendent', 'clerk', 'marshal', 'trooper', 'agent', 'commissioner', 'executive', 'representative', 'liaison', 'assistant', 'planner', 'chair'];
function hasW(e, t) { return new RegExp('(^|[^a-z])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?([^a-z]|$)', 'i').test(e); }
function agScore(e) { return AG_STRONG.reduce(function (t, n) { return t + (hasW(e, n) ? 2 : 0); }, 0) + AG_WEAK.reduce(function (t, n) { return t + (hasW(e, n) ? 1 : 0); }, 0); }
function tiScore(e) { return TITLE_W.reduce(function (t, n) { return t + (hasW(e, n) ? 2 : 0); }, 0) + (/^(it|sales)\b/i.test(e) ? 1 : 0); }
function deScore(e) { return DEPT_W.reduce(function (t, n) { return t + (hasW(e, n) ? 2 : 0); }, 0); }
function capWord(e) { return /^[A-Z][A-Z'’.-]+$/.test(e) && e.length > 1 ? e.toLowerCase().replace(/(^|['’-])([a-z])/g, function (t, n, s) { return n + s.toUpperCase(); }) : e; }
function fixOcr(e) {
  var t = '(com|org|net|gov|us|edu|info|biz|io|co)';
  return e.replace(/([\w.+-])\s*@\s*([\w-]+\.)/g, '$1@$2').replace(/\.(c0m|g0v|0rg|n3t)\b/gi, function (n) { return n.replace(/0/g, 'o').replace(/3/g, 'e'); })
    .replace(new RegExp('([\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)*)[ ,]+' + t + '\\b', 'gi'), '$1.$2')
    .replace(new RegExp('\\b(www)\\.?[ ,]+([a-z0-9-]+)\\.?[ ,]+' + t + '\\b', 'gi'), '$1.$2.$3')
    .replace(new RegExp('\\b(www)[ ,]+([a-z0-9-]+(?:\\.[a-z0-9-]+)*)[ ,]+' + t + '\\b', 'gi'), '$1.$2.$3')
    .replace(/\b(www)[ ,]+([a-z0-9-]+\.[a-z]{2,})/gi, '$1.$2');
}
// Returns { fields, conf } with conf 'High' (read) or 'Check' (check this). Field names here use mobile_phone like the Conference Tracker.
function parseCardText(text, big) {
  big = big || [];
  var n = fixOcr(String(text || '').replace(/\r/g, '')), s = n.split('\n').map(function (P) { return P.trim(); }).filter(Boolean), r = {}, a = {};
  var o = function (P, B, ne) { if (B && !r[P]) { r[P] = B; a[P] = ne; } };
  var l = n.match(RX_EMAIL) || [];
  if (l[0]) o('work_email', l[0].toLowerCase().replace(/^[^a-z0-9]+/, ''), 'High');
  (n.match(RX_WEB) || []).forEach(function (P) {
    if (l.some(function (ne) { return ne.toLowerCase().indexOf(P.toLowerCase().replace(/^https?:\/\//, '')) >= 0; })) return;
    var B = toUrl(P); if (/linkedin\.com/i.test(B)) o('linkedin', B, 'High'); else o('website', B, 'High');
  });
  s.forEach(function (P) {
    (P.match(RX_PHONE) || []).forEach(function (B) {
      var ie = (P.slice(0, P.indexOf(B)).toLowerCase().match(/([a-z]+)\s*[:.]?\s*$/) || [])[1] || '', le = P.slice(P.indexOf(B) + B.length).toLowerCase(), I = 'office';
      if (/^(f|fax)$/.test(ie) || /^\s*\(?fax\)?/.test(le)) I = 'fax'; else if (/^(c|m|cell|mobile|cellular)$/.test(ie) || /^\s*\(?(cell|mobile)\)?/.test(le)) I = 'mobile';
      var ext = (B.match(/(?:x|ext\.?|extension)\s*(\d+)/i) || [])[1] || '', te = B.replace(/\s*(?:x|ext\.?|extension)\s*\d+/i, '').trim();
      if (I === 'mobile') o('mobile_phone', te, 'High');
      else if (I === 'office') {
        if (r.office_phone && !ie && r.office_phone.replace(/\D/g, '') !== te.replace(/\D/g, '')) o('mobile_phone', te, 'Check');
        else { o('office_phone', te, 'High'); if (ext) o('office_ext', ext, 'High'); }
      }
    });
  });
  if (!r.office_phone || !r.mobile_phone) s.forEach(function (P) {
    var B = P.match(/\(?\d{3}\)?[\s.-]?\d{4}[\s.-]\d{4}\b/); if (!B) return;
    var ne = (P.slice(0, P.indexOf(B[0])).toLowerCase().match(/([a-z]+)\s*[:.]?\s*$/) || [])[1] || '';
    if (/^(c|m|cell|mobile)$/.test(ne)) o('mobile_phone', B[0], 'Check'); else if (!/^(f|fax)$/.test(ne)) o('office_phone', B[0], 'Check');
  });
  var c = function (P) { return /@/.test(P) || new RegExp(RX_PHONE.source, 'i').test(P) || /(www\.|https?:\/\/|\.(com|gov|org|net|us)\b)/i.test(P); };
  var d = s.filter(c).map(function (P) { return P.split(/\s+(?:office|cell|mobile|phone|direct|main|fax|tel|[pcmfeot]\s*:|\(?\d{3}\)?[\s.-]\d{3})/i)[0].trim(); })
    .filter(function (P) { return P && !c(P) && /^[A-Z]/.test(P); });
  var u = s.filter(function (P) { return !c(P); }).concat(d).map(function (P) { return P.replace(/^[A-Z]\s*:\s*/, ''); });
  var h = /^\d+\s+.*\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pkwy|parkway|hwy|highway|pl|place|suite|ste)\b\.?/i,
    m = /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pkwy|parkway|hwy|highway|pl|place|suite|ste|west|east|north|south)\b\.?,?\s*/gi;
  var f = { alabama: 'AL', arkansas: 'AR', florida: 'FL', georgia: 'GA', kentucky: 'KY', louisiana: 'LA', mississippi: 'MS', 'north carolina': 'NC', 'south carolina': 'SC', tennessee: 'TN', texas: 'TX', virginia: 'VA', 'west virginia': 'WV', oklahoma: 'OK', missouri: 'MO', maryland: 'MD', ohio: 'OH', indiana: 'IN', illinois: 'IL', arizona: 'AZ', california: 'CA', colorado: 'CO', nevada: 'NV', 'new mexico': 'NM', pennsylvania: 'PA', 'new york': 'NY', 'new jersey': 'NJ', delaware: 'DE', michigan: 'MI' };
  var y = Object.keys(f).sort(function (P, B) { return B.length - P.length; }).join('|');
  var w = s.slice().sort(function (P, B) { return Number(/\d{5}/.test(B)) - Number(/\d{5}/.test(P)); });
  for (var wi = 0; wi < w.length; wi++) {
    var B = w[wi].replace(new RegExp('\\b(' + y + ')\\b(?=\\s*\\d{5}|\\s*$)', 'i'), function (ie) { return f[ie.toLowerCase()]; });
    var ne = B.match(/([A-Za-z .'-]+?),\s*([A-Z]{2})\b\.?(?:\s*(\d{5}(?:-\d{4})?))?/) || B.match(/([A-Za-z .'-]+?)\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/);
    if (ne && US_ST.indexOf(ne[2]) >= 0 && agScore(ne[1]) < 2) {
      var ie = ne[1].replace(/^.*\d+\s+/, ''), le = ie.split(m); ie = le[le.length - 1] || ie;
      o('city', ie.replace(/^[,\s]+/, '').trim(), 'Check'); o('state', ne[2], 'High'); break;
    }
  }
  var S = u.filter(function (P) { return !h.test(P) && !/^p\.?\s*o\.?\s*box/i.test(P) && (!/,\s*[A-Z]{2}\b/.test(P) || agScore(P) >= 2 && !/\d{5}/.test(P)) && /^[A-Z0-9]/.test(P); });
  var p = S.map(function (P) { return { l: P, a: agScore(P), t: tiScore(P), d: deScore(P) }; });
  var g = (p.filter(function (P) { return P.a >= 2 && P.a > P.t && P.d === 0; }).sort(function (P, B) { return B.a - P.a; })[0] || {}).l ||
    (p.filter(function (P) { return P.a >= 1 && P.t === 0 && P.d === 0; }).sort(function (P, B) { return B.a - P.a; })[0] || {}).l;
  var v = (p.filter(function (P) { return P.l !== g && P.t > 0 && P.t >= P.a; })[0] || {}).l;
  var k = (p.filter(function (P) { return P.l !== g && P.l !== v && P.d > 0; })[0] || {}).l;
  var T = /^([A-Z][A-Za-z'’.-]*)(\s+[A-Z][A-Za-z'’.-]*){1,3}(,?\s+[A-Z][A-Za-z.]{1,6})?$/, used = [g, v, k];
  var N = S.filter(function (P) { return used.indexOf(P) < 0 && T.test(P.replace(/,\s*[A-Za-z.]+$/, '').trim()) && agScore(P) === 0 && tiScore(P) === 0 && deScore(P) === 0; });
  var L = (r.work_email || '').split('@')[0].replace(/[^a-z]/g, '');
  var Y = function (P) { var Bq = P.toLowerCase().replace(/[^a-z]/g, ''); return !!L && Bq.length >= 3 && L.indexOf(Bq) >= 0; };
  var W = function (P) { return P.replace(/,.*$/, '').split(/\s+/).slice(1).some(Y); };
  var H = N.filter(W)[0] || N.filter(function (P) { return big.some(function (Bq) { return Bq.trim() === P; }); })[0] || N[0];
  if (H) {
    var Pn = H.replace(/,.*$/, '').split(/\s+/).filter(function (x) { return /^[A-Z]/.test(x) && !/^(mr|mrs|ms|dr|rev)\.?$/i.test(x); }).map(capWord);
    var conf = W(H) ? 'High' : 'Check', ni = -1;
    Pn.forEach(function (x, i) { if (ni < 0 && i > 0 && Y(x)) ni = i; });
    if (Pn.length >= 2) { o('first_name', Pn[0], conf); o('last_name', Pn[ni > 0 ? ni : Pn.length - 1], conf); }
    else if (Pn.length === 1) o('last_name', Pn[0], 'Check');
  }
  if (!r.last_name && /^[a-z]{4,}$/.test(L)) {
    var cl = function (I) { return I.replace(/[^A-Za-z'’-]/g, ''); };
    var Bw = [].concat.apply([], u.map(function (I) { return I.split(/\s+/); })).map(cl).filter(function (I) { return I.length >= 2; });
    var nw = Bw.filter(function (I) { return I.length >= 3 && L.slice(-I.toLowerCase().replace(/[^a-z]/g, '').length) === I.toLowerCase().replace(/[^a-z]/g, '') && L.length - I.replace(/[^A-Za-z]/g, '').length <= 2; })[0];
    var lastN = nw ? capWord(nw) : L.slice(1, 2).toUpperCase() + L.slice(2);
    o('last_name', lastN, 'Check');
    var fw = Bw.filter(function (I) { return /^[A-Z][a-z]{1,}$/.test(I) && I[0].toLowerCase() === L[0] && used.indexOf(I) < 0 && I !== lastN && agScore(I) === 0 && tiScore(I) === 0; })[0];
    if (fw) o('first_name', fw, 'Check');
  }
  if (v) o('title', v, 'Check');
  var small = ['of', 'and', 'the', 'for', 'at', 'in', 'on'];
  if (g) o('agency', (function (P) {
    return /[a-z]/.test(P) ? P : P.toLowerCase().split(' ').map(function (Bq, ni2) { return ni2 > 0 && small.indexOf(Bq) >= 0 ? Bq : Bq.replace(/(^|['’-])([a-z])/g, function (x, le2, I) { return le2 + I.toUpperCase(); }); }).join(' ');
  })(g.replace(/,\s*[A-Z]{2}\.?$/, '')), 'Check');
  if (k) o('department', k, 'Check');
  if (r.work_email && r.first_name && r.last_name) {
    var parts = r.work_email.split('@'), ln = r.last_name.toLowerCase().replace(/[^a-z]/g, '');
    if (parts[0].length === ln.length + 1 && parts[0].slice(1) === ln && /[il1|]/.test(parts[0][0])) r.work_email = r.first_name[0].toLowerCase() + ln + '@' + parts[1];
  }
  if (!r.website && r.work_email) {
    var dom = r.work_email.split('@')[1] || '';
    if (dom && !/(gmail|yahoo|outlook|hotmail|aol|icloud)\./i.test(dom)) o('website', toUrl(dom), 'Check');
  }
  return { fields: r, conf: a };
}
// QR / badge text: vCard, MeCard, a link, or a plain code (kept in Badge / code).
function parseCode(e) {
  var t = String(e || '').trim(), n = {}, s = {}, r = function (k, v) { var l = String(v || '').trim(); if (l && !n[k]) { n[k] = l; s[k] = 'High'; } };
  if (/^BEGIN:VCARD/i.test(t)) {
    t.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':'); if (i < 0) return;
      var key = line.slice(0, i).toUpperCase(), d = line.slice(i + 1).replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' '), u = key.split(';')[0], x;
      if (u === 'N') { x = d.split(';'); r('last_name', x[0]); r('first_name', x[1]); }
      else if (u === 'FN' && !n.last_name) { x = d.split(/\s+/); if (x.length > 1) { r('first_name', x[0]); r('last_name', x[x.length - 1]); } else r('last_name', d); }
      else if (u === 'TITLE') r('title', d);
      else if (u === 'ORG') { x = d.split(';'); r('agency', x[0]); r('department', x[1]); }
      else if (u === 'EMAIL') r('work_email', d.toLowerCase());
      else if (u === 'TEL') { if (/CELL|MOBILE/.test(key)) r('mobile_phone', d); else if (!/FAX/.test(key)) r('office_phone', d); }
      else if (u === 'URL') { if (/linkedin\.com/i.test(d)) r('linkedin', toUrl(d)); else r('website', toUrl(d)); }
      else if (u === 'ADR') { x = d.split(';'); r('city', x[3]); r('state', (x[4] || '').toUpperCase().slice(0, 2)); }
    });
    return { fields: n, conf: s, kind: 'contact' };
  }
  if (/^MECARD:/i.test(t)) {
    t.slice(7).split(/(?<!\\);/).forEach(function (p) {
      var i = p.indexOf(':'); if (i < 0) return;
      var key = p.slice(0, i).toUpperCase(), v = p.slice(i + 1).replace(/\\(.)/g, '$1'), x;
      if (key === 'N') { x = v.split(','); r('last_name', x[0]); r('first_name', x[1]); }
      else if (key === 'ORG') r('agency', v); else if (key === 'TITLE') r('title', v); else if (key === 'TEL') r('office_phone', v);
      else if (key === 'EMAIL') r('work_email', v.toLowerCase()); else if (key === 'URL') r('website', toUrl(v));
    });
    return { fields: n, conf: s, kind: 'contact' };
  }
  if (/^https?:\/\//i.test(t) && !/\s/.test(t)) { if (/linkedin\.com/i.test(t)) r('linkedin', t); else r('website', t); return { fields: n, conf: s, kind: 'link' }; }
  r('badge_code', t.slice(0, 500)); return { fields: n, conf: s, kind: 'code' };
}
function toOurs(p) {
  var f = {}, m = {};
  Object.keys(p.fields).forEach(function (k) { var o = k === 'mobile_phone' ? 'mobile' : k; f[o] = p.fields[k]; m[o] = p.conf[k] === 'High' ? 'read' : 'check'; });
  return { fields: f, marks: m };
}
// Fill only empty fields; mark each "read" or "check this"; then show only the filled fields.
function applyParsed(p) {
  var q = toOurs(p), any = false;
  Object.keys(q.fields).forEach(function (k) {
    var el = $('cf_' + k); if (!el || !q.fields[k]) return;
    any = true;
    if (!el.value.trim()) { el.value = q.fields[k]; setMark(k, q.marks[k]); }
  });
  if (any) cf.hideBlank = true;
  cfFieldView(); cfButtons();
  return q;
}
function cfBusy(t) { $('cfBusy').textContent = t || ''; $('cfBusy').hidden = !t; $('cfReadBtn').disabled = $('cfScanBtn').disabled = !!t; }
$('cfText').addEventListener('input', cfButtons);
$('cfFillBtn').addEventListener('click', function () {
  var t = $('cfText').value; if (!t.trim()) return;
  var p = parseCardText(t); applyParsed(p); readStart('text', t, toOurs(p).fields);
});
function readDone(res) {
  $('cfText').value = ($('cfText').value ? $('cfText').value + '\n' : '') + res.text;
  var p = parseCardText(res.all, res.big); applyParsed(p); readStart('card', res.all, toOurs(p).fields);
}

// ---- pictures: find the card, clean it up, read it twice (same as the Conference Tracker) ----
function fileToCanvas(file, maxW) {
  maxW = maxW || 1600;
  return new Promise(function (ok, bad) {
    var url = URL.createObjectURL(file), im = new Image();
    im.onload = function () {
      var r = Math.min(1, maxW / im.naturalWidth), c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * r); c.height = Math.round(im.naturalHeight * r);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url); ok(c);
    };
    im.onerror = function () { URL.revokeObjectURL(url); bad(new Error('unreadable picture')); };
    im.src = url;
  });
}
function findCard(e, t, n) { // bright, low-colour area
  var s = new Uint8Array(t * n), c, d, u;
  for (c = 0; c < t * n; c++) { var R = e[c * 4], G = e[c * 4 + 1], B = e[c * 4 + 2], lum = .299 * R + .587 * G + .114 * B, sat = Math.max(R, G, B) - Math.min(R, G, B); s[c] = lum > 170 && sat < 40 ? 1 : 0; }
  var r = -1, a = -1;
  for (c = 0; c < n; c++) { d = 0; for (u = 0; u < t; u++) d += s[c * t + u]; if (d / t > .25) { if (r < 0) r = c; a = c; } }
  if (r < 0) return null;
  var o = -1, l = -1;
  for (c = 0; c < t; c++) { d = 0; for (u = r; u <= a; u++) d += s[u * t + c]; if (d / (a - r + 1) > .35) { if (o < 0) o = c; l = c; } }
  return o < 0 || (l - o) * (a - r) < .08 * t * n ? null : { x0: o, y0: r, x1: l, y1: a };
}
function cleanForOcr(e, target) { // grey, evens out shadow and glare, light-on-dark turned dark-on-light
  var sc = Math.max(.5, Math.min(2.5, target / Math.max(1, e.width))), r = document.createElement('canvas');
  r.width = Math.max(1, Math.round(e.width * sc)); r.height = Math.max(1, Math.round(e.height * sc));
  var a = r.getContext('2d', { willReadFrequently: true }); a.imageSmoothingEnabled = true; a.imageSmoothingQuality = 'high';
  a.drawImage(e, 0, 0, r.width, r.height); e.width = 0; e.height = 0;
  var o = r.width, l = r.height, img = a.getImageData(0, 0, o, l), d = img.data, u = new Float32Array(o * l), i, x, yy, X, Y;
  for (i = 0; i < o * l; i++) u[i] = .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2];
  var h = Math.max(8, Math.round(o / 40)), m = Math.ceil(o / h), f = Math.ceil(l / h), mx = new Float32Array(m * f), mn = new Float32Array(m * f), av = new Float32Array(m * f);
  for (yy = 0; yy < f; yy++) for (x = 0; x < m; x++) {
    var hi = 0, lo = 255, sum = 0, cnt = 0;
    for (Y = yy * h; Y < Math.min(l, (yy + 1) * h); Y += 2) for (X = x * h; X < Math.min(o, (x + 1) * h); X += 2) { var P = u[Y * o + X]; if (P > hi) hi = P; if (P < lo) lo = P; sum += P; cnt++; }
    mx[yy * m + x] = hi; mn[yy * m + x] = lo; av[yy * m + x] = cnt ? sum / cnt : 255;
  }
  var dark = new Uint8Array(m * f); for (i = 0; i < m * f; i++) dark[i] = av[i] < 105 ? 1 : 0;
  var bg = new Float32Array(m * f);
  for (yy = 0; yy < f; yy++) for (x = 0; x < m; x++) {
    var me2 = yy * m + x, L = dark[me2] ? 255 : 0;
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      var H = yy + dy, D = x + dx; if (H < 0 || D < 0 || H >= f || D >= m) continue;
      var V = H * m + D; if (dark[V] === dark[me2]) L = dark[me2] ? Math.min(L, mn[V]) : Math.max(L, mx[V]);
    }
    bg[me2] = L;
  }
  var lerp = function (arr, px, py) {
    var Yf = Math.min(m - 1, Math.max(0, px / h - .5)), Wf = Math.min(f - 1, Math.max(0, py / h - .5)), H0 = Math.floor(Yf), D0 = Math.floor(Wf),
      V1 = Math.min(m - 1, H0 + 1), P1 = Math.min(f - 1, D0 + 1), Bx = Yf - H0, ny = Wf - D0;
    return (arr[D0 * m + H0] * (1 - Bx) + arr[D0 * m + V1] * Bx) * (1 - ny) + (arr[P1 * m + H0] * (1 - Bx) + arr[P1 * m + V1] * Bx) * ny;
  };
  for (Y = 0; Y < l; Y++) for (X = 0; X < o; X++) {
    var k = Y * o + X, cx = Math.min(m - 1, Math.floor(X / h)), cy = Math.min(f - 1, Math.floor(Y / h)), Hb = lerp(bg, X, Y), val;
    if (dark[cy * m + cx]) { var Dd = 255 - Hb; val = Dd > 20 ? Math.min(255, (255 - u[k]) / Dd * 255) : 255; }
    else val = Hb > 20 ? Math.min(255, u[k] / Hb * 255) : u[k];
    d[k * 4] = d[k * 4 + 1] = d[k * 4 + 2] = val; d[k * 4 + 3] = 255;
  }
  a.putImageData(img, 0, 0); return r;
}
function ocrLines(res, minConf, gap) { // drop words under minConf; split lines with a wide gap; note the largest text
  gap = gap || 1.2;
  var lines = (res.data && res.data.lines) || [];
  if (!lines.length) return { text: (res.data && res.data.text) || '', big: [] };
  var ok = function (w) { return w.confidence >= minConf && /[A-Za-z0-9]/.test(w.text) && (w.text.length >= 2 || /\d/.test(w.text)); }, out = [];
  lines.forEach(function (ln) {
    var ws = (ln.words || []).filter(ok).sort(function (p, q) { return ((p.bbox && p.bbox.x0) || 0) - ((q.bbox && q.bbox.x0) || 0); });
    if (!ws.length) return;
    var hs = ws.map(function (w) { return w.bbox ? w.bbox.y1 - w.bbox.y0 : 0; }).sort(function (p, q) { return p - q; }), med = hs[Math.floor(hs.length / 2)] || 0, cur = [];
    var flush = function () { if (cur.length) out.push({ text: cur.map(function (w) { return w.text; }).join(' '), h: med }); cur = []; };
    ws.forEach(function (w, i) { var pw = ws[i - 1]; if (pw && pw.bbox && w.bbox && med && w.bbox.x0 - pw.bbox.x1 > gap * med) flush(); cur.push(w); });
    flush();
  });
  return { text: out.map(function (x) { return x.text; }).join('\n'), big: out.slice().sort(function (p, q) { return q.h - p.h; }).slice(0, 3).map(function (x) { return x.text; }) };
}
function readCanvas(cv) { // read twice: about 1800 and 1100 px wide
  return loadScript(TESS_URL).then(function () {
    var T = window.Tesseract; if (!T) throw new Error('reader not available');
    var copy = document.createElement('canvas'); copy.width = cv.width; copy.height = cv.height; copy.getContext('2d').drawImage(cv, 0, 0);
    var res = [], passes = [[cv, 1800], [copy, 1100]];
    return passes.reduce(function (pr, ps) {
      return pr.then(function () {
        var c = cleanForOcr(ps[0], ps[1]);
        return T.recognize(c, 'eng').then(function (r) { res.push(ocrLines(r, 40)); c.width = 0; c.height = 0; });
      });
    }, Promise.resolve()).then(function () {
      return { text: res[0].text || res[1].text, all: res.map(function (x) { return x.text; }).join('\n'), big: res[1].big.concat(res[0].big) };
    });
  });
}
function readPictureFile(file) { // picture route: find the card first
  return fileToCanvas(file, 2400).then(function (cv) {
    var b = findCard(cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
    if (!b) return readCanvas(cv);
    var c = document.createElement('canvas'); c.width = b.x1 - b.x0 + 1; c.height = b.y1 - b.y0 + 1;
    c.getContext('2d').drawImage(cv, b.x0, b.y0, c.width, c.height, 0, 0, c.width, c.height); cv.width = 0; cv.height = 0;
    return readCanvas(c);
  });
}
function smallPicture(src) { // kept with the card: long side 900 px, JPEG 0.6 (0.4 if over 400 KB)
  var draw = function (w, h, fn) {
    if (!w || !h) return null;
    var r = Math.min(1, 900 / Math.max(w, h)), c = document.createElement('canvas'); c.width = Math.round(w * r); c.height = Math.round(h * r);
    fn(c.getContext('2d'), c.width, c.height);
    var u = c.toDataURL('image/jpeg', .6); return u.length <= 4e5 ? u : c.toDataURL('image/jpeg', .4);
  };
  if (src instanceof HTMLCanvasElement) return Promise.resolve(draw(src.width, src.height, function (x, w, h) { x.drawImage(src, 0, 0, w, h); }));
  return new Promise(function (ok) {
    var url = URL.createObjectURL(src), im = new Image();
    im.onload = function () { ok(draw(im.naturalWidth, im.naturalHeight, function (x, w, h) { x.drawImage(im, 0, 0, w, h); })); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
    im.onerror = function () { ok(null); }; im.src = url;
  });
}
function keepPicture(p) { p.then(function (u) { if (u) { cf.image = u; $('cfPicKept').hidden = false; } }, function () { }); }
function readFromInput() {
  var input = this, file = input.files && input.files[0]; if (!file) return;
  cMsg(''); cfBusy('Reading the card on this device…');
  var pic = smallPicture(file);
  readPictureFile(file).then(function (res) { readDone(res); keepPicture(pic); })
    .catch(function () { cMsg('The card could not be read. Try again, or type it.'); })
    .then(function () { cfBusy(''); input.value = ''; });
}
$('cfReadFile').addEventListener('change', readFromInput);
$('cfSavedFile').addEventListener('change', readFromInput);
function readCaptured(canvas) {
  cMsg(''); cfBusy('Reading the card on this device…');
  var pic = smallPicture(canvas);
  pic.then(function () { return readCanvas(canvas); }).then(function (res) { readDone(res); keepPicture(pic); })
    .catch(function () { cMsg('The card could not be read. Try again, or type it.'); })
    .then(function () { cfBusy(''); });
}
// Scan Code: a picture of the QR code or badge, read with ZXing (try harder).
$('cfScanFile').addEventListener('change', function () {
  var file = this.files && this.files[0]; if (!file) return;
  cMsg(''); cfBusy('Reading the code on this device…');
  loadScript(ZXING_URL).then(function () {
    var Z = window.ZXing; if (!Z) throw new Error('reader not available');
    return fileToCanvas(file, 2000).then(function (cv) {
      var hints = new Map(); hints.set(Z.DecodeHintType.TRY_HARDER, true);
      var rd = new Z.MultiFormatReader(); rd.setHints(hints);
      return String(rd.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(cv)))).getText() || '');
    });
  }).then(function (txt) {
    var p = parseCode(txt); applyParsed(p); readStart('code', txt, toOurs(p).fields);
    if (p.kind === 'code') cMsg('The code holds no contact details; it was kept in Badge / code.', true);
  }).catch(function () { cMsg('No code was found in that picture. Try again closer and in good light.'); })
    .then(function () { cfBusy(''); $('cfScanFile').value = ''; });
});
$('cfScanBtn').addEventListener('click', function () { $('cfScanFile').click(); });

// ---- camera screen: card outline, auto-capture, green lock (same as the Conference Tracker) ----
var cam = { stream: null, timer: null, done: false, state: 'starting', holding: false };
function stopCam() {
  if (cam.timer) clearInterval(cam.timer); cam.timer = null;
  if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null;
  $('camBox').hidden = true;
}
function camHint() {
  $('camHint').textContent = cam.state === 'starting' ? 'Starting the camera…' : cam.state === 'ready'
    ? (cam.holding ? 'Hold still…' : 'Fill the outline with the card and hold still. It takes the picture by itself, or tap Capture.') : '';
  $('camOutline').classList.toggle('hold', cam.holding);
  $('camBox').toggleAttribute('data-holding', cam.holding);
  $('camFailed').hidden = cam.state !== 'failed'; $('camCapture').disabled = cam.state !== 'ready';
}
function hasLiveCamera() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
function startCam() {
  cam = { stream: null, timer: null, done: false, state: 'starting', holding: false };
  $('camBox').hidden = false; camHint();
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false }).then(function (s) {
    if (cam.done || $('camBox').hidden) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
    cam.stream = s;
    var tr = s.getVideoTracks()[0];
    try { var caps = (tr.getCapabilities && tr.getCapabilities()) || {}; if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () { }); } catch (e) { /* ignore */ }
    var v = $('camVideo'); v.srcObject = s;
    return v.play().catch(function () { }).then(function () { cam.state = 'ready'; camHint(); camWatch(); });
  }).catch(function () { cam.state = 'failed'; camHint(); });
}
function camRect() { // the outline, in video pixels (video fills the screen, cropped)
  var v = $('camVideo'), o = $('camOutline'); if (!v.videoWidth) return null;
  var S = v.getBoundingClientRect(), p = o.getBoundingClientRect(), g = Math.max(S.width / v.videoWidth, S.height / v.videoHeight),
    ox = (S.width - v.videoWidth * g) / 2, oy = (S.height - v.videoHeight * g) / 2;
  return { v: v, x: (p.left - S.left - ox) / g, y: (p.top - S.top - oy) / g, w: p.width / g, h: p.height / g };
}
function camCapture() {
  if (cam.done) return;
  var R = camRect(); if (!R) return;
  var v = R.v, x = Math.max(0, R.x), y = Math.max(0, R.y), w = Math.min(v.videoWidth - x, R.w), h = Math.min(v.videoHeight - y, R.h);
  var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  c.getContext('2d').drawImage(v, x, y, w, h, 0, 0, c.width, c.height);
  cam.done = true; stopCam(); readCaptured(c);
}
function edgeSides(g, W, H, ox, oy, ow, oh) { // how many outline sides show a card edge
  var px = function (x, y) { return g[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]; };
  var side = function (horiz, pos, len, start, span) {
    var a = Math.round(pos - .15 * span), b = Math.round(pos + .15 * span), s0 = Math.round(start + .15 * len), s1 = Math.round(start + .85 * len), best = 0;
    for (var q = Math.max(1, a); q <= Math.min((horiz ? H : W) - 2, b); q++) {
      var hits = 0;
      for (var t = s0; t < s1; t++) { var dlt = horiz ? px(t, q + 1) - px(t, q - 1) : px(q + 1, t) - px(q - 1, t); if (Math.abs(dlt) > 24) hits++; }
      best = Math.max(best, hits / Math.max(1, s1 - s0));
    }
    return best >= .55 ? 1 : 0;
  };
  return side(true, oy, ow, ox, oh) + side(true, oy + oh, ow, ox, oh) + side(false, ox, oh, oy, ow) + side(false, ox + ow, oh, oy, ow);
}
function frameDiff(a, b) { if (a.length !== b.length || !a.length) return 255; var n = 0; for (var i = 0; i < a.length; i += 2) n += Math.abs(a[i] - b[i]); return n / Math.ceil(a.length / 2); }
function camWatch() {
  var cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true }), last = null, holdSince = 0, misses = 0, startAt = Date.now();
  cam.timer = setInterval(function () {
    if (cam.done) return;
    var T = camRect(); if (!T || !T.v.videoWidth) return;
    var mx = T.w * .2, my = T.h * .2, L = Math.max(0, T.x - mx), Y = Math.max(0, T.y - my), Wd = Math.min(T.v.videoWidth, T.x + T.w + mx), Hd = Math.min(T.v.videoHeight, T.y + T.h + my);
    var sc = 200 / Math.max(1, Wd - L), V = 200, P = Math.max(10, Math.round((Hd - Y) * sc));
    cv.width = V; cv.height = P; ctx.drawImage(T.v, L, Y, Wd - L, Hd - Y, 0, 0, V, P);
    var B = ctx.getImageData(0, 0, V, P).data, g = new Uint8Array(V * P);
    for (var i = 0; i < g.length; i++) g[i] = B[i * 4] * 77 + B[i * 4 + 1] * 150 + B[i * 4 + 2] * 29 >> 8;
    var still = last ? frameDiff(last, g) <= 11 : false; last = g;
    if (!(edgeSides(g, V, P, (T.x - L) * sc, (T.y - Y) * sc, T.w * sc, T.h * sc) >= 3 && still && Date.now() - startAt > 600)) {
      misses++;
      if (!holdSince || misses > 2) { holdSince = 0; misses = 0; if (cam.holding) { cam.holding = false; camHint(); } }
      return;
    }
    misses = 0;
    if (!holdSince) { holdSince = Date.now(); cam.holding = true; camHint(); return; }
    if (Date.now() - holdSince >= 1000) camCapture();
  }, 120);
}
$('camCapture').addEventListener('click', camCapture);
$('camClose').addEventListener('click', function () { cam.done = true; stopCam(); });
$('camPicker').addEventListener('click', function () { cam.done = true; stopCam(); $('cfReadFile').click(); });
function useSavedPhoto() { cam.done = true; stopCam(); $('cfSavedFile').click(); }
$('camSaved').addEventListener('click', useSavedPhoto);
$('camSaved2').addEventListener('click', useSavedPhoto);
$('cfReadBtn').addEventListener('click', function () { cMsg(''); if (hasLiveCamera()) startCam(); else $('cfReadFile').click(); });

// ---- export: only new or changed cards; recorded per person ----
function vEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
function toVcf(list) {
  return list.map(function (c) {
    var L = ['BEGIN:VCARD', 'VERSION:3.0', 'N:' + vEsc(c.last_name) + ';' + vEsc(c.first_name) + ';;;', 'FN:' + vEsc(cName(c))];
    if (c.agency || c.department) L.push('ORG:' + vEsc(c.agency) + (c.department ? ';' + vEsc(c.department) : ''));
    if (c.title) L.push('TITLE:' + vEsc(c.title));
    if (c.work_email) L.push('EMAIL;TYPE=WORK:' + c.work_email);
    if (c.mobile) L.push('TEL;TYPE=CELL:' + c.mobile);
    if (c.office_phone) L.push('TEL;TYPE=WORK:' + c.office_phone + (c.office_ext ? ' x' + c.office_ext : ''));
    if (c.city || c.state) L.push('ADR;TYPE=WORK:;;;' + vEsc(c.city) + ';' + vEsc(c.state) + ';;');
    if (c.website) L.push('URL:' + c.website);
    if (c.linkedin) L.push('URL;TYPE=LinkedIn:' + c.linkedin);
    L.push('NOTE:' + vEsc(['Reason: ' + c.reason, c.date_met ? 'Met: ' + c.date_met : '', (c.tags || []).length ? 'Tags: ' + c.tags.join(', ') : '', c.badge_code ? 'Badge: ' + c.badge_code : '', c.notes || ''].filter(String).join('. ')));
    L.push('END:VCARD'); return L.join('\r\n');
  }).join('\r\n') + '\r\n';
}
var CSV_COLS = [['First Name', 'first_name'], ['Last Name', 'last_name'], ['Title', 'title'], ['Agency', 'agency'], ['Department', 'department'], ['Email', 'work_email'],
  ['Mobile', 'mobile'], ['Office Phone', 'office_phone'], ['Ext', 'office_ext'], ['City', 'city'], ['State', 'state'], ['Website', 'website'], ['LinkedIn', 'linkedin'],
  ['Badge Code', 'badge_code'], ['Date Met', 'date_met'], ['Reason', 'reason'], ['Tags', 'tags'], ['Notes', 'notes'], ['Saved By', 'created_by_email'], ['Saved At', 'created_at']];
function toCsv(list) {
  var q = function (v) { v = Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [CSV_COLS.map(function (c) { return c[0]; }).join(',')].concat(list.map(function (c) { return CSV_COLS.map(function (k) { return q(c[k[1]]); }).join(','); })).join('\r\n') + '\r\n';
}
function download(name, text, type) {
  var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportNew(kind) {
  var list = cards.list.filter(cIsNew);
  if (!list.length) { $('cSummary').textContent = 'Nothing new to export.'; return; }
  var stamp = todayIso();
  if (kind === 'vcf') download('Training_Cards_' + stamp + '.vcf', toVcf(list), 'text/vcard');
  else download('Training_Cards_' + stamp + '.csv', toCsv(list), 'text/csv');
  var now = new Date().toISOString();
  sb.from('ts_contact_exports').upsert(list.map(function (c) { return { user_id: me.id, contact_id: c.id, exported_at: now }; })).then(function (r) {
    if (r.error) { $('cSummary').textContent = 'File made, but the export was not recorded: ' + r.error.message; return; }
    loadCards();
  });
}
$('cExpVcf').addEventListener('click', function () { exportNew('vcf'); });
$('cExpCsv').addEventListener('click', function () { exportNew('csv'); });
$('cBackup').addEventListener('click', function () { download('Training_Cards_Backup_' + todayIso() + '.csv', toCsv(cards.list), 'text/csv'); });

// ---- start tiles: once per browser session after sign-in (also when arriving by Switch App) ----
var START_KEY = 'ts-start-picked';
function maybeStartTiles() {
  var picked = null; try { picked = sessionStorage.getItem(START_KEY); } catch (e) { picked = '1'; }
  if (!picked) $('startTiles').hidden = false;
}
function pickStart(v) {
  try { sessionStorage.setItem(START_KEY, v); } catch (e) { /* ignore */ }
  $('startTiles').hidden = true;
  if (v === 'cards') { var b = document.querySelector('.tab[data-view="cards"]'); if (b) b.click(); }
}
// Help pictures for the Card Reader load only when Help is opened (help-cards.js).
function loadHelpPictures() {
  if (window.TS_HELP_IMG) return fillHelpPictures();
  loadScript('help-cards.js?v=2026-11-26e').then(fillHelpPictures, function () { /* pictures are optional */ });
}
function fillHelpPictures() {
  document.querySelectorAll('img[data-help-img]').forEach(function (im) { var u = window.TS_HELP_IMG && window.TS_HELP_IMG[im.dataset.helpImg]; if (u && !im.src) im.src = u; });
}
['helpBtn', 'helpLink'].forEach(function (id) { var b = $(id); if (b) b.addEventListener('click', loadHelpPictures); });
$('tileCards').addEventListener('click', function () { pickStart('cards'); });
$('tileApp').addEventListener('click', function () { pickStart('app'); });
sb.auth.onAuthStateChange(function (event, session) {
  if (!session) { cards = { list: [], reasons: [], exp: {}, shares: {}, loaded: false }; $('cardCounts').innerHTML = ''; $('tileCount').hidden = true; return; }
  if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') setTimeout(loadCards, 800);
});
})();
