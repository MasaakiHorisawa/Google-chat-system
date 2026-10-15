/**
 * マネーフォワード クラウド会計との接続
 *
 * Claude Code で使っている MF の MCP サーバーに、APIキー認証で直接つなぎます。
 * （OAuth のアプリ登録をしなくても、事業者ごとの APIキーだけで動かせるため）
 * 事業者ごとの APIキーはスクリプトプロパティに入れ、「事業者」シートの「APIキー名」でどれを使うか指定します。
 */

// 1回の実行の中で MCP のセッションを使い回す（APIキー名ごと）
const MF_SESSIONS_ = {};

/** 「事業者」シートから事業者を名前で探す */
function findOffice_(name) {
  const offices = readRows_(getSheet_(APP.SHEETS.OFFICES)).filter(r => r['事業者名']);
  const office = offices.find(r => String(r['事業者名']).trim() === String(name).trim());
  if (!office) {
    const names = offices.map(r => r['事業者名']).join('、') || '（未登録）';
    throw new Error(`事業者「${name}」が「事業者」シートにありません。登録済み：${names}`);
  }
  return { name: String(office['事業者名']).trim(), code: String(office['事業者番号']).trim(), keyName: String(office['APIキー名']).trim() };
}

/**
 * MF の MCP ツールを呼ぶ
 * @param {{name: string, code: string, keyName: string}} office
 * @param {string} tool 例：mfc_ca_postJournals
 * @param {Object} args office_code は自動で付ける
 */
function mfCall_(office, tool, args) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(office.keyName);
  if (!apiKey) throw new Error(`「${office.name}」の APIキー（スクリプトプロパティ ${office.keyName}）が未設定です。`);

  let session = MF_SESSIONS_[office.keyName];
  if (!session) {
    session = mfInitialize_(apiKey);
    MF_SESSIONS_[office.keyName] = session;
  }
  const params = { name: tool, arguments: Object.assign({ office_code: office.code }, args || {}) };
  const res = mcpPost_(apiKey, session, { jsonrpc: '2.0', id: 2 + Math.floor(Math.random() * 1e6), method: 'tools/call', params: params });
  return parseMcpToolResult_(res.message, tool);
}

function mfInitialize_(apiKey) {
  const init = mcpPost_(apiKey, {}, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'google-chat-shiwake', version: '1.0.0' } },
  });
  if (!init.message || init.message.error) {
    throw new Error(`MF への接続に失敗しました：${JSON.stringify(init.message && init.message.error)}`);
  }
  const session = {
    id: init.sessionId,
    version: (init.message.result && init.message.result.protocolVersion) || '2025-06-18',
  };
  mcpPost_(apiKey, session, { jsonrpc: '2.0', method: 'notifications/initialized' });
  return session;
}

/** MCP サーバーへ JSON-RPC を1件送り、応答（JSON または SSE）を読む */
function mcpPost_(apiKey, session, body) {
  const headers = { 'Mf-API-Key': apiKey, Accept: 'application/json, text/event-stream' };
  if (session.id) headers['Mcp-Session-Id'] = session.id;
  if (session.version) headers['MCP-Protocol-Version'] = session.version;
  const res = UrlFetchApp.fetch(APP.MF_MCP_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 401 || code === 403) throw new Error('MF の APIキーが無効か、この事業者への権限がありません。APIキーを確認してください。');
  if (code >= 400) throw new Error(`MF への接続でエラーが出ました（HTTP ${code}）：${res.getContentText().slice(0, 300)}`);
  const respHeaders = res.getHeaders();
  const sessionId = respHeaders['Mcp-Session-Id'] || respHeaders['mcp-session-id'] || session.id;
  if (body.id === undefined) return { sessionId: sessionId, message: null }; // 通知には応答がない
  return { sessionId: sessionId, message: parseMcpResponse_(res.getContentText(), body.id) };
}

/** 応答本文から、送ったリクエストIDに対応する JSON-RPC メッセージを取り出す（SSE 形式にも対応） */
function parseMcpResponse_(text, id) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const messages = [];
  trimmed.split(/\r?\n\r?\n/).forEach(event => {
    const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
    if (!data) return;
    try { messages.push(JSON.parse(data)); } catch (e) { /* 読めない行は無視 */ }
  });
  const found = messages.find(m => m.id === id) || messages[messages.length - 1];
  if (!found) throw new Error('MF から想定外の応答がありました。時間をおいてもう一度試してください。');
  return found;
}

/** tools/call の結果を取り出す。中身が JSON ならパースして返す */
function parseMcpToolResult_(message, tool) {
  if (message.error) throw new Error(`MF（${tool}）エラー：${message.error.message || JSON.stringify(message.error)}`);
  const result = message.result || {};
  const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  if (result.isError) throw new Error(`MF（${tool}）エラー：${text.slice(0, 500)}`);
  if (result.structuredContent) return result.structuredContent;
  try { return JSON.parse(text); } catch (e) { return text; }
}

/** 応答のうち最初に見つかった配列を返す（{accounts: [...]} のような形を想定） */
function firstArray_(obj, preferredKey) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj[preferredKey])) return obj[preferredKey];
  const key = Object.keys(obj).find(k => Array.isArray(obj[k]));
  return key ? obj[key] : [];
}

/** 勘定科目・税区分の一覧（名前とID）。6時間キャッシュする */
function getMaster_(office) {
  const cache = CacheService.getScriptCache();
  const key = `master_${office.code}`;
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);
  const pick = list => list.filter(x => x.available !== false && x.name).map(x => ({ id: String(x.id), name: String(x.name) }));
  const master = {
    accounts: pick(firstArray_(mfCall_(office, 'mfc_ca_getAccounts', { available: true }), 'accounts')),
    taxes: pick(firstArray_(mfCall_(office, 'mfc_ca_getTaxes', { available: true }), 'taxes')),
  };
  if (!master.accounts.length) throw new Error(`「${office.name}」の勘定科目を MF から取得できませんでした。`);
  try { cache.put(key, JSON.stringify(master), APP.MASTER_CACHE_SEC); } catch (e) { /* 大きすぎてキャッシュできないときは毎回取得 */ }
  return master;
}

/** 未仕訳の明細を取得する */
function getUnjournalized_(office, startDate, endDate, limit) {
  const res = mfCall_(office, 'mfc_ca_getTransactions', {
    start_date: startDate,
    end_date: endDate,
    journalizing_statuses: ['none'],
    order: 'asc',
    per_page: Math.max(10, Math.min(500, limit)),
  });
  return firstArray_(res, 'transactions').slice(0, limit);
}
