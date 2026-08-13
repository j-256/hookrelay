import { describe, expect, it } from 'vitest'
import {
  emptyGitHubFleetManifest,
  generateGitHubFleetManifestRepository,
  parseGitHubFleetManifest,
  serializeGitHubFleetManifest,
  withGitHubFleetManifestRepository,
} from '../../scripts/github-fleet-manifest'

const FIRST_SLUG = 'abcdefghijklmnopqrstuv'
const SECOND_SLUG = 'zyxwvutsrqponmlkjihgfe'
const THIRD_SLUG = '0123456789abcdefghijkl'

function entry(repo: string, value = `${repo}-secret`, slugs = {
  activity: FIRST_SLUG,
  stars: SECOND_SLUG,
  alerts: THIRD_SLUG,
}) {
  return {
    hmac: {
      name: `HMAC_GITHUB_${repo.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
      value,
    },
    slugs,
  }
}

describe('GitHub fleet manifest', () => {
  it('parses strict versioned JSON and rejects unknown fields', () => {
    const text = serializeGitHubFleetManifest({
      version: 1,
      repositories: { 'example-owner/example-repo': entry('example-owner/example-repo') },
    })
    expect(parseGitHubFleetManifest(text).repositories['example-owner/example-repo']?.hmac.name).toBe('HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO')
    expect(() => parseGitHubFleetManifest(text.replace('"version": 1', '"version": 1, "extra": true'))).toThrow(/Unrecognized key/)
    expect(() => parseGitHubFleetManifest('{')).toThrow(/parse/)
  })

  it('serializes repositories in stable order with a trailing newline', () => {
    const text = serializeGitHubFleetManifest({
      version: 1,
      repositories: {
        'z-owner/z-repo': entry('z-owner/z-repo', 'z-secret', {
          activity: FIRST_SLUG.toUpperCase(),
          stars: SECOND_SLUG.toUpperCase(),
          alerts: THIRD_SLUG.toUpperCase(),
        }),
        'a-owner/a-repo': entry('a-owner/a-repo', 'a-secret'),
      },
    })
    expect(text.indexOf('a-owner/a-repo')).toBeLessThan(text.indexOf('z-owner/z-repo'))
    expect(text.endsWith('\n')).toBe(true)
    expect(serializeGitHubFleetManifest(parseGitHubFleetManifest(text))).toBe(text)
  })

  it('generates one HMAC and three distinct slugs without regenerating saved values', () => {
    const slugs = [FIRST_SLUG, SECOND_SLUG, THIRD_SLUG]
    const generated = generateGitHubFleetManifestRepository('example-owner/example-repo', {
      hmac: () => 'generated-secret',
      slug: () => slugs.shift()!,
    })
    const saved = withGitHubFleetManifestRepository(emptyGitHubFleetManifest(), 'example-owner/example-repo', generated)
    const reparsed = parseGitHubFleetManifest(serializeGitHubFleetManifest(saved))
    expect(reparsed.repositories['example-owner/example-repo']).toEqual(generated)
  })

  it('rejects recovered values that disagree without exposing either value', () => {
    const original = entry('example-owner/example-repo', 'original-secret')
    const manifest = withGitHubFleetManifestRepository(emptyGitHubFleetManifest(), 'example-owner/example-repo', original)
    let error: Error | undefined
    try {
      withGitHubFleetManifestRepository(manifest, 'example-owner/example-repo', entry('example-owner/example-repo', 'different-secret'))
    } catch (err) {
      error = err as Error
    }
    expect(error?.message).toMatch(/disagrees/)
    expect(error?.message).not.toContain('original-secret')
    expect(error?.message).not.toContain('different-secret')
  })

  it('preserves retiring HMACs while requiring them to differ from canonical', () => {
    const site = {
      ...entry('example-owner/example-repo'),
      retiringHmacs: {
        stars: { name: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_STARS', value: 'retiring-secret' },
      },
    }
    const text = serializeGitHubFleetManifest({ version: 1, repositories: { 'example-owner/example-repo': site } })
    expect(parseGitHubFleetManifest(text).repositories['example-owner/example-repo']?.retiringHmacs?.stars).toEqual(
      site.retiringHmacs.stars,
    )
    expect(() => serializeGitHubFleetManifest({
      version: 1,
      repositories: {
        'example-owner/example-repo': {
          ...entry('example-owner/example-repo'),
          retiringHmacs: { stars: entry('example-owner/example-repo').hmac },
        },
      },
    })).toThrow(/must differ/)
    expect(() => serializeGitHubFleetManifest({
      version: 1,
      repositories: {
        'example-owner/example-repo': {
          ...entry('example-owner/example-repo'),
          retiringHmacs: {
            stars: { name: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_STARS', value: 'shared-retiring-secret' },
            alerts: { name: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_ALERTS', value: 'shared-retiring-secret' },
          },
        },
      },
    })).toThrow(/must be distinct/)
  })
})
