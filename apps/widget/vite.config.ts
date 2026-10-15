import {defineConfig} from 'vite';

export default defineConfig({
  base: '/widget/',
  oxc: {
    jsx: {runtime: 'automatic', importSource: 'preact'},
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2019',
  },
});
