/**
 * Claude API の呼び出し
 *
 * GAS には公式SDKがないため、UrlFetchApp で HTTP リクエストを直接送ります。
 * APIキーはスクリプトプロパティ ANTHROPIC_API_KEY に入れます（コードやシートには書かない）。
 */

/**
 * Claude に JSON 形式で回答させる
 * @param {{model: string, effort: string, system: string, content: (string|Object[]), schema: Object, maxTokens?: number}} opts
 *   content は文字列、または画像・PDFを含むコンテンツブロックの配列
 * @return {Object} schema に沿ってパースした結果
 */
function callClaudeJson_(opts) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(APP.PROP_ANTHROPIC_KEY);
  if (!apiKey) throw new Error('Claude の APIキーが未設定です。スクリプトプロパティ ANTHROPIC_API_KEY に入れてください。');
  const request = buildClaudeRequest_(opts, apiKey);
  const response = fetchWithRetry_(request);
  return parseClaudeJson_(response.getResponseCode(), response.getContentText());
}

/** UrlFetchApp に渡すリクエストを組み立てる（テストしやすいよう分離） */
function buildClaudeRequest_(opts, apiKey) {
  const payload = {
    model: opts.model,
    max_tokens: opts.maxTokens || 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: opts.effort,
      format: { type: 'json_schema', schema: opts.schema },
    },
    system: opts.system,
    messages: [{ role: 'user', content: opts.content }],
  };
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': APP.ANTHROPIC_VERSION,
  };
  if (APP.FALLBACK_MODELS.includes(opts.model)) {
    payload.fallbacks = 'default';
    headers['anthropic-beta'] = APP.FALLBACK_BETA;
  }
  return {
    url: APP.ANTHROPIC_URL,
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
}

/** 混雑（429）やサーバーエラー（5xx）のときだけ、間隔を空けて最大3回まで試す */
function fetchWithRetry_(request) {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = UrlFetchApp.fetch(request.url, request);
    } catch (e) {
      // GAS の通信は約60秒で打ち切られる。再試行しても同じなので、対処方法を伝えて止める
      if (/timeout|timed out|タイムアウト/i.test(e.message)) {
        throw new Error('AIの応答が時間切れ（約60秒）になりました。もう一度送るか、「設定」シートのモデルを claude-sonnet-5-5 に変えると速くなります。');
      }
      throw e;
    }
    const code = response.getResponseCode();
    const retryable = code === 429 || code >= 500;
    if (!retryable || attempt >= maxAttempts) return response;
    const retryAfter = Number(response.getHeaders()['retry-after'] || response.getHeaders()['Retry-After']);
    const waitSec = retryAfter > 0 ? Math.min(retryAfter, 30) : Math.pow(2, attempt);
    Utilities.sleep(waitSec * 1000);
  }
}

/** API のレスポンスを確認して JSON を取り出す */
function parseClaudeJson_(code, bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`Claude API から想定外の応答がありました（HTTP ${code}）`);
  }
  if (code !== 200) {
    const message = body.error && body.error.message ? body.error.message : bodyText;
    if (code === 401) throw new Error('Claude の APIキーが無効です。スクリプトプロパティ ANTHROPIC_API_KEY を確認してください。');
    if (code === 429) throw new Error('Claude API の利用上限に達しました。時間をおいて送り直してください。');
    throw new Error(`Claude API エラー（HTTP ${code}）：${message}`);
  }
  if (body.stop_reason === 'refusal') {
    const category = body.stop_details && body.stop_details.category ? `（${body.stop_details.category}）` : '';
    throw new Error(`Claude が回答を見送りました${category}。内容を変えて送り直してください。`);
  }
  if (body.stop_reason === 'max_tokens') {
    throw new Error('回答が途中で切れました。1回に送る資料・明細の数を減らしてください。');
  }
  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (body.usage) {
    console.log(`Claude usage: input=${body.usage.input_tokens}, output=${body.usage.output_tokens}, model=${body.model}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Claude の回答をJSONとして読み取れませんでした。もう一度送ってください。');
  }
}

/** 添付ファイルを Claude に渡すコンテンツブロックにする（画像とPDFのみ） */
function attachmentToBlock_(contentType, base64) {
  if (/^image\/(jpeg|png|gif|webp)$/.test(contentType)) {
    return { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } };
  }
  if (contentType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  }
  return null;
}
