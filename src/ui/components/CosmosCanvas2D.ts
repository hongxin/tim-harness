import { drawMachinePart, drawStatusLight, drawConveyorBelt, getToolIcon } from './MachineParts'
/**
 * Cosmos 2D v4 —— 约束力导向布局（Constrained Force-Directed）
 * 力场 + 语义约束 = 有机 + 有结构（参考中医药知识图谱可视化方法论）
 */
export interface CosmosNode2D { id:string; kind:'user'|'assistant'|'tool'|'sub-agent'|'core'|'file'; content:string; toolName?:string; isError?:boolean; isRunning?:boolean; durationMs?:number; turnId:number; birthTime:number; x:number;y:number;vx:number;vy:number; radius:number; pinned:boolean; hue:number; gridCol?:number; gridRow?:number; dragged?:boolean }
export interface CosmosEdge2D { id:string;fromId:string;toId:string; type:'flow'|'cross-turn'|'grid' }
export interface TurnCluster { turnId:number;centerX:number;centerY:number;radius:number;nodeIds:string[];summary:string;hue:number;toolCount:number;hasError:boolean;totalDuration:number }
export const TOOL_HUE:Record<string,number>={ls:140,read_file:200,write_file:160,edit_file:280,grep:180,glob:150,run_js:45,web_fetch:320,web_search:220,todo_write:100,spawn_agent:300,ask_user:50,skill:260,goal_update:120,snapshot_save:170,snapshot_restore:175,snapshot_list:165,snapshot_diff:168,snapshot_delete:172}
export const KIND_HUE:Record<string,number>={user:30,assistant:260,tool:210,'sub-agent':300,core:45,file:100}
const R:Record<string,number>={user:40,assistant:28,tool:16,'sub-agent':38,core:44,file:12}


interface SimS{nodes:Map<string,CosmosNode2D>;edges:CosmosEdge2D[];clusters:Map<number,TurnCluster>;cooled:boolean}
/**
 * 语义定位 + 力场微调（Semantic Layout + Force Refinement）
 *
 * 与"约束力导向"的本质区别：
 * - 约束力导向：力场做骨架 + 约束力做引导 → 两种力打架 → 挤向中间
 * - 语义定位：先确定语义位置 → 力场只做碰撞消解 → 位置稳定且有结构
 *
 * 语义定位（确定性）：
 *   X = turnId × GAP + 工具偏移 + 微抖动
 *   Y = 角色层级（用户 -90 / 助手 0 / 工具 100+行×40）+ 微抖动
 *
 * 力场微调（有机感）：
 *   仅在节点重叠时施加分离力（不影响语义位置）
 *   弹簧力保持连接的视觉关联
 */
const GAP = 340
const USER_Y = -220
const ASST_Y = 0
const TOOL_Y0 = 220
const TOOL_DH = 90
const JITTER = 22
const COLLIDE = 15000
const COLLIDE_RANGE = 1.5

export function tickSim(sim: SimS) {
  if (sim.cooled || sim.nodes.size < 2) return
  const arr = Array.from(sim.nodes.values())
  let energy = 0

  // 1. 语义锚定：每个节点被强力拉向其语义位置
  for (const n of arr) {
    if (n.pinned || n.dragged) continue // 用户拖拽过的节点不被拉回
    let targetX: number, targetY: number
    if (n.kind === 'core') { targetX = -GAP; targetY = 0 }
    else if (n.kind === 'user') { targetX = n.turnId * GAP; targetY = USER_Y }
    else if (n.kind === 'assistant') { targetX = n.turnId * GAP; targetY = ASST_Y }
    else if (n.kind === 'tool') {
      const col = n.gridCol ?? 0
      const row = n.gridRow ?? 0
      const toolCount = arr.filter((m) => m.turnId === n.turnId && m.kind === 'tool').length
      const centerOffset = (Math.min(toolCount, 3) - 1) / 2 * 44
      targetX = n.turnId * GAP + col * 80 - centerOffset
      targetY = TOOL_Y0 + row * TOOL_DH
    }
    else { targetX = n.turnId * GAP + 100; targetY = 50 }

    // 强力锚定（比碰撞力强 → 语义位置是"家"）
    // 自适应锚定：距离远→强拉（快速到位），距离近→温和（避免过冲振荡）
    const dist = Math.sqrt((targetX-n.x)**2 + (targetY-n.y)**2)
    const strength = Math.min(0.2, Math.max(0.05, dist * 0.002))
    n.vx += (targetX - n.x) * strength
    n.vy += (targetY - n.y) * strength
  }

  // 2. 碰撞消解：仅在跨回合节点重叠时推开（同回合网格节点已由间距保证）
  // 根因修复：同回合工具方块的网格间距(44px) < 碰撞最小距离(48px)
  // → 碰撞力永远激活 → 与锚定力形成永久振荡（抖动的根源）
  // 解法：同回合的网格定位节点跳过碰撞（它们的间距由网格决定，不需要力来保证）
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j]
      // 跳过同回合的碰撞（网格已处理间距）
      if (a.turnId === b.turnId && a.kind !== 'user' && b.kind !== 'user') continue
      // 用户与同回合助手的碰撞也跳过（层级约束已保证垂直分离）
      if (a.turnId === b.turnId) continue
      const dx = b.x - a.x, dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const minDist = (a.radius + b.radius) * COLLIDE_RANGE
      if (dist < minDist && dist > 0.1) {
        const f = COLLIDE / (dist * dist)
        const fx = (dx / dist) * f, fy = (dy / dist) * f * 0.3
        if (!a.pinned) { a.vx -= fx; a.vy -= fy }
        if (!b.pinned) { b.vx += fx; b.vy += fy }
      }
    }
  }

  // 3. 连接弹簧（视觉关联提示，很弱）
  for (const e of sim.edges) {
    const a = sim.nodes.get(e.fromId), b = sim.nodes.get(e.toId)
    if (!a || !b) continue
    if (a.turnId !== b.turnId) continue // 跨回合连接不用弹簧（由语义位置保证间距）
    const dx = b.x - a.x, dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const f = 0.001 * Math.max(0, dist - 80)
    const fx = (dx / dist) * f, fy = (dy / dist) * f * 0.1
    if (!a.pinned) { a.vx += fx; a.vy += fy }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy }
  }

  // 4. 应用运动
  for (const n of arr) {
    if (n.pinned) continue
    n.vx *= 0.65; n.vy *= 0.65
    const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy)
    if (sp > 6) { n.vx = n.vx / sp * 6; n.vy = n.vy / sp * 6 }
    n.x += n.vx; n.y += n.vy
    energy += n.vx * n.vx + n.vy * n.vy
  }
  if (energy < 0.1) sim.cooled = true

  // 更新回合聚集
  const bt = new Map<number, CosmosNode2D[]>()
  for (const n of arr) {
    if (!bt.has(n.turnId)) bt.set(n.turnId, [])
    bt.get(n.turnId)!.push(n)
  }
  for (const [tid, ns] of bt) {
    let cx = 0, cy = 0
    for (const n of ns) { cx += n.x; cy += n.y }
    cx /= ns.length; cy /= ns.length
    let far = 0
    for (const n of ns) far = Math.max(far, Math.sqrt((n.x-cx)**2 + (n.y-cy)**2) + n.radius)
    let c = sim.clusters.get(tid)
    if (!c) {
      c = { turnId: tid, centerX: cx, centerY: cy, radius: Math.max(far, 50), nodeIds: ns.map(n=>n.id),
            summary: `T${tid+1}`, hue: 210, toolCount: ns.filter(n=>n.kind==='tool').length,
            hasError: ns.some(n=>n.isError), totalDuration: ns.reduce((s,n)=>s+(n.durationMs??0),0) }
      sim.clusters.set(tid, c)
    }
    c.centerX = cx; c.centerY = cy; c.radius = Math.max(far, 50)
    c.nodeIds = ns.map(n=>n.id); c.toolCount = ns.filter(n=>n.kind==='tool').length
    c.hasError = ns.some(n=>n.isError); c.totalDuration = ns.reduce((s,n)=>s+(n.durationMs??0),0)
  }
}

export function mapSessionToCosmos(msgs:Array<{role:string;content?:string|null;tool_calls?:Array<{id:string;name:string}>;name?:string;toolOk?:boolean;durationMs?:number}>,folded:number):{nodes:CosmosNode2D[];edges:CosmosEdge2D[];clusters:TurnCluster[]}{
const nodes:CosmosNode2D[]=[],edges:CosmosEdge2D[]=[];let turn=0
if(folded>0)nodes.push({id:'core',kind:'core',content:`⚡ ${folded} 条已压缩`,turnId:-1,birthTime:performance.now(),x:-GAP,y:0,vx:0,vy:0,radius:R.core,pinned:false,hue:KIND_HUE.core})
msgs.slice(folded).forEach((m,i)=>{const now=performance.now()
if(m.role==='user'){turn++;const id=`u${i}`,tx=turn*GAP+(Math.random()-.5)*40;nodes.push({id,kind:'user',content:(m.content??'').slice(0,120),turnId:turn,birthTime:now,x:tx,y:USER_Y+(Math.random()-.5)*JITTER,vx:0,vy:0,radius:R.user,pinned:false,hue:KIND_HUE.user});const p=nodes[nodes.length-2];if(p)edges.push({id:`xt${i}`,fromId:p.id,toId:id,type:'cross-turn'})}
else if(m.role==='assistant'){const id=`a${i}`,tx=turn*GAP+(Math.random()-.5)*40;nodes.push({id,kind:'assistant',content:(m.content??'').slice(0,120)||`${m.tool_calls?.length??0} 工具`,turnId:turn,birthTime:now,x:tx,y:ASST_Y+(Math.random()-.5)*JITTER,vx:0,vy:0,radius:R.assistant,pinned:false,hue:KIND_HUE.assistant});const un=nodes.find(n=>n.kind==='user'&&n.turnId===turn);if(un)edges.push({id:`f${i}`,fromId:un.id,toId:id,type:'flow'});if(m.tool_calls)m.tool_calls.forEach((tc,j)=>{const tid=`t${i}_${j}`;nodes.push({id:tid,kind:'tool',content:tc.name,toolName:tc.name,turnId:turn,birthTime:now,x:tx+(j%3-(Math.min(m.tool_calls!.length,3)-1)/2)*80+(Math.random()-.5)*JITTER,y:TOOL_Y0+Math.floor(j/3)*TOOL_DH+(Math.random()-.5)*JITTER, gridCol:j%3, gridRow:Math.floor(j/3),vx:0,vy:0,radius:R.tool,pinned:false,hue:TOOL_HUE[tc.name]??210});edges.push({id:`g${tid}`,fromId:id,toId:tid,type:'grid'})})}
else if(m.role==='tool'){const tn=nodes.find(n=>n.kind==='tool'&&n.turnId===turn&&n.toolName===m.name&&n.durationMs==null);if(tn){tn.isError=m.toolOk===false;tn.durationMs=m.durationMs;tn.content=`${m.name} ${m.toolOk===false?'✗':'✓'}`}}})
return{nodes,edges,clusters:[]}}
interface Star{x:number;y:number;size:number;layer:number;alpha:number;twinkle:boolean}
interface P{edgeId:string;t:number}
export class CosmosCanvas2D{private c:HTMLCanvasElement;private x:CanvasRenderingContext2D;private w=0;private h=0;private dpr=1;private ai=0;private sim:SimS={nodes:new Map(),edges:[],clusters:new Map(),cooled:false};private st:Star[]=[];private pt:P[]=[];private t0=performance.now();private z=1;private ox=0;private oy=0;private hi:string|null=null
  private hoverNeighbors:Set<string>=new Set();private si:string|null=null;private ft:number|null=null;private ro:ResizeObserver;private os:((n:CosmosNode2D|null)=>void)|null=null;private oc:((c:string|null)=>void)|null=null;private cam:{t:number;d:number;fx:number;fy:number;fz:number;tx:number;ty:number;tz:number}|null=null;private pan=false;private dn:string|null=null
  // 主题配色（从 CSS 变量读取，随主题切换更新）
  private theme = this.defaultTheme()
  private defaultTheme() {
    return {
      dark: true,
      bg: 'hsl(230,20%,8%)', bgEdge: 'hsl(230,15%,3%)',
      star: 'rgba(220,230,255,',
      text: 'hsla(0,0%,95%,', textDim: 'hsla(0,0%,70%,',
      line: 'hsla(210,30%,30%,', lineSub: 'hsla(210,25%,40%,',
      glow: (h: number, s: number, a: number) => `hsla(${h},${s}%,65%,${a})`,
      particle: 'hsla(45,80%,70%,.6)',
      clusterLine: (h: number, a: number) => `hsla(${h},50%,55%,${a})`,
      clusterLabel: (h: number, a: number) => `hsla(${h},30%,60%,${a})`,
      region: (h: number, a: number) => `hsla(${h},30%,50%,${a})`,
      bodyBoost: 15, bodyCut: -10,
      selectRing: (h: number) => `hsla(${h},90%,70%,.8)`,
    }
  }

  /** 从 CSS 变量读取当前主题配色（浅色/深色自适应） */
  updateTheme(){const root=document.documentElement;const isLight=root.dataset.theme==='light'
    this.theme.dark=!isLight
    if(isLight){
      this.theme.bg='hsl(220,15%,96%)';this.theme.bgEdge='hsl(220,12%,90%)'
      this.theme.star='rgba(80,90,120,'
      this.theme.text='hsla(0,0%,15%,';this.theme.textDim='hsla(0,0%,40%,'
      this.theme.line='hsla(210,20%,60%,';this.theme.lineSub='hsla(210,15%,70%,'
      // 发光/粒子/区域：浅色下降低饱和度、提高亮度
      this.theme.glow=(h,s,a)=>`hsla(${h},${Math.round(s*0.5)}%,80%,${a*0.6})`
      this.theme.particle='hsla(210,50%,50%,.5)'
      this.theme.clusterLine=(h,a)=>`hsla(${h},40%,60%,${a})`
      this.theme.clusterLabel=(h,a)=>`hsla(${h},30%,35%,${a})`
      this.theme.region=(h,a)=>`hsla(${h},25%,70%,${a})`
      this.theme.bodyBoost=0;this.theme.bodyCut=-5 // 浅色下节点体色更柔和
      this.theme.selectRing=(h)=>`hsla(${h},60%,40%,.8)`
    }else{
      this.theme.bg='hsl(230,20%,8%)';this.theme.bgEdge='hsl(230,15%,3%)'
      this.theme.star='rgba(220,230,255,'
      this.theme.text='hsla(0,0%,95%,';this.theme.textDim='hsla(0,0%,70%,'
      this.theme.line='hsla(210,30%,30%,';this.theme.lineSub='hsla(210,25%,40%,'
      this.theme.glow=(h,s,a)=>`hsla(${h},${s}%,65%,${a})`
      this.theme.particle='hsla(45,80%,70%,.6)'
      this.theme.clusterLine=(h,a)=>`hsla(${h},50%,55%,${a})`
      this.theme.clusterLabel=(h,a)=>`hsla(${h},30%,60%,${a})`
      this.theme.region=(h,a)=>`hsla(${h},30%,50%,${a})`
      this.theme.bodyBoost=15;this.theme.bodyCut=-10 // 深色下节点体色更鲜明
      this.theme.selectRing=(h)=>`hsla(${h},90%,70%,.8)`
    }};private ps={x:0,y:0}
constructor(c:HTMLCanvasElement){this.c=c;this.x=c.getContext('2d')!;this.ro=new ResizeObserver(()=>this.rs());this.ro.observe(c.parentElement||c);this.updateTheme();this.rs();this.is();this.lp();this.be()}
destroy(){cancelAnimationFrame(this.ai);this.ro.disconnect();this.ue()}
setOnNodeSelect(cb:(n:CosmosNode2D|null)=>void){this.os=cb}
setOnCaptionUpdate(cb:(c:string|null)=>void){this.oc=cb}
setNodes(ns:CosmosNode2D[],es:CosmosEdge2D[],_cl:TurnCluster[]){const ni=new Set(ns.map(n=>n.id));for(const id of this.sim.nodes.keys())if(!ni.has(id))this.sim.nodes.delete(id);for(const n of ns){const o=this.sim.nodes.get(n.id);if(o){o.content=n.content;o.isError=n.isError;o.durationMs=n.durationMs;o.hue=n.hue;o.toolName=n.toolName}else{this.sim.nodes.set(n.id,{...n});this.sim.cooled=false}}this.sim.edges=es;this.sim.cooled=false;const ei=new Set(es.map(e=>e.id));this.pt=this.pt.filter(p=>ei.has(p.edgeId));for(const e of es)if(!this.pt.some(p=>p.edgeId===e.id))this.pt.push({edgeId:e.id,t:Math.random()})}
flyToTurn(t:number){const c=this.sim.clusters.get(t);if(!c)return;this.ft=t;this.ac(c.centerX,c.centerY,Math.max(1.4,200/Math.max(c.radius,60)));this.oc?.(c.summary)}
resetView(){this.ft=null;this.oc?.(null);this.af()}
getTourSteps(){return[...this.sim.clusters.values()].filter(c=>c.turnId>=0).sort((a,b)=>a.turnId-b.turnId)}
private ac(tx:number,ty:number,tz:number){this.cam={t:0,d:700,fx:this.ox,fy:this.oy,fz:this.z,tx:-tx,ty:-ty*.5,tz}}
private af(){
    if(!this.sim.nodes.size)return
    // 地图式初始视角：聚焦最近 2-3 个回合（可读优先），非全量缩放
    // 类似 Google Maps 初始显示城市级别，而非整个地球
    const all=Array.from(this.sim.nodes.values())
    const maxTurn=Math.max(...all.map(n=>n.turnId))
    const recentTurns=all.filter(n=>n.turnId>=Math.max(0,maxTurn-2)) // 最近 3 个回合（含当前）
    
    // 如果有较早的节点，把起点也纳入视野（但降低权重）
    const focusNodes=recentTurns.length>0?recentTurns:all
    let x1=1/0,x2=-1/0,y1=1/0,y2=-1/0
    for(const n of focusNodes){x1=Math.min(x1,n.x-n.radius);x2=Math.max(x2,n.x+n.radius);y1=Math.min(y1,n.y-n.radius);y2=Math.max(y2,n.y+n.radius)}
    // Y 轴始终包含完整层级范围（用户到工具）
    y1=Math.min(y1,-240);y2=Math.max(y2,420)
    // 计算缩放：目标是让节点在屏幕上足够大（zoom >= 0.8）
    this.z=Math.max(0.8,Math.min(1.5,Math.min(this.w/Math.max(x2-x1,300),this.h/(y2-y1+100))))
    this.ox=-(x1+x2)/2;this.oy=-(y1+y2)/2
    // 如果 zoom 被上限截断，偏移到右端（最新的回合）
    if((x2-x1)*this.z>this.w){this.ox=-(x2-this.w/this.z/2)}
  }
private w2s(wx:number,wy:number):[number,number]{return[(wx+this.ox)*this.z+this.w/2,(wy+this.oy)*this.z+this.h/2]}
private s2w(sx:number,sy:number):[number,number]{return[(sx-this.w/2)/this.z-this.ox,(sy-this.h/2)/this.z-this.oy]}
private be(){this.c.addEventListener('wheel',this.ow);this.c.addEventListener('pointerdown',this.od);this.c.addEventListener('pointermove',this.om);this.c.addEventListener('pointerup',this.ou);this.c.addEventListener('pointerleave',this.ou)}
private ue(){this.c.removeEventListener('wheel',this.ow);this.c.removeEventListener('pointerdown',this.od);this.c.removeEventListener('pointermove',this.om);this.c.removeEventListener('pointerup',this.ou);this.c.removeEventListener('pointerleave',this.ou)}
private ow=(e:WheelEvent)=>{e.preventDefault();this.cam=null;this.z=Math.max(.1,Math.min(5,this.z*(e.deltaY>0?.9:1.1)))}
private od=(e:PointerEvent)=>{const r=this.c.getBoundingClientRect();const[wx,wy]=this.s2w(e.clientX-r.left,e.clientY-r.top);for(const n of[...this.sim.nodes.values()].reverse()){const dx=wx-n.x,dy=wy-n.y;if(dx*dx+dy*dy<=n.radius*n.radius){this.si=n.id;this.os?.(n);this.dn=n.id;n.pinned=true;n.vx=0;n.vy=0;this.sim.cooled=false;return}}for(const c of this.sim.clusters.values()){const dx=wx-c.centerX,dy=wy-c.centerY;if(dx*dx+dy*dy<=c.radius*c.radius){this.flyToTurn(c.turnId);return}}this.si=null;this.ft=null;this.os?.(null);this.oc?.(null);this.pan=true;this.ps={x:e.clientX,y:e.clientY}}
private om=(e:PointerEvent)=>{const r=this.c.getBoundingClientRect();if(this.dn){const[wx,wy]=this.s2w(e.clientX-r.left,e.clientY-r.top);const n=this.sim.nodes.get(this.dn);if(n){n.x=wx;n.y=wy;n.vx=0;n.vy=0;n.dragged=true;this.sim.cooled=false}return}
if(this.pan){this.cam=null;this.ox+=(e.clientX-this.ps.x)/this.z;this.oy+=(e.clientY-this.ps.y)/this.z;this.ps={x:e.clientX,y:e.clientY};return}const[wx,wy]=this.s2w(e.clientX-r.left,e.clientY-r.top);this.hi=null;this.hoverNeighbors.clear();for(const n of this.sim.nodes.values()){const dx=wx-n.x,dy=wy-n.y;if(dx*dx+dy*dy<=n.radius*n.radius){this.hi=n.id;break}}this.c.style.cursor=this.hi?'pointer':'grab'}
private ou=()=>{if(this.dn){const n=this.sim.nodes.get(this.dn);if(n)n.pinned=false;this.dn=null}this.pan=false;this.hi=null;this.hoverNeighbors.clear()}
private rs(){const p=this.c.parentElement;if(!p)return;this.dpr=devicePixelRatio||1;this.w=p.clientWidth;this.h=p.clientHeight;this.c.width=this.w*this.dpr;this.c.height=this.h*this.dpr;this.c.style.width=`${this.w}px`;this.c.style.height=`${this.h}px`;this.x.setTransform(this.dpr,0,0,this.dpr,0,0)}
private is(){this.st=[];for(let i=0;i<60;i++)this.st.push({x:Math.random()*3000-1500,y:Math.random()*2000-1000,size:Math.random()*1.5+.3,layer:Math.floor(Math.random()*3),alpha:Math.random()*.5+.15,twinkle:Math.random()<.1})}
private lp=()=>{if(this.cam){const a=this.cam;a.t+=16/a.d;if(a.t>=1){this.ox=a.tx;this.oy=a.ty;this.z=a.tz;this.cam=null}else{const e=a.t<.5?4*a.t**3:1-(-2*a.t+2)**3/2;this.ox=a.fx+(a.tx-a.fx)*e;this.oy=a.fy+(a.ty-a.fy)*e;this.z=a.fz+(a.tz-a.fz)*e}}tickSim(this.sim);this.rd();this.ai=requestAnimationFrame(this.lp)}
private rd(){const ctx=this.x;const now=performance.now();const tm=(now-this.t0)/1000
const bg=ctx.createRadialGradient(this.w/2,this.h/2,0,this.w/2,this.h/2,Math.max(this.w,this.h)*.7);bg.addColorStop(0,this.theme.bg);bg.addColorStop(1,this.theme.bgEdge);ctx.fillStyle=bg;ctx.fillRect(0,0,this.w,this.h)
const px=[.1,.3,.6];for(const s of this.st){const sx=(s.x+this.ox*px[s.layer])*this.z+this.w/2,sy=(s.y+this.oy*px[s.layer])*this.z+this.h/2;if(sx<-5||sx>this.w+5||sy<-5||sy>this.h+5)continue;ctx.beginPath();ctx.arc(sx,sy,s.size*this.z,0,Math.PI*2);ctx.fillStyle=`${this.theme.star}${s.twinkle?s.alpha*(.5+.5*Math.sin(tm*2+s.x*.01)):s.alpha})`;ctx.fill()}
for(const c of this.sim.clusters.values()){const[sx,sy]=this.w2s(c.centerX,c.centerY);const r=c.radius*this.z;if(sx+r<0||sx-r>this.w)continue;const isF=this.ft===null||this.ft===c.turnId;ctx.beginPath();ctx.arc(sx,sy,r,0,Math.PI*2);ctx.strokeStyle=this.theme.clusterLine(c.hue,isF?.08:.02);ctx.lineWidth=1;ctx.setLineDash([5,5]);ctx.stroke();ctx.setLineDash([]);if(this.z>.5&&c.turnId>=0){ctx.font=`${10*this.z}px monospace`;ctx.textAlign='center';ctx.fillStyle=this.theme.clusterLabel(c.hue,isF?.35:.08);ctx.fillText(`T${c.turnId+1}`,sx,sy-r-8)}}
// ─── 地形层：地图感的核心 ───

// 1. 地面线（工具层的视觉基底，像地图的海平面）
if (this.sim.nodes.size > 0) {
  const toolNodes = Array.from(this.sim.nodes.values()).filter(n => n.kind === 'tool')
  if (toolNodes.length > 0) {
    const maxY = Math.max(...toolNodes.map(n => n.y + n.radius))
    const [gx1] = this.w2s(-GAP, maxY)
    const [gx2] = this.w2s((this.sim.nodes.size) * GAP, maxY)
    const [, gy] = this.w2s(0, maxY + 10)
    ctx.beginPath()
    ctx.moveTo(Math.max(0, gx1), gy)
    ctx.lineTo(Math.min(this.w, gx2), gy)
    ctx.strokeStyle = 'hsla(210, 25%, 25%, 0.15)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
}

// 2. 回合领地（每个回合的微妙背景色块，像地图的行政区域）
for (const c of this.sim.clusters.values()) {
  if (c.turnId < 0) continue
  const [sx] = this.w2s(c.centerX, 0)
  const w = GAP * this.z * 0.7
  const topY = this.h * 0.15
  const botY = this.h * 0.85
  const isF = this.ft === null || this.ft === c.turnId
  const hue = c.hue
  // 微妙的领地填充
  const regionAlpha = isF ? 0.015 : 0.005
  const grad = ctx.createLinearGradient(sx, topY, sx, botY)
  grad.addColorStop(0, this.theme.region(hue, regionAlpha))
  grad.addColorStop(1, this.theme.region(hue, regionAlpha * 0.5))
  ctx.fillStyle = grad
  ctx.fillRect(sx - w / 2, topY, w, botY - topY)
  // 领地边界（左右各一条极淡的竖线）
  if (isF && this.z > 0.4) {
    ctx.strokeStyle = this.theme.clusterLine(hue, this.theme.dark ? 0.03 : 0.06)
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(sx - w/2, topY); ctx.lineTo(sx - w/2, botY); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(sx + w/2, topY); ctx.lineTo(sx + w/2, botY); ctx.stroke()
  }
}

// 3. 等高线（回合间的分隔，暗示推理'深度'的变化）
if (this.sim.clusters.size > 1) {
  const sortedClusters = Array.from(this.sim.clusters.values())
    .filter(c => c.turnId >= 0)
    .sort((a, b) => a.turnId - b.turnId)
  for (let i = 1; i < sortedClusters.length; i++) {
    const prev = sortedClusters[i-1]
    const curr = sortedClusters[i]
    const midX = (prev.centerX + curr.centerX) / 2
    const [sx] = this.w2s(midX, 0)
    // 等高线：工具数差异越大，线越明显（推理深度的跳跃）
    const depthDiff = Math.abs(curr.toolCount - prev.toolCount)
    if (depthDiff > 0) {
      const alpha = Math.min(0.2, depthDiff * 0.05)
      ctx.strokeStyle = `hsla(210, 30%, 50%, ${alpha})`
      ctx.lineWidth = 1
      ctx.setLineDash([2, 6])
      ctx.beginPath()
      ctx.moveTo(sx, this.h * 0.12)
      ctx.lineTo(sx, this.h * 0.88)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
}

// 4. 地标增强：用户节点更大更亮（像地图上的首都）
for (const n of this.sim.nodes.values()) {
  if (n.kind === 'user') {
    n.radius = Math.max(n.radius, 36) // 用户节点最小 36（比 assistant 的 28 大）
  }
}

for(const e of this.sim.edges){const a=this.sim.nodes.get(e.fromId),b=this.sim.nodes.get(e.toId);if(!a||!b)continue;const isF=this.ft===null||a.turnId===this.ft||b.turnId===this.ft
    const eBoost=this.hi?(e.fromId===this.hi||e.toId===this.hi)?3:0.1:1
    if(!isF&&this.hi===null)continue;const[x1,y1]=this.w2s(a.x,a.y);const[x2,y2]=this.w2s(b.x,b.y);ctx.beginPath();ctx.moveTo(x1,y1);if(e.type==='grid'){ctx.lineTo(x2,y2);ctx.strokeStyle=this.theme.dark?`hsla(${a.hue},40%,55%,${Math.min(.9,.25*eBoost)})`:`hsla(${a.hue},40%,35%,${Math.min(.9,.35*eBoost)})`;ctx.lineWidth=1.5}else{const mx=(x1+x2)/2,my=(y1+y2)/2,dx=x2-x1,dy=y2-y1,l=Math.sqrt(dx*dx+dy*dy)||1;ctx.quadraticCurveTo(mx-dy/l*l*.1,my+dx/l*l*.1,x2,y2);if(e.type==='cross-turn'){drawConveyorBelt(ctx,x1,y1,x2,y2,4,this.theme.dark,now,Math.min(.5,.35*eBoost))}else{ctx.strokeStyle=this.theme.dark?'hsla(200,55%,55%,'+Math.min(.9,.4*eBoost)+')':'hsla(200,45%,30%,'+Math.min(.9,.5*eBoost)+')';ctx.lineWidth=2.2}}ctx.stroke()}
for(const p of this.pt){const e=this.sim.edges.find(ed=>ed.id===p.edgeId);if(!e||e.type==='grid')continue;const a=this.sim.nodes.get(e.fromId),b=this.sim.nodes.get(e.toId);if(!a||!b)continue;if(this.ft!==null&&a.turnId!==this.ft)continue;p.t=(p.t+.005)%1;const[x1,y1]=this.w2s(a.x,a.y);const[x2,y2]=this.w2s(b.x,b.y);const hpx=x1+(x2-x1)*p.t,hpy=y1+(y2-y1)*p.t;ctx.save();ctx.translate(hpx,hpy);ctx.rotate(p.t*Math.PI);ctx.beginPath();for(let hi=0;hi<6;hi++){const ha=hi/6*Math.PI*2;if(hi===0)ctx.moveTo(Math.cos(ha)*3.5,Math.sin(ha)*3.5);else ctx.lineTo(Math.cos(ha)*3.5,Math.sin(ha)*3.5)}ctx.closePath();ctx.fillStyle=this.theme.particle;ctx.globalAlpha=.85;ctx.fill();ctx.strokeStyle=this.theme.dark?'rgba(255,255,255,.3)':'rgba(0,0,0,.2)';ctx.lineWidth=.5;ctx.stroke();ctx.restore();ctx.globalAlpha=1}
const fs=Math.max(9,11*this.z);ctx.textAlign='center';ctx.textBaseline='middle'
for(const n of this.sim.nodes.values()){const[sx,sy]=this.w2s(n.x,n.y);const r=n.radius*this.z;if(r<2||sx<-r*3||sx>this.w+r*3||sy<-r*3||sy>this.h+r*3)continue;const isF=this.ft===null||n.turnId===this.ft;
    let al=isF?1:.12;
    if(this.hi){const isN=this.hi===n.id||this.hoverNeighbors.has(n.id);al=isN?1:0.08}const isH=this.hi===n.id;const isS=this.si===n.id;const ag=now-n.birthTime;const bi=Math.min(1,ag/800);const ea=1-(1-bi)**3;const er=r*ea;if(er<.5)continue;const{hue}=n;const sa=n.isError?90:70;const li=n.isError?40:n.kind==='core'?55:50;ctx.globalAlpha=al
const gr=er*(isH?2.0:1.2);const g=ctx.createRadialGradient(sx,sy,er*.3,sx,sy,gr);g.addColorStop(0,this.theme.glow(hue,sa,(isH?.25:.1)*al));g.addColorStop(1,'transparent');ctx.beginPath();ctx.arc(sx,sy,gr,0,Math.PI*2);ctx.fillStyle=g;ctx.fill()
if(bi<1&&isF){const ab=bi;for(let ap=0;ap<4;ap++){const aA=ap/4*Math.PI*2+bi*2;const aD=er*(1-ab)*2.5;const aX=sx+Math.cos(aA)*aD,aY=sy+Math.sin(aA)*aD;const aR=Math.max(2,er*.15);ctx.beginPath();ctx.arc(aX,aY,aR,0,Math.PI*2);ctx.fillStyle=this.theme.glow(hue,70,.6*(1-ab)*al);ctx.fill()}if(ab>.85){ctx.beginPath();ctx.arc(sx,sy,er*1.2,0,Math.PI*2);ctx.strokeStyle=this.theme.glow(hue,90,(ab-.85)/.15*.5*al);ctx.lineWidth=2;ctx.stroke()}}
// Anatomy: 工具节点 = 机械零件（非纯色方块）
if(n.kind==='tool'){
  const { icon } = getToolIcon(n.toolName ?? n.content)
  drawMachinePart(ctx, icon, sx, sy, er * 0.65, hue, al, now)
  // 状态指示灯
  const lightStatus = n.isRunning ? 'running' : n.isError ? 'error' : n.durationMs != null ? 'done' : 'idle'
  drawStatusLight(ctx, sx + er * 0.6, sy - er * 0.6, lightStatus, now)
}else if(false){const hf=er*.85;const fg=ctx.createLinearGradient(sx-hf,sy-hf,sx+hf,sy+hf);fg.addColorStop(0,`hsla(${hue},${sa}%,${li+this.theme.bodyBoost}%,.9)`);fg.addColorStop(1,`hsla(${hue},${sa}%,${li+this.theme.bodyCut}%,.7)`);ctx.fillStyle=fg;ctx.beginPath();ctx.roundRect(sx-hf,sy-hf,hf*2,hf*2,2);ctx.fill();ctx.strokeStyle=this.theme.dark?`hsla(${hue},${sa}%,${li+20}%,.4)`:`hsla(${hue},${sa}%,${li-10}%,.5)`;ctx.lineWidth=1;ctx.stroke()}else{const bg2=ctx.createRadialGradient(sx-er*.3,sy-er*.3,0,sx,sy,er);bg2.addColorStop(0,`hsla(${hue},${sa}%,${li+this.theme.bodyBoost}%,.9)`);bg2.addColorStop(1,`hsla(${hue},${sa}%,${li+this.theme.bodyCut}%,.7)`);ctx.beginPath();ctx.arc(sx,sy,er,0,Math.PI*2);ctx.fillStyle=bg2;ctx.fill()}
// Running gear (Anatomy metaphor)
if(n.isRunning&&isF){const gr2=er*1.7;const teeth=8;const rot=now/250;ctx.save();ctx.translate(sx,sy);ctx.rotate(rot);for(let t2=0;t2<teeth;t2++){const ta=t2/teeth*Math.PI*2;ctx.beginPath();ctx.moveTo(Math.cos(ta)*er*1.15,Math.sin(ta)*er*1.15);ctx.lineTo(Math.cos(ta)*gr2,Math.sin(ta)*gr2);ctx.strokeStyle=this.theme.glow(hue,80,.5*al);ctx.lineWidth=2;ctx.stroke()}ctx.beginPath();ctx.arc(0,0,er*1.15,0,Math.PI*2);ctx.strokeStyle=this.theme.glow(hue,80,.3*al);ctx.lineWidth=1.5;ctx.stroke();ctx.restore()}if(isS){ctx.beginPath();ctx.arc(sx,sy,er+3,0,Math.PI*2);ctx.strokeStyle=this.theme.selectRing(hue);ctx.lineWidth=2;ctx.stroke()}
// 用户拖拽过的节点：虚线圆环标记（地图上的"用户标记"）
if(n.dragged){ctx.beginPath();ctx.arc(sx,sy,er+5,0,Math.PI*2);ctx.strokeStyle=this.theme.dark?'hsla(45,60%,60%,.3)':'hsla(45,60%,40%,.4)';ctx.lineWidth=1;ctx.setLineDash([4,3]);ctx.stroke();ctx.setLineDash([])}
if(n.isError){ctx.fillStyle=`hsla(0,90%,60%,${.9*al})`;ctx.font=`bold ${Math.max(9,er*.5)}px sans-serif`;ctx.fillText('✗',sx+er*.5,sy-er*.5)}
if(this.z>.35&&isF){if(n.kind==='tool'){ctx.font=`bold ${Math.max(7,fs*.7)}px monospace`;ctx.fillStyle=this.theme.dark?`hsla(${hue},40%,92%,.95)`:`hsla(${hue},50%,15%,.95)`;const tn=n.toolName??n.content;ctx.fillText(tn.length>12?tn.slice(0,11)+'…':tn,sx,sy)}else{const mc=Math.floor(er*2/(fs*.55));let t=n.content;if(t.length>mc)t=t.slice(0,mc)+'…';if(t){ctx.font=`${fs}px -apple-system,sans-serif`;ctx.fillStyle=this.theme.dark?`hsla(${hue},10%,95%,.95)`:`hsla(${hue},30%,10%,.95)`;ctx.fillText(t,sx,sy+er*.4)}}}
if(n.durationMs!=null&&n.durationMs>500&&this.z>.5&&isF){ctx.font=`${Math.max(7,fs*.7)}px monospace`;ctx.fillStyle=this.theme.dark?'rgba(200,200,200,.3)':'rgba(80,80,80,.4)';ctx.fillText(n.durationMs<1000?`${n.durationMs}ms`:`${(n.durationMs/1000).toFixed(1)}s`,sx,sy-er-8)}
ctx.globalAlpha=1}}}
