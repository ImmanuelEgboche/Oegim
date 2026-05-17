import { readFileSync } from 'fs'

// Runs in each worker thread before tests — populates process.env from .env.local
try {
  const content = readFileSync('.env.local', 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const raw = trimmed.slice(eqIdx + 1).trim()
    const value = raw.replace(/^(['"])(.*)\1$/, '$2')
    process.env[key] ??= value
  }
} catch {
  // .env.local absent in CI — rely on real env vars being set
}
