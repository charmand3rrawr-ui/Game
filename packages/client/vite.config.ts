import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The client builds twice from one source:
 *
 *   - `pnpm dev` / a normal build talks to the Fastify gateway.
 *   - the GitHub Pages build runs the SAME engine in the browser, against an
 *     in-process world. That is not a second implementation: it is literally
 *     @ascendance/engine, which has no I/O and no clock reads, so it runs
 *     anywhere (DECISIONS.md D4).
 *
 * BASE is set because Pages serves the site from a repository sub-path.
 */
export default defineConfig({
  plugins: [react()],
  base: process.env['ASCENDANCE_BASE'] ?? '/',
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  server: { port: 5173, proxy: { '/v1': 'http://localhost:8787' } },
  define: { __LOCAL_WORLD__: JSON.stringify(process.env['ASCENDANCE_LOCAL'] === '1') },
});
