export interface ScoreCardData {
  headline: string;
  remark: string;
  score: number;
  survival: string;
  /** e.g. "12" or "12 (2 super)". */
  treasure: string;
  rank: number | null;
  ranked: boolean;
  /** The stage of the Test the voyage reached, e.g. "The Outer Rim". */
  stage: string;
  /** Who sailed it (null: a guest). */
  name: string | null;
  /** The day of the voyage, as printed on the card. */
  date: string;
  /** The Society's address, for whoever sees the card shared. */
  site: string;
}

const W = 1200;
const H = 630;
const GOLD = '#c9a24a';
const GOLD_HI = '#f2d57e';
const GOLD_LO = '#7c5619';
const PARCHMENT = '#e8dcc0';
const PARCHMENT_2 = '#c8b996';
const PARCHMENT_3 = '#a8987a';
const DISPLAY = 'Cinzel, "Trajan Pro", Georgia, serif';
const SERIF = '"Cormorant Garamond", Garamond, Georgia, serif';

/** Text with letter spacing (canvas letter spacing is not available everywhere). Returns its width. */
function tracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number, align: 'left' | 'center' | 'right' = 'center'): number {
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, widths.length - 1);
  let cx = align === 'left' ? x : align === 'right' ? x - total : x - total / 2;
  const saved = ctx.textAlign;
  ctx.textAlign = 'left';
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, cx, y);
    cx += widths[i] + spacing;
  });
  ctx.textAlign = saved;
  return total;
}

/** The largest font size (down to `min`) at which the text fits the width. */
function fit(ctx: CanvasRenderingContext2D, text: string, font: (size: number) => string, max: number, min: number, width: number): number {
  let size = max;
  for (; size > min; size -= 2) {
    ctx.font = font(size);
    if (ctx.measureText(text).width <= width) break;
  }
  ctx.font = font(size);
  return size;
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A vertical gold gradient for engraved lettering between y0 and y1. */
function goldFill(ctx: CanvasRenderingContext2D, y0: number, y1: number): CanvasGradient {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, '#fff1b8');
  g.addColorStop(0.45, GOLD_HI);
  g.addColorStop(1, GOLD);
  return g;
}

/** Text set around a circle: over the top (reading clockwise) or under the bottom (reading left to right). */
function arcText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, r: number, spacing: number, top: boolean): void {
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let along = -total / 2;
  ctx.textAlign = 'center';
  chars.forEach((ch, i) => {
    const mid = along + widths[i] / 2;
    const theta = top ? -Math.PI / 2 + mid / r : Math.PI / 2 - mid / r;
    ctx.save();
    ctx.translate(cx + r * Math.cos(theta), cy + r * Math.sin(theta));
    ctx.rotate(top ? theta + Math.PI / 2 : theta - Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    along += widths[i] + spacing;
  });
}

/** The Society's seal (as on the site), drawn in its own 400-unit square centred on (cx, cy). */
function drawSeal(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const s = size / 400;
  ctx.save();
  ctx.translate(cx - 200 * s, cy - 200 * s);
  ctx.scale(s, s);
  const gold = ctx.createLinearGradient(0, 0, 400, 400);
  gold.addColorStop(0, GOLD_HI);
  gold.addColorStop(0.6, GOLD);
  gold.addColorStop(1, GOLD_LO);

  const metal = ctx.createRadialGradient(152, 128, 0, 152, 128, 300);
  metal.addColorStop(0, '#7a5a2c');
  metal.addColorStop(0.55, '#3c2a14');
  metal.addColorStop(1, '#1b130a');
  ctx.beginPath();
  ctx.arc(200, 200, 196, 0, Math.PI * 2);
  ctx.fillStyle = metal;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = gold;
  ctx.stroke();

  // The rope ring: twisted strands, each with a lit edge and a shadow beside it.
  ctx.lineCap = 'round';
  for (let i = 0; i < 60; i++) {
    ctx.save();
    ctx.translate(200, 200);
    ctx.rotate((i / 60) * Math.PI * 2);
    ctx.translate(0, -180);
    ctx.strokeStyle = 'rgba(20,12,4,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-3, 10);
    ctx.lineTo(9, -6);
    ctx.stroke();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 6.5;
    ctx.beginPath();
    ctx.moveTo(-7, 8);
    ctx.lineTo(6, -8);
    ctx.stroke();
    ctx.strokeStyle = GOLD_HI;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-8, 5);
    ctx.lineTo(3, -9);
    ctx.stroke();
    ctx.restore();
  }
  const ring = (r: number, alpha: number, width: number) => {
    ctx.beginPath();
    ctx.arc(200, 200, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(201,162,74,${alpha})`;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  ring(166, 0.7, 1.5);
  ctx.fillStyle = '#e6c56f';
  ctx.font = `600 19px ${DISPLAY}`;
  arcText(ctx, 'THE FLAT EARTH SOCIETY', 200, 200, 148, 5, true);
  ctx.fillStyle = GOLD;
  ctx.font = `400 13px ${DISPLAY}`;
  arcText(ctx, '✦ VERITAS IN MARGINE ✦', 200, 200, 148, 4, false);
  ring(128, 0.6, 1.2);

  // The disc of the world, its chart lines and the compass star.
  ctx.beginPath();
  ctx.arc(200, 200, 112, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(233,241,234,0.85)';
  ctx.fill();
  const sea = ctx.createRadialGradient(200, 200, 0, 200, 200, 106);
  sea.addColorStop(0, '#24505a');
  sea.addColorStop(1, '#0f262c');
  ctx.beginPath();
  ctx.arc(200, 200, 106, 0, Math.PI * 2);
  ctx.fillStyle = sea;
  ctx.fill();
  for (const r of [30, 58, 84]) ring(r, 0.45, 1);
  ctx.strokeStyle = 'rgba(201,162,74,0.45)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(200, 200);
    ctx.lineTo(200 + Math.sin(a) * 106, 200 - Math.cos(a) * 106);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(200, 200);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = gold;
  ctx.fill(new Path2D('M0,-44 L7,-7 L44,0 L7,7 L0,44 L-7,7 L-44,0 L-7,-7 Z'));
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#3c2a14';
  ctx.fill(new Path2D('M0,-44 L7,-7 L0,0 Z M44,0 L7,7 L0,0 Z M0,44 L-7,7 L0,0 Z M-44,0 L-7,-7 L0,0 Z'));
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, Math.PI * 2);
  ctx.fillStyle = GOLD_HI;
  ctx.fill();
  ctx.restore();

  // A small vessel nearing the Edge.
  ctx.save();
  ctx.translate(262, 128);
  ctx.rotate((-38 * Math.PI) / 180);
  ctx.fillStyle = '#5b3a1e';
  ctx.strokeStyle = '#1a0f06';
  ctx.lineWidth = 0.8;
  const hull = new Path2D('M-12,0 C-8,5 8,5 13,0 L9,-2 L-9,-2 Z');
  ctx.fill(hull);
  ctx.stroke(hull);
  ctx.strokeStyle = '#efe4c6';
  ctx.fillStyle = '#efe4c6';
  ctx.lineWidth = 1.2;
  ctx.stroke(new Path2D('M0,-2 L0,-17'));
  const sail = new Path2D('M0,-15 C6,-12 6,-6 0,-4');
  ctx.fill(sail);
  ctx.stroke(sail);
  ctx.restore();
  ctx.restore();
}

/** A shareable "Record of the Society" card for a single voyage (PNG data URL, 1200×630). */
export async function renderScoreCard(d: ScoreCardData): Promise<string> {
  // Canvas text only uses web fonts already loaded: ask for every face the card needs.
  await Promise.all(
    [`600 20px ${DISPLAY}`, `700 40px ${DISPLAY}`, `400 13px ${DISPLAY}`, `italic 400 26px ${SERIF}`, `500 26px ${SERIF}`].map((f) =>
      document.fonts?.load(f).catch(() => undefined),
    ),
  );
  await document.fonts?.ready;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.textBaseline = 'alphabetic';

  // The sea of the chart, lit around the seal, darkening to the corners.
  const sealX = 222;
  const sealY = 292;
  const bg = ctx.createRadialGradient(W * 0.6, H * 0.42, 40, W * 0.6, H * 0.42, 820);
  bg.addColorStop(0, '#1f414a');
  bg.addColorStop(0.55, '#13282e');
  bg.addColorStop(1, '#060909');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // Rhumb lines and rings from the seal, as on an old chart.
  ctx.strokeStyle = 'rgba(201,162,74,0.08)';
  ctx.lineWidth = 1;
  for (let r = 200; r < 1200; r += 110) {
    ctx.beginPath();
    ctx.arc(sealX, sealY, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(sealX + Math.cos(a) * 170, sealY + Math.sin(a) * 170);
    ctx.lineTo(sealX + Math.cos(a) * 1400, sealY + Math.sin(a) * 1400);
    ctx.stroke();
  }
  // A faint grain, like printed paper.
  for (let i = 0; i < 3000; i++) {
    ctx.fillStyle = `rgba(232,220,192,${Math.random() * 0.035})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
  }
  const glow = ctx.createRadialGradient(sealX, sealY, 60, sealX, sealY, 230);
  glow.addColorStop(0, 'rgba(242,213,126,0.16)');
  glow.addColorStop(1, 'rgba(242,213,126,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // The frame: a heavy gold rule, a fine one inside it, and diamonds at the corners.
  const frameGold = ctx.createLinearGradient(0, 0, W, H);
  frameGold.addColorStop(0, GOLD_HI);
  frameGold.addColorStop(0.5, GOLD);
  frameGold.addColorStop(1, GOLD_LO);
  ctx.strokeStyle = frameGold;
  ctx.lineWidth = 3;
  ctx.strokeRect(22, 22, W - 44, H - 44);
  ctx.strokeStyle = 'rgba(201,162,74,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(32, 32, W - 64, H - 64);
  for (const [x, y] of [
    [22, 22],
    [W - 22, 22],
    [22, H - 22],
    [W - 22, H - 22],
  ]) {
    diamond(ctx, x, y, 9, GOLD_HI);
  }

  // Left: the seal and the motto.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 6;
  drawSeal(ctx, sealX, sealY, 300);
  ctx.restore();
  ctx.fillStyle = PARCHMENT_2;
  ctx.font = `italic 400 25px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.fillText('The Truth Lies at the Edge.', sealX, 490);
  ctx.fillStyle = PARCHMENT_3;
  ctx.font = `600 13px ${DISPLAY}`;
  tracked(ctx, d.ranked ? 'COMPETITIVE PLAY' : 'FREE PLAY', sealX, 522, 4);

  // The divide between the seal and the record.
  ctx.strokeStyle = 'rgba(201,162,74,0.45)';
  ctx.beginPath();
  ctx.moveTo(420, 70);
  ctx.lineTo(420, H - 70);
  ctx.stroke();
  diamond(ctx, 420, H / 2, 6, GOLD);

  // Right: the record.
  const cx = 795;
  const width = 680;
  ctx.fillStyle = PARCHMENT_3;
  ctx.font = `600 17px ${DISPLAY}`;
  tracked(ctx, 'RECORD OF THE SOCIETY', cx, 90, 5);

  const headline = d.headline.toUpperCase();
  const hs = fit(ctx, headline, (n) => `700 ${n}px ${DISPLAY}`, 46, 26, width);
  ctx.fillStyle = goldFill(ctx, 146 - hs, 146);
  ctx.textAlign = 'center';
  ctx.fillText(headline, cx, 146);
  ctx.fillStyle = PARCHMENT;
  fit(ctx, d.remark, (n) => `italic 400 ${n}px ${SERIF}`, 27, 18, width);
  ctx.fillText(d.remark, cx, 186);

  ctx.strokeStyle = 'rgba(201,162,74,0.55)';
  ctx.beginPath();
  ctx.moveTo(cx - 210, 214);
  ctx.lineTo(cx - 14, 214);
  ctx.moveTo(cx + 14, 214);
  ctx.lineTo(cx + 210, 214);
  ctx.stroke();
  diamond(ctx, cx, 214, 5, GOLD);

  ctx.fillStyle = PARCHMENT_3;
  ctx.font = `600 15px ${DISPLAY}`;
  tracked(ctx, 'FINAL SCORE', cx, 252, 6);
  const score = d.score.toLocaleString('en-US');
  const ss = fit(ctx, score, (n) => `700 ${n}px ${DISPLAY}`, 104, 60, width);
  ctx.save();
  ctx.shadowColor = 'rgba(242,213,126,0.35)';
  ctx.shadowBlur = 28;
  ctx.fillStyle = goldFill(ctx, 338 - ss * 0.72, 338);
  ctx.textAlign = 'center';
  ctx.fillText(score, cx, 338);
  ctx.restore();
  ctx.fillStyle = PARCHMENT_2;
  ctx.font = `italic 400 25px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.fillText(`Reached ${d.stage}`, cx, 378);

  // Survival, treasure and rank, each in its own column.
  const cols: [string, string][] = [
    ['SURVIVAL', d.survival],
    ['TREASURE', d.treasure],
    [d.ranked ? 'WEEKLY RANK' : 'LEADERBOARD', d.rank ? `#${d.rank}` : '—'],
  ];
  const colW = 226;
  cols.forEach(([label, value], i) => {
    const x = cx + (i - 1) * colW;
    ctx.fillStyle = PARCHMENT_3;
    ctx.font = `600 14px ${DISPLAY}`;
    tracked(ctx, label, x, 428, 4);
    ctx.fillStyle = PARCHMENT;
    fit(ctx, value, (n) => `600 ${n}px ${DISPLAY}`, 34, 18, colW - 24);
    ctx.textAlign = 'center';
    ctx.fillText(value, x, 472);
    if (i > 0) {
      ctx.strokeStyle = 'rgba(201,162,74,0.35)';
      ctx.beginPath();
      ctx.moveTo(x - colW / 2, 408);
      ctx.lineTo(x - colW / 2, 484);
      ctx.stroke();
    }
  });

  // Who, when, and where to sail it yourself.
  ctx.strokeStyle = 'rgba(201,162,74,0.25)';
  ctx.beginPath();
  ctx.moveTo(cx - width / 2, 518);
  ctx.lineTo(cx + width / 2, 518);
  ctx.stroke();
  ctx.fillStyle = PARCHMENT_2;
  ctx.font = `italic 400 23px ${SERIF}`;
  ctx.textAlign = 'left';
  ctx.fillText(`Sailed by ${d.name ?? 'a guest explorer'} · ${d.date}`, cx - width / 2, 556);
  ctx.fillStyle = GOLD;
  ctx.font = `600 14px ${DISPLAY}`;
  tracked(ctx, d.site.toUpperCase(), cx + width / 2, 554, 3, 'right');
  return c.toDataURL('image/png');
}
