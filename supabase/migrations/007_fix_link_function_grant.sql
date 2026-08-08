-- Fixes a bug in 006_member_self_service.sql: that migration created
-- link_my_member_record() but never granted the `authenticated` role
-- permission to call it. Result: every signed-in member's first attempt to
-- link their login to their membership record failed with a permission
-- error — silently, since the app treats that failure the same as "no
-- matching member" and shows "we couldn't find you" either way.
--
-- If you already ran 006 on a live database, run just this file — it's a
-- single, safe, idempotent grant. (006 itself has also been patched with
-- this same line for anyone setting up fresh from scratch.)

grant execute on function link_my_member_record() to authenticated;
