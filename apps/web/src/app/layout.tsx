import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/Providers';
import { DesktopGate } from '@/components/site/DesktopGate';
import { SiteFooter } from '@/components/site/SiteFooter';
import { SiteHeader } from '@/components/site/SiteHeader';
import { SITE_NAME as NAME } from '@/lib/meta';
import { SITE_URL } from '@/lib/share';
import './globals.css';

const DESCRIPTION =
  'Sail to the end of the flat world: dodge rocks, kraken and whirlpools, grab the treasure, and don’t fall off the Edge. Free to play, with a weekly $WIF Pot for the top three on Robinhood Chain.';
/** Shorter, for link previews (the share image says the rest). */
const SHARE = 'The Truth Lies at the Edge. Sail to the end of the flat world, dodge everything the sea throws at you, and win a share of the weekly $WIF Pot.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // Pages add their name in front ("Leaderboard · The Flat Earth Society"); the home page is the Society alone.
  title: { default: NAME, template: `%s · ${NAME}` },
  description: DESCRIPTION,
  applicationName: NAME,
  keywords: ['Flat Earth Society', 'Society Test', 'WIF', '$WIF', 'World is Flat', 'Robinhood Chain', 'browser game', 'play to earn', 'weekly prize'],
  alternates: { canonical: '/' },
  // The share image is app/opengraph-image.jpg (and twitter-image.jpg), a frame of the game at the Edge.
  openGraph: { type: 'website', siteName: NAME, title: NAME, description: SHARE, url: '/', locale: 'en_GB' },
  twitter: { card: 'summary_large_image', title: NAME, description: SHARE },
  // The Society's coin. Browsers that can't show an SVG icon take the PNG.
  icons: {
    icon: [
      { url: '/logo.svg', type: 'image/svg+xml' },
      { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-icon.png',
  },
};

export const viewport: Viewport = { themeColor: '#0d0b08', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <DesktopGate>
            {/* A full-height column keeps the footer at the bottom of the window on short pages. */}
            <div className="flex min-h-screen flex-col">
              <SiteHeader />
              <main className="relative flex-1">{children}</main>
              <SiteFooter />
            </div>
          </DesktopGate>
        </Providers>
      </body>
    </html>
  );
}
