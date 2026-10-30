/** The Society's seal: rope ring, motto, and the disc of the world with its Edge. */
export function SocietySeal({ size = 320, className = '' }: { size?: number; className?: string }) {
  const ropes = Array.from({ length: 64 }, (_, i) => (i / 64) * 360);
  const meridians = Array.from({ length: 12 }, (_, i) => (i / 12) * 360);
  return (
    <svg width={size} height={size} viewBox="0 0 400 400" className={className} role="img" aria-label="Seal of the Flat Earth Society">
      <defs>
        <radialGradient id="seal-metal" cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#7a5a2c" />
          <stop offset="55%" stopColor="#3c2a14" />
          <stop offset="100%" stopColor="#1b130a" />
        </radialGradient>
        <radialGradient id="seal-sea" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#24505a" />
          <stop offset="100%" stopColor="#0f262c" />
        </radialGradient>
        <linearGradient id="seal-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f2d57e" />
          <stop offset="60%" stopColor="#c9a24a" />
          <stop offset="100%" stopColor="#7c5619" />
        </linearGradient>
        <path id="seal-text" d="M 200,200 m -148,0 a 148,148 0 1,1 296,0 a 148,148 0 1,1 -296,0" />
        <path id="seal-text-bottom" d="M 200,200 m -148,0 a 148,148 0 0,0 296,0" />
      </defs>
      <circle cx="200" cy="200" r="196" fill="url(#seal-metal)" stroke="url(#seal-gold)" strokeWidth="3" />
      <g transform="translate(200 200)">
        {ropes.map((a) => (
          <ellipse key={a} cx="0" cy="-180" rx="4.2" ry="9.5" transform={`rotate(${a}) rotate(32 0 -180)`} fill="none" stroke="url(#seal-gold)" strokeWidth="2.2" />
        ))}
      </g>
      <circle cx="200" cy="200" r="166" fill="none" stroke="#c9a24a" strokeOpacity="0.7" strokeWidth="1.5" />
      <text fill="#e6c56f" fontFamily="Cinzel, serif" fontSize="19" fontWeight="600" letterSpacing="5">
        <textPath href="#seal-text" startOffset="25%" textAnchor="middle">
          THE FLAT EARTH SOCIETY
        </textPath>
      </text>
      <text fill="#c9a24a" fontFamily="Cinzel, serif" fontSize="13" letterSpacing="4">
        <textPath href="#seal-text-bottom" startOffset="50%" textAnchor="middle">
          ✦ VERITAS IN MARGINE ✦
        </textPath>
      </text>
      <circle cx="200" cy="200" r="128" fill="none" stroke="#c9a24a" strokeOpacity="0.6" strokeWidth="1.2" />
      {/* The disc of the world */}
      <circle cx="200" cy="200" r="112" fill="#e9f1ea" fillOpacity="0.85" />
      <circle cx="200" cy="200" r="106" fill="url(#seal-sea)" />
      <g stroke="#c9a24a" strokeOpacity="0.45" fill="none" strokeWidth="1">
        <circle cx="200" cy="200" r="30" />
        <circle cx="200" cy="200" r="58" />
        <circle cx="200" cy="200" r="84" />
        {meridians.map((a) => (
          <line key={a} x1="200" y1="200" x2="200" y2="94" transform={`rotate(${a} 200 200)`} />
        ))}
      </g>
      {/* Compass star */}
      <g transform="translate(200 200)">
        <path d="M0,-44 L7,-7 L44,0 L7,7 L0,44 L-7,7 L-44,0 L-7,-7 Z" fill="url(#seal-gold)" opacity="0.9" />
        <path d="M0,-44 L7,-7 L0,0 Z M44,0 L7,7 L0,0 Z M0,44 L-7,7 L0,0 Z M-44,0 L-7,-7 L0,0 Z" fill="#3c2a14" opacity="0.55" />
        <circle r="4" fill="#f2d57e" />
      </g>
      {/* A small vessel nearing the Edge */}
      <g transform="translate(262 128) rotate(-38)">
        <path d="M-12,0 C-8,5 8,5 13,0 L9,-2 L-9,-2 Z" fill="#5b3a1e" stroke="#1a0f06" strokeWidth="0.8" />
        <path d="M0,-2 L0,-17 M0,-15 C6,-12 6,-6 0,-4" stroke="#efe4c6" strokeWidth="1.2" fill="#efe4c6" />
      </g>
    </svg>
  );
}
