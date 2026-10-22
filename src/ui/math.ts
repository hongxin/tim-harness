/**
 * LaTeX 公式渲染（双层策略）：
 * 1. 零依赖 Unicode 美化（prettifyTex）——离线可用、永不失败的兜底
 * 2. KaTeX 精确渲染 —— 检测到公式时从 CDN 懒加载（8s 超时），失败静默保持兜底
 * markdown.ts 产出 <span|div data-tex="...">prettified</span|div>，enhanceMath 升级。
 */

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ',
  psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

const SYMBOLS: Record<string, string> = {
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗', star: '⋆',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', equiv: '≡', approx: '≈', sim: '∼', propto: '∝',
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', nexists: '∄', emptyset: '∅', varnothing: '∅',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', wedge: '∧', vee: '∨', neg: '¬', land: '∧', lor: '∨',
  oplus: '⊕', ominus: '⊖', otimes: '⊗', odot: '⊙',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  mapsto: '↦', implies: '⟹', iff: '⟺', uparrow: '↑', downarrow: '↓',
  degree: '°', circ: '∘', bullet: '•', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  perp: '⊥', parallel: '∥', angle: '∠', triangle: '△', square: '□',
  hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  mathbbR: 'ℝ', mathbbC: 'ℂ', mathbbN: 'ℕ', mathbbZ: 'ℤ', mathbbQ: 'ℚ',
}

const SUPERS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
}

const SUBS: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', n: 'ₙ', i: 'ᵢ', j: 'ⱼ',
}

function readGroup(src: string, i: number): { body: string; next: number } | null {
  // 读取 {...} 组或单字符
  if (src[i] === '{') {
    let depth = 1
    let j = i + 1
    while (j < src.length && depth > 0) {
      if (src[j] === '{' && src[j - 1] !== '\\') depth++
      else if (src[j] === '}' && src[j - 1] !== '\\') depth--
      if (depth === 0) break
      j++
    }
    if (depth !== 0) return null
    return { body: src.slice(i + 1, j), next: j + 1 }
  }
  if (i < src.length) return { body: src[i], next: i + 1 }
  return null
}

function toScript(text: string, table: Record<string, string>): string {
  const mapped = [...text].map((c) => table[c])
  return mapped.every(Boolean) ? mapped.join('') : text
}

/** Unicode 美化 LaTeX（兜底渲染；支持子/上标、希腊字母、常用算符、frac/sqrt） */
export function prettifyTex(tex: string): string {
  let s = tex.trim()

  // \frac{a}{b} → (a)/(b)
  for (let guard = 0; guard < 20; guard++) {
    const m = /\\(?:d|t)?frac\{/.exec(s)
    if (!m) break
    const a = readGroup(s, m.index + m[0].length - 1)
    if (!a) break
    const rest = s.slice(a.next)
    const bm = /^\s*\{/.exec(rest)
    const b = bm ? readGroup(s, a.next + bm[0].length - 1) : null
    if (!b) break
    const va = a.body.length > 1 ? `(${prettifyTex(a.body)})` : prettifyTex(a.body)
    const vb = b.body.length > 1 ? `(${prettifyTex(b.body)})` : prettifyTex(b.body)
    s = s.slice(0, m.index) + va + '/' + vb + s.slice(b.next)
  }
  // \sqrt{x} → √(x)
  for (let guard = 0; guard < 10; guard++) {
    const m = /\\sqrt\{/.exec(s)
    if (!m) break
    const a = readGroup(s, m.index + m[0].length - 1)
    if (!a) break
    s = s.slice(0, m.index) + '√(' + prettifyTex(a.body) + ')' + s.slice(a.next)
  }
  // \overline{x} / \hat{x} / \bar{x} / \vec{x}
  s = s.replace(/\\(?:overline|bar)\{([^{}]*)\}/g, '$1\u0304')
  s = s.replace(/\\hat\{([^{}]*)\}/g, '$1\u0302')
  s = s.replace(/\\vec\{([^{}]*)\}/g, '$1\u20D7')
  // \text{..} / \mathrm{..} / \mathbf{..} / \mathit{..}
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, '$1')
  // \mathbb{R} 等
  s = s.replace(/\\mathbb\{([RCNZQ])\}/g, (_m, c: string) => SYMBOLS[`mathbb${c}`] ?? c)

  // 命令替换：希腊字母与算符（\omega 之类，长名优先）
  const cmd = /\\([a-zA-Z]+)(?![a-zA-Z])/g
  s = s.replace(cmd, (whole, name: string) => GREEK[name] ?? SYMBOLS[name] ?? whole)

  // 上/下标
  for (let guard = 0; guard < 30; guard++) {
    const m = /([_^])/.exec(s)
    if (!m) break
    const g = readGroup(s, m.index + 1)
    if (!g) break
    const table = m[1] === '^' ? SUPERS : SUBS
    s = s.slice(0, m.index) + toScript(prettifyTex(g.body), table) + s.slice(g.next)
  }

  // 间隔与修饰命令清理
  s = s.replace(/\\left|\\right|\\!|\\,|\\;|\\:|\\quad|\\qquad|\\displaystyle|\\limits/g, ' ')
  s = s.replace(/~/g, ' ')
  // 剩余花括号
  s = s.replace(/[{}]/g, '')
  return s.replace(/\s{2,}/g, ' ').trim()
}

/* ---------------- KaTeX 懒加载增强 ---------------- */

let katexPromise: Promise<any | null> | null = null

function loadKatex(): Promise<any | null> {
  if (typeof document === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const done = (k: any | null) => {
      if (!settled) {
        settled = true
        resolve(k)
      }
    }
    const timer = setTimeout(() => done(null), 8_000)
    const finish = () => {
      clearTimeout(timer)
      done((window as any).katex ?? null)
    }
    if ((window as any).katex) return finish()
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css'
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js'
    script.onload = finish
    script.onerror = () => {
      clearTimeout(timer)
      done(null)
    }
    css.onerror = () => {}
    document.head.appendChild(css)
    document.head.appendChild(script)
  })
}

export function ensureKatex(): Promise<any | null> {
  if (!katexPromise) katexPromise = loadKatex()
  return katexPromise
}

/** 将节点内所有 [data-tex] 升级为 KaTeX 精确渲染（失败保持 Unicode 兜底） */
export async function enhanceMath(root: HTMLElement): Promise<void> {
  const nodes = root.querySelectorAll('[data-tex]')
  if (nodes.length === 0) return
  const katex = await ensureKatex()
  if (!katex) return
  nodes.forEach((n) => {
    const tex = n.getAttribute('data-tex') ?? ''
    try {
      katex.render(tex, n, {
        throwOnError: false,
        displayMode: n.classList.contains('math-block'),
        output: 'html',
      })
    } catch {
      /* 保持兜底 */
    }
  })
}
