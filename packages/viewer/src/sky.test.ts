import { describe, expect, it } from 'vitest'
import { averageRadiance, skyEnvironmentIntensity } from './sky'

const clear = { turbidity: 3, cloudCoverage: 0 }
const elevation = (degrees: number) => Math.sin((degrees * Math.PI) / 180)

describe('averageRadiance', () => {
  it('tracks the sun up and down the sky', () => {
    const noon = averageRadiance(clear, elevation(70))
    const golden = averageRadiance(clear, elevation(5))
    const night = averageRadiance(clear, elevation(-10))
    expect(noon).toBeCloseTo(4.29, 1)
    expect(golden).toBeCloseTo(0.49, 1)
    expect(night).toBeLessThan(0.01)
  })

  it('brightens with haze', () => {
    expect(
      averageRadiance({ turbidity: 12, cloudCoverage: 0 }, elevation(20)),
    ).toBeGreaterThan(averageRadiance(clear, elevation(20)))
  })
})

describe('skyEnvironmentIntensity', () => {
  it('holds ambient to a share of the sun whatever the hour', () => {
    // Left at 1 the model lights every surface at half the sun's strength and
    // the scene washes white; each of these lands near 18% instead.
    for (const [degrees, sun] of [
      [70, 5],
      [16.7, 3],
      [5, 3],
    ] as const) {
      const intensity = skyEnvironmentIntensity(clear, elevation(degrees), sun)
      const ambient = intensity * averageRadiance(clear, elevation(degrees))
      expect(ambient / sun).toBeCloseTo(0.18, 2)
    }
  })

  it('leaves a set sun dark rather than amplifying a black sky', () => {
    const intensity = skyEnvironmentIntensity(clear, elevation(-10), 0.5)
    expect(intensity).toBeLessThanOrEqual(10)
    expect(intensity * averageRadiance(clear, elevation(-10))).toBeLessThan(0.1)
  })
})
