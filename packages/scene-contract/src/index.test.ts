import { describe, expect, it } from 'vitest'
import {
  COLLISION_SUFFIXES,
  collisionIsHidden,
  collisionKind,
  DEFAULT_PLAYER_CONTROLLER,
  PLAYER_CONTROLLER_EXTRA_KEYS,
  DEFAULT_SKY,
  readPlayerController,
  readSky,
  SKY_EXTRA,
  SKY_EXTRA_KEYS,
  sourceName,
  SOURCE_NAME_EXTRA,
} from './index'

describe('collision names', () => {
  it('classifies only a final collision suffix', () => {
    expect(collisionKind(`Floor${COLLISION_SUFFIXES.visibleTrimesh}`)).toBe(
      'visibleTrimesh',
    )
    expect(collisionKind(`Couch${COLLISION_SUFFIXES.hiddenConvex}`)).toBe(
      'hiddenConvex',
    )
    expect(collisionKind('Couch-convcolonly.001')).toBeUndefined()
    expect(collisionKind('uncollidable-decoration')).toBeUndefined()
  })

  it('keeps only the visible collider rendered', () => {
    expect(collisionIsHidden('visibleTrimesh')).toBe(false)
    expect(collisionIsHidden('hiddenTrimesh')).toBe(true)
    expect(collisionIsHidden('hiddenConvex')).toBe(true)
  })
})

describe('source names', () => {
  it('prefers a preserved Blender name when one exists', () => {
    expect(
      sourceName('Sanitized', { [SOURCE_NAME_EXTRA]: 'Wall-colonly' }),
    ).toBe('Wall-colonly')
    expect(sourceName('Exported', {})).toBe('Exported')
  })
})

describe('player controller extras', () => {
  it('uses human defaults and accepts valid overrides', () => {
    expect(readPlayerController({}).config).toEqual(DEFAULT_PLAYER_CONTROLLER)
    const result = readPlayerController({
      [PLAYER_CONTROLLER_EXTRA_KEYS.walkSpeed]: 2.5,
      [PLAYER_CONTROLLER_EXTRA_KEYS.runSpeed]: 7,
    })
    expect(result.errors).toEqual([])
    expect(result.config.walkSpeed).toBe(2.5)
    expect(result.config.runSpeed).toBe(7)
  })

  it('reports invalid scalar and cross-field values', () => {
    const result = readPlayerController({
      [PLAYER_CONTROLLER_EXTRA_KEYS.height]: 1,
      [PLAYER_CONTROLLER_EXTRA_KEYS.radius]: 0.6,
      [PLAYER_CONTROLLER_EXTRA_KEYS.eyeHeight]: 2,
      [PLAYER_CONTROLLER_EXTRA_KEYS.walkSpeed]: 8,
      [PLAYER_CONTROLLER_EXTRA_KEYS.runSpeed]: 3,
      [PLAYER_CONTROLLER_EXTRA_KEYS.gravity]: 'earth',
    })
    expect(result.errors).toHaveLength(4)
  })
})

describe('sky', () => {
  it('draws over a walkable scene and not over a lone asset', () => {
    expect(readSky({}, 'environment').kind).toBe('daylight')
    expect(readSky({}, 'asset').kind).toBe('none')
    expect(readSky({}, undefined).kind).toBe('none')
    expect(readSky({ [SKY_EXTRA]: 'none' }, 'environment').kind).toBe('none')
    expect(readSky({ [SKY_EXTRA]: 'daylight' }, 'asset').kind).toBe('daylight')
  })

  it('uses clear-day defaults and accepts haze and cloud', () => {
    expect(readSky({}, 'environment').config).toEqual(DEFAULT_SKY)
    const result = readSky(
      {
        [SKY_EXTRA_KEYS.turbidity]: 9,
        [SKY_EXTRA_KEYS.cloudCoverage]: 0.8,
      },
      'environment',
    )
    expect(result.errors).toEqual([])
    expect(result.config).toEqual({ turbidity: 9, cloudCoverage: 0.8 })
    expect(DEFAULT_SKY.cloudCoverage).toBe(0)
  })

  it('reports values it cannot draw', () => {
    const result = readSky(
      {
        [SKY_EXTRA]: 'starfield',
        [SKY_EXTRA_KEYS.turbidity]: 60,
        [SKY_EXTRA_KEYS.cloudCoverage]: 'heavy',
      },
      'environment',
    )
    expect(result.errors).toHaveLength(3)
    expect(result.config).toEqual(DEFAULT_SKY)
  })
})
