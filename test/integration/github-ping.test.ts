import { applyD1Migrations, createExecutionContext, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/index'
import { hmacSha256Hex } from '../../src/lib/hmac'
import { subscriptionKvKeyForSlug } from '../../src/lib/subscription'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'

const SUB_SLUG = 'github-ping-aaaaaaaaaaa'
const SUB_KEY = await subscriptionKvKeyForSlug(SUB_SLUG)
const SECRET_NAME = 'HMAC_GITHUB_PING'
const SECRET_VALUE = 'shhh'
const ALTERNATE_SECRET_NAME = 'HMAC_GITHUB_PING_ALTERNATE'
const ALTERNATE_SECRET_VALUE = 'also-shhh'
;(env as unknown as Record<string, string>)[SECRET_NAME] = SECRET_VALUE
;(env as unknown as Record<string, string>)[ALTERNATE_SECRET_NAME] = ALTERNATE_SECRET_VALUE

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM deliveries; DELETE FROM events;')
  await env.SUBS.put(
    SUB_KEY,
    JSON.stringify({
      name: 'github-ping',
      source: 'github',
      enabled: true,
      sinks: ['phone'],
      auth: {
        scheme: 'github-sha256',
        secretEnv: SECRET_NAME,
        alternateSecretEnvs: [ALTERNATE_SECRET_NAME],
      },
    }),
  )
})

afterEach(async () => {
  await env.SUBS.delete(SUB_KEY)
})

describe('GitHub ping delivery', () => {
  it('persists the ping without creating sink deliveries', async () => {
    const payload = JSON.stringify({
      zen: 'Keep it logically awesome.',
      hook_id: 123,
      repository: { full_name: 'example-owner/example-repo' },
    })
    const raw = new TextEncoder().encode(payload)
    const signature = await hmacSha256Hex(SECRET_VALUE, raw)
    const queue = recordingQueue()
    const testEnv = withDeliveryQueue(env as unknown as Env, queue.binding)
    const response = await worker.fetch(
      new Request(`https://hooks.example.com/hook/github/${SUB_SLUG}`, {
        method: 'POST',
        body: raw,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-github-delivery': 'ping-delivery-1',
          'x-hub-signature-256': `sha256=${signature}`,
        },
      }),
      testEnv,
      createExecutionContext(),
    )

    expect(response.status).toBe(200)
    expect(queue.messages).toEqual([])

    const event = await env.EVENTS_DB.prepare(
      'SELECT id, type, title FROM events WHERE id = ?',
    )
      .bind('github:ping-delivery-1')
      .first<{ id: string; type: string; title: string }>()
    const deliveries = await env.EVENTS_DB.prepare(
      'SELECT COUNT(*) AS count FROM deliveries WHERE event_id = ?',
    )
      .bind('github:ping-delivery-1')
      .first<{ count: number }>()

    expect(event).toMatchObject({
      id: 'github:ping-delivery-1',
      type: 'ping.event',
      title: 'example-owner/example-repo: ping.event',
    })
    expect(deliveries?.count).toBe(0)
  })

  it('accepts a ping signed with an alternate secret', async () => {
    const payload = JSON.stringify({
      zen: 'Keep it logically awesome.',
      hook_id: 123,
      repository: { full_name: 'example-owner/example-repo' },
    })
    const raw = new TextEncoder().encode(payload)
    const signature = await hmacSha256Hex(ALTERNATE_SECRET_VALUE, raw)
    const queue = recordingQueue()
    const testEnv = withDeliveryQueue(env as unknown as Env, queue.binding)
    const response = await worker.fetch(
      new Request(`https://hooks.example.com/hook/github/${SUB_SLUG}`, {
        method: 'POST',
        body: raw,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-github-delivery': 'ping-delivery-alternate',
          'x-hub-signature-256': `sha256=${signature}`,
        },
      }),
      testEnv,
      createExecutionContext(),
    )

    expect(response.status).toBe(200)
    expect(queue.messages).toEqual([])
    await expect(
      env.EVENTS_DB.prepare('SELECT id FROM events WHERE id = ?')
        .bind('github:ping-delivery-alternate')
        .first<{ id: string }>(),
    ).resolves.toEqual({ id: 'github:ping-delivery-alternate' })
  })
})
