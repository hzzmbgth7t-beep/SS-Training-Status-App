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
})();
