/** 设置对话框：Provider 管理、CORS 代理、搜索服务、数据管理 */
import { useEffect, useState } from 'react'
import type { AppSettings, ProviderSetting } from '../../core/types'
import type { HarnessRuntime } from '../../core/runtime'
import { downloadText } from '../fileops'
import { genId } from '../../core/util/path'

export function SettingsDialog({ runtime, onClose }: { runtime: HarnessRuntime; onClose: () => void }) {
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [activeId, setActiveId] = useState('')
  const [tab, setTab] = useState<'model' | 'web' | 'data'>('model')
  const [importOpen, setImportOpen] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const snap = runtime.getSnapshot()
    if (snap.settings) {
      setDraft(structuredClone(snap.settings))
      setActiveId(snap.settings.activeProviderId)
    }
  }, [runtime])

  if (!draft) return null
  const provider = draft.providers.find((p) => p.id === activeId) ?? draft.providers[0]

  const update = (fn: (d: AppSettings) => void) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = structuredClone(prev)
      fn(next)
      return next
    })
  }

  const addProvider = () => {
    const id = genId('prov_')
    update((d) => {
      d.providers.push({ id, name: '自定义服务', baseURL: '', apiKey: '', model: '' })
    })
    setActiveId(id)
  }

  const removeProvider = (id: string) => {
    if (draft.providers.length <= 1) return
    update((d) => {
      d.providers = d.providers.filter((p) => p.id !== id)
      if (d.activeProviderId === id) d.activeProviderId = d.providers[0].id
    })
    if (activeId === id) setActiveId(draft.providers.find((p) => p.id !== id)!.id)
  }

  const save = async () => {
    await runtime.saveSettings({ ...draft, activeProviderId: activeId })
    onClose()
  }

  const clearAllData = () => {
    if (!confirm('清空全部本地数据（会话、设置、密钥、虚拟工作区文件）？刷新后将从零开始。')) return
    indexedDB.deleteDatabase('tim-harness')
    localStorage.clear()
    location.reload()
  }

  const exportSessionJson = async () => {
    const json = await runtime.exportSession()
    downloadText(`tim-session-${Date.now()}.json`, json, 'application/json')
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">设置</span>
          <button type="button" className="btn-icon" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-tabs">
          <button type="button" className={`rp-tab ${tab === 'model' ? 'on' : ''}`} onClick={() => setTab('model')}>
            模型服务
          </button>
          <button type="button" className={`rp-tab ${tab === 'web' ? 'on' : ''}`} onClick={() => setTab('web')}>
            网络
          </button>
          <button type="button" className={`rp-tab ${tab === 'data' ? 'on' : ''}`} onClick={() => setTab('data')}>
            数据
          </button>
        </div>

        {tab === 'model' && (
          <div className="settings-body">
            <div className="prov-list">
              {draft.providers.map((p: ProviderSetting) => (
                <button
                  key={p.id}
                  type="button"
                  className={`prov-item ${p.id === activeId ? 'on' : ''}`}
                  onClick={() => setActiveId(p.id)}
                >
                  <span className={`prov-radio ${p.id === activeId ? 'on' : ''}`} />
                  <span className="prov-name">{p.name}</span>
                  <span className="prov-model">{p.model || '未设置模型'}</span>
                  {p.apiKey ? <span className="prov-key-ok">密钥✓</span> : /localhost|127\./.test(p.baseURL) ? <span className="prov-key-local">本地</span> : <span className="prov-key-none">缺密钥</span>}
                </button>
              ))}
            </div>
            <button type="button" className="btn-ghost btn-sm" onClick={addProvider}>
              + 添加 Provider
            </button>

            {provider && (
              <div className="prov-form">
                <div className="form-row">
                  <label>名称</label>
                  <input value={provider.name} onChange={(e) => update((d) => { d.providers.find((p) => p.id === provider.id)!.name = e.target.value })} />
                </div>
                <div className="form-row">
                  <label>Base URL</label>
                  <input value={provider.baseURL} placeholder="https://api.deepseek.com/v1" onChange={(e) => update((d) => { d.providers.find((p) => p.id === provider.id)!.baseURL = e.target.value.trim() })} />
                </div>
                <div className="form-row">
                  <label>API Key</label>
                  <input type="password" value={provider.apiKey} placeholder="仅存在本机浏览器 IndexedDB" autoComplete="off" onChange={(e) => update((d) => { d.providers.find((p) => p.id === provider.id)!.apiKey = e.target.value.trim() })} />
                </div>
                <div className="form-row">
                  <label>模型</label>
                  <input value={provider.model} placeholder="deepseek-flash" onChange={(e) => update((d) => { d.providers.find((p) => p.id === provider.id)!.model = e.target.value.trim() })} />
                </div>
                <div className="form-row">
                  <label>Temperature</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={provider.temperature ?? 0}
                    onChange={(e) => update((d) => { d.providers.find((p) => p.id === provider.id)!.temperature = Number(e.target.value) })}
                  />
                </div>
                <div className="form-actions">
                  <span className="form-hint">任何 OpenAI 兼容端点均可（含 Ollama / vLLM / 智谱等）。</span>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => removeProvider(provider.id)} disabled={draft.providers.length <= 1}>
                    删除此项
                  </button>
                </div>
              </div>
            )}

            <div className="form-block" style={{ marginTop: 4 }}>
              <div className="form-block-title">子代理模型路由（省 token）</div>
              <p className="form-desc">
                spawn_agent 派发的子代理可使用更便宜的模型（如非思考型），主会话保持强模型。
                质量/成本由你掌控。
              </p>
              <select
                className="subagent-select"
                value={draft.subagentProviderId ?? ''}
                onChange={(e) => update((d) => { d.subagentProviderId = e.target.value || undefined })}
              >
                <option value="">跟随主模型</option>
                {draft.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model || '未设置模型'}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {tab === 'web' && (
          <div className="settings-body">
            <div className="form-block">
              <div className="form-block-title">web_fetch CORS 代理（可选）</div>
              <p className="form-desc">
                浏览器直连多数网站会因 CORS 失败。可在此配置代理模板（须含 <code>{'{url}'}</code> 占位符，会被替换为编码后的目标地址）。
                例如 <code>https://corsproxy.io/?{'{url}'}</code>。留空 = 仅直连 CORS 友好的站点。
              </p>
              <input
                value={draft.proxyTemplate}
                placeholder="https://your-proxy.example/?{url}"
                onChange={(e) => update((d) => { d.proxyTemplate = e.target.value.trim() })}
              />
            </div>
            <div className="form-block">
              <div className="form-block-title">web_search 搜索服务（可选）</div>
              <div className="seg">
                {(['none', 'tavily', 'brave'] as const).map((v) => (
                  <button key={v} type="button" className={`seg-btn ${(v === 'none' && !draft.webSearch) || draft.webSearch?.provider === v ? 'on' : ''}`} onClick={() => update((d) => { d.webSearch = v === 'none' ? null : { provider: v, apiKey: d.webSearch?.apiKey ?? '' } })}>
                    {v === 'none' ? '不启用' : v === 'tavily' ? 'Tavily' : 'Brave'}
                  </button>
                ))}
              </div>
              {draft.webSearch && (
                <div className="form-row" style={{ marginTop: 10 }}>
                  <label>API Key</label>
                  <input type="password" value={draft.webSearch.apiKey} onChange={(e) => update((d) => { if (d.webSearch) d.webSearch.apiKey = e.target.value.trim() })} />
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'data' && (
          <div className="settings-body">
            <div className="form-block">
              <div className="form-block-title">Token 成本档位</div>
              <p className="form-desc">
                一组联动旋钮：上下文预算（折叠/压缩时机）、工具输出上限（read_file / grep / web_fetch）、
                保持全文的近期工具结果条数。<b>省流</b>最省钱（预算 48k 字符、read 32k、更早压缩），
                <b>完整</b>最宽裕（260k/200k，适合大文件深分析）。随时切换，即时生效。
              </p>
              <div className="seg">
                {(['eco', 'standard', 'full'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`seg-btn ${(draft.costTier ?? 'standard') === v ? 'on' : ''}`}
                    onClick={() => update((d) => { d.costTier = v })}
                  >
                    {v === 'eco' ? '省流' : v === 'standard' ? '标准' : '完整'}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-block">
              <div className="form-block-title">上下文压缩</div>
              <p className="form-desc">
                水位超 80% 时自动压缩：用一次 LLM 调用把早期消息总结为摘要，之后每轮只发"摘要 + 近期尾部"，
                token 消耗从全量降为尾部。会话完整记录不受影响。也可随时用顶栏 ⚡ 手动压缩。
              </p>
              <div className="seg">
                {(['on', 'off'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`seg-btn ${(draft.autoCompact ?? 'on') === v ? 'on' : ''}`}
                    onClick={() => update((d) => { d.autoCompact = v })}
                  >
                    {v === 'on' ? '自动压缩（默认）' : '仅手动'}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-block">
              <div className="form-block-title">工具审批</div>
              <p className="form-desc">
                开启后，智能体的写操作（write_file / edit_file）执行前会弹出审批卡片，经你允许才落盘；
                同类操作允许一次后本会话内不再询问。默认关闭以保持流畅。
              </p>
              <div className="seg">
                {(['off', 'on'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`seg-btn ${(draft.toolApproval ?? 'off') === v ? 'on' : ''}`}
                    onClick={() => update((d) => { d.toolApproval = v })}
                  >
                    {v === 'off' ? '关闭（默认）' : '开启审批'}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-block">
              <div className="form-block-title">会话数据</div>
              <p className="form-desc">所有会话、设置、密钥与工作区文件仅保存在本机浏览器（IndexedDB / OPFS），不经过任何服务器。</p>
              <div className="form-actions">
                <button type="button" className="btn-ghost btn-sm" onClick={() => void exportSessionJson()}>
                  导出会话 JSON
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => downloadText(`tim-session-${Date.now()}.md`, runtime.exportSessionMarkdown(), 'text/markdown')}
                >
                  导出会话 Markdown
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setImportOpen(true)}>
                  导入会话 JSON
                </button>
              </div>
              {importOpen && (
                <textarea
                  className="import-area"
                  placeholder="粘贴 tim-harness 会话导出的 JSON…"
                  onChange={async (e) => {
                    const v = e.target.value.trim()
                    if (v.startsWith('{')) {
                      const ok = await runtime.importSession(v)
                      setNotice(ok ? '已导入并切换到该会话。' : '导入失败：JSON 不合法。')
                    }
                  }}
                />
              )}
            </div>
            <div className="form-block">
              <div className="form-block-title danger">危险区</div>
              <button type="button" className="btn-danger" onClick={clearAllData}>
                清空全部本地数据
              </button>
            </div>
            <div className="about-block">
              <b>Tim Harness v0.1</b>
              <p>纯浏览器 harness：core 平台无关（六边形架构），浏览器只是第一个适配目标。架构文档见仓库 docs/ 目录。</p>
            </div>
          </div>
        )}

        {notice && <div className="settings-notice">{notice}</div>}

        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
