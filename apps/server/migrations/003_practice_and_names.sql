-- Usernames are unique (ignoring case), and practice voyages are logged.

-- Earlier names were not unique: keep each name for the explorer who chose it first.
update players p set display_name = null
 where display_name is not null
   and exists (
     select 1 from players q
      where q.display_name is not null
        and lower(q.display_name) = lower(p.display_name)
        and (q.created_at, q.address) < (p.created_at, p.address)
   );
create unique index if not exists players_display_name_idx on players (lower(display_name)) where display_name is not null;

-- Free practice voyages. Seeds are issued by the server and every run is replayed on
-- submission, so the practice board is verified too; practice may pause, so there is
-- no real-time limit beyond "not faster than the clock". Never ranked for prizes.
create table if not exists practice_runs (
  id            uuid primary key,
  player        text not null references players(address),
  week_id       integer not null,
  -- started → verified | rejected | abandoned
  status        text not null,
  seed          text not null,
  game_version  text not null,
  started_at    timestamptz not null default now(),
  verified_at   timestamptz,
  end_tick      integer,
  inputs        jsonb,
  score         integer,
  evidence      integer,
  survival_ms   integer,
  death         text,
  flags         jsonb not null default '[]'::jsonb,
  note          text
);
create index if not exists practice_board_idx on practice_runs (week_id, status, score desc);
create index if not exists practice_player_idx on practice_runs (player, started_at desc);
