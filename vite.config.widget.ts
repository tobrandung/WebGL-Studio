import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';

/**
 * Since r185 DRACOLoader and KTX2Loader default to decoders bundled next to
 * them, referenced as `new URL('../libs/…', import.meta.url)`. An IIFE library
 * build can only inline those, which put about 3 MB of base64 WASM into every
 * embed. The widget always sets its decoder paths to the CDN
 * (src/three/renderer.ts), so the defaults are dead and are dropped here.
 */
function dropBundledDecoders(): Plugin {
  return {
    name: 'drop-bundled-decoders',
    enforce: 'pre',
    transform(code, id) {
      if (!/three[\/]examples[\/]jsm[\/]loaders[\/](DRACO|KTX2)Loader\.js$/.test(id)) return null;
      return code.replace(/new URL\(\s*'[^']+',\s*import\.meta\.url\s*\)\.toString\(\)/g, "''");
    },
  };
}

export default defineConfig({
  // The widget is a library bundle with no public assets of its own. Without
  // this, Vite copies all of public/ into dist-widget on every widget build —
  // which drags the ~11 MB of bundled HDRI presets along for nothing (they
  // reach the CDN as project environments, not from here).
  publicDir: false,
  plugins: [dropBundledDecoders()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/widget/index.ts'),
      name: 'Web3DWidget',
      fileName: 'web3d-widget',
      formats: ['iife'],
    },
    outDir: 'dist-widget',
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    target: 'es2020',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
