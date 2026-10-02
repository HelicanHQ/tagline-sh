import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: ['src/index.ts'],
        format: ['esm'],
        dts: false,
        clean: true,
        sourcemap: true,
        target: 'node24',
        shims: true,
    },
    // Lambda: one self-contained file (deps inlined) so the deploy asset needs no node_modules.
    {
        entry: { index: 'src/lambda.ts' },
        outDir: 'dist-lambda',
        format: ['esm'],
        outExtension: () => ({ js: '.mjs' }),
        dts: false,
        clean: true,
        sourcemap: false,
        target: 'node24',
        platform: 'node',
        noExternal: [/.*/],
        // Resolve like Node does (`main` before `module`). tsup's default prefers `module`, which
        // pulls web builds of old @octokit deps, e.g. universal-github-app-jwt@1's dist-web rejects
        // GitHub's PKCS#1 private keys.
        esbuildOptions(options) {
            options.mainFields = ['main', 'module'];
        },
        // Bundled CJS deps call require(); give ESM output a real one.
        banner: {
            js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
    },
]);
