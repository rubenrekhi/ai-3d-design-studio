import { cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const outdir = here('dist')
const piRoot = dirname(
  dirname(
    fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')),
  ),
)

// Two things a bundle has to supply that an installed package gets for free:
// esbuild's ESM output leaves `require`, `__dirname` and `__filename` as free
// identifiers, and pi finds its own assets by walking up from `__dirname` for a
// package.json, which no longer sits above the code. Both are fatal on the
// first import, so name pi's directory rather than let it search.
const banner = [
  "import { createRequire as __studioRequire } from 'node:module'",
  "import { dirname as __studioDirname } from 'node:path'",
  "import { fileURLToPath as __studioPath } from 'node:url'",
  'const require = __studioRequire(import.meta.url)',
  'const __filename = __studioPath(import.meta.url)',
  'const __dirname = __studioDirname(__filename)',
  'process.env.PI_PACKAGE_DIR ??= `${__dirname}/pi`',
].join('\n')

await build({
  entryPoints: [here('src/cli.ts')],
  outfile: join(outdir, 'agent.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: { js: banner },
})

// photon-node reads its wasm from beside its own file, which after bundling is
// `dist/`. Pi loads photon to resize images and swallows the failure, so a
// missing copy costs the model full-size renders rather than raising anything.
const wasm = createRequire(join(piRoot, 'index.js')).resolve(
  '@silvia-odwyer/photon-node/photon_rs_bg.wasm',
)
await cp(wasm, join(outdir, 'photon_rs_bg.wasm'))

// Pi reads these at run time instead of importing them, so the bundler cannot
// see them. The layout is pi's own: `<PI_PACKAGE_DIR>/dist/<path>`.
const assets = [
  'package.json',
  'docs',
  'dist/modes/interactive/theme',
  'dist/modes/interactive/assets',
  'dist/core/export-html',
]
for (const asset of assets) {
  await cp(join(piRoot, asset), join(outdir, 'pi', asset), { recursive: true })
}
