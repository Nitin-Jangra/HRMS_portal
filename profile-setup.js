/* ============================================================================
   HRMS — PROFILE SETUP · profile-setup.js
   ----------------------------------------------------------------------------
   Handles: auth guard · department/manager loading · existing-profile prefill ·
            live progress ring + step tracker · inline validation · toasts ·
            save (users + employee_profiles upsert) · demo mode

   ── SETUP ──────────────────────────────────────────────────────────────────
   Your existing supabase.js runs first — it is THE ONLY FILE YOU EDIT (it
   defines window.HRMS_CONFIG + one shared client, window.HRMS_SB) and this
   file picks its values up automatically. Until real credentials are found
   the page runs in DEMO MODE: fully interactive, sample data, nothing is
   written anywhere.

   ── EXPECTED SCHEMA (same as your original code) ───────────────────────────
     users             : id, name, phone, department_id, manager_id, joining_date
     employee_profiles : user_id, first_name, last_name, phone, department_id,
                         designation, manager_id, joining_date, dob, gender,
                         blood_group, address, city, state, country, pincode,
                         emergency_contact_name, emergency_contact_phone
     departments       : id, name

   ── IMPROVEMENTS over the original script ──────────────────────────────────
   1. Upsert instead of blind insert — re-submitting no longer creates
      duplicate employee_profiles rows.
   2. Existing profile (or your users.name) is prefilled into the form.
   3. Inline validation with shake + error text instead of alert().
   4. Live progress ring, per-section counters and a clickable step tracker.
   5. Toast notifications, loading state on the save button, retry on
      department/manager load failure.
   6. UUID-safe id casting (Number() only when the id really is numeric).
   7. Unsaved-changes guard while the form is dirty.
   ========================================================================== */

(function () {
'use strict';

/* ============================================================
   1. CONFIG — supabase.js is the single source of truth.
   This block is only a fallback used when supabase.js is absent.
   ============================================================ */

var CONFIG = {
    supabaseUrl:     'YOUR_SUPABASE_URL',       // fallback if supabase.js is absent
    supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',
    loginUrl:        'index.html',              // redirect when not logged in
    successUrl:      'dashboard.html',          // redirect after save
    tables: {
        users:       'users',
        profiles:    'employee_profiles',
        departments: 'departments'
    }
};

/* supabase.js (central config — the only file you edit) overrides this block */
(function () {
    var HC = window.HRMS_CONFIG;
    if (!HC) return;
    if (HC.loginUrl)     CONFIG.loginUrl = HC.loginUrl;
    if (HC.dashboardUrl) CONFIG.successUrl = HC.dashboardUrl;
    if (HC.tables) {
        for (var k in HC.tables) {
            if (Object.prototype.hasOwnProperty.call(HC.tables, k) && HC.tables[k] &&
                Object.prototype.hasOwnProperty.call(CONFIG.tables, k)) {
                CONFIG.tables[k] = HC.tables[k];
            }
        }
    }
})();

/* ============================================================
   2. STATE + TINY DOM UTILS
   ============================================================ */

var sb = null;        // supabase client (null in demo mode)
var DEMO = true;      // flipped below once credentials are resolved
var USER = null;      // { id, name, ... } from localStorage
var SAVING = false;
var DIRTY = false;
var PREFILLING = false;

var REDUCE = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function byId(id)  { return document.getElementById(id); }
function $(sel, root) { return (root || document).querySelector(sel); }

function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* Number cast for FK ids — keeps UUID strings intact */
function smartId(v) {
    if (v === '' || v == null) return null;
    var n = Number(v);
    return isNaN(n) ? v : n;
}

/* ============================================================
   3. FORM MAP — sections, fields, counters
   ============================================================ */

var SECTIONS = [
    { id: 'sec-personal',   fill: 'fill-personal',   step: 1, fields: ['firstName', 'lastName', 'dob', 'gender', 'bloodGroup', 'phone'] },
    { id: 'sec-employment', fill: 'fill-employment', step: 2, fields: ['department', 'designation', 'manager', 'joiningDate'] },
    { id: 'sec-address',    fill: 'fill-address',    step: 3, fields: ['address', 'city', 'state', 'country', 'pincode'] },
    { id: 'sec-emergency',  fill: 'fill-emergency',  step: 4, fields: ['emergencyName', 'emergencyPhone'] }
];

var TOTAL_FIELDS = SECTIONS.reduce(function (n, s) { return n + s.fields.length; }, 0); /* 17 */

var REQUIRED  = ['firstName', 'lastName', 'department'];
var PHONE_IDS = ['phone', 'emergencyPhone'];

/* employee_profiles column  ->  input id */
var PROFILE_MAP = {
    first_name:               'firstName',
    last_name:                'lastName',
    dob:                      'dob',
    gender:                   'gender',
    blood_group:              'bloodGroup',
    phone:                    'phone',
    department_id:            'department',
    designation:              'designation',
    manager_id:               'manager',
    joining_date:             'joiningDate',
    address:                  'address',
    city:                     'city',
    state:                    'state',
    country:                  'country',
    pincode:                  'pincode',
    emergency_contact_name:   'emergencyName',
    emergency_contact_phone:  'emergencyPhone'
};

var RING_C = 326.73; /* 2 * PI * r(52) */

/* ============================================================
   4. TOASTS
   ============================================================ */

var TOAST_ICON = { success: 'check', error: 'x', info: 'info' };

function toast(msg, type, ms) {
    var stack = byId('toastStack');
    if (!stack) return;
    type = TOAST_ICON[type] ? type : 'info';

    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML =
        '<span class="toast-ico"><i data-lucide="' + TOAST_ICON[type] + '"></i></span>' +
        '<span></span>';
    el.lastChild.textContent = msg;
    stack.appendChild(el);
    refreshIcons();

    setTimeout(function () {
        el.classList.add('out');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, ms || 3400);
}

/* ============================================================
   5. PROGRESS ENGINE — ring, counters, step tracker
   ============================================================ */

function isFilled(el) {
    if (!el) return false;
    if (el.type === 'select-one' || el.tagName === 'SELECT') return el.value !== '';
    return String(el.value || '').trim() !== '';
}

function sectionCount(sec) {
    var n = 0;
    sec.fields.forEach(function (id) { if (isFilled(byId(id))) n++; });
    return n;
}

function updateProgress(animate) {
    var filled = 0;

    SECTIONS.forEach(function (sec) {
        var n = sectionCount(sec);
        filled += n;
        var m = sec.fields.length;

        var fillEl = byId(sec.fill);
        if (fillEl) {
            fillEl.textContent = n + '/' + m;
            fillEl.classList.toggle('done', n === m);
        }

        var countEl = byId('stepCount-' + sec.step);
        if (countEl) countEl.textContent = n + '/' + m;

        var stepEl = $('.step[data-target="' + sec.id + '"]');
        if (stepEl) stepEl.classList.toggle('done', n === m);
    });

    var pct = Math.round((filled / TOTAL_FIELDS) * 100);

    var pctEl = byId('progressPct');
    if (pctEl) pctEl.textContent = pct + '%';

    var countEl = byId('progressCount');
    if (countEl) countEl.textContent = filled + ' of ' + TOTAL_FIELDS + ' fields filled';

    var bar = byId('ringBar');
    if (bar) {
        if (animate && !REDUCE) {
            /* sweep from current value for a smooth count-up feel */
            bar.style.transition = 'none';
            bar.style.strokeDashoffset = RING_C;
            void bar.getBoundingClientRect(); /* reflow */
            bar.style.transition = '';
        }
        bar.style.strokeDashoffset = String(RING_C * (1 - pct / 100));
    }

    var doneSections = SECTIONS.filter(function (s) {
        return sectionCount(s) === s.fields.length;
    }).length;
    var chip = byId('stepsDoneChip');
    if (chip) chip.textContent = doneSections + ' of ' + SECTIONS.length;
}

function setCurrentStep(targetId) {
    document.querySelectorAll('.step').forEach(function (el) {
        el.classList.toggle('current', el.getAttribute('data-target') === targetId);
    });
}

function initSteps() {
    document.querySelectorAll('.step[data-target]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var target = byId(btn.getAttribute('data-target'));
            if (!target) return;
            setCurrentStep(btn.getAttribute('data-target'));
            target.scrollIntoView({
                behavior: REDUCE ? 'auto' : 'smooth',
                block: 'start'
            });
        });
    });

    /* scroll-spy — highlights the section currently in view */
    if ('IntersectionObserver' in window && !REDUCE) {
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) setCurrentStep(entry.target.id);
            });
        }, { rootMargin: '-30% 0px -62% 0px', threshold: 0 });

        SECTIONS.forEach(function (sec) {
            var el = byId(sec.id);
            if (el) io.observe(el);
        });
    }
}

/* ============================================================
   6. VALIDATION — inline errors + shake, no alert()
   ============================================================ */

function fieldWrap(el) { return el ? el.closest('.field') : null; }

function showError(el, msg) {
    var wrap = fieldWrap(el);
    if (!wrap) return;
    var err = wrap.querySelector('.field-err');
    if (err && msg) err.textContent = msg;
    wrap.classList.add('invalid');
    el.setAttribute('aria-invalid', 'true');
}

function clearError(el) {
    var wrap = fieldWrap(el);
    if (!wrap) return;
    wrap.classList.remove('invalid', 'shake');
    el.removeAttribute('aria-invalid');
}

function validPhone(v) {
    var digits = String(v).replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15;
}

function validateField(id, quiet) {
    var el = byId(id);
    if (!el) return true;
    var v = String(el.value || '').trim();

    /* required */
    if (REQUIRED.indexOf(id) !== -1 && v === '') {
        if (!quiet) showError(el, el.tagName === 'SELECT'
            ? 'Please select an option.' : 'This field is required.');
        return false;
    }

    /* format checks only run when the optional value is present */
    if (v !== '') {
        if (PHONE_IDS.indexOf(id) !== -1 && !validPhone(v)) {
            if (!quiet) showError(el, 'Enter a valid phone number.');
            return false;
        }
        if (id === 'pincode' && !/^\d{5,6}$/.test(v.replace(/\s/g, ''))) {
            if (!quiet) showError(el, 'Enter a valid pincode (5–6 digits).');
            return false;
        }
    }

    clearError(el);
    return true;
}

function validateAll() {
    var firstBad = null;

    REQUIRED.forEach(function (id) {
        if (!validateField(id)) firstBad = firstBad || byId(id);
    });
    PHONE_IDS.forEach(function (id) {
        if (!validateField(id)) firstBad = firstBad || byId(id);
    });
    if (!validateField('pincode')) firstBad = firstBad || byId('pincode');

    if (firstBad) {
        var wrap = fieldWrap(firstBad);
        if (wrap) {
            wrap.classList.add('shake');
            setTimeout(function () { wrap.classList.remove('shake'); }, 500);
        }
        firstBad.scrollIntoView({ behavior: REDUCE ? 'auto' : 'smooth', block: 'center' });
        try { firstBad.focus({ preventScroll: true }); } catch (e) { firstBad.focus(); }
        toast('Please fix the highlighted fields.', 'error');
        return false;
    }
    return true;
}

/* ============================================================
   7. SUPABASE RESOLUTION + AUTH GUARD
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
    if (DEMO) return null;

    /* reuse the ONE client created by supabase.js (window.HRMS_SB) */
    if (window.HRMS_SB) return window.HRMS_SB;

    if (!window.supabase || !window.supabase.createClient) { DEMO = true; return null; }

    try {
        return window.supabase.createClient(c.url, c.key);
    } catch (e) {
        console.error('[HRMS Profile] Supabase init failed:', e.message);
        DEMO = true;
        return null;
    }
}

function loadUser() {
    var raw = null;
    try { raw = localStorage.getItem('loggedInUser'); } catch (e) {}

    if (raw) {
        try { USER = JSON.parse(raw); } catch (e) { USER = null; }
    }

    if (!USER) {
        if (DEMO) {
            /* synthetic session so the demo stays browsable */
            USER = { id: 1, name: 'Aarav Sharma', email: 'aarav@hrims.app' };
            return true;
        }
        window.location.replace(CONFIG.loginUrl);   /* original behaviour */
        return false;
    }
    return true;
}

/* ============================================================
   8. SELECT FILLING (departments + managers)
   ============================================================ */

function addOption(select, value, label) {
    var opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
}

function showLoadError(selectId, label, retry) {
    var el = byId(selectId);
    var wrap = fieldWrap(el);
    if (!el || !wrap) return;

    wrap.classList.add('invalid');
    var err = wrap.querySelector('.field-err');
    if (err) {
        err.textContent = '';
        err.appendChild(document.createTextNode('Couldn\u2019t load ' + label + '. '));
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Retry';
        btn.style.cssText = 'background:none;border:none;color:#0D6EFD;font-weight:700;' +
                            'font-size:12px;cursor:pointer;padding:0;text-decoration:underline;';
        btn.addEventListener('click', function () {
            wrap.classList.remove('invalid');
            if (err) err.textContent = '';
            retry();
        });
        err.appendChild(btn);
        err.style.display = 'block';
    }
}

async function loadDepartments() {
    var select = byId('department');
    if (!select) return;

    var rows = null, error = null;

    if (DEMO) {
        rows = [
            { id: 1, name: 'Engineering' }, { id: 2, name: 'Design' },
            { id: 3, name: 'Human Resources' }, { id: 4, name: 'Sales' },
            { id: 5, name: 'Marketing' }, { id: 6, name: 'Finance' }
        ];
    } else {
        var res = await sb.from(CONFIG.tables.departments)
            .select('id,name')
            .order('name');
        rows = res.data; error = res.error;
    }

    if (error) {
        console.error('[HRMS Profile] departments:', error.message);
        toast(error.message, 'error');
        showLoadError('department', 'departments', loadDepartments);
        return;
    }

    (rows || []).forEach(function (dep) { addOption(select, dep.id, dep.name); });
}

async function loadManagers() {
    var select = byId('manager');
    if (!select) return;

    var rows = null, error = null;

    if (DEMO) {
        rows = [
            { id: 2, name: 'Priya Nair' }, { id: 3, name: 'Rahul Verma' },
            { id: 4, name: 'Sneha Iyer' }, { id: 5, name: 'Arjun Mehta' }
        ];
    } else {
        var res = await sb.from(CONFIG.tables.users)
            .select('id,name')
            .order('name');
        rows = res.data; error = res.error;
    }

    if (error) {
        console.error('[HRMS Profile] managers:', error.message);
        return; /* manager is optional — stay quiet, keep the form usable */
    }

    (rows || []).forEach(function (m) {
        if (USER && String(m.id) === String(USER.id)) return; /* exclude self (as before) */
        addOption(select, m.id, m.name);
    });
}

/* ============================================================
   9. PREFILL — existing profile, or the users.name fallback
   ============================================================ */

function setVal(id, v) {
    var el = byId(id);
    if (!el || v === null || v === undefined || v === '') return;

    if (el.tagName === 'SELECT') {
        var has = false;
        for (var i = 0; i < el.options.length; i++) {
            if (String(el.options[i].value) === String(v)) { has = true; break; }
        }
        if (!has) return; /* stale/dead FK — leave the placeholder */
    } else if (el.type === 'date') {
        v = String(v).slice(0, 10);
    }

    PREFILLING = true;
    el.value = v;
    PREFILLING = false;
}

function prefillFromProfile(row) {
    if (!row) return;
    Object.keys(PROFILE_MAP).forEach(function (col) {
        setVal(PROFILE_MAP[col], row[col]);
    });
    updateProgress(true);
}

async function loadExistingProfile() {
    if (DEMO) {
        prefillFromProfile({
            first_name: 'Aarav', last_name: 'Sharma', dob: '1998-04-12',
            gender: 'Male', blood_group: 'O+', phone: '+91 98765 43210',
            department_id: 2, designation: 'Senior UI Designer', manager_id: 2,
            joining_date: todayISO(),
            address: '402, Sunrise Residency, MG Road', city: 'Mumbai',
            state: 'Maharashtra', country: 'India', pincode: '400001',
            emergency_contact_name: 'Rohan Sharma', emergency_contact_phone: '+91 98123 45678'
        });
        return;
    }

    /* 1) try the full profile row */
    var res = await sb.from(CONFIG.tables.profiles)
        .select('*')
        .eq('user_id', USER.id)
        .maybeSingle();

    if (res.error) {
        console.error('[HRMS Profile] prefill:', res.error.message);
        return;
    }

    if (res.data) { prefillFromProfile(res.data); return; }

    /* 2) gentle fallback: split the account name */
    var u = await sb.from(CONFIG.tables.users)
        .select('name,phone')
        .eq('id', USER.id)
        .maybeSingle();

    if (u.error || !u.data) return;

    var parts = String(u.data.name || '').trim().split(/\s+/);
    setVal('firstName', parts[0] || '');
    setVal('lastName', parts.slice(1).join(' ') || '');
    setVal('phone', u.data.phone || '');
    updateProgress(true);
}

/* ============================================================
   10. SAVE — validate → users update → profiles upsert
   ============================================================ */

function collectProfileData() {
    return {
        user_id: USER.id,

        first_name: byId('firstName').value.trim(),
        last_name:  byId('lastName').value.trim(),
        phone:      byId('phone').value.trim(),

        department_id: smartId(byId('department').value),
        designation:   byId('designation').value.trim(),
        manager_id:    smartId(byId('manager').value),
        joining_date:  byId('joiningDate').value || null,

        dob:         byId('dob').value || null,
        gender:      byId('gender').value || null,
        blood_group: byId('bloodGroup').value || null,

        address: byId('address').value.trim(),
        city:    byId('city').value.trim(),
        state:   byId('state').value.trim(),
        country: byId('country').value.trim(),
        pincode: byId('pincode').value.trim(),

        emergency_contact_name:  byId('emergencyName').value.trim(),
        emergency_contact_phone: byId('emergencyPhone').value.trim()
    };
}

function setSaving(on) {
    SAVING = on;
    var btn = byId('saveBtn');
    var label = byId('saveBtnLabel');
    if (btn) btn.classList.toggle('loading', on);
    if (label) label.textContent = on ? 'Saving…' : 'Save Profile';
    if (btn) btn.disabled = on;
}

function finishSave(ok, message) {
    setSaving(false);
    if (ok) {
        DIRTY = false;
        toast(message || 'Profile saved — redirecting…', 'success');
        setTimeout(function () {
            window.location.href = CONFIG.successUrl;
        }, 1200);
    } else {
        toast(message || 'Something went wrong. Please try again.', 'error', 4200);
    }
}

async function saveProfile(e) {
    e.preventDefault();
    if (SAVING) return;

    if (!validateAll()) return;

    var data = collectProfileData();
    setSaving(true);

    /* ---------- demo path ---------- */
    if (DEMO) {
        await new Promise(function (r) { setTimeout(r, 900); });
        console.info('[HRMS Profile] DEMO save:', data);
        finishSave(true, 'Demo save complete — redirecting…');
        return;
    }

    /* ---------- production path ---------- */

    /* 1. update the account row (same payload as the original script) */
    var userRes = await sb.from(CONFIG.tables.users)
        .update({
            phone:         data.phone,
            department_id: data.department_id,
            manager_id:    data.manager_id,
            joining_date:  data.joining_date
        })
        .eq('id', USER.id);

    if (userRes.error) {
        console.error('[HRMS Profile] users update:', userRes.error.message);
        finishSave(false, userRes.error.message);
        return;
    }

    /* 2. upsert the profile — update when one exists, insert when it
          doesn't (fixes the duplicate-row bug of the blind insert)      */
    var existing = await sb.from(CONFIG.tables.profiles)
        .select('id')
        .eq('user_id', USER.id)
        .maybeSingle();

    if (existing.error) {
        console.error('[HRMS Profile] lookup:', existing.error.message);
        finishSave(false, existing.error.message);
        return;
    }

    var res;
    if (existing.data && existing.data.id) {
        var row = Object.assign({}, data);
        delete row.user_id;
        res = await sb.from(CONFIG.tables.profiles)
            .update(row)
            .eq('id', existing.data.id);
    } else {
        res = await sb.from(CONFIG.tables.profiles)
            .insert([data]);
    }

    if (res.error) {
        console.error('[HRMS Profile] save:', res.error.message);
        finishSave(false, res.error.message);
        return;
    }

    finishSave(true);
}

/* ============================================================
   11. INIT
   ============================================================ */

function wireFields() {
    SECTIONS.forEach(function (sec) {
        sec.fields.forEach(function (id) {
            var el = byId(id);
            if (!el) return;

            var handler = function () {
                if (!PREFILLING) DIRTY = true;
                clearError(el);
                updateProgress(false);
            };

            el.addEventListener('input', handler);
            el.addEventListener('change', handler);

            /* validate on blur once the field has been touched */
            el.addEventListener('blur', function () {
                if (REQUIRED.indexOf(id) !== -1 || String(el.value || '').trim() !== '') {
                    validateField(id);
                }
            });
        });
    });
}

function init() {
    /* auth guard first — nothing else matters if we are signed out */
    sb = initClient();
    if (DEMO) {
        console.info('[HRMS Profile] DEMO MODE — fill CONFIG / supabase.js with real credentials to go live.');
    }
    if (!loadUser()) return;   /* redirected to login */

    var jd = byId('joiningDate');
    if (jd && !jd.value) jd.value = todayISO();   /* original default */

    wireFields();
    initSteps();
    updateProgress(true);

    /* load reference data, then prefill (order matters for selects) */
    (async function () {
        await loadDepartments();
        await loadManagers();
        await loadExistingProfile();
        DIRTY = false;   /* prefill is not a user edit */
    })();

    byId('profileForm').addEventListener('submit', saveProfile);

    /* unsaved-changes guard */
    window.addEventListener('beforeunload', function (e) {
        if (DIRTY && !SAVING) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

})();
