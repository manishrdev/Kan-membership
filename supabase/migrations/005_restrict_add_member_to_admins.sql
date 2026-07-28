-- Follow-up to 004: Add Member is now admin-only too, matching Edit/Delete.
-- (004 deliberately left INSERT open to any allowed user; this tightens it.)
--
-- Safe to run on an already-migrated database — run this once in the
-- Supabase SQL Editor (Project → SQL Editor → New query → paste → Run).
-- If you haven't run 004 yet, run 004 first, then this one.

drop policy if exists "members: allowed users can insert" on members;

create policy "members: admins can insert"
  on members for insert
  with check (is_kan_admin());
