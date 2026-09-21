# HRMS — Go-Live Setup Guide

Your HRMS front-end is already complete (login → dashboard → profile setup,
one shared design system). This guide connects it to **your Supabase
database**. Total time: **≈ 5 minutes**.

---

## The one rule to remember

> **`supabase.js` is the ONLY file you edit.**
> Every page (index.html, dashboard.html, profile-setup.html) loads it first
> and takes its credentials, table names and redirect targets from there.
> You never touch dashboard.js / profile-setup.js / login.js.

---

## Step 1 — Run the database script (once)

1. Open **Supabase Dashboard → SQL Editor → New query**.
2. Open **`hrms-schema.sql`**, copy **the entire file**, paste it, click **Run**.

What it does:

| Part | Action |
|------|--------|
| 1 | Adds optional columns to your existing `users` table (`email`, `role`, `avatar_url`, `status`) — safe no-ops if they exist |
| 2 | Creates the 9 new tables: `attendance`, `leave_requests`, `holidays`, `announcements`, `activities`, `tasks`, `overtime`, `notifications`, `messages` |
| 3 | Creates indexes for the dashboard queries |
| 4 | Seeds holidays + announcements |
| 5 | **Enables RLS + creates the policies** (`hrms_app_access`) the app needs |
| 6–8 | Optional test data · future Supabase-Auth policies · verification queries |

The script is **safe to re-run** — nothing is dropped or duplicated.

> ⚠ **ID type note** — the new tables use `bigint` for `user_id` (your code
> casts ids with `Number()`, so `users.id` is presumably integer/bigint).
> If your `users.id` is `uuid`, search-replace `bigint` → `uuid` in Part 2
> before running.

---

## Step 2 — Paste your credentials (the only edit)

Open **`supabase.js`** and fill the two marked values:

```js
var CONFIG = {
    supabaseUrl: 'https://xxxxxxxxxxxx.supabase.co',   // ← Project URL
    supabaseKey: 'eyJhbGciOiJIUzI1NiIs...',            // ← anon / public key
    ...
};
```

Where to find them: **Supabase Dashboard → ⚙ Project Settings → API**

- **Project URL** → `supabaseUrl`
- **Project API keys → `anon` / `public`** → `supabaseKey`
  (starts with `eyJ…` or `sb_publishable_…`)

That's it — the shared client (`window.HRMS_SB`) is created here once and
**every page reuses this single reference**.

---

## Step 3 — Open the app

| File | Role |
|------|------|
| `index.html` | **Login page** (same as login.html) |
| `hrms.html` | **The complete HRMS — single-page app.** Every view lives here: Dashboard · Attendance · Leaves · Directory · My Tasks · Holidays · Announcements · My Profile · Settings. Every button is wired: punch in/out, apply/cancel leave, task add/complete/delete, notifications mark-read, messages, global search (Ctrl+/), directory filters, profile save, preferences, logout. |
| `dashboard.html` · `profile-setup.html` | Legacy standalone pages — still work, but the single-page app replaces them |

Flow: **index.html** → sign in with an email that exists in your `users`
table → **hrms.html**.

### Sign-in behaviour

- The app looks up `users` by `email` (column added in Step 1 if missing).
- If your `users` table has a `password` column, it is compared
  (plain-text — quick start only).
- If there is **no password column**, any password is accepted (a console
  warning reminds you). Recommended: add the column, or move to Supabase
  Auth later (see hrms-schema.sql Part 7).

---

## Demo mode (before you paste credentials)

With the placeholders untouched, every page runs in **demo mode**:
fully clickable, sample data, nothing is written to any database. The
console shows an orange `[HRMS] Demo mode` banner. The moment you paste real
values in `supabase.js`, the banner turns blue (`Connected to Supabase ✓`)
and live data loads.

---

## Security notes (worth 2 minutes)

- The **anon key is designed to be public** — it is safe inside front-end
  code *provided* RLS is enabled. `hrms-schema.sql` Part 5 does exactly that
  for the new tables and creates explicit `hrms_app_access` policies.
- Because your login currently lives in the `users` table + localStorage
  (no `auth.uid()` session), those policies allow the anon role to work.
  That matches how your existing tables already run today.
- When you later migrate sign-in to **Supabase Auth**, run **Part 7** of
  `hrms-schema.sql` (strict per-user policies) so every row is locked to its
  owner.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Orange "Demo mode" banner stays after pasting keys | Hard-refresh (Ctrl+Shift+R). Check the URL looks like `https://xxxx.supabase.co` and the key starts with `eyJ` / `sb_publishable_` |
| Console: `relation "attendance" does not exist` | Step 1 not run (or run against a different project) |
| Data doesn't load, console shows RLS/permission errors | Re-run `hrms-schema.sql` — Part 5 (policies) is required |
| Login says "No account found" | The email must exist in `users.email`. Add it or register through your flow |
| Wrong table names in your project | Rename them in `supabase.js → CONFIG.tables` — no JS editing needed |
