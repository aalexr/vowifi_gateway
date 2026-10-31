export const DOWNLOAD_STEPS = [
  ['es10a_get_euicc_configured_addresses', 'Read default SM-DP+'],
  ['es10b_get_euicc_challenge_and_info', 'Get eUICC challenge'],
  ['es9p_initiate_authentication', 'Authenticate with SM-DP+'],
  ['es10b_authenticate_server', 'Authenticate server'],
  ['es9p_authenticate_client', 'Authenticate client'],
  ['es8p_metadata_parse', 'Profile preview'],
  ['es10b_prepare_download', 'Prepare download'],
  ['es9p_get_bound_profile_package', 'Fetch profile package'],
  ['es10b_load_bound_profile_package', 'Install on eUICC'],
]

/** Map lpac progress/error names onto the pipeline. Ignore cancel_session etc. */
export function resolveDownloadStep(step) {
  const s = String(step || '')
  if (!s || s === 'started' || s === 'completed' || s === 'cancelling') return null
  // lpac may emit "es10b_load_bound_profile_package:result"
  const base = s.split(':')[0]
  const idx = DOWNLOAD_STEPS.findIndex(([k]) => k === s || k === base)
  return idx >= 0 ? DOWNLOAD_STEPS[idx][0] : null
}
export function isNonEuiccError(msg) {
  const s = String(msg || '')
  return /euicc_init|does not appear to be an eUICC|not an eUICC|ordinary USIM/i.test(s)
}

export function copyText(text, showToast) {
  if (!text) return
  navigator.clipboard?.writeText(text).then(
    () => showToast?.('Copied'),
    () => showToast?.('Copy failed'),
  )
}

export function parseActivationCode(raw) {
  let s = (raw || '').trim()
  if (!s) return null
  if (/^LPA:/i.test(s)) s = s.slice(4)
  const parts = s.split('$')
  if (parts.length < 3 || parts[0] !== '1') return null
  return {
    smdp: parts[1] || '',
    matching_id: parts[2] || '',
    confirmation_required: parts[4] === '1',
  }
}
/** Match sigmo: nickname takes priority, else profileName. */
export function profileDisplayName(p) {
  const nick = (p.profileNickname || '').trim()
  if (nick) return nick
  return (p.profileName || p.serviceProviderName || 'Profile').trim() || 'Profile'
}
export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return '—'
  const n = Number(bytes)
  if (n === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KiB', 'MiB', 'GiB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(n) / Math.log(k)))
  return `${Math.round((n / k ** i) * 100) / 100} ${sizes[i]}`
}

export function seTarget(reader, se) {
  return {
    reader,
    se_id: se?.id || se?.seId,
    aid: se?.aid || undefined,
  }
}
export function instanceForCard(card, instances) {
  if (!card) return null
  if (card.matched != null) {
    const byId = instances.find((i) => String(i.id) === String(card.matched))
    if (byId) return byId
  }
  if (card.iccid) {
    return instances.find((i) => i.iccid && i.iccid === card.iccid) || null
  }
  return null
}

export function isLineRunning(inst) {
  const st = inst?.status?.state
  return !!(st && st !== 'STOPPED')
}
