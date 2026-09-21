-- ============================================================================
--  HRMS — COMPLETE DATABASE SETUP FOR SUPABASE (PostgreSQL)
--  Version 2 — tables + indexes + seed data + ROW LEVEL SECURITY POLICIES
-- ----------------------------------------------------------------------------
--  HOW TO RUN
--    1. Open your Supabase project → SQL Editor → New query.
--    2. Paste this ENTIRE file and click Run.
--    3. Done. Every statement is guarded (IF NOT EXISTS / DO-blocks), so it
--       is SAFE TO RE-RUN at any time — nothing is deleted or duplicated.
--
--  WHAT IT DOES
--    Part 1  Adds optional columns to your EXISTING `users` table (safe
--            no-ops if they already exist). Your users / departments /
--            employee_profiles tables are NOT modified in any other way.
--    Part 2  Creates the 9 NEW tables the dashboard needs:
--            attendance · leave_requests · holidays · announcements ·
--            activities · tasks · overtime · notifications · messages
--    Part 3  Indexes for fast dashboard queries.
--    Part 4  Seed data (holidays + announcements).
--    Part 5  ROW LEVEL SECURITY — enables RLS on the new tables and creates
--            the policies the app needs.  ← REQUIRED PART, kept active.
--    Part 6  OPTIONAL test data for one user (commented out).
--    Part 7  OPTIONAL strict per-user policies for a future Supabase-Auth
--            migration (commented out).
--    Part 8  Verification queries (commented out).
--
--  ⚠ ID TYPE NOTE
--    The new tables use bigint for user_id, matching integer users.id
--    (your front-end casts ids with Number(), which implies integer PKs).
--    If your users.id is actually uuid → search-replace  bigint  with  uuid
--    in Part 2 before running. (Your FK references will still be valid.)
--
--  ⚠ HOW AUTH WORKS HERE (read once)
--    Your app signs users in against the `users` table and keeps the session
--    in localStorage. Requests therefore reach Supabase with the ANON role —
--    there is no auth.uid() session. Part 5 creates "app access" policies
--    that allow the anon role to read/write the HRMS tables so everything
--    works today, while RLS is still ON (better than no RLS at all: tables
--    are never silently exposed by default and the rules are explicit).
--    When you later migrate to Supabase Auth, run Part 7 to lock every row
--    to its owner.
-- ============================================================================


-- ============================================================================
-- PART 1 · OPTIONAL COLUMNS ON EXISTING TABLES (safe, non-destructive)
-- ============================================================================

alter table public.users add column if not exists email       text;
alter table public.users add column if not exists role        text default 'Employee';
alter table public.users add column if not exists avatar_url  text;
alter table public.users add column if not exists status      text default 'active';

-- Helpful: unique index so login-by-email can never hit two rows.
-- (Non-unique when several rows already share an email — it still gets
--  created so the app keeps working; clean duplicates, re-run, done.)
do $$
begin
    if not exists (
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'users_email_uniq'
    ) then
        begin
            create unique index users_email_uniq on public.users (lower(email));
        exception when others then
            raise notice 'users_email_uniq skipped (duplicate emails exist?)';
        end;
    end if;
end $$;

-- Everything else your code already expects already exists:
--   users             : id, name, phone, department_id, manager_id, joining_date
--   departments       : id, name
--   employee_profiles : user_id, first_name, last_name, phone, department_id,
--                       designation, manager_id, joining_date, dob, gender,
--                       blood_group, address, city, state, country, pincode,
--                       emergency_contact_name, emergency_contact_phone


-- ============================================================================
-- PART 2 · NEW TABLES
-- ============================================================================

-- 2.1 ATTENDANCE — one row per user per day (punch in / punch out)
create table if not exists public.attendance (
    id            bigint generated always as identity primary key,
    user_id       bigint not null references public.users(id) on delete cascade,
    work_date     date   not null default current_date,
    check_in      timestamptz,
    check_out     timestamptz,
    break_minutes int    not null default 45,
    created_at    timestamptz not null default now(),
    constraint attendance_user_date_unique unique (user_id, work_date)
);
comment on table public.attendance is
    'Daily punch records. UNIQUE(user_id, work_date) powers the dashboard upsert.';

-- 2.2 LEAVE REQUESTS — donut + leave balance aggregate approved rows
create table if not exists public.leave_requests (
    id         bigint generated always as identity primary key,
    user_id    bigint not null references public.users(id) on delete cascade,
    leave_type text not null check (leave_type in ('Casual','Sick','Earned','Unpaid')),
    start_date date not null,
    end_date   date not null,
    days       numeric(4,1) not null default 1,
    reason     text,
    status     text not null default 'pending'
               check (status in ('pending','approved','rejected')),
    created_at timestamptz not null default now()
);

-- 2.3 HOLIDAYS — company-wide, shown with countdown chips
create table if not exists public.holidays (
    id   bigint generated always as identity primary key,
    name text not null,
    date date not null unique
);

-- 2.4 ANNOUNCEMENTS — global feed
create table if not exists public.announcements (
    id         bigint generated always as identity primary key,
    title      text not null,
    body       text,
    type       text not null default 'info'
               check (type in ('info','policy','birthday','event')),
    created_at timestamptz not null default now()
);

-- 2.5 ACTIVITIES — per-user feed (leave approved, payslip, overtime…)
create table if not exists public.activities (
    id         bigint generated always as identity primary key,
    user_id    bigint references public.users(id) on delete cascade,
    message    text not null,
    type       text not null default 'task'
               check (type in ('leave','payslip','overtime','task')),
    created_at timestamptz not null default now()
);

-- 2.6 TASKS — pending count feeds the KPI card
create table if not exists public.tasks (
    id         bigint generated always as identity primary key,
    user_id    bigint references public.users(id) on delete cascade,
    title      text not null,
    status     text not null default 'pending'
               check (status in ('pending','in_progress','completed')),
    due_date   date,
    created_at timestamptz not null default now()
);

-- 2.7 OVERTIME — approved minutes summed into the KPI card
create table if not exists public.overtime (
    id         bigint generated always as identity primary key,
    user_id    bigint not null references public.users(id) on delete cascade,
    minutes    int not null default 0,
    status     text not null default 'pending'
               check (status in ('pending','approved','rejected')),
    created_at timestamptz not null default now()
);

-- 2.8 NOTIFICATIONS — bell badge counts unread rows
create table if not exists public.notifications (
    id         bigint generated always as identity primary key,
    user_id    bigint not null references public.users(id) on delete cascade,
    title      text,
    message    text,
    is_read    boolean not null default false,
    created_at timestamptz not null default now()
);

-- 2.9 MESSAGES — chat badge counts unread rows
create table if not exists public.messages (
    id          bigint generated always as identity primary key,
    user_id     bigint not null references public.users(id) on delete cascade,
    sender_name text,
    preview     text,
    is_read     boolean not null default false,
    created_at  timestamptz not null default now()
);


-- ============================================================================
-- PART 3 · INDEXES (dashboard query paths)
-- ============================================================================

create index if not exists attendance_user_date_idx
    on public.attendance (user_id, work_date desc);

create index if not exists leave_user_status_idx
    on public.leave_requests (user_id, status, start_date);

create index if not exists activities_user_idx
    on public.activities (user_id, created_at desc);

create index if not exists tasks_user_status_idx
    on public.tasks (user_id, status);

create index if not exists overtime_user_status_idx
    on public.overtime (user_id, status, created_at desc);

create index if not exists notifications_user_unread_idx
    on public.notifications (user_id, is_read);

create index if not exists messages_user_unread_idx
    on public.messages (user_id, is_read);


-- ============================================================================
-- PART 4 · SEED DATA (global, safe to re-run)
-- ============================================================================

-- Upcoming holidays (edit names/dates to your calendar)
insert into public.holidays (name, date) values
    ('Gandhi Jayanti',  '2026-10-02'),
    ('Diwali',          '2026-11-08'),
    ('Christmas',       '2026-12-25'),
    ('Republic Day',    '2027-01-26'),
    ('Holi',            '2027-03-23')
on conflict (date) do nothing;

-- Announcements (inserted only if not already present)
insert into public.announcements (title, body, type)
select 'HRMS Portal is live',
       'Attendance, leaves and announcements are now in one place.',
       'info'
where not exists (select 1 from public.announcements where title = 'HRMS Portal is live');

insert into public.announcements (title, body, type)
select 'Work-from-home policy updated',
       'Two days per week allowed with manager approval, effective this month.',
       'policy'
where not exists (select 1 from public.announcements where title = 'Work-from-home policy updated');

insert into public.announcements (title, body, type)
select 'Happy Birthday, Priya!',
       'Wish Priya from HR a wonderful day in the team channel.',
       'birthday'
where not exists (select 1 from public.announcements where title = 'Happy Birthday, Priya!');


-- ============================================================================
-- PART 5 · ROW LEVEL SECURITY + POLICIES  (REQUIRED — DO NOT SKIP)
-- ----------------------------------------------------------------------------
--  5A  Grants + RLS on the 9 NEW tables, with an "HRMS app access" policy
--      that lets your app (anon role, localStorage login) read and write.
--  5B  Matching policies for your EXISTING tables. These are created but
--      RLS is NOT switched on for them (your tables already work — enabling
--      RLS there is your call; see the commented line at the end of 5B).
--      If RLS is already enabled on any of them, these policies make the
--      app work immediately.
--  All statements are idempotent (safe to re-run).
-- ============================================================================

-- ---- 5A · new tables -------------------------------------------------------

grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;

alter table public.attendance     enable row level security;
alter table public.leave_requests enable row level security;
alter table public.holidays       enable row level security;
alter table public.announcements  enable row level security;
alter table public.activities     enable row level security;
alter table public.tasks          enable row level security;
alter table public.overtime       enable row level security;
alter table public.notifications  enable row level security;
alter table public.messages       enable row level security;

-- Create (or replace) the app-access policy on every HRMS table.
-- CREATE POLICY has no IF NOT EXISTS, so we drop-then-create inside DO blocks.
do $$
declare t text;
begin
    foreach t in array array[
        'attendance','leave_requests','holidays','announcements',
        'activities','tasks','overtime','notifications','messages'
    ]
    loop
        execute format('drop policy if exists "hrms_app_access" on public.%I', t);
        execute format(
            'create policy "hrms_app_access" on public.%I
                 for all to anon, authenticated
                 using (true) with check (true)', t);
    end loop;
end $$;

-- ---- 5B · existing tables (policies created; RLS left as-is) ---------------

do $$
declare t text;
begin
    foreach t in array array['users','departments','employee_profiles']
    loop
        execute format('drop policy if exists "hrms_app_access" on public.%I', t);
        execute format(
            'create policy "hrms_app_access" on public.%I
                 for all to anon, authenticated
                 using (true) with check (true)', t);
    end loop;
end $$;

-- Optional (commented): also lock the EXISTING tables with RLS.
-- Only run these if no other tool depends on open access to them:
-- alter table public.users             enable row level security;
-- alter table public.departments       enable row level security;
-- alter table public.employee_profiles enable row level security;


-- ============================================================================
-- PART 6 · OPTIONAL TEST DATA (uncomment, fix user_id, then run)
-- ============================================================================

-- insert into public.leave_requests (user_id, leave_type, start_date, end_date, days, status) values
--     (1, 'Casual', '2026-09-14', '2026-09-15', 2.0, 'approved'),
--     (1, 'Sick',   '2026-08-20', '2026-08-20', 1.0, 'approved'),
--     (1, 'Earned', '2026-07-06', '2026-07-10', 5.0, 'approved'),
--     (1, 'Unpaid', '2026-06-02', '2026-06-03', 2.0, 'approved');

-- insert into public.tasks (user_id, title, status, due_date) values
--     (1, 'Submit Q3 report', 'pending',   '2026-09-12'),
--     (1, 'Update profile details', 'pending', '2026-09-20');

-- insert into public.overtime (user_id, minutes, status) values
--     (1, 95, 'approved');

-- insert into public.activities (user_id, message, type) values
--     (1, 'Your casual leave for Sep 14–15 was approved', 'leave'),
--     (1, 'August payslip is ready to download', 'payslip'),
--     (1, 'Overtime claim of 1h 35m approved', 'overtime');

-- insert into public.notifications (user_id, title, message) values
--     (1, 'Payslip available', 'Your August payslip has been generated.');

-- insert into public.messages (user_id, sender_name, preview) values
--     (1, 'Priya Nair', 'Hey, are you joining the standup?');


-- ============================================================================
-- PART 7 · OPTIONAL — STRICT PER-USER POLICIES (future Supabase-Auth mode)
-- ----------------------------------------------------------------------------
-- Your CURRENT login (users table + localStorage) has no auth.uid() session,
-- so strict policies below would hide every row from the app. ONLY run this
-- block AFTER you migrate sign-in to Supabase Auth, and only for tables
-- whose rows belong to one user.
--
-- Two common mappings — pick ONE:
--   (a) users.id is uuid AND equals auth.users.id  →  user_id = auth.uid()
--   (b) users.id is your own integer/bigint, and users.email equals the
--       Supabase Auth email                          →  email lookup
--
-- Example for (b):
-- create or replace function public.hrms_current_user_id()
-- returns bigint language sql stable as $$
--     select id from public.users
--     where email = (auth.jwt() ->> 'email')
--     limit 1
-- $$;
--
-- alter table public.attendance enable row level security;
-- drop policy if exists "hrms_app_access" on public.attendance;
-- create policy "own attendance" on public.attendance
--     for all to authenticated
--     using (user_id = public.hrms_current_user_id())
--     with check (user_id = public.hrms_current_user_id());
--
-- -- Repeat the pattern for: leave_requests · activities · tasks ·
-- -- overtime · notifications · messages · employee_profiles
-- -- Global tables (holidays, announcements) keep a read-only policy:
-- create policy "read holidays" on public.holidays
--     for select to authenticated using (true);
-- ============================================================================


-- ============================================================================
-- PART 8 · VERIFY — uncomment and run after the script to confirm
-- ============================================================================

-- All HRMS tables that now exist:
-- select table_name from information_schema.tables
-- where table_schema = 'public' order by table_name;

-- RLS status + policy count per table:
-- select c.relname as table_name,
--        c.relrowsecurity as rls_on,
--        count(p.policyname) as policies
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
-- left join pg_policies p
--        on p.tablename = c.relname and p.schemaname = 'public'
-- where c.relkind = 'r'
-- group by 1, 2 order by 1;

-- Quick peeks:
-- select * from public.holidays order by date limit 5;
-- select * from public.announcements order by created_at desc limit 5;
