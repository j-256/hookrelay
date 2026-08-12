import { describe, expect, it } from 'vitest'
import {
  GITHUB_EVENT_MODES,
  GITHUB_RECOMMENDED_EVENTS,
  githubEventsForMode,
  isGitHubEventMode,
} from '../../scripts/github-events'

describe('GitHub event modes', () => {
  it('supports the four user-facing modes', () => {
    expect(GITHUB_EVENT_MODES).toEqual(['push', 'all', 'recommended', 'manual'])
    expect(GITHUB_EVENT_MODES.every(isGitHubEventMode)).toBe(true)
  })

  it('maps push and all to GitHub API event lists', () => {
    expect(githubEventsForMode('push')).toEqual(['push'])
    expect(githubEventsForMode('all')).toEqual(['*'])
    expect(githubEventsForMode('manual')).toBeNull()
  })

  it('keeps the recommended set unique and avoids high-volume duplicate signals', () => {
    expect(new Set(GITHUB_RECOMMENDED_EVENTS).size).toBe(GITHUB_RECOMMENDED_EVENTS.length)
    expect(GITHUB_RECOMMENDED_EVENTS).toContain('workflow_run')
    expect(GITHUB_RECOMMENDED_EVENTS).toContain('secret_scanning_alert')
    expect(GITHUB_RECOMMENDED_EVENTS).not.toContain('push')
    expect(GITHUB_RECOMMENDED_EVENTS).not.toContain('check_run')
    expect(GITHUB_RECOMMENDED_EVENTS).not.toContain('status')
  })
})
