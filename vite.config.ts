import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 20_000,
          groups: [
            // three's core is the largest dependency by far and changes only when the
            // package is upgraded, so it is worth a long-lived chunk of its own.
            // `examples/` is deliberately excluded: TransformControls is imported
            // dynamically, and folding it in here would make it eager again.
            { name: 'three', test: /node_modules[\\/]three[\\/]build[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            {
              name: 'ui',
              test: /node_modules[\\/](@ark-ui|@zag-js|@floating-ui|tailwind-variants|tailwind-merge|lucide-react|clsx)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
