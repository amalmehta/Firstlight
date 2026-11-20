import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        demo: resolve(__dirname, 'index.html'),
        hello: resolve(__dirname, 'examples/hello.html'),
        selfcheck: resolve(__dirname, 'examples/selfcheck.html'),
      },
    },
  },
});
