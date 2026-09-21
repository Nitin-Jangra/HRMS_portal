/* ============================================================================
   HRMS WORKSPACE — hrms.js  (single-page application)
   ----------------------------------------------------------------------------
   EVERYTHING lives in one page: 9 views switched by hash-router
     #/dashboard · #/attendance · #/leaves · #/directory · #/tasks ·
     #/holidays · #/announcements · #/profile · #/settings
   Every button is wired: punch in/out · apply/cancel leave · task CRUD ·
   notifications (mark read) · messages · global search · directory filters ·
   profile save · preferences · logout.

   ── DATA MODES ──────────────────────────────────────────────────────────────
   PRODUCTION : supabase.js (the only file you edit) supplies URL + anon key
                → reads/writes go straight to your Supabase tables.
   DEMO       : no credentials yet → a sample workspace is generated and
                persisted in localStorage, so every button still works.
                Settings → "Reset demo data" restores the seed.

   ── TABLES USED (created by hrms-schema.sql, plus your existing ones) ──────
     users · departments · employee_profiles · attendance · leave_requests ·
     holidays · announcements · activities · tasks · overtime ·
     notifications · messages
   ========================================================================== */

(function () {
'use strict';

/* ============================================================
   1. CONFIG — supabase.js is the single source of truth
   ============================================================ */

var CONFIG = {
    loginUrl:      'index.html',
    defaultBreakMinutes: 45,
    punchInByHour: 10,          /* arrivals after this hour count as "late" for stats */

    leaveAlloc: { Casual: 12, Sick: 10, Earned: 15, Unpaid: null },

    tables: {
        users:         'users',
        profiles:      'employee_profiles',
        departments:   'departments',
        attendance:    'attendance',
        leaveRequests: 'leave_requests',
        overtime:      'overtime',
        tasks:         'tasks',
        holidays:      'holidays',
        announcements: 'announcements',
        activities:    'activities',
        notifications: 'notifications',
        messages:      'messages'
    }
};

/* central config overrides */
(function () {
    var HC = window.HRMS_CONFIG;
    if (!HC) return;
    if (HC.loginUrl) CONFIG.loginUrl = HC.loginUrl;
    if (HC.tables) {
        for (var k in HC.tables) {
            if (Object.prototype.hasOwnProperty.call(HC.tables, k) && HC.tables[k]) {
                CONFIG.tables[k] = HC.tables[k];
            }
        }
    }
})();

var LEAVE_COLORS = { Casual: '#3B82F6', Sick: '#8B5CF6', Earned: '#F59E0B', Unpaid: '#EC4899' };
var LEAVE_TYPES  = ['Casual', 'Sick', 'Earned', 'Unpaid'];

/* ============================================================
   2. STATE + TINY UTILS
   ============================================================ */

var sb = null, DEMO = true;
var USER = null;        /* localStorage account { id, name, email } */
var PROF = null;        /* employee_profiles row (production) */
var UROW = null;        /* fresh users row (production) */

var state = {
    today: null, todayRec: null,
    profile: null, deptName: '', managerName: '',
    leaves: [], leaveFilter: 'all', summary: [],
    tasks: [], taskFilter: 'all',
    directory: [], depts: [], dirQuery: '', dirDept: '',
    holidays: [], announcements: [], annFilter: 'all',
    notifs: [], notifFilter: 'all',
    messages: [], activities: [],
    calMonth: null,
    confirmCb: null
};

function $(sel, root)  { return (root || document).querySelector(sel); }
function byId(id)      { return document.getElementById(id); }
function $$ (sel, root){ return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function setText(id, v){ var el = byId(id); if (el) el.textContent = v; }

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function initials(name) {
    var p = String(name || '').trim().split(/\s+/);
    return (((p[0] || '')[0] || '') + ((p[1] || '')[0] || '')).toUpperCase() || '?';
}
function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }

function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function monthRange(y, m) { /* m: 0-based */
    var first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
    return { from: todayISO(first), to: todayISO(last), y: y, m: m };
}
function humanDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function clockParts(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return null;
    var h = d.getHours(), mer = h >= 12 ? 'PM' : 'AM', h12 = h % 12; if (!h12) h12 = 12;
    return { time: pad2(h12) + ':' + pad2(d.getMinutes()), mer: mer };
}
function minutesToHm(min) {
    min = Math.max(0, Math.round(min || 0));
    return pad2(Math.floor(min / 60)) + 'h ' + pad2(min % 60) + 'm';
}
function timeAgo(iso) {
    if (!iso) return '';
    var mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1)  return 'Just now';
    if (mins < 60) return mins + ' min ago';
    var h = Math.floor(mins / 60);
    if (h < 24)    return h + (h === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(h / 24);
    if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
    return humanDate(iso);
}
function daysUntil(iso) {
    return Math.round((new Date(iso + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000);
}
function animateNumber(el, target, pad) {
    if (!el) return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var fmt = function (v) {
        var s = String(Math.round(v));
        while (pad && s.length < pad) s = '0' + s;
        return s;
    };
    if (reduce) { el.textContent = fmt(target); return; }
    var duration = 800, start = null;
    function step(ts) {
        if (!start) start = ts;
        var p = Math.min((ts - start) / duration, 1);
        el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

/* ============================================================
   3. DEMO WORKSPACE (localStorage-backed sample data)
   ============================================================ */

var DEMO_KEY = 'hrmsDemoDB_v1';

function demoSeed() {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth();
    function iso(dt) { return new Date(dt).toISOString(); }
    function at(day, h, min) { return iso(new Date(y, m, day, h, min || 0, 0)); }

    /* attendance for the last 25 days (weekdays mostly present) */
    var att = [];
    for (var i = 25; i >= 1; i--) {
        var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        var dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        var absent = (i % 11 === 0);
        if (absent) continue;
        var inH = 9 + (i % 2), inM = (i * 7) % 50;
        var outH = 18 + (i % 2);
        att.push({
            user_id: 1, work_date: todayISO(d),
            check_in: iso(new Date(y, m, d.getDate(), inH, inM)),
            check_out: (i === 1) ? null : iso(new Date(y, m, d.getDate(), outH, 12)),
            break_minutes: 45
        });
    }
    att.push({ user_id: 1, work_date: todayISO(now), check_in: null, check_out: null, break_minutes: 45 });

    return {
        v: 1,
        employees: [
            { id: 1, name: 'Nitin Jangra',  email: 'nitin@hrims.app',   role: 'Employee', phone: '9812345670', designation: 'Senior Developer', dept: 'Engineering' },
            { id: 2, name: 'Priya Nair',    email: 'priya@hrims.app',  role: 'HR',       phone: '9812345671', designation: 'HR Manager',       dept: 'Human Resources' },
            { id: 3, name: 'Aarav Sharma',  email: 'aarav@hrims.app',  role: 'Employee', phone: '9812345672', designation: 'Developer',        dept: 'Engineering' },
            { id: 4, name: 'Sneha Patel',   email: 'sneha@hrims.app',  role: 'Employee', phone: '9812345673', designation: 'Product Designer', dept: 'Design' },
            { id: 5, name: 'Vikram Singh',  email: 'vikram@hrims.app', role: 'Employee', phone: '9812345674', designation: 'DevOps Engineer',  dept: 'Engineering' },
            { id: 6, name: 'Ananya Iyer',   email: 'ananya@hrims.app', role: 'Manager',  phone: '9812345675', designation: 'Product Manager',  dept: 'Product' },
            { id: 7, name: 'Kabir Khan',    email: 'kabir@hrims.app',  role: 'Employee', phone: '9812345676', designation: 'Support Lead',     dept: 'Support' },
            { id: 8, name: 'Rahul Verma',   email: 'rahul@hrims.app',  role: 'Employee', phone: '9812345677', designation: 'QA Engineer',      dept: 'Engineering' }
        ],
        attendance: att,
        leaves: [
            { id: 101, user_id: 1, leave_type: 'Earned', start_date: todayISO(new Date(y, m - 2, 6)),  end_date: todayISO(new Date(y, m - 2, 8)),  days: 3, reason: 'Family function',   status: 'approved', created_at: at(5, 10) },
            { id: 102, user_id: 1, leave_type: 'Sick',   start_date: todayISO(new Date(y, m - 1, 14)), end_date: todayISO(new Date(y, m - 1, 14)), days: 1, reason: 'Fever',             status: 'approved', created_at: at(12, 9) },
            { id: 103, user_id: 1, leave_type: 'Casual', start_date: todayISO(new Date(y, m, 24)),     end_date: todayISO(new Date(y, m, 25)),     days: 2, reason: 'Short trip',        status: 'pending',  created_at: at(15, 11) }
        ],
        tasks: [
            { id: 201, user_id: 1, title: 'Submit Q3 attendance report', status: 'pending',   due_date: todayISO(new Date(y, m, 22)) },
            { id: 202, user_id: 1, title: 'Review onboarding checklist', status: 'pending', due_date: todayISO(new Date(y, m, 26)) },
            { id: 203, user_id: 1, title: 'Update emergency contact',    status: 'pending', due_date: todayISO(new Date(y, m, 30)) },
            { id: 204, user_id: 1, title: 'Complete security training',  status: 'completed', due_date: todayISO(new Date(y, m - 1, 20)) },
            { id: 205, user_id: 1, title: 'Approve team timesheets',     status: 'completed', due_date: todayISO(new Date(y, m - 1, 28)) }
        ],
        holidays: [
            { name: 'Gandhi Jayanti', date: y + '-10-02' },
            { name: 'Diwali',         date: y + '-11-08' },
            { name: 'Christmas',      date: y + '-12-25' },
            { name: 'Republic Day',   date: (y + 1) + '-01-26' },
            { name: 'Holi',           date: (y + 1) + '-03-23' }
        ],
        announcements: [
            { id: 301, title: 'HRMS Workspace is live',  body: 'Attendance, leaves, tasks and announcements are now in one place — explore the sidebar.', type: 'info',     created_at: at(16, 9) },
            { id: 302, title: 'Work-from-home policy updated', body: 'Two days per week are allowed with manager approval, effective this month.', type: 'policy', created_at: at(10, 12) },
            { id: 303, title: 'Happy Birthday, Sneha!',  body: 'Wish Sneha from Design a wonderful day in the team channel.', type: 'birthday', created_at: at(8, 9) },
            { id: 304, title: 'Townhall this Friday',    body: 'Quarterly results, new joins and a product demo. Main hall, 4 PM.', type: 'event', created_at: at(4, 15) }
        ],
        activities: [
            { id: 401, message: 'Your casual leave for the 24th–25th was submitted', type: 'leave',    created_at: at(15, 11) },
            { id: 402, message: 'August payslip is ready to download',               type: 'payslip',  created_at: at(11, 10) },
            { id: 403, message: 'Overtime claim of 1h 35m was approved',             type: 'overtime', created_at: at(9, 17) },
            { id: 404, message: 'Security training task was marked complete',        type: 'task',     created_at: at(6, 16) }
        ],
        notifications: [
            { id: 501, title: 'Payslip available',        message: 'Your August payslip has been generated.',        is_read: false, created_at: at(11, 10) },
            { id: 502, title: 'Leave submitted',          message: 'Casual leave (24th–25th) is pending approval.',  is_read: false, created_at: at(15, 11) },
            { id: 503, title: 'Policy update',            message: 'Work-from-home policy was refreshed.',           is_read: true,  created_at: at(10, 12) },
            { id: 504, title: 'Townhall invite',          message: 'Join the quarterly townhall this Friday.',       is_read: true,  created_at: at(4, 15) }
        ],
        messages: [
            { id: 601, sender_name: 'Priya Nair',  preview: 'Hey, are you joining the standup?',        is_read: false, created_at: at(17, 9) },
            { id: 602, sender_name: 'Ananya Iyer', preview: 'Roadmap doc is ready for review.',          is_read: true,  created_at: at(13, 14) },
            { id: 603, sender_name: 'Vikram Singh',preview: 'Deploy window moved to 9 PM tonight.',      is_read: true,  created_at: at(12, 18) }
        ],
        prefs: { email: true, punch: true, digest: false }
    };
}

function loadDemo() {
    try {
        var raw = localStorage.getItem(DEMO_KEY);
        if (raw) {
            var db = JSON.parse(raw);
            if (db && db.v === 1) return db;
        }
    } catch (e) { /* corrupted → reseed */ }
    var seeded = demoSeed();
    saveDemo(seeded);
    return seeded;
}
function saveDemo(db) {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(db || demoDB)); } catch (e) {}
}
function resetDemo() {
    try { localStorage.removeItem(DEMO_KEY); } catch (e) {}
    demoDB = loadDemo();
}
var demoDB = loadDemo();

function demoNextId(rows) {
    return rows.reduce(function (mx, r) { return Math.max(mx, r.id || 0); }, 0) + 1;
}

/* ============================================================
   4. AUTH — same localStorage model as the rest of the suite
   ============================================================ */

function requireAuth() {
    var raw = null;
    try { raw = localStorage.getItem('loggedInUser'); } catch (e) {}
    if (raw) { try { USER = JSON.parse(raw); } catch (e) { USER = null; } }

    if (!USER || USER.id == null) {
        if (DEMO) {
            USER = { id: 1, name: 'Nitin Jangra', email: 'nitin@hrims.app' };
            return true;
        }
        window.location.href = CONFIG.loginUrl;
        throw new Error('[HRMS] Not signed in');
    }
    return true;
}

function logout() {
    try { localStorage.removeItem('loggedInUser'); } catch (e) {}
    window.location.href = CONFIG.loginUrl;
}

/* ============================================================
   5. DATA LAYER — every function has a demo + production path
   ============================================================ */

var api = {

    /* ---- profile ---------------------------------------------------- */
    profile: async function () {
        if (DEMO) {
            var me = demoDB.employees.filter(function (e) { return e.id === Number(USER.id); })[0] || demoDB.employees[0];
            state.deptName = me.dept;
            state.managerName = 'Priya Nair';
            return {
                user: { id: me.id, name: me.name, email: me.email, phone: me.phone, role: me.role },
                profile: {
                    first_name: me.name.split(' ')[0], last_name: me.name.split(' ').slice(1).join(' '),
                    phone: me.phone, designation: me.designation, dob: '', gender: '', blood_group: '',
                    address: '', city: '', state: '', country: 'India', pincode: '',
                    emergency_contact_name: '', emergency_contact_phone: ''
                }
            };
        }

        var u = await sb.from(CONFIG.tables.users)
            .select('id,name,email,phone,role,department_id,manager_id,joining_date')
            .eq('id', USER.id).maybeSingle();
        if (u.error) console.error('[HRMS] users:', u.error.message);
        UROW = u.data || USER;
        if (!UROW.id) UROW.id = USER.id;

        var p = await sb.from(CONFIG.tables.profiles)
            .select('*').eq('user_id', USER.id).maybeSingle();
        if (p.error) console.error('[HRMS] profiles:', p.error.message);
        PROF = p.data || null;

        state.deptName = ''; state.managerName = '';
        if (UROW.department_id != null) {
            var d = await sb.from(CONFIG.tables.departments)
                .select('name').eq('id', UROW.department_id).maybeSingle();
            if (!d.error && d.data) state.deptName = d.data.name;
        }
        if (UROW.manager_id != null) {
            var mg = await sb.from(CONFIG.tables.users)
                .select('name').eq('id', UROW.manager_id).maybeSingle();
            if (!mg.error && mg.data) state.managerName = mg.data.name;
        }
        return { user: UROW, profile: PROF };
    },

    saveProfile: async function (f) {
        if (DEMO) {
            var me = demoDB.employees.filter(function (e) { return e.id === Number(USER.id); })[0];
            if (me) {
                me.name = ((f.firstName || '') + ' ' + (f.lastName || '')).trim() || me.name;
                me.phone = f.phone || me.phone;
                me.designation = f.designation || me.designation;
                me.dept = f.departmentName || me.dept;
            }
            saveDemo();
            return { ok: true };
        }

        var upd = {
            phone:         f.phone || null,
            department_id: f.departmentId != null ? f.departmentId : null,
            manager_id:    f.managerId != null ? f.managerId : null,
            joining_date:  f.joiningDate || null
        };
        var uRes = await sb.from(CONFIG.tables.users).update(upd).eq('id', USER.id);
        if (uRes.error) return { ok: false, error: uRes.error.message };

        var profRow = {
            user_id: Number(USER.id) == USER.id ? Number(USER.id) : USER.id,
            first_name: f.firstName || '', last_name: f.lastName || '',
            phone: f.phone || '', department_id: f.departmentId || null,
            designation: f.designation || '', manager_id: f.managerId || null,
            joining_date: f.joiningDate || null,
            dob: f.dob || null, gender: f.gender || '', blood_group: f.bloodGroup || '',
            address: f.address || '', city: f.city || '', state: f.state || '',
            country: f.country || '', pincode: f.pincode || '',
            emergency_contact_name: f.emergencyName || '',
            emergency_contact_phone: f.emergencyPhone || ''
        };

        var existing = await sb.from(CONFIG.tables.profiles)
            .select('id').eq('user_id', USER.id).maybeSingle();
        if (existing.error) return { ok: false, error: existing.error.message };

        var res;
        if (existing.data && existing.data.id) {
            res = await sb.from(CONFIG.tables.profiles).update(profRow).eq('id', existing.data.id);
        } else {
            res = await sb.from(CONFIG.tables.profiles).insert([profRow]);
        }
        return res.error ? { ok: false, error: res.error.message } : { ok: true };
    },

    /* ---- attendance -------------------------------------------------- */
    todayAttendance: async function () {
        if (DEMO) {
            var t = todayISO();
            var rec = demoDB.attendance.filter(function (r) {
                return r.user_id === 1 && r.work_date === t;
            })[0];
            if (!rec) { rec = { user_id: 1, work_date: t, check_in: null, check_out: null, break_minutes: 45 }; demoDB.attendance.push(rec); saveDemo(); }
            return rec;
        }
        var res = await sb.from(CONFIG.tables.attendance).select('*')
            .eq('user_id', USER.id).eq('work_date', todayISO()).maybeSingle();
        if (res.error) { console.error('[HRMS] attendance:', res.error.message); return null; }
        return res.data;
    },

    punchIn: async function () {
        var stamp = new Date().toISOString();
        if (DEMO) {
            var t = todayISO();
            var rec = demoDB.attendance.filter(function (r) { return r.user_id === 1 && r.work_date === t; })[0];
            if (!rec) { rec = { user_id: 1, work_date: t, break_minutes: 45 }; demoDB.attendance.push(rec); }
            rec.check_in = stamp; rec.check_out = null;
            saveDemo();
            api.logActivity('Checked in at ' + clockParts(stamp).time + ' ' + clockParts(stamp).mer, 'task');
            return rec;
        }
        var res = await sb.from(CONFIG.tables.attendance)
            .upsert({ user_id: USER.id, work_date: todayISO(), check_in: stamp },
                    { onConflict: 'user_id,work_date' })
            .select().single();
        if (res.error) { throw new Error(res.error.message); }
        api.logActivity('Checked in at ' + clockParts(stamp).time + ' ' + clockParts(stamp).mer, 'task');
        return res.data;
    },

    punchOut: async function () {
        var stamp = new Date().toISOString();
        var brk = (state.todayRec && state.todayRec.break_minutes != null)
            ? state.todayRec.break_minutes : CONFIG.defaultBreakMinutes;
        if (DEMO) {
            var t = todayISO();
            var rec = demoDB.attendance.filter(function (r) { return r.user_id === 1 && r.work_date === t; })[0];
            if (rec) { rec.check_out = stamp; rec.break_minutes = brk; saveDemo(); }
            return rec || { work_date: t, check_out: stamp, break_minutes: brk };
        }
        var res = await sb.from(CONFIG.tables.attendance)
            .update({ check_out: stamp, break_minutes: brk })
            .eq('user_id', USER.id).eq('work_date', todayISO())
            .select().single();
        if (res.error) { throw new Error(res.error.message); }
        return res.data;
    },

    monthAttendance: async function (y, m) {
        var r = monthRange(y, m);
        if (DEMO) {
            return demoDB.attendance.filter(function (a) {
                return a.user_id === 1 && a.work_date >= r.from && a.work_date <= r.to && a.check_in;
            });
        }
        var res = await sb.from(CONFIG.tables.attendance).select('*')
            .eq('user_id', USER.id)
            .gte('work_date', r.from).lte('work_date', r.to)
            .not('check_in', 'is', null);
        if (res.error) { console.error('[HRMS] month attendance:', res.error.message); return []; }
        return res.data || [];
    },

    /* ---- leaves ------------------------------------------------------ */
    myLeaves: async function () {
        if (DEMO) {
            return demoDB.leaves.filter(function (l) { return l.user_id === 1; })
                .slice().sort(function (a, b) { return b.id - a.id; });
        }
        var res = await sb.from(CONFIG.tables.leave_requests).select('*')
            .eq('user_id', USER.id)
            .order('created_at', { ascending: false });
        if (res.error) { console.error('[HRMS] leaves:', res.error.message); return []; }
        return res.data || [];
    },

    applyLeave: async function (f) {
        if (DEMO) {
            var row = {
                id: demoNextId(demoDB.leaves), user_id: 1,
                leave_type: f.type, start_date: f.start, end_date: f.end,
                days: f.days, reason: f.reason || '', status: 'pending',
                created_at: new Date().toISOString()
            };
            demoDB.leaves.push(row); saveDemo();
            api.logActivity('Applied for ' + f.type.toLowerCase() + ' leave (' + f.days + ' day' + (f.days > 1 ? 's' : '') + ')', 'leave');
            return row;
        }
        var res = await sb.from(CONFIG.tables.leave_requests)
            .insert({
                user_id: USER.id, leave_type: f.type,
                start_date: f.start, end_date: f.end,
                days: f.days, reason: f.reason || '', status: 'pending'
            })
            .select().single();
        if (res.error) throw new Error(res.error.message);
        api.logActivity('Applied for ' + f.type.toLowerCase() + ' leave (' + f.days + ' day' + (f.days > 1 ? 's' : '') + ')', 'leave');
        return res.data;
    },

    cancelLeave: async function (id) {
        if (DEMO) {
            demoDB.leaves = demoDB.leaves.filter(function (l) { return !(l.id === id && l.status === 'pending'); });
            saveDemo();
            return { ok: true };
        }
        var res = await sb.from(CONFIG.tables.leave_requests)
            .delete()
            .eq('id', id).eq('user_id', USER.id).eq('status', 'pending');
        return res.error ? { ok: false, error: res.error.message } : { ok: true };
    },

    /* ---- stats ------------------------------------------------------- */
    stats: async function () {
        var r = monthRange(new Date().getFullYear(), new Date().getMonth());
        if (DEMO) {
            var present = demoDB.attendance.filter(function (a) {
                return a.user_id === 1 && a.check_in && a.work_date >= r.from && a.work_date <= r.to;
            }).length;
            var leaveDays = demoDB.leaves.filter(function (l) {
                return l.user_id === 1 && l.status === 'approved' && l.start_date >= r.from && l.start_date <= r.to;
            }).reduce(function (s, l) { return s + (Number(l.days) || 0); }, 0);
            var open = demoDB.tasks.filter(function (t) { return t.user_id === 1 && t.status !== 'completed'; }).length;
            return { presentDays: present, leaveDays: leaveDays, overtimeMin: 95, openTasks: open };
        }

        var T = CONFIG.tables, self = this;
        var out = { presentDays: 0, leaveDays: 0, overtimeMin: 0, openTasks: 0 };

        var jobs = await Promise.allSettled([
            sb.from(T.attendance).select('*', { count: 'exact', head: true })
                .eq('user_id', USER.id)
                .gte('work_date', r.from).lte('work_date', r.to)
                .not('check_in', 'is', null),
            sb.from(T.leaveRequests).select('days')
                .eq('user_id', USER.id).eq('status', 'approved')
                .gte('start_date', r.from).lte('start_date', r.to),
            sb.from(T.overtime).select('minutes')
                .eq('user_id', USER.id).eq('status', 'approved')
                .gte('created_at', r.from + 'T00:00:00'),
            sb.from(T.tasks).select('*', { count: 'exact', head: true })
                .eq('user_id', USER.id).neq('status', 'completed')
        ]);

        if (jobs[0].status === 'fulfilled' && !jobs[0].value.error) out.presentDays = jobs[0].value.count || 0;
        if (jobs[1].status === 'fulfilled' && !jobs[1].value.error) {
            out.leaveDays = (jobs[1].value.data || []).reduce(function (s, x) { return s + (Number(x.days) || 0); }, 0);
        }
        if (jobs[2].status === 'fulfilled' && !jobs[2].value.error) {
            out.overtimeMin = (jobs[2].value.data || []).reduce(function (s, x) { return s + (Number(x.minutes) || 0); }, 0);
        }
        if (jobs[3].status === 'fulfilled' && !jobs[3].value.error) out.openTasks = jobs[3].value.count || 0;
        return out;
    },

    /* ---- activity ---------------------------------------------------- */
    activities: async function (limit) {
        limit = limit || 5;
        if (DEMO) {
            return demoDB.activities.slice().sort(function (a, b) { return b.id - a.id; }).slice(0, limit);
        }
        var res = await sb.from(CONFIG.tables.activities).select('*')
            .eq('user_id', USER.id)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (res.error) { console.error('[HRMS] activities:', res.error.message); return []; }
        return res.data || [];
    },

    logActivity: function (message, type) {
        if (DEMO) {
            demoDB.activities.unshift({ id: demoNextId(demoDB.activities), message: message, type: type || 'task', created_at: new Date().toISOString() });
            demoDB.activities = demoDB.activities.slice(0, 30);
            saveDemo();
            return;
        }
        sb.from(CONFIG.tables.activities).insert({ user_id: USER.id, message: message, type: type || 'task' })
            .then(function () {}, function () {});
    },

    /* ---- holidays + announcements ------------------------------------- */
    holidays: async function () {
        var t = todayISO();
        if (DEMO) {
            return demoDB.holidays.filter(function (h) { return h.date >= t; })
                .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
        }
        var res = await sb.from(CONFIG.tables.holidays).select('name,date')
            .gte('date', t).order('date', { ascending: true });
        if (res.error) { console.error('[HRMS] holidays:', res.error.message); return []; }
        return res.data || [];
    },

    announcements: async function () {
        if (DEMO) {
            return demoDB.announcements.slice().sort(function (a, b) { return b.id - a.id; });
        }
        var res = await sb.from(CONFIG.tables.announcements).select('*')
            .order('created_at', { ascending: false }).limit(30);
        if (res.error) { console.error('[HRMS] announcements:', res.error.message); return []; }
        return res.data || [];
    },

    /* ---- directory ---------------------------------------------------- */
    directory: async function () {
        if (DEMO) {
            return demoDB.employees.map(function (e) {
                return { id: e.id, name: e.name, email: e.email, role: e.role,
                         phone: e.phone, designation: e.designation, dept: e.dept };
            });
        }
        var uRes = await sb.from(CONFIG.tables.users)
            .select('id,name,email,role,phone,department_id').order('name');
        if (uRes.error) { console.error('[HRMS] directory:', uRes.error.message); return []; }
        var dRes = await sb.from(CONFIG.tables.departments).select('id,name');
        var pRes = await sb.from(CONFIG.tables.profiles).select('user_id,designation');
        var dmap = {}, pmap = {};
        if (!dRes.error) (dRes.data || []).forEach(function (d) { dmap[d.id] = d.name; });
        if (!pRes.error) (pRes.data || []).forEach(function (p) { pmap[p.user_id] = p.designation; });
        return (uRes.data || []).map(function (u) {
            return { id: u.id, name: u.name, email: u.email, role: u.role,
                     phone: u.phone, designation: pmap[u.id] || '',
                     dept: dmap[u.department_id] || '—' };
        });
    },

    departments: async function () {
        if (DEMO) {
            var seen = {}, out = [];
            demoDB.employees.forEach(function (e) {
                if (!seen[e.dept]) { seen[e.dept] = 1; out.push({ id: e.dept, name: e.dept }); }
            });
            return out;
        }
        var res = await sb.from(CONFIG.tables.departments).select('id,name').order('name');
        if (res.error) { console.error('[HRMS] departments:', res.error.message); return []; }
        return res.data || [];
    },

    managers: async function () {
        if (DEMO) {
            return demoDB.employees.filter(function (e) { return e.id !== Number(USER.id); })
                .map(function (e) { return { id: e.id, name: e.name }; });
        }
        var res = await sb.from(CONFIG.tables.users).select('id,name').neq('id', USER.id).order('name');
        if (res.error) { console.error('[HRMS] managers:', res.error.message); return []; }
        return res.data || [];
    },

    /* ---- tasks -------------------------------------------------------- */
    tasks: async function () {
        if (DEMO) {
            return demoDB.tasks.filter(function (t) { return t.user_id === 1; })
                .sort(function (a, b) { return a.status === b.status ? b.id - a.id : (a.status === 'completed' ? 1 : -1); });
        }
        var res = await sb.from(CONFIG.tables.tasks).select('*')
            .eq('user_id', USER.id)
            .order('created_at', { ascending: false });
        if (res.error) { console.error('[HRMS] tasks:', res.error.message); return []; }
        return (res.data || []).sort(function (a, b) { return a.status === b.status ? 0 : (a.status === 'completed' ? 1 : -1); });
    },

    addTask: async function (title, due) {
        if (DEMO) {
            var row = { id: demoNextId(demoDB.tasks), user_id: 1, title: title, status: 'pending', due_date: due || null };
            demoDB.tasks.unshift(row); saveDemo();
            return row;
        }
        var res = await sb.from(CONFIG.tables.tasks)
            .insert({ user_id: USER.id, title: title, status: 'pending', due_date: due || null })
            .select().single();
        if (res.error) throw new Error(res.error.message);
        return res.data;
    },

    setTaskStatus: async function (id, status) {
        if (DEMO) {
            demoDB.tasks.forEach(function (t) { if (t.id === id) t.status = status; });
            saveDemo();
            return { ok: true };
        }
        var res = await sb.from(CONFIG.tables.tasks).update({ status: status }).eq('id', id).eq('user_id', USER.id);
        return res.error ? { ok: false, error: res.error.message } : { ok: true };
    },

    deleteTask: async function (id) {
        if (DEMO) {
            demoDB.tasks = demoDB.tasks.filter(function (t) { return t.id !== id; });
            saveDemo();
            return { ok: true };
        }
        var res = await sb.from(CONFIG.tables.tasks).delete().eq('id', id).eq('user_id', USER.id);
        return res.error ? { ok: false, error: res.error.message } : { ok: true };
    },

    /* ---- notifications + messages -------------------------------------- */
    notifications: async function () {
        if (DEMO) {
            return demoDB.notifications.slice().sort(function (a, b) { return b.id - a.id; });
        }
        var res = await sb.from(CONFIG.tables.notifications).select('*')
            .eq('user_id', USER.id)
            .order('created_at', { ascending: false }).limit(30);
        if (res.error) { console.error('[HRMS] notifications:', res.error.message); return []; }
        return res.data || [];
    },

    markNotification: async function (id) {
        if (DEMO) {
            demoDB.notifications.forEach(function (n) { if (n.id === id) n.is_read = true; });
            saveDemo();
            return;
        }
        sb.from(CONFIG.tables.notifications).update({ is_read: true }).eq('id', id).then(function () {}, function () {});
    },

    markAllNotifications: async function () {
        if (DEMO) {
            demoDB.notifications.forEach(function (n) { n.is_read = true; });
            saveDemo();
            return;
        }
        sb.from(CONFIG.tables.notifications).update({ is_read: true }).eq('user_id', USER.id).then(function () {}, function () {});
    },

    messages: async function () {
        if (DEMO) {
            return demoDB.messages.slice().sort(function (a, b) { return b.id - a.id; });
        }
        var res = await sb.from(CONFIG.tables.messages).select('*')
            .eq('user_id', USER.id)
            .order('created_at', { ascending: false }).limit(30);
        if (res.error) { console.error('[HRMS] messages:', res.error.message); return []; }
        return res.data || [];
    },

    markMessage: async function (id) {
        if (DEMO) {
            demoDB.messages.forEach(function (m) { if (m.id === id) m.is_read = true; });
            saveDemo();
            return;
        }
        sb.from(CONFIG.tables.messages).update({ is_read: true }).eq('id', id).then(function () {}, function () {});
    }
};

/* ============================================================
   6. UI HELPERS — toast · drawers · modals · confirm
   ============================================================ */

function toast(msg, type, ms) {
    var stack = byId('toastStack');
    if (!stack) return;
    var icons = { success: 'check', error: 'x', info: 'info' };
    type = icons[type] ? type : 'info';
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = '<span class="toast-ico"><i data-lucide="' + icons[type] + '"></i></span><span>' + esc(msg) + '</span>';
    stack.appendChild(el);
    refreshIcons();
    setTimeout(function () {
        el.classList.add('out');
        setTimeout(function () { el.remove(); }, 320);
    }, ms || 2600);
}

function openDrawer(id) {
    closeDrawers();
    var w = byId(id);
    if (w) { w.classList.add('open'); w.setAttribute('aria-hidden', 'false'); document.body.classList.add('no-scroll'); }
}
function closeDrawers() {
    $$('.drawer-wrap.open').forEach(function (w) { w.classList.remove('open'); w.setAttribute('aria-hidden', 'true'); });
    if (!$('.modal-wrap.open')) document.body.classList.remove('no-scroll');
}
function openModal(id) {
    var w = byId(id);
    if (w) { w.classList.add('open'); w.setAttribute('aria-hidden', 'false'); document.body.classList.add('no-scroll'); refreshIcons(); }
}
function closeModal(id) {
    var w = byId(id);
    if (w) { w.classList.remove('open'); w.setAttribute('aria-hidden', 'true'); }
    if (!$('.modal-wrap.open') && !$('.drawer-wrap.open')) document.body.classList.remove('no-scroll');
}
function closeAllLayers() {
    closeDrawers();
    $$('.modal-wrap.open').forEach(function (w) { w.classList.remove('open'); w.setAttribute('aria-hidden', 'true'); });
    byId('userMenu') && byId('userMenu').classList.remove('open');
    byId('searchResults') && byId('searchResults').classList.remove('open');
    document.body.classList.remove('no-scroll');
}

function askConfirm(title, msg, cb) {
    setText('confirmTitle', title || 'Are you sure?');
    setText('confirmMsg', msg || 'This action cannot be undone.');
    state.confirmCb = cb || null;
    openModal('confirmModal');
}

function btnLoading(btn, on) { if (btn) btn.classList.toggle('loading', !!on); }
function setBusy(btn, labelEl, busy, busyText, idleText) {
    btnLoading(btn, busy);
    if (labelEl) labelEl.textContent = busy ? busyText : idleText;
    if (btn) btn.disabled = busy;
}

/* ============================================================
   7. ROUTER
   ============================================================ */

var ROUTES = ['dashboard', 'attendance', 'leaves', 'directory', 'tasks',
              'holidays', 'announcements', 'profile', 'settings'];

var VIEW_LOADERS = {};   /* filled by each view section below */

function currentRoute() {
    var h = String(location.hash || '').replace(/^#\/?/, '');
    return ROUTES.indexOf(h) >= 0 ? h : 'dashboard';
}

function render(route) {
    /* view visibility */
    $$('.view').forEach(function (v) {
        v.classList.toggle('active', v.getAttribute('data-view') === route);
    });

    /* nav active states (sidebar + bottom) */
    $$('[data-route]').forEach(function (a) {
        a.classList.toggle('active', a.getAttribute('data-route') === route);
    });

    /* close transient layers + mobile sidebar */
    byId('sidebar') && byId('sidebar').classList.remove('open');
    byId('sidebarOverlay') && byId('sidebarOverlay').classList.remove('show');
    byId('userMenu') && byId('userMenu').classList.remove('open');
    window.scrollTo({ top: 0, behavior: 'auto' });

    refreshIcons();
    if (VIEW_LOADERS[route]) VIEW_LOADERS[route]();
}

function navigate(route) {
    if (currentRoute() === route && $('.view[data-view="' + route + '"]').classList.contains('active')) {
        VIEW_LOADERS[route] && VIEW_LOADERS[route]();
    } else {
        location.hash = '#/' + route;
    }
}

/* ============================================================
   8. IDENTITY (topbar · greeting · sidebar mode card)
   ============================================================ */

function applyIdentity() {
    var name = (state.profile && (state.profile.first_name || state.profile.last_name))
        ? ((state.profile.first_name || '') + ' ' + (state.profile.last_name || '')).trim()
        : (USER.name || '');

    setText('topbarName', name || '—');
    setText('topbarRole', (state.profile && state.profile.designation) || state.deptName || '');
    setText('topbarAvatar', initials(name));

    var h = new Date().getHours();
    var g = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    setText('greetTitle', g + ', ' + (String(name).trim().split(/\s+/)[0] || 'there') + '!');

    setText('greetDate', new Date().toLocaleDateString('en-GB',
        { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    setText('attDay', new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }));

    setText('setAccountName', name || '—');
    setText('setAccountEmail', USER.email || '—');
    setText('setAccountRole', UROW && UROW.role ? UROW.role : 'Employee');
    setText('setAvatar', initials(name));

    var mode = byId('setDataMode');
    if (mode) {
        mode.textContent = DEMO ? 'Demo workspace' : 'Connected to Supabase';
        mode.className = 'mode-pill ' + (DEMO ? 'demo' : 'live');
    }
    setText('setDataNote', DEMO
        ? 'Sample data stored in this browser. Paste your URL + anon key in supabase.js to go live.'
        : 'Reads and writes go live to your Supabase project.');
    setText('sideDataMode', DEMO ? 'Demo workspace' : 'Supabase connected');
    setText('sideDataNote', DEMO ? 'Sample data — connect Supabase in supabase.js' : 'Live data from your database');
}

/* ============================================================
   9. ATTENDANCE STATE (shared by dashboard + attendance views)
   ============================================================ */

function setAttTime(sel, iso) {
    $$(sel).forEach(function (el) {
        var c = clockParts(iso);
        if (c) el.innerHTML = esc(c.time) + ' <small>' + c.mer + '</small>';
        else el.innerHTML = '--:-- <small>--</small>';
        el.classList.toggle('dim', !c);
    });
}

function applyAttendance(rec) {
    state.todayRec = rec || null;
    var hasIn  = !!(rec && rec.check_in);
    var hasOut = !!(rec && rec.check_out);

    setAttTime('.js-att-checkin', hasIn ? rec.check_in : null);
    setAttTime('.js-att-checkout', hasOut ? rec.check_out : null);

    $$('.js-att-pill').forEach(function (p) {
        p.textContent = hasIn ? 'Present' : 'Not Checked In';
        p.classList.toggle('pill-present', hasIn);
        p.classList.toggle('pill-absent', !hasIn);
    });
    $$('.js-att-indate').forEach(function (el) {
        el.textContent = hasIn ? humanDate(rec.check_in) : '—';
    });
    $$('.js-att-outsub').forEach(function (el) {
        el.textContent = hasOut ? 'Checked Out' : 'Not Checked Out';
    });

    var brk = rec && rec.break_minutes != null ? rec.break_minutes : CONFIG.defaultBreakMinutes;
    var work = '00h 00m';
    if (hasIn && hasOut) {
        work = minutesToHm((new Date(rec.check_out) - new Date(rec.check_in)) / 60000 - brk);
    }
    $$('.js-att-work').forEach(function (el) { el.textContent = work; });
    $$('.js-att-break').forEach(function (el) { el.textContent = minutesToHm(brk); });

    /* punch buttons */
    $$('.js-punch-in').forEach(function (b) {
        b.disabled = hasIn;
        b.classList.remove('loading');
        b.classList.toggle('can-punch', !hasIn);
        var lbl = b.querySelector('.btn-label');
        if (lbl) lbl.textContent = hasIn ? 'Checked In ✓' : 'Check In';
    });
    $$('.js-punch-out').forEach(function (b) {
        b.disabled = !hasIn || hasOut;
        b.classList.remove('loading');
        var lbl = b.querySelector('.btn-label');
        if (lbl) lbl.textContent = hasOut ? 'Checked Out ✓' : 'Check Out';
    });

    var toggle = byId('punchToggleLabel');
    if (toggle) toggle.textContent = !hasIn ? 'Check In' : (hasOut ? 'Checked Out ✓' : 'Check Out');
}

async function doPunch(mode, btn) {
    if (!DEMO && !sb) return;
    btnLoading(btn, true);
    try {
        var rec = mode === 'in' ? await api.punchIn() : await api.punchOut();
        applyAttendance(rec);
        if (mode === 'in') toast('Checked in at ' + clockParts(rec.check_in).time + ' ' + clockParts(rec.check_in).mer, 'success');
        else toast('Checked out — see you tomorrow!', 'success');
        refreshAfterPunch();
    } catch (e) {
        console.error('[HRMS] punch failed:', e.message || e);
        toast('Punch failed: ' + (e.message || 'unknown error'), 'error');
        btnLoading(btn, false);
    }
    refreshIcons();
}

function refreshAfterPunch() {
    var route = currentRoute();
    if (route === 'attendance') VIEW_LOADERS.attendance();
    loadBadges();
    loadDashboardLite();
}

/* ============================================================
   10. VIEW: DASHBOARD
   ============================================================ */

function donutUpdate(items) {
    var svg = $('.donut');
    if (!svg) return;
    var segs = $$('.donut-seg', svg);
    var C = 2 * Math.PI * 54, PAD = 3;
    var total = items.reduce(function (s, it) { return s + (Number(it.days) || 0); }, 0);
    setText('donutTotal', String(Math.round(total * 10) / 10));

    var acc = 0;
    segs.forEach(function (seg, i) {
        var it = items[i];
        if (!it || !it.days) { seg.style.display = 'none'; return; }
        seg.style.display = '';
        var frac = total ? it.days / total : 0;
        var dash = Math.max(frac * C - PAD, 0.6);
        seg.setAttribute('stroke', it.color || LEAVE_COLORS[it.name] || '#3B82F6');
        seg.setAttribute('stroke-dasharray', dash.toFixed(2) + ' ' + (C - dash).toFixed(2));
        seg.setAttribute('stroke-dashoffset', (-acc).toFixed(2));
        acc += frac * C;
    });
}

function renderLegend(items) {
    var wrap = byId('leaveLegend');
    if (!wrap) return;
    wrap.innerHTML = items.length
        ? items.map(function (it) {
            return '<div class="lg-row">' +
                '<span class="lg-dot" style="--c:' + (it.color || LEAVE_COLORS[it.name]) + '"></span>' +
                '<span class="lg-name">' + esc(it.name) + '</span><b>' + pad2(it.days) + ' d</b></div>';
        }).join('')
        : '<p class="empty" style="padding:10px">No approved leaves yet</p>';
}

function renderHolidaysPreview(list) {
    var wrap = byId('holidayList');
    if (!wrap) return;
    if (!list.length) {
        wrap.innerHTML = '<p class="empty">No upcoming holidays</p>';
        return;
    }
    wrap.innerHTML = list.slice(0, 3).map(function (h) {
        var d = new Date(h.date + 'T00:00:00');
        var n = daysUntil(h.date);
        var chip = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : 'In ' + n + ' days';
        return '<div class="h-row">' +
            '<span class="h-date">' + d.getDate() + '<small>' +
            d.toLocaleDateString('en-GB', { month: 'short' }) + '</small></span>' +
            '<span class="h-meta"><b>' + esc(h.name) + '</b><small>' +
            d.toLocaleDateString('en-GB', { weekday: 'long' }) + '</small></span>' +
            '<span class="h-chip">' + chip + '</span></div>';
    }).join('');
}

var ANN_ICONS = { info: ['info', 'ic-blue'], policy: ['file-text', 'ic-purple'], birthday: ['cake', 'ic-pink'], event: ['party-popper', 'ic-teal'] };

function renderAnnouncementsPreview(list) {
    var wrap = byId('annList');
    if (!wrap) return;
    if (!list.length) { wrap.innerHTML = '<p class="empty">Nothing new</p>'; return; }
    wrap.innerHTML = list.slice(0, 3).map(function (a) {
        var ic = ANN_ICONS[a.type] || ANN_ICONS.info;
        return '<div class="a-row">' +
            '<span class="a-ico ' + ic[1] + '"><i data-lucide="' + ic[0] + '"></i></span>' +
            '<span class="a-meta"><b>' + esc(a.title) + '</b><p>' + esc(a.body || '') + '</p></span></div>';
    }).join('');
}

function renderActivity(list) {
    var wrap = byId('activityList');
    if (!wrap) return;
    var icons = { leave: 'plane', payslip: 'wallet', overtime: 'clock-4', task: 'check-circle-2' };
    if (!list.length) { wrap.innerHTML = '<p class="empty">No recent activity</p>'; return; }
    wrap.innerHTML = list.slice(0, 4).map(function (a) {
        return '<div class="act-row">' +
            '<span class="act-dot"><i data-lucide="' + (icons[a.type] || 'activity') + '"></i></span>' +
            '<p>' + esc(a.message) + '</p><time>' + esc(timeAgo(a.created_at)) + '</time></div>';
    }).join('');
}

async function loadDashboardLite() {
    /* lightweight refresh of widgets that change after actions */
    var s = await api.stats();
    animateNumber(byId('statPresentDays'), s.presentDays);
    animateNumber(byId('statLeaves'), s.leaveDays);
    setText('statOvertime', minutesToHm(s.overtimeMin));
    animateNumber(byId('statTasks'), s.openTasks, 2);

    var acts = await api.activities(4);
    renderActivity(acts);
}

VIEW_LOADERS.dashboard = async function () {
    applyIdentity();
    var jobs = await Promise.allSettled([
        api.stats(), api.myLeaves(), api.holidays(), api.announcements(), api.activities(4)
    ]);

    if (jobs[0].status === 'fulfilled') {
        var s = jobs[0].value;
        animateNumber(byId('statPresentDays'), s.presentDays);
        animateNumber(byId('statLeaves'), s.leaveDays);
        setText('statOvertime', minutesToHm(s.overtimeMin));
        animateNumber(byId('statTasks'), s.openTasks, 2);
    }
    if (jobs[1].status === 'fulfilled') {
        state.leaves = jobs[1].value;
        var taken = {};
        state.leaves.forEach(function (l) {
            if (l.status !== 'approved') return;
            var k = l.leave_type || 'Unpaid';
            taken[k] = (taken[k] || 0) + (Number(l.days) || 0);
        });
        var items = LEAVE_TYPES
            .map(function (t) { return { name: t, days: taken[t] || 0, color: LEAVE_COLORS[t] }; })
            .filter(function (x) { return x.days > 0; });
        donutUpdate(items);
        renderLegend(items);
    }
    if (jobs[2].status === 'fulfilled') renderHolidaysPreview(jobs[2].value);
    if (jobs[3].status === 'fulfilled') renderAnnouncementsPreview(jobs[3].value);
    if (jobs[4].status === 'fulfilled') renderActivity(jobs[4].value);
    refreshIcons();
};

/* ============================================================
   11. VIEW: ATTENDANCE (stats · calendar · history)
   ============================================================ */

function renderCalendar(y, m, attRows, leaveRows) {
    var wrap = byId('attCalendar');
    if (!wrap) return;
    setText('calTitle', new Date(y, m, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }));

    var byDate = {};
    attRows.forEach(function (a) { byDate[a.work_date] = a; });

    var leaveDates = {};
    (leaveRows || []).forEach(function (l) {
        if (l.status !== 'approved') return;
        var d = new Date(l.start_date + 'T00:00:00'), end = new Date(l.end_date + 'T00:00:00');
        while (d <= end) { leaveDates[todayISO(d)] = true; d.setDate(d.getDate() + 1); }
    });

    var first = new Date(y, m, 1);
    var lead = first.getDay();                     /* 0 = Sunday */
    var daysIn = new Date(y, m + 1, 0).getDate();
    var tISO = todayISO();
    var html = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(function (d) {
        return '<span class="cal-dow">' + d + '</span>';
    }).join('');

    for (var i = 0; i < lead; i++) html += '<span class="cal-day out"></span>';

    for (var day = 1; day <= daysIn; day++) {
        var dISO = todayISO(new Date(y, m, day));
        var dow = new Date(y, m, day).getDay();
        var cls = 'cal-day', title = '';

        if (byDate[dISO]) {
            var a = byDate[dISO];
            if (a.check_in && a.check_out) {
                var mins = (new Date(a.check_out) - new Date(a.check_in)) / 60000 - (a.break_minutes || 45);
                if (mins >= 360) { cls += ' present'; title = 'Full day'; }
                else { cls += ' short'; title = minutesToHm(mins); }
            } else { cls += ' short'; title = 'Checked in'; }
        } else if (leaveDates[dISO]) {
            cls += ' leave'; title = 'On leave';
        } else if (dow === 0 || dow === 6) {
            cls += ' weekend';
        }
        if (dISO === tISO) cls += ' today';

        html += '<span class="' + cls + '" title="' + esc(title) + '">' + day +
                (byDate[dISO] || leaveDates[dISO] ? '<i class="d-dot"></i>' : '') + '</span>';
    }
    wrap.innerHTML = html;
}

function renderAttHistory(rows) {
    var tb = byId('attHistory');
    if (!tb) return;
    if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="5"><p class="empty">No records this month</p></td></tr>';
        return;
    }
    var sorted = rows.slice().sort(function (a, b) { return a.work_date < b.work_date ? 1 : -1; });
    tb.innerHTML = sorted.slice(0, 10).map(function (a) {
        var inC = clockParts(a.check_in), outC = clockParts(a.check_out);
        var work = a.check_in && a.check_out
            ? minutesToHm((new Date(a.check_out) - new Date(a.check_in)) / 60000 - (a.break_minutes || 45))
            : 'In progress';
        return '<tr><td>' + humanDate(a.work_date) + '</td>' +
            '<td>' + (inC ? inC.time + ' ' + inC.mer : '—') + '</td>' +
            '<td>' + (outC ? outC.time + ' ' + outC.mer : '—') + '</td>' +
            '<td>' + work + '</td>' +
            '<td>' + (a.check_out
                ? '<span class="status-chip st-approved">Complete</span>'
                : '<span class="status-chip st-pending">Working</span>') + '</td></tr>';
    }).join('');
}

VIEW_LOADERS.attendance = async function () {
    applyIdentity();
    if (!state.calMonth) {
        var n = new Date();
        state.calMonth = { y: n.getFullYear(), m: n.getMonth() };
    }
    var c = state.calMonth;
    var res = await Promise.allSettled([
        api.monthAttendance(c.y, c.m), api.myLeaves(), api.todayAttendance()
    ]);

    var rows = res[0].status === 'fulfilled' ? res[0].value : [];
    var leaves = res[1].status === 'fulfilled' ? res[1].value : [];
    if (res[2].status === 'fulfilled') applyAttendance(res[2].value);

    renderCalendar(c.y, c.m, rows, leaves);
    renderAttHistory(rows);

    /* month stats */
    var workMins = rows.filter(function (r) { return r.check_in && r.check_out; }).map(function (r) {
        return (new Date(r.check_out) - new Date(r.check_in)) / 60000 - (r.break_minutes || 45);
    });
    animateNumber(byId('attMonthPresent'), rows.length);
    var onLeave = leaves.filter(function (l) {
        return l.status === 'approved' &&
            l.start_date <= monthRange(c.y, c.m).to && l.end_date >= monthRange(c.y, c.m).from;
    }).reduce(function (s, l) { return s + (Number(l.days) || 0); }, 0);
    animateNumber(byId('attMonthLeave'), onLeave);
    setText('attMonthAvg', workMins.length
        ? minutesToHm(workMins.reduce(function (a, b) { return a + b; }, 0) / workMins.length)
        : '00h 00m');

    /* streak: consecutive present days ending today/yesterday */
    var set = {}; rows.forEach(function (r) { set[r.work_date] = 1; });
    var streak = 0, cursor = new Date();
    while (set[todayISO(cursor)] || cursor.getDay() === 0 || cursor.getDay() === 6) {
        if (set[todayISO(cursor)]) streak++;
        cursor.setDate(cursor.getDate() - 1);
        if (streak > 60) break;
    }
    animateNumber(byId('attStreak'), streak);
    refreshIcons();
};

/* ============================================================
   12. VIEW: LEAVES (balance cards · apply modal · requests table)
   ============================================================ */

function renderLeaveCards(summary) {
    var wrap = byId('leaveCards');
    if (!wrap) return;
    wrap.innerHTML = summary.map(function (s) {
        var alloc = s.alloc == null ? '—' : s.alloc;
        var pct = s.alloc ? Math.min(100, (s.taken / s.alloc) * 100) : (s.taken ? 100 : 0);
        return '<div class="lb-card" style="--c:' + (LEAVE_COLORS[s.type] || '#3B82F6') + '">' +
            '<span class="lb-type">' + esc(s.type) + ' Leave</span>' +
            '<div class="lb-nums"><b>' + (s.remaining < 0 ? 0 : s.remaining) + '</b>' +
            '<span>of ' + alloc + ' left</span></div>' +
            '<div class="lb-bar"><i style="width:' + pct + '%"></i></div>' +
            '<div class="lb-foot"><span>' + s.taken + ' taken</span><span>' +
            (s.alloc == null ? 'no cap' : s.alloc + ' allotted') + '</span></div></div>';
    }).join('');
}

function renderLeaveTable() {
    var tb = byId('leaveTable');
    if (!tb) return;
    var rows = state.leaves.filter(function (l) {
        return state.leaveFilter === 'all' || l.status === state.leaveFilter;
    });
    if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="7"><p class="empty">No leave requests' +
            (state.leaveFilter !== 'all' ? ' in this filter' : ' yet — apply for one!') + '</p></td></tr>';
        return;
    }
    tb.innerHTML = rows.map(function (l) {
        var cancel = l.status === 'pending'
            ? '<button class="icon-btn tiny danger" data-action="cancel-leave" data-id="' + l.id + '" title="Cancel request"><i data-lucide="trash-2"></i></button>'
            : '';
        return '<tr><td><b>' + esc(l.leave_type) + '</b></td>' +
            '<td>' + humanDate(l.start_date) + '</td>' +
            '<td>' + humanDate(l.end_date) + '</td>' +
            '<td>' + Number(l.days) + '</td>' +
            '<td>' + esc(l.reason || '—') + '</td>' +
            '<td><span class="status-chip st-' + esc(l.status) + '">' + esc(l.status) + '</span></td>' +
            '<td><div class="row-actions">' + cancel + '</div></td></tr>';
    }).join('');
    refreshIcons();
}

async function refreshLeaveData() {
    var leaves = await api.myLeaves();
    state.leaves = leaves;
    var taken = {};
    leaves.forEach(function (l) {
        if (l.status !== 'approved') return;
        var k = l.leave_type || 'Unpaid';
        taken[k] = (taken[k] || 0) + (Number(l.days) || 0);
    });
    state.summary = LEAVE_TYPES.map(function (t) {
        var alloc = CONFIG.leaveAlloc[t];
        return { type: t, taken: taken[t] || 0, alloc: alloc, remaining: alloc == null ? Infinity : alloc - (taken[t] || 0) };
    });
    renderLeaveCards(state.summary);
    renderLeaveTable();
}

function calcLeaveDays(startISO, endISO) {
    if (!startISO || !endISO) return 0;
    var s = new Date(startISO + 'T00:00:00'), e = new Date(endISO + 'T00:00:00');
    if (isNaN(s) || isNaN(e) || e < s) return 0;
    var n = 0, d = new Date(s);
    while (d <= e) {
        var dow = d.getDay();
        if (dow !== 0 && dow !== 6) n++;      /* skip weekends */
        d.setDate(d.getDate() + 1);
    }
    return n || (Math.round((e - s) / 86400000) + 1);   /* all-weekend range counts itself */
}

function openLeaveModal() {
    var f = byId('leaveForm');
    if (f) f.reset();
    var t = todayISO();
    byId('leaveStart').min = t;
    byId('leaveEnd').min = t;
    byId('leaveStart').value = t;
    byId('leaveEnd').value = t;
    setText('leaveDays', '1 day');
    $$('#leaveForm .field').forEach(function (el) { el.classList.remove('invalid'); });
    openModal('leaveModal');
}

async function submitLeave() {
    var f = byId('leaveForm');
    var type = byId('leaveType').value;
    var start = byId('leaveStart').value;
    var end = byId('leaveEnd').value;
    var reason = byId('leaveReason').value.trim();

    $$('#leaveForm .field').forEach(function (el) { el.classList.remove('invalid', 'shake'); });
    var bad = false;
    if (!start) { markInvalid('leaveStart'); bad = true; }
    if (!end)   { markInvalid('leaveEnd');   bad = true; }
    if (start && end && end < start) {
        markInvalid('leaveEnd');
        byId('leaveEnd').closest('.field').classList.add('shake');
        toast('“To” date must be after “From” date', 'error');
        return;
    }
    if (bad) { toast('Please pick both dates', 'error'); return; }

    var days = calcLeaveDays(start, end);

    var btn = byId('leaveSubmitBtn');
    setBusy(btn, byId('leaveSubmitLabel'), true, 'Submitting…', 'Submit Request');
    try {
        await api.applyLeave({ type: type, start: start, end: end, days: days, reason: reason });
        closeModal('leaveModal');
        toast('Leave request submitted — pending approval', 'success');
        await refreshLeaveData();
        loadDashboardLite();
    } catch (e) {
        console.error('[HRMS] applyLeave:', e.message || e);
        toast('Could not submit: ' + (e.message || 'error'), 'error');
    } finally {
        setBusy(btn, byId('leaveSubmitLabel'), false, '', 'Submit Request');
    }
}

function markInvalid(inputId) {
    var el = byId(inputId);
    if (!el) return;
    var field = el.closest('.field');
    if (field) {
        field.classList.add('invalid');
        void field.offsetWidth;
        field.classList.add('shake');
    }
}

VIEW_LOADERS.leaves = async function () {
    applyIdentity();
    await refreshLeaveData();
    refreshIcons();
};

/* ============================================================
   13. VIEW: DIRECTORY
   ============================================================ */

async function loadDirectoryMeta() {
    state.directory = await api.directory();
    state.depts = await api.departments();

    var sel = byId('dirDept');
    if (sel) {
        var cur = sel.value;
        sel.innerHTML = '<option value="">All departments</option>' +
            state.depts.map(function (d) {
                return '<option value="' + esc(d.name) + '">' + esc(d.name) + '</option>';
            }).join('');
        sel.value = cur;
    }
    renderDirectory();
}

function renderDirectory() {
    var wrap = byId('dirGrid');
    if (!wrap) return;
    var q = state.dirQuery.trim().toLowerCase();
    var rows = state.directory.filter(function (e) {
        var okQ = !q || (e.name || '').toLowerCase().indexOf(q) >= 0 || (e.email || '').toLowerCase().indexOf(q) >= 0;
        var okD = !state.dirDept || e.dept === state.dirDept;
        return okQ && okD;
    });
    setText('dirCount', rows.length + ' of ' + state.directory.length + ' employees');

    if (!rows.length) {
        wrap.innerHTML = '<div class="card" style="grid-column:1/-1"><p class="empty"><i data-lucide="search-x"></i>No employees match your search</p></div>';
        refreshIcons();
        return;
    }
    wrap.innerHTML = rows.map(function (e) {
        return '<div class="emp-card" data-action="open-emp" data-id="' + e.id + '" role="button" tabindex="0">' +
            '<span class="avatar">' + esc(initials(e.name)) + '</span>' +
            '<b>' + esc(e.name) + '</b>' +
            '<p class="emp-role">' + esc(e.designation || e.role || 'Team member') + '</p>' +
            '<div class="emp-tags"><span class="dept-chip">' + esc(e.dept) + '</span>' +
            (e.role && e.role !== 'Employee' ? '<span class="dept-chip" style="background:var(--purple-bg);color:var(--purple)">' + esc(e.role) + '</span>' : '') +
            '</div></div>';
    }).join('');
    refreshIcons();
}

function openEmployee(id) {
    var e = state.directory.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!e) return;
    var body = byId('empModalBody');
    if (!body) return;
    body.innerHTML =
        '<div class="emp-hero">' +
            '<span class="avatar">' + esc(initials(e.name)) + '</span>' +
            '<div><b>' + esc(e.name) + '</b><p>' + esc(e.designation || e.role || 'Team member') + '</p></div>' +
        '</div>' +
        '<div class="emp-facts">' +
            '<div class="ef"><small>Department</small><b>' + esc(e.dept) + '</b></div>' +
            '<div class="ef"><small>Role</small><b>' + esc(e.role || '—') + '</b></div>' +
            '<div class="ef"><small>Email</small><b>' + esc(e.email || '—') + '</b></div>' +
            '<div class="ef"><small>Phone</small><b>' + esc(e.phone || '—') + '</b></div>' +
        '</div>';
    openModal('empModal');
}

VIEW_LOADERS.directory = async function () {
    applyIdentity();
    if (!state.directory.length) await loadDirectoryMeta();
    else renderDirectory();
};

/* ============================================================
   14. VIEW: TASKS
   ============================================================ */

function renderTasks() {
    var wrap = byId('taskList');
    if (!wrap) return;
    var rows = state.tasks.filter(function (t) {
        return state.taskFilter === 'all' || t.status === state.taskFilter;
    });
    if (!rows.length) {
        wrap.innerHTML = '<div class="card"><p class="empty"><i data-lucide="clipboard-check"></i>' +
            (state.taskFilter === 'completed' ? 'Nothing completed yet' : 'No tasks here — add one above!') +
            '</p></div>';
        refreshIcons();
        return;
    }
    var tISO = todayISO();
    wrap.innerHTML = rows.map(function (t) {
        var overdue = t.status !== 'completed' && t.due_date && t.due_date < tISO;
        return '<div class="task-row' + (t.status === 'completed' ? ' done' : '') + '" data-id="' + t.id + '">' +
            '<button class="task-check" data-action="toggle-task" data-id="' + t.id + '" aria-label="Toggle task"><i data-lucide="check"></i></button>' +
            '<span class="task-meta"><b>' + esc(t.title) + '</b>' +
            '<small class="' + (overdue ? 'overdue' : '') + '">' +
            (t.due_date ? (overdue ? 'Overdue · ' : 'Due ') + humanDate(t.due_date) : 'No due date') +
            '</small></span>' +
            '<button class="icon-btn tiny danger" data-action="delete-task" data-id="' + t.id + '" aria-label="Delete task"><i data-lucide="trash-2"></i></button>' +
            '</div>';
    }).join('');
    refreshIcons();
}

function refreshTaskSummary() {
    var done = state.tasks.filter(function (t) { return t.status === 'completed'; }).length;
    setText('taskSummary', done + ' of ' + state.tasks.length + ' completed');
}

async function refreshTasks() {
    state.tasks = await api.tasks();
    refreshTaskSummary();
    renderTasks();
}

VIEW_LOADERS.tasks = async function () {
    applyIdentity();
    await refreshTasks();
};

async function addTask() {
    var input = byId('taskInput'), due = byId('taskDue');
    var title = (input.value || '').trim();
    if (!title) { toast('Type a task first', 'error'); input.focus(); return; }
    try {
        await api.addTask(title, due.value || null);
        input.value = ''; due.value = '';
        toast('Task added', 'success');
        await refreshTasks();
        loadDashboardLite();
    } catch (e) {
        toast('Could not add task: ' + (e.message || e), 'error');
    }
}

/* ============================================================
   15. VIEW: HOLIDAYS + ANNOUNCEMENTS
   ============================================================ */

VIEW_LOADERS.holidays = async function () {
    applyIdentity();
    var list = await api.holidays();
    state.holidays = list;

    var hero = byId('nextHolidayCard');
    if (hero) {
        if (!list.length) {
            hero.innerHTML = '<div style="display:flex;align-items:center;gap:16px">' +
                '<span class="hh-ico"><i data-lucide="calendar-x"></i></span>' +
                '<div><small>No upcoming holidays</small><b>Enjoy the regular grind!</b></div></div>';
        } else {
            var h = list[0], n = daysUntil(h.date);
            var d = new Date(h.date + 'T00:00:00');
            hero.innerHTML =
                '<span class="hh-ico"><i data-lucide="party-popper"></i></span>' +
                '<div><small>Next holiday · ' + d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + '</small>' +
                '<b>' + esc(h.name) + '</b></div>' +
                '<span class="hh-chip">' + (n === 0 ? 'Today 🎉' : n === 1 ? 'Tomorrow' : n + ' days to go') + '</span>';
        }
    }

    var grid = byId('holidayFull');
    if (grid) {
        grid.innerHTML = list.map(function (hh) {
            var dd = new Date(hh.date + 'T00:00:00');
            var past = daysUntil(hh.date) < 0;
            return '<div class="hol-card' + (past ? ' past' : '') + '">' +
                '<span class="h-date">' + dd.getDate() + '<small>' + dd.toLocaleDateString('en-GB', { month: 'short' }) + '</small></span>' +
                '<span class="h-meta"><b>' + esc(hh.name) + '</b><small>' +
                dd.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric' }) + '</small></span></div>';
        }).join('');
    }
    refreshIcons();
};

VIEW_LOADERS.announcements = async function () {
    applyIdentity();
    state.announcements = await api.announcements();
    renderAnnFeed();
};

function renderAnnFeed() {
    var wrap = byId('annFull');
    if (!wrap) return;
    var rows = state.announcements.filter(function (a) {
        return state.annFilter === 'all' || a.type === state.annFilter;
    });
    if (!rows.length) {
        wrap.innerHTML = '<div class="card"><p class="empty"><i data-lucide="megaphone-off"></i>Nothing in this category</p></div>';
        refreshIcons();
        return;
    }
    wrap.innerHTML = rows.map(function (a) {
        var ic = ANN_ICONS[a.type] || ANN_ICONS.info;
        return '<article class="ann-card-full">' +
            '<div class="acf-head"><span class="a-ico ' + ic[1] + '"><i data-lucide="' + ic[0] + '"></i></span>' +
            '<b>' + esc(a.title) + '</b><time>' + esc(humanDate(a.created_at)) + '</time></div>' +
            '<p>' + esc(a.body || '') + '</p></article>';
    }).join('');
    refreshIcons();
}

/* ============================================================
   16. VIEW: PROFILE (17-field form · ring · save)
   ============================================================ */

var P_SECTIONS = {
    'sec-personal':   { fields: ['firstName', 'lastName', 'dob', 'gender', 'bloodGroup', 'phone', 'pEmail'], chip: 'fill-personal' },
    'sec-employment': { fields: ['department', 'designation', 'manager', 'joiningDate'], chip: 'fill-employment' },
    'sec-address':    { fields: ['address', 'city', 'state', 'country', 'pincode'], chip: 'fill-address' },
    'sec-emergency':  { fields: ['emergencyName', 'emergencyPhone'], chip: 'fill-emergency' }
};
var P_REQUIRED = ['firstName', 'department'];
var P_PHONE_IDS = ['phone', 'emergencyPhone'];

function updateProfileProgress() {
    var total = 0, filled = 0;
    Object.keys(P_SECTIONS).forEach(function (secId) {
        var cfg = P_SECTIONS[secId];
        var secFilled = 0;
        cfg.fields.forEach(function (fid) {
            total++;
            var el = byId(fid);
            var v = el ? String(el.value || '').trim() : '';
            if (v) { filled++; secFilled++; }
        });
        var chip = byId(cfg.chip);
        if (chip) {
            chip.textContent = secFilled + '/' + cfg.fields.length;
            chip.classList.toggle('done', secFilled === cfg.fields.length);
        }
    });

    var pct = total ? Math.round((filled / total) * 100) : 0;
    setText('progressPct', pct + '%');
    setText('progressCount', filled + ' of ' + total);
    var bar = byId('ringBar');
    if (bar) {
        var C = 326.73;
        bar.style.strokeDashoffset = String(C - (pct / 100) * C);
    }
}

function validateProfileField(el) {
    var field = el.closest('.field');
    var v = String(el.value || '').trim();
    var bad = false;

    if (P_REQUIRED.indexOf(el.id) >= 0 && !v) bad = true;
    if (!bad && P_PHONE_IDS.indexOf(el.id) >= 0 && v) {
        bad = !/^[0-9+\-\s]{7,15}$/.test(v) || v.replace(/\D/g, '').length < 7;
    }
    if (!bad && el.id === 'pincode' && v) {
        bad = !/^[0-9]{5,6}$/.test(v);
    }

    if (field) field.classList.toggle('invalid', bad);
    if (el) el.setAttribute('aria-invalid', bad ? 'true' : 'false');
    return !bad;
}

async function loadProfileForm() {
    /* departments + managers */
    var deps = await api.departments();
    var mgrs = await api.managers();
    var dSel = byId('department'), mSel = byId('manager');
    if (dSel) {
        dSel.innerHTML = '<option value="">Select department…</option>' +
            deps.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>'; }).join('');
    }
    if (mSel) {
        mSel.innerHTML = '<option value="">Select manager…</option>' +
            mgrs.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('');
    }

    /* prefill */
    var data = await api.profile();
    state.profile = data.profile;
    var u = data.user, p = data.profile || {};
    var set = function (id, v) { var el = byId(id); if (el) el.value = v == null ? '' : v; };

    set('firstName', p.first_name || String(u.name || '').split(' ')[0]);
    set('lastName', p.last_name || String(u.name || '').split(' ').slice(1).join(' '));
    set('dob', p.dob || '');
    set('gender', p.gender || '');
    set('bloodGroup', p.blood_group || '');
    set('phone', p.phone || u.phone || '');
    set('pEmail', u.email || USER.email || '');
    set('designation', p.designation || '');
    set('joiningDate', (p.joining_date || u.joining_date || ''));

    /* selects — match by id then by name */
    if (dSel) {
        var dval = u.department_id != null ? String(u.department_id) : '';
        if (!dval && state.deptName) {
            var match = deps.filter(function (d) { return d.name === state.deptName; })[0];
            if (match) dval = String(match.id);
        }
        dSel.value = dval;
        if (dSel.value !== dval) dSel.value = '';
    }
    if (mSel) {
        var mval = u.manager_id != null ? String(u.manager_id) : '';
        mSel.value = mval;
        if (mSel.value !== mval) mSel.value = '';
    }

    set('address', p.address || '');
    set('city', p.city || '');
    set('state', p.state || '');
    set('country', p.country || 'India');
    set('pincode', p.pincode || '');
    set('emergencyName', p.emergency_contact_name || '');
    set('emergencyPhone', p.emergency_contact_phone || '');

    updateProfileProgress();
    refreshIcons();
}

async function saveProfileForm() {
    /* validate all */
    var ok = true, firstBad = null;
    $$('#profileForm input, #profileForm select, #profileForm textarea').forEach(function (el) {
        if (el.readOnly) return;
        if (!validateProfileField(el) && !firstBad) firstBad = el;
        if (!validateProfileField(el)) ok = false;
    });
    if (!ok) {
        toast('Please fix the highlighted fields', 'error');
        if (firstBad) firstBad.focus();
        return;
    }

    var btn = byId('saveBtn');
    setBusy(btn, byId('saveBtnLabel'), true, 'Saving…', 'Save Profile');
    try {
        var dSel = byId('department'), mSel = byId('manager');
        var deptName = '';
        if (dSel && dSel.selectedIndex > 0) deptName = dSel.options[dSel.selectedIndex].text;

        var res = await api.saveProfile({
            firstName: byId('firstName').value.trim(),
            lastName: byId('lastName').value.trim(),
            dob: byId('dob').value,
            gender: byId('gender').value,
            bloodGroup: byId('bloodGroup').value,
            phone: byId('phone').value.trim(),
            departmentId: dSel && dSel.value ? dSel.value : null,
            departmentName: deptName,
            designation: byId('designation').value.trim(),
            managerId: mSel && mSel.value ? mSel.value : null,
            joiningDate: byId('joiningDate').value,
            address: byId('address').value.trim(),
            city: byId('city').value.trim(),
            state: byId('state').value.trim(),
            country: byId('country').value.trim(),
            pincode: byId('pincode').value.trim(),
            emergencyName: byId('emergencyName').value.trim(),
            emergencyPhone: byId('emergencyPhone').value.trim()
        });

        if (!res.ok) throw new Error(res.error || 'save failed');
        toast('Profile saved ✓', 'success');
        var data = await api.profile();
        state.profile = data.profile;
        applyIdentity();
        USER.name = ((data.profile && data.profile.first_name) ? (data.profile.first_name + ' ' + (data.profile.last_name || '')) : USER.name).trim();
        try { localStorage.setItem('loggedInUser', JSON.stringify(USER)); } catch (e) {}
        applyIdentity();
    } catch (e) {
        console.error('[HRMS] saveProfile:', e.message || e);
        toast('Save failed: ' + (e.message || 'error'), 'error');
    } finally {
        setBusy(btn, byId('saveBtnLabel'), false, '', 'Save Profile');
    }
}

VIEW_LOADERS.profile = async function () {
    applyIdentity();
    await loadProfileForm();
};

/* ============================================================
   17. VIEW: SETTINGS
   ============================================================ */

var PREF_KEY = 'hrmsPrefs_v1';

function loadPrefs() {
    try {
        var p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
        Object.keys(p).forEach(function (k) {
            var el = byId('pref' + k.charAt(0).toUpperCase() + k.slice(1));
            if (el) el.checked = !!p[k];
        });
    } catch (e) {}
}
function savePrefs() {
    var p = {
        email:  byId('prefEmail') ? byId('prefEmail').checked : true,
        punch:  byId('prefPunch') ? byId('prefPunch').checked : true,
        digest: byId('prefDigest') ? byId('prefDigest').checked : false
    };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) {}
    toast('Preferences saved', 'success', 1600);
}

VIEW_LOADERS.settings = async function () {
    applyIdentity();
    loadPrefs();
};

/* ============================================================
   18. NOTIFICATIONS + MESSAGES DRAWERS
   ============================================================ */

var NOTIF_ICONS = { info: ['info', 'ic-blue'], leave: ['plane', 'ic-purple'], payslip: ['wallet', 'ic-green'], task: ['list-checks', 'ic-orange'], policy: ['file-text', 'ic-teal'] };

async function loadBadges() {
    var notifs = await api.notifications();
    var msgs = await api.messages();
    state.notifs = notifs;
    state.messages = msgs;

    var unreadN = notifs.filter(function (n) { return !n.is_read; }).length;
    var unreadM = msgs.filter(function (m) { return !m.is_read; }).length;

    var nb = byId('notifBadge'), mb = byId('msgBadge');
    if (nb) { nb.textContent = unreadN; nb.classList.toggle('hidden', !unreadN); }
    if (mb) { mb.textContent = unreadM; mb.classList.toggle('hidden', !unreadM); }

    if (byId('notifDrawer').classList.contains('open')) renderNotifList();
    if (byId('msgDrawer').classList.contains('open')) renderMsgList();
}

function renderNotifList() {
    var wrap = byId('notifList');
    if (!wrap) return;
    var rows = state.notifs.filter(function (n) {
        return state.notifFilter === 'all' || !n.is_read;
    });
    if (!rows.length) {
        wrap.innerHTML = '<p class="empty"><i data-lucide="bell-off"></i>' +
            (state.notifFilter === 'unread' ? 'All caught up!' : 'No notifications') + '</p>';
        refreshIcons();
        return;
    }
    wrap.innerHTML = rows.map(function (n) {
        var ic = NOTIF_ICONS[n.type] || ['bell', 'ic-blue'];
        return '<div class="notif-row' + (n.is_read ? '' : ' unread') + '" data-action="notif-read" data-id="' + n.id + '" role="button" tabindex="0">' +
            '<span class="n-ico ' + ic[1] + '"><i data-lucide="' + ic[0] + '"></i></span>' +
            '<span class="n-meta"><b>' + esc(n.title || 'Notification') + '</b><p>' + esc(n.message || '') + '</p></span>' +
            '<time>' + esc(timeAgo(n.created_at)) + '</time>' +
            (n.is_read ? '' : '<span class="n-unread-dot"></span>') +
            '</div>';
    }).join('');
    refreshIcons();
}

function renderMsgList() {
    var wrap = byId('msgList');
    if (!wrap) return;
    if (!state.messages.length) {
        wrap.innerHTML = '<p class="empty"><i data-lucide="inbox"></i>No messages</p>';
        refreshIcons();
        return;
    }
    wrap.innerHTML = state.messages.map(function (m) {
        return '<div class="notif-row' + (m.is_read ? '' : ' unread') + '" data-action="msg-read" data-id="' + m.id + '" role="button" tabindex="0">' +
            '<span class="n-ico ic-blue">' + esc(initials(m.sender_name || '?')) + '</span>' +
            '<span class="n-meta"><b>' + esc(m.sender_name || 'Unknown') + '</b><p>' + esc(m.preview || '') + '</p></span>' +
            '<time>' + esc(timeAgo(m.created_at)) + '</time>' +
            (m.is_read ? '' : '<span class="n-unread-dot"></span>') +
            '</div>';
    }).join('');
    refreshIcons();
}

/* ============================================================
   19. GLOBAL SEARCH
   ============================================================ */

var SEARCH_PAGES = [
    ['dashboard', 'Dashboard', 'layout-dashboard'],
    ['attendance', 'Attendance', 'fingerprint'],
    ['leaves', 'Leaves', 'plane'],
    ['directory', 'Directory', 'users'],
    ['tasks', 'My Tasks', 'list-checks'],
    ['holidays', 'Holidays', 'calendar-days'],
    ['announcements', 'Announcements', 'megaphone'],
    ['profile', 'My Profile', 'user-round'],
    ['settings', 'Settings', 'settings']
];

function runSearch(q) {
    var box = byId('searchResults');
    if (!box) return;
    q = q.trim().toLowerCase();
    if (!q) { box.classList.remove('open'); box.innerHTML = ''; return; }

    var pages = SEARCH_PAGES.filter(function (p) { return p[1].toLowerCase().indexOf(q) >= 0; })
        .slice(0, 4)
        .map(function (p) {
            return '<button class="sr-item" data-action="goto" data-route="' + p[0] + '">' +
                '<span class="sr-ico"><i data-lucide="' + p[2] + '"></i></span>' +
                '<span><b>' + esc(p[1]) + '</b><small>Page</small></span></button>';
        });

    var emps = state.directory.filter(function (e) {
        return (e.name || '').toLowerCase().indexOf(q) >= 0 || (e.email || '').toLowerCase().indexOf(q) >= 0;
    }).slice(0, 5).map(function (e) {
        return '<button class="sr-item" data-action="open-emp" data-id="' + e.id + '">' +
            '<span class="sr-ico">' + esc(initials(e.name)) + '</span>' +
            '<span><b>' + esc(e.name) + '</b><small>' + esc(e.designation || e.dept || 'Employee') + '</small></span></button>';
    });

    var html = pages.join('') + emps.join('');
    box.innerHTML = html || '<p class="sr-empty">No results for “' + esc(q) + '”</p>';
    box.classList.add('open');
    refreshIcons();
}

/* ============================================================
   20. EVENT DELEGATION — every [data-action] button in one place
   ============================================================ */

document.addEventListener('click', async function (ev) {
    var el = ev.target.closest('[data-action]');
    if (!el) {
        /* click-away handlers */
        if (!ev.target.closest('#profileChip')) byId('userMenu') && byId('userMenu').classList.remove('open');
        if (!ev.target.closest('.search-wrap')) byId('searchResults') && byId('searchResults').classList.remove('open');
        return;
    }
    var act = el.getAttribute('data-action');
    var id = el.getAttribute('data-id');

    switch (act) {

        /* navigation */
        case 'goto':           closeAllLayers(); navigate(el.getAttribute('data-route')); break;
        case 'goto-attendance':    navigate('attendance'); break;
        case 'goto-tasks':         navigate('tasks'); break;
        case 'goto-directory':     navigate('directory'); break;
        case 'goto-holidays':      navigate('holidays'); break;
        case 'goto-announcements': navigate('announcements'); break;
        case 'goto-profile':       closeAllLayers(); navigate('profile'); break;
        case 'goto-settings':      closeAllLayers(); navigate('settings'); break;
        case 'goto-apply-leave':   openLeaveModal(); break;

        /* shell */
        case 'open-sidebar':
            byId('sidebar').classList.add('open');
            byId('sidebarOverlay').classList.add('show');
            break;
        case 'close-sidebar':
            byId('sidebar').classList.remove('open');
            byId('sidebarOverlay').classList.remove('show');
            break;
        case 'toggle-usermenu':    byId('userMenu').classList.toggle('open'); break;
        case 'open-notifs':        openDrawer('notifDrawer'); renderNotifList(); break;
        case 'open-msgs':          openDrawer('msgDrawer'); renderMsgList(); break;
        case 'close-drawers':      closeDrawers(); break;
        case 'close-modal':        closeAllLayers(); break;

        /* auth */
        case 'logout':
            askConfirm('Sign out?', 'You will need to sign in again to continue.', function () { logout(); });
            break;

        /* attendance */
        case 'punch-in':       doPunch('in', el); break;
        case 'punch-out':      doPunch('out', el); break;
        case 'punch-toggle':
            if (!state.todayRec || !state.todayRec.check_in) doPunch('in', el);
            else if (!state.todayRec.check_out) doPunch('out', el);
            else toast('Attendance is complete for today', 'info');
            break;
        case 'cal-prev':
            state.calMonth.m--; if (state.calMonth.m < 0) { state.calMonth.m = 11; state.calMonth.y--; }
            VIEW_LOADERS.attendance();
            break;
        case 'cal-next':
            state.calMonth.m++; if (state.calMonth.m > 11) { state.calMonth.m = 0; state.calMonth.y++; }
            VIEW_LOADERS.attendance();
            break;

        /* leaves */
        case 'open-leave':     openLeaveModal(); break;
        case 'cancel-leave':
            askConfirm('Cancel this request?', 'The pending ' + 'leave request will be removed.', async function () {
                var res = await api.cancelLeave(id == null ? null : (isNaN(Number(id)) ? id : Number(id)));
                if (res && res.ok === false) toast('Cancel failed: ' + res.error, 'error');
                else toast('Leave request cancelled', 'success');
                await refreshLeaveData();
                loadDashboardLite();
            });
            break;

        /* tasks */
        case 'add-task':       addTask(); break;
        case 'toggle-task':
            var row = el.closest('.task-row');
            var t = state.tasks.filter(function (x) { return String(x.id) === String(id); })[0];
            if (t) {
                var next = t.status === 'completed' ? 'pending' : 'completed';
                t.status = next;
                if (row) row.classList.toggle('done', next === 'completed');
                await api.setTaskStatus(isNaN(Number(id)) ? id : Number(id), next);
                refreshTaskSummary();
                if (state.taskFilter !== 'all') renderTasks();
                loadDashboardLite();
                if (next === 'completed') toast('Task completed ✓', 'success', 1600);
            }
            break;
        case 'delete-task':
            askConfirm('Delete this task?', 'It will be removed permanently.', async function () {
                var res = await api.deleteTask(isNaN(Number(id)) ? id : Number(id));
                if (res && res.ok === false) toast('Delete failed: ' + res.error, 'error');
                else toast('Task deleted', 'success', 1600);
                await refreshTasks();
                loadDashboardLite();
            });
            break;

        /* directory */
        case 'open-emp':       openEmployee(id); break;

        /* notifications + messages */
        case 'notif-read':
            await api.markNotification(isNaN(Number(id)) ? id : Number(id));
            await loadBadges();
            renderNotifList();
            break;
        case 'notif-read-all':
            await api.markAllNotifications();
            await loadBadges();
            renderNotifList();
            toast('All notifications marked as read', 'success', 1600);
            break;
        case 'msg-read':
            await api.markMessage(isNaN(Number(id)) ? id : Number(id));
            await loadBadges();
            renderMsgList();
            break;

        /* settings */
        case 'reload-data':
            toast('Refreshing data…', 'info', 1200);
            state.directory = []; 
            await render(currentRoute());
            await loadBadges();
            toast('Data refreshed', 'success', 1500);
            break;
        case 'reset-demo':
            askConfirm('Reset demo workspace?', 'All sample changes you made will be restored to defaults.', async function () {
                resetDemo();
                state.directory = [];
                toast('Demo workspace reset', 'success');
                await render(currentRoute());
                await loadBadges();
            });
            break;
    }
});

/* confirm modal OK */
byId('confirmOk') && byId('confirmOk').addEventListener('click', function () {
    var cb = state.confirmCb;
    closeAllLayers();
    state.confirmCb = null;
    if (cb) cb();
});

/* chip filters (leave status / task status / announcements / notifications) */
document.addEventListener('click', function (ev) {
    var chip = ev.target.closest('.chip');
    if (!chip) return;

    if (chip.hasAttribute('data-filter') && chip.closest('#leaveChips')) {
        state.leaveFilter = chip.getAttribute('data-filter');
        $$('#leaveChips .chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
        renderLeaveTable();
    }
    if (chip.hasAttribute('data-filter') && chip.closest('#taskChips')) {
        state.taskFilter = chip.getAttribute('data-filter');
        $$('#taskChips .chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
        renderTasks();
    }
    if (chip.hasAttribute('data-filter') && chip.closest('#annChips')) {
        state.annFilter = chip.getAttribute('data-filter');
        $$('#annChips .chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
        renderAnnFeed();
    }
    if (chip.hasAttribute('data-nfilter')) {
        state.notifFilter = chip.getAttribute('data-nfilter');
        $$('#notifDrawer .chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
        renderNotifList();
    }
});

/* forms */
byId('leaveForm') && byId('leaveForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    submitLeave();
});
byId('profileForm') && byId('profileForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    saveProfileForm();
});

/* leave date inputs → live day count */
['leaveStart', 'leaveEnd'].forEach(function (fid) {
    var el = byId(fid);
    el && el.addEventListener('change', function () {
        var n = calcLeaveDays(byId('leaveStart').value, byId('leaveEnd').value);
        setText('leaveDays', n + ' day' + (n === 1 ? '' : 's'));
    });
});

/* profile live progress + validation */
$$('#profileForm input, #profileForm select').forEach(function (el) {
    el.addEventListener('input', function () {
        updateProfileProgress();
        if (el.closest('.field') && el.closest('.field').classList.contains('invalid')) {
            validateProfileField(el);
        }
    });
    el.addEventListener('blur', function () {
        if (el.readOnly) return;
        validateProfileField(el);
    });
});

/* directory toolbar */
byId('dirSearch') && byId('dirSearch').addEventListener('input', function () {
    state.dirQuery = this.value;
    renderDirectory();
});
byId('dirDept') && byId('dirDept').addEventListener('change', function () {
    state.dirDept = this.value;
    renderDirectory();
});

/* task input: Enter adds */
byId('taskInput') && byId('taskInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); addTask(); }
});

/* settings prefs */
['prefEmail', 'prefPunch', 'prefDigest'].forEach(function (fid) {
    var el = byId(fid);
    el && el.addEventListener('change', savePrefs);
});

/* global search interactions */
byId('globalSearch') && byId('globalSearch').addEventListener('input', function () {
    runSearch(this.value);
});
byId('globalSearch') && byId('globalSearch').addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { this.value = ''; runSearch(''); this.blur(); }
});
document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === '/') {
        ev.preventDefault();
        byId('globalSearch') && byId('globalSearch').focus();
    }
    if (ev.key === 'Escape') closeAllLayers();
});

/* hash router */
window.addEventListener('hashchange', function () { render(currentRoute()); });

/* ============================================================
   21. BOOT
   ============================================================ */

async function boot() {
    /* resolve credentials from supabase.js — the only file you edit */
    var HC = window.HRMS_CONFIG;
    var url = HC && HC.supabaseUrl || '';
    var key = HC && (HC.supabaseAnonKey || HC.supabaseKey) || '';

    DEMO = !/^https:\/\/[a-z0-9-]+\.supabase\.(co|in|net)/i.test(url) ||
           String(key).indexOf('YOUR_') === 0 ||
           String(key).length < 30;

    if (!DEMO) {
        if (window.HRMS_SB) sb = window.HRMS_SB;
        else if (window.supabase && window.supabase.createClient) {
            try { sb = window.supabase.createClient(url, key); }
            catch (e) { console.error('[HRMS] client init failed:', e.message); DEMO = true; }
        } else { DEMO = true; }
    }

    requireAuth();

    try {
        var data = await api.profile();
        state.profile = data.profile;
        if (data.user && data.user.name) USER.name = data.user.name;
    } catch (e) {
        console.error('[HRMS] profile load:', e.message || e);
    }

    applyIdentity();
    /* preload the directory so global search covers employees immediately */
    api.directory().then(function (rows) { state.directory = rows; }, function () {});
    await loadBadges();

    if (DEMO) {
        console.info(
            '%c[HRMS] Demo workspace%c — every button works with sample data. Paste credentials in supabase.js to go live.',
            'background:#F59E0B;color:#111827;padding:2px 8px;border-radius:4px;font-weight:700', ''
        );
    } else {
        console.info('%c[HRMS] Connected to Supabase ✓', 'background:#0D6EFD;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700');
    }

    render(currentRoute());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

/* public API for debugging */
window.HRMS = { state: state, api: api, navigate: navigate, demo: function () { return DEMO; } };

})();


