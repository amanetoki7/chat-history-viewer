/*
 * CodeMirror (lezer) ベースの静的コードハイライター。
 * 本家 ChatGPT と同じパーサー・タグ付けでコードを解析し、
 * 色グループごとの <span class="tok-*"> を含む HTML を返す（エディタは生成しない）。
 *
 * 色グループは本家 ChatGPT の CodeMirror テーマ実測（2026-08）と同じ構成:
 *   tok-comment / tok-kw(キーワード・演算子・単位) / tok-str(文字列・正規表現)
 *   tok-num(数値・真偽値・アトム・クラス名) / tok-var(変数・関数名)
 *   tok-tag(タグ・メタ) / tok-attr(属性名) / tok-link / tok-invalid
 * 実際の配色は styles/chat.css（既定）と styles/providers/*.css（プロバイダー別）が持つ。
 */
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';
import { parser as jsParser } from '@lezer/javascript';
import { parser as cssParser } from '@lezer/css';
import { parser as htmlParser } from '@lezer/html';
import { parser as xmlParser } from '@lezer/xml';
import { parser as pythonParser } from '@lezer/python';
import { parser as jsonParser } from '@lezer/json';
import { parser as javaParser } from '@lezer/java';
import { parser as cppParser } from '@lezer/cpp';
import { parser as rustParser } from '@lezer/rust';
import { parser as phpParser } from '@lezer/php';
import { parser as yamlParser } from '@lezer/yaml';
import { parser as mdParser } from '@lezer/markdown';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell.js';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql.js';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell.js';
import { go } from '@codemirror/legacy-modes/mode/go.js';
import { ruby } from '@codemirror/legacy-modes/mode/ruby.js';
import { swift } from '@codemirror/legacy-modes/mode/swift.js';
import { toml } from '@codemirror/legacy-modes/mode/toml.js';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile.js';
import { lua } from '@codemirror/legacy-modes/mode/lua.js';
import { diff } from '@codemirror/legacy-modes/mode/diff.js';
import { r } from '@codemirror/legacy-modes/mode/r.js';
import { csharp, kotlin, scala, objectiveC, dart } from '@codemirror/legacy-modes/mode/clike.js';

/*
 * タグ→クラスの対応。本家の色グループに合わせる。
 * 親タグは子を巻き込む（keyword は controlKeyword なども拾う）。
 * propertyName を無指定にするのは本家仕様（CSS の margin: などが地の色になる）。
 * メソッド定義・呼び出し（function/definition 付き propertyName）だけ紫にする。
 */
const highlighter = tagHighlighter([
  { tag: [t.comment, t.quote], class: 'tok-comment' },
  { tag: [t.keyword, t.operator, t.modifier, t.unit], class: 'tok-kw' },
  { tag: [t.string, t.escape, t.regexp, t.url, t.inserted], class: 'tok-str' },
  {
    tag: [
      t.number, t.bool, t.atom, t.null, t.self, t.labelName,
      t.className, t.typeName, t.namespace, t.macroName,
    ],
    class: 'tok-num',
  },
  {
    tag: [
      t.variableName,
      t.function(t.propertyName),
      t.definition(t.propertyName),
      t.special(t.propertyName),
    ],
    class: 'tok-var',
  },
  {
    tag: [
      t.tagName, t.angleBracket, t.documentMeta,
      t.processingInstruction, t.meta, t.heading, t.contentSeparator,
    ],
    class: 'tok-tag',
  },
  { tag: t.attributeName, class: 'tok-attr' },
  { tag: t.link, class: 'tok-link' },
  { tag: [t.invalid, t.deleted], class: 'tok-invalid' },
  { tag: t.emphasis, class: 'tok-em' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.strikethrough, class: 'tok-strike' },
]);

/* フェンスの言語名 → パーサー。値は { parse(code) → Tree } を持つオブジェクト */
const stream = (mode) => StreamLanguage.define(mode).parser;

const tsParser = jsParser.configure({ dialect: 'ts' });
const LANGS = {
  javascript: jsParser, js: jsParser, mjs: jsParser, cjs: jsParser,
  jsx: jsParser.configure({ dialect: 'jsx' }),
  typescript: tsParser, ts: tsParser,
  tsx: jsParser.configure({ dialect: 'jsx ts' }),
  css: cssParser, scss: cssParser, less: cssParser,
  html: htmlParser, vue: htmlParser, svelte: htmlParser,
  xml: xmlParser, svg: xmlParser, xsl: xmlParser,
  python: pythonParser, py: pythonParser, python3: pythonParser,
  json: jsonParser, jsonc: jsonParser,
  java: javaParser,
  cpp: cppParser, 'c++': cppParser, c: cppParser, h: cppParser, hpp: cppParser, ino: cppParser,
  rust: rustParser, rs: rustParser,
  php: phpParser.configure({ top: 'Program' }),
  yaml: yamlParser, yml: yamlParser,
  markdown: mdParser, md: mdParser,
  bash: stream(shell), sh: stream(shell), shell: stream(shell), zsh: stream(shell), console: stream(shell),
  sql: stream(standardSQL), mysql: stream(standardSQL), postgresql: stream(standardSQL), sqlite: stream(standardSQL),
  powershell: stream(powerShell), ps1: stream(powerShell), pwsh: stream(powerShell),
  go: stream(go), golang: stream(go),
  ruby: stream(ruby), rb: stream(ruby),
  swift: stream(swift),
  toml: stream(toml),
  dockerfile: stream(dockerFile), docker: stream(dockerFile),
  lua: stream(lua),
  diff: stream(diff), patch: stream(diff),
  r: stream(r),
  csharp: stream(csharp), cs: stream(csharp), 'c#': stream(csharp),
  kotlin: stream(kotlin), kt: stream(kotlin),
  scala: stream(scala),
  objectivec: stream(objectiveC), objc: stream(objectiveC),
  dart: stream(dart),
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** code を lang としてハイライトした HTML を返す。未対応言語や解析失敗は '' */
window.cmHighlight = (code, lang) => {
  const parser = lang && LANGS[lang.toLowerCase()];
  if (!parser) return '';
  try {
    let out = '';
    let pos = 0;
    highlightTree(parser.parse(code), highlighter, (from, to, cls) => {
      if (from > pos) out += esc(code.slice(pos, from));
      out += `<span class="${cls}">${esc(code.slice(from, to))}</span>`;
      pos = to;
    });
    out += esc(code.slice(pos));
    return out;
  } catch {
    return '';
  }
};
