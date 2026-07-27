#!/usr/bin/env node
// termp promo animation generator.
// Emits 1200x630 SVG frames, rasterizes with rsvg-convert, assembles with ffmpeg.
// Usage: node promo/build-demo.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');           // termp-web repo root
const PROMO = __dirname;                          // promo/
const FRAMES = join(PROMO, 'frames');

// ---- timeline constants ----
const FPS = 30;
const HOLD = 1.0;                                 // seconds fully-opaque per tool
const CROSSFADE = 0.4;                            // seconds blending to next tool
const SEG = HOLD + CROSSFADE;                     // 1.4 s per tool
const SEG_FRAMES = Math.round(SEG * FPS);         // 42
const HOLD_FRAMES = Math.round(HOLD * FPS);       // 30
const TIMER_START = 1 * 3600 + 42 * 60 + 0;       // 1:42:00

// ---- tools ----
const TOOLS = [
  { name: 'Claude Code', img: 'public/logos/claude-code.png' },
  { name: 'Codex CLI',   img: 'public/logos/codex-cli.png' },
  { name: 'Gemini CLI',  img: 'public/logos/gemini-cli.png' },
  { name: 'Aider',       img: 'public/logos/aider.png' },
  { name: 'Ollama',      img: 'public/logos/ollama.png' },
];
const TOTAL_FRAMES = TOOLS.length * SEG_FRAMES;   // 210

for (const t of TOOLS) {
  t.dataUri = 'data:image/png;base64,' + readFileSync(join(ROOT, t.img)).toString('base64');
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const smoothstep = t => t * t * (3 - 2 * t);
const fmtElapsed = total => {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} elapsed`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} elapsed`;
};
const SHORT = {
  'Claude Code': 'Claude',
  'Codex CLI':   'Codex',
  'Gemini CLI':  'Gemini',
  'Aider':       'Aider',
  'Ollama':      'Ollama',
};
const secondaryLine = i => {
  const a = SHORT[TOOLS[(i + 1) % TOOLS.length].name];
  const b = SHORT[TOOLS[(i + 2) % TOOLS.length].name];
  return `${a} · ${b}`;
};

// The card sub-elements that change per tool.
// Logos and the corner badge crossfade; text rolls through clipped rows.
const opAttr = o => o >= 0.999 ? '' : ` opacity="${o.toFixed(4)}"`;
function logoPart(i, opacity) {
  if (opacity <= 0.001) return '';
  return `    <image x="724" y="236" width="124" height="124" preserveAspectRatio="xMidYMid meet"${opAttr(opacity)} href="${TOOLS[i].dataUri}" clip-path="url(#cardImage)"/>\n`;
}

function badgeLogoPart(i, opacity) {
  if (opacity <= 0.001) return '';
  const secondary = (i + 1) % TOOLS.length;
  return `    <image x="829" y="341" width="42" height="42" preserveAspectRatio="xMidYMid meet"${opAttr(opacity)} href="${TOOLS[secondary].dataUri}" clip-path="url(#cornerBadge)"/>\n`;
}

function badgePart(from, to, e) {
  return '    <circle cx="850" cy="362" r="26" fill="#1e1f22" stroke="#111214" stroke-width="6"/>\n'
       + badgeLogoPart(from, 1 - e)
       + badgeLogoPart(to, e);
}

const TEXT_ROWS = [
  { key: 'title', x: 896, y: 253, clipX: 894, clipY: 230, width: 220, height: 32, fill: '#f2f2f6', size: 22, weight: 700 },
  { key: 'with', x: 944, y: 287, clipX: 894, clipY: 265, width: 220, height: 29, fill: '#b8b8c2', size: 16 },
];
function rowText(i, row) {
  if (row.key === 'title') return esc(TOOLS[i].name);
  return esc(secondaryLine(i));
}
function textRow(i, row, { clipId, dy = 0 } = {}) {
  const content = rowText(i, row);
  if (!content) return '';
  const weightAttr = row.weight ? ` font-weight="${row.weight}"` : '';
  const transformAttr = Math.abs(dy) <= 0.001 ? '' : ` transform="translate(0 ${dy.toFixed(2)})"`;
  const spaceAttr = row.key === 'with' ? ' xml:space="preserve"' : '';
  const text = `<text x="${row.x}" y="${row.y}" fill="${row.fill}" font-size="${row.size}"${weightAttr}${spaceAttr}>${content}</text>`;
  if (!clipId) return `    <g>${text}</g>\n`;
  return `    <g clip-path="url(#${clipId})"><g${transformAttr}>${text}</g></g>\n`;
}
function withPrefix() {
  const text = '<text x="896" y="287" fill="#b8b8c2" font-size="16" xml:space="preserve"><tspan font-style="italic">With </tspan></text>';
  return `    <g>${text}</g>\n`;
}
function heldText(i) {
  return textRow(i, TEXT_ROWS[0])
       + withPrefix()
       + textRow(i, TEXT_ROWS[1]);
}
function rollingText(from, to, e, f) {
  const rows = TEXT_ROWS.map(row => {
    const clipId = `${row.key}Clip-${f}`;
    return textRow(from, row, { clipId, dy: -row.height * e })
         + textRow(to, row, { clipId, dy: row.height * (1 - e) });
  }).join('');
  return rows + withPrefix();
}
function rowClipDefs(f) {
  return TEXT_ROWS.map(row => `    <clipPath id="${row.key}Clip-${f}"><rect x="${row.clipX}" y="${row.clipY}" width="${row.width}" height="${row.height}"/></clipPath>`).join('\n');
}

function frameSVG(f) {
  const seg = Math.floor(f / SEG_FRAMES) % TOOLS.length;
  const inSeg = f % SEG_FRAMES;
  const next = (seg + 1) % TOOLS.length;

  let tools;
  let textClipDefs = '';
  if (inSeg < HOLD_FRAMES) {
    tools = logoPart(seg, 1) + badgePart(seg, seg, 0) + heldText(seg);
  } else {
    const raw = (inSeg - HOLD_FRAMES + 1) / (SEG_FRAMES - HOLD_FRAMES);
    const e = smoothstep(raw);
    textClipDefs = rowClipDefs(f);
    tools = logoPart(seg, 1 - e) + logoPart(next, e)
          + badgePart(seg, next, e)
          + rollingText(seg, next, e, f);
  }

  const elapsed = fmtElapsed(TIMER_START + f / FPS);
  // Cursor blink: 0.6 s on, 0.4 s off.
  const blinkPhase = (f / FPS) % 1.0;
  const cursorOn = blinkPhase < 0.6;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0e0e11"/>
      <stop offset="1" stop-color="#08080a"/>
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientTransform="translate(255 220) rotate(32) scale(580 430)" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ab93ed" stop-opacity=".18"/>
      <stop offset="1" stop-color="#ab93ed" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity=".34"/>
    </filter>
    <clipPath id="cardImage">
      <rect x="706" y="218" width="160" height="160" rx="14"/>
    </clipPath>
    <clipPath id="cornerBadge">
      <circle cx="850" cy="362" r="21"/>
    </clipPath>
${textClipDefs}
  </defs>

  <rect width="1200" height="630" fill="url(#background)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <path d="M0 95.5H1200M0 534.5H1200" stroke="#202026"/>
  <path d="M76 0V630M1124 0V630" stroke="#16161a"/>

  <g transform="translate(91 101) scale(2.18)">
    <g transform="rotate(-8 17 17) translate(1 1)">
      <polyline points="9 10 16.5 16 9 22" fill="none" stroke="#ab93ed" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="20" y1="22.5" x2="25.5" y2="21.5" stroke="#e8e8ee" stroke-width="4.2" stroke-linecap="round"/>
    </g>
    <text x="42" y="24" font-family="'JetBrains Mono', ui-monospace, monospace" font-size="20" font-weight="700" font-style="italic" letter-spacing="-.4" fill="#e8e8ee">termp</text>
  </g>

  <text x="96" y="264" fill="#f2f2f6" font-family="'JetBrains Mono', ui-monospace, monospace" font-size="39" font-weight="600" letter-spacing="-1.3">your terminal, as</text>
  <text x="96" y="320" fill="#ab93ed" font-family="'JetBrains Mono', ui-monospace, monospace" font-size="39" font-weight="600" letter-spacing="-1.3">Discord Rich Presence</text>
  <text x="99" y="378" fill="#8a8a94" font-family="'JetBrains Mono', ui-monospace, monospace" font-size="19">48 tools · no bot token · no telemetry</text>

  <g filter="url(#shadow)" font-family="'JetBrains Mono', ui-monospace, monospace">
    <rect x="680" y="156" width="444" height="276" rx="18" fill="#111214" stroke="#292a30"/>
    <text x="710" y="193" fill="#7a7a86" font-size="15" font-weight="600" letter-spacing="1.5">PLAYING</text>
    <text x="1093" y="191" text-anchor="end" fill="#6e6e78" font-size="22" font-weight="700" letter-spacing="3">•••</text>
    <rect x="706" y="218" width="160" height="160" rx="14" fill="#0e0e11" stroke="#25262c"/>
${tools}
    <text x="896" y="320" fill="#8a8a94" font-size="15">📁 projects/termp</text>
    <text x="896" y="359" fill="#7a7a86" font-size="14">${elapsed}</text>
  </g>

  <text x="96" y="535" fill="#55555e" font-family="'JetBrains Mono', ui-monospace, monospace" font-size="17">$ termp start</text>
  <rect x="247" y="518" width="10" height="21" fill="#8a8a94" opacity="${cursorOn ? 1 : 0}"/>
  <text x="1105" y="535" text-anchor="end" fill="#55555e" font-family="'JetBrains Mono', ui-monospace, monospace" font-size="16">termp.polter.sh</text>
</svg>
`;
}

// ---- build ----
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

console.log(`Generating ${TOTAL_FRAMES} frames (${FPS} fps, ${TOOLS.length} tools x ${SEG}s = ${TOTAL_FRAMES / FPS}s loop)...`);
for (let f = 0; f < TOTAL_FRAMES; f++) {
  const id = String(f).padStart(4, '0');
  const svgPath = join(FRAMES, `frame_${id}.svg`);
  const pngPath = join(FRAMES, `frame_${id}.png`);
  writeFileSync(svgPath, frameSVG(f));
  execFileSync('rsvg-convert', ['-w', '2400', '-h', '1260', svgPath, '-o', pngPath]);
  if (f % 44 === 0) process.stdout.write(`  frame ${id}\n`);
}

const ff = args => execFileSync('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
const mp4 = join(PROMO, 'presence-demo.mp4');
const gif = join(PROMO, 'presence-demo.gif');
const png = join(PROMO, 'presence-demo.png');
const palette = join(PROMO, 'palette.png');
const inPat = join(FRAMES, 'frame_%04d.png');

console.log('Encoding MP4...');
ff(['-y', '-framerate', String(FPS), '-i', inPat, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);

console.log('Encoding GIF (two-pass palette)...');
ff(['-y', '-i', inPat, '-vf', `fps=${FPS},scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff`, palette]);
ff(['-y', '-framerate', String(FPS), '-i', inPat, '-i', palette, '-lavfi',
    `fps=${FPS},scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer`, gif]);

// Hero: mid-hold of the Claude Code segment (segment 0).
const heroFrame = Math.floor(HOLD_FRAMES / 2);
copyFileSync(join(FRAMES, `frame_${String(heroFrame).padStart(4, '0')}.png`), png);

console.log(`\nDone. ${TOTAL_FRAMES} frames.`);
for (const p of [mp4, gif, png]) console.log(`  ${p}  (${statSync(p).size} bytes)`);
