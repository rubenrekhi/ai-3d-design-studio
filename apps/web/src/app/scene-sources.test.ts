import { describe, expect, it } from 'vitest'
import { sceneSources } from './scene-sources'

describe('sceneSources', () => {
  it('falls back to the configured scene when the query names none', () => {
    expect(sceneSources({}, '/scene.glb')).toEqual([
      { id: 'current', label: 'Current build', url: '/scene.glb' },
    ])
    expect(sceneSources({})).toEqual([])
  })

  it('busts the cache for a URL the agent rebuilt in place', () => {
    expect(sceneSources({ scene: '/scene.glb', build: '4' })[0]?.url).toBe(
      '/scene.glb?build=4',
    )
    expect(
      sceneSources({ scene: 'https://blobs.test/s.glb?token=a', build: '4' })[0]
        ?.url,
    ).toBe('https://blobs.test/s.glb?token=a&build=4')
  })

  it('numbers earlier builds and leaves them uncached', () => {
    expect(
      sceneSources({ scene: '/scene.glb', version: ['/v1.glb', '/v2.glb'] }),
    ).toEqual([
      { id: 'current', label: 'Current build', url: '/scene.glb' },
      { id: 'version-1', label: 'Earlier build 1', url: '/v1.glb' },
      { id: 'version-2', label: 'Earlier build 2', url: '/v2.glb' },
    ])
  })

  it('drops a URL the browser must not be handed', () => {
    expect(sceneSources({ scene: 'javascript:alert(1)' })).toEqual([])
    expect(
      sceneSources({ scene: 'data:model/gltf-binary;base64,AAAA' }),
    ).toEqual([])
    expect(sceneSources({ scene: '//elsewhere.test/scene.glb' })).toEqual([])
    expect(sceneSources({ scene: 'not a url' })).toEqual([])
  })

  it('keeps numbering contiguous when a version is dropped', () => {
    expect(
      sceneSources({ version: ['javascript:alert(1)', '/v2.glb'] }),
    ).toEqual([{ id: 'version-1', label: 'Earlier build 1', url: '/v2.glb' }])
  })
})
