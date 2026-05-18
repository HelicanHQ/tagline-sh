import { defineConfig } from 'tsup';

// The Action runs as a single bundled CJS file on the GitHub-hosted Node 20 runtime.
// Bundling all dependencies (noExternal) is required — node_modules is not shipped.
export default defineConfig({
    entry: { index: 'src/main.ts' },
    format: ['cjs'],
    dts: false,
    clean: true,
    sourcemap: false,
    target: 'node20',
    noExternal: [/.*/],
    minify: false,
    outExtension: () => ({ js: '.js' }),
});
