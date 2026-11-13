import { z } from 'zod'
import { HANDOFF_KEYS, HandoffUnavailableError, handoffBundleSchema, handoffHmacName, handoffRepositorySchema, type HandoffBundle } from './github-handoff'

const LIMITS = Object.freeze({ KEY_BYTES: 32, NONCE_BYTES: 12, TAG_BITS: 128, KEYRING_BYTES: 32768, PAYLOAD_BYTES: 16384, KEYS: 8 })
type Environment = { HOOK_HANDOFF_KEYS?: string }
export const handoffBindingSchema = z.object({
  authorityId: z.string().regex(/^[a-f0-9]{32}$/), workspaceId: z.string().min(1).max(240),
  repositoryId: z.uuid(), repository: handoffRepositorySchema, revision: z.number().int().positive(),
}).strict()
export type HandoffBinding = z.infer<typeof handoffBindingSchema>
export const encryptedHandoffSchema = z.object({
  keyId: z.string().min(1).max(64), nonce: z.string().max(32), ciphertext: z.string().max(24000),
}).strict()
export type EncryptedHandoff = z.infer<typeof encryptedHandoffSchema>
const ringSchema = z.object({
  version: z.literal(1), activeKeyId: z.string().min(1).max(64),
  keys: z.array(z.object({ id: z.string().min(1).max(64), key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
    .refine(value => { try { return atob(value).length === LIMITS.KEY_BYTES && btoa(atob(value)) === value } catch { return false } }),
  }).strict()).min(1).max(LIMITS.KEYS),
}).strict().refine(ring => new Set(ring.keys.map(key => key.id)).size === ring.keys.length && ring.keys.some(key => key.id === ring.activeKeyId))
const encoder = new TextEncoder()
function ring(env: Environment) {
  const raw = env[HANDOFF_KEYS]
  if (!raw || raw.length > LIMITS.KEYRING_BYTES) throw new HandoffUnavailableError()
  return ringSchema.parse(JSON.parse(raw))
}
export function handoffKeyStatus(env: Environment): boolean {
  try { return Boolean(ring(env)) } catch { return false }
}
function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)) }
function decode(value: string, limit: number): Uint8Array {
  if (value.length > Math.ceil(limit / 3) * 4) throw new HandoffUnavailableError()
  const decoded = atob(value)
  if (decoded.length > limit || btoa(decoded) !== value) throw new HandoffUnavailableError()
  return Uint8Array.from(decoded, value => value.charCodeAt(0))
}
async function key(env: Environment, id?: string) {
  const available = ring(env)
  const selected = available.keys.find(key => key.id === (id ?? available.activeKeyId))
  if (!selected) throw new HandoffUnavailableError()
  const bytes = decode(selected.key, LIMITS.KEY_BYTES)
  try {
    if (bytes.length !== LIMITS.KEY_BYTES) throw new HandoffUnavailableError()
    return { id: selected.id, key: await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) }
  } finally { bytes.fill(0) }
}
function aad(binding: HandoffBinding, keyId: string): Uint8Array {
  return encoder.encode(JSON.stringify({ purpose: 'hookrelay.github-handoff.v1', keyId, binding: handoffBindingSchema.parse(binding) }))
}
function bundleFor(binding: HandoffBinding, value: unknown): HandoffBundle {
  const bundle = handoffBundleSchema.parse(value)
  if (bundle.hmac.name !== handoffHmacName(binding.repository)) throw new HandoffUnavailableError()
  return bundle
}
export async function sealHandoffBundle(env: Environment, binding: HandoffBinding, bundle: HandoffBundle): Promise<EncryptedHandoff> {
  let plaintext: Uint8Array | undefined
  try {
    const selected = await key(env)
    plaintext = encoder.encode(JSON.stringify(bundleFor(binding, bundle)))
    if (plaintext.length > LIMITS.PAYLOAD_BYTES) throw new HandoffUnavailableError()
    const nonce = crypto.getRandomValues(new Uint8Array(LIMITS.NONCE_BYTES))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(binding, selected.id), tagLength: LIMITS.TAG_BITS }, selected.key, plaintext))
    return { keyId: selected.id, nonce: encode(nonce), ciphertext: encode(ciphertext) }
  } catch { throw new HandoffUnavailableError() } finally { plaintext?.fill(0) }
}
export async function openHandoffBundle(env: Environment, binding: HandoffBinding, encrypted: EncryptedHandoff): Promise<HandoffBundle> {
  let plaintext: Uint8Array | undefined
  try {
    const saved = encryptedHandoffSchema.parse(encrypted)
    const selected = await key(env, saved.keyId)
    const nonce = decode(saved.nonce, LIMITS.NONCE_BYTES)
    if (nonce.length !== LIMITS.NONCE_BYTES) throw new HandoffUnavailableError()
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(binding, selected.id), tagLength: LIMITS.TAG_BITS }, selected.key, decode(saved.ciphertext, LIMITS.PAYLOAD_BYTES + LIMITS.TAG_BITS / 8)))
    return bundleFor(binding, JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext)))
  } catch { throw new HandoffUnavailableError() } finally { plaintext?.fill(0) }
}

export async function sealProtectedValue(env: Environment, purpose: string, binding: unknown, value: unknown): Promise<EncryptedHandoff> {
  let plaintext: Uint8Array | undefined
  try {
    const selected = await key(env)
    plaintext = encoder.encode(JSON.stringify(value))
    if (plaintext.length > LIMITS.PAYLOAD_BYTES) throw new HandoffUnavailableError()
    const nonce = crypto.getRandomValues(new Uint8Array(LIMITS.NONCE_BYTES))
    const additionalData = encoder.encode(JSON.stringify({ purpose, keyId: selected.id, binding }))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData, tagLength: LIMITS.TAG_BITS }, selected.key, plaintext))
    return { keyId: selected.id, nonce: encode(nonce), ciphertext: encode(ciphertext) }
  } catch { throw new HandoffUnavailableError() } finally { plaintext?.fill(0) }
}
export async function openProtectedValue(env: Environment, purpose: string, binding: unknown, value: unknown): Promise<unknown> {
  let plaintext: Uint8Array | undefined
  try {
    const saved = encryptedHandoffSchema.parse(value)
    const selected = await key(env, saved.keyId)
    const nonce = decode(saved.nonce, LIMITS.NONCE_BYTES)
    if (nonce.length !== LIMITS.NONCE_BYTES) throw new HandoffUnavailableError()
    const additionalData = encoder.encode(JSON.stringify({ purpose, keyId: selected.id, binding }))
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData, tagLength: LIMITS.TAG_BITS }, selected.key, decode(saved.ciphertext, LIMITS.PAYLOAD_BYTES + LIMITS.TAG_BITS / 8)))
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext)) as unknown
  } catch { throw new HandoffUnavailableError() } finally { plaintext?.fill(0) }
}
