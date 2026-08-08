-- Member self-service portal: lets every KAN member (not just allowed_users
-- admins/committee) log in via the same magic-link flow and see + edit only
-- their own record, from the new public/profile.html page. index.html (the
-- admin dashboard) is completely unaffected by this migration.
--
-- Safe to run on an already-migrated database — run this once in the
-- Supabase SQL Editor (Project → SQL Editor → New query → paste → Run).

-- ============================================================
-- 1. Link column: ties a members row to a specific Supabase Auth identity.
-- ============================================================
-- Deliberately matched by email ONCE (via link_my_member_record(), below)
-- rather than re-matched by email on every request. That's what lets a
-- member later edit their own contact email without breaking their own
-- login — once linked, the connection is by stable auth user id, not by
-- whatever the email column currently says.
alter table members add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

create index if not exists idx_members_auth_user_id on members(auth_user_id);

-- ============================================================
-- 2. First-login linking RPC.
-- ============================================================
-- SECURITY DEFINER so it can look up a member by email (bypassing RLS,
-- which at this point wouldn't grant a matching row yet since nothing is
-- linked) — but it only ever touches the ONE row matching the caller's own
-- verified auth email, and only if that row isn't already linked to someone
-- else. Safe to call every time the member portal loads; it's a no-op once
-- linked, and returns the linked member id either way (or null if no
-- matching membership record exists for this email).
create or replace function link_my_member_record()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  my_email text := lower(trim(coalesce(auth.email(), '')));
  matched_id bigint;
begin
  if my_email = '' then
    return null;
  end if;

  select id into matched_id from members where auth_user_id = auth.uid();
  if matched_id is not null then
    return matched_id;
  end if;

  update members
    set auth_user_id = auth.uid()
    where lower(trim(email)) = my_email
      and auth_user_id is null
    returning id into matched_id;

  return matched_id;
end;
$$;

-- CREATE FUNCTION does not by itself let signed-in members call this — the
-- authenticated role needs explicit EXECUTE, or every call fails with a
-- permission error before the linking logic ever runs (which the app
-- quietly treats the same as "no matching member," masking the real cause).
grant execute on function link_my_member_record() to authenticated;

-- ============================================================
-- 3. RLS: members can read + update their own row.
-- ============================================================
-- Additive alongside the existing allowed_users/admin policies from
-- 001/004/005 — those are untouched, so the admin dashboard's behavior
-- doesn't change at all.
create policy "members: self can read own row"
  on members for select
  using (auth_user_id = auth.uid());

create policy "members: self can update own row"
  on members for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- ============================================================
-- 4. Column lock for self-edits.
-- ============================================================
-- RLS is row-level only — without this, a member could still UPDATE their
-- own row's status/category/type/payment date/etc. via a raw API call, not
-- just through the profile page's form. This trigger silently reverts any
-- admin-only column back to its previous value whenever the person making
-- the change is not an admin, so self-service edits can only ever take
-- effect on the contact-info columns (email, phone, address, spouse_name,
-- children_names, native_place, notes). Admin edits via the dashboard are
-- unaffected — is_kan_admin() is true there, so nothing gets reverted.
-- NOTE: auth_user_id is deliberately NOT in this reset list. It's tempting
-- to include it (it looks like "just another column a member shouldn't be
-- able to change"), but doing so silently breaks first-time self-service
-- linking entirely: link_my_member_record() sets auth_user_id via an
-- UPDATE, and since a linking member is by definition not yet an admin,
-- this trigger would revert that same UPDATE back to null in the same
-- statement — the row would still get *found* (id comes back fine) but
-- never actually get linked. It's already safe to leave unprotected here:
-- the "members: self can update own row" RLS policy requires
-- auth_user_id = auth.uid() before ANY update is allowed at all, so a
-- member can never reach this trigger for a row that isn't already theirs
-- via the normal update path — only link_my_member_record()'s
-- SECURITY DEFINER context (itself gated on auth_user_id is null AND a
-- verified email match) can ever set it in the first place.
create or replace function protect_admin_only_member_fields()
returns trigger
language plpgsql
as $$
begin
  if not is_kan_admin() then
    new.name := old.name;
    new.status := old.status;
    new.category := old.category;
    new.type := old.type;
    new.membership_payment_date := old.membership_payment_date;
    new.year_renewed := old.year_renewed;
    new.other_names := old.other_names;
    new.attended_2026_new_year := old.attended_2026_new_year;
    new.event_2026_payment := old.event_2026_payment;
    new.event_2026_member_status := old.event_2026_member_status;
  end if;
  return new;
end;
$$;

drop trigger if exists members_protect_admin_only_fields on members;
create trigger members_protect_admin_only_fields
  before update on members
  for each row execute function protect_admin_only_member_fields();
