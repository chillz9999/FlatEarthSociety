import { LoreScreen } from '@/components/registry/LoreScreen';
import { pageMetadata } from '@/lib/meta';

export const metadata = pageMetadata(
  'Lore',
  'The world behind the Society Test: the Edge, the ice wall, the Globe Lobby, the Colossus and the explorers who sailed for the end of the world.',
  '/lore',
);

export default function LorePage() {
  return <LoreScreen />;
}
