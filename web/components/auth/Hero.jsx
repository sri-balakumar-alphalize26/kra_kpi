"use client";
import { useEffect, useRef } from "react";

/* The login page's brand panel: the "Spotlight" SMART/KPI wheel. Markup is
   rendered by React; the motion is the Web Animations API, started once the
   panel mounts and cancelled on unmount. Geometry is the mockup's. */
const SEG = [
  { l: "Specific", c: "#F5A623", i: "⚙️", a: -90 },
  { l: "Time-bound", c: "#3F3F46", i: "⏱️", a: -30 },
  { l: "Relevant", c: "#EC407A", i: "💡", a: 30 },
  { l: "Key Performance\nIndicator", c: "#7E57C2", i: "📊", a: 90, w: 1, s: "KPI" },
  { l: "Attainable", c: "#26C6DA", i: "🎯", a: 150 },
  { l: "Measurable", c: "#8BC34A", i: "📏", a: 210 },
];
const CARDS = [{ i: "📈", x: 4, y: 6 }, { i: "📋", x: 88, y: 10 }, { i: "🎯", x: 46, y: 4 }, { i: "👥", x: 90, y: 60 }];
const WS = 380, C = WS / 2, WH = WS * 0.62, WC = WH / 2, R = WC - 4, KD = WC * 0.84;
const rad = (d) => (Math.PI / 180) * d;
/* Rounded so the server and the browser print identical markup (hydration). */
const f = (n) => Math.round(n * 100) / 100;
const E = { back: "cubic-bezier(.34,1.56,.64,1)", out: "cubic-bezier(.22,.61,.36,1)", spring: "cubic-bezier(.34,1.8,.64,1)" };
const sector = (a) => {
  const s = rad(a - 30), e = rad(a + 30);
  return `M${f(WC)},${f(WC)} L${f(WC + R * Math.cos(s))},${f(WC + R * Math.sin(s))} A${f(R)},${f(R)} 0 0 1 ${f(WC + R * Math.cos(e))},${f(WC + R * Math.sin(e))} Z`;
};

export default function Hero() {
  const root = useRef(null);

  useEffect(() => {
    const el = root.current;
    if (!el || !el.animate) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const $ = (s) => el.querySelector(s), $$ = (s) => [...el.querySelectorAll(s)];
    const A = (n, k, o) => n && n.animate(k, { fill: "both", easing: E.out, ...o });
    const fadeUp = (n, d, dist = 24) => A(n, [{ opacity: 0, transform: `translateY(${dist}px)` }, { opacity: 1, transform: "none" }], { duration: 650, delay: d, easing: E.back });
    const timers = [];

    fadeUp($(".logo"), 100);
    [".la", ".lb", ".sub"].forEach((s, i) => fadeUp($(s), 250 + i * 120));
    A($(".ul"), [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 500, delay: 650 });
    A($(".kpi"), [{ transform: "scale(0)" }, { transform: "scale(1)" }], { duration: 600, delay: 300, easing: E.spring });
    A($(".base"), [{ opacity: 0, transform: "scale(.3)" }, { opacity: 0.5, transform: "none" }], { duration: 600, delay: 500 });
    const segs = $$(".sg"), labs = $$(".lab"), ks = $(".kpi span");
    segs.forEach((g, i) => A(g, [{ opacity: 0, transform: "scale(0) rotate(-40deg)" }, { opacity: 1, transform: "none" }], { duration: 550, delay: 700 + i * 140, easing: E.spring, fill: "backwards" }));
    labs.forEach((l, i) => A(l, [{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 900 + i * 140 }));
    $$(".card").forEach((c, i) => A(c, [{ opacity: 0, transform: "scale(.3) rotate(-30deg)" }, { opacity: 1, transform: "none" }], { duration: 600, delay: 400 + i * 130, easing: E.spring }));
    $$(".card span").forEach((s, i) => A(s, [{ transform: "translateY(0)" }, { transform: "translateY(-10px)" }], { duration: 1800 + i * 200, direction: "alternate", iterations: Infinity, easing: "ease-in-out", fill: "none" }));
    A($(".alpha"), [{ opacity: 0, transform: "translateY(50px)" }, { opacity: 1, transform: "none" }], { duration: 700, delay: 1800 });

    let k = -1;
    const step = () => {
      k = (k + 1) % SEG.length;
      const g = SEG[k], txt = g.s || g.l;
      segs.forEach((s, i) => { s.classList.toggle("hot", i === k); s.classList.toggle("dim", i !== k); });
      labs.forEach((s, i) => { s.classList.toggle("hot", i === k); s.classList.toggle("dim", i !== k); });
      if (ks) {
        ks.textContent = txt; ks.style.color = g.c; ks.style.fontSize = txt.length > 4 ? "15px" : "26px";
        ks.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }], { duration: 350, easing: E.back });
      }
    };
    timers.push(setTimeout(() => { step(); timers.push(setInterval(step, 1500)); }, 2200));

    return () => {
      timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      el.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    };
  }, []);

  return (
    <div className="k-hero" ref={root} aria-hidden="true">
      <div className="cards">
        {CARDS.map((c, i) => <div key={i} className="card" style={{ left: `${c.x}%`, top: `${c.y}%` }}><span>{c.i}</span></div>)}
      </div>
      <div className="grid">
        <div className="left">
          <img className="logo" src="/brand/logo369.png" alt="369 ai.Biz" />
          <h1>
            <span className="la"><span className="w">Track.</span> <span className="w">Analyze.</span></span>
            <span className="lb"><span className="w c">Improve.</span> <span className="w o">Grow.</span></span>
          </h1>
          <div className="ul" />
          <p className="sub">Set SMART goals, measure every KPI and grow your business with real-time insight.</p>
        </div>
        <div className="right">
          <div className="wrap">
            <div className="labs">
              {SEG.map((g) => {
                const w = g.w ? 150 : 112, x = C + (WC + 34) * Math.cos(rad(g.a)), y = C + (WC + 34) * Math.sin(rad(g.a));
                return <div key={g.l} className="lab" style={{ width: w, left: f(x - w / 2), top: f(y - 16), color: g.c }}><i style={{ background: g.c }} />{g.l}</div>;
              })}
            </div>
            <svg className="wheel" style={{ left: f((WS - WH) / 2), top: f((WS - WH) / 2) }} width={f(WH)} height={f(WH)} viewBox={`0 0 ${f(WH)} ${f(WH)}`}>
              <g className="spinner seg" style={{ transformOrigin: `${f(WC)}px ${f(WC)}px` }}>
                <circle className="base" cx={f(WC)} cy={f(WC)} r={f(R)} fill="#C9D6EE" opacity=".5" />
                {SEG.map((g) => {
                  const ix = f(WC + WC * 0.6 * Math.cos(rad(g.a))), iy = f(WC + WC * 0.6 * Math.sin(rad(g.a)));
                  return (
                    <g key={g.l} className="seg sg" style={{ transformOrigin: `${f(WC)}px ${f(WC)}px` }}>
                      <path d={sector(g.a)} fill={g.c} stroke="#EEF3FC" strokeWidth="5" strokeLinejoin="round" />
                      <text x={ix} y={iy} fontSize="22" textAnchor="middle" dominantBaseline="central">{g.i}</text>
                    </g>
                  );
                })}
              </g>
            </svg>
            <div className="kpi" style={{ left: f(C - KD / 2), top: f(C - KD / 2), width: f(KD), height: f(KD) }}><span>KPI</span></div>
          </div>
        </div>
      </div>
      <div className="bottom">
        <svg viewBox="0 0 400 80" preserveAspectRatio="none"><path d="M0,34 C90,80 150,6 220,34 C300,66 340,20 400,38 L400,80 L0,80 Z" fill="#DCE6FA" /></svg>
        <div className="alpha"><img src="/brand/alphalize.png" alt="alphalize" /></div>
      </div>
    </div>
  );
}
