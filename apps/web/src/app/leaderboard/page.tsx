import { LeaderboardScreen } from '@/components/registry/LeaderboardScreen';
import { pageMetadata } from '@/lib/meta';

export const metadata = pageMetadata('Leaderboard', 'This week’s best voyages, the $WIF Pot the top three will share, and every past winner.', '/leaderboard');

export default function LeaderboardPage() {
  return <LeaderboardScreen />;
}
