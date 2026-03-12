import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3847,
    proxy: {
      '/api': 'http://localhost:3848',
      '/ws': {
        target: 'ws://localhost:3848',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
