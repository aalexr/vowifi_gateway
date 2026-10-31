import React, { useState, useEffect } from 'react'
import { profileDisplayName } from './utils'

export default function RenameModal({ profile, busy, onClose, onSave }) {
  const [nick, setNick] = useState(() => profileDisplayName(profile))
  useEffect(() => {
    setNick(profileDisplayName(profile))
  }, [profile])
  if (!profile) return null
  return (
    <div className="modal-backdrop"
      onClick={onClose}>
      <div className="card" style={{ width: 360, maxWidth: '92vw', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Rename</div>
        <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 14, wordBreak: 'break-all' }}>
          {profile.iccid}
        </div>
        <label style={{ display: 'block', marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 4 }}>Nickname</div>
          <input
            autoFocus
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            placeholder="Nickname"
            style={{ width: '100%' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave(nick.trim())
              if (e.key === 'Escape') onClose()
            }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => onSave(nick.trim())}>
            {busy ? 'Saving…' : 'Update'}
          </button>
        </div>
      </div>
    </div>
  )
}
