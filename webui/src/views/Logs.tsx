import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { api } from '../api'
import SimSelector from '../components/common/SimSelector'

// Map ANSI SGR color codes to on-theme colors.
const FG = {
  30: '#475569', 31: '#ef4444', 32: '#22c55e', 33: '#eab308', 34: '#3b82f6',
  35: '#a855f7', 36: '#06b6d4', 37: 'var(--text)',
  90: '#64748b', 91: '#f87171', 92: '#4ade80', 93: '#facc15', 94: '#60a5fa',
  95: '#c084fc', 96: '#22d3ee', 97: 'var(--text)',
}

// Parse a string containing ANSI SGR escapes (e.g. "\x1b[1;32mDEBUG\x1b[0m[153]: ")
// into an array of styled React spans. Tolerates a missing ESC byte.
function ansi(text) {
  const out = []
  let style = {}
  let key = 0
  const re = /\x1b?\[([0-9;]*)m/g
  let last = 0
  let m
  const push = (t) => { if (t) out.push(<span key={key++} style={{ ...style }}>{t}</span>) }
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index))
    const codes = m[1].split(';').filter((s) => s !== '').map(Number)
    if (codes.length === 0) style = {}
    for (const c of codes) {
      if (c === 0) style = {}
      else if (c === 1) style = { ...style, fontWeight: 700 }
      else if (c === 3) style = { ...style, fontStyle: 'italic' }
      else if (c === 4) style = { ...style, textDecoration: 'underline' }
      else if (FG[c]) style = { ...style, color: FG[c] }
    }
    last = re.lastIndex
  }
  push(text.slice(last))
  return out
}

const TABS = [
  { id: 'engine', short: 'Engine', full: 'Asterisk / engine' },
  { id: 'charon', short: 'IKE', full: 'SWu tunnel (IKE)' },
]

export default function Logs({ selected, instances, cards, setSelected }) {
  const id = selected?.id
  const [logs, setLogs] = useState({ engine: '', charon: '' })
  const [tab, setTab] = useState('engine')
  const [auto, setAuto] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    try { setLogs(await api.logs(id, 400)); setErr('') }
    catch (e) { setErr(e.message) }
  }, [id])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!auto) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [auto, load])

  const rendered = useMemo(() => ansi(logs[tab] || '(empty)'), [logs, tab])

  if (!id) return (
    <div className="logs-page logs-page-empty">
      <SimSelector instances={instances} cards={cards} selected={selected} setSelected={setSelected} label="Show logs for" />
      <div style={{ color: 'var(--text-dim)' }}>Select a SIM / line to view its engine and IKE logs.</div>
    </div>
  )

  return (
    <div className="logs-page">
      <div className="logs-chrome">
        <SimSelector instances={instances} cards={cards} selected={selected} setSelected={setSelected} label="Show logs for" />
        {err && <div className="logs-err" role="alert">
          {err}{' '}<button type="button" className="btn btn-ghost logs-small-button" onClick={load}>Retry</button>
        </div>}
        <div className="logs-toolbar">
          <div className="logs-tabs" role="tablist" aria-label="Log source">
            {TABS.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
                className={`btn ${tab === item.id ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setTab(item.id)}>
                <span className="logs-tab-full">{item.full}</span>
                <span className="logs-tab-short">{item.short}</span>
              </button>
            ))}
          </div>
          <div className="logs-actions">
            <button type="button" className="btn btn-ghost" onClick={load}>Refresh</button>
            <label className="logs-auto">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto
            </label>
          </div>
        </div>
      </div>
      <pre className="mono card logs-body" tabIndex={0}>
        {rendered}
      </pre>
    </div>
  )
}
