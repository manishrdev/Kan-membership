# KAN Member Portal — Step-by-Step Setup (v9, unified single-link version)

Every KAN member — not just board members in Manage Access — can sign in
with their own email, see only their own record, edit their own contact
info, and view/print a digital membership card (green when Active, red
otherwise).

**As of v9, there is only one link for everyone.** `index.html` is now a
router: after sign-in, it shows the admin dashboard to board members, the
membership card to regular members, and — for anyone who's both (e.g. a
board member who's also a KAN member) — the dashboard by default with a
one-tap switch to their own card. Earlier versions had three separate
pages (`index.html`, `profile.html`, `card.html`); those are now folded
into this one entry point, so there's nothing to explain to members about
which link to use.

If you've already deployed the base KAN Membership Tracker (per
`SETUP_CHECKLIST.md`), this is the only new setup required.

---

## What's in this version

- `public/index.html`, `public/app.js` — now handle both the admin
  dashboard and the member card/edit view, routed by email after sign-in.
- `public/lib/member-portal.js` — the card/edit-form rendering logic
  (namespaced separately from `app.js`'s own admin-table logic so the two
  don't collide).
- `public/profile.css` — shared styling for the card, the collapsible
  "Edit my info" panel, and the code-entry login step. Now loaded by
  `index.html` too.
- `public/profile.html`, `public/card.html` — kept only as redirect stubs,
  so any old bookmarks or emailed links still land somewhere useful
  (they forward straight to `index.html`).
- `public/manifest.json` + `public/assets/kan-icon-192.png` /
  `kan-icon-512.png` — makes "Add to Home Screen" install a KAN-branded
  icon that opens straight back to `index.html`, the router.
- `public/lib/place-utils.js` — shared address-parsing helper used by both
  the admin location map and the member card's "City in USA" field.
- `supabase/migrations/006_member_self_service.sql` — the database changes
  that make member self-service possible (unchanged since v8 — no new
  migration needed if you already ran this one).

---

## Step 1 — Run the database migration (~2 min, skip if already done)

1. Go to your Supabase project → **SQL Editor → New query**.
2. Open `supabase/migrations/006_member_self_service.sql` from this folder,
   copy its entire contents, paste into the SQL editor, click **Run**.
3. This is safe to run on your already-live database, and safe to skip if
   you already ran it for a previous version. It only:
   - adds one new column to `members` (`auth_user_id`, used to link a
     member's login to their record — nothing existing is touched)
   - adds one new function that does that linking on first login
   - adds two new row-level-security policies (a member can read/update
     *their own row only* — the existing admin/board policies are
     untouched)
   - adds one trigger that silently blocks a member from changing their
     own status, type, category, renewal date, or name, even via a direct
     API call — only the admin dashboard can change those

No existing table, policy, or data is modified or removed.

## Step 1b — Add the code to the login email (~2 min, required if not already done)

On iOS, tapping the emailed login link from someone's **home-screen icon**
opens Safari instead of the installed app — that's an Apple platform
limitation, not something the website can control (Safari and a home-screen
web app have completely separate storage, even for the same site). To work
around it, the login screen also accepts a code typed in by hand, which
finishes sign-in without needing to follow any link at all.

For the email to actually include that code, Supabase's email template
needs one small edit:

1. Go to **Authentication → Emails → Templates → Magic Link**.
2. In the email body, make sure `{{ .Token }}` appears somewhere (in
   addition to the existing `{{ .ConfirmationURL }}` link) — e.g. add a line
   like: `Or enter this code: {{ .Token }}`.
3. Save.

Both the link and the code now go out in the same email — people in a
regular browser can keep clicking the link as before; people opening the
site from their home-screen icon use the code instead.

## Step 2 — Deploy the updated files (~5 min)

1. Copy this entire `kan-hosted` folder over your existing project folder.
2. Commit and push to the GitHub repo connected to Cloudflare Pages, the
   same way you've deployed every update so far:
   ```
   git add .
   git commit -m "Unify admin/member pages into one router"
   git push
   ```
3. Cloudflare Pages redeploys automatically.

## Step 3 — Test it yourself first (~5 min)

Since `mailtomanishravikumar@gmail.com` is both an admin (Manage Access)
and a KAN member, you're the right account to test all three cases:

1. Open `<your-site>.pages.dev/` and sign in with your email.
2. You should land on the **admin dashboard**, same as always, with a new
   **"My Membership"** button next to Sign out.
3. Click **My Membership** — confirm it shows your own card (green if
   Active), with an **"Edit my info"** section you can expand, and that
   you **cannot** see any input for status, category, type, or renewal
   date — those aren't in the form at all.
4. Click **Dashboard** in that view's header — confirm it takes you back
   to the full admin dashboard.
5. If you have a second email that's a member but *not* on Manage Access,
   sign in as them (or ask a member to try) and confirm they land
   **directly** on the card — no dashboard, no "Dashboard" button, since
   they don't have that access.

## Step 4 — Share the one link with everyone (~ongoing)

1. Send **the same link** to board members and regular members alike:
   `<your-site>.pages.dev/` — by email, WhatsApp, newsletter, whatever you
   already use. Nobody needs to be told which page to use.
2. Everyone signs in with the email currently on file for them (as a
   member, a board admin, or both). If an email matches neither, they'll
   see a "we couldn't find you" screen telling them to email
   `kantreasurer@gmail.com`.
3. On a phone, tapping **Add to Home Screen** installs one KAN-branded
   icon that always opens back to this same router — it always shows live
   data, since it re-fetches from the database on every open.

---

## What a member can and can't edit

| Can edit themselves | Locked (admin-only) |
|---|---|
| Email | Name |
| Phone | Status |
| Address | Type |
| Native Place | Category |
| Spouse Name | Renewed Year |
| Children's Names | Last Payment Date |
| Notes | |

The lock is enforced twice: the edit form simply doesn't include the
locked fields, **and** a database trigger silently reverts any attempt to
change them outside the form (e.g. a direct API call). A member editing
their own email won't lock themselves out next time, either — their login
is tied to a stable internal ID, not to whatever the email field currently
says.

---

## Known issue: "we couldn't find you" for every regular member (fixed)

If members who are genuinely on file all get sent to the "we couldn't find
you" screen — even though board admins log in fine — there were actually
**two** stacked bugs in `006_member_self_service.sql`, both now fixed. Both
only ever affected non-admins, which is why board members logging in never
noticed anything wrong.

**Bug 1 — missing permission.** `link_my_member_record()` was created but
the `authenticated` role was never granted permission to call it, so every
member's first link attempt failed outright with a permission error
(silently — the app shows the same "not found" screen either way). Fixed
in `007_fix_link_function_grant.sql`:
```sql
grant execute on function link_my_member_record() to authenticated;
```

**Bug 2 — a trigger reverting its own fix.** After fixing the grant, member
lookups *still* failed. The column-lock trigger
(`protect_admin_only_member_fields`, added in the same migration to stop
members editing admin-only fields via a raw API call) included
`auth_user_id` in its reset list. Since a member linking for the first
time is by definition not an admin, this trigger was silently reverting
`link_my_member_record()`'s own update in the same statement — the
function would still find and return the member's row id, but the
`auth_user_id` column itself snapped right back to null. Confirmed live via
browser devtools: the RPC call returned a valid member id every time, but
the column never actually changed. Fixed in
`008_fix_auth_user_id_trigger_revert.sql` — removes `auth_user_id` from
that trigger's reset list (safe: the RLS update policy already stops a
member from touching any row that isn't already linked to them, so only
the linking function itself can ever set this column).

Anyone setting up 006 fresh from this package already has both fixes baked
in. If you already ran 006 before either fix, run `007` then `008` — both
are small, safe, standalone statements.

To confirm the cause for a specific member, in SQL Editor:
```sql
select id, name, email, auth_user_id from members where email = 'their-email@example.com';
```
If `auth_user_id` is null even though their email is on file correctly and
you've already run 007, run 008 too.

---

## If something goes wrong

Paste me the exact error (browser console, Supabase logs, or the Cloudflare
deploy log) and I'll help you fix it.
