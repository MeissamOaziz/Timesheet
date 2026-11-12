-- Newsletter status per account owner, 2026-11-11.
-- Who is subscribed lives in Resend (the newsletter list). This column is a copy for the super admin's
-- Accounts page, so the live app never needs a full-access Resend key. It is written only by hand when
-- the list is refreshed before a send (service role); nothing in the apps writes it, and secure-db's
-- SELF_ADMIN_FIELDS / CHILD_ADMIN_FIELDS allowlists do not include it, so no account can change it.
-- NULL means "not on the newsletter list" (teammates, managers, accounts created after the last refresh).
-- No new table, no new grant, no function change: nothing customers see or do is affected.

ALTER TABLE public.admins
  ADD COLUMN IF NOT EXISTS newsletter_status text,
  ADD COLUMN IF NOT EXISTS newsletter_synced_at timestamptz;

ALTER TABLE public.admins
  ADD CONSTRAINT admins_newsletter_status_values CHECK (
    newsletter_status IS NULL OR newsletter_status IN ('subscribed', 'unsubscribed'));
