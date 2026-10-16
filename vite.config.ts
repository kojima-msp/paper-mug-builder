import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages のプロジェクトページ（/<repo>/）に置けるよう相対パスにする
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
