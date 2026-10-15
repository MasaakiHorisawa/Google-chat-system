/**
 * Google Chat API の呼び出し（アプリとしての認証）
 *
 * 時間のかかる処理（AIの読み取りなど）はチャットの応答期限（30秒）に間に合わないため、
 * ジョブとして後から処理し、結果を Chat API でスペースに投稿します。
 * その投稿と添付ファイルのダウンロードには、Chat アプリのサービスアカウントで認証します。
 */

/** サービスアカウントで chat.bot 権限のアクセストークンを得る（50分キャッシュ） */
function getChatToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('chat_token');
  if (cached) return cached;

  const raw = PropertiesService.getScriptProperties().getProperty(APP.PROP_SERVICE_ACCOUNT);
  if (!raw) throw new Error('サービスアカウントの鍵が未設定です。スクリプトプロパティ SERVICE_ACCOUNT_JSON に鍵（JSON）を貼ってください。');
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch (e) {
    throw new Error('SERVICE_ACCOUNT_JSON を JSON として読めません。ダウンロードした鍵ファイルの中身をそのまま貼ってください。');
  }

  const now = Math.floor(Date.now() / 1000);
  const jwt = buildJwt_(
    { alg: 'RS256', typ: 'JWT' },
    { iss: sa.client_email, scope: APP.CHAT_SCOPE, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    sa.private_key
  );
  const res = UrlFetchApp.fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`サービスアカウントの認証に失敗しました（HTTP ${res.getResponseCode()}）。鍵が無効になっていないか確認してください。`);
  }
  const token = JSON.parse(res.getContentText()).access_token;
  cache.put('chat_token', token, 50 * 60);
  return token;
}

function buildJwt_(header, claims, privateKey) {
  const enc = obj => Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  const input = `${enc(header)}.${enc(claims)}`;
  const signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, privateKey)).replace(/=+$/, '');
  return `${input}.${signature}`;
}

function chatFetch_(method, path, body) {
  const options = {
    method: method,
    headers: { Authorization: `Bearer ${getChatToken_()}` },
    muteHttpExceptions: true,
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  const res = UrlFetchApp.fetch(`${APP.CHAT_API}/${path}`, options);
  const code = res.getResponseCode();
  if (code >= 300) throw new Error(`Google Chat API エラー（HTTP ${code}）：${res.getContentText().slice(0, 300)}`);
  return JSON.parse(res.getContentText() || '{}');
}

/** スペースにメッセージを投稿する。thread を渡すとそのスレッドに返信する */
function postChatMessage_(space, message, thread) {
  let path = `${space}/messages`;
  if (thread) {
    message.thread = { name: thread };
    path += '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
  }
  return chatFetch_('post', path, message);
}

/** アプリが投稿したメッセージ（カード）を書き換える */
function updateChatMessage_(messageName, message) {
  return chatFetch_('patch', `${messageName}?updateMask=text,cardsV2`, message);
}

/** チャットに直接アップロードされた添付ファイルを取得する */
function downloadChatAttachment_(resourceName) {
  const res = UrlFetchApp.fetch(`${APP.CHAT_API}/media/${resourceName}?alt=media`, {
    headers: { Authorization: `Bearer ${getChatToken_()}` },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`添付ファイルを取得できませんでした（HTTP ${res.getResponseCode()}）。もう一度アップロードしてください。`);
  }
  return res.getBlob();
}
