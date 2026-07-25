-- KAN Membership Tracker — initial schema
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query → paste → Run).

-- ============================================================
-- 1. ALLOWED USERS  (this is what makes login "configurable via the app")
-- ============================================================
-- Anyone can create a Supabase Auth account, but nobody can see or touch
-- member data unless their email appears in this table. Admins manage this
-- table from inside the app's "Manage Access" screen — no dashboard trip
-- needed after the first admin is seeded below.

create table if not exists allowed_users (
  email      text primary key,
  is_admin   boolean not null default false,
  added_by   text,
  added_at   timestamptz not null default now()
);

-- Seed the first admin. Everyone else is added later from inside the app.
insert into allowed_users (email, is_admin, added_by)
values ('manish.ravikumar@gmail.com', true, 'system')
on conflict (email) do nothing;

alter table allowed_users enable row level security;

-- Anyone logged in can READ the allow-list (needed so the app can show the
-- Manage Access screen and check "am I an admin?").
create policy "allowed_users: any authenticated user can read"
  on allowed_users for select
  using (auth.role() = 'authenticated');

-- Only existing admins can add/remove/edit rows.
create policy "allowed_users: only admins can write"
  on allowed_users for all
  using (
    exists (
      select 1 from allowed_users au
      where au.email = auth.email() and au.is_admin = true
    )
  )
  with check (
    exists (
      select 1 from allowed_users au
      where au.email = auth.email() and au.is_admin = true
    )
  );

-- ============================================================
-- 2. MEMBERS
-- ============================================================
create table if not exists members (
  id                        bigint generated always as identity primary key,
  name                      text not null,
  status                    text,          -- Life | Annual | Biennial | Expired | Lapsed
  category                  text,          -- Active | Renewal Due | Long Lapsed (derived, kept in sync by the app)
  type                      text,          -- Family | Single
  membership_payment_date   date,
  year_renewed              integer,
  other_names               text,
  address                   text,
  phone                     text,
  email                     text,
  spouse_name               text,
  children_names            text,
  native_place              text,
  notes                     text,
  attended_2026_new_year    boolean not null default false,
  event_2026_payment        numeric,
  event_2026_member_status  text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

alter table members enable row level security;

create policy "members: allowed users can read"
  on members for select
  using (exists (select 1 from allowed_users au where au.email = auth.email()));

create policy "members: allowed users can write"
  on members for all
  using (exists (select 1 from allowed_users au where au.email = auth.email()))
  with check (exists (select 1 from allowed_users au where au.email = auth.email()));

-- keep updated_at current on every edit
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger members_set_updated_at
  before update on members
  for each row execute function set_updated_at();

-- ============================================================
-- 3. REMINDER HISTORY
-- ============================================================
create table if not exists reminder_history (
  id              bigint generated always as identity primary key,
  member_id       bigint not null references members(id) on delete cascade,
  sent_at         timestamptz not null default now(),
  channel         text not null,   -- 'email' | 'sms'
  purpose         text,            -- 'renewal' | 'update-contact'
  reason          text,            -- 'contact-gap-phone' | 'contact-gap-email' (renewal campaign only)
  missing_fields  text[],          -- e.g. {address,phone} (update-contact campaign only)
  sent_by         text             -- email of the board member who sent it
);

alter table reminder_history enable row level security;

create policy "reminder_history: allowed users can read"
  on reminder_history for select
  using (exists (select 1 from allowed_users au where au.email = auth.email()));

create policy "reminder_history: allowed users can write"
  on reminder_history for all
  using (exists (select 1 from allowed_users au where au.email = auth.email()))
  with check (exists (select 1 from allowed_users au where au.email = auth.email()));

-- ============================================================
-- 4. Helpful index for the common "who hasn't been reminded" lookups
-- ============================================================
create index if not exists idx_reminder_history_member_id on reminder_history(member_id);
create index if not exists idx_members_category on members(category);
create index if not exists idx_members_status on members(status);
