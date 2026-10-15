import {defineConfig} from 'vite';

/* The loader is a classic script pasted into third-party sites, so it ships as one unhashed IIFE
at a stable URL next to the frame build. */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2019',
    lib: {
      entry: 'src/loader/index.ts',
      formats: ['iife'],
      name: 'PlunkChatLoader',
      fileName: () => 'loader.js',
    },
  },
});
