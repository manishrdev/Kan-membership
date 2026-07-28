-- Adds a display name + board position to allowed_users, so the header can
-- show "Jane Doe — Treasurer" instead of a raw email address, and Manage
-- Access can capture who's on the KAN executive board and in what role.
--
-- Safe to run on an already-migrated database — run this once in the
-- Supabase SQL Editor (Project → SQL Editor → New query → paste → Run).

alter table allowed_users add column if not exists name text;
alter table allowed_users add column if not exists position text;
