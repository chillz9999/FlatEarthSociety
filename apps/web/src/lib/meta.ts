import type { Metadata } from 'next';

export const SITE_NAME = 'The Flat Earth Society';

/** The share card (app/opengraph-image.jpg): a frame of the game at the Edge, the coin and the name. */
const CARD = {
  url: '/opengraph-image.jpg',
  width: 1200,
  height: 630,
  alt: 'The Flat Earth Society: a ship sails a moonlit channel towards the lantern-bearing Colossus under the aurora.',
};

/**
 * A page's metadata: its name in the title and in shared links, its own description, and the Society's card. (A page
 * that sets `openGraph` replaces the layout's, card included, so the card is named here every time.)
 */
export function pageMetadata(title: string, description: string, path: string): Metadata {
  const full = `${title} · ${SITE_NAME}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website', siteName: SITE_NAME, title: full, description, url: path, images: [CARD] },
    twitter: { card: 'summary_large_image', title: full, description, images: [CARD] },
  };
}
