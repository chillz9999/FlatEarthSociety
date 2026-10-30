-- The Flat Earth Society — initial schema.
-- Addresses and hashes are stored lowercase 0x-hex. Token amounts are raw integers (numeric).

create table if not exists players (
  address       text primary key,
  display_name  text,
  created_at    timestamptz not null default now()
);

create table if not exists auth_nonces (
  nonce       text primary key,
  created_at  timestamptz not null default now(),
  used_at     timestamptz
);

-- One row per weekly competition (Monday 00:00 UTC → Sunday 23:59:59 UTC).
create table if not exists competitions (
  week_id       integer primary key,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  -- open → closing (no new starts; in-flight runs may finish) → closed (rankings locked)
  --      → finalized (winners recorded onchain) → settled (all prizes paid)
  status        text not null default 'open',
  closed_at     timestamptz,
  results_hash  text,
  winners       jsonb,
  finalize_tx   text,
  finalized_at  timestamptz,
  settled_at    timestamptz
);

-- Verified onchain EntryPurchased events. One payment ⇒ exactly one ranked attempt.
create table if not exists payments (
  entry_id        text primary key,
  tx_hash         text not null,
  log_index       integer not null,
  block_number    bigint not null,
  player          text not null,
  week_id         integer not null,
  attempt_ref     text not null,
  fee             numeric not null,
  reward_share    numeric not null,
  protocol_share  numeric not null,
  recorded_at     timestamptz not null default now(),
  unique (tx_hash, log_index)
);
create index if not exists payments_week_idx on payments (week_id);
create index if not exists payments_player_idx on payments (player);

create table if not exists attempts (
  id                uuid primary key,
  player            text not null references players(address),
  -- Chosen by the server for reservations, but by the player when paying the contract directly,
  -- so it is only unique per player. entry_id = keccak256(player, attempt_ref) is globally unique.
  attempt_ref       text not null,
  entry_id          text not null unique,
  -- awaiting_payment → paid → started → verified | flagged | rejected | abandoned ; paid/started → restored
  status            text not null,
  payment_entry_id  text unique references payments(entry_id),
  week_id           integer,
  game_version      text,
  seed              text,
  created_at        timestamptz not null default now(),
  paid_at           timestamptz,
  started_at        timestamptz,
  submitted_at      timestamptz,
  verified_at       timestamptz,
  end_tick          integer,
  inputs            jsonb,
  checkpoint_tick   integer,
  checkpoints       jsonb,
  claimed_score     integer,
  score             integer,
  distance_score    integer,
  evidence          integer,
  survival_ms       integer,
  death             text,
  flags             jsonb not null default '[]'::jsonb,
  analysis          jsonb,
  note              text,
  restored_from     uuid references attempts(id)
);
create unique index if not exists attempts_player_ref_idx on attempts (player, attempt_ref);
create index if not exists attempts_board_idx on attempts (week_id, status, score desc);
create index if not exists attempts_player_idx on attempts (player, created_at desc);
create index if not exists attempts_status_idx on attempts (status);

-- Onchain settlement actions taken by the Society's settler key.
create table if not exists settlements (
  id          serial primary key,
  week_id     integer not null,
  kind        text not null,          -- convert | finalize | claim
  tx_hash     text not null unique,
  wif_in      numeric,
  fes_out     numeric,
  rank        integer,
  recipient   text,
  amount      numeric,
  created_at  timestamptz not null default now()
);
create index if not exists settlements_week_idx on settlements (week_id);

-- Every privileged or policy-driven action is recorded here.
create table if not exists audit_log (
  id          serial primary key,
  at          timestamptz not null default now(),
  actor       text not null,
  action      text not null,
  attempt_id  uuid,
  week_id     integer,
  detail      jsonb
);

create table if not exists kv (
  key    text primary key,
  value  text not null
);
