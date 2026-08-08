# KAN Membership Tracker — hosted version

This is the cloud-hosted version of the KAN Membership Tracker: same app, but data lives in a shared Supabase database instead of one browser's local storage, login is required, and renewal-reminder emails send for real (through Brevo) instead of opening your Mail app.

**If you haven't set anything up yet, start with `SETUP_CHECKLIST.md` in this folder** — it's the exact list of accounts to create and values to paste in before this will run.

## Folder structure

```
kan-hosted/
├── SETUP_CHECKLIST.md          ← start here
├── public/                     ← the website itself (deploy this folder to Cloudflare Pages)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── config.js               ← paste your Supabase URL + anon key here
│   ├── lib/                    ← bundled libraries (Supabase client, SheetJS for Excel, Chart.js)
│   ├── assets/
│   │   └── kan-logo.jpg        ← put your logo here to show it in the header
│   └── data/
│       └── members_seed_for_import.json   ← your existing 263 members, for the one-time import
└── supabase/
    ├── migrations/
    │   ├── 001_init.sql        ← run first: creates tables + security rules
    │   └── 002_import_data.sql ← run second: loads your existing members + reminder history
    └── functions/
        └── send-email/
            └── index.ts        ← the server-side function that actually sends reminder emails
```

## Dashboard

The top of the app shows two charts (Chart.js, bundled in `public/lib/chart.min.js`):
- **Membership Overview** — a donut chart of Active / Renewal Due / Long Lapsed / Moved Out, with the total in the center. Hover a segment for its count, click to filter the table below.
- **Member Locations** — a bar chart toggled between India (from each member's Native Place) and USA (parsed from each member's Address). Place names are collated so "Kochi" and "Kochi, Kerala" count as the same place.

"Moved Out" is a new option in the Status dropdown, alongside Life/Annual/Biennial/Expired/Lapsed — mark a member Moved Out the same way you'd mark them Lapsed.

To show your KAN logo in the header, save it as `public/assets/kan-logo.jpg` (roughly square works best) and redeploy.

## What's different from the local (offline) version

- **Login required.** Anyone who wants access signs in with a one-time emailed link. Only emails listed in the `allowed_users` table can see or edit data — manageable from the app's "Manage Access" button (admin-only).
- **Shared data.** Every board member with access sees the same live data, from any device.
- **Email sends automatically.** The "Send Reminders" email flow calls a server-side function that relays through Brevo — no more opening your Mail app and hitting send yourself. Every email is sent from `manish.ravikumar@gmail.com` and CC'd to `kantreasurer@gmail.com`.
- **SMS is unchanged.** There's no free way to send arbitrary text messages automatically, so texting still opens your phone's Messages app the same way it always has — you tap send.
- Import JSON / "Reset to imported data" (from the local version) are removed here, since they'd be risky against data that's now shared by multiple people. The one-time data load happens once, via `002_import_data.sql`.

## Local development (optional)

You don't need Node.js or a build step — `public/` is plain HTML/JS/CSS. To preview it on your own machine before deploying, any static file server works, e.g.:

```
cd public
python3 -m http.server 8080
```

Then open `http://localhost:8080`. Note: Supabase's magic-link login needs `http://localhost:8080` added to your Supabase project's allowed redirect URLs for this to work locally (see the checklist).
