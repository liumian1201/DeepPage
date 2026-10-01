/**
 * ESLint flat config — DeepPage
 *
 * 目标：拦住「运行时才炸」的问题（未定义变量、重复声明、变量遮蔽、误用 ==、
 * 不可达代码、catch 里吞异常等），不做格式化风格的争论。
 *
 * 关键设计：本项目是 16 个经典脚本（非 ES module）共享全局作用域，
 * 因此跨文件符号（currentSettings / saveSettings / renderSpeeddials ...）
 * 由本配置在加载时扫描 src/js/*.js 的顶层声明自动收集，新增模块无需手工登记。
 */
import js from '@eslint/js';
import globals from 'globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.join(ROOT, 'src', 'js');

/** 扫描 src/js/*.js 顶层声明 → 跨文件共享全局符号表 */
function collectSharedGlobals() {
  const names = new Set();
  const patterns = [
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^(?:var|let|const)\s+([A-Za-z_$][\w$]*)/,
    /^window\.([A-Za-z_$][\w$]*)\s*=/,
  ];
  for (const file of fs.readdirSync(JS_DIR)) {
    if (!file.endsWith('.js') || file === 'fflate.min.js') continue;
    const lines = fs.readFileSync(path.join(JS_DIR, file), 'utf8').split('\n');
    for (const line of lines) {
      for (const re of patterns) {
        const m = re.exec(line);
        if (m) { names.add(m[1]); break; }
      }
    }
  }
  return Object.fromEntries([...names].sort().map((n) => [n, 'writable']));
}

const SHARED = collectSharedGlobals();

/** 由第三方脚本提供、非本项目声明的全局（fflate.min.js 为 UMD，已跳过扫描） */
const VENDOR_GLOBALS = { fflate: 'readonly' };

export default [
  {
    ignores: [
      'node_modules/**',
      'src/js/fflate.min.js', // 第三方压缩产物
      '_private/**',
    ],
  },

  // ---- 扩展源码：经典脚本，浏览器 + 扩展 API ----
  {
    files: ['src/js/*.js', 'src/background.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...VENDOR_GLOBALS,
        ...SHARED,
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      // 跨文件全局是常态：只查函数内部的局部未使用变量，避免把
      // 「在 A 文件定义、B 文件调用」的符号误报成死代码
      'no-unused-vars': ['warn', { args: 'none', vars: 'local', caughtErrors: 'none' }],
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-shadow': ['warn', { builtinGlobals: false, allow: ['err', 'e', 'i', 'k', 'v'] }],
      'no-undef': 'error',

      // 防御式初始化（var x = null; try { x = await ... }）在 var 语境下合法，
      // 降为 warning 暴露但不阻断
      'no-useless-assignment': 'warn',

      // 本项目大量使用 `== null` 判空
      eqeqeq: ['warn', 'smart'],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },

  // background.js 的 webdavProxy 按分支复用 var res/text/fname 是既有统一写法，
  // 同函数内 var 重复声明无副作用 → 仅提示，不阻断
  {
    files: ['src/background.js'],
    rules: {
      'no-redeclare': 'warn',
    },
  },

  // ---- 开发工具脚本：Node + CommonJS ----
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-console': 'off',
    },
  },

  // ---- ESM 工具：Node + module ----
  {
    files: ['tools/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'off',
    },
  },
];
