/**
 * LM Studio（OpenAI 互換 API）クライアント。
 *
 * チャット履歴はプライバシー保護のため一切外部へ送信しない。
 * LLM 呼び出しはすべてローカルの LM Studio 経由で行う。
 *
 * 環境変数:
 *   LMSTUDIO_BASE_URL … 既定 http://localhost:1234/v1
 *   LMSTUDIO_MODEL    … 未指定ならロード済みモデルを自動選択
 */

export const BASE_URL = (process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1').replace(/\/+$/, '');

/** 使用モデルを決める。指定がなければロード済みモデル → モデル一覧の先頭。 */
export async function resolveModel() {
  if (process.env.LMSTUDIO_MODEL) return process.env.LMSTUDIO_MODEL;

  // LM Studio 拡張 API でロード済みモデルを探す（JIT ロード待ちを避ける）
  try {
    const res = await fetch(BASE_URL.replace(/\/v1$/, '') + '/api/v0/models');
    if (res.ok) {
      const { data } = await res.json();
      const loaded = (data || []).find((m) => m.state === 'loaded' && m.type === 'llm');
      if (loaded) return loaded.id;
    }
  } catch {
    /* 拡張 API が無いバージョンは無視して /v1/models へ */
  }

  const res = await fetch(`${BASE_URL}/models`);
  if (!res.ok) throw new Error(`LM Studio /models が ${res.status} を返しました`);
  const { data } = await res.json();
  const first = (data || []).find((m) => !/embed/i.test(m.id));
  if (!first) throw new Error('LM Studio に利用可能なモデルがありません。モデルをロードしてください。');
  return first.id;
}

/** /chat/completions を呼ぶ（非ストリーミング）。content 文字列を返す。 */
export async function chat(body) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LM Studio がエラーを返しました (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

/** テキストから最初の JSON オブジェクトを取り出す（構造化出力が使えないモデル向けの保険）。 */
export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('LLM の応答から JSON を取り出せませんでした。');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * JSON Schema 構造化出力でチャットし、パース済みオブジェクトを返す。
 * 構造化出力に未対応のモデルはプロンプト指示だけで再試行する。
 */
export async function chatJson({ messages, schema, name, temperature = 0.1, maxTokens = 4096, model = null }) {
  const useModel = model || (await resolveModel());
  let text;
  try {
    text = await chat({
      model: useModel,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name, strict: true, schema },
      },
    });
  } catch (err) {
    if (!/400|json_schema|response_format/i.test(err.message || '')) throw err;
    text = await chat({ model: useModel, messages, temperature, max_tokens: maxTokens });
  }
  return extractJson(text);
}

/**
 * /chat/completions をストリーミングで呼び、content の差分を onDelta へ流す。
 * @returns {Promise<string>} 全文
 */
export async function chatStream(body, onDelta) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LM Studio がエラーを返しました (${res.status}): ${detail.slice(0, 300)}`);
  }

  // OpenAI 互換の SSE ストリームを読み、content の差分だけを流す
  let text = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
    }
  }
  return text;
}

/** 接続失敗をユーザー向けメッセージへ変換する。該当しなければ null。 */
export function connectionErrorMessage(err) {
  const unreachable =
    err?.cause?.code === 'ECONNREFUSED' ||
    (err?.cause?.errors || []).some((e) => e?.code === 'ECONNREFUSED') ||
    /fetch failed|ECONNREFUSED/i.test(err?.message || '');
  return unreachable
    ? 'LM Studio に接続できません。LM Studio を起動し、ローカルサーバー（既定 http://localhost:1234）を開始してください。'
    : null;
}
