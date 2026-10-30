import Image from 'next/image';
import type { ReactNode } from 'react';

/** The world behind the Society Test, as the Society's records tell it. */
export function LoreScreen() {
  return (
    <div className="mx-auto max-w-[900px] px-4 pt-10 pb-6 md:px-8">
      <div className="label">From the Society’s records</div>
      <h1 className="mt-2 font-display text-4xl text-gold-2 candle md:text-5xl">Lore</h1>
      <p className="mt-5 font-serif text-xl leading-relaxed text-parchment-2">
        For as long as there have been charts, the Flat Earth Society has held that the world is a disc, and that anyone who sails far enough will reach
        its Edge. The Globe Lobby has always disagreed. This is what the Society’s records say about the sea in between.
      </p>

      <Figure src="/lore/storm.jpg" alt="The Colossus against a red storm sky, a ship sailing towards it down the channel" caption="The Colossus, in the red storm of Dangerous Waters" />

      <Section title="The Society">
        <p>
          The Society was founded by navigators who watched the horizon stay perfectly level, voyage after voyage, and drew the obvious conclusion. Its
          motto is carved over the door of its chart room: <em className="text-parchment">The Truth Lies at the Edge.</em>
        </p>
        <p>
          It does not ask its members to believe anything. It asks them to sail. The Society Test is the oldest of its customs: take a small ship down the
          last charted channel and see how near the Edge you can get. Navigation skills are required; belief, as the first chart puts it, is optional.
        </p>
        <p>
          Each week the Society reads the logs and names three explorers: a <Title>Grand Cartographer</Title>, a <Title>Master Navigator</Title> and a{' '}
          <Title>Distinguished Fellow</Title>.
        </p>
      </Section>

      <Section title="The world">
        <p>
          The world is a disc of sea and stone beneath a single guiding star. All the way around it stands a wall of ice. Icebergs calve from the wall and
          drift inward, and penguins keep house on its fallen shelves.
        </p>
        <p>
          Beyond the ice, the sea simply stops. It pours over the Edge in long white falls and is never seen again. The Society has measured the drop with
          great care and found it to be very long.
        </p>
        <p>
          One narrow channel runs from the charted lands to the Edge itself, the last route the Society has charted. The Test is sailed along it, and the
          channel does not wait for anyone: the further out a ship goes, the faster the sea carries it.
        </p>
      </Section>

      <Figure src="/lore/calm.jpg" alt="A ship in golden evening light, a Society lighthouse on an island ahead and coins on the water" caption="Calm Waters, with a Society lighthouse ahead" />

      <Section title="The five reaches">
        <dl className="space-y-4">
          <Reach name="Calm Waters">Golden evening, scattered rocks and the odd wreck. The charts are good here.</Reach>
          <Reach name="Uncharted Territory">The charts grow vague. The Society’s sea gates stand across the channel, and the first kraken come up to look.</Reach>
          <Reach name="Dangerous Waters">A red storm sky, whirlpools, lines of wreckage, and the Colossus. The Society advises considerable care.</Reach>
          <Reach name="The Outer Rim">Violet twilight and the first aurora. Few explorers have returned from the Outer Rim.</Reach>
          <Reach name="The Edge">Night under the moon, the sea at full speed, and the end of the world in sight.</Reach>
        </dl>
      </Section>

      <Section title="What waits on the water">
        <p>
          <Title>Rocks and sea stacks.</Title> Every one of them is on the charts. The Society notes this with regret.
        </p>
        <p>
          <Title>The Globe Lobby.</Title> Their galleons went looking for the far side of the world and found the rocks instead. The wrecks still fly the
          Lobby’s faded colours, and the Lobby’s forts still glower from the islands. The Society keeps lighthouses on the islands it holds.
        </p>
        <p>
          <Title>The Society’s gates.</Title> Stone arches across the channel, each with a lantern swinging beneath its keystone. The gate is always open; the
          Society notes that explorers sometimes miss it.
        </p>
        <p>
          <Title>The Colossus.</Title> A bronze giant standing astride the channel, lantern raised, the Society’s star on its shield. It has stood there since
          the first expedition, and ships pass between its feet. It has never moved for anyone.
        </p>
        <p>
          <Title>The kraken and the leviathan.</Title> The Society maintains that the kraken is a navigational hazard, not a myth. The leviathan has waited at
          the Edge for longer than the Society has existed.
        </p>
        <p>
          <Title>Whirlpools.</Title> Their pull can be seen on the water, and a ship that steers away will always escape. The deep keeps its own counsel.
        </p>
      </Section>

      <Figure src="/lore/edge.jpg" alt="The Colossus beneath the aurora and the moon at the Edge of the world, a ship sailing towards it" caption="The Edge, under the moon and the aurora" />

      <Section title="Treasure">
        <p>
          The channel is strewn with the gold of earlier expeditions, lost when their ships went down. The Society counts every coin recovered as evidence.
          Now and then a larger coin turns up with a ruby set in it; the Society values these at ten ordinary pieces.
        </p>
      </Section>

      <Section title="The Pot and the Edge">
        <p>
          Passage on a competitive voyage is paid in $WIF: <em className="text-parchment">World is Flat</em>. Half of every payment goes into the week’s Pot,
          which the Society’s three named explorers share when the week ends.
        </p>
        <p>The other half is given to the Edge. It goes where the sea goes and does not come back: burned, and out of circulation for good.</p>
        <p>Free play costs nothing. The Society is always glad of another explorer.</p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="plaque mt-6 p-7">
      <h2 className="font-display text-xl tracking-[0.12em] text-gold-2 uppercase">{title}</h2>
      <div className="mt-4 space-y-3 font-serif text-lg leading-relaxed text-parchment-2">{children}</div>
    </section>
  );
}

function Reach({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-display text-sm tracking-[0.16em] text-gold-3 uppercase">{name}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

function Title({ children }: { children: ReactNode }) {
  return <span className="font-display text-[0.92em] tracking-[0.04em] text-gold-3">{children}</span>;
}

function Figure({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="mt-6">
      <div className="plaque overflow-hidden p-1.5">
        <Image src={src} alt={alt} width={1400} height={721} sizes="(min-width: 900px) 836px, 100vw" className="h-auto w-full" />
      </div>
      <figcaption className="mt-2 text-center font-serif text-sm text-parchment-3 italic">{caption}</figcaption>
    </figure>
  );
}
