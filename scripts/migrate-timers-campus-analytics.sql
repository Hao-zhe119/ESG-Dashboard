-- Adds the missing page_number=11 "Campus Analytics" row to the `timers` table
-- for every existing account. Campus Analytics was added after the original
-- 10-page timer seed data, so any database created before that change is
-- missing this row and the admin panel can't show duration/animation controls
-- for it. Safe to re-run: the unique key on (account_id, page_number) means
-- INSERT IGNORE silently skips accounts that already have a page 11 row.
--
-- Note: app.js also runs this automatically on every startup
-- (ensureCampusAnalyticsTimerRow), so you shouldn't normally need to run this
-- by hand — it's here for manual/offline use only.

INSERT IGNORE INTO timers (account_id, page_number, page_name, duration_seconds, background_animation)
SELECT id, 11, 'Campus Analytics', 75, 'particles' FROM accounts;
