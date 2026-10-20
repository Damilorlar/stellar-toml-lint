import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { PRECACHE_GLOBS, RUNTIME_CACHE_PATTERNS } from './src/precache';

/**
 * The offline studio build.
 *
 * `generateSW` hands Workbox the precache list and the runtime routes and lets
 * it emit the service worker, so there is no hand-maintained `sw.js` to drift
 * from the assets the build actually produced. The plan itself lives in
 * `src/precache.ts` where the tests can read it.
 *
 * `manifest: false` because we ship `public/manifest.webmanifest` ourselves:
 * the file has to be readable by anything inspecting the deployment, not only
 * by the plugin that generated it.
 */
export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      strategies: 'generateSW',
      registerType: 'autoUpdate',
      manifest: false,
      includeAssets: ['icons/*.png', 'data/*.json', 'manifest.webmanifest'],
      workbox: {
        globPatterns: [...PRECACHE_GLOBS],
        // A deep link opened offline still renders the app shell.
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: RUNTIME_CACHE_PATTERNS.map((entry) => ({
          urlPattern: entry.pattern,
          handler: entry.strategy,
          options: {
            cacheName: entry.cacheName,
            expiration: {
              maxEntries: entry.maxEntries,
              // Thirty days: long enough for a field trip, short enough that a
              // stale rules file cannot outlive a spec revision indefinitely.
              maxAgeSeconds: 60 * 60 * 24 * 30,
            },
          },
        })),
      },
      devOptions: {
        // The service worker is only useful if it can be exercised locally.
        enabled: true,
        type: 'module',
      },
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
