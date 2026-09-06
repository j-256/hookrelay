import { z } from 'zod'

export const MANAGEMENT_PATH = '/admin/api/v1'
export const MANAGEMENT_VERSION = 1
export const MANAGEMENT_LIMITS = Object.freeze({
  BODY_BYTES: 16384,
  BODY_TIMEOUT_MS: 10000,
  PAGE_SIZE: 25,
  HEALTH_SAMPLE: 1000,
  SUBSCRIPTION_BYTES: 32768,
  PENDING_PLANS: 25,
  PLAN_TTL_MS: 5 * 60 * 1000,
  RECEIPT_DAYS: 30,
  PRUNE_BATCH: 100,
  CREDENTIAL_BYTES: 32768,
})
export const DELIVERY_STATES = [
  'pending', 'queued', 'processing', 'retrying', 'delivered', 'filtered', 'exhausted',
] as const
export const managementId = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:@-]+$/)
export const managementName = z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/)
const context = z.object({ workspaceId: managementId, actorId: managementId }).strict()
const delivery = context.extend({ eventId: managementId, sinkName: managementName }).strict()
export const deliveryCursor = z.object({
  updatedAt: z.iso.datetime(), eventId: managementId, sinkName: managementName,
}).strict()
export const managementInputs = {
  snapshot: context,
  subscriptions: context.extend({ cursor: z.string().max(8192).nullable().default(null) }).strict(),
  deliveries: context.extend({
    status: z.enum(DELIVERY_STATES).nullable().default(null),
    subscription: managementName.nullable().default(null),
    cursor: deliveryCursor.nullable().default(null),
  }).strict(),
  delivery,
  retry_plan: delivery.extend({
    planId: z.uuid(), generation: z.number().int().min(0), updatedAt: z.iso.datetime(),
  }).strict(),
  retry_apply: context.extend({ planId: z.uuid() }).strict(),
  retry_get: context.extend({ planId: z.uuid() }).strict(),
} as const
export const managementEnvelope = z.object({
  command: z.enum(Object.keys(managementInputs) as [keyof typeof managementInputs]),
  input: z.unknown(),
}).strict()
export type ManagementContext = z.infer<typeof context>
export type RetryInput = z.infer<typeof managementInputs.retry_plan>

export class ManagementError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
  }
}

export function managementResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    },
  })
}

export async function readManagementBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    throw new ManagementError('media_type', 415, 'Send application/json')
  }
  const reader = request.body?.getReader()
  if (!reader) throw new ManagementError('validation', 400, 'A JSON body is required')
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new ManagementError('request_timeout', 408, 'The request body timed out'))
      void reader.cancel().catch(() => {})
    }, MANAGEMENT_LIMITS.BODY_TIMEOUT_MS)
  })
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), expired])
      if (done) break
      size += value.byteLength
      if (size > MANAGEMENT_LIMITS.BODY_BYTES) {
        void reader.cancel().catch(() => {})
        throw new ManagementError('too_large', 413, 'The request exceeds the management input limit')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch {
      throw new ManagementError('validation', 400, 'Send valid JSON')
    }
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
  }
}
