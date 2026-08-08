-- Fixes a second bug in 006_member_self_service.sql (the first, missing
-- EXECUTE grant, was fixed in 007). This one is more fundamental:
-- protect_admin_only_member_fields() — the trigger that stops members from
-- editing admin-only columns via a raw API call — included auth_user_id in
-- its list of fields to silently revert for non-admins. Since a member
-- linking their account for the first time is, by definition, not an
-- admin, this trigger was reverting link_my_member_record()'s own UPDATE
-- in the same statement: the function would still find and return the
-- member's row id, but the auth_user_id column itself would snap right
-- back to null. That looked exactly like "no matching member" from the
-- app's point of view, even though the record and the email match were
-- both correct.
--
-- Confirmed live: calling link_my_member_record() returned a valid member
-- id every time, but a follow-up select of that same row showed
-- auth_user_id still null — and a debug SECURITY DEFINER function
-- confirmed auth.uid() itself was resolving correctly, narrowing it down
-- to this trigger.
--
-- Safe to remove auth_user_id from the reset list: the
-- "members: self can update own row" RLS policy already requires
-- auth_user_id = auth.uid() before any update is allowed at all, so a
-- member can never use the normal update path to touch a row that isn't
-- already linked to them. Only link_my_member_record()'s own
-- SECURITY DEFINER logic (itself gated on auth_user_id being null AND the
-- caller's verified email matching) can ever set this column.

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
