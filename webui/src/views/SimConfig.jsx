import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import SimSelector from './SimSelector.jsx'

const PANI_ACCESS_TYPES = [
  'IEEE-802.11', 'IEEE-802.11a', 'IEEE-802.11b', 'IEEE-802.11g', 'IEEE-802.11n',
  'IEEE-802.11ac', 'IEEE-802.11ax', 'IEEE-802.11be', '3GPP-WLAN',
]

// Preview-only MCC→ISO hints (authoritative table lives in control/app/mcc_country.py).
const PREVIEW_MCC_ISO = {
  '202': 'GR', '204': 'NL', '206': 'BE', '208': 'FR', '214': 'ES', '216': 'HU',
  '219': 'HR', '222': 'IT', '226': 'RO', '228': 'CH', '230': 'CZ', '232': 'AT',
  '234': 'GB', '235': 'GB', '238': 'DK', '240': 'SE', '242': 'NO', '244': 'FI',
  '250': 'RU', '255': 'UA', '260': 'PL', '262': 'DE', '268': 'PT', '272': 'IE',
  '286': 'TR', '302': 'CA', '310': 'US', '311': 'US', '312': 'US', '313': 'US',
  '314': 'US', '315': 'US', '316': 'US', '334': 'MX', '404': 'IN', '405': 'IN',
  '440': 'JP', '441': 'JP', '450': 'KR', '454': 'HK', '455': 'MO', '460': 'CN',
  '461': 'CN', '466': 'TW', '502': 'MY', '505': 'AU', '510': 'ID', '515': 'PH',
  '520': 'TH', '525': 'SG', '530': 'NZ', '602': 'EG', '655': 'ZA', '724': 'BR',
}

const emptyInstance = () => ({
  id: '', name: '', imsi: '', mcc: '', mnc: '', imei: '', imeisv: '', pin: '', reader: '',
  reader_index: 0, reader_port: '', msisdn: '', smsc: '', enabled: true, apn: 'ims', idr_mode: 'apn', cp_mode: 'auto',
  use_reauth_id: true,
  ims_domain: '', reg_geolocation_country: '', reg_srvcc_tags: false, reg_imei_urn_spare_zero: false,
  dial_00_to_plus: false, update_after_prack: false,
  sip: {
    listen_addr: '0.0.0.0', transport: 'udp', external: [], webrtc: { enable: true },
    pani_country_enable: true, pani_country: '',
    pani_node_id_enable: false, pani_node_id: '',
    pani_access_type: 'IEEE-802.11',
  },
  debug: { asterisk: true, charon: false },
})

function Field({ label, children, wide }) {
  return <div className={wide ? 'field-wide' : undefined}><label>{label}</label>{children}</div>
}

// One titled block of the line form. Collapsible sections are for settings most lines never
// touch; they open by default when something in them is already set, so nothing is hidden
// that differs from the defaults. The open state then belongs to the user until the line
// changes (resetKey), so clearing a field doesn't snap the section shut mid-edit.
function Section({ title, desc, collapsible, defaultOpen, resetKey, children }) {
  const [open, setOpen] = useState(!!defaultOpen)
  useEffect(() => { setOpen(!!defaultOpen) }, [resetKey])  // eslint-disable-line react-hooks/exhaustive-deps
  const head = (
    <>
      <div className="cfg-section-title">{title}</div>
      {desc && <div className="cfg-section-desc">{desc}</div>}
    </>
  )
  if (!collapsible) return <section className="card cfg-section"><header>{head}</header>{children}</section>
  return (
    <details className="card cfg-section" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{head}</summary>
      <div className="cfg-section-body">{children}</div>
    </details>
  )
}

function Check({ checked, onChange, children }) {
  return (
    <label className="cfg-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  )
}

function normalizePreviewCountry(c) {
  const s = String(c || '').trim().toUpperCase().replace(/[^A-Z]/g, '')
  return s.length === 2 ? s : ''
}

function normalizePreviewNodeId(m) {
  const s = String(m || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  return /^[0-9a-f]{12}$/.test(s) ? s : ''
}

/** Client-side preview of the P-Access-Network-Info header that will be sent. */
function previewPani(sip, mcc) {
  const s = sip || {}
  if ((s.pani || '').trim()) return s.pani.trim()
  const parts = [s.pani_access_type || 'IEEE-802.11']
  if (s.pani_country_enable !== false) {
    let c = normalizePreviewCountry(s.pani_country)
    if (!c) {
      const key = String(mcc || '').replace(/\D/g, '').slice(0, 3).padStart(3, '0')
      c = PREVIEW_MCC_ISO[key] || ''
    }
    if (c) parts.push(`country=${c}`)
    else if (mcc) parts.push('country=<from SIM MCC>')
  }
  if (s.pani_node_id_enable) {
    const n = normalizePreviewNodeId(s.pani_node_id)
    if (n) parts.push(`i-wlan-node-id=${n}`)
  }
  return parts.join(';')
}

function sipUsernameConflict(sip) {
  const accounts = sip?.external || []
  const webrtcUser = String(sip?.webrtc?.username || 'webrtc').trim()
  const reserved = new Set([
    'global', 'system', 'volte_ims', 'endpoint-local', 'auth-local', 'aor-local',
    'transport-local', 'transport-wss', webrtcUser,
  ].filter(Boolean))
  const seen = new Map()
  for (let i = 0; i < accounts.length; i++) {
    const username = String(accounts[i]?.username || '').trim()
    if (!username) continue
    if (reserved.has(username)) {
      return `SIP username '${username}' is reserved for the built-in softphone or Asterisk.`
    }
    if (seen.has(username)) {
      return `SIP username '${username}' is used more than once (accounts #${seen.get(username) + 1} and #${i + 1}).`
    }
    seen.set(username, i)
  }
  return ''
}

export default function SimConfig({ instances, selected, refresh, cards, setSelected }) {
  const [readers, setReaders] = useState([])
  const [card, setCard] = useState(null)
  const [pin, setPin] = useState('')
  const [pinMsg, setPinMsg] = useState('')
  const [form, setForm] = useState(emptyInstance())
  const [saving, setSaving] = useState(false)
  const [smscMode, setSmscMode] = useState('auto')   // 'auto' = read from SIM, 'manual' = typed

  // Refresh the physical-reader list whenever the detected-card set changes (hotplug), so
  // the reader picker never lists a reader that has been unplugged.
  useEffect(() => { api.readers().then((r) => setReaders(r.readers)).catch(() => {}) }, [cards.map((c) => c.name).join(',')])
  useEffect(() => {
    if (!selected) return
    // Deep-merge sip so new PANI knobs keep their defaults when an older saved
    // instance has no pani_* keys yet (shallow spread would drop emptyInstance.sip).
    const base = emptyInstance()
    setForm({ ...base, ...selected, sip: { ...base.sip, ...(selected.sip || {}) } })
  }, [selected?.id])
  // Keep the reader selection valid for the CURRENT hardware. A stored reader_index can be
  // stale — saved when more readers were attached — and point past the live reader list; the
  // <select> then has no matching option and "Detect card" probes a phantom reader ("No SIM
  // card in reader N"). Clamp any out-of-range index back onto a reader that actually exists.
  useEffect(() => {
    if (!readers.length) return
    setForm((f) => (f.reader_index >= readers.length || f.reader_index < 0)
      ? { ...f, reader_index: 0 } : f)
  }, [readers.length])
  // Keep the "PIN saved?" indicator in sync when it changes server-side (delete-PIN,
  // start-with-PIN) without a full line switch — mirror the fresh value onto the form.
  useEffect(() => { if (selected) setForm((f) => ({ ...f, has_pin: selected.has_pin })) }, [selected?.has_pin])

  const upd = (patch) => setForm((f) => ({ ...f, ...patch }))
  const updSip = (patch) => setForm((f) => ({ ...f, sip: { ...f.sip, ...patch } }))
  // The reader index to act on, clamped to a reader that currently exists (never probe a
  // stale/out-of-range index that would report a phantom empty reader).
  const readerIdx = () => (form.reader_index >= 0 && form.reader_index < readers.length) ? form.reader_index : 0
  // Stable USB port path of a reader index (from the live card monitor). A line binds to this
  // port, not the enumeration index, so it sticks to the physical reader socket even when pcscd
  // re-enumerates two identical readers in a different order.
  const portForIdx = (i) => (cards.find((c) => c.index === i) || {}).reader_port || ''

  const detect = async () => {
    setPinMsg('Detecting…')
    try {
      const c = await api.detect(readerIdx())
      setCard(c)
      if (!c.present) {
        setPinMsg('No SIM card in this reader.')
        return
      }
      const patch = { imsi: c.imsi || form.imsi, mcc: c.mcc || form.mcc, mnc: c.mnc || form.mnc }
      if (c.smsc && smscMode === 'auto') patch.smsc = c.smsc   // SMSC from the SIM (EF_SMSP)
      if (c.imsi) patch.reader = `imsi:${c.imsi}`
      // Bind the line to the reader's stable physical USB port (from the detected card, else the
      // live monitor). Persisted so start-time re-resolves the correct index for this socket.
      const port = c.reader_port || portForIdx(readerIdx())
      if (port) patch.reader_port = port
      if (!form.id) patch.id = String(instances.length + 1)
      upd(patch)
      setPinMsg(c.imsi ? 'Card read.' : `Card present (enter PIN to read IMSI). ICCID ${c.iccid || '?'}, tries ${c.pin_tries ?? '?'}`)
    } catch (e) { setPinMsg('Error: ' + e.message) }
  }

  const verifyPin = async () => {
    setPinMsg('Verifying…')
    try {
      const r = await api.verifyPin(pin, readerIdx())
      setPinMsg(r.ok ? 'PIN OK ✓' : `Failed: ${r.error} (${r.tries} tries left)`)
      if (r.ok) {
        const p = { pin }
        if (r.card?.smsc && smscMode === 'auto') p.smsc = r.card.smsc   // now-readable SMSC from SIM
        upd(p)
        await detect()
      }
    } catch (e) { setPinMsg('Error: ' + e.message) }
  }

  const save = async () => {
    setSaving(true)
    try {
      const sipError = sipUsernameConflict(form.sip)
      if (sipError) throw new Error(sipError)
      const body = { ...form, mnc: String(form.mnc).padStart(3, '0') }
      // Strip runtime-only fields that ride along on the instance object from /api/instances
      // (they are computed per-request, not config — never persist them).
      delete body.status; delete body.has_pin
      // Never send an empty PIN — the stored PIN (tied to this IMSI) must survive edits to
      // unrelated fields. `pin` state is only set when the user re-enters/verifies a PIN
      // here; only then do we forward it to update the saved credential.
      delete body.pin
      if (pin) body.pin = pin
      // An empty password field means "keep the saved secret", not "replace it with
      // empty". A deliberate password change is sent normally.
      if (body.sip) {
        body.sip = {
          ...body.sip,
          external: (body.sip.external || []).map((account) => {
            const row = { username: account.username || '' }
            if (String(account.password || '').trim()) row.password = account.password
            return row
          }),
        }
      }
      const res = await api.saveInstance(body)
      await refresh()
      if (res?.restart_required) {
        const message = 'Saved. Restart this line (Stop → Start) for SIP, IMEI, and softphone changes to take effect.'
        setPinMsg(message)
        alert(message)
      } else {
        setPinMsg('Saved.')
      }
    } catch (e) { setPinMsg(e.message); alert(e.message) }
    setSaving(false)
  }

  const del = async () => {
    if (!confirm('Delete this instance?')) return
    await api.deleteInstance(form.id); await refresh(); setForm(emptyInstance())
  }

  const deleteSavedPin = async () => {
    if (!form.id) return
    if (!confirm('Delete the saved SIM PIN for this line?\n\nThe line will be stopped and, '
      + 'the next time you start it, you\'ll be asked to enter the PIN again.')) return
    try {
      const r = await api.clearPin(form.id)
      upd({ has_pin: false })          // reflect immediately (form is local state)
      await refresh()
      setPinMsg(r.had_pin ? 'Saved PIN deleted — the line will ask for it on next start.'
                          : 'No saved PIN to delete.')
    } catch (e) { alert(e.message) }
  }

  const addAccount = () => updSip({ external: [...(form.sip.external || []), { username: '', password: '' }] })
  const setAccount = (i, k, v) => updSip({ external: form.sip.external.map((a, idx) => idx === i ? { ...a, [k]: v } : a) })
  const sipUserError = sipUsernameConflict(form.sip)

  // Open the advanced sections when the saved line already uses them (computed from the saved
  // instance, not the live form, so typing doesn't change it).
  const saved = selected || {}
  const savedSip = saved.sip || {}
  const imsAdvancedSet = !!(saved.ims_domain || saved.reg_geolocation_country || saved.reg_srvcc_tags
    || saved.reg_imei_urn_spare_zero || saved.dial_00_to_plus || saved.update_after_prack)
  const paniCustomised = (!!savedSip.pani_access_type && savedSip.pani_access_type !== 'IEEE-802.11')
    || !!savedSip.pani_country || savedSip.pani_country_enable === false || !!savedSip.pani_node_id_enable

  return (
    <div className="simcfg">
      {instances.length > 1 &&
        <SimSelector instances={instances} cards={cards} selected={selected} setSelected={setSelected} label="Configuring line" />}
      <div className="simcfg-grid">
      {/* Card / PIN panel */}
      <aside className="card simcfg-card">
        <div className="cfg-section-title">SIM card</div>
        <Field label="Reader">
          <select value={form.reader_index} onChange={(e) => upd({ reader_index: +e.target.value, reader_port: portForIdx(+e.target.value) || form.reader_port })}>
            {readers.map((r, i) => <option key={i} value={i}>{i}: {r}{portForIdx(i) ? ` — USB ${portForIdx(i)}` : ''}</option>)}
            {readers.length === 0 && <option>no readers</option>}
          </select>
        </Field>
        {form.reader_port &&
          <div className="hint">Bound to USB port {form.reader_port} (stable across reader re-enumeration)</div>}
        <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={detect}>Detect card</button>
        {card && (
          card.present ? (
            <dl className="simcfg-facts mono">
              <dt>ICCID</dt><dd>{card.iccid || '—'}</dd>
              <dt>IMSI</dt><dd>{card.imsi || '(locked)'}</dd>
              {card.reader_port && <><dt>USB port</dt><dd>{card.reader_port}</dd></>}
              <dt>PIN</dt><dd>{card.pin_enabled ? `enabled, ${card.pin_tries} tries` : 'disabled'}</dd>
            </dl>
          ) : <div className="banner banner-danger" style={{ marginTop: 12 }}>No SIM card in reader {card.reader_index}.</div>
        )}
        <hr className="cfg-rule" />
        <Field label="PIN (CHV1)">
          <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="e.g. 123456" />
        </Field>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={verifyPin} disabled={!pin}>Verify PIN</button>
          {form.id && form.has_pin &&
            <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={deleteSavedPin}>Delete saved PIN</button>}
        </div>
        {form.id && (
          <div className="hint" style={{ marginTop: 8 }}>
            {form.has_pin
              ? 'A PIN is saved for this line and used automatically on start.'
              : 'No PIN saved — you\'ll be asked for it when the line is started (if the SIM requires one).'}
          </div>
        )}
        {pinMsg && <div style={{ fontSize: 13, marginTop: 10, color: pinMsg.includes('OK') || pinMsg.includes('read') || pinMsg.startsWith('Saved.') || pinMsg.includes('deleted') ? 'var(--ok)' : 'var(--warn)' }}>{pinMsg}</div>}
      </aside>

      {/* Instance form, split into sections */}
      <div className="simcfg-form">
        <Section title="Line" desc="How this line is identified in the gateway.">
          <div className="form-grid">
            <Field label="Instance ID"><input value={form.id} onChange={(e) => upd({ id: e.target.value })} placeholder="1" /></Field>
            <Field label="Name"><input value={form.name} onChange={(e) => upd({ name: e.target.value })} placeholder="Telus" /></Field>
            <Field label="Phone number (MSISDN)"><input className="mono" value={form.msisdn} onChange={(e) => upd({ msisdn: e.target.value })} placeholder="auto-learned" /></Field>
            <Field label="Reader match"><input className="mono" value={form.reader} onChange={(e) => upd({ reader: e.target.value })} placeholder="imsi:302..." /></Field>
          </div>
        </Section>

        <Section title="Subscriber & device" desc="Read from the SIM; the IMEI is what the line presents to the network.">
          <div className="form-grid form-grid-4">
            <Field label="IMSI" wide><input className="mono" value={form.imsi} onChange={(e) => upd({ imsi: e.target.value })} /></Field>
            <Field label="MCC"><input className="mono" value={form.mcc} onChange={(e) => upd({ mcc: e.target.value })} /></Field>
            <Field label="MNC"><input className="mono" value={form.mnc} onChange={(e) => upd({ mnc: e.target.value })} /></Field>
            <Field label="IMEI" wide><input className="mono" value={form.imei} onChange={(e) => upd({ imei: e.target.value })} placeholder="35123456-789012-3" /></Field>
            <Field label="IMEISV" wide><input className="mono" value={form.imeisv || ''} onChange={(e) => upd({ imeisv: e.target.value.replace(/[^0-9]/g, '') })} maxLength={16} placeholder="auto from IMEI" /></Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <label>SMS centre (SMSC)</label>
            <div className="segmented" style={{ marginBottom: 6 }}>
              <button type="button" className={`btn${smscMode === 'auto' ? ' is-active' : ''}`}
                onClick={() => { setSmscMode('auto'); if (card?.smsc) upd({ smsc: card.smsc }) }}>Auto (from SIM)</button>
              <button type="button" className={`btn${smscMode === 'manual' ? ' is-active' : ''}`}
                onClick={() => setSmscMode('manual')}>Manual</button>
            </div>
            <input className="mono" value={form.smsc} readOnly={smscMode === 'auto'}
              onChange={(e) => upd({ smsc: e.target.value })}
              placeholder={smscMode === 'auto' ? 'detect card / verify PIN to read from SIM' : '+1...'}
              style={smscMode === 'auto' ? { opacity: .7 } : undefined} />
          </div>
        </Section>

        <Section title="ePDG tunnel" desc="IKEv2 / EAP-AKA attach to the carrier's Wi-Fi calling gateway.">
          <div className="form-grid">
            <Field label="APN"><input className="mono" value={form.apn ?? 'ims'} onChange={(e) => upd({ apn: e.target.value })} placeholder="ims" /></Field>
            <Field label="ePDG identity (IDr)">
              <select value={form.idr_mode ?? 'apn'} onChange={(e) => upd({ idr_mode: e.target.value })}>
                <option value="apn">Bare APN (default)</option>
                <option value="fqdn">APN-FQDN</option>
              </select>
            </Field>
            <Field label="IMS address family (CP)">
              <select value={form.cp_mode ?? 'auto'} onChange={(e) => upd({ cp_mode: e.target.value })}>
                <option value="auto">Auto-detect (recommended)</option>
                <option value="dual">Dual-stack (IPv4+IPv6)</option>
                <option value="v6">IPv6 only</option>
                <option value="v4">IPv4 only</option>
              </select>
            </Field>
          </div>
          {form.cp_mode && form.cp_mode !== 'auto' && form.cp_mode_source === 'auto' && (
            <div className="hint">Auto-detected: {form.cp_mode.toUpperCase()}. Switch back to Auto-detect to re-probe.</div>
          )}
          <div className="hint">
            <b>IDr</b> is how the APN is presented to the ePDG. <b>Bare APN</b> (just the APN string) is what most carriers' ePDGs expect and is the safe default; <b>APN-FQDN</b> (<code>&lt;apn&gt;.apn.epc.mnc…mcc….pub.3gppnetwork.org</code>) is required only by a few stricter carriers — some networks reject it.
          </div>
          <div className="hint">
            <b>IMS address family</b> must match the carrier's IMS PDN. <b>Auto-detect</b> figures it out for you (matches known carriers, else probes families after SIM auth) and pins the one that works — leave this unless you know the carrier needs a specific family. Telus/EE are IPv6; Vodafone UK is IPv4.
          </div>
          <Check checked={form.use_reauth_id !== false} onChange={(v) => upd({ use_reauth_id: v })}>
            Use EAP-AKA fast re-authentication
          </Check>
          <div className="hint">
            On by default. After a successful attach the carrier's AAA may hand out a short-lived re-authentication identity; presenting it on a reconnect lets the network skip a full SIM auth run. If it has expired the engine notices the rejection and retries with the permanent IMSI identity by itself, so this is safe to leave on. Turn it <b>off</b> for a carrier whose AAA rejects it on every reconnect (O2 UK) to skip that wasted attach attempt.
          </div>
        </Section>

        <Section title="Local SIP access" desc="How phones and SIP clients on your network reach this line.">
          <div className="form-grid">
            <Field label="Listen address">
              <select value={form.sip.listen_addr} onChange={(e) => updSip({ listen_addr: e.target.value })}>
                <option value="0.0.0.0">0.0.0.0 (all)</option>
                <option value="127.0.0.1">127.0.0.1 (local)</option>
                {selected?.status && <option value="lan">LAN IP</option>}
              </select>
            </Field>
            <Field label="Transport">
              <select value={form.sip.transport} onChange={(e) => updSip({ transport: e.target.value })}>
                <option value="udp">UDP</option><option value="tcp">TCP</option><option value="tls">TLS</option>
              </select>
            </Field>
            <Field label="Device User-Agent (identify to the carrier as this device)" wide>
              <input className="mono" value={form.sip.user_agent || ''} onChange={(e) => updSip({ user_agent: e.target.value })} placeholder="iOS/26.6 iPhone" />
            </Field>
          </div>
          <Check checked={!!form.sip.webrtc?.enable} onChange={(v) => updSip({ webrtc: { ...form.sip.webrtc, enable: v } })}>
            Enable browser softphone (WebRTC)
          </Check>

          <div className="cfg-subhead">External SIP accounts</div>
          <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
            Each account needs a unique username and cannot reuse an Asterisk or WebRTC name.
          </div>
          {(form.sip.external || []).map((a, i) => (
            <div key={i} className="sip-account-row">
              <input placeholder="username" value={a.username} onChange={(e) => setAccount(i, 'username', e.target.value)} />
              <input type="password" placeholder="password" value={a.password} onChange={(e) => setAccount(i, 'password', e.target.value)} />
            </div>
          ))}
          {sipUserError && (
            <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 6 }} role="alert">
              {sipUserError}
            </div>
          )}
          <button className="btn btn-ghost" onClick={addAccount}>+ Add account</button>
        </Section>

        <Section title="IMS registration" desc="Advanced — leave off/empty unless the carrier needs them."
          collapsible defaultOpen={imsAdvancedSet} resetKey={saved.id}>
          <div className="form-grid">
            <Field label="Registrar home domain">
              <input className="mono" value={form.ims_domain || ''} onChange={(e) => upd({ ims_domain: e.target.value.trim() })} placeholder="auto (ims.mnc….mcc….3gppnetwork.org)" />
            </Field>
            <Field label="Geolocation in REGISTER (country)">
              <input className="mono" value={form.reg_geolocation_country || ''} maxLength={2}
                onChange={(e) => upd({ reg_geolocation_country: e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase() })} placeholder="off (e.g. DE)" />
            </Field>
          </div>
          <Check checked={!!form.reg_srvcc_tags} onChange={(v) => upd({ reg_srvcc_tags: v })}>
            Advertise SRVCC capabilities in REGISTER
          </Check>
          <Check checked={!!form.reg_imei_urn_spare_zero} onChange={(v) => upd({ reg_imei_urn_spare_zero: v })}>
            Send IMEI in +sip.instance with spare digit 0 (RFC 7254)
          </Check>
          <Check checked={!!form.dial_00_to_plus} onChange={(v) => upd({ dial_00_to_plus: v })}>
            Dial a leading 00 as + (for phones that can't dial "+", e.g. DECT handsets)
          </Check>
          <Check checked={!!form.update_after_prack} onChange={(v) => upd({ update_after_prack: v })}>
            Send the call-setup UPDATE only after the PRACK is answered (fixes 491 → 500 on outgoing calls)
          </Check>
          <div className="hint">
            These change only this line. Some IMS cores accept the REGISTER and then remove it within a second (status "The carrier's IMS accepted the registration but then removed it again") unless it looks like a native phone. <b>MTS RU</b> needs only the Geolocation country (the country you are in, e.g. <code>DE</code>); the other options are there for carriers that turn out to need them (an iPhone sends all of them). Restart the line after changing them.
          </div>
        </Section>

        <Section title="P-Access-Network-Info" collapsible defaultOpen={paniCustomised} resetKey={saved.id}
          desc={<>Identifies the Wi-Fi access on REGISTER / SIP. Default matches real phones: <code>IEEE-802.11;country=&lt;SIM home country&gt;</code></>}>
          <Field label="Access type">
            <select value={form.sip.pani_access_type || 'IEEE-802.11'}
              onChange={(e) => updSip({ pani_access_type: e.target.value })}>
              {PANI_ACCESS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Check checked={form.sip.pani_country_enable !== false} onChange={(v) => updSip({ pani_country_enable: v })}>
            Report country code
          </Check>
          {form.sip.pani_country_enable !== false && (
            <input className="mono" maxLength={2} style={{ marginTop: 6 }}
              value={form.sip.pani_country || ''}
              onChange={(e) => updSip({ pani_country: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) })}
              placeholder="empty = derive from the SIM's MCC (e.g. GB)" />
          )}
          <Check checked={!!form.sip.pani_node_id_enable} onChange={(v) => updSip({ pani_node_id_enable: v })}>
            Report Wi-Fi AP BSSID (i-wlan-node-id)
          </Check>
          {!!form.sip.pani_node_id_enable && (
            <input className="mono" style={{ marginTop: 6 }}
              value={form.sip.pani_node_id || ''}
              onChange={(e) => updSip({ pani_node_id: e.target.value })}
              placeholder="000cf1126028" />
          )}
          <div className="mono pani-preview">
            P-Access-Network-Info: {previewPani(form.sip, form.mcc)}
          </div>
        </Section>

        <div className="card simcfg-actions">
          <button className="btn btn-primary" onClick={save} disabled={saving || !form.id || !form.imsi}>Save</button>
          {form.id && <button className="btn btn-danger" onClick={del}>Delete</button>}
          <span className="hint" style={{ margin: 0 }}>Restart the line after saving for most changes to apply.</span>
        </div>
      </div>
      </div>
    </div>
  )
}
