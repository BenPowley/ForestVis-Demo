/*
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs'
import path from 'path'
import { defineConfig } from 'vite'
//import patchGiro3DWorker from './vite-plugin-patch-worker.js'

// Local dev uses self-signed certs when present; CI and static builds have none.
const https = fs.existsSync('key.pem') && fs.existsSync('cert.pem')
  ? { key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') }
  : false

export default defineConfig({
  // Relative base so the build works under a GitHub Pages project subpath.
  base: './',
  plugins: [],
  server: {
    https,
    headers: {
      'Accept-Ranges': 'bytes'
    },
    fs: {
      strict: false
    }
  },
  resolve: {
    extensions: ['.js', '.ts', '.json'],
    alias: {
      '@giro3d/giro3d': path.resolve(__dirname, 'giro3d/build/giro3d'),
      'three': path.resolve(__dirname, 'node_modules/three'),
      'ol': path.resolve(__dirname, 'node_modules/ol'),
      'proj4': path.resolve(__dirname, 'node_modules/proj4'),
      // Vite 3 can't resolve @fontsource's wildcard "exports" patterns.
      '@fontsource': path.resolve(__dirname, 'node_modules/@fontsource')
    },
    dedupe: ['three', 'ol', 'proj4']
  },
  build: {
    target: 'es2022', // This supports BigInt literals
    sourcemap: true, // Enable source maps for debugging
    rollupOptions: {
      external: [],
      output: {
        manualChunks: undefined,
        sourcemap: true
      }
    }
  },
  esbuild: {
    target: 'es2022'
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022' // This supports BigInt literals
    },
    force: true // Force re-optimization after patching
  }
})