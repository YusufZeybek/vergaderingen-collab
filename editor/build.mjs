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

// Sollicitatiegesprekken (Vacatures): één doc per gesprek, één kleine editor per vraag.
// Naam zonder ".min": het portaal negeert *.min.js in git, dit bestand moet mee met de deploy.
const gesprek = {
  ...opts,
  entryPoints: ['src/gesprek.js'],
  globalName: 'VacGesprekCollab',
  sourcemap: false,
  outfile: 'dist/vac-gesprek-collab.bundle.js',
}

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(opts)
  await ctx.watch()
  console.log('[build] watching…')
} else if (process.argv.includes('--gesprek')) {
  await esbuild.build(gesprek)
  console.log('[build] dist/vac-gesprek-collab.bundle.js geschreven')
} else {
  await esbuild.build(opts)
  await esbuild.build(gesprek)
  console.log('[build] dist/mtg-collab-editor.min.js + dist/vac-gesprek-collab.bundle.js geschreven')
}
