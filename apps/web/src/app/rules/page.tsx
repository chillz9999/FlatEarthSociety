import { RulesScreen } from '@/components/registry/RulesScreen';
import { pageMetadata } from '@/lib/meta';

export const metadata = pageMetadata(
  'Game rules',
  'How to play, what competitive play costs, how the weekly $WIF Pot is shared, and why 50% of every payment is burned.',
  '/rules',
);

export default function RulesPage() {
  return <RulesScreen />;
}
