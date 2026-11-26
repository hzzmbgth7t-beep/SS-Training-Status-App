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
  function gateMsg(html) { only('gateView'); $('gateChoices').hidden = true; $('gateMsg').innerHTML = html; }
  function choose(app) { try { sessionStorage.setItem(CHOICE_KEY, app); } catch (e) { /* ignore */ } }
  function chosen() { try { return sessionStorage.getItem(CHOICE_KEY); } catch (e) { return null; } }
  function openConference() { choose('conference'); location.href = cfg.CONFERENCE_URL; }

  // Decide which app this person sees: training only -> Training Status;
  // conference only -> Conference Tracker; both -> landing page to choose.
  function routeSession(session) {
    $('userEmail').textContent = session.user.email || '';
    $('gateEmail').textContent = session.user.email || '';
    if (state.access) return enterTraining();
    gateMsg('Checking your access…');
    sb.rpc('my_app_access').then(function (r) {
      if (r.error) throw r.error;
      var a = state.access = r.data || {};
      updateSwitch();
      if (a.training && a.conference) {
        if (chosen() === 'training') return enterTraining();
        only('gateView'); $('gateChoices').hidden = false; $('gateMsg').textContent = 'You have access to both apps. Which one do you want to open?';
      } else if (a.training) {
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
  $('pickTraining').addEventListener('click', enterTraining);
  $('pickConference').addEventListener('click', openConference);
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
    sb.from('ts_card_reasons').select('reason').order('reason'),
    sb.from('ts_contact_exports').select('contact_id,exported_at'),
    sb.from('ts_contact_shares').select('contact_id,email')
  ]).then(function (r) {
    var err = r.filter(function (x) { return x.error; })[0];
    if (err) throw err.error;
    cards.list = r[0].data || [];
    cards.reasons = (r[1].data || []).map(function (x) { return x.reason; });
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

// ---- form ----
function fillReasons(sel) {
  var list = cards.reasons.slice();
  if (sel && list.indexOf(sel) < 0) list.push(sel);
  $('cf_reason').innerHTML = '<option value="">Choose a reason…</option>' + list.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') +
    '<option value="__other">Other…</option>';
  $('cf_reason').value = sel || '';
}
function agencyList() {
  $('cfAgencies').innerHTML = uniq(state.trainings.map(function (t) { return t.agency_std || t.agency; })).map(function (a) { return '<option value="' + esc(a) + '">'; }).join('');
}
function setMarks(marks) {
  CF.forEach(function (f) {
    var el = document.querySelector('[data-mark="' + f + '"]'); if (!el) return;
    var m = marks && marks[f]; el.textContent = m === 'read' ? 'read' : m === 'check' ? 'check this' : ''; el.className = 'mark ' + (m || '');
  });
}
function openCardForm(c, prefill) {
  cards.editing = c || null; cards.otherReason = null; cards.pendingSave = null;
  if (!prefill) cards.image = null;
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
  $('cfOther').hidden = true; $('cfDup').hidden = true; $('cfPaste').hidden = true; cMsg('');
  $('cfDelete').hidden = !(c && (c.created_by_email === cMe() || me.admin));
  $('cfViewImg').hidden = !c; $('cfImg').hidden = true; $('cfImg').src = '';
  $('cfSaved').textContent = c ? 'Saved by ' + c.created_by_email + (c.updated_by_email ? ' · last edit ' + c.updated_by_email : '') : '';
  agencyList(); setMarks(null);
  if (prefill) applyParsed(prefill);
  $('cardForm').hidden = false; $('cardForm').scrollTop = 0;
}
$('cAdd').addEventListener('click', function () { openCardForm(null); });
$('cfCancel').addEventListener('click', function () { $('cardForm').hidden = true; stopCam(); });
$('cf_vis').addEventListener('change', function () { $('cfShareRow').hidden = $('cf_vis').value !== 'selected'; });
$('cf_reason').addEventListener('change', function () {
  if ($('cf_reason').value !== '__other') { $('cfOther').hidden = true; return; }
  $('cfOther').hidden = false; $('cfOtherText').value = ''; $('cfOtherText').focus();
  $('cfAddList').hidden = !me.admin; $('cfAsk').hidden = true;
});
function useOther(addToList) {
  var r = $('cfOtherText').value.trim().slice(0, 60);
  if (!r) { cMsg('Type the other reason first.'); return; }
  if (addToList) {
    sb.from('ts_card_reasons').insert({ reason: r, added_by_email: cMe() }).then(function (x) {
      if (x.error && !/duplicate/i.test(x.error.message)) { cMsg('Not added to the list: ' + x.error.message); return; }
      if (cards.reasons.indexOf(r) < 0) cards.reasons.push(r);
      cards.reasons.sort(); fillReasons(r); $('cfOther').hidden = true; cMsg('Added "' + r + '" to the reason list.', true);
    });
  } else {
    fillReasons(r); $('cfOther').hidden = true;
    if (!me.admin) { $('cfAskText').textContent = r; $('cfAsk').hidden = false; }
  }
}
$('cfAddList').addEventListener('click', function () { useOther(true); });
$('cfUseOnce').addEventListener('click', function () { useOther(false); });
$('cfAskYes').addEventListener('click', function () {
  var r = $('cfAskText').textContent; $('cfAsk').hidden = true;
  sb.from('ts_reason_requests').insert({ reason: r, requested_by_email: cMe() }).then(function (x) {
    cMsg(x.error ? 'Request not sent: ' + x.error.message : 'Request sent to add "' + r + '" for everyone.', !x.error);
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
function findDups(o) {
  var em = o.work_email, nm = ((o.first_name || '') + ' ' + (o.last_name || '')).trim().toLowerCase(), mob = cDigits(o.mobile);
  return cards.list.filter(function (c) {
    return (em && c.work_email === em) || (nm.indexOf(' ') > 0 && cName(c).toLowerCase() === nm) || (mob.length === 10 && cDigits(c.mobile) === mob);
  });
}
$('cfSave').addEventListener('click', function () {
  var o = formValues();
  if (!o.reason) { cMsg('Choose a reason (required).'); return; }
  if (!o.first_name && !o.last_name && !o.work_email) { cMsg('Add at least a name or an email.'); return; }
  if (!cards.editing) {
    var d = findDups(o);
    if (d.length) { cards.pendingSave = o; showDup(d[0], o); return; }
  }
  saveCard(o, cards.editing);
});
function saveCard(o, existing) {
  cMsg('Saving…');
  var shareList = $('cf_share').value.split(/[,;\s]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return /@/.test(s); });
  var p = existing
    ? sb.from('ts_contacts').update(o).eq('id', existing.id).select().single()
    : sb.from('ts_contacts').insert(Object.assign({ created_by_email: cMe() }, o)).select().single();
  p.then(function (r) {
    if (r.error) throw r.error;
    var c = r.data, jobs = [];
    if (c.created_by_email === cMe()) {
      jobs.push(sb.from('ts_contact_shares').delete().eq('contact_id', c.id).then(function () {
        if (o.visibility === 'selected' && shareList.length)
          return sb.from('ts_contact_shares').insert(shareList.map(function (e) { return { contact_id: c.id, email: e }; }));
      }));
      if (cards.image && !existing) jobs.push(sb.from('ts_card_images').insert({ contact_id: c.id, image: cards.image, created_by: cMe() }));
    }
    return Promise.all(jobs).then(function () { return c; });
  }).then(function () {
    cards.image = null; $('cardForm').hidden = true; loadCards();
  }).catch(function (e) { cMsg('Not saved: ' + (e.message || e)); });
}
// Possible duplicate: use existing, update side by side, or save as new.
function showDup(c, o) {
  var rows = CF.concat(['reason']).filter(function (f) { return (o[f] || '') !== (c[f] == null ? '' : String(c[f])) && o[f]; });
  $('cfDupText').textContent = 'Possible duplicate: ' + cName(c) + (c.agency ? ' (' + c.agency + ')' : '') + ', saved by ' + c.created_by_email + '.';
  $('cfDupTable').innerHTML = rows.length ? '<table><thead><tr><th>Use new?</th><th>Field</th><th>On file</th><th>New</th></tr></thead><tbody>' +
    rows.map(function (f) {
      return '<tr><td><input type="checkbox" data-f="' + f + '"' + (c[f] ? '' : ' checked') + '></td><td>' + esc(f.replace(/_/g, ' ')) + '</td><td>' + esc(c[f] || '') + '</td><td>' + esc(o[f]) + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="small muted">No differences.</p>';
  cards.dupOf = c; $('cfDup').hidden = false; cMsg('');
}
$('cfDupUse').addEventListener('click', function () { $('cfDup').hidden = true; openCardForm(cards.dupOf); });
$('cfDupNew').addEventListener('click', function () { $('cfDup').hidden = true; saveCard(cards.pendingSave, null); });
$('cfDupUpdate').addEventListener('click', function () {
  var c = cards.dupOf, o = cards.pendingSave, upd = {};
  $('cfDupTable').querySelectorAll('input[data-f]:checked').forEach(function (i) { upd[i.dataset.f] = o[i.dataset.f]; });
  if (!Object.keys(upd).length) { cMsg('Tick at least one field to update, or use the existing card.'); return; }
  sb.from('ts_contacts').update(upd).eq('id', c.id).then(function (r) {
    if (r.error) { cMsg('Not updated: ' + r.error.message); return; }
    $('cfDup').hidden = true; $('cardForm').hidden = true; loadCards();
  });
});
$('cfDelete').addEventListener('click', function () {
  var c = cards.editing; if (!c) return;
  if (!$('cfDelete').dataset.armed) { $('cfDelete').dataset.armed = '1'; $('cfDelete').textContent = 'Tap again to delete'; return; }
  delete $('cfDelete').dataset.armed; $('cfDelete').textContent = 'Delete';
  sb.from('ts_contacts').delete().eq('id', c.id).then(function (r) {
    if (r.error) { cMsg('Not deleted: ' + r.error.message); return; }
    $('cardForm').hidden = true; loadCards();
  });
});
$('cfViewImg').addEventListener('click', function () {
  var c = cards.editing; if (!c) return;
  sb.from('ts_card_images').select('image').eq('contact_id', c.id).maybeSingle().then(function (r) {
    if (r.error || !r.data) { cMsg('No card picture (it is removed once the saver exports the card).'); return; }
    $('cfImg').src = r.data.image; $('cfImg').hidden = false;
  });
});

// ---- reading text into fields ----
var TITLE_RE = /\b(chief|sheriff|deputy|officer|sergeant|sgt|lieutenant|lt|captain|capt|major|colonel|corporal|cpl|detective|investigator|director|manager|coordinator|administrator|supervisor|clerk|analyst|specialist|technician|dispatcher|commander|president|vice|assistant|records|it\b|marshal|warden|jailer|constable)/i;
var AGENCY_RE = /\b(police|sheriff'?s?|county|department|dept|pd\b|so\b|city of|town of|university|college|campus|911|e-?911|communications|detention|jail|public safety|marshal|state)\b/i;
var RANK_RE = /^(lt|lieutenant|sgt|sergeant|capt|captain|cpl|corporal|det|detective|chief|major|maj|sheriff|deputy|dep|officer|ofc|col|colonel|investigator|inv)\.?\s+(.+)$/i;
var DEPT_RE = /\b(division|unit|bureau|section|office of|records|investigations|patrol|support services)\b/i;
function parseCardText(text) {
  var f = {}, m = {}, used = {};
  var lines = String(text || '').split(/\r?\n/).map(function (s) { return s.replace(/\s+/g, ' ').trim(); }).filter(function (s) { return s.length > 1; });
  var all = lines.join('\n');
  var em = all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (em) { f.work_email = em[0].toLowerCase(); m.work_email = 'read'; }
  var li = all.match(/(https?:\/\/)?(www\.)?linkedin\.com\/[^\s]+/i);
  if (li) { f.linkedin = li[0]; m.linkedin = 'read'; }
  lines.forEach(function (l, i) {
    if (/@/.test(l) || /linkedin/i.test(l)) { used[i] = 1; return; }
    var w = l.match(/\b((https?:\/\/)?(www\.)?[a-z0-9-]+\.(com|org|gov|net|us|edu|info|biz)(\/\S*)?)\b/i);
    if (w && !f.website && !/\d{3}.*\d{4}/.test(l)) { f.website = w[1]; m.website = 'read'; used[i] = 1; }
    var phoneRe = /(\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(\s*(?:x|ext\.?|extension)\s*(\d+))?/gi, p;
    while ((p = phoneRe.exec(l))) {
      used[i] = 1;
      var num = '(' + p[2] + ') ' + p[3] + '-' + p[4];
      var before = l.slice(Math.max(0, p.index - 12), p.index).toLowerCase();
      if (/fax|\bf\b/.test(before)) continue;
      if (/cell|mobile|\bm\b|\bc\b/.test(before) && !f.mobile) { f.mobile = num; m.mobile = 'read'; }
      else if (!f.office_phone) { f.office_phone = num; m.office_phone = 'read'; if (p[6]) { f.office_ext = p[6]; m.office_ext = 'read'; } }
      else if (!f.mobile) { f.mobile = num; m.mobile = 'check'; }
    }
    var cs = l.match(/^(?:.*?,\s*)?([A-Za-z .'-]+),\s*([A-Z]{2})\.?\s+\d{5}(-\d{4})?$/);
    if (cs) { f.city = cs[1].trim(); f.state = cs[2]; m.city = 'read'; m.state = 'read'; used[i] = 1; }
  });
  var free = lines.map(function (l, i) { return { l: l, i: i }; }).filter(function (x) { return !used[x.i] && !/\d{3}/.test(x.l); });
  // A rank in front of a name ("Lt. John Smith"): name from the rest, rank as the title if none found.
  free.forEach(function (x) {
    var r = x.l.match(RANK_RE); if (!r || f.first_name) return;
    var words = r[2].replace(/[^A-Za-z .'-]/g, '').trim().split(' ').filter(String);
    if (words.length >= 2 && words.length <= 4 && words.every(function (w) { return /^[A-Z]/.test(w); })) {
      f.first_name = words[0]; f.last_name = words.slice(1).join(' '); m.first_name = 'check'; m.last_name = 'check';
      f.rank = r[1]; used[x.i] = 1;
    }
  });
  free.forEach(function (x) {
    if (!f.agency && AGENCY_RE.test(x.l) && !TITLE_RE.test(x.l.split(' ')[0])) { f.agency = x.l; m.agency = 'check'; used[x.i] = 1; }
  });
  free.forEach(function (x) {
    if (used[x.i]) return;
    if (!f.title && TITLE_RE.test(x.l) && x.l.split(' ').length <= 7) { f.title = x.l; m.title = 'check'; used[x.i] = 1; }
    else if (!f.department && DEPT_RE.test(x.l)) { f.department = x.l; m.department = 'check'; used[x.i] = 1; }
  });
  free.forEach(function (x) {
    if (used[x.i] || f.first_name) return;
    var words = x.l.replace(/[^A-Za-z .'-]/g, '').trim().split(' ').filter(String);
    if (words.length >= 2 && words.length <= 4 && words.every(function (w) { return /^[A-Z]/.test(w); })) {
      f.first_name = words[0]; f.last_name = words.slice(1).join(' '); m.first_name = 'check'; m.last_name = 'check'; used[x.i] = 1;
    }
  });
  if (f.rank) { if (!f.title) { f.title = f.rank.replace(/\.$/, '') + '.'; m.title = 'check'; } delete f.rank; }
  return { fields: f, marks: m };
}
function parseVcard(t) {
  var f = {}, m = {};
  String(t).split(/\r?\n/).forEach(function (l) {
    var k = l.split(':')[0].toUpperCase(), v = l.slice(l.indexOf(':') + 1).trim();
    if (k === 'N') { var n = v.split(';'); f.last_name = n[0]; f.first_name = n[1]; }
    else if (k.indexOf('FN') === 0 && !f.first_name) { var w = v.split(' '); f.first_name = w[0]; f.last_name = w.slice(1).join(' '); }
    else if (k.indexOf('ORG') === 0) { var o = v.split(';'); f.agency = o[0]; if (o[1]) f.department = o[1]; }
    else if (k.indexOf('TITLE') === 0) f.title = v;
    else if (k.indexOf('EMAIL') === 0) f.work_email = v.toLowerCase();
    else if (k.indexOf('TEL') === 0) { if (/CELL|MOBILE/.test(k)) f.mobile = v; else if (!f.office_phone) f.office_phone = v; }
    else if (k.indexOf('URL') === 0) { if (/linkedin/i.test(v)) f.linkedin = v; else f.website = v; }
    else if (k.indexOf('ADR') === 0) { var a = v.split(';'); if (a[3]) f.city = a[3]; if (a[4]) f.state = a[4].slice(0, 2).toUpperCase(); }
  });
  Object.keys(f).forEach(function (k) { if (f[k]) m[k] = 'read'; });
  return { fields: f, marks: m };
}
function parseMecard(t) {
  var f = {}, m = {};
  String(t).replace(/^MECARD:/i, '').split(';').forEach(function (p) {
    var k = p.split(':')[0].toUpperCase(), v = p.slice(p.indexOf(':') + 1);
    if (k === 'N') { var n = v.split(','); f.last_name = n[0]; f.first_name = n[1] || ''; }
    else if (k === 'TEL' && !f.mobile) f.mobile = v; else if (k === 'EMAIL') f.work_email = v.toLowerCase();
    else if (k === 'ORG') f.agency = v; else if (k === 'URL') f.website = v; else if (k === 'TITLE') f.title = v;
  });
  Object.keys(f).forEach(function (k) { if (f[k]) m[k] = 'read'; });
  return { fields: f, marks: m };
}
function applyParsed(p) {
  Object.keys(p.fields).forEach(function (k) { var el = $('cf_' + k); if (el && p.fields[k] && !el.value) el.value = p.fields[k]; });
  setMarks(p.marks);
}
$('cfPasteBtn').addEventListener('click', function () { $('cfPaste').hidden = !$('cfPaste').hidden; $('cfPasteText').focus(); });
$('cfPasteGo').addEventListener('click', function () {
  var t = $('cfPasteText').value;
  applyParsed(/BEGIN:VCARD/i.test(t) ? parseVcard(t) : /^MECARD:/i.test(t.trim()) ? parseMecard(t) : parseCardText(t));
  $('cfPaste').hidden = true; cMsg('Filled in. Fields marked "check this" were guessed.', true);
});

// ---- camera: Read Card (auto-capture after 1 second still) and Scan Code ----
var cam = { stream: null, timer: null, mode: null, last: null, stillSince: 0 };
function stopCam() {
  if (cam.timer) clearInterval(cam.timer); cam.timer = null;
  if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null;
  $('camBox').hidden = true;
}
function startCam(mode) {
  cam.mode = mode; cam.last = null; cam.stillSince = 0;
  $('camTitle').textContent = mode === 'read' ? 'Read Card: hold the card inside the outline' : 'Scan Code: point at the QR code or badge';
  $('camOutline').hidden = mode !== 'read'; $('camStatus').textContent = 'Starting camera…'; $('camBox').hidden = false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('camStatus').textContent = 'This browser cannot use the camera. Use Fill In instead.'; return; }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }).then(function (s) {
    cam.stream = s; var v = $('camVideo'); v.srcObject = s; v.setAttribute('playsinline', ''); return v.play();
  }).then(function () {
    $('camStatus').textContent = mode === 'read' ? 'Hold still…' : 'Looking for a code…';
    if (mode === 'scan') loadScript(JSQR_URL).catch(function () { /* BarcodeDetector may still work */ });
    cam.timer = setInterval(mode === 'read' ? readTick : scanTick, 250);
  }).catch(function (e) { $('camStatus').textContent = 'Camera not available: ' + (e.message || e) + '. Use Fill In instead.'; });
}
function frameData(w) {
  var v = $('camVideo'); if (!v.videoWidth) return null;
  var h = Math.round(w * v.videoHeight / v.videoWidth), c = document.createElement('canvas'); c.width = w; c.height = h;
  var x = c.getContext('2d'); x.drawImage(v, 0, 0, w, h); return { canvas: c, data: x.getImageData(0, 0, w, h) };
}
function readTick() {
  var f = frameData(64); if (!f) return;
  var d = f.data.data, sum = 0, gray = new Uint8Array(d.length / 4);
  for (var i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = (d[i] + d[i + 1] + d[i + 2]) / 3;
  if (cam.last) { for (var k = 0; k < gray.length; k++) sum += Math.abs(gray[k] - cam.last[k]); sum /= gray.length; }
  cam.last = gray;
  if (cam.last && sum && sum < 4) { if (!cam.stillSince) cam.stillSince = Date.now(); else if (Date.now() - cam.stillSince > 1000) captureCard(); }
  else cam.stillSince = 0;
}
$('camCapture').addEventListener('click', function () { if (cam.mode === 'read') captureCard(); });
$('camCancel').addEventListener('click', stopCam);
function cardImage(canvas) {
  var v = $('camVideo'), long = 900, sc = long / Math.max(v.videoWidth, v.videoHeight);
  var c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * sc); c.height = Math.round(v.videoHeight * sc);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  var q = 0.6, url = c.toDataURL('image/jpeg', q);
  while (url.length > 400 * 1024 * 1.37 && q > 0.2) { q -= 0.1; url = c.toDataURL('image/jpeg', q); }
  return url;
}
function captureCard() {
  if (cam.timer) clearInterval(cam.timer); cam.timer = null;
  var v = $('camVideo'), c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  cards.image = cardImage(c);
  $('camStatus').textContent = 'Reading the card… (first time can take a few seconds)';
  if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null;
  loadScript(TESS_URL).then(function () { return window.Tesseract.recognize(c, 'eng'); }).then(function (r) {
    $('camBox').hidden = true;
    applyParsed(parseCardText(r.data.text));
    cMsg('Card read. Check every field; "check this" means it was guessed. The card picture is saved with the card.', true);
  }).catch(function (e) { $('camBox').hidden = true; cMsg('Could not read the card: ' + (e.message || e) + '. Use Fill In instead.'); });
}
function scanTick() {
  var f = frameData(640); if (!f) return;
  var done = function (txt) {
    stopCam();
    var t = String(txt || '').trim();
    if (/BEGIN:VCARD/i.test(t)) applyParsed(parseVcard(t));
    else if (/^MECARD:/i.test(t)) applyParsed(parseMecard(t));
    else { $('cf_badge_code').value = t; setMarks({ badge_code: 'read' }); }
    cMsg('Code scanned.', true);
  };
  if (window.BarcodeDetector) {
    if (!cam.bd) try { cam.bd = new window.BarcodeDetector(); } catch (e) { cam.bd = null; }
    if (cam.bd) { cam.bd.detect(f.canvas).then(function (r) { if (r && r[0] && cam.timer) done(r[0].rawValue); }).catch(function () { }); return; }
  }
  if (window.jsQR) { var q = window.jsQR(f.data.data, f.data.width, f.data.height); if (q && q.data) done(q.data); }
}
$('cfReadBtn').addEventListener('click', function () { startCam('read'); });
$('cfScanBtn').addEventListener('click', function () { startCam('scan'); });

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
$('tileCards').addEventListener('click', function () { pickStart('cards'); });
$('tileApp').addEventListener('click', function () { pickStart('app'); });
sb.auth.onAuthStateChange(function (event, session) {
  if (!session) { cards = { list: [], reasons: [], exp: {}, shares: {}, loaded: false }; $('cardCounts').innerHTML = ''; $('tileCount').hidden = true; return; }
  if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') setTimeout(loadCards, 800);
});
})();
