import type { SkyConfig } from '@repo/scene-contract'

/**
 * How much of the sun's own strength the sky is allowed to add back as ambient.
 * Diffuse skylight outdoors runs at roughly this share of direct sun.
 */
const AMBIENT_SHARE = 0.18
/** A near-black night sky must not be amplified into coloured noise. */
const MAX_INTENSITY = 10
/** Enough to converge the integral below; it is smooth and settles by ~32. */
const SAMPLES = 32

const EE = 1000
const CUTOFF_ANGLE = 1.6110731556870734
const STEEPNESS = 1.5
const TOTAL_RAYLEIGH = [
  5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5,
]
const MIE_CONST = [
  1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14,
]
const RAYLEIGH_ZENITH_LENGTH = 8.4e3
const MIE_ZENITH_LENGTH = 1.25e3
const THREE_OVER_SIXTEENPI = 0.05968310365946075
const ONE_OVER_FOURPI = 0.07957747154594767
const RAYLEIGH = 1
const MIE_COEFFICIENT = 0.005
const MIE_DIRECTIONAL_G = 0.8
const LUMINANCE = [0.2126, 0.7152, 0.0722]

/**
 * `SkyMesh` returns raw atmospheric radiance with no tone curve, so its numbers
 * are in the model's own units — around 4 at midday, near zero once the sun
 * sets. Prefiltered into an environment map at face value that lights a scene
 * from every direction at half the strength of the sun and washes it white.
 *
 * This is the same Preetham evaluation the shader runs, averaged over the whole
 * sphere rather than a hemisphere: the shader clamps downward directions to the
 * horizon, which is the brightest part of the sky, so the lower half of the map
 * is not dark. Dividing by the result turns the model's arbitrary scale into a
 * fixed share of whatever sun the scene authored, and keeps dusk dim and noon
 * bright rather than flattening both.
 */
export function skyEnvironmentIntensity(
  config: SkyConfig,
  sunHeight: number,
  sunIntensity: number,
): number {
  const radiance = averageRadiance(config, sunHeight)
  if (radiance <= 0) return 0
  return Math.min((AMBIENT_SHARE * sunIntensity) / radiance, MAX_INTENSITY)
}

export function averageRadiance(config: SkyConfig, sunHeight: number): number {
  const height = Math.max(-1, Math.min(1, sunHeight))
  const horizontal = Math.sqrt(Math.max(0, 1 - height * height))
  const sun = [0, height, horizontal]

  const sunE =
    EE *
    Math.max(0, 1 - Math.exp(-(CUTOFF_ANGLE - Math.acos(height)) / STEEPNESS))
  // The shader divides by 450000 for a sun given as a world position; a unit
  // direction leaves this at 1, which is the sun-is-up branch.
  const sunfade = 1 - Math.min(1, Math.max(0, 1 - Math.exp(height / 450000)))
  const betaR = TOTAL_RAYLEIGH.map((v) => v * (RAYLEIGH - (1 - sunfade)))
  const turbidityTerm = 0.2 * config.turbidity * 10e-18
  const betaM = MIE_CONST.map(
    (v) => 0.434 * turbidityTerm * v * MIE_COEFFICIENT,
  )

  const total = [0, 0, 0]
  let weight = 0
  for (let i = 0; i < SAMPLES; i++) {
    const theta = ((i + 0.5) / SAMPLES) * Math.PI
    for (let j = 0; j < SAMPLES; j++) {
      const phi = ((j + 0.5) / SAMPLES) * 2 * Math.PI
      const direction = [
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      ] as const
      const solidAngle = Math.sin(theta)
      const colour = radianceAt(direction, sun, sunE, betaR, betaM)
      for (let k = 0; k < 3; k++) {
        total[k] = (total[k] as number) + (colour[k] as number) * solidAngle
      }
      weight += solidAngle
    }
  }

  return total.reduce(
    (sum, channel, k) => sum + (channel / weight) * (LUMINANCE[k] as number),
    0,
  )
}

function radianceAt(
  direction: readonly [number, number, number],
  sun: number[],
  sunE: number,
  betaR: number[],
  betaM: number[],
): number[] {
  const zenithAngle = Math.acos(Math.max(0, direction[1]))
  const inverse =
    1 /
    (Math.cos(zenithAngle) +
      0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253))
  const sR = RAYLEIGH_ZENITH_LENGTH * inverse
  const sM = MIE_ZENITH_LENGTH * inverse
  const extinction = betaR.map((b, k) =>
    Math.exp(-(b * sR + (betaM[k] as number) * sM)),
  )

  const cosTheta =
    direction[0] * (sun[0] as number) +
    direction[1] * (sun[1] as number) +
    direction[2] * (sun[2] as number)
  const rayleighPhase =
    THREE_OVER_SIXTEENPI * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2))
  const g2 = MIE_DIRECTIONAL_G * MIE_DIRECTIONAL_G
  const miePhase =
    (ONE_OVER_FOURPI * (1 - g2)) /
    Math.pow(1 - 2 * MIE_DIRECTIONAL_G * cosTheta + g2, 1.5)

  const scattered = betaR.map(
    (b, k) =>
      (sunE * (b * rayleighPhase + (betaM[k] as number) * miePhase)) /
      (b + (betaM[k] as number)),
  )
  const horizonMix = Math.min(
    1,
    Math.max(0, Math.pow(1 - (sun[1] as number), 5)),
  )
  const inScatter = scattered.map((value, k) => {
    const base = Math.pow(value * (1 - (extinction[k] as number)), 1.5)
    const horizon = Math.pow(value * (extinction[k] as number), 0.5)
    return base * (1 - horizonMix + horizon * horizonMix)
  })

  const night = extinction.map((value) => 0.1 * value)
  const offset = [0, 0.0003, 0.00075]
  return inScatter.map(
    (value, k) => (value + (night[k] as number)) * 0.04 + (offset[k] as number),
  )
}
