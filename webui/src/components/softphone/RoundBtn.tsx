import React from 'react'

export default function RoundBtn({ icon, label, color, bg = undefined, onClick, active = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <button onClick={onClick} style={{
        width: 58, height: 58, borderRadius: '50%', cursor: 'pointer', fontSize: 22,
        border: '1px solid ' + (active ? color : 'var(--border-strong)'),
        background: bg || (active ? `color-mix(in srgb, ${color} 13%, transparent)` : 'var(--hover)'),
        color: bg ? color : active ? color : 'var(--text-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{icon}</button>
      <span style={{ fontSize: 11, color: 'var(--text-mute)' }}>{label}</span>
    </div>
  )
}
