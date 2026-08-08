# Setup checklist — the parts only you can do

Everything else (all the code, the database design, the email-sending function, the login system, the admin panel) is already built in this folder. What's left is account creation and pasting a few values back in — about 15–20 minutes total, all free.

Do these in order. Each step says exactly what to click and exactly where the result goes.

---

## 1. Create your Supabase project (~5 min)

1. Go to supabase.com and sign up (free, no credit card).
2. Click **New project**. Name it `kan-membership-tracker`, pick any region close to Nashville (e.g. `us-east-1`), set a database password (save it somewhere — you likely won't need it again, but keep it just in case).
3. Wait ~2 minutes for the project to spin up.
4. In the left sidebar, go to **SQL Editor → New query**.
5. Open `supabase/migrations/001_init.sql` from this folder, copy its entire contents, paste into the SQL editor, click **Run**. This creates the `members`, `reminder_history`, and `allowed_users` tables, turns on the security rules, and seeds `manish.ravikumar@gmail.com` as the first admin.
6. New query again. Open `supabase/migrations/002_import_data.sql`, copy, paste, **Run**. This loads your existing 263 members and their reminder history.
7. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
8. Open `public/config.js` in this folder and paste those two values in:
   ```js
   window.KAN_CONFIG = {
     SUPABASE_URL: "<paste Project URL here>",
     SUPABASE_ANON_KEY: "<paste anon public key here>",
   };
   ```

## 2. Turn on email login (~2 min)

1. In Supabase, go to **Authentication → Providers**, make sure **Email** is enabled (it is by default).
2. Go to **Authentication → URL Configuration**. Set **Site URL** to the URL your app will live at once deployed (you'll get this in step 4 below — you can come back and fill this in after deploying, it just needs to be right before login will work end-to-end). Add the same URL under **Redirect URLs**.
3. That's it — Supabase sends the login-link emails itself for this part (this is separate from Brevo, which only handles the reminder emails to members).

## 3. Create your Brevo account and connect it (~5 min)

1. Go to brevo.com and sign up (free, no credit card, 300 emails/day forever).
2. Go to **Senders, Domains & Dedicated IPs → Senders**, click **Add a sender**, and add `manish.ravikumar@gmail.com` exactly. Brevo emails a confirmation link to that inbox — click it to verify. (Reminder emails will show this as the "From" address, and Brevo won't let you send until it's verified.)
3. Go to **SMTP & API → API Keys**, click **Generate a new API key**, name it `kan-reminder-emails`, copy the key it shows you (you only see it once).
4. Back in Supabase, go to **Edge Functions → Manage secrets** (or run this from your terminal if you have the Supabase CLI installed: `supabase secrets set BREVO_API_KEY=your-key-here`). Add a secret named `BREVO_API_KEY` with the value you just copied.
5. Deploy the email-sending function. If you have the Supabase CLI:
   ```
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase functions deploy send-email
   ```
   If you'd rather not install the CLI, tell me once you've done steps 1–4 above and I'll walk you through deploying the function a different way (Supabase also supports deploying via their dashboard's function editor by pasting in `supabase/functions/send-email/index.ts`).

## 4. Deploy the website to Cloudflare Pages (~5 min)

1. Push this whole `kan-hosted` folder to a **private** GitHub repository. (If you're not sure how — create a new repo on github.com, then in a terminal inside this folder: `git init && git add . && git commit -m "KAN hosted app" && git remote add origin <your-repo-url> && git push -u origin main`.)
2. Go to dash.cloudflare.com, sign up (free), go to **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick the repository you just pushed.
4. Under build settings: leave **Build command** blank, set **Build output directory** to `public`.
5. Click **Save and Deploy**. Cloudflare gives you a URL like `kan-membership-tracker.pages.dev` within a minute or two.
6. Go back to Supabase → **Authentication → URL Configuration** (step 2 above) and set the Site URL / Redirect URL to this real `*.pages.dev` address now.

## 5. Test it

1. Open your new `*.pages.dev` URL.
2. Enter `manish.ravikumar@gmail.com`, click **Send me a login link**, check that inbox, click the link.
3. You should land back in the app, logged in, with "Manage Access" visible (you're the seeded admin).
4. Confirm all 263 members are there and the table/filters/chips work.
5. Open **Send Reminders**, pick one member, send yourself a test reminder email, confirm it arrives (check spam the first time) and that it's CC'd to `kantreasurer@gmail.com`.
6. Try the SMS quick-select on a member with a phone number — confirm it still opens Messages the same way it always has.
7. Open **Manage Access** and add anyone else on the board who needs access, by email.

---

## Update: member self-service portal + digital ID card

Every KAN member (not just board members in Manage Access) can sign in with
their own email, see only their own record, edit their own contact info,
and view/print a digital membership card that's green when Active and red
otherwise.

**One link for everyone.** `index.html` is now the single URL you share
with anyone — board members and regular members alike. After sign-in, it
routes each person automatically: board members land on the admin
dashboard, regular members land on their card, and anyone who's both (e.g.
a board member who's also a KAN member) lands on the dashboard with a "My
Membership" button to switch over, and a "Dashboard" button to switch back.
See `PROFILE_PORTAL_STEP_BY_STEP.md` for the full detail — the short
version below is enough to deploy it.

To turn it on:

1. In Supabase → **SQL Editor → New query**, paste in and run
   `supabase/migrations/006_member_self_service.sql`. Safe to run even
   though the app is already live — it only adds a new column, a new
   function, and new policies; it doesn't touch existing data or policies.
2. Push the updated `public/` folder the same way you deployed
   originally — commit and push to the GitHub repo connected to Cloudflare
   Pages.
3. Share **one link** with everyone: `<your-site>.pages.dev/` (or
   `/index.html`). Members sign in with the email already on their
   membership record. If a member's email isn't on file (or is spelled
   differently there), they'll see a "we couldn't find you" screen telling
   them to email the treasurer — that's expected until their record's email
   matches what they log in with.
4. On a phone, opening that link and using the browser's "Add to Home
   Screen" gives everyone an app-like icon using the KAN logo, which always
   opens back to this same router — no separate links to keep track of.

Old links to `profile.html` or `card.html`, if anyone still has them saved,
automatically redirect to `index.html` — they still work, just land on the
unified page now.

A member can only ever edit: email, phone, address, native place, spouse
name, children's names, notes. Status, type, category, renewal date, and
name are enforced read-only at the database level (not just hidden in the
UI) — even a direct API call from a member's own login can't change them.

## When you get stuck

Paste me the exact error message (from the browser console, Supabase logs, or Cloudflare's deploy log) at whatever step you're on, and I'll help you fix it — I just can't click through the account-creation screens themselves on your behalf.
