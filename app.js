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
      $('switchApp').hidden = !(a.training && a.conference);
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
  }
  $('pickTraining').addEventListener('click', enterTraining);
  $('pickConference').addEventListener('click', openConference);
  $('switchApp').addEventListener('click', function () {
    try { sessionStorage.removeItem(CHOICE_KEY); } catch (e) { /* ignore */ }
    only('gateView'); $('gateChoices').hidden = false; $('gateMsg').textContent = 'Which app do you want to open?';
  });
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
  var F = ['fDate', 'fFrom', 'fTo', 'fState', 'fTrainer', 'fCategory', 'fProduct', 'fStatus', 'fSearch'];
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
      cat: $('fCategory').value, prod: $('fProduct').value, status: $('fStatus').value,
      q: $('fSearch').value.trim().toLowerCase()
    };
    var lc = function (x) { return String(x || '').toLowerCase(); };
    return state.trainings.filter(function (t) {
      if (!matchDate(t, v.date, today)) return false;
      if (v.state && lc(t.state) !== lc(v.state)) return false;
      if (v.cat && lc(t.category) !== lc(v.cat)) return false;
      if (v.prod && lc(t.product) !== lc(v.prod)) return false;
      if (v.status && lc(t.status) !== lc(v.status)) return false;
      if (v.trainer === '__none') { if ((t.trainer_list || []).length) return false; }
      else if (v.trainer && !(t.trainer_list || []).some(function (n) { return lc(n) === lc(v.trainer); })) return false;
      if (v.q) {
        var hay = [t.training_id, t.agency, t.agency_std, t.state, t.category, t.product, t.trainers, t.status, t.notes, t.portal_project, t.source_ref].join(' ').toLowerCase();
        if (hay.indexOf(v.q) < 0) return false;
      }
      return true;
    });
  }

  // ---------- render ----------
  function render() {
    if (state.view === 'trainings') renderTrainings(); else renderTrainers();
  }
  function trainingRow(t, today) {
    var links = [];
    var dl = safeUrl(t.drive_link); if (dl) links.push('<a href="' + esc(dl) + '" target="_blank" rel="noopener">Drive</a>');
    var pp = safeUrl(t.portal_project);
    if (pp) links.push('<a href="' + esc(pp) + '" target="_blank" rel="noopener">Portal</a>');
    else if (/^y(es)?$/i.test(String(t.portal_project).trim())) links.push('<span class="muted">In portal</span>');
    else if (t.portal_project) links.push('<span class="muted">Portal: ' + esc(t.portal_project) + '</span>');
    return '<tr>' +
      '<td class="nowrap">' + fmtRange(t) + (inProgress(t, today) ? ' <span class="chip badge-now">Now</span>' : '') + '</td>' +
      '<td>' + (t.category ? '<span class="chip cat ' + catClass(t.category) + '">' + esc(t.category) + '</span>' : '') + '</td>' +
      '<td>' + esc(t.product) + '</td>' +
      '<td>' + (t.trainers ? esc(t.trainers) : '<span class="warn">Unassigned</span>') + '</td>' +
      '<td>' + esc(t.status) + '</td>' +
      '<td>' + esc(t.delivery) + '</td>' +
      '<td class="notes">' + (t.agency && t.agency_std && t.agency !== t.agency_std ? '<div>Source name: ' + esc(t.agency) + '</div>' : '') + esc(t.notes) + '</td>' +
      '<td class="nowrap small">' + links.join(' · ') + '<div class="muted">' + esc(t.training_id) + '</div></td>' +
      '</tr>';
  }
  function renderTrainings() {
    var list = filtered(), today = todayIso();
    var groups = {};
    list.forEach(function (t) { var k = (t.agency_std || t.agency || '(No agency)') + (t.state ? ' (' + t.state + ')' : ''); (groups[k] = groups[k] || []).push(t); });
    var names = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b); });
    $('tSummary').textContent = list.length + ' training' + (list.length === 1 ? '' : 's') + ' across ' +
      names.length + ' agenc' + (names.length === 1 ? 'y' : 'ies') + ' (of ' + state.trainings.length + ' total)';
    if (!names.length) {
      $('agencyList').innerHTML = '<div class="empty card">' + (state.trainings.length
        ? 'No trainings match these filters.' : 'No data yet — the master sheet has not been synced.') + '</div>';
      return;
    }
    var open = names.length <= 8;
    $('agencyList').innerHTML = names.map(function (n) {
      var rows = groups[n].sort(function (a, b) { return (a.start_date || '9999').localeCompare(b.start_date || '9999'); });
      var st = uniq(rows.map(function (t) { return t.state; })).join(', ');
      var cats = uniq(rows.map(function (t) { return t.category; }));
      return '<details class="agency card"' + (open ? ' open' : '') + '><summary>' +
        '<span class="agency-name">' + esc(n) + '</span>' +
        (st ? '<span class="chip">' + esc(st) + '</span>' : '') +
        '<span class="muted small">' + rows.length + ' training' + (rows.length === 1 ? '' : 's') + '</span>' +
        cats.map(function (c) { return '<span class="chip cat ' + catClass(c) + '">' + esc(c) + '</span>'; }).join('') +
        '</summary><div class="table-wrap"><table><thead><tr>' +
        '<th>Date</th><th>Category</th><th>Product</th><th>Trainer(s)</th><th>Status</th><th>Onsite/Remote</th><th>Notes</th><th>Links / ID</th>' +
        '</tr></thead><tbody>' + rows.map(function (t) { return trainingRow(t, today); }).join('') + '</tbody></table></div></details>';
    }).join('');
  }
  $('expandAll').addEventListener('click', function () { document.querySelectorAll('details.agency').forEach(function (d) { d.open = true; }); });
  $('collapseAll').addEventListener('click', function () { document.querySelectorAll('details.agency').forEach(function (d) { d.open = false; }); });

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
      .sort(function (a, b) { return b.items.length - a.items.length || a.info.name.localeCompare(b.info.name); });
    var busy = people.filter(function (p) { return p.items.length; }).length;
    $('rSummary').textContent = people.length + ' trainers · ' + busy + ' with current assignments';
    if (!people.length) { $('trainerList').innerHTML = '<div class="empty card">No trainers yet — the master sheet has not been synced.</div>'; return; }
    $('trainerList').innerHTML = people.map(function (p) {
      var r = p.info;
      var items = p.items.sort(function (a, b) { return (a.start_date || '9999').localeCompare(b.start_date || '9999'); });
      return '<div class="card trainer"><h3>' + esc(r.name) +
        '<span class="chip">' + items.length + ' current</span>' +
        (r.active === false ? '<span class="chip">Inactive</span>' : '') + '</h3>' +
        '<div class="meta">' + [r.email ? '<a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a>' : '', esc(r.products)].filter(String).join(' · ') +
        (r.missing ? '<div class="warn">Not on the Trainers tab of the master sheet</div>' : '') + '</div>' +
        (items.length ? '<ul>' + items.map(function (t) {
          return '<li><div class="line1"><strong>' + esc(t.agency_std || t.agency) + '</strong><span class="small">' + fmtRange(t) +
            (inProgress(t, today) ? ' <span class="chip badge-now">Now</span>' : '') + '</span></div>' +
            '<div class="line2">' + [t.category ? '<span class="chip cat ' + catClass(t.category) + '">' + esc(t.category) + '</span>' : '',
              esc(t.product), esc(t.state), esc(t.delivery), esc(t.status)].filter(String).join(' · ') + '</div></li>';
        }).join('') + '</ul>' : '<div class="muted small">No current assignments.</div>') + '</div>';
    }).join('');
  }
  $('showInactive').addEventListener('change', renderTrainers);

  // ---------- tabs ----------
  function setView(v) {
    state.view = v;
    document.querySelectorAll('.tab').forEach(function (b) {
      var on = b.dataset.view === v; b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
    });
    $('trainingsView').hidden = v !== 'trainings';
    $('trainersView').hidden = v !== 'trainers';
    if (location.hash !== '#' + v && !/access_token|type=/.test(location.hash)) history.replaceState(null, '', '#' + v);
    if (state.loaded) render();
  }
  document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { setView(b.dataset.view); }); });
  setView(location.hash === '#trainers' ? 'trainers' : 'trainings');
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
// ---------- Users page: owner adds / removes Training Status access (added 2026-11-15) ----------
function usersCall(body) {
return sb.functions.invoke('ts-users', { body: body }).then(function (r) {
if (!r.error) return r.data;
var ctx = r.error.context;
if (ctx && typeof ctx.json === 'function') {
return ctx.json().then(function (j) { throw new Error((j && j.error) || r.error.message); }, function () { throw r.error; });
}
throw r.error;
});
}
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
b.addEventListener('click', function () {
var on = b.dataset.view === 'users';
$('usersView').hidden = !on;
if (on) loadUsers();
});
});
function fmtSeen(u) {
if (u.inactive) return '<span class="warn">Account turned off</span>';
if (!u.has_account) return '<span class="muted">No account yet</span>';
if (!u.last_sign_in_at) return '<span class="muted">Never signed in</span>';
return 'Last sign-in ' + new Date(u.last_sign_in_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function loadUsers() {
$('userList').innerHTML = '<div class="empty">Loading…</div>';
usersCall({ action: 'list' }).then(function (d) {
var list = (d.users || []).sort(function (a, b) { return (b.training - a.training) || String(a.name).localeCompare(String(b.name)); });
var n = list.filter(function (u) { return u.training; }).length;
$('uSummary').textContent = n + ' with Training Status access · ' + list.length + ' on the access list';
$('userList').innerHTML = '<div class="table-wrap card"><table><thead><tr><th>Name</th><th>Email</th><th>Training Status</th><th>Conference Tracker</th><th>Account</th><th></th></tr></thead><tbody>' +
list.map(function (u) {
var btn = u.is_me ? '<span class="muted small">You</span>'
: u.training ? '<button class="ghost small" data-revoke="' + esc(u.email) + '">Remove access</button>'
: '<button class="ghost small" data-grant="' + esc(u.email) + '" data-name="' + esc(u.name) + '">Give access</button>';
return '<tr><td>' + esc(u.name) + '</td><td>' + esc(u.email) + '</td><td>' + (u.training ? 'Yes' : '<span class="muted">No</span>') +
'</td><td>' + (u.conference ? 'Yes' : '<span class="muted">No</span>') + '</td><td class="small">' + fmtSeen(u) + '</td><td>' + btn + '</td></tr>';
}).join('') + '</tbody></table></div>';
}).catch(function (err) {
$('userList').innerHTML = '<div class="empty card">Could not load users: ' + esc(err.message || err) + '</div>';
});
}
function grant(email, name, method) {
var msg = $('uMsg'); msg.className = 'msg'; msg.textContent = 'Working…'; $('uPassBox').hidden = true;
return usersCall({ action: 'grant', email: email, name: name, method: method }).then(function (d) {
msg.className = 'msg ok';
if (d.created === 'invite') msg.textContent = 'Done. ' + d.email + ' was emailed an invite link to set a password and sign in.';
else if (d.created === 'password') msg.textContent = 'Done. Account made for ' + d.email + '. Give them the temporary password below; they can change it with Forgot password.';
else msg.textContent = 'Done. ' + d.email + ' already had an account; they can sign in with their usual password or Face ID.';
if (d.password) { $('uPass').textContent = d.password; $('uPassBox').hidden = false; }
$('uEmail').value = ''; $('uName').value = '';
loadUsers();
}).catch(function (err) { msg.className = 'msg'; msg.textContent = 'Not done: ' + (err.message || err); });
}
$('userForm').addEventListener('submit', function (e) {
e.preventDefault();
grant($('uEmail').value.trim().toLowerCase(), $('uName').value.trim(), $('uMethod').value);
});
$('userList').addEventListener('click', function (e) {
var b = e.target.closest('button'); if (!b) return;
if (b.dataset.revoke) {
if (!confirm('Remove Training Status access for ' + b.dataset.revoke + '? Their account and any Conference Tracker access stay as they are.')) return;
var msg = $('uMsg'); msg.className = 'msg'; msg.textContent = 'Working…';
usersCall({ action: 'revoke', email: b.dataset.revoke }).then(function () {
msg.className = 'msg ok'; msg.textContent = 'Access removed for ' + b.dataset.revoke + '.'; loadUsers();
}).catch(function (err) { msg.textContent = 'Not done: ' + (err.message || err); });
} else if (b.dataset.grant) {
grant(b.dataset.grant, b.dataset.name, 'invite');
}
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
})();
