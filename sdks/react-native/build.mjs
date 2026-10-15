import {build} from 'esbuild';

/* The workspace helpers it uses are bundled in, so the package installs without any private @plunk package. */
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2019',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-native'],
  logLevel: 'info',
});
