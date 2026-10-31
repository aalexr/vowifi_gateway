import React from 'react'
import { Phone as PhoneIcon } from 'lucide-react'

export default function Avatar({ label, color = 'var(--primary)', size = 96 }) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: `color-mix(in srgb, ${color} 13%, transparent)`,
      border: `2px solid color-mix(in srgb, ${color} 33%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.42, color, margin: '0 auto' }}><PhoneIcon size={size * 0.4} strokeWidth={1.6} /></div>
  )
}
