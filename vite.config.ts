import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  assetsInclude: ['**/*.glb', '**/*.gltf', '**/*.fbx', '**/*.obj', '**/*.stl'],
  optimizeDeps: {
    // @gltf-transform/functions statically imports ndarray and ndarray-ops,
    // which are CJS with no exports map. They are only reached through the
    // optimizer worker, and dependencies discovered that late make the dev
    // server re-optimise and full-reload mid-session — which does not
    // gracefully take an in-flight worker with it. Pre-bundling them at
    // startup avoids the reload entirely.
    include: [
      '@gltf-transform/core',
      '@gltf-transform/extensions',
      '@gltf-transform/functions',
    ],
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/react-router-dom')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/three')) {
            return 'vendor-three';
          }
          return undefined;
        },
      },
    },
  },
});
