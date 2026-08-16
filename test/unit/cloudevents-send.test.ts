// @vitest-environment node

import { createHmac } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  cloudEventsSendUsage,
  createTestCloudEvent,
  curlConfig,
  normalizeCloudEventsHookUrl,
  parseCloudEventsCredentials,
  runCurlConfig,
  sendTestCloudEvent,
  signCloudEvent,
} from '../../scripts/cloudevents-send'
import { modeAwareFileSystem } from '../helpers/atomic-file-system'

const SLUG = 'abcdefghijklmnopqrstuv'
const HOOK_URL = `https://hooks.example.com/hook/cloudevents/${SLUG}`
const SENDER_HMAC = 'test-sender-hmac'
const EVENT_ID = '7c60e65a-741f-4b53-ac9a-795308442ba4'
const EVENT_TIME = new Date('2026-08-16T12:34:56.000Z')

describe('CloudEvents ingress sender', () => {
  it('documents concealed non-interactive input', () => {
    expect(cloudEventsSendUsage()).toContain('URL and sender HMAC are read without echoing')
    expect(cloudEventsSendUsage()).toContain('separate lines')
  })

  it('parses exactly two non-interactive credential lines', () => {
    expect(parseCloudEventsCredentials(`${HOOK_URL}\n${SENDER_HMAC}\n`)).toEqual({
      hookUrl: HOOK_URL,
      senderHmac: SENDER_HMAC,
    })
    expect(() => parseCloudEventsCredentials(HOOK_URL)).toThrow(/separate lines/)
    expect(() => parseCloudEventsCredentials(`${HOOK_URL}\n${SENDER_HMAC}\nextra\n`)).toThrow(/separate lines/)
  })

  it('accepts only private HTTPS CloudEvents subscription URLs', () => {
    expect(normalizeCloudEventsHookUrl(HOOK_URL)).toBe(HOOK_URL)
    expect(() => normalizeCloudEventsHookUrl(HOOK_URL.replace('https:', 'http:'))).toThrow(/HTTPS/)
    expect(() => normalizeCloudEventsHookUrl(HOOK_URL.replace('/cloudevents/', '/github/'))).toThrow(/CloudEvents/)
    expect(() => normalizeCloudEventsHookUrl(`${HOOK_URL}?exposed=true`)).toThrow(/unsupported/)
  })

  it('creates and signs a valid structured CloudEvent', () => {
    const event = createTestCloudEvent(EVENT_ID, EVENT_TIME)
    expect(event).toEqual({
      specversion: '1.0',
      id: EVENT_ID,
      source: 'urn:hookrelay:cloudevents-send',
      type: 'hookrelay.test',
      time: EVENT_TIME.toISOString(),
      subject: 'Hookrelay ingress test',
      severity: 'info',
      data: { message: 'Valid signed ingress test' },
    })
    const body = JSON.stringify(event)
    expect(signCloudEvent(body, SENDER_HMAC)).toBe(
      createHmac('sha256', SENDER_HMAC).update(body, 'utf8').digest('hex'),
    )
  })

  it('passes secret-bearing curl configuration through stdin only', async () => {
    const runner = vi.fn(async () => '')
    await runCurlConfig('private curl configuration', runner)
    expect(runner).toHaveBeenCalledWith('curl', ['--disable', '--config', '-'], {
      input: 'private curl configuration',
    })
  })

  it('writes an exact private body, sends it, and removes the temporary file', async () => {
    let bodyPath = ''
    const fileSystem = modeAwareFileSystem()
    const runCurl = vi.fn(async (config: string) => {
      const match = config.match(/data-binary = "@([^"]+)"/)
      expect(match).not.toBeNull()
      bodyPath = match![1]!
      const body = await readFile(bodyPath, 'utf8')
      const info = await fileSystem.lstat(bodyPath)
      expect(info.mode & 0o777).toBe(0o600)
      const event = JSON.parse(body) as Record<string, unknown>
      expect(event).toMatchObject({ specversion: '1.0', id: EVENT_ID, type: 'hookrelay.test' })
      const signature = createHmac('sha256', SENDER_HMAC).update(body, 'utf8').digest('hex')
      expect(config).toBe(curlConfig(HOOK_URL, signature, bodyPath))
      expect(config).not.toContain(SENDER_HMAC)
    })
    const log = vi.fn()

    await expect(sendTestCloudEvent({
      now: () => EVENT_TIME,
      randomId: () => EVENT_ID,
      readCredentials: async () => ({ hookUrl: HOOK_URL, senderHmac: SENDER_HMAC }),
      runCurl,
      log,
      fileSystem,
    })).resolves.toEqual({ id: EVENT_ID, type: 'hookrelay.test' })

    expect(runCurl).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(`Sent CloudEvent ${EVENT_ID} (hookrelay.test)`)
    await expect(lstat(bodyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
