import type { DeathCause } from './types';

/** The Society's official wording. Shared by the game client and the server's share cards. */
export const DEATH_HEADLINES: Record<DeathCause, string> = {
  edge: 'You fell off the Earth.',
  rock: 'Your vessel struck the rocks.',
  island: 'Your vessel ran aground.',
  debris: 'Your vessel was holed by wreckage.',
  iceberg: 'Your vessel met the ice.',
  tentacle: 'Your vessel was taken by the kraken.',
  leviathan: 'Your vessel was swallowed by the leviathan.',
  wreck: 'Your vessel joined an earlier expedition.',
  pillar: 'Your vessel struck the Society’s gate.',
  colossus: 'Your vessel struck the Colossus.',
  whirlpool: 'Your vessel was swallowed by the deep.',
  timeout: 'The examination has concluded.',
};

export const DEATH_SUBLINES: Record<DeathCause, string> = {
  edge: "Your disappearance has been noted in the Society's records.",
  rock: 'The rocks were charted. The Society notes this with regret.',
  island: 'The land was, regrettably, exactly where the chart said it was.',
  debris: 'The previous expedition left this here. Lessons were not learned.',
  iceberg: 'The ice wall sends its regards. It has been expecting you.',
  tentacle: 'The Society maintains that the kraken is a navigational hazard, not a myth.',
  leviathan: 'It has waited at the Edge for longer than the Society has existed.',
  wreck: 'The wreck was charted. So, now, is yours.',
  pillar: 'The gate was open. The Society notes that you missed it.',
  colossus: 'The Colossus has stood here since the first expedition. It did not move for yours.',
  whirlpool: 'The deep keeps its own counsel.',
  timeout: 'The Society has seen enough. Your navigation is beyond reproach.',
};

export const FAILURE_REMARKS: readonly string[] = [
  'The Society denies all responsibility.',
  'An unfortunate but scientifically significant outcome.',
  'The globe lobby will hear of this.',
  'A brief but memorable voyage.',
  'The Society recommends further training.',
  'The Society accepts no responsibility for gravity.',
  'Your expedition has been classified as further evidence.',
];

export const STAGE_REMARKS: readonly string[] = [
  'Navigation skills required. Belief optional.',
  'Beyond this point the charts grow vague.',
  'The Society advises considerable care.',
  'Few explorers have returned from the Outer Rim.',
  'The Truth Lies at the Edge.',
];

export const SOCIETY_TITLES = ['Grand Cartographer', 'Master Navigator', 'Distinguished Fellow'] as const;
export const PRIZE_SHARES_BPS = [5000, 3000, 2000] as const;
