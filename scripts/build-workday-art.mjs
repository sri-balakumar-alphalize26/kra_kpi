// Builds assets/art/workdayStartArt.js from the designer's export
// (task-workflow-animation.html) — the drop-in picture played after Start
// Workday while attendance is on in the app (components/WorkdayStartAnimation.js).
//
//   node scripts/build-workday-art.mjs "<path to task-workflow-animation.html>"
//
// The export loops forever behind a Replay button and needs a script to wrap
// each layer and add the ribbon's shine. Here the same layers and keyframes are
// rewritten to play ONCE with JavaScript off (as AnimatedArt does): the wrappers
// are written into the markup, and the exit is chained onto each layer's
// entrance in CSS instead of being added by a timer.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/build-workday-art.mjs <task-workflow-animation.html>');
  process.exit(1);
}
const html = readFileSync(src, 'utf8');

// Each layer: <div class="L name" style="..."><img src="data:image/png;base64,...">
const layers = {};
for (const m of html.matchAll(/<div class="L (\w+)" style="([^"]+)"><img src="(data:image\/png;base64,[^"]+)"/g)) {
  layers[m[1]] = { style: m[2], uri: m[3] };
}
const ORDER = ['person', 'dash', 'ribbon', 'cal', 'clock', 'finger'];
for (const k of ORDER) if (!layers[k]) throw new Error(`layer "${k}" not found in ${src}`);
// The shine is masked by the ribbon's own picture — same PNG, kept once.
const mask = html.match(/mask:url\((data:image\/png;base64,[^)]+)\)/);
if (!mask || mask[1] !== layers.ribbon.uri) throw new Error('ribbon shine mask is not the ribbon picture');

// The exit starts at EXIT_AT seconds, staggered top → bottom like the export's
// .out rules, and is over by about EXIT_AT + 1.3s.
const EXIT_AT = 4.4;
const exitDelay = { person: 0, dash: 0.12, ribbon: 0.28, clock: 0.42, cal: 0.5, finger: 0.58, ground: 0.58 };
const out = (k) => `fadeOut .7s cubic-bezier(.55,0,.8,.2) ${(EXIT_AT + exitDelay[k]).toFixed(2)}s forwards`;

const css = `*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{background:radial-gradient(circle at 50% 40%,#ffffff 0%,#eef3fb 55%,#dfe8f7 100%);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;overflow:hidden}
.stage{position:relative;width:min(92vw,78vh*1.094,720px);aspect-ratio:1312/1199}
.L{position:absolute;inset:0;will-change:transform,opacity,filter}
.L img{width:100%;height:100%;display:block}
.float{width:100%;height:100%}
.person{opacity:0;animation:dropIn 1s cubic-bezier(.22,1.3,.36,1) .1s forwards,${out('person')}}
.dash{opacity:0;animation:dropTilt 1.05s cubic-bezier(.22,1.3,.36,1) .45s forwards,${out('dash')}}
.ribbon{opacity:0;animation:wipe 1s cubic-bezier(.65,0,.35,1) 1.15s forwards,${out('ribbon')}}
.clock{opacity:0;animation:land .9s cubic-bezier(.3,1.5,.5,1) 1.95s forwards,${out('clock')}}
.cal{opacity:0;animation:land .9s cubic-bezier(.3,1.5,.5,1) 2.2s forwards,${out('cal')}}
.finger{opacity:0;animation:land .9s cubic-bezier(.3,1.5,.5,1) 2.38s forwards,${out('finger')}}
@keyframes dropIn{0%{opacity:0;transform:translateY(-22%) scale(.94);filter:blur(10px)}60%{opacity:1;filter:blur(0)}100%{opacity:1;transform:none;filter:none}}
@keyframes dropTilt{0%{opacity:0;transform:translateY(-26%) rotate(-6deg) scale(.92);filter:blur(10px)}60%{opacity:1;filter:blur(0)}100%{opacity:1;transform:none;filter:none}}
@keyframes wipe{0%{opacity:1;clip-path:inset(0 0 50% 0);filter:brightness(1.7)}100%{opacity:1;clip-path:inset(0 0 33% 0);filter:none}}
@keyframes land{0%{opacity:0;transform:translateY(-20%) scale(.85)}55%{opacity:1;transform:translateY(0) scaleX(1.08) scaleY(.9)}75%{transform:translateY(-1.5%) scaleX(.97) scaleY(1.04)}100%{opacity:1;transform:none}}
@keyframes fadeOut{from{opacity:1;transform:none;filter:none}to{opacity:0;transform:translateY(4%) scale(.96);filter:blur(8px)}}
.stage{animation:bob 5s ease-in-out 3.4s infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.6%)}}
.shine{position:absolute;inset:0;pointer-events:none;opacity:0;
 -webkit-mask:url(RIBBON) center/100% 100% no-repeat;mask:url(RIBBON) center/100% 100% no-repeat;
 background:linear-gradient(180deg,transparent 46%,rgba(255,255,255,.95) 50%,transparent 54%) 0 52%/100% 200% no-repeat;
 mix-blend-mode:screen;animation:shine 2.6s ease-in-out 2.4s infinite}
@keyframes shine{0%{opacity:1;background-position:0 54%}70%,100%{opacity:1;background-position:0 30%}}
.ground{position:absolute;left:30%;right:26%;bottom:3%;height:4%;border-radius:50%;
 background:radial-gradient(closest-side,rgba(20,60,160,.28),transparent);opacity:0;transform:scaleX(.3);
 animation:shadow .9s ease-out 2.1s forwards,${out('ground')}}
@keyframes shadow{to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.L,.ground,.stage,.shine{animation:none!important}.L,.ground{opacity:1!important;transform:none!important;filter:none!important}.ribbon{clip-path:inset(0 0 33% 0)}}`;

const origin = (style) => style.replace(/^inset:0;/, '');
const layer = (k) => `<div class="L ${k}" style="${origin(layers[k].style)}"><div class="float"${k === 'ribbon' ? ' style="position:relative"' : ''}><img src="\${${k.toUpperCase()}}" alt="">${k === 'ribbon' ? '<div class="shine"></div>' : ''}</div></div>`;

const body = `<div class="stage"><div class="ground"></div>${ORDER.map(layer).join('')}</div>`;
const page = '<!doctype html><html><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">'
  + `<style>${css.replace(/RIBBON/g, '${RIBBON}')}</style></head><body>${body}</body></html>`;

const consts = ORDER.map((k) => `const ${k.toUpperCase()} = '${layers[k].uri}';`).join('\n');
const outFile = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/art/workdayStartArt.js');
writeFileSync(outFile, `// GENERATED by scripts/build-workday-art.mjs from task-workflow-animation.html — do not edit by hand.
//
// Played in a centred popup after Start Workday while attendance is on in the app,
// through components/WorkdayStartAnimation.js. Six transparent PNG layers drop
// in top to bottom, float, then fade out once — about ${(EXIT_AT + 1.3).toFixed(1)}s, CSS only.
//
// Kept as a STRING for the same reason as the login art: a WebView wants
// markup. The ribbon PNG is also the shine's mask, so it is held once here.
${consts}

export const WORKDAY_START_DURATION_MS = ${Math.round((EXIT_AT + 1.3) * 1000)};

export const WORKDAY_START_HTML = \`${page}\`;
`);
console.log(`wrote ${outFile}`);
