/**
 * The helmsman's instruments: where the ship sits across the charted channel
 * (and how close either Edge is), and how fast the sea is carrying it.
 */
export function VoyageGauge({ x, halfWidth, speed }: { x: number; halfWidth: number; speed: number }) {
  const pos = Math.max(0, Math.min(1, (x + halfWidth) / (halfWidth * 2)));
  const danger = Math.max(0, 1 - (halfWidth - Math.abs(x)) / 120);
  // The Society measures speed in knots of its own definition: twenty units of the chart per knot.
  const knots = Math.round(speed / 20);
  return (
    <div className="plaque flex items-center gap-4 px-4 py-2">
      <div className="w-56">
        <div className="label text-[0.55rem]! flex justify-between">
          <span>Edge</span>
          <span>Channel</span>
          <span>Edge</span>
        </div>
        <div className="relative mt-1 h-2.5 rounded-full bg-ink-3 shadow-[inset_0_1px_3px_rgba(0,0,0,0.8)]">
          <div className="absolute inset-y-0 left-0 w-[14%] rounded-l-full bg-linear-to-r from-[#8a2a16] to-transparent" />
          <div className="absolute inset-y-0 right-0 w-[14%] rounded-r-full bg-linear-to-l from-[#8a2a16] to-transparent" />
          <div
            className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm"
            style={{
              left: `${pos * 100}%`,
              background: danger > 0 ? `rgb(${240},${180 - danger * 110},${120 - danger * 90})` : '#f2d57e',
              boxShadow: '0 0 8px rgba(242,213,126,0.8)',
            }}
          />
        </div>
      </div>
      <div className="text-center">
        <div className="label text-[0.55rem]!">Speed</div>
        <div className="num text-lg leading-tight text-gold-3">
          {knots}
          <span className="ml-1 text-xs text-parchment-3">kn</span>
        </div>
      </div>
    </div>
  );
}
