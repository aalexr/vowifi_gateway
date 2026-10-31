import React, { useEffect, useState, useCallback, useRef } from 'react'
import { api, connectWs } from './api'
import Dashboard from './views/Dashboard'
import Softphone from './views/Softphone'
import Messages from './views/Messages'
import SimConfig from './views/SimConfig'
import Settings from './views/Settings'
import Logs from './views/Logs'
import Esim from './views/Esim'
import { LayoutDashboard, Phone, MessageSquare, Cpu, Smartphone, Settings as SettingsIcon, ScrollText, SunMoon, Sun, Moon, type LucideIcon } from 'lucide-react'

// [key, label, icon, alwaysAvailable] — views not marked alwaysAvailable are disabled
// while no PC/SC reader is connected (they all operate on a physical SIM line).
const NAV: [string, string, LucideIcon, boolean][] = [
  ['dashboard', 'Dashboard', LayoutDashboard, true],
  ['softphone', 'Softphone', Phone, false],
  ['messages', 'Messages', MessageSquare, false],
  ['sims', 'SIM Config', Cpu, false],
  ['esim', 'eSIM', Smartphone, false],
  ['settings', 'Settings', SettingsIcon, true],
  ['logs', 'Logs', ScrollText, true],
]
const THEMES: [string, LucideIcon][] = [['auto', SunMoon], ['light', Sun], ['dark', Moon]]

export default function App() {
  const [view, setView] = useState('dashboard')
  const [instances, setInstances] = useState([])
  const [cards, setCards] = useState([])
  const [cardsKnown, setCardsKnown] = useState(false)  // first successful reader scan received
  const [selected, setSelected] = useState(null)
  const [toast, setToast] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'auto')
  const wsEvents = useRef<{ handlers: Set<(msg: any) => void> }>({ handlers: new Set() })

  // Apply + persist theme. 'auto' follows the OS (falls back to light if unavailable).
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
  }, [theme])

  const refresh = useCallback(async () => {
    try {
      const r = await api.instances()
      setInstances(r.instances)
      setSelected((s) => s != null && s !== ''
        ? String(s)
        : (r.instances[0] ? String(r.instances[0].id) : null))
    } catch (e) { /* manager may be starting */ }
    try { const c = await api.cards(); setCards(c.cards); setCardsKnown(true) } catch {}
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // live updates
  useEffect(() => {
    const off = connectWs((msg) => {
      if (msg.type === 'status') {
        // Keep the WHOLE status payload (reason, reason_code, retry, frozen, …), not just
        // state/label/detail — otherwise a live status push would drop the failure reason
        // that the initial /api/instances fetch showed, making the error banner vanish.
        const { type, instance, ...status } = msg
        setInstances((list) => list.map((i) => String(i.id) === String(instance)
          ? { ...i, status }
          : i))
      }
      if (msg.type === 'cards') { setCards(msg.cards); setCardsKnown(true) }
      if (msg.type === 'engine' && ['card_removed', 'reader_lost', 'reader_added', 'reader_removed'].includes(msg.event)) {
        const name = msg.args?.[0]
        showToast({
          card_removed: 'SIM removed — line stopped',
          reader_lost: 'Reader unplugged — line stopped',
          reader_added: `Card reader connected${name ? `: ${name}` : ''}`,
          reader_removed: `Card reader disconnected${name ? `: ${name}` : ''}`,
        }[msg.event])
        refresh()
      }
      wsEvents.current.handlers.forEach((h) => h(msg))
      // later parts of a concatenated SMS only update the existing message (msg.update)
      if (msg.type === 'sms' && msg.message?.direction === 'in' && !msg.update) {
        showToast(`SMS from ${msg.message.peer}`)
      }
      if (msg.type === 'call' && msg.call?.direction === 'in') {
        showToast(`Incoming call from ${msg.call.peer}`)
      }
    })
    return off
  }, [])

  const subscribe = useCallback((h) => {
    wsEvents.current.handlers.add(h)
    return () => wsEvents.current.handlers.delete(h)
  }, [])

  const toastTimer = useRef(null)
  const showToast = (m) => {
    clearTimeout(toastTimer.current)   // an older toast's timer must not clear this one
    setToast(m)
    toastTimer.current = setTimeout(() => setToast(null), 5000)
  }

  // No PC/SC reader connected at all -> SIM-bound views are unusable; keep only
  // Dashboard / Settings / Logs and bounce back to the dashboard if needed.
  const noReaders = cardsKnown && cards.length === 0
  useEffect(() => {
    if (noReaders && !NAV.find(([k]) => k === view)?.[3]) setView('dashboard')
  }, [noReaders, view])

  const sel = instances.find((i) => String(i.id) === String(selected))

  const View = { dashboard: Dashboard, softphone: Softphone, messages: Messages, sims: SimConfig, esim: Esim, settings: Settings, logs: Logs }[view]

  return (
    <div className="app-shell" style={{ display: 'flex', height: '100%' }}>
      <aside className="app-sidebar">
        <div className="app-brand">
          <span className="app-brand-accent">Vo</span>WiFi<span className="app-brand-sub"> gateway</span>
        </div>
        {NAV.map(([k, label, Icon, always]) => {
          const disabled = noReaders && !always
          return (
            <button className={`app-nav-button${view === k ? ' is-active' : ''}`} key={k}
              onClick={() => !disabled && setView(k)} disabled={disabled}
              title={disabled ? 'No PC/SC reader detected — connect a card reader to enable' : undefined}>
              <Icon size={18} strokeWidth={1.9} aria-hidden="true" /><span className="app-nav-label">{label}</span>
            </button>
          )
        })}
        <div className="app-theme-picker" role="radiogroup" aria-label="Theme">
          {THEMES.map(([t, Icon]) => (
            <button key={t} onClick={() => setTheme(t)} title={`${t} theme`} role="radio" aria-checked={theme === t}
              className={theme === t ? 'is-active' : ''}>
              <Icon size={14} aria-hidden="true" /><span>{t}</span>
            </button>
          ))}
        </div>
        <div className="app-instance-count">
          {instances.length} SIM{instances.length !== 1 ? 's' : ''} configured
        </div>
      </aside>

      <main className="app-main" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="app-header" style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 16, flexShrink: 0, padding: '24px 24px 0' }}>
          <h1 className="app-title">{NAV.find(([k]) => k === view)?.[1]}</h1>
          {/* per-page SIM selectors (SimSelector) handle multi-SIM switching on the views that
              operate on a single line — softphone / messages / logs / SIM config */}
        </div>
        {/* Single bounded scroll region. Document-flow views (Dashboard/Settings/Logs) scroll
            here; app-like views (Messages/Softphone) fill it with height:100% and scroll their
            own inner lists instead, so the page height never grows with list length. The
            padding also gives card outlines/shadows room so overflow:auto doesn't clip them
            (e.g. the Dashboard active-reader ring on the top/left edge). */}
        <div className="app-content" style={{ flex: 1, minHeight: 0, overflowX: 'hidden', overflowY: 'auto', padding: '6px 24px 24px' }}>
          {View && <View instances={instances} cards={cards} noReaders={noReaders} cardsKnown={cardsKnown} selected={sel} setSelected={setSelected} refresh={refresh} subscribe={subscribe} showToast={showToast} setView={setView} />}
        </div>
      </main>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
