# KAN Member Profile Portal — Step-by-Step Setup (v8)

This document covers **one feature**: the new member self-service portal
(`public/profile.html`), separate from the admin dashboard (`index.html`).
Every KAN member — not just board members in Manage Access — can sign in
with their own email, see only their own record, edit their own contact
info, and view/print a digital membership card (green when Active, red
otherwise).

If you've already deployed the base KAN Membership Tracker (per
`SETUP_CHECKLIST.md`), this is the only new setup required.

---

## What's in this version

- `public/profile.html`, `public/profile.js`, `public/profile.css` — the
  member portal page.
- `public/manifest.json` + `public/assets/kan-icon-192.png` /
  `kan-icon-512.png` — makes "Add to Home Screen" install a KAN-branded
  icon that opens full-screen, like an app.
- `public/lib/place-utils.js` — shared address-parsing helper, factored out
  of `app.js` so the admin map and the member card's "City in USA" field
  stay in sync.
- `supabase/migrations/006_member_self_service.sql` — the database changes
  that make member self-service possible.
- Redesigned digital card: smaller, centered, matches the mockup you
  approved (see "What changed in this redesign" below).

---

## Step 1 — Run the new database migration (~2 min)

1. Go to your Supabase project → **SQL Editor → New query**.
2. Open `supabase/migrations/006_member_self_service.sql` from this folder,
   copy its entire contents, paste into the SQL editor, click **Run**.
3. This is safe to run on your already-live database. It only:
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

## Step 2 — Deploy the updated files (~5 min)

1. Copy this entire `kan-hosted` folder over your existing project folder
   (or copy just the new/changed files listed above if you're merging by
   hand).
2. Commit and push to the GitHub repo connected to Cloudflare Pages, the
   same way you've deployed every update so far:
   ```
   git add .
   git commit -m "Add member self-service profile portal"
   git push
   ```
3. Cloudflare Pages will redeploy automatically. `index.html` (admin
   dashboard) is unaffected — this is purely additive.

## Step 3 — Test it yourself first (~3 min)

1. Open `<your-site>.pages.dev/profile.html`.
2. Sign in with **your own email** (the one on your KAN membership record —
   e.g. `mailtomanishravikumar@gmail.com`), the same magic-link flow as the
   admin login.
3. Confirm:
   - You land directly on your own profile — no member list, no way to see
     anyone else's data.
   - The card shows your real status/type/renewal info and is green if
     you're Active.
   - Editing a field (e.g. Notes) and clicking **Save Changes** works and
     the card/page reflect it immediately.
   - You **cannot** see any input for status, category, type, or renewal
     date — those aren't in the form at all.

## Step 4 — Share the link with members (~ongoing)

1. Send members `<your-site>.pages.dev/profile.html` — by email, WhatsApp,
   newsletter, whatever you already use.
2. They sign in with the email currently on file for them. If a member's
   email isn't on file (or is spelled differently there), they'll see a
   "we couldn't find you" screen telling them to email
   `kantreasurer@gmail.com` — that's expected until the record's email
   matches what they log in with.
3. On a phone, opening the link and tapping **Add to Home Screen** (in the
   browser's Share menu) installs an icon using the KAN logo that opens
   straight to their card, full-screen, every time — and it always shows
   live data (no stale cache), since it re-fetches from the database on
   every open.

---

## What a member can and can't do

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

## What changed in this redesign

Compared to the first version delivered:

- **Card is smaller and centered**, not stretched edge-to-edge. It now has
  a fixed width (~300px) and sits centered on the page with visible
  background on both sides, rather than a wide block of green/red
  dominating the screen.
- Card text was resized down proportionally (still legible — nothing
  smaller than 9pt labels / 13pt values) to match the smaller card.
- The **"Add to Home Screen" / "Download·Print Card"** buttons now span the
  full page width as a two-column row, lining up with the panels below
  instead of trailing off narrower than the card.
- Everything else — the editable "Your Information" form, the read-only
  "Membership Details" panel, the renewal status banner, and the overall
  page structure — is unchanged from the original.

---

## If something goes wrong

Paste me the exact error (browser console, Supabase logs, or the Cloudflare
deploy log) and I'll help you fix it.
