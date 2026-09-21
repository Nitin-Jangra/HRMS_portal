/* ============================================================================
   HRMS DASHBOARD — dashboard.js  (v2 — matched to YOUR database schema)
   ----------------------------------------------------------------------------
   Handles: auth guard · profile (users + employee_profiles) · attendance
            punch-in/out · KPI stats · leave balance + donut · holidays ·
            announcements · activity · notification badges · logout

   ── DATABASE CONTRACT (created by hrms-schema.sql) ─────────────────────────
     users             : id, name, email, role, phone, department_id,
                         manager_id, joining_date        ← your existing table
     employee_profiles : user_id, first_name, last_name, designation, city …
                         ← your existing table
     departments       : id, name                       ← your existing table
     attendance        : user_id, work_date, check_in, check_out, break_minutes
                         (UNIQUE(user_id, work_date))
     leave_requests    : user_id, leave_type ('Casual'|'Sick'|'Earned'|'Unpaid'),
                         start_date, end_date, days, status
     overtime          : user_id, minutes, status
     tasks             : user_id, title, status
     holidays          : name, date
     announcements     : title, body, type ('info'|'policy'|'birthday'|'event')
     activities        : user_id, message, type
     notifications     : user_id, is_read        messages : user_id, is_read

   ── AUTH MODEL (same as your profile-setup.js) ─────────────────────────────
     Login stores the account row in  localStorage.loggedInUser.
     This file reads it, guards the page (redirects to CONFIG.loginUrl when
     missing) and loads everything else by  user_id.  Logout clears the key.

   ── SETUP ──────────────────────────────────────────────────────────────────
   Credentials are read from supabase.js — THE ONLY FILE YOU EDIT (it defines
   window.HRMS_CONFIG + one shared client, window.HRMS_SB). If that file is
   absent, fill the CONFIG block below. Until real credentials are found the
   page runs in DEMO MODE: fully interactive, no network calls, static HTML
   preserved.

   Run hrms-schema.sql in the Supabase SQL Editor first — it creates the
   missing tables (+ RLS policies) this file reads/writes.
   ========================================================================== */

(function () {
'use strict';

/* ============================================================
   1. CONFIG — supabase.js is the single source of truth.
   This block is only a fallback used when supabase.js is absent.
   ============================================================ */

var CONFIG = {
    supabaseUrl:     'YOUR_SUPABASE_URL',       // e.g. https://xxxx.supabase.co
    supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',  // anon/public key
    loginUrl:        'index.html',              // redirect target when signed out
    defaultBreakMinutes: 45,

    limits: { announcements: 3, activity: 4, holidays: 3 },

    tables: {
        users:           'users',
        profiles:        'employee_profiles',
        departments:     'departments',
        attendance:      'attendance',
        leaveRequests:   'leave_requests',
        overtime:        'overtime',
        tasks:           'tasks',
        holidays:        'holidays',
        announcements:   'announcements',
        activities:      'activities',
        notifications:   'notifications',
        messages:        'messages'
    }
};

/* supabase.js (central config — the only file you edit) overrides this block */
(function () {
    var HC = window.HRMS_CONFIG;
    if (!HC) return;
    if (HC.loginUrl)     CONFIG.loginUrl = HC.loginUrl;
    if (HC.dashboardUrl) CONFIG.dashboardUrl = HC.dashboardUrl;
    if (HC.tables) {
        for (var k in HC.tables) {
            if (Object.prototype.hasOwnProperty.call(HC.tables, k) && HC.tables[k]) {
                CONFIG.tables[k] = HC.tables[k];
            }
        }
    }
})();

/* ============================================================
   2. STATE + TINY DOM UTILS
   ============================================================ */

var sb = null;         // supabase client
var DEMO = true;       // flipped in initClient()
var USER = null;       // localStorage account row { id, name, email, … }
var UROW = null;       // fresh users row (production)
var PROF = null;       // employee_profiles row (production)
var todayRec = null;   // today's attendance record

function $(sel, root)  { return (root || document).querySelector(sel); }
function byId(id)      { return document.getElementById(id); }
function setText(id, v){ var el = byId(id); if (el) el.textContent = v; }

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function pad4(n) { n = String(n == null ? '' : n); while (n.length < 4) n = '0' + n; return n; }

function initials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '');
}

function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }

/* 2025-06-12 (local timezone, avoids UTC off-by-one) */
function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function monthRangeISO() {
    var d = new Date();
    var first = new Date(d.getFullYear(), d.getMonth(), 1);
    var last  = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { from: todayISO(first), to: todayISO(last) };
}

/* "12 Jun 2025" */
function humanDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* "12 June 2025" (attendance card) */
function longDate(iso) {
    var d = iso ? new Date(iso) : new Date();
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* { time: "09:05", meridiem: "AM" } in 12h format */
function clockParts(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return null;
    var h = d.getHours();
    var mer = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return { time: pad2(h12) + ':' + pad2(d.getMinutes()), meridiem: mer };
}

/* minutes -> "07h 35m" */
function minutesToHm(min) {
    min = Math.max(0, Math.round(min));
    return pad2(Math.floor(min / 60)) + 'h ' + pad2(min % 60) + 'm';
}

/* "2 days ago" */
function timeAgo(iso) {
    if (!iso) return '';
    var diffMs = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diffMs / 60000);
    if (mins < 1)    return 'Just now';
    if (mins < 60)   return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24)    return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(hrs / 24);
    if (days < 30)   return days + (days === 1 ? ' day ago' : ' days ago');
    return humanDate(iso);
}

/* whole days from today until date (local) */
function daysUntil(iso) {
    var today = new Date(todayISO());
    var target = new Date(iso);
    return Math.round((target - today) / 86400000);
}

/* re-run count-up animation on a stat element */
function animateNumber(el, target, pad) {
    if (!el) return;
    if (DEMO && typeof target !== 'number') return;

    var reduce = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
        var s0 = String(target);
        while (pad && s0.length < pad) s0 = '0' + s0;
        el.textContent = s0;
        return;
    }

    var duration = 900, start = null;
    function fmt(v) {
        var s = String(Math.round(v));
        while (pad && s.length < pad) s = '0' + s;
        return s;
    }
    function step(ts) {
        if (!start) start = ts;
        var p = Math.min((ts - start) / duration, 1);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(target * eased);
        if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

/* ============================================================
   3. AUTH — localStorage account (your existing login model)
   ============================================================ */

function resolveCredentials() {
    var url = '', key = '';

    /* 1) central config — supabase.js, the only file you ever edit */
    var HC = window.HRMS_CONFIG;
    if (HC) {
        url = HC.supabaseUrl || '';
        key = HC.supabaseAnonKey || HC.supabaseKey || '';
    }

    /* 2) legacy supabase.js globals (older setups still work) */
    if (!url) { try { if (typeof supabaseUrl !== 'undefined') url = supabaseUrl; } catch (e) {} }
    if (!key) { try { if (typeof supabaseKey !== 'undefined') key = supabaseKey; } catch (e) {} }
    if (!url && window.supabaseUrl) url = window.supabaseUrl;
    if (!key && window.supabaseKey) key = window.supabaseKey;

    /* 3) local fallback block (only reached when supabase.js is absent) */
    if (!url || !/^https:\/\/(?!YOUR_)/.test(String(url))) url = CONFIG.supabaseUrl;
    if (!key || String(key).indexOf('YOUR_') === 0) key = CONFIG.supabaseAnonKey;

    return { url: String(url), key: String(key) };
}

function initClient() {
    var c = resolveCredentials();

    DEMO = !/^https:\/\/(?!YOUR_)/.test(c.url) || c.key.indexOf('YOUR_') === 0;
    if (DEMO) return false;

    /* reuse the ONE client created by supabase.js (window.HRMS_SB) */
    if (window.HRMS_SB) { sb = window.HRMS_SB; return true; }

    if (!window.supabase || !window.supabase.createClient) {
        console.warn('[HRMS] Supabase CDN not loaded — falling back to demo mode.');
        DEMO = true;
        return false;
    }

    try {
        sb = window.supabase.createClient(c.url, c.key);
        return true;
    } catch (e) {
        console.error('[HRMS] Supabase init failed:', e.message);
        DEMO = true;
        return false;
    }
}

function requireAuth() {
    var raw = null;
    try { raw = localStorage.getItem('loggedInUser'); } catch (e) {}
    if (raw) {
        try { USER = JSON.parse(raw); } catch (e) { USER = null; }
    }

    if (!USER || USER.id == null) {
        if (DEMO) {
            /* synthetic session so the demo stays browsable */
            USER = { id: 1, name: 'Nitin Jangra', email: 'nitin@hrims.app' };
            return true;
        }
        window.location.href = CONFIG.loginUrl;
        throw new Error('[HRMS] Not signed in — redirecting to ' + CONFIG.loginUrl);
    }
    return true;
}

function logout() {
    try { localStorage.removeItem('loggedInUser'); } catch (e) {}
    window.location.href = CONFIG.loginUrl;
}

/* ============================================================
   4. PROFILE + GREETING  (users + employee_profiles + departments)
   ============================================================ */

function applyGreeting(name) {
    var el = byId('welcomeName');
    if (!el) return;
    var h = new Date().getHours();
    var g = h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
    var first = String(name || '').trim().split(/\s+/)[0] || 'there';
    el.textContent = g + ', ' + first + '! \uD83D\uDC4B';
}

function applyProfile(u, p, deptName, managerName) {
    var name = (p && (p.first_name || p.last_name))
        ? ((p.first_name || '') + ' ' + (p.last_name || '')).trim()
        : (u.name || '');

    if (name) {
        setText('profileName', name);
        setText('topbarName', name);
        applyGreeting(name);
        var ini = initials(name).toUpperCase();
        var pa = byId('profileAvatar'), ta = byId('topbarAvatar');
        if (pa) pa.textContent = ini;
        if (ta) ta.textContent = ini;
    }

    /* designation from the profile beats the users.role default */
    setText('profileRole', (p && p.designation) || u.role || '');
    setText('profileDept', deptName || '');
    setText('employeeId', 'Employee ID: EMP-' + pad4(u.id));
    setText('profileEmail', u.email || '');
    setText('profilePhone', (p && p.phone) || u.phone || '');
    setText('profileLocation', (p && (p.city || p.state)) || '');

    /* reporting manager, if the profile card has a slot for it */
    var mgrEl = byId('profileManager');
    if (mgrEl && managerName) mgrEl.textContent = managerName;
}

async function loadProfile() {
    if (DEMO) { applyGreeting(USER.name || 'Nitin Jangra'); return; }

    /* 1) fresh account row — fall back to the stored login object */
    var u = await sb.from(CONFIG.tables.users)
        .select('id,name,email,phone,role,department_id,manager_id,joining_date')
        .eq('id', USER.id)
        .maybeSingle();

    if (u.error) { console.error('[HRMS] Users:', u.error.message); }
    UROW = (u.data || USER);
    if (!UROW.id) UROW.id = USER.id;

    /* 2) extended profile */
    var p = await sb.from(CONFIG.tables.profiles)
        .select('*')
        .eq('user_id', USER.id)
        .maybeSingle();
    if (p.error) console.error('[HRMS] Profile:', p.error.message);
    PROF = p.data || null;

    /* 3) department + manager names (both optional) */
    var deptName = null, managerName = null;

    if (UROW.department_id != null) {
        var d = await sb.from(CONFIG.tables.departments)
            .select('name')
            .eq('id', UROW.department_id)
            .maybeSingle();
        if (!d.error && d.data) deptName = d.data.name;
    }

    if (UROW.manager_id != null) {
        var m = await sb.from(CONFIG.tables.users)
            .select('name')
            .eq('id', UROW.manager_id)
            .maybeSingle();
        if (!m.error && m.data) managerName = m.data.name;
    }

    applyProfile(UROW, PROF, deptName, managerName);
}

/* ============================================================
   5. ATTENDANCE — today + punch in / out   (keyed by user_id)
   ============================================================ */

function setPill(state) { // 'present' | 'absent'
    var pill = byId('presentPill');
    if (!pill) return;
    if (state === 'absent') {
        pill.textContent = 'Not Checked In';
        pill.classList.add('pill-absent');
        pill.classList.remove('pill-present');
    } else {
        pill.textContent = 'Present';
        pill.classList.remove('pill-absent');
        pill.classList.add('pill-present');
    }
}

function setAttTime(id, iso) {
    var el = byId(id);
    if (!el) return;
    var c = clockParts(iso);
    if (c) el.innerHTML = esc(c.time) + ' <small>' + c.meridiem + '</small>';
    else   el.innerHTML = '--:-- <small>--</small>';
    el.classList.toggle('dim', !c);
}

function setPunchState(state) { // 'none' | 'in' | 'done'
    var inBtn = byId('checkInBtn'), outBtn = byId('checkOutBtn');
    if (!inBtn || !outBtn) return;

    inBtn.disabled  = (state !== 'none');
    outBtn.disabled = (state !== 'in');

    var inLabel = state === 'none' ? 'Check In' : 'Checked In \u2713';
    inBtn.innerHTML =
        '<i data-lucide="log-in"></i><span class="spinner"></span>' +
        '<span class="btn-label">' + inLabel + '</span>';
    if (state !== 'none') inBtn.querySelector('.pulse-dot') &&
        inBtn.removeChild(inBtn.querySelector('.pulse-dot'));

    outBtn.innerHTML =
        '<i data-lucide="log-out"></i><span class="spinner"></span>' +
        '<span class="btn-label">' +
        (state === 'done' ? 'Checked Out \u2713' : 'Check Out') + '</span>';

    refreshIcons();
}

function applyAttendance(rec) {
    todayRec = rec || null;

    setText('attCheckInDate', longDate(rec && rec.check_in));

    if (!rec || !rec.check_in) {
        setAttTime('attCheckIn', null);
        setAttTime('attCheckOut', null);
        setText('attCheckOutSub', 'Not Checked Out');
        setText('attWorkTime', '00h 00m');
        setText('attBreak', '00h 00m');
        setPill('absent');
        setPunchState('none');
        return;
    }

    setAttTime('attCheckIn', rec.check_in);
    setPill('present');

    if (!rec.check_out) {
        setAttTime('attCheckOut', null);
        setText('attCheckOutSub', 'Not Checked Out');
        setPunchState('in');
    } else {
        setAttTime('attCheckOut', rec.check_out);
        setText('attCheckOutSub', 'Checked Out');
        setPunchState('done');
    }

    var breakMin = rec.break_minutes != null ? rec.break_minutes : CONFIG.defaultBreakMinutes;
    setText('attBreak', minutesToHm(breakMin));

    if (rec.check_in && rec.check_out) {
        var mins = (new Date(rec.check_out) - new Date(rec.check_in)) / 60000 - breakMin;
        setText('attWorkTime', minutesToHm(mins));
    } else {
        setText('attWorkTime', '00h 00m');
    }
}

function btnLoading(btn, on) {
    if (btn) btn.classList.toggle('loading', !!on);
}

async function punchIn() {
    var btn = byId('checkInBtn');
    btnLoading(btn, true);

    try {
        var row = {
            user_id:   USER.id,
            work_date: todayISO(),
            check_in:  new Date().toISOString()
        };
        var res = await sb.from(CONFIG.tables.attendance)
            .upsert(row, { onConflict: 'user_id,work_date' })
            .select()
            .single();

        if (res.error) throw res.error;
        applyAttendance(res.data);

        /* punch-in activity entry (best effort) */
        sb.from(CONFIG.tables.activities).insert({
            user_id: USER.id,
            message: 'Checked in at ' + clockParts(row.check_in).time + ' ' +
                     clockParts(row.check_in).meridiem,
            type: 'task'
        }).then(function () {}, function () {});
    } catch (e) {
        console.error('[HRMS] Check-in failed:', e.message || e);
        btnLoading(btn, false);
    }
}

async function punchOut() {
    var btn = byId('checkOutBtn');
    btnLoading(btn, true);

    try {
        var res = await sb.from(CONFIG.tables.attendance)
            .update({
                check_out: new Date().toISOString(),
                break_minutes: todayRec && todayRec.break_minutes != null
                    ? todayRec.break_minutes : CONFIG.defaultBreakMinutes
            })
            .eq('user_id', USER.id)
            .eq('work_date', todayISO())
            .select()
            .single();

        if (res.error) throw res.error;
        applyAttendance(res.data);
    } catch (e) {
        console.error('[HRMS] Check-out failed:', e.message || e);
        btnLoading(btn, false);
    }
}

async function loadTodayAttendance() {
    if (DEMO) return;

    var res = await sb.from(CONFIG.tables.attendance)
        .select('*')
        .eq('user_id', USER.id)
        .eq('work_date', todayISO())
        .maybeSingle();

    if (res.error) { console.error('[HRMS] Attendance:', res.error.message); return; }
    applyAttendance(res.data);
}

/* Demo punch — same UI flow, no network */
function demoPunch(mode) {
    var btn = byId(mode === 'in' ? 'checkInBtn' : 'checkOutBtn');
    btnLoading(btn, true);

    setTimeout(function () {
        if (mode === 'in') {
            todayRec = {
                work_date: todayISO(),
                check_in: new Date().toISOString(),
                check_out: null,
                break_minutes: CONFIG.defaultBreakMinutes
            };
        } else if (todayRec) {
            todayRec.check_out = new Date().toISOString();
        }
        applyAttendance(todayRec);
        console.info('[HRMS] Demo ' + (mode === 'in' ? 'check-in' : 'check-out') +
            ' recorded (demo mode — nothing saved).');
    }, 650);
}

/* ============================================================
   6. KPI STATS (this month, keyed by user_id)
   ============================================================ */

async function loadStats() {
    if (DEMO) return;
    var r = monthRangeISO();
    var T = CONFIG.tables;

    var jobs = [

        /* Present days: attendance rows with a check-in this month */
        sb.from(T.attendance).select('*', { count: 'exact', head: true })
            .eq('user_id', USER.id)
            .gte('work_date', r.from).lte('work_date', r.to)
            .not('check_in', 'is', null)
            .then(function (res) {
                if (!res.error) animateNumber(byId('statPresentDays'), res.count || 0);
            }),

        /* Approved leave days this month */
        sb.from(T.leaveRequests).select('days', { count: 'exact', head: true })
            .eq('user_id', USER.id)
            .eq('status', 'approved')
            .gte('start_date', r.from).lte('start_date', r.to)
            .then(function (res) {
                if (!res.error) animateNumber(byId('statLeaves'), res.count || 0);
            }),

        /* Approved overtime minutes */
        sb.from(T.overtime).select('minutes')
            .eq('user_id', USER.id)
            .eq('status', 'approved')
            .gte('created_at', r.from + 'T00:00:00')
            .then(function (res) {
                if (res.error) return;
                var total = 0;
                (res.data || []).forEach(function (row) {
                    total += Number(row.minutes) || 0;
                });
                setText('statOvertime', minutesToHm(total));
            }),

        /* Pending tasks */
        sb.from(T.tasks).select('*', { count: 'exact', head: true })
            .eq('user_id', USER.id)
            .neq('status', 'completed')
            .then(function (res) {
                if (!res.error) animateNumber(byId('statTasks'), res.count || 0, 2);
            })
    ];

    var results = await Promise.allSettled(jobs);
    results.forEach(function (p, i) {
        if (p.status === 'rejected') console.error('[HRMS] Stat ' + i + ':', p.reason);
    });
}

/* ============================================================
   7. LEAVE BALANCE — sidebar list + donut + legend
   ============================================================ */

var LEAVE_COLORS = ['#3B82F6', '#8B5CF6', '#F59E0B', '#EC4899'];

function renderSidebarBalance(items) {
    var wrap = byId('leaveBalanceList');
    if (!wrap) return;
    wrap.innerHTML = items.map(function (it, i) {
        return '<div class="lb-row">' +
            '<span class="lb-dot" style="--c:' + (it.color || LEAVE_COLORS[i % 4]) + '"></span>' +
            '<span class="lb-name">' + esc(it.name) + '</span>' +
            '<b>' + pad2(it.days) + '</b>' +
            '</div>';
    }).join('');
}

function renderLegend(items) {
    var wrap = byId('leaveLegend');
    if (!wrap) return;
    wrap.innerHTML = items.map(function (it, i) {
        return '<div class="lg-row">' +
            '<span class="lg-dot" style="--c:' + (it.color || LEAVE_COLORS[i % 4]) + '"></span>' +
            '<span class="lg-name">' + esc(it.name) + '</span>' +
            '<b>' + pad2(it.days) + ' Days</b>' +
            '</div>';
    }).join('');
}

/* Recompute donut geometry for any set of leave values */
function updateDonut(items) {
    var svg = $('.donut');
    if (!svg) return;

    var segs = svg.querySelectorAll('.donut-seg');
    var C = 2 * Math.PI * 54;   /* r=54 in the SVG viewBox */
    var PAD = 3;                /* visual gap between segments */
    var total = 0, i;

    for (i = 0; i < items.length; i++) total += Number(items[i].days) || 0;
    setText('donutTotal', String(total));

    var acc = 0;
    for (i = 0; i < segs.length; i++) {
        var seg = segs[i];
        var it = items[i];
        if (!it) { seg.style.display = 'none'; continue; }
        seg.style.display = '';

        var frac = total ? (Number(it.days) || 0) / total : 0;
        var dash = Math.max(frac * C - PAD, 0.6);
        var gap = C - dash;

        if (it.color) seg.setAttribute('stroke', it.color);
        seg.style.setProperty('--dash', dash.toFixed(2));
        seg.style.setProperty('--gap', gap.toFixed(2));
        seg.setAttribute('stroke-dasharray', dash.toFixed(2) + ' ' + gap.toFixed(2));
        seg.setAttribute('stroke-dashoffset', (-acc).toFixed(2));

        acc += frac * C;
    }

    /* restart sweep animation */
    svg.classList.remove('animate');
    void svg.getBoundingClientRect(); /* force reflow */
    svg.classList.add('animate');
}

function applyLeaves(items) {
    if (!items || !items.length) return;
    renderSidebarBalance(items);
    renderLegend(items);
    updateDonut(items);
}

async function loadLeaves() {
    if (DEMO) return;

    /* Approved leaves only — the donut shows what was actually granted. */
    var res = await sb.from(CONFIG.tables.leaveRequests)
        .select('leave_type, days')
        .eq('user_id', USER.id)
        .eq('status', 'approved');

    if (res.error) { console.error('[HRMS] Leaves:', res.error.message); return; }

    /* Aggregate approved leave per type. */
    var order = [], map = {};
    (res.data || []).forEach(function (row) {
        var key = row.leave_type || 'Leave';
        if (!(key in map)) { map[key] = 0; order.push(key); }
        map[key] += Number(row.days) || 0;
    });

    if (!order.length) return;
    applyLeaves(order.slice(0, 4).map(function (name, i) {
        return { name: name, days: map[name], color: LEAVE_COLORS[i % 4] };
    }));
}

/* ============================================================
   8. HOLIDAYS
   ============================================================ */

function renderHolidays(list) {
    var wrap = byId('holidayList');
    if (!wrap || !list) return;

    if (!list.length) {
        wrap.innerHTML = '<p style="color:var(--text-3);font-size:13px;padding:8px 2px;">' +
            'No upcoming holidays.</p>';
        return;
    }

    wrap.innerHTML = list.map(function (h) {
        var d = daysUntil(h.date);
        var chip = d <= 0 ? 'Today' : d === 1 ? 'Tomorrow' : 'In ' + d + ' days';
        return '<div class="holiday-row">' +
            '<span class="icon-chip c-green"><i data-lucide="calendar-check"></i></span>' +
            '<div class="h-info"><b>' + esc(h.name) + '</b>' +
            '<small>' + esc(humanDate(h.date)) + '</small></div>' +
            '<span class="h-chip">' + esc(chip) + '</span>' +
            '</div>';
    }).join('');

    refreshIcons();
}

async function loadHolidays() {
    if (DEMO) return;

    var res = await sb.from(CONFIG.tables.holidays)
        .select('*')
        .gte('date', todayISO())
        .order('date', { ascending: true })
        .limit(CONFIG.limits.holidays);

    if (res.error) { console.error('[HRMS] Holidays:', res.error.message); return; }
    renderHolidays(res.data || []);
}

/* ============================================================
   9. ANNOUNCEMENTS + ACTIVITY FEEDS
   ============================================================ */

var ANN_ICONS = {
    info:     ['megaphone', 'c-blue'],
    policy:   ['shield-check', 'c-green'],
    birthday: ['gift', 'c-orange'],
    event:    ['calendar-days', 'c-purple']
};

var ACT_ICONS = {
    leave:    ['check', 'c-green'],
    payslip:  ['file-text', 'c-blue'],
    overtime: ['clock', 'c-orange'],
    task:     ['check', 'c-purple']
};

function renderAnnouncements(list) {
    var wrap = byId('announcementList');
    if (!wrap || !list) return;

    if (!list.length) {
        wrap.innerHTML = '<p style="color:var(--text-3);font-size:13px;padding:8px 2px;">' +
            'No announcements yet.</p>';
        return;
    }

    wrap.innerHTML = list.map(function (a) {
        var ic = ANN_ICONS[a.type] || ANN_ICONS.info;
        return '<div class="feed-item">' +
            '<span class="icon-chip ' + ic[1] + '"><i data-lucide="' + ic[0] + '"></i></span>' +
            '<div class="feed-info"><b>' + esc(a.title) + '</b>' +
            '<p>' + esc(a.body || '') + '</p></div>' +
            '<small class="feed-time">' + esc(humanDate(a.created_at)) + '</small>' +
            '</div>';
    }).join('');

    refreshIcons();
}

function renderActivity(list) {
    var wrap = byId('activityList');
    if (!wrap || !list) return;

    if (!list.length) {
        wrap.innerHTML = '<p style="color:var(--text-3);font-size:13px;padding:8px 2px;">' +
            'No recent activity.</p>';
        return;
    }

    wrap.innerHTML = list.map(function (a) {
        var ic = ACT_ICONS[a.type] || ACT_ICONS.leave;
        return '<div class="feed-item">' +
            '<span class="icon-chip ' + ic[1] + '"><i data-lucide="' + ic[0] + '"></i></span>' +
            '<div class="feed-info"><p>' + esc(a.message) + '</p></div>' +
            '<small class="feed-time">' + esc(timeAgo(a.created_at)) + '</small>' +
            '</div>';
    }).join('');

    refreshIcons();
}

async function loadFeeds() {
    if (DEMO) return;
    var T = CONFIG.tables;

    var ann = sb.from(T.announcements)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(CONFIG.limits.announcements)
        .then(function (res) {
            if (res.error) throw res.error;
            renderAnnouncements(res.data || []);
        });

    var act = sb.from(T.activities)
        .select('*')
        .eq('user_id', USER.id)
        .order('created_at', { ascending: false })
        .limit(CONFIG.limits.activity)
        .then(function (res) {
            if (res.error) throw res.error;
            renderActivity(res.data || []);
        });

    var both = await Promise.allSettled([ann, act]);
    both.forEach(function (p, i) {
        if (p.status === 'rejected') {
            console.error('[HRMS] Feed ' + (i ? 'activity' : 'announcements') + ':', p.reason.message || p.reason);
        }
    });
}

/* ============================================================
   10. NOTIFICATION BADGES   (is_read — see hrms-schema.sql)
   ============================================================ */

async function loadBadges() {
    if (DEMO || !USER) return;
    var T = CONFIG.tables;

    async function count(table) {
        var res = await sb.from(table)
            .select('*', { count: 'exact', head: true })
            .eq('user_id', USER.id)
            .eq('is_read', false);
        return res.error ? null : (res.count || 0);
    }

    var notif = await count(T.notifications);
    var msgs  = await count(T.messages);

    function paint(id, n) {
        var el = byId(id);
        if (!el) return;
        if (n == null) return;          /* query failed — keep static value */
        el.textContent = n;
        el.classList.toggle('hidden', n === 0);
    }

    paint('notifCount', notif);
    paint('msgCount', msgs);
}

/* ============================================================
   11. UI BINDINGS (search shortcut, punch buttons, logout)
   ============================================================ */

function bindUI() {

    /* Ctrl + / focuses global search */
    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === '/') {
            var input = byId('globalSearch');
            if (input) {
                e.preventDefault();
                input.focus();
                input.select();
            }
        }
    });

    /* Punch buttons */
    var inBtn = byId('checkInBtn'), outBtn = byId('checkOutBtn');
    if (inBtn) inBtn.addEventListener('click', function () {
        DEMO ? demoPunch('in') : punchIn();
    });
    if (outBtn) outBtn.addEventListener('click', function () {
        DEMO ? demoPunch('out') : punchOut();
    });

    /* Logout — clears the localStorage session used across the app */
    var logoutBtn = byId('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', function () {
        if (DEMO) {
            console.info('[HRMS] Demo mode — logout would redirect to ' + CONFIG.loginUrl);
            return;
        }
        logout();
    });
}

/* ============================================================
   12. BOOT
   ============================================================ */

async function boot() {
    initClient();   /* resolve credentials from supabase.js + reuse window.HRMS_SB — MUST run before requireAuth */
    bindUI();

    try {
        requireAuth();   /* demo-safe: synthesizes a session in demo mode */

        if (DEMO) {
            /* supabase.js already announced demo mode — avoid double banners */
            if (!window.HRMS_CONFIG) {
                console.info(
                    '%c[HRMS] Demo mode%c — paste your URL + anon key in supabase.js to go live.',
                    'background:#0D6EFD;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700', ''
                );
            }
            applyGreeting(USER.name || 'Nitin Jangra');
            setText('employeeId', 'Employee ID: EMP-' + pad4(USER.id));
            return;
        }

        await loadProfile();
        await Promise.allSettled([
            loadTodayAttendance(),
            loadStats(),
            loadLeaves(),
            loadHolidays(),
            loadFeeds(),
            loadBadges()
        ]);
    } catch (e) {
        if (!/Not signed in/.test(String(e && e.message))) {
            console.error('[HRMS] Boot error:', e);
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

/* ============================================================
   13. PUBLIC API (debugging / external hooks)
   ============================================================ */

window.HRMS = {
    config: CONFIG,
    demo: function () { return DEMO; },
    user: function () { return USER; },
    refresh: function () {
        if (DEMO) return Promise.resolve();
        return Promise.allSettled([
            loadProfile(), loadTodayAttendance(), loadStats(),
            loadLeaves(), loadHolidays(), loadFeeds(), loadBadges()
        ]);
    },
    /* Handy for custom integrations: HRMS.applyLeaves([{name:'Casual',days:12},...]) */
    applyLeaves: applyLeaves,
    applyAttendance: applyAttendance
};

})();
