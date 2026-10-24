/**
 * 六冲程智能体发动机 v3 —— 化繁为简版
 *
 * v3 原则（用户方向修正）：讲清楚问题，不堆机械花活。
 * 只保留讲清 tim-harness 原理所必需的五个语义块，每块做大做清楚：
 *
 *   [进料斗 用户意图] ─▶ [汽缸 LLM 六冲程·活塞=当前消息] ─▶ [日志鼓 只追加的真相]
 *                          ▲   │
 *              进气管(摘要+尾部)│ └─回灌管(工具结果追加)──▶ 鼓
 *   鼓上：滑动视窗(上下文投影) · 68% 刻线+压杆(压缩) · 棘轮(只进不退)
 *   缸座仪表：转速表(红区24=迭代上限) · 保险丝×3(连败熔断)
 *
 * 已删（v2 遗留的花活）：飞轮/离合/主轴/轴承座/分度轮/时序杆/前面板/
 * 档位旋钮/端口插座/束线 —— 缓存经济与端口等概念移入图注文字。
 *
 * 构建：node build.mjs [--light]（依赖 ~/.claude/skills/anatomy 的 kit）
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kitScript } from "/Users/hongxin/.claude/skills/anatomy/scripts/inline-kit.mjs";
import * as k from "/Users/hongxin/.claude/skills/anatomy/kit/iso-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--light") ? "light" : "dark";
const WIDTH = 640, HEIGHT = 420;

/* ═══════════ 布局：三个语义块，从左到右一条故事线 ═══════════ */
// 唯一基准底板（v3 的台面+底板两层合并为一层）
const BED = { x: -96, y: -52, w: 232, d: 104, r: 7 };
const BED_Z = 0, BED_H = 8, BED_TOP = BED_Z + BED_H; // 顶 z=8

// ① 进料斗（用户意图）
const HOP = { x: -62, y: -8 };

// ② 汽缸（LLM 主体）
const ENG = { x: 0, y: -10 };
const COL = { x: -20, y: -26, w: 40, d: 32, r: 5 };
const BAR_R = 14, BAR_Z0 = BED_TOP + 8, BAR_Z1 = 92;
const HEAD_R = 17.5, HEAD_H = 8, HEAD_TOP = BAR_Z1 + HEAD_H;
const SPARK = { dx: -7.5, dy: 8, r: 2.6, h: 9 };
const ROD = { r: 3.2, z0: HEAD_TOP - 8, z1: HEAD_TOP + 20 };
const PUCK_Z = ROD.z1 + 2.2;
const SHELF = { x: -14, y: -46, w: 46, d: 12, r: 3 }; // 仪表小台（缸座前伸）
const COUNTER = { x: 16, y: -40, r: 8.5, z: 26 };     // 转速表
const FUSE_XS = [-8, 0, 8], FUSE_Y = -40;             // 保险丝×3

// ③ 日志鼓（真相）
const DRUM = { x: 76, y: 6, r: 13, z0: 18, z1: 116 };
const FRAME = { x: 52, y: -12, w: 52, d: 38, r: 4 };
const SIGHT = { x: 82.5, y: -4.5, w: 4.5, d: 9 };
const GATE = { r: 14.5, h: 13 };
const COMPACT_AT = 0.68;
const MARK_Z = DRUM.z0 + (DRUM.z1 - DRUM.z0) * COMPACT_AT;

// 管道：进（鼓→缸，低）与回（缸→鼓，高）
const INTAKE = {
  runA: { x: 44, y: -22, w: 4, d: 36 },   // y 向（z 30..34）
  elbow: { x: 42, y: 22, w: 9, d: 9 },
  runB: { x: 46, y: 24, w: 12, d: 4 },    // x 向接鼓
};
const RETURN = {
  runR1: { x: 12, y: -12, w: 40, d: 4 },  // x 向（z 84..88）
  elbowE1: { x: 48, y: -14, w: 9, d: 9 },
  runR2: { x: 50, y: -10, w: 4, d: 18 },  // y 向
  elbowE2: { x: 48, y: 4, w: 9, d: 9 },
  runR3: { x: 60, y: 6, w: 12, d: 4 },    // x 向入鼓
};

const P = k.fitProjection(
  [
    ...k.boxCorners(BED, 0, 0),
    [ENG.x, ENG.y, PUCK_Z + 12],
    [DRUM.x + DRUM.r + 6, DRUM.y, 134],
    [HOP.x - 14, HOP.y, 62],
  ],
  WIDTH, HEIGHT, { pad: 28, azimuth: 42 },
);

const at = (pt) => k.iso(pt, P);
const S = (p, s) => k.solidSvg(p, s);
const L = (d, s) => k.lineSvg(d, s);
const D = (pts, s) => k.dotsSvg(pts, s);
const band = (x, y, r, z, segs = 44) => k.sideArc(x, y, r, z, P, segs) + k.sideArc(x, y, r, z + 1.1, P, segs);

/* ═══════════ 基准底板（唯一地面）═══════════ */
function base() {
  return `<path class="iso-halo" d="${k.haloOf(BED, 0, BED_H, P)}"/>` +
    S(k.slabOf(BED, 0, BED_H, P, 7, 1.2), { tone: "mid" });
}

/* ═══════════ ① 进料斗（用户意图，一件大而简的形体）═══════════ */
function hopper() {
  const out = [];
  out.push(S(k.cylinder(HOP.x, HOP.y, 3.4, BED_TOP, 18, P, 18), { tone: "mid", crease: "none" })); // 支柱
  out.push(S(k.slabOf({ x: HOP.x - 13, y: HOP.y - 11, w: 26, d: 22, r: 2 }, 32, 3, P, 3, 0.6), { tone: "mid" })); // 斗底
  for (const w of [
    { x: HOP.x - 13, y: HOP.y - 11, w: 26, d: 2.6, r: 1 }, // 后壁
    { x: HOP.x - 13, y: HOP.y + 8.4, w: 26, d: 2.6, r: 1 }, // 前壁
  ]) {
    out.push(S(k.slabOf(w, 35, 16, P, 2, 0.4), { tone: "mid", crease: "lo" }));
  }
  // 斗内消息块（两块 hi 小板 = 排队意图）
  out.push(S(k.slabOf({ x: HOP.x - 9, y: HOP.y - 7, w: 15, d: 11, r: 1.5 }, 35, 3.4, P, 2, 0.4), { tone: "hi" }));
  // 落料管：斗底 → 缸侧进气口
  out.push(S(k.slabOf({ x: HOP.x - 2, y: HOP.y - 1.6, w: 4, d: 3.2, r: 1 }, BED_TOP, 35 - BED_TOP, P, 1.5, 0.3), { tone: "mid", crease: "none" }));
  return out.join("");
}

/* ═══════════ ② 汽缸（LLM：六冲程主体，唯一 lit）═══════════ */
function engineStatic() {
  const out = [];
  out.push(S(k.slabOf(COL, BED_TOP, 8, P, 4, 0.8), { tone: "lo" }));
  out.push(S(k.cylinder(ENG.x, ENG.y, BAR_R, BAR_Z0, BAR_Z1 - BAR_Z0, P, 72, 1), { tone: "mid", crease: "lo" }));
  out.push(S(k.cylinder(ENG.x, ENG.y, HEAD_R, BAR_Z1, HEAD_H, P, 88, 1), { tone: "hi", crease: "lo" }));
  // 火花塞（点火 = LLM 调用；唯一 lit 部件）
  const sx = ENG.x + SPARK.dx, sy = ENG.y + SPARK.dy;
  out.push(S(k.cylinder(sx, sy, SPARK.r, HEAD_TOP + 2.8, SPARK.h, P, 20), { tone: "hi", lit: true }));
  out.push(D([at([sx, sy, HEAD_TOP + SPARK.h + 1.4])], { size: 0.75, tone: "lit" }));
  // 进气/排气端口
  out.push(S(k.cylinder(HOP.x - 1, ENG.y + BAR_R - 2.4, 2.6, 26, 4, P, 16), { tone: "mid" }));
  out.push(S(k.cylinder(ENG.x + HEAD_R - 2, ENG.y, 2.6, 84, 4, P, 16), { tone: "mid" }));
  return out.join("");
}
function pistonGroup() {
  const out = [];
  out.push(S(k.cylinder(ENG.x, ENG.y, ROD.r, ROD.z0, ROD.z1 - ROD.z0, P, 18), { tone: "hi", lit: true, crease: "none" }));
  out.push(S(k.cylinder(ENG.x, ENG.y, 5.8, PUCK_Z, 4.8, P, 26, 0.8), { tone: "hi", lit: true, crease: "lo" }));
  return out.join("");
}

/* ═══════════ ③ 日志鼓（真相：只追加 + 视窗 + 压缩）═══════════ */
function logDrum() {
  const out = [];
  out.push(S(k.cylinder(DRUM.x, DRUM.y, DRUM.r + 3, BED_TOP, 3, P, 40), { tone: "lo" }));
  out.push(S(k.cylinder(DRUM.x, DRUM.y, DRUM.r, DRUM.z0, DRUM.z1 - DRUM.z0, P, 64, 1), { tone: "mid", crease: "lo" }));
  out.push(S(k.slabOf(SIGHT, DRUM.z0 + 2, DRUM.z1 - DRUM.z0 - 4, P, 2, 0.4), { tone: "lo", crease: "none" }));
  out.push(L(band(DRUM.x, DRUM.y, DRUM.r + 0.05, MARK_Z, 64), { tone: "hi" }));
  out.push(k.faceTextSvg(k.topMatrix([DRUM.x - DRUM.r - 6, DRUM.y + 9], MARK_Z - 2, P, "x"), "68", { size: 2.2, tone: "lo", anchor: "end" }));
  return out.join("");
}
function ratchet() {
  const out = [];
  out.push(S(k.cylinder(DRUM.x, DRUM.y, 8, DRUM.z1, 3, P, 44, 0.8), { tone: "mid", crease: "lo" }));
  const teeth = k.radialTicks(DRUM.x, DRUM.y, 6, 12, 4, DRUM.z1 + 3, [1.1, 2], P);
  out.push(L(teeth.minor, { tone: "lo" }), L(teeth.major, { tone: "mid" }));
  out.push(L(k.ring(DRUM.x, DRUM.y, 6, DRUM.z1 + 3, P, 30), { tone: "lo" }));
  // 棘爪（只进不退）
  out.push(S(k.cylinder(DRUM.x + 11.5, DRUM.y + 6, 2, DRUM.z1 + 1, 2.8, P, 16), { tone: "mid" }));
  out.push(S(k.slabOf({ x: DRUM.x + 7.4, y: DRUM.y + 4.6, w: 6.4, d: 3, r: 1 }, DRUM.z1 + 4.4, 1.4, P, 2), { tone: "hi", crease: "none" }));
  return out.join("");
}
function gateSleeve() {
  return S(k.cylinder(DRUM.x, DRUM.y, GATE.r, 0, GATE.h, P, 68, 0.8), { tone: "mid", crease: "lo" });
}
const floatMark = () =>
  S(k.slabOf({ x: SIGHT.x - 0.6, y: SIGHT.y - 1, w: SIGHT.w + 1.2, d: SIGHT.d + 2, r: 1 }, 0, 1.5, P, 2), { tone: "hi" });
function pressYoke() {
  const out = [];
  for (const dx of [-16, 16]) {
    out.push(S(k.cylinder(DRUM.x + dx, DRUM.y, 2.2, BED_TOP, 116 - BED_TOP, P, 16), { tone: "mid", crease: "none" }));
  }
  out.push(S(k.slabOf({ x: DRUM.x - 20, y: DRUM.y - 4, w: 40, d: 8, r: 2 }, 116, 5, P, 3, 0.5), { tone: "mid" }));
  return out.join("");
}
function pressRam() {
  return S(k.cylinder(DRUM.x, DRUM.y, 3, 112, 12, P, 16), { tone: "mid", crease: "none" }) +
    S(k.cylinder(DRUM.x, DRUM.y, 8.5, 109, 3, P, 52, 0.8), { tone: "hi", crease: "lo" });
}
function pellet(i) {
  // 压缩弹丸直接落在鼓座前缘（不再单独托盘）
  const x = DRUM.x - 20 + i * 6.6, y = DRUM.y - 14;
  return S(k.cylinder(x, y, 2.3, BED_TOP + 3, 2.8, P, 16, 0.8), { tone: "hi", crease: "lo" }) +
    L(k.ring(x, y, 1.2, BED_TOP + 5.8, P, 14), { tone: "lo" });
}

/* ═══════════ 管道（两条 = 核心叙事）═══════════ */
const duct = (run, z0, h) => S(k.slabOf(run, z0, h, P, 1.5, 0.3), { tone: "mid", crease: "lo" });
function intakeDuct() {
  const out = [];
  out.push(duct(INTAKE.runA, 30, 4));
  out.push(S(k.slabOf(INTAKE.elbow, 29, 6, P, 1.5, 0.3), { tone: "mid", crease: "lo" }));
  out.push(duct(INTAKE.runB, 30, 4));
  return out.join("");
}
function returnDuct() {
  const out = [];
  out.push(duct(RETURN.runR1, 84, 4));
  out.push(S(k.slabOf(RETURN.elbowE1, 83, 6, P, 1.5, 0.3), { tone: "mid", crease: "lo" }));
  out.push(duct(RETURN.runR2, 84, 4));
  out.push(S(k.slabOf(RETURN.elbowE2, 83, 6, P, 1.5, 0.3), { tone: "mid", crease: "lo" }));
  out.push(duct(RETURN.runR3, 84, 4));
  return out.join("");
}

/* ═══════════ 仪表（一台表 + 三保险丝，装在缸座小台上）═══════════ */
function counterDial() {
  const out = [];
  out.push(S(k.cylinder(COUNTER.x, COUNTER.y, 2.2, BED_TOP, COUNTER.z - BED_TOP, P, 16), { tone: "mid", crease: "none" }));
  out.push(S(k.cylinder(COUNTER.x, COUNTER.y, COUNTER.r, COUNTER.z, 4.4, P, 56, 0.8), { tone: "hi", crease: "lo" }));
  const ticks = k.radialTicks(COUNTER.x, COUNTER.y, COUNTER.r - 2.2, 24, 6, COUNTER.z + 4.4, [1, 2.2], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(L(k.ring(COUNTER.x, COUNTER.y, COUNTER.r - 2.2, COUNTER.z + 4.4, P, 44), { tone: "lo" }));
  const arc = [];
  for (let a = Math.PI * 0.62; a <= Math.PI * 0.86; a += Math.PI / 110) {
    arc.push(k.iso([COUNTER.x + Math.cos(a) * (COUNTER.r - 3.3), COUNTER.y + Math.sin(a) * (COUNTER.r - 3.3), COUNTER.z + 4.4], P));
  }
  out.push(`<path class="iso-line" data-tone="lit" data-free="both" d="M${arc.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L")}" style="stroke-width:1.3"/>`);
  out.push(k.faceTextSvg(k.topMatrix([COUNTER.x + COUNTER.r - 1.5, COUNTER.y + 6.2], COUNTER.z + 4.4, P, "x"), "24", { size: 2, tone: "lo", anchor: "middle" }));
  out.push(D([at([COUNTER.x, COUNTER.y, COUNTER.z + 4.4])], { size: 0.8, tone: "mid" }));
  return out.join("");
}
function fuse(fx, intact) {
  const out = [];
  out.push(S(k.cylinder(fx, FUSE_Y, 3, BED_TOP, 1.6, P, 18), { tone: "lo" }));
  out.push(S(k.cylinder(fx, FUSE_Y, 2.2, BED_TOP + 1.6, intact ? 10 : 5.4, P, 18, 0.8), { tone: intact ? "mid" : "lo", crease: "lo" }));
  if (!intact) out.push(L(band(fx, FUSE_Y, 2.2, BED_TOP + 7, 18), { tone: "hi" }));
  return out.join("");
}
const FUSES_INTACT = FUSE_XS.map((fx) => fuse(fx, true)).join("");
const FUSES_BROKEN = FUSE_XS.map((fx) => fuse(fx, false)).join("");

/* ═══════════ 装配 ═══════════ */
function needleAt(turns) {
  const a = Math.PI * 0.95 - (turns / 24) * Math.PI * 1.8;
  return k.lineOnTop(
    [COUNTER.x - Math.cos(a) * 2, COUNTER.y - Math.sin(a) * 2],
    [COUNTER.x + Math.cos(a) * (COUNTER.r - 4), COUNTER.y + Math.sin(a) * (COUNTER.r - 4)],
    COUNTER.z + 4.6, P,
  );
}

const svg = k.figureSvg({
  width: WIDTH, height: HEIGHT,
  label:
    "Simple six-stroke agent engine. One story, left to right: intent drops into the hopper; the cylinder fires one stroke per LLM call (piston puck = the current message); every tool result is appended onto the ratcheted drum — the append-only session log. The intake duct feeds the cylinder only the context view (sliding sleeve = summary plus tail); past the 68% mark the yoke press folds the head into a gold pellet and the sight-glass level falls. The dial's red zone at 24 is the iteration cap; three straight failures break the fuses.",
  body: [
    base(),
    hopper(),
    engineStatic(),
    `<g data-part="piston">${pistonGroup()}</g>`,
    counterDial(),
    `<path data-part="needle" class="iso-line" data-tone="lit" data-free="start" d="${needleAt(0)}" style="stroke-width:1.1"/>`,
    `<g data-part="fuses">${FUSES_INTACT}</g>`,
    pressYoke(),
    logDrum(),
    `<g data-part="gate">${gateSleeve()}</g>`,
    `<g data-part="float">${floatMark()}</g>`,
    ratchet(),
    `<g data-part="ram">${pressRam()}</g>`,
    `<g data-part="pellets"></g>`,
    returnDuct(),
    intakeDuct(),
  ],
});

/* ═══════════ 运行时 ═══════════ */
const live = `
const P = ${JSON.stringify(P)};
const TURN_MS = 4800, MAX_ITERS = 24, COMPACT_AT = ${COMPACT_AT};
const DRUM = ${JSON.stringify(DRUM)}, GATE_H = ${GATE.h};
const COUNTER = ${JSON.stringify(COUNTER)};
const FUSES_INTACT = ${JSON.stringify(FUSES_INTACT)}, FUSES_BROKEN = ${JSON.stringify(FUSES_BROKEN)};
const PELLETS = ${JSON.stringify([pellet(0), pellet(1), pellet(2)])};
const strokeNames = ["intake", "valve", "ignite", "tools", "re-enter", "tail"];
const $ = (n) => document.querySelector('[data-part="' + n + '"]');
const piston = $("piston"), gate = $("gate"), floatM = $("float"), ram = $("ram"),
      needle = $("needle"), pellets = $("pellets"), fuses = $("fuses"),
      stage = document.querySelector(".iso-stage"), readout = document.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
let phase = 0, turn = 1, iters = 0, logFill = 0.16, pelletsN = 0,
    fuseBlown = false, failStreak = 0, cut = false, playing = true,
    last = 0, hover = -1, frame = 0, visible = false, ramDown = 0;
const needleAt = ${needleAt.toString().replace(/k\./g, "")};
function draw() {
  const s = Math.min(5, Math.floor(phase * 6) % 6);
  const lift = s === 2 ? Math.sin((phase * 6 - 2) * Math.PI) * 14 : s === 3 ? 4.5 + 1.6 * Math.sin(phase * 46) : 0;
  piston.setAttribute("transform", translateAlong(P, [0, 0, lift]));
  const gateBottom = DRUM.z0 + 1 + Math.max(0.5, logFill * (DRUM.z1 - DRUM.z0) - GATE_H * 0.7);
  gate.setAttribute("transform", translateAlong(P, [0, 0, gateBottom]));
  floatM.setAttribute("transform", translateAlong(P, [0, 0, DRUM.z0 + 2 + logFill * (DRUM.z1 - DRUM.z0 - 6)]));
  ram.setAttribute("transform", translateAlong(P, [0, 0, -ramDown]));
  needle.setAttribute("d", needleAt(Math.min(iters, MAX_ITERS)));
  const text = fuseBlown
    ? "熔断：LLM 连续 3 次失败 → 本轮终止 · 点击复位"
    : cut
      ? "iter " + iters + "/24 · 迭代上限 → 强制收尾 · 点击复位"
      : "第 " + turn + " 回合 · 冲程 " + (s + 1) + "/6 " + strokeNames[s] + " · 日志 " + Math.round(logFill * 100) + "%" + (logFill >= COMPACT_AT ? " ⚠超阈值" : "");
  if (readout.textContent !== text) readout.textContent = text;
  stage.setAttribute("aria-valuetext", text);
}
function compact() {
  logFill = 0.3 + Math.random() * 0.05;
  pelletsN = Math.min(pelletsN + 1, 3);
  pellets.innerHTML = PELLETS.slice(0, pelletsN).join("");
  ramDown = 3;
  setTimeout(() => { ramDown = 0; }, 420);
}
function onIter() {
  iters = Math.min(iters + 1, MAX_ITERS);
  logFill = Math.min(logFill + 0.045 + Math.random() * 0.02, 1);
  if (logFill >= COMPACT_AT) compact();
  if (iters >= MAX_ITERS) { cut = true; playing = false; }
}
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  if (playing && !still.matches && hover < 0) {
    const p0 = phase;
    phase += dt * (1000 / TURN_MS);
    if (Math.floor(phase * 6) > Math.floor(p0 * 6)) onIter();
    if (Math.floor(phase) > Math.floor(p0)) turn++;
  }
  draw();
  frame = visible && !still.matches ? requestAnimationFrame(tick) : 0;
}
const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
new IntersectionObserver((e) => { visible = e[e.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
stage.addEventListener("pointermove", (ev) => {
  const box = stage.getBoundingClientRect();
  hover = Math.max(0, Math.min(0.999, (ev.clientX - box.left) / box.width));
  phase = Math.floor(phase) + hover;
  playing = false;
  run();
});
stage.addEventListener("pointerleave", () => { hover = -1; if (!fuseBlown && !cut) playing = true; run(); });
function reset() {
  fuseBlown = false; failStreak = 0; cut = false; playing = true;
  turn = 1; iters = 0; logFill = 0.16; phase = 0; pelletsN = 0; pellets.innerHTML = "";
  fuses.innerHTML = FUSES_INTACT;
  run();
}
stage.addEventListener("click", (ev) => {
  const box = stage.getBoundingClientRect();
  const px = (ev.clientX - box.left) / box.width;
  if (fuseBlown || cut) return reset();
  if (px > 0.3 && px < 0.5) {  // 火花塞区域
    failStreak++;
    if (failStreak >= 3) { fuseBlown = true; playing = false; fuses.innerHTML = FUSES_BROKEN; }
  }
});
stage.addEventListener("keydown", (ev) => {
  if (ev.key === "r" || ev.key === "R") { ev.preventDefault(); reset(); }
  if (ev.key === " ") { ev.preventDefault(); playing = !playing && !fuseBlown && !cut; run(); }
});
draw();
`;

const body = k.plateHtml({
  fig: "Fig 1",
  title: "Six-stroke agent engine — tim-harness",
  hint: "hover 拖动冲程 · 火花塞区连点 3× 熔断 · R 复位",
  readout: "第 1 回合 · 冲程 1/6 intake · 日志 16%",
  keys: [
    { mark: "lit", label: "火花塞·活塞·puck：当前回合（每次点火 = 一次 LLM 调用）" },
    { mark: "raised", label: "进气管（上下文视图=摘要+尾部）与回灌管（工具结果追加进日志）" },
  ],
  caption:
    "tim-harness 的核心原理，从左到右一条线讲完：意图从料斗落进汽缸；汽缸每点火一次做一次 LLM 调用（活塞顶上的 puck 就是当前消息），工具结果经回灌管追加到右边的日志鼓上——棘轮保证只进不退，所以页面刷新后永远能继续。进气管只把「上下文视图」（滑动套筒标出的摘要+尾部）喂给汽缸；越过 68% 刻线时压杆落下，把头部压成一颗金色摘要弹丸，视镜水位随之回落——日志本身从不缩短。表盘红区 24 = 迭代上限（超限强制无工具收尾），保险丝 ×3 = 连续三次失败熔断。数字均来自仓库真实常量；缓存经济与四端口等概念见项目文档。",
  body: `<div class="iso-stage" tabindex="0" role="slider" aria-label="Six-stroke agent engine: hover scrubs the cycle, R resets" aria-valuemin="0" aria-valuemax="24">${svg}</div>`,
});

writeFileSync(
  join(HERE, theme === "light" ? "tim-harness-engine-light.html" : "tim-harness-engine.html"),
  k.pageHtml({ title: "Six-stroke agent engine — tim-harness", theme, body, script: kitScript() + live }),
);
console.log("wrote", theme === "light" ? "tim-harness-engine-light.html" : "tim-harness-engine.html");
