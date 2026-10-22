/**
 * 极简 Markdown 渲染器（零依赖、防 XSS）。
 * 支持子集：标题、段落、粗体/斜体/行内代码、链接（仅 http(s)）、
 * 引用、无序/有序列表、分隔线、围栏代码块（带复制按钮）。
 * 所有原始 HTML 先转义，再生成受控标签。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
    // 斜体
    if (src.startsWith('*', i) && !src.startsWith('**', i)) {
      const end = src.indexOf('*', i + 1)
      if (end !== -1 && end > i + 1) {
        out += `<em>${src.slice(i + 1, end)}</em>`
        i = end + 1
        continue
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
    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph(para)
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ul class="md-list">${items.join('')}</ul>`)
      continue
    }
    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph(para)
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ol class="md-list md-ol">${items.join('')}</ol>`)
      continue
    }

    para.push(line)
    i++
  }
  flushParagraph(para)
  return out.join('\n')
}
