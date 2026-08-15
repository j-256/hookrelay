import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import { subscriptionKvKeyForSlug } from '../../src/lib/subscription'

const SUB_SLUG = 'badauth-aaaaaaaaaaaaaaaaa'
const SUB_KEY = await subscriptionKvKeyForSlug(SUB_SLUG)
const SECRET_NAME = 'HMAC_BADAUTH'
;(env as unknown as Record<string, string>)[SECRET_NAME] = 'shhh'

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM operational_alert_deliveries; DELETE FROM operational_signals')
  await env.SUBS.put(
    SUB_KEY,
    JSON.stringify({
      name: 'badauth',
      source: 'github',
      enabled: true,
      sinks: [],
      auth: { scheme: 'github-sha256', secretEnv: SECRET_NAME },
    }),
  )
})

afterEach(async () => {
  await env.SUBS.delete(SUB_KEY)
})

describe('bad HMAC signature', () => {
  it('returns 401 when X-Hub-Signature-256 is wrong', async () => {
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await worker.fetch(
      new Request(`https://hooks.example.com/hook/github/${SUB_SLUG}`, {
        method: 'POST',
        body: '{"action":"opened","repository":{"full_name":"x/y"},"issue":{"number":1,"title":"t","html_url":"http://x"}}',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': '11111111-2222-3333-4444-555555555555',
          'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
        },
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(401)
    await expect(
      env.EVENTS_DB.prepare(
        'SELECT code, summary, source, sub_name, occurrences FROM operational_signals',
      ).first(),
    ).resolves.toEqual({
      code: 'ingress-authentication-rejected',
      summary: 'A known route rejected webhook authentication',
      source: 'github',
      sub_name: 'badauth',
      occurrences: 1,
    })
  })

  it('returns 401 when X-Hub-Signature-256 is missing', async () => {
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await worker.fetch(
      new Request(`https://hooks.example.com/hook/github/${SUB_SLUG}`, {
        method: 'POST',
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-github-delivery': 'd-1',
        },
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(401)
  })
})
