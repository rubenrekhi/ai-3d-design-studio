export const SCENE_CONTRACT_VERSION = 1
export const SCENE_SETTINGS_NAME = '__studio_scene_settings__'
export const PLAYER_SPAWN_NAME = '__studio_player_spawn__'

export const SCENE_KIND_EXTRA = 'studio_scene_kind'
export const SKY_EXTRA = 'studio_sky'
export const CONTRACT_VERSION_EXTRA = 'studio_contract_version'
export const SOURCE_NAME_EXTRA = 'studio_source_name'

export const COLLISION_SUFFIXES = {
  visibleTrimesh: '-col',
  hiddenTrimesh: '-colonly',
  hiddenConvex: '-convcolonly',
} as const

export type CollisionKind = keyof typeof COLLISION_SUFFIXES
export type SceneKind = 'asset' | 'environment'

const COLLISION_SUFFIX_ENTRIES = (
  Object.entries(COLLISION_SUFFIXES) as [CollisionKind, string][]
).sort((left, right) => right[1].length - left[1].length)

export function collisionKind(name: string): CollisionKind | undefined {
  return COLLISION_SUFFIX_ENTRIES.find(([, suffix]) =>
    name.endsWith(suffix),
  )?.[0]
}

export function collisionIsHidden(kind: CollisionKind): boolean {
  return kind !== 'visibleTrimesh'
}

export function sourceName(
  exportedName: string,
  extras: Readonly<Record<string, unknown>>,
): string {
  const preserved = extras[SOURCE_NAME_EXTRA]
  return typeof preserved === 'string' && preserved.length > 0
    ? preserved
    : exportedName
}

export const PLAYER_CONTROLLER_EXTRA_KEYS = {
  height: 'studio_player_height_m',
  radius: 'studio_player_radius_m',
  eyeHeight: 'studio_eye_height_m',
  walkSpeed: 'studio_walk_speed_mps',
  runSpeed: 'studio_run_speed_mps',
  jumpSpeed: 'studio_jump_speed_mps',
  gravity: 'studio_gravity_mps2',
  maxSlopeDegrees: 'studio_max_slope_degrees',
  fallResetDistance: 'studio_fall_reset_m',
} as const

export interface PlayerControllerConfig {
  height: number
  radius: number
  eyeHeight: number
  walkSpeed: number
  runSpeed: number
  jumpSpeed: number
  gravity: number
  maxSlopeDegrees: number
  fallResetDistance: number
}

/**
 * Speeds read slower through a 50° first-person camera than they do on foot,
 * because the peripheral vision that sells motion is missing. These are what a
 * brisk walk and a run feel like on screen, not what they measure in life.
 */
export const DEFAULT_PLAYER_CONTROLLER: Readonly<PlayerControllerConfig> = {
  height: 1.8,
  radius: 0.35,
  eyeHeight: 1.65,
  walkSpeed: 4.5,
  runSpeed: 8,
  jumpSpeed: 5,
  gravity: 9.81,
  maxSlopeDegrees: 50,
  fallResetDistance: 12,
}

export const PLAYER_CONTROLLER_LIMITS: {
  [Key in keyof PlayerControllerConfig]: readonly [number, number]
} = {
  height: [0.5, 4],
  radius: [0.1, 1],
  eyeHeight: [0.2, 4],
  walkSpeed: [0.1, 20],
  runSpeed: [0.1, 30],
  jumpSpeed: [0, 20],
  gravity: [0.1, 50],
  maxSlopeDegrees: [0, 89],
  fallResetDistance: [1, 1_000],
}

export interface ControllerReadResult {
  config: PlayerControllerConfig
  errors: string[]
}

export function readPlayerController(
  extras: Readonly<Record<string, unknown>>,
): ControllerReadResult {
  const config = { ...DEFAULT_PLAYER_CONTROLLER }
  const errors: string[] = []

  for (const key of Object.keys(
    PLAYER_CONTROLLER_EXTRA_KEYS,
  ) as (keyof PlayerControllerConfig)[]) {
    const extra = PLAYER_CONTROLLER_EXTRA_KEYS[key]
    const value = extras[extra]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${extra} must be a finite number`)
      continue
    }
    const [minimum, maximum] = PLAYER_CONTROLLER_LIMITS[key]
    if (value < minimum || value > maximum) {
      errors.push(`${extra} must be between ${minimum} and ${maximum}`)
      continue
    }
    config[key] = value
  }

  if (config.radius * 2 >= config.height) {
    errors.push(
      `${PLAYER_CONTROLLER_EXTRA_KEYS.radius} must be less than half ${PLAYER_CONTROLLER_EXTRA_KEYS.height}`,
    )
  }
  if (config.eyeHeight > config.height) {
    errors.push(
      `${PLAYER_CONTROLLER_EXTRA_KEYS.eyeHeight} cannot exceed ${PLAYER_CONTROLLER_EXTRA_KEYS.height}`,
    )
  }
  if (config.runSpeed < config.walkSpeed) {
    errors.push(
      `${PLAYER_CONTROLLER_EXTRA_KEYS.runSpeed} cannot be lower than ${PLAYER_CONTROLLER_EXTRA_KEYS.walkSpeed}`,
    )
  }

  return { config, errors }
}

export function readSceneKind(
  extras: Readonly<Record<string, unknown>>,
): SceneKind | undefined {
  const value = extras[SCENE_KIND_EXTRA]
  return value === 'asset' || value === 'environment' ? value : undefined
}

export function readContractVersion(
  extras: Readonly<Record<string, unknown>>,
): number | undefined {
  const value = extras[CONTRACT_VERSION_EXTRA]
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined
}

export type SkyKind = 'daylight' | 'none'

export const SKY_EXTRA_KEYS = {
  turbidity: 'studio_sky_turbidity',
  cloudCoverage: 'studio_sky_cloud_coverage',
} as const

export interface SkyConfig {
  turbidity: number
  cloudCoverage: number
}

/**
 * Clear by default. The sky shader skips its noise entirely when coverage is
 * zero, so cloud is the one setting here that costs frames rather than nothing.
 */
export const DEFAULT_SKY: Readonly<SkyConfig> = {
  turbidity: 3,
  cloudCoverage: 0,
}

export const SKY_LIMITS: {
  [Key in keyof SkyConfig]: readonly [number, number]
} = {
  turbidity: [1, 20],
  cloudCoverage: [0, 1],
}

export interface SkyReadResult {
  kind: SkyKind
  config: SkyConfig
  errors: string[]
}

/**
 * A walkable scene gets a sky unless it asks not to; an asset is one object on
 * a neutral field and would only be lit oddly by one.
 */
export function readSky(
  extras: Readonly<Record<string, unknown>>,
  sceneKind: SceneKind | undefined,
): SkyReadResult {
  const config = { ...DEFAULT_SKY }
  const errors: string[] = []
  const declared = extras[SKY_EXTRA]
  let kind: SkyKind = sceneKind === 'environment' ? 'daylight' : 'none'

  if (declared !== undefined) {
    if (declared === 'daylight' || declared === 'none') {
      kind = declared
    } else {
      errors.push(`${SKY_EXTRA} must be 'daylight' or 'none'`)
    }
  }

  for (const key of Object.keys(SKY_EXTRA_KEYS) as (keyof SkyConfig)[]) {
    const extra = SKY_EXTRA_KEYS[key]
    const value = extras[extra]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${extra} must be a finite number`)
      continue
    }
    const [minimum, maximum] = SKY_LIMITS[key]
    if (value < minimum || value > maximum) {
      errors.push(`${extra} must be between ${minimum} and ${maximum}`)
      continue
    }
    config[key] = value
  }

  return { kind, config, errors }
}
