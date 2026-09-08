import { describe, expect, it } from 'vitest'
import {
  COLLISION_SUFFIXES,
  collisionIsHidden,
  collisionKind,
  DEFAULT_PLAYER_CONTROLLER,
  PLAYER_CONTROLLER_EXTRA_KEYS,
  readPlayerController,
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
