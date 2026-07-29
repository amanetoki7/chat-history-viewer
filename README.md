# AI Chat History Viewer

Obsidian の `AI Chats` フォルダ以下を**全探索**し、エクスポートされた ChatGPT / Claude / Gemini /
Perplexity / Google AI Mode / LM Studio の会話ログを**チャット UI で表示・全文検索**するローカル Web アプリ。

外部への通信は一切行わない。すべてローカルの Node.js プロセスで完結する。

## 起動

```bash
npm install
npm start
# → http://localhost:5173
```

初回起動時に全ファイルを解析して索引を作る（約 9,500 ファイル / 300 MB で数十秒）。
2 回目以降は `.cache/` から復元するため数秒で立ち上がる。
ファイルの追加・更新・削除は mtime とサイズで自動検知し、変化があれば索引を作り直す。

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CHAT_ROOT` | `~/Obsidian/AI Chats` | 走査するルートフォルダ |
| `PORT` | `5173` | 待ち受けポート |

```bash
CHAT_ROOT="D:/Vault/AI Chats" PORT=8080 npm start   # ルートを変える
npm run reindex                                      # 索引を強制的に作り直す
```

## 機能

### 検索

- 全会話を対象にした部分一致検索。日本語もそのまま検索できる（英字は大小を区別しない）
- `"複数語 まとめて"` … フレーズ一致
- `-除外語` … その語を含む会話を除外
- 空白区切りの複数語は AND 条件
- 検索対象を「全文 / 自分の発言 / AI の回答」に切り替え可能
- ソース・期間・お気に入り・アーカイブでの絞り込み
- 関連度 / 新しい順 / 古い順 / 長い順で並べ替え

### 表示

- 発言ごとの吹き出し表示（自分は右、AI は左）
- Markdown・表・コードのシンタックスハイライト描画
- Claude の `<antArtifact>` / `<antThinking>` は折りたたみブロックとして描画
- Perplexity の `## Sources` / `## Related Questions` は出典セクションとして分離
- 検索語を本文中でハイライトし、`↑` `↓` で一致箇所を順に辿れる
- 元のチャット URL / Obsidian / Markdown 原文へのリンク
- ダーク / ライトテーマ

### キーボード

| キー | 動作 |
| --- | --- |
| `/` | 検索ボックスにフォーカス |
| `J` / `K` | 一覧を上下に移動して開く |
| `N` / `Shift+N` | 次 / 前の一致箇所へ |
| `Esc` | 検索を抜ける・会話を閉じる |

## 対応フォーマット

エクスポータごとに Markdown の構造が違うため、3 通りの解析を自動で切り替える。

| 種別 | 構造 | 主な対象 |
| --- | --- | --- |
| `marker` | `# you asked` / `# xxx response` で発言を区切る | ChatGPT, Claude, Gemini, Google AI Mode, AI Chats Exporter |
| `thread` | H1 が質問、以降が回答。`## Sources` / `## Related Questions` で回答が閉じる | Perplexity Threads |
| `plain` | 区切りの無い単一本文 | LM Studio ほか |

いずれもコードフェンス内の `#` や `----` は区切りとして扱わない。
`thread` 判定では、貼り付けられた長文プロンプト中の H1 を新しい質問と誤認しないよう、
「直前の H1 以降に出典セクションが現れたか」を見て境界を決めている。

フロントマター（`Source` / `Chat Time` / `URL` / `Favorite` / `Archive` / `Tags` など）は
そのままメタデータとして取り込む。`Source` が無いファイルはパスから推定する。

## 構成

```text
server.js           Express サーバと API
src/config.js       ルートパス・ポート・ソース定義
src/parser.js       Markdown → 会話構造への変換
src/indexer.js      全探索・索引構築・.cache への永続化
src/search.js       全文検索とスニペット生成
public/             フロントエンド（依存フレームワークなし）
```

### 索引の仕組み

検索対象テキストは会話ごとに UTF-8 の 1 本の `Buffer` へ連結し、
**ASCII の A–Z だけを小文字化**して保持する。多バイト文字に触れないためバイト長が原文と一致し、

- 英字の大小を無視した検索
- 日本語の部分一致検索
- 一致位置をそのまま原文の位置として再利用（スニペット生成）

を、形態素解析なしで同時に満たせる。テキスト本体は JS ヒープ外の `Buffer` に置き、
ヒープにはメタデータだけを載せるため、300 MB 規模でもメモリを圧迫しない。

貼り付けられた画像の base64 本体は索引から除外する。この Vault では 258 個の画像が
生テキストの約 6 割（158 MB）を占めており、検索対象としては無意味なうえ誤ヒットの原因になるため。
除外は検索用 Buffer の生成時のみに適用し、表示用の本文はそのまま残すので、
チャット画面では画像が普通に描画される。結果として索引は 273 MB → 114 MB、
構築時間は 28 秒 → 9 秒、検索は 1 クエリあたり 20〜120 ms に収まっている。

索引は `.cache/index.json`（メタデータ）、`.cache/search.bin`（検索用テキスト）、
`.cache/segments.bin`（発言境界）に保存される。消しても次回起動時に作り直される。

## API

| エンドポイント | 説明 |
| --- | --- |
| `GET /api/stats` | 総件数・ソース別件数・期間 |
| `GET /api/conversations?q=&sources=&from=&to=&scope=&sort=&offset=&limit=` | 検索・一覧（スニペット付き） |
| `GET /api/conversation?id=<相対パス>` | 会話 1 件の全発言 |
| `GET /api/raw?id=<相対パス>` | Markdown 原文 |
| `POST /api/reindex` | 索引の再構築 |
