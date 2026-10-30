-- Review bookkeeping, checkpoint timing and one-run-at-a-time.

-- When the last checkpoint arrived (the real-time check for runs that are never submitted).
alter table attempts add column if not exists checkpoint_at timestamptz;
-- Administrator review of runs carrying anomaly flags.
alter table attempts add column if not exists reviewed_at timestamptz;
alter table attempts add column if not exists reviewed_by text;
-- A player can have at most one ranked run in progress.
create unique index if not exists attempts_one_started_idx on attempts (player) where status = 'started';
