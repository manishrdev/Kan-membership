-- Restricts editing and deleting members to admin users only.
-- The app already hides the Edit/Delete controls from non-admins, but this
-- migration enforces the same rule at the database level (row level
-- security), so it holds even if someone calls the API directly.
--
-- Adding new members stays open to any allowed user (not just admins) here —
-- only edit (UPDATE) and delete (DELETE) are being locked down in this file.
-- (Add Member was later locked to admins too, in migration 005.)
--
-- Safe to run on an already-migrated database — run this once in the
-- Supabase SQL Editor (Project → SQL Editor → New query → paste → Run).

drop policy if exists "members: allowed users can write" on members;

create policy "members: allowed users can insert"
  on members for insert
  with check (exists (select 1 from allowed_users au where au.email = auth.email()));

create policy "members: admins can update"
  on members for update
  using (is_kan_admin())
  with check (is_kan_admin());

create policy "members: admins can delete"
  on members for delete
  using (is_kan_admin());
