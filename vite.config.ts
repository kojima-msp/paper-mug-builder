import { defineConfig } from 'vitest/config';
// @ts-expect-error 素の JavaScript のスクリプト
import { generate, STYLES_DIR } from './scripts/gen-styles.mjs';

export default defineConfig({
  // GitHub Pages のプロジェクトページ（/<repo>/）に置けるよう相対パスにする
  base: './',
  plugins: [
    {
      // 開発サーバーの起動中に style.json を書き換えたら、スタイルの一覧を作り直す
      name: 'paper-mug-styles',
      configureServer(server) {
        server.watcher.on('all', (_event, file) => {
          if (file.startsWith(STYLES_DIR) && file.endsWith('style.json')) {
            try {
              generate();
            } catch (e) {
              server.config.logger.error((e as Error).message);
            }
          }
        });
      },
    },
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
