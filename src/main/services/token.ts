import { safeStorage, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'

const TOKEN_FILE = 'autodl-token.enc'

export interface TokenData {
  token: string
  cookie: string
}

function tokenPath(): string {
  return join(app.getPath('userData'), TOKEN_FILE)
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function saveAuth(token: string, cookie: string): void {
  const data: TokenData = { token, cookie }
  const encrypted = safeStorage.encryptString(JSON.stringify(data))
  writeFileSync(tokenPath(), encrypted.toString('base64'), 'utf-8')
}

export function loadAuth(): TokenData | null {
  const p = tokenPath()
  if (!existsSync(p)) return null
  try {
    const b64 = readFileSync(p, 'utf-8')
    const buffer = Buffer.from(b64, 'base64')
    const raw = safeStorage.decryptString(buffer)
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.token === 'string') {
      return { token: parsed.token, cookie: parsed.cookie || '' }
    }
    // Legacy: plain token string
    return { token: raw, cookie: '' }
  } catch {
    return null
  }
}

export function hasToken(): boolean {
  return existsSync(tokenPath())
}

export function clearToken(): void {
  const p = tokenPath()
  if (existsSync(p)) unlinkSync(p)
}
