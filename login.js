/* ============================================================================
   HRMS — LOGIN · login.js
   ----------------------------------------------------------------------------
   Signs the user in and stores the account row in
   localStorage.loggedInUser — the same auth model your profile-setup.js and
   dashboard.js already use.

   ── HOW SIGN-IN RESOLVES ───────────────────────────────────────────────────
   1. Credentials come from supabase.js — THE ONLY FILE YOU EDIT (it defines
      window.HRMS_CONFIG + one shared client, window.HRMS_SB).
   2. Production: looks up `users` by email.
        • If the row has a `password` column → plain-text compare
          (quick start only — see security note below).
        • If there is no password column → any password is accepted and a
          warning is logged, so the flow keeps working either way.
   3. Demo mode (no credentials yet): any email/password works, or press
      "Enter Demo Mode".

   ── SECURITY NOTE ──────────────────────────────────────────────────────────
   Storing/ comparing raw passwords from the browser is NOT secure and the
   anon key must never see password hashes. This is provided to match your
   current localStorage flow. For production, migrate to Supabase Auth
   (sb.auth.signInWithPassword) and switch dashboard.js/profile-setup.js
   guards to sb.auth.getSession().
   ========================================================================== */

(function () {
'use strict';

/* ============================================================
   1. CONFIG
   ============================================================ */

var CONFIG = {
    supabaseUrl:     'YOUR_SUPABASE_URL',       // fallback if supabase.js is absent
    supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',
    usersTable:      'users',
    dashboardUrl:    'dashboard.html',
    demoName:        'Nitin Jangra'
};

/* supabase.js (central config — the only file you edit) overrides this block */
(function () {
    var HC = window.HRMS_CONFIG;
    if (!HC) return;
    if (HC.dashboardUrl) CONFIG.dashboardUrl = HC.dashboardUrl;
    if (HC.tables && HC.tables.users) CONFIG.usersTable = HC.tables.users;
})();

/* ============================================================
   2. UTILS
   ============================================================ */

function byId(id) { return document.getElementById(id); }

var REDUCE = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function toast(msg, type, ms) {
    var stack = byId('toastStack');
    if (!stack) return;
    var icons = { success: 'check', error: 'x', info: 'info' };
    type = icons[type] ? type : 'info';

    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML =
        '<span class="toast-ico"><i data-lucide="' + icons[type] + '"></i></span>' +
        '<span></span>';
    el.lastChild.textContent = msg;
    stack.appendChild(el);
    if (window.lucide) window.lucide.createIcons();

    setTimeout(function () {
        el.classList.add('out');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, ms || 3400);
}

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

function shake(el) {
    var wrap = fieldWrap(el);
    if (!wrap) return;
    wrap.classList.add('shake');
    setTimeout(function () { wrap.classList.remove('shake'); }, 500);
}

function validEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim());
}

/* ============================================================
   3. SUPABASE RESOLUTION (same pattern as the other pages)
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

var DEMO = true;
var sb = null;

(function initClient() {
    var c = resolveCredentials();
    DEMO = !/^https:\/\/(?!YOUR_)/.test(c.url) || c.key.indexOf('YOUR_') === 0;
    if (DEMO) return;

    /* reuse the ONE client created by supabase.js (window.HRMS_SB) */
    if (window.HRMS_SB) { sb = window.HRMS_SB; return; }

    if (!window.supabase || !window.supabase.createClient) { DEMO = true; return; }
    try { sb = window.supabase.createClient(c.url, c.key); }
    catch (e) { console.error('[HRMS Login] Supabase init failed:', e.message); DEMO = true; }
})();

/* ============================================================
   4. SESSION
   ============================================================ */

function storeSession(account) {
    var acc = Object.assign({}, account);
    delete acc.password;             /* never persist credentials */
    try {
        localStorage.setItem('loggedInUser', JSON.stringify(acc));
    } catch (e) {
        console.error('[HRMS Login] localStorage unavailable:', e);
    }
}

/* already signed in? go straight to the dashboard */
(function () {
    var raw = null;
    try { raw = localStorage.getItem('loggedInUser'); } catch (e) {}
    if (raw) {
        try {
            var u = JSON.parse(raw);
            if (u && u.id != null && !DEMO) {
                window.location.replace(CONFIG.dashboardUrl);
            }
        } catch (e) { /* corrupted key — show the form */ }
    }
})();

/* remembered email prefill (the "Remember me" checkbox) */
(function () {
    try {
        var saved = localStorage.getItem('hrmsRememberEmail');
        if (saved && byId('loginEmail')) byId('loginEmail').value = saved;
    } catch (e) {}
})();

/* ============================================================
   5. LOADING STATE
   ============================================================ */

var SAVING = false;

function setBusy(on, label) {
    SAVING = on;
    var btn = byId(label === 'demo' ? 'demoBtn' : 'loginBtn');
    var lab = byId('loginBtnLabel');
    if (btn === byId('loginBtn')) btn.classList.toggle('loading', on);
    if (lab) lab.textContent = on ? 'Signing in…' : 'Sign In';
    if (btn === byId('demoBtn')) btn.classList.toggle('loading', on);
    byId('loginBtn').disabled = on;
    byId('demoBtn').disabled = on;
}

/* ============================================================
   6. SIGN-IN FLOWS
   ============================================================ */

function enterAs(account, note) {
    storeSession(account);
    if (note) toast(note, 'success');
    setTimeout(function () {
        window.location.href = CONFIG.dashboardUrl;
    }, 600);
}

async function signIn(email, password) {
    setBusy(true);

    try {
        if (DEMO) {
            await new Promise(function (r) { setTimeout(r, 700); });
            enterAs(
                { id: 1, name: CONFIG.demoName, email: email },
                'Signed in to demo workspace'
            );
            return;
        }

        var res = await sb.from(CONFIG.usersTable)
            .select('*')
            .eq('email', email)
            .maybeSingle();

        if (res.error) throw res.error;

        if (!res.data) {
            setBusy(false);
            var em = byId('loginEmail');
            showError(em, 'No account found with this email.');
            shake(em);
            toast('No account found with this email.', 'error');
            return;
        }

        var row = res.data;

        if ('password' in row) {
            if (String(row.password) !== String(password)) {
                setBusy(false);
                var pw = byId('loginPassword');
                showError(pw, 'Incorrect password.');
                shake(pw);
                toast('Incorrect password. Please try again.', 'error');
                return;
            }
        } else {
            console.warn('[HRMS Login] users table has no password column — ' +
                'email-only sign-in accepted. Add a password column or move to Supabase Auth.');
        }

        enterAs(row, 'Welcome back, ' + String(row.name || '').split(' ')[0] + '!');
    } catch (e) {
        setBusy(false);
        console.error('[HRMS Login] failed:', e.message || e);
        toast(e.message || 'Sign-in failed. Check your connection.', 'error', 4200);
    }
}

/* ============================================================
   7. UI BINDINGS
   ============================================================ */

function bind() {

    var form = byId('loginForm');

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (SAVING) return;

        var email = byId('loginEmail');
        var pwd   = byId('loginPassword');
        var ok = true;

        clearError(email);
        clearError(pwd);

        if (!validEmail(email.value)) {
            showError(email, 'Enter a valid email address.');
            shake(email);
            ok = false;
        }
        if (String(pwd.value).length < 4) {
            showError(pwd, 'Password must be at least 4 characters.');
            shake(pwd);
            ok = false;
        }
        if (!ok) return;

        /* remember-me → prefill email next visit */
        try {
            if (byId('rememberMe').checked) {
                localStorage.setItem('hrmsRememberEmail', String(email.value).trim());
            } else {
                localStorage.removeItem('hrmsRememberEmail');
            }
        } catch (err) {}

        signIn(String(email.value).trim(), String(pwd.value));
    });

    /* show / hide password */
    byId('togglePwd').addEventListener('click', function () {
        var pw = byId('loginPassword');
        var show = pw.type === 'password';
        pw.type = show ? 'text' : 'password';
        this.innerHTML = '<i data-lucide="' + (show ? 'eye-off' : 'eye') + '"></i>';
        this.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        if (window.lucide) window.lucide.createIcons();
    });

    /* demo shortcut */
    byId('demoBtn').addEventListener('click', function () {
        if (SAVING) return;
        setBusy(true, 'demo');
        enterAs(
            { id: 1, name: CONFIG.demoName, email: 'demo@hrims.app' },
            'Entering demo workspace…'
        );
    });

    /* forgot password */
    byId('forgotLink').addEventListener('click', function () {
        toast('Please contact HR to reset your password.', 'info');
    });

    /* live validation feedback */
    byId('loginEmail').addEventListener('input', function () { clearError(this); });
    byId('loginPassword').addEventListener('input', function () { clearError(this); });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
} else {
    bind();
}

if (DEMO) {
    console.info('[HRMS Login] DEMO MODE — any email/password works, or use "Enter Demo Mode".');
}

})();
