/**
 * 六冲程智能体发动机 —— tim-harness 基本原理的 Anatomy 刻画（Figure 级，纯 SVG）
 *
 * 依赖 Claude Code 的 anatomy skill（kit 构建期引用，产物 HTML 已内联 kit，可独立浏览）：
 *   node build.mjs [--light]
 *
 * 机械映射（每个数字都来自仓库真实常量）：
 *   分度轮一圈        = 一个回合 runTurn（六冲程：进料/阀门/点火/工具/回灌/收尾）
 *   活塞杆上的 puck   = 当前消息（点火冲程被顶起；工具冲程震动）
 *   日志鼓 + 棘爪     = 会话日志：只追加、永不删改（棘轮只进不退）
 *   滑动视窗套筒      = buildContextView 投影：只把"摘要+尾部"送进汽缸
 *   68% 刻线 + 压杆   = autoCompactAt 0.68（standard 档），压头成金色摘要弹丸（增量压缩）
 *   飞轮离合          = 前缀缓存：咬合时输入价 1/50（DeepSeek 0.02 vs 1 元/M tokens）
 *   保险丝 ×3         = LLM 连续 3 次失败熔断
 *   转速表红区 24      = DEFAULT_MAX_ITERATIONS = 24，超限强制收尾（无工具最终回答）
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kitScript } from "/Users/hongxin/.claude/skills/anatomy/scripts/inline-kit.mjs";
import * as k from "/Users/hongxin/.claude/skills/anatomy/kit/iso-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--light") ? "light" : "dark";

const WIDTH = 640;
const HEIGHT = 430;

/* ---- 世界布局（单位≈px）---- */
const PLATE = { x: -168, y: -86, w: 336, d: 172, r: 9 };
const PLATE_H = 11, FOOT_H = 5;

const ENG = [-62, 10];
const CASE = { x: ENG[0] - 34, y: ENG[1] - 30, w: 68, d: 60, r: 5 };
const CASE_H = 22;
const BAR_R = 15, BAR_Z0 = CASE_H, BAR_Z1 = 92;
const HEAD_R = 18.5, HEAD_H = 8;
const HEAD_TOP = BAR_Z1 + HEAD_H;
const SPARK = { x: ENG[0] - 8.5, y: ENG[1] + 7.5, r: 2.6, h: 9 }; // 火花塞（偏置，避让活塞杆）
const ROD = { r: 3.4, z0: HEAD_TOP - 8, z1: HEAD_TOP + 22 };
const PUCK_Z = ROD.z1 + 2.4;

const FLY = [-64, 62];
const FLY_R = 24, FLY_Z = CASE_H, FLY_H = 6, FLY_TOP = FLY_Z + FLY_H;

const DRUM = [92, -20];
const DRUM_R = 14, DRUM_Z0 = 4, DRUM_Z1 = 122;
const SIGHT = { x: DRUM[0] + 8.5, y: DRUM[1] - 5, w: 5, d: 10 };
const GATE = { r: 16, h: 14 };
const COMPACT_AT = 0.68;
const MARK_Z = DRUM_Z0 + (DRUM_Z1 - DRUM_Z0) * COMPACT_AT;

const TRAY = { x: 128, y: 16, w: 27, d: 17, r: 3 };

const FUSE = { x: -14, y: -76, w: 48, d: 15, r: 3 };
const FUSE_XS = [FUSE.x + 8, FUSE.x + 24, FUSE.x + 40];

const COUNTER = [-140, -52];
const C_R = 12, C_Z = 30;

const INDEX = [52, 46];
const I_R = 12;

const P = k.fitProjection(
  [
    ...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
    [ENG[0], ENG[1], HEAD_TOP + 40],
    [DRUM[0] + GATE.r + 2, DRUM[1], DRUM_Z1 + 46],
    [FLY[0] + FLY_R, FLY[1], FLY_TOP + 8],
    [TRAY.x + TRAY.w, TRAY.y, 26],
  ],
  WIDTH, HEIGHT, { pad: 24, azimuth: 44 },
);

const at = (pt) => k.iso(pt, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const band = (x, y, r, z, segs = 44) => k.sideArc(x, y, r, z, P, segs) + k.sideArc(x, y, r, z + 1.1, P, segs);

/* ---------------- 台面 ---------------- */
function bench() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
  for (const [x, y] of k.corners(PLATE, 24)) {
    out.push(S(k.cylinder(x, y, 6.5, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 5, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }));
  }
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 9, 1.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }));
  const screws = k.corners(PLATE, 11);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
  const strip = { x: -150, y: PLATE.y + PLATE.d - 14, w: 244, d: 7, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 4, 5, strip.y + 0.8, 0.6, [2, 3.6], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(D([at([strip.x + 2, strip.y + 3.5, 0.6]), at([strip.x + strip.w - 2, strip.y + 3.5, 0.6])], { size: 0.45 }));
  const mat = { x: -24, y: -82, w: 168, d: 26, r: 4 };
  out.push(L(k.planOutline(mat, 0.2, P, 6), { tone: "faint" }));
  const nameplate = { x: 100, y: PLATE.y + PLATE.d - 13, w: 54, d: 9, r: 1.5 };
  out.push(S(k.slabOf(nameplate, 0, 1, P, 2), { tone: "lo" }));
  out.push(k.faceTextSvg(k.topMatrix([nameplate.x + nameplate.w / 2, nameplate.y + 6.4], 1.1, P, "x"), "TIM·HARNESS", { size: 2.8, tone: "lo", anchor: "middle" }));
  return out.join("");
}

/* ---------------- 发动机本体（曲轴箱/汽缸/缸头/火花塞） ---------------- */
function engineStatic() {
  const out = [];
  out.push(S(k.slabOf(CASE, 0, CASE_H, P, 6, 0.8), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(CASE, 3), CASE_H, P), { tone: "faint" }));
  out.push(D(
    [[CASE.x + 7, CASE.y + 7], [CASE.x + CASE.w - 7, CASE.y + 7], [CASE.x + 7, CASE.y + CASE.d - 7], [CASE.x + CASE.w - 7, CASE.y + CASE.d - 7]].map(([x, y]) => at([x, y, CASE_H])),
    { size: 0.5, tone: "lo" },
  ));
  out.push(S(k.cylinder(ENG[0], ENG[1], BAR_R, BAR_Z0, BAR_Z1 - BAR_Z0, P, 72, 1), { tone: "mid", crease: "lo" }));
  for (const z of [42, 56, 70]) out.push(L(band(ENG[0], ENG[1], BAR_R + 0.05, z, 72), { tone: "lo" }));
  out.push(S(k.cylinder(ENG[0], ENG[1], HEAD_R, BAR_Z1, HEAD_H, P, 90, 1), { tone: "hi", crease: "lo" }));
  out.push(L(k.ring(ENG[0], ENG[1], HEAD_R - 2.4, HEAD_TOP, P, 40), { tone: "lo" }));
  const boltA = [0.7, 2.26, 3.84, 5.42];
  out.push(D(boltA.map((a) => at([ENG[0] + Math.cos(a) * (HEAD_R - 4), ENG[1] + Math.sin(a) * (HEAD_R - 4), HEAD_TOP + 0.9])), { size: 0.5 }));
  // 火花塞（偏置；点火 = LLM 调用，lit 部件）
  out.push(S(k.cylinder(SPARK.x, SPARK.y, 4.8, HEAD_TOP, 3, P, 22), { tone: "mid" })); // 座
  out.push(S(k.cylinder(SPARK.x, SPARK.y, SPARK.r, HEAD_TOP + 2, SPARK.h, P, 18), { tone: "hi", lit: true }));
  out.push(L(k.knurl(SPARK.x, SPARK.y, SPARK.r, HEAD_TOP + 3, HEAD_TOP + SPARK.h - 2, 26, P, 0.3), { tone: "lo" }));
  out.push(D([at([SPARK.x, SPARK.y, HEAD_TOP + SPARK.h + 1.6])], { size: 0.8, tone: "lit" }));
  return out.join("");
}

/* 活塞杆 + 载荷 puck（整组沿 z 平移 = 冲程升程） */
function pistonGroup() {
  const out = [];
  out.push(S(k.cylinder(ENG[0], ENG[1], ROD.r, ROD.z0, ROD.z1 - ROD.z0, P, 18), { tone: "hi", lit: true, crease: "none" }));
  out.push(S(k.cylinder(ENG[0], ENG[1], ROD.r + 2.2, ROD.z1, 2.4, P, 22), { tone: "mid" }));
  out.push(S(k.cylinder(ENG[0], ENG[1], 6.2, PUCK_Z, 5, P, 26, 0.8), { tone: "hi", lit: true, crease: "lo" }));
  out.push(L(k.ring(ENG[0], ENG[1], 3.4, PUCK_Z + 5, P, 18), { tone: "lo" }));
  return out.join("");
}

/* ---------------- 飞轮（前缀缓存） ---------------- */
function flywheel() {
  const out = [];
  // 传动床：连接曲轴箱与飞轮（两个轴承座 + 床身）
  out.push(S(k.slabOf({ x: ENG[0] - 8, y: 4, w: 14, d: 60, r: 2 }, CASE_H - 4, 3.4, P, 3, 0.4), { tone: "lo" }));
  for (const by of [14, 52]) {
    out.push(S(k.slabOf({ x: ENG[0] - 7, y: by - 5, w: 12, d: 10, r: 2 }, CASE_H - 1, 6, P, 2.5, 0.4), { tone: "mid" }));
    out.push(D([at([ENG[0] - 1, by, CASE_H + 5])], { size: 0.5, tone: "lo" }));
  }
  // 传动轴：枕在两轴承座上，一头没入曲轴箱、一头接飞轮轮毂
  out.push(S(k.slabOf({ x: ENG[0] - 2.2, y: 12, w: 4.4, d: 46, r: 1.2 }, CASE_H + 3, 3.2, P, 2, 0.4), { tone: "mid", crease: "none" }));
  out.push(D([at([ENG[0], 14, CASE_H + 6.4]), at([ENG[0], 56, CASE_H + 6.4])], { size: 0.55, tone: "lo" }));
  out.push(S(k.cylinder(FLY[0], FLY[1], 5, 0, FLY_Z, P, 22), { tone: "mid", crease: "none" }));
  out.push(S(k.cylinder(FLY[0], FLY[1], FLY_R, FLY_Z, FLY_H, P, 120, 1), { tone: "mid", crease: "lo" }));
  out.push(L(k.knurl(FLY[0], FLY[1], FLY_R, FLY_Z + 1.4, FLY_TOP - 1.4, 132, P, 0.35), { tone: "lo" }));
  out.push(S(k.cylinder(FLY[0], FLY[1], 4.4, FLY_TOP, 7, P, 22), { tone: "mid" }));
  out.push(L(k.ring(FLY[0], FLY[1], FLY_R - 2.2, FLY_TOP, P, 48), { tone: "lo" }));
  return out.join("");
}
/* 离合蹄（咬合=缓存命中；退开=尾部变化使前缀失配） */
function clutchShoe() {
  const out = [];
  out.push(S(k.cylinder(FLY[0] - FLY_R - 8, FLY[1], 2.4, 0, FLY_TOP + 3, P, 16), { tone: "mid", crease: "none" }));
  out.push(S(k.slabOf({ x: FLY[0] - FLY_R - 12, y: FLY[1] - 4, w: 8, d: 8, r: 2 }, FLY_TOP + 3, 4, P, 2, 0.5), { tone: "mid" }));
  out.push(S(k.cylinder(FLY[0] - FLY_R - 4, FLY[1], 2.6, FLY_TOP + 5, 5, P, 18), { tone: "mid" }));
  out.push(L(k.knurl(FLY[0] - FLY_R - 4, FLY[1], 2.6, FLY_TOP + 5, FLY_TOP + 10, 18, P), { tone: "lo" }));
  return out.join("");
}

/* ---------------- 六位分度轮（凸轮面孔） ---------------- */
function indexWheel() {
  const out = [];
  out.push(S(k.cylinder(INDEX[0], INDEX[1], 4, 0, C_Z, P, 24), { tone: "mid", crease: "none" }));
  out.push(S(k.cylinder(INDEX[0], INDEX[1], I_R + 3, 0, 3, P, 40), { tone: "lo" }));
  out.push(S(k.cylinder(INDEX[0], INDEX[1], I_R, C_Z, 4, P, 58, 0.8), { tone: "mid", crease: "lo" }));
  out.push(L(k.knurl(INDEX[0], INDEX[1], I_R, C_Z + 2, C_Z + 4, 68, P, 0.4), { tone: "lo" }));
  const spokes = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    spokes.push(k.lineOnTop([INDEX[0] + Math.cos(a) * 2.8, INDEX[1] + Math.sin(a) * 2.8], [INDEX[0] + Math.cos(a) * (I_R - 3.5), INDEX[1] + Math.sin(a) * (I_R - 3.5)], C_Z + 4, P));
  }
  out.push(L(spokes.join(""), { tone: "lo" }));
  out.push(L(k.ring(INDEX[0], INDEX[1], 2.8, C_Z + 4, P, 20), { tone: "lo" })); // 轮毂环：辐条内端锚
  out.push(D(
    Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2;
      return at([INDEX[0] + Math.cos(a) * (I_R - 3.5), INDEX[1] + Math.sin(a) * (I_R - 3.5), C_Z + 4]);
    }),
    { size: 0.95, tone: "lo" },
  ));
  out.push(S(k.cylinder(INDEX[0], INDEX[1], 2.2, C_Z + 4, 3, P, 20), { tone: "mid" }));
  out.push(D([at([INDEX[0], INDEX[1], C_Z + 7])], { size: 0.7, tone: "hi" }));
  return out.join("");
}

/* ---------------- 时序联动杆（分度轮 → 导向柱 → 曲轴箱托架） ---------------- */
function timingLink() {
  const out = [];
  const GUIDE = [INDEX[0], INDEX[1] - 22];          // 导向柱（分度轮前方，落地）
  const SHELF = { x: ENG[0] + 30, y: ENG[1] - 12, w: 7, d: 10, r: 1.5 }; // 箱侧托架
  const SHELF_Z = 9;
  out.push(S(k.cylinder(GUIDE[0], GUIDE[1], 2.2, 0, 10, P, 16), { tone: "mid", crease: "none" }));
  out.push(L(k.ring(GUIDE[0], GUIDE[1], 3.2, 0, P, 16), { tone: "lo" }));
  out.push(D([at([GUIDE[0], GUIDE[1], 10])], { size: 0.6, tone: "lo" }));
  // 段1：轮毂顶 → 导向柱顶；段2：导向柱顶 → 托架面（低空，末端没入托架）
  out.push(L(k.segment([INDEX[0], INDEX[1], C_Z + 7], [GUIDE[0], GUIDE[1], 10.4], P), { tone: "lo" }));
  out.push(L(k.segment([GUIDE[0], GUIDE[1], 10.4], [SHELF.x + 3, SHELF.y + 5, SHELF_Z + 3], P), { tone: "lo" }));
  out.push(S(k.slabOf(SHELF, SHELF_Z, 3, P, 2, 0.4), { tone: "mid" }));
  out.push(D([at([SHELF.x + 3, SHELF.y + 5, SHELF_Z + 3])], { size: 0.5, tone: "lo" }));
  return out.join("");
}

/* ---------------- 日志鼓（真相，棘轮只进不退） ---------------- */
function logDrum() {
  const out = [];
  out.push(S(k.cylinder(DRUM[0], DRUM[1], DRUM_R + 3.4, DRUM_Z0 - 4, 4, P, 40), { tone: "lo" }));
  out.push(S(k.cylinder(DRUM[0], DRUM[1], DRUM_R, DRUM_Z0, DRUM_Z1 - DRUM_Z0, P, 68, 1), { tone: "mid", crease: "lo" }));
  // 视镜（液位 = 上下文占用）
  out.push(S(k.slabOf(SIGHT, DRUM_Z0 + 2, DRUM_Z1 - DRUM_Z0 - 4, P, 2, 0.4), { tone: "lo", crease: "none" }));
  out.push(D(
    [at([SIGHT.x + 2.5, SIGHT.y + 2.4, DRUM_Z0 + 2]), at([SIGHT.x + 2.5, SIGHT.y + SIGHT.d - 2.4, DRUM_Z0 + 2])],
    { size: 0.45 },
  ));
  // 68% 刻线（autoCompact 阈值）
  out.push(L(band(DRUM[0], DRUM[1], DRUM_R + 0.05, MARK_Z, 68), { tone: "hi" }));
  out.push(k.faceTextSvg(k.topMatrix([DRUM[0] - DRUM_R - 6, DRUM[1] + 7], MARK_Z - 2, P, "x"), "68", { size: 2.3, tone: "lo", anchor: "end" }));
  // 棘轮盘 + 棘爪
  out.push(S(k.cylinder(DRUM[0], DRUM[1], 9, DRUM_Z1, 4, P, 44, 0.8), { tone: "mid", crease: "lo" }));
  const teeth = k.radialTicks(DRUM[0], DRUM[1], 6.6, 12, 4, DRUM_Z1 + 4, [1.2, 2.2], P);
  out.push(L(teeth.minor, { tone: "lo" }), L(teeth.major, { tone: "mid" }));
  out.push(L(k.ring(DRUM[0], DRUM[1], 6.6, DRUM_Z1 + 4, P, 32), { tone: "lo" }));   // 齿外缘锚环
  out.push(L(k.ring(DRUM[0], DRUM[1], 4.2, DRUM_Z1 + 4, P, 28), { tone: "lo" }));   // 齿内缘锚环
  out.push(S(k.cylinder(DRUM[0] + 13, DRUM[1] + 6, 2.2, DRUM_Z1 + 1, 3, P, 16), { tone: "mid" }));
  out.push(S(k.slabOf({ x: DRUM[0] + 8.6, y: DRUM[1] + 4.4, w: 7, d: 3.2, r: 1 }, DRUM_Z1 + 5, 1.6, P, 2), { tone: "hi", crease: "none" }));
  out.push(D([at([DRUM[0] + 9.6, DRUM[1] + 6, DRUM_Z1 + 5.6])], { size: 0.6, tone: "hi" }));
  return out.join("");
}

/* 视窗套筒（投影：随水位滑动，罩住"摘要+尾部"窗口） */
function gateSleeve() {
  const out = [];
  out.push(S(k.cylinder(DRUM[0], DRUM[1], GATE.r, 0, GATE.h, P, 78, 0.8), { tone: "mid", crease: "lo" }));
  out.push(S(k.slabOf({ x: DRUM[0] - GATE.r - 6.2, y: DRUM[1] - 2, w: 6, d: 4, r: 1 }, GATE.h - 2, 3.4, P, 2), { tone: "mid", crease: "none" }));
  return out.join("");
}

/* 液位浮子 */
const floatMark = () =>
  S(k.slabOf({ x: SIGHT.x - 0.6, y: SIGHT.y - 1, w: SIGHT.w + 1.2, d: SIGHT.d + 2, r: 1 }, 0, 1.6, P, 2), { tone: "hi" });

/* 压缩压杆：龙门架两柱 + 横梁 + 穿梁压杆（端面贴近棘轮，68% 下击） */
function pressRam() {
  const out = [];
  for (const dx of [-20, 20]) {
    out.push(S(k.cylinder(DRUM[0] + dx, DRUM[1], 2.6, 0, 148, P, 16), { tone: "mid", crease: "none" }));
    out.push(L(k.ring(DRUM[0] + dx, DRUM[1], 4, 0, P, 16), { tone: "lo" }));
  }
  out.push(S(k.slabOf({ x: DRUM[0] - 24, y: DRUM[1] - 4, w: 48, d: 8, r: 2 }, 148, 6, P, 3, 0.5), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan({ x: DRUM[0] - 24, y: DRUM[1] - 4, w: 48, d: 8, r: 2 }, 2), 154, P), { tone: "faint" }));
  out.push(D([at([DRUM[0] - 21, DRUM[1] - 2, 154]), at([DRUM[0] + 21, DRUM[1] - 2, 154])], { size: 0.45 }));
  // 压杆：梁下衬套 → 杆 → 压盘（静止时距棘轮 6，下击 5 触及）
  out.push(S(k.cylinder(DRUM[0], DRUM[1], 4.2, 154, 3, P, 20), { tone: "lo" }));
  out.push(S(k.cylinder(DRUM[0], DRUM[1], 3.4, 130, 24, P, 16), { tone: "mid", crease: "none" }));
  out.push(S(k.cylinder(DRUM[0], DRUM[1], 10.5, 127, 3, P, 52, 0.8), { tone: "hi", crease: "lo" }));
  out.push(D([at([DRUM[0], DRUM[1], 130])], { size: 0.8, tone: "lo" }));
  return out.join("");
}

/* 摘要弹丸托盘 + 弹丸 */
function pelletTray() {
  const out = [];
  out.push(S(k.slabOf(TRAY, 0, 4, P, 3, 0.6), { tone: "lo" }));
  out.push(L(k.planOutline(k.insetPlan(TRAY, 2.4), 4, P), { tone: "faint" }));
  return out.join("");
}
function pellet(i) {
  const x = TRAY.x + 6.5 + i * 7.4;
  return (
    S(k.cylinder(x, TRAY.y + 8.5, 2.6, 4, 3, P, 18, 0.8), { tone: "hi", crease: "lo" }) +
    L(k.ring(x, TRAY.y + 8.5, 1.4, 7, P, 14), { tone: "lo" })
  );
}

/* ---------------- 四端口插座（Transport/KV/VFS/Sandbox，可换插头） ---------------- */
function portSockets() {
  const out = [];
  const base = { x: 116, y: -48, w: 52, d: 18, r: 3 };
  out.push(S(k.slabOf(base, 0, 5, P, 3, 0.6), { tone: "lo" }));
  out.push(L(k.planOutline(k.insetPlan(base, 2.4), 5, P), { tone: "faint" }));
  for (let i = 0; i < 4; i++) {
    const x = base.x + 7 + i * 12;
    out.push(S(k.cylinder(x, base.y + 9, 3.8, 5, 6.5, P, 24, 0.8), { tone: "mid", crease: "lo" }));
    out.push(L(k.ring(x, base.y + 9, 2.2, 11.5, P, 18), { tone: "lo" }));
    out.push(D([at([x, base.y + 9, 11.5])], { size: 0.55, tone: "hi" }));
  }
  // 束线：四插座 → 保险丝盒（端口汇聚到熔断保护）
  out.push(k.wireSvg([base.x + 44, base.y + 9, 11.5], [FUSE.x + FUSE.w, FUSE.y + FUSE.d / 2, 9], { tone: "mid", dotted: false }));
  return out.join("");
}

/* ---------------- 保险丝盒 ---------------- */
function fusebox() {
  return (
    S(k.slabOf(FUSE, 0, 9, P, 3, 0.6), { tone: "lo" }) +
    L(k.planOutline(k.insetPlan(FUSE, 2.4), 9, P), { tone: "faint" })
  );
}
function fuse(fx, intact) {
  const fy = FUSE.y + FUSE.d / 2;
  const out = [S(k.cylinder(fx, fy, 2.8, 9, intact ? 14 : 7.5, P, 18, 0.8), { tone: intact ? "mid" : "lo", crease: "lo" })];
  out.push(L(k.ring(fx, fy, 1.6, 9 + (intact ? 14 : 7.5), P, 14), { tone: "lo" }));
  if (!intact) out.push(L(band(fx, fy, 2.8, 16.5, 26), { tone: "hi" }));
  return out.join("");
}
const FUSES_INTACT = FUSE_XS.map((fx) => fuse(fx, true)).join("");
const FUSES_BROKEN = FUSE_XS.map((fx) => fuse(fx, false)).join("");

/* ---------------- 转速表（24 圈红区） ---------------- */
function counter() {
  const out = [];
  out.push(S(k.cylinder(COUNTER[0], COUNTER[1], 2.8, 0, C_Z, P, 18), { tone: "mid", crease: "none" }));
  out.push(S(k.cylinder(COUNTER[0], COUNTER[1], C_R, C_Z, 5, P, 58, 0.8), { tone: "hi", crease: "lo" }));
  out.push(L(k.knurl(COUNTER[0], COUNTER[1], C_R, C_Z + 2, C_Z + 5, 72, P, 0.3), { tone: "lo" }));
  const ticks = k.radialTicks(COUNTER[0], COUNTER[1], C_R - 2.6, 24, 6, C_Z + 5, [1.1, 2.4], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(L(k.ring(COUNTER[0], COUNTER[1], C_R - 2.6, C_Z + 5, P, 44), { tone: "lo" })); // 外缘锚环
  out.push(L(k.ring(COUNTER[0], COUNTER[1], C_R - 5.0, C_Z + 5, P, 36), { tone: "lo" })); // 内缘锚环
  const arc = [];
  for (let a = Math.PI * 0.62; a <= Math.PI * 0.86; a += Math.PI / 110) {
    arc.push(k.iso([COUNTER[0] + Math.cos(a) * (C_R - 3.7), COUNTER[1] + Math.sin(a) * (C_R - 3.7), C_Z + 5], P));
  }
  out.push(`<path class="iso-line" data-tone="lit" data-free="both" d="M${arc.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L")}" style="stroke-width:1.4"/>`);
  out.push(k.faceTextSvg(k.topMatrix([COUNTER[0] - C_R + 2, COUNTER[1] + 8.6], C_Z + 5, P, "x"), "24", { size: 2.2, tone: "lo", anchor: "middle" }));
  out.push(D([at([COUNTER[0], COUNTER[1], C_Z + 5])], { size: 0.9, tone: "mid" }));
  return out.join("");
}

function needleAt(turns) {
  const a = Math.PI * 0.95 - (turns / 24) * Math.PI * 1.8;
  const [x, y] = COUNTER;
  return k.lineOnTop(
    [x - Math.cos(a) * 2.2, y - Math.sin(a) * 2.2],
    [x + Math.cos(a) * (C_R - 4.2), y + Math.sin(a) * (C_R - 4.2)],
    C_Z + 5.2, P,
  );
}

/* ---------------- 装配（画家序：后 → 前） ---------------- */
const svg = k.figureSvg({
  width: WIDTH, height: HEIGHT,
  label:
    "Six-stroke agent engine on a bench. One revolution of the index wheel is one harness turn: intake, context valve, ignition, tool stroke, results re-enter, snapshot at the tail. The ratcheted drum is the session log, append-only; the sliding sleeve is the context view — summary plus tail is all the cylinder breathes; at the 68% mark the press folds the head into a gold pellet. The flywheel clutch is the prefix cache — engaged, the unchanged prefix costs a fiftieth. Three straight failures break the fuse; the red zone at 24 forces a tool-free final answer.",
  body: [
    bench(),
    flywheel(),
    `<g data-part="shoe">${clutchShoe()}</g>`,
    `<g data-part="orbit">${D([at([FLY[0] + FLY_R - 2.4, FLY[1], FLY_TOP + 0.4])], { size: 0.9, tone: "hi" })}</g>`,
    indexWheel(),
    timingLink(),
    `<g data-part="idot">${D([at([INDEX[0] + I_R - 3.2, INDEX[1], C_Z + 4])], { size: 0.9, tone: "hi" })}</g>`,
    engineStatic(),
    `<g data-part="piston">${pistonGroup()}</g>`,
    logDrum(),
    `<g data-part="gate">${gateSleeve()}</g>`,
    `<g data-part="float">${floatMark()}</g>`,
    pelletTray(),
    `<g data-part="pellets"></g>`,
    `<g data-part="ram">${pressRam()}</g>`,
    counter(),
    `<path data-part="needle" class="iso-line" data-tone="lit" data-free="start" d="${needleAt(0)}" style="stroke-width:1.1"/>`,
    portSockets(),
    fusebox(),
    `<g data-part="fuses">${FUSES_INTACT}</g>`,
  ],
});

/* ---------------- 运行时（构建期注入常量与预制 HTML） ---------------- */
const live = `
const P = ${JSON.stringify(P)};
const TURN_MS = 4800, MAX_ITERS = 24, TOOLS = 18, COMPACT_AT = ${COMPACT_AT};
const DRUM = ${JSON.stringify(DRUM)}, DRUM_Z0 = ${DRUM_Z0}, DRUM_Z1 = ${DRUM_Z1};
const ENG = ${JSON.stringify(ENG)};
const FLY = ${JSON.stringify(FLY)}, FLY_R = ${FLY_R}, FLY_TOP = ${FLY_TOP};
const INDEX = ${JSON.stringify(INDEX)}, I_R = ${I_R}, C_Z = ${C_Z}, C_R = ${C_R};
const COUNTER = ${JSON.stringify(COUNTER)};
const GATE_H = ${GATE.h};
const FUSES_INTACT = ${JSON.stringify(FUSES_INTACT)}, FUSES_BROKEN = ${JSON.stringify(FUSES_BROKEN)};
const PELLETS = ${JSON.stringify([pellet(0), pellet(1), pellet(2)])};
const strokeNames = ["intake", "valve", "ignite", "tools", "re-enter", "tail"];
const $ = (n) => document.querySelector('[data-part="' + n + '"]');
const piston = $("piston"), gate = $("gate"), floatM = $("float"), ram = $("ram"),
      shoe = $("shoe"), orbit = $("orbit"), idot = $("idot"), needle = $("needle"),
      pellets = $("pellets"), fuses = $("fuses"), stage = document.querySelector(".iso-stage"),
      readout = document.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
let phase = 0, turn = 1, iters = 0, logFill = 0.16, pelletsN = 0,
    fuseBlown = false, failStreak = 0, cut = false, playing = true,
    last = 0, hover = -1, frame = 0, visible = false, ramDown = 0;
const needleAt = ${needleAt.toString().replace(/k\./g, "")};
function draw() {
  const s = Math.min(5, Math.floor(phase * 6) % 6);
  const lift = s === 2 ? Math.sin((phase * 6 - 2) * Math.PI) * 15 : s === 3 ? 5 + 1.8 * Math.sin(phase * 46) : 0;
  piston.setAttribute("transform", translateAlong(P, [0, 0, lift]));
  // 视窗套筒：罩住水位附近的"摘要+尾部"窗口（套筒画于 z=0，平移到目标底缘）
  const gateBottom = DRUM_Z0 + Math.max(1, logFill * (DRUM_Z1 - DRUM_Z0) - GATE_H * 0.7);
  gate.setAttribute("transform", translateAlong(P, [0, 0, gateBottom]));
  floatM.setAttribute("transform", translateAlong(P, [0, 0, DRUM_Z0 + 2 + logFill * (DRUM_Z1 - DRUM_Z0 - 6)]));
  const eng = playing && !cut && !fuseBlown;
  const wheelA = eng ? phase * Math.PI * 2 : 0;
  idot.setAttribute("transform", translateAlong(P, [
    INDEX[0] + Math.cos(wheelA) * (I_R - 3.2) - (INDEX[0] + I_R - 3.2),
    INDEX[1] + Math.sin(wheelA) * (I_R - 3.2) - INDEX[1], 0]));
  const fo = eng ? phase * Math.PI * 2 * 1.6 : 0;
  orbit.setAttribute("transform", translateAlong(P, [
    FLY[0] + Math.cos(fo) * (FLY_R - 2.4) - (FLY[0] + FLY_R - 2.4),
    FLY[1] + Math.sin(fo) * (FLY_R - 2.4) - FLY[1], 0]));
  // 离合：点火/收尾冲程外退开（尾部变化破坏前缀 → 未命中部分按原价）
  shoe.setAttribute("transform", translateAlong(P, [s === 2 || s === 3 ? 0 : -4, 0, 0]));
  ram.setAttribute("transform", translateAlong(P, [0, 0, -ramDown]));
  needle.setAttribute("d", needleAt(Math.min(iters, MAX_ITERS)));
  const cache = fuseBlown ? 0 : cut ? 34 : 90 + Math.round(6 * Math.sin(phase * 9));
  const text = fuseBlown
    ? "fuse blown · LLM 连续 3 次失败 → 熔断 · 点击复位"
    : cut
      ? "iter " + iters + "/" + MAX_ITERS + " · 达到上限 → 强制收尾（无工具直接作答） · 点击复位"
      : "t" + turn + " · 冲程 " + (s + 1) + "/6 " + strokeNames[s] + " · 日志 " + Math.round(logFill * 100) + "% · 缓存 " + cache + "%";
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
  if (px > 0.18 && px < 0.38) {   // 火花塞区域：连点 3 次 = LLM 连续失败
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
  hint: "hover 拖动冲程 · 火花塞连点 3× 熔断 · R 复位",
  readout: "turn 1 · stroke 1/6 intake · log 16% · cache 96% · tools 18",
  keys: [
    { mark: "lit", label: "Plug, piston rod and payload puck: the live turn — one fired stroke per LLM call" },
    { mark: "raised", label: "Sliding sleeve on the log drum: the context view; summary plus tail is all the cylinder breathes" },
  ],
  caption:
    "tim-harness runs a whole agent harness in one browser page. One revolution of the index wheel is one harness turn — six strokes: intent in, context valved, ignition, tools, results back, snapshot at the tail. The ratcheted drum is the session log: append-only, never rewritten, so any reload can resume. The sleeve is the context view; past the 68% mark the press folds the head into a gold pellet and the sight-glass level falls — the log itself never shrinks. The flywheel clutch is the provider prefix cache: engaged, the unchanged prefix costs a fiftieth. Three straight failures break the fuse; the red zone at 24 iterations forces a tool-free final answer. Numbers are the repo's own: 18 tools, 0.68 compact threshold, 24-iteration cap.",
  body: `<div class="iso-stage" tabindex="0" role="slider" aria-label="Six-stroke agent engine: hover scrubs the cycle, R resets" aria-valuemin="0" aria-valuemax="24">${svg}</div>`,
});

writeFileSync(
  join(HERE, theme === "light" ? "tim-harness-engine-light.html" : "tim-harness-engine.html"),
  k.pageHtml({ title: "Six-stroke agent engine — tim-harness", theme, body, script: kitScript() + live }),
);
console.log("wrote", theme === "light" ? "tim-harness-engine-light.html" : "tim-harness-engine.html");
