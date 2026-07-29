import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, '..');

/** 走査対象のルート。CHAT_ROOT 環境変数で上書きできる。 */
export const CHAT_ROOT = path.resolve(
  process.env.CHAT_ROOT || path.join(os.homedir(), 'Obsidian', 'AI Chats')
);

export const CACHE_DIR = path.join(ROOT_DIR, '.cache');
export const CACHE_META = path.join(CACHE_DIR, 'index.json');
export const CACHE_BLOB = path.join(CACHE_DIR, 'search.bin');

export const PORT = Number(process.env.PORT || 5173);

/** 索引対象の拡張子 */
export const EXTENSIONS = new Set(['.md', '.txt']);

/** 走査から除外するディレクトリ名 */
export const IGNORED_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

/** フロントマターに Source が無い場合、パスから推定するための対応表 */
export const FOLDER_SOURCE_HINTS = [
  ['lm studio', 'lmstudio'],
  ['chatgpt', 'chatgpt'],
  ['claude', 'claude'],
  ['gemini', 'gemini'],
  ['perplexity', 'perplexity'],
  ['google ai', 'google_ai_mode'],
];

/** UI 表示用のソース定義 */
export const SOURCE_META = {
  chatgpt: { label: 'ChatGPT', color: '#10a37f' },
  claude: { label: 'Claude', color: '#d97757' },
  gemini: { label: 'Gemini', color: '#4285f4' },
  perplexity: { label: 'Perplexity', color: '#20808d' },
  google_ai_mode: { label: 'Google AI', color: '#ea4335' },
  lmstudio: { label: 'LM Studio', color: '#8b5cf6' },
  unknown: { label: 'その他', color: '#8a8f98' },
};
