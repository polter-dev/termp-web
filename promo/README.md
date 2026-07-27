# termp promo animation

Generates the looping demo of the termp Discord Rich Presence card
(design matched to `public/og.svg`), used as the README hero in the app repo
(`.github/presence-demo.gif`).

The loop cycles the five flagship tools (Claude Code, Codex CLI, Gemini CLI,
Aider, Ollama). Each tool shows the featured logo, a corner badge with the top
secondary tool's logo, a title, an italic "With <tools>" secondary line, the
`📁 projects/termp` folder, and a ticking elapsed timer. Logos crossfade; the
title and secondary lines roll vertically through clipped rows; the terminal
cursor blinks.

Regenerate everything with:

```
node promo/build-demo.mjs
```

Requires local `rsvg-convert` and `ffmpeg`. Timeline: 30 fps, 1.0 s hold +
0.4 s transition per tool = a 7 s seamless loop.

Outputs (git-ignored — regenerated each run):

- `promo/presence-demo.mp4` — 2400x1260, H.264, seamless loop
- `promo/presence-demo.gif` — 1000 px wide, two-pass palette
- `promo/presence-demo.png` — static hero (mid-hold Claude Code frame)
- `promo/palette.png` — GIF palette (intermediate)
- `promo/frames/` — intermediate SVG/PNG frames

After regenerating, copy `presence-demo.gif` to the app repo's
`.github/presence-demo.gif` to update the README hero.
