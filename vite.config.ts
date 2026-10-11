import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import path from "node:path";
const host = process.env.TAURI_DEV_HOST;

// 插件包解析：@ll/sdk（插件唯一允许的壳层依赖）与 @ll/plugin-<id>（插件 fe 包）
const pluginAlias = [
  { find: "@ll/sdk", replacement: path.resolve("plugins/sdk/src/index.ts") },
  {
    find: /^@ll\/plugin-(.+)$/,
    replacement: path.resolve("plugins") + "/$1/fe/src/index.ts",
  },
];

// https://vite.dev/config/
export default defineConfig(() => ({
  base: "./",
  plugins: [solid()],
  resolve: { alias: pluginAlias },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
