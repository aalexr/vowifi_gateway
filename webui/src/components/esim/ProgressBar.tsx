import React from 'react'
import { DOWNLOAD_STEPS, resolveDownloadStep } from './utils'

export default function ProgressBar({ step, done, error }) {
  const resolved = resolveDownloadStep(step)
  const idx = resolved ? DOWNLOAD_STEPS.findIndex(([k]) => k === resolved) : -1
  // Unknown steps (cancel_session, started) must NOT fall back to index 0 — that looked like a jump to step 1.
  const cur = done ? DOWNLOAD_STEPS.length : (idx >= 0 ? idx : (step === 'started' ? 0 : -1))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {DOWNLOAD_STEPS.map(([k, label], i) => {
        const finished = done || (cur >= 0 && i < cur)
        const active = !done && !error && cur >= 0 && i === cur
        const failed = !!error && cur >= 0 && i === cur
        const color = failed ? 'var(--danger-solid)' : finished ? 'var(--ok-solid)' : active ? '#ca8a04' : 'var(--border-strong)'
        return (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <span style={{
              width: 18, height: 18, borderRadius: 999, background: color,
              color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, flexShrink: 0,
            }}>
              {finished ? '✓' : failed ? '!' : active ? '…' : i + 1}
            </span>
            <span style={{ color: finished || active || failed ? 'var(--text)' : 'var(--text-mute)', fontWeight: active || failed ? 700 : 500 }}>
              {label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
