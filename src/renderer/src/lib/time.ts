import { clock } from './clock.svelte'

export function relativeTime(iso: string, now = clock.now): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

export function relativeTimeLong(iso: string, now = clock.now): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 30) return `${d} days ago`
  return new Date(iso).toLocaleDateString()
}

export function shortModel(id: string): string {
  const tail = id.startsWith('chatgpt:') ? id.slice(8) : (id.split('/').pop() ?? id)
  return tail
    .replace(/[-_]/g, ' ')
    .replace(/\b(\w)/g, (c) => c.toUpperCase())
    .replace(/\bK(\d)/g, 'K$1')
    .replace(/\bGpt\b/g, 'GPT')
}
