/**
 * esbuild → één IIFE-global `window.MtgCollabEditor` (geen module-loader nodig op de PHP-pagina).
 * Output: dist/mtg-collab-editor.min.js — kopieer dat naar de Vergaderingen-module en laad via <script>.
 *   node build.mjs            (eenmalige build)
 *   node build.mjs --watch    (rebuild bij wijziging)
 */
import * as esbuild from 'esbuild'

const opts = {
  entryPoints: ['src/editor.js'],
  bundle: true,
  format: 'iife',
  globalName: 'MtgCollabEditor',
  minify: true,
  sourcemap: true,
  target: ['es2020'],
  outfile: 'dist/mtg-collab-editor.min.js',
  legalComments: 'none',
}

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(opts)
  await ctx.watch()
  console.log('[build] watching…')
} else {
  await esbuild.build(opts)
  console.log('[build] dist/mtg-collab-editor.min.js geschreven')
}
