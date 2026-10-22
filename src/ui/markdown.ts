/**
 * 极简 Markdown 渲染器（零依赖、防 XSS）。
 * 支持子集：标题、段落、粗体/斜体/删除线/行内代码、链接（仅 http(s)）、
 * 引用、无序/有序列表（一层嵌套）、任务列表（- [ ] / - [x]）、
 * GFM 管道表格（含对齐）、分隔线、围栏代码块（带复制按钮）、
 * LaTeX 数学（$...$ / $$...$$ / \(...\) / \[...\]，Unicode 兜底 + KaTeX 增强）。
 * 所有原始 HTML 先转义，再生成受控标签；外链图片渲染为链接（不自动加载外部资源） */
import { prettifyTex } from './math'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 行内数学是否"像公式"（避免货币误伤） */
function looksMathy(texRaw: string): boolean {
  if (texRaw.length === 0 || texRaw.length > 300) return false
  if (/^\d+([.,]\d+)?$/.test(texRaw.trim())) return false // 纯数字=价格
  return /[\\^_{}=<>+\-*/]|\\|[a-zA-Z]/.test(texRaw)
}

function mathSpan(escapedTex: string, display: boolean): string {
  const pretty = prettifyTex(unescapeHtml(escapedTex))
  const open = display ? 'div' : 'span'
  const cls = display ? 'math-block' : 'math-inline'
  return `<${open} class="${cls}" data-tex="${escapedTex}">${escapeHtml(pretty)}</${open}>`
}

function renderInline(text: string): string {
  let out = ''
  let i = 0
  const src = escapeHtml(text)
  while (i < src.length) {
    // 行内代码
    if (src.startsWith('`', i)) {
      const end = src.indexOf('`', i + 1)
      if (end !== -1) {
        out += `<code class="md-code">${src.slice(i + 1, end)}</code>`
        i = end + 1
        continue
      }
    }
    // 粗体
    if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2)
      if (end !== -1) {
        out += `<strong>${renderInline(src.slice(i + 2, end))}</strong>`
        i = end + 2
        continue
      }
    }
    // 删除线
    if (src.startsWith('~~', i)) {
      const end = src.indexOf('~~', i + 2)
      if (end !== -1) {
        out += `<del>${src.slice(i + 2, end)}</del>`
        i = end + 2
        continue
      }
    }
    // 斜体
    if (src.startsWith('*', i) && !src.startsWith('**', i)) {
      const end = src.indexOf('*', i + 1)
      if (end !== -1 && end > i + 1) {
        out += `<em>${src.slice(i + 1, end)}</em>`
        i = end + 1
        continue
      }
    }
    // 图片 ![alt](url) → 渲染为链接（不自动加载外部图，隐私与排版友好）
    if (src.startsWith('![', i)) {
      const closeText = src.indexOf(']', i + 2)
      if (closeText !== -1 && src.startsWith('(', closeText + 1)) {
        const closeParen = src.indexOf(')', closeText + 2)
        if (closeParen !== -1) {
          const label = src.slice(i + 2, closeText)
          const url = src.slice(closeText + 2, closeParen)
          if (/^https?:\/\//i.test(url)) {
            out += `<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-imglink">🖼 ${label || url}</a>`
            i = closeParen + 1
            continue
          }
        }
      }
    }
    // 链接 [text](url)
    if (src.startsWith('[', i)) {
      const closeText = src.indexOf(']', i + 1)
      if (closeText !== -1 && src.startsWith('(', closeText + 1)) {
        const closeParen = src.indexOf(')', closeText + 2)
        if (closeParen !== -1) {
          const label = src.slice(i + 1, closeText)
          const url = src.slice(closeText + 2, closeParen)
          if (/^https?:\/\//i.test(url)) {
            out += `<a href="${url}" target="_blank" rel="noopener noreferrer">${label || url}</a>`
            i = closeParen + 1
            continue
          }
        }
      }
    }
    // 行内数学 \( ... \)
    if (src.startsWith('\\(', i)) {
      const end = src.indexOf('\\)', i + 2)
      if (end !== -1) {
        const inner = src.slice(i + 2, end)
        out += mathSpan(inner, false)
        i = end + 2
        continue
      }
    }
    // 行内数学 $ ... $（货币启发式排除）
    if (src[i] === '$' && i + 1 < src.length && src[i + 1] !== ' ' && src[i + 1] !== '$') {
      let j = i + 1
      while (j < src.length && src[j] !== '$') j++
      if (j > i + 1 && j < src.length && src[j - 1] !== ' ') {
        const inner = src.slice(i + 1, j)
        if (looksMathy(unescapeHtml(inner))) {
          out += mathSpan(inner, false)
          i = j + 1
          continue
        }
      }
    }
    // 裸链接
    const bare = /^https?:\/\/[^\s<>")\]]+/.exec(src.slice(i))
    if (bare && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      const url = bare[0]
      out += `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
      i += url.length
      continue
    }
    out += src[i]
    i++
  }
  return out
}

/* ---------------- 表格 ---------------- */

const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  // 先保护转义管道与行内代码中的管道，切分后还原
  const guard = ' \u0000PIPE\u0000 '
  const segments: string[] = []
  let inCode = false
  let cur = ''
  for (let j = 0; j < s.length; j++) {
    const ch = s[j]
    if (ch === '`') inCode = !inCode
    if (ch === '\\' && s[j + 1] === '|') {
      cur += guard
      j++
      continue
    }
    if (ch === '|' && !inCode) {
      segments.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  segments.push(cur)
  return segments.map((c) => c.trim().replaceAll(guard, '|'))
}

function sepAlignments(line: string): ('left' | 'center' | 'right')[] {
  return splitRow(line).map((cell) => {
    const t = cell.trim()
    const l = t.startsWith(':')
    const r = t.endsWith(':')
    if (l && r) return 'center'
    if (r) return 'right'
    return 'left'
  })
}

function renderTable(header: string, sep: string, bodyLines: string[]): string {
  const aligns = sepAlignments(sep)
  const th = splitRow(header)
    .map((c, i) => `<th class="md-th align-${aligns[i] ?? 'left'}">${renderInline(c)}</th>`)
    .join('')
  const rows = bodyLines
    .map((line) => {
      const cells = splitRow(line)
      const cols = Math.max(th ? splitRow(header).length : 0, cells.length)
      const tds: string[] = []
      for (let i = 0; i < cols; i++) {
        tds.push(`<td class="md-td align-${aligns[i] ?? 'left'}">${renderInline(cells[i] ?? '')}</td>`)
      }
      return `<tr>${tds.join('')}</tr>`
    })
    .join('')
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`
}

/* ---------------- 列表 ---------------- */

function renderListItem(text: string): string {
  const task = /^\[( |x|X)\]\s+(.*)$/.exec(text)
  if (task) {
    const checked = task[1].toLowerCase() === 'x'
    return `<span class="md-task ${checked ? 'done' : ''}"><span class="md-task-box">${checked ? '☑' : '☐'}</span>${renderInline(task[2])}</span>`
  }
  return renderInline(text)
}

/** 解析连续的列表行（支持一层嵌套：≥2 空格缩进） */
function renderListBlock(lines: string[], ordered: boolean): string {
  type Item = { text: string; children: string[] }
  const items: Item[] = []
  for (const raw of lines) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw)
    if (!m) {
      // 延续行并入最后一个条目
      if (items.length > 0) items[items.length - 1].text += ' ' + raw.trim()
      continue
    }
    const indent = m[1].length
    if (indent >= 2 && items.length > 0) items[items.length - 1].children.push(m[3])
    else items.push({ text: m[3], children: [] })
  }
  const tag = ordered ? 'ol' : 'ul'
  const html = items
    .map((it) => {
      const inner = it.children.length
        ? `<${tag} class="md-list md-nested">${it.children.map((c) => `<li>${renderListItem(c)}</li>`).join('')}</${tag}>`
        : ''
      return `<li>${renderListItem(it.text)}${inner}</li>`
    })
    .join('')
  return `<${tag} class="md-list${ordered ? ' md-ol' : ''}">${html}</${tag}>`
}

/* ---------------- 主渲染 ---------------- */

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0

  const flushParagraph = (buf: string[]) => {
    if (buf.length > 0) out.push(`<p>${renderInline(buf.join('\n'))}</p>`)
    buf.length = 0
  }

  const para: string[] = []
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // 块级数学 $$ ... $$（单行或多行）
    if (trimmed === '$$' || (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4)) {
      flushParagraph(para)
      let tex: string
      if (trimmed.length > 4) {
        tex = trimmed.slice(2, -2)
        i++
      } else {
        const buf: string[] = []
        i++
        while (i < lines.length && lines[i].trim() !== '$$') {
          buf.push(lines[i])
          i++
        }
        i++ // 跳过闭合 $$
        tex = buf.join('\n')
      }
      out.push(mathSpan(escapeHtml(tex), true))
      continue
    }
    // 块级数学 \[ ... \]
    if (trimmed === '\\[') {
      flushParagraph(para)
      const buf: string[] = []
      i++
      while (i < lines.length && lines[i].trim() !== '\\]') {
        buf.push(lines[i])
        i++
      }
      i++
      out.push(mathSpan(escapeHtml(buf.join('\n')), true))
      continue
    }

    // 围栏代码块
    const fence = /^```(\w*)\s*$/.exec(line.trim())
    if (fence) {
      flushParagraph(para)
      const lang = fence[1] || 'text'
      const code: string[] = []
      i++
      while (i < lines.length && lines[i].trim() !== '```') {
        code.push(lines[i])
        i++
      }
      i++ // 跳过闭合 ```
      const codeHtml = escapeHtml(code.join('\n'))
      out.push(
        `<div class="md-codeblock"><div class="md-codebar"><span>${escapeHtml(lang)}</span><button type="button" class="md-copy" data-copy>复制</button></div><pre><code>${codeHtml}</code></pre></div>`,
      )
      continue
    }

    // GFM 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushParagraph(para)
      const header = lines[i]
      const sep = lines[i + 1]
      i += 2
      const body: string[] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        body.push(lines[i])
        i++
      }
      out.push(renderTable(header, sep, body))
      continue
    }

    // 空行
    if (!line.trim()) {
      flushParagraph(para)
      i++
      continue
    }
    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph(para)
      const level = Math.min(heading[1].length + 1, 5) // h1→h2 缩一级，避免过大
      out.push(`<h${level} class="md-h">${renderInline(heading[2])}</h${level}>`)
      i++
      continue
    }
    // 分隔线
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph(para)
      out.push('<hr class="md-hr" />')
      i++
      continue
    }
    // 引用
    if (line.startsWith('> ') || line === '>') {
      flushParagraph(para)
      const quote: string[] = []
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        quote.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote class="md-quote">${renderInline(quote.join('\n'))}</blockquote>`)
      continue
    }
    // 列表（无序 / 有序，支持嵌套与任务项）
    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph(para)
      const block: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        block.push(lines[i])
        i++
      }
      out.push(renderListBlock(block, false))
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph(para)
      const block: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        block.push(lines[i])
        i++
      }
      out.push(renderListBlock(block, true))
      continue
    }

    para.push(line)
    i++
  }
  flushParagraph(para)
  return out.join('\n')
}
