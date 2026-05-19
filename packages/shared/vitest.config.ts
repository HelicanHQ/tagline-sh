import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
    // Bridge `tsconfig.paths` → Vite's resolver. Without this, vitest can't
    // resolve `~/app/*` aliases at test time (the tsup build resolves them
    // via esbuild, but vitest uses Vite which has its own resolver).
    plugins: [tsconfigPaths()],
    test: {
        globals: false,
        environment: 'node',
        include: ['test/**/*.test.ts'],
    },
});
