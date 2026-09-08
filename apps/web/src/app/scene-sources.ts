export interface SceneSource {
  id: string
  label: string
  url: string
}

type SearchValue = string | string[] | undefined

/**
 * Until the store exists, the page is told which GLBs to show. `scene` is the
 * current build, `version` repeats for earlier ones, and `build` changes
 * whenever the agent rewrites the same URL.
 */
export function sceneSources(
  params: Record<string, SearchValue>,
  fallback?: string,
): SceneSource[] {
  const sources: SceneSource[] = []
  const current = sceneUrl(first(params.scene) ?? fallback)

  if (current !== undefined) {
    sources.push({
      id: 'current',
      label: 'Current build',
      url: withBuild(current, first(params.build)),
    })
  }

  const versions = all(params.version)
    .map(sceneUrl)
    .filter((url) => url !== undefined)
  for (const [index, url] of versions.entries()) {
    sources.push({
      id: `version-${index + 1}`,
      label: `Earlier build ${index + 1}`,
      url,
    })
  }

  return sources
}

/**
 * A scene URL comes from the query string and ends up in the browser's loader,
 * so only same-origin paths and http(s) are honoured.
 */
function sceneUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  if (value.startsWith('//')) return undefined
  if (value.startsWith('/')) return value
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

function withBuild(url: string, build: string | undefined): string {
  if (build === undefined || build === '') return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}build=${encodeURIComponent(build)}`
}

function first(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function all(value: SearchValue): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}
