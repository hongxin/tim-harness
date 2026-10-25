/** 设置对话框：语言 / Provider 管理 / CORS 代理 / 搜索服务 / 数据管理 */
import { useTranslation } from '../../i18n/useTranslation'
import { useEffect, useState } from 'react'
import type { AppSettings, ProviderSetting } from '../../core/types'
import type { HarnessRuntime } from '../../core/runtime'
import { downloadText } from '../fileops'
import { genId } from '../../core/util/path'

export function SettingsDialog({ runtime, onClose }: { runtime: HarnessRuntime; onClose: () => void }) {
  const { t, locale, setLocale } = useTranslation()
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
      d.providers.push({ id, name: locale === 'zh' ? '自定义服务' : 'Custom', baseURL: '', apiKey: '', model: '' })
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
    if (!confirm(t('settings.clearAllConfirm'))) return
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
          <span className="modal-title">{t('settings.title')}</span>
          {/* 语言切换（紧凑，在标题栏右侧） */}
          <div className="lang-switch">
            <button type="button" className={`seg-btn ${locale === 'en' ? 'on' : ''}`} onClick={() => setLocale('en')}>EN</button>
            <button type="button" className={`seg-btn ${locale === 'zh' ? 'on' : ''}`} onClick={() => setLocale('zh')}>中</button>
          </div>
          <button type="button" className="btn-icon" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-tabs">
          <button type="button" className={`rp-tab ${tab === 'model' ? 'on' : ''}`} onClick={() => setTab('model')}>
            {t('settings.modelService')}
          </button>
          <button type="button" className={`rp-tab ${tab === 'web' ? 'on' : ''}`} onClick={() => setTab('web')}>
            {t('settings.network')}
          </button>
          <button type="button" className={`rp-tab ${tab === 'data' ? 'on' : ''}`} onClick={() => setTab('data')}>
            {t('settings.tabData')}
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
                  <span className="prov-model">{p.model || t('settings.noModel')}</span>
                  {p.apiKey ? (
                    <span className="prov-key-ok">{t('settings.keyOk')}</span>
                  ) : /localhost|127\./.test(p.baseURL) ? (
                    <span className="prov-key-local">{t('settings.keyLocal')}</span>
                  ) : (
                    <span className="prov-key-none">{t('settings.keyNone')}</span>
                  )}
                </button>
              ))}
            </div>
            <button type="button" className="btn-ghost btn-sm" onClick={addProvider}>
              + {t('settings.addProvider')}
            </button>

            {provider && (
              <div className="prov-form">
                <div className="form-row">
                  <label>{t('settings.name')}</label>
                  <input value={provider.name} onChange={(e) => update((d) => { d.providers.find((p) => p.id === provider.id)!.name = e.target.value })} />
                </div>
                <div className="form-row">
                  <label>{t('settings.baseURL')}</label>
                  <input value={provider.baseURL} placeholder="https://api.deepseek.com/v1" onChange={(e) => update((d) => { d.providers.find((p) => p.id === provider.id)!.baseURL = e.target.value.trim() })} />
                </div>
                <div className="form-row">
                  <label>{t('settings.apiKey')}</label>
                  <input type="password" value={provider.apiKey} placeholder={t('settings.apiKeyPlaceholder')} autoComplete="off" onChange={(e) => update((d) => { d.providers.find((p) => p.id === provider.id)!.apiKey = e.target.value.trim() })} />
                </div>
                <div className="form-row">
                  <label>{t('settings.model')}</label>
                  <input value={provider.model} placeholder="deepseek-flash" onChange={(e) => update((d) => { d.providers.find((p) => p.id === provider.id)!.model = e.target.value.trim() })} />
                </div>
                <div className="form-row">
                  <label>{t('settings.temperature')}</label>
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
                  <span className="form-hint">{t('settings.openAICompatHint')}</span>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => removeProvider(provider.id)} disabled={draft.providers.length <= 1}>
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )}

            <div className="form-block" style={{ marginTop: 4 }}>
              <div className="form-block-title">{t('settings.subagentModel')}</div>
              <p className="form-desc">{t('settings.subagentHint')}</p>
              <select
                className="subagent-select"
                value={draft.subagentProviderId ?? ''}
                onChange={(e) => update((d) => { d.subagentProviderId = e.target.value || undefined })}
              >
                <option value="">{t('settings.followMain')}</option>
                {draft.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model || t('settings.noModel')}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {tab === 'web' && (
          <div className="settings-body">
            <div className="form-block">
              <div className="form-block-title">{t('settings.proxyTitle')}</div>
              <p className="form-desc">
                {t('settings.proxyHint')} <code>{'{url}'}</code>
              </p>
              <input
                value={draft.proxyTemplate}
                placeholder="https://your-proxy.example/?{url}"
                onChange={(e) => update((d) => { d.proxyTemplate = e.target.value.trim() })}
              />
            </div>
            <div className="form-block">
              <div className="form-block-title">{t('settings.webSearch')}</div>
              <div className="seg">
                {(['none', 'tavily', 'brave'] as const).map((v) => (
                  <button key={v} type="button" className={`seg-btn ${(v === 'none' && !draft.webSearch) || draft.webSearch?.provider === v ? 'on' : ''}`} onClick={() => update((d) => { d.webSearch = v === 'none' ? null : { provider: v, apiKey: d.webSearch?.apiKey ?? '' } })}>
                    {v === 'none' ? t('settings.webSearchNone') : v === 'tavily' ? 'Tavily' : 'Brave'}
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
              <div className="form-block-title">{t('settings.balance')}</div>
              <p className="form-desc">{t('settings.balanceHint')}</p>
              <div className="seg">
                {(['off', 'on'] as const).map((v) => (
                  <button key={v} type="button" className={`seg-btn ${(draft.showBalance ?? 'off') === v ? 'on' : ''}`} onClick={() => update((d) => { d.showBalance = v })}>
                    {v === 'off' ? t('settings.off') : t('settings.on')}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-block">
              <div className="form-block-title">{t('settings.contextTier')}</div>
              <p className="form-desc">{t('settings.contextTierHint')}</p>
              <div className="seg">
                {(['eco', 'standard', 'full'] as const).map((v) => (
                  <button key={v} type="button" className={`seg-btn ${(draft.costTier ?? 'standard') === v ? 'on' : ''}`} onClick={() => update((d) => { d.costTier = v })}>
                    {v === 'eco' ? t('settings.contextTierEco') : v === 'standard' ? t('settings.contextTierStandard') : t('settings.contextTierFull')}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-block">
              <div className="form-block-title">{t('settings.autoCompact')}</div>
              <p className="form-desc">{t('settings.autoCompactHint')}</p>
              <div className="seg">
                {(['on', 'off'] as const).map((v) => (
                  <button key={v} type="button" className={`seg-btn ${(draft.autoCompact ?? 'on') === v ? 'on' : ''}`} onClick={() => update((d) => { d.autoCompact = v })}>
                    {v === 'on' ? t('settings.autoCompactOn') : t('settings.autoCompactOff')}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-block">
              <div className="form-block-title">{t('settings.toolApproval')}</div>
              <p className="form-desc">{t('settings.toolApprovalHint')}</p>
              <div className="seg">
                {(['off', 'on'] as const).map((v) => (
                  <button key={v} type="button" className={`seg-btn ${(draft.toolApproval ?? 'off') === v ? 'on' : ''}`} onClick={() => update((d) => { d.toolApproval = v })}>
                    {v === 'off' ? t('settings.off') : t('settings.on')}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-block">
              <div className="form-block-title">{t('settings.sessionData')}</div>
              <p className="form-desc">{t('settings.sessionDataHint')}</p>
              <div className="form-actions">
                <button type="button" className="btn-ghost btn-sm" onClick={() => void exportSessionJson()}>
                  {t('settings.exportJson')}
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => downloadText(`tim-session-${Date.now()}.md`, runtime.exportSessionMarkdown(), 'text/markdown')}>
                  {t('settings.exportMd')}
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setImportOpen(true)}>
                  {t('settings.importJson')}
                </button>
              </div>
              {importOpen && (
                <textarea
                  className="import-area"
                  placeholder={t('settings.importPlaceholder')}
                  onChange={async (e) => {
                    const v = e.target.value.trim()
                    if (v.startsWith('{')) {
                      const ok = await runtime.importSession(v)
                      setNotice(ok ? t('settings.importOk') : t('settings.importFail'))
                    }
                  }}
                />
              )}
            </div>
            <div className="form-block">
              <div className="form-block-title danger">{t('settings.dangerZone')}</div>
              <button type="button" className="btn-danger" onClick={clearAllData}>
                {t('settings.clearAll')}
              </button>
            </div>
            <div className="about-block">
              <b>Tim Harness v0.4</b>
              <p>{t('settings.aboutText')}</p>
            </div>
          </div>
        )}

        {notice && <div className="settings-notice">{notice}</div>}

        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
