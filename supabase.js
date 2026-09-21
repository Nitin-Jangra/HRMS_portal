/* ============================================================================
   HRMS — CENTRAL CONFIGURATION  ·  supabase.js
   ----------------------------------------------------------------------------
   ███████████████████████████████████████████████████████████████████████████
   █  THIS IS THE ONLY FILE YOU EDIT.                                        █
   █  index.html · dashboard.html · profile-setup.html all load this file    █
   █  BEFORE their own scripts and take everything from here.                █
   ███████████████████████████████████████████████████████████████████████████

   ── GO LIVE IN 2 STEPS ──────────────────────────────────────────────────────
     1. Open your Supabase Dashboard → ⚙ Project Settings → API
     2. Copy the two values into the marked block below:
          · "Project URL"          →  supabaseUrl
          · "anon / public" key    →  supabaseKey
        (the long key starting with "eyJ…" or "sb_publishable_…")

   ── WHAT HAPPENS AUTOMATICALLY ─────────────────────────────────────────────
     • One shared Supabase client is created here (window.HRMS_SB) and every
       page reuses that single reference — no per-page keys anywhere.
     • Redirect targets (login page / dashboard) also come from this file.
     • While the placeholders below are untouched, every page quietly runs in
       DEMO MODE: fully clickable, sample data, nothing is written anywhere.
     • Tables the app reads/writes (created by hrms-schema.sql, or already
       present in your project):
         users · departments · employee_profiles            ← yours, existing
         attendance · leave_requests · overtime · tasks     ← hrms-schema.sql
         holidays · announcements · activities ·
         notifications · messages                           ← hrms-schema.sql

   ── SECURITY NOTE ──────────────────────────────────────────────────────────
     The anon key is designed to be public — it is safe in front-end code as
     long as Row Level Security (RLS) is enabled on your tables. Run
     hrms-schema.sql which enables RLS + creates the matching policies.
   ========================================================================== */

(function (window) {
'use strict';

/* ╔════════════════════════════════════════════════════════════════════╗
   ║   1 · PASTE YOUR CREDENTIALS HERE — the only edit you ever make    ║
   ╚════════════════════════════════════════════════════════════════════╝ */

var CONFIG = {

    /* Supabase Dashboard → Project Settings → API → "Project URL"
       Example: 'https://abcdefghijklmnopqrst.supabase.co'                */
    supabaseUrl: 'https://qalpehjzykkpvkzzikwl.supabase.co',

    /* Supabase Dashboard → Project Settings → API → "anon public"
       Example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3M4…'          */
    supabaseKey: 'sb_publishable_mWRL6nZ6vt1a78yuCdcNKA_kqI-1s_C',

    /* Pages & redirects — change only if you renamed the files */
    loginUrl:     'index.html',       // signed-out users land here
    dashboardUrl: 'hrms.html',        // signed-in users land here (single-page HRMS)

    /* Table names — rename only if your Supabase tables differ */
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

/* ╚═══════════════════════ END OF USER EDIT AREA ══════════════════════╝
   Everything below is automatic — you never need to touch it.
   ====================================================================== */

/* ---- detect whether real credentials were pasted ----------------------- */
function looksRealUrl(v) {
    return typeof v === 'string' &&
        /^https:\/\/[a-z0-9-]+\.supabase\.(co|in|net)/i.test(v.trim());
}

function looksRealKey(v) {
    if (typeof v !== 'string') return false;
    v = v.trim();
    if (v.length < 30) return false;                       // too short = placeholder
    if (v.indexOf('YOUR_') === 0) return false;            // untouched placeholder
    return /^eyJ/.test(v) || /^sb_publishable_/.test(v);   // JWT or new-style key
}

var url = String(CONFIG.supabaseUrl || '').trim();
var key = String(CONFIG.supabaseKey  || '').trim();
var CONFIGURED = looksRealUrl(url) && looksRealKey(key);

/* ---- expose one config object every page reads from -------------------- */
window.HRMS_CONFIG = {
    supabaseUrl:     url,
    supabaseAnonKey: key,
    supabaseKey:     key,        /* alias — some pages use either name */
    loginUrl:        CONFIG.loginUrl,
    dashboardUrl:    CONFIG.dashboardUrl,
    tables:          CONFIG.tables,
    configured:      CONFIGURED, /* true = production, false = demo mode  */
    demo:            !CONFIGURED
};

/* legacy globals — the page scripts' resolvers also read these,
   so older code keeps working without any change                          */
window.supabaseUrl = url;
window.supabaseKey = key;

/* ---- one shared Supabase client for the whole app ----------------------
   Created here, once. dashboard.js / profile-setup.js / login.js all
   reuse window.HRMS_SB instead of building their own clients.             */
window.HRMS_SB = null;

if (CONFIGURED) {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
        try {
            window.HRMS_SB = window.supabase.createClient(url, key);
            console.info('%c[HRMS] Connected to Supabase ✓',
                'background:#0D6EFD;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700');
        } catch (e) {
            console.error('[HRMS] Could not create Supabase client:', e.message);
        }
    } else {
        console.warn('[HRMS] supabase-js CDN did not load — check your internet ' +
            'connection or the <script> tag order in the HTML files.');
    }
} else {
    console.info(
        '%c[HRMS] Demo mode%c — paste your URL + anon key in supabase.js to go live.',
        'background:#F59E0B;color:#111827;padding:2px 8px;border-radius:4px;font-weight:700',
        ''
    );
}

})(window);
