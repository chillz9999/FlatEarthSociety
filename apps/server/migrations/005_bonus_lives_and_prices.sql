-- Verified onchain ExtraLifePurchased events: at most one bonus life per paid entry.
create table if not exists extra_lives (
  entry_id        text primary key,
  tx_hash         text not null,
  log_index       integer not null,
  block_number    bigint not null,
  player          text not null,
  week_id         integer not null,
  fee             numeric not null,
  reward_share    numeric not null,
  protocol_share  numeric not null,
  recorded_at     timestamptz not null default now(),
  unique (tx_hash, log_index)
);
create index if not exists extra_lives_week_idx on extra_lives (week_id);

-- A ranked voyage's bonus life: when it was offered (the ship was lost), and when its payment was confirmed.
-- The real time in between is not counted against the voyage.
alter table attempts add column if not exists life_offered_at timestamptz;
alter table attempts add column if not exists revived_at timestamptz;

-- Every market re-pricing of the fees, published for transparency.
create table if not exists price_updates (
  id              serial primary key,
  at              timestamptz not null default now(),
  wif_usd         text not null,
  source          text not null,
  entry_fee       numeric not null,
  extra_life_fee  numeric not null,
  tx_hash         text
);
