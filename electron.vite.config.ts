import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // `ws` stays external: it carries optional native addons (bufferutil,
  // utf-8-validate) that Rollup cannot bundle. Electron runs from out/ with
  // node_modules present, so an external resolve works at runtime.
  main: { build: { rollupOptions: { external: ['ws', '@stoqey/ib'] } } },
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
