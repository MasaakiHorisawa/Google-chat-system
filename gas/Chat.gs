/**
 * Google Chat アプリ: 議事録システムの「関与先ノート」を読んで返す(段階1: 読むだけ)
 *
 *   ノート 関与先名 … カルテ(確認済)の要点、未確認カルテの件数、未回答の質問、未完了のタスク、次回MTG日、ノートへのリンク
 *   質問 関与先名   … 未回答の質問(関与先あて/事務所内)
 *   ルール 関与先名 … Claude に渡す「関与先ルール」Markdown
 *
 * 返事の中身は Shared.gs(議事録システムの Code.gs から写した関数)で作る。このファイルは
 * Chat からの入口と、スプレッドシートを「読むだけ」で開く部分を受け持つ。
 *
 * 情報の扱い
 *   - 話しかけた人の権限で動く(Apps Script の Chat アプリは利用者ごとに承認して、その人として実行される)。
 *     ノートを見られない人には、スプレッドシートが開けないので何も出ない。
 *   - スコープは spreadsheets.readonly だけ。シートの追加・書き換えはしない(議事録システムの openNotebook_ と違う点)。
 *   - 外部ユーザーが参加できるスペースでは関与先の情報を返さない(chatExternal_)。スペースが分からないときも返さない。
 *
 * スクリプト プロパティ
 *   MASTER_SS_ID   … 議事録システムのマスタースプレッドシートのID(URLでも可)。必須
 *   ALLOWED_DOMAIN … 例 example.co.jp。入れると、このドメインのアカウント以外には返さない。任意
 */

/** Chatでメッセージを受けたとき(スペースでは @メンションされたとき、DMでは毎回) */
function onMessage(event) {
  let text;
  try {
    text = chatGuard_(event) || chatAnswer_(event);
  } catch (e) {
    text = 'エラー: ' + e.message;
  }
  // Chatは1通4096文字まで
  return { text: text.length > 3800 ? text.slice(0, 3800) + '\n…(以下省略。関与先ノートを開いて確認してください)' : text };
}

function onAddToSpace(event) {
  return { text: chatGuard_(event) || CHAT_HELP };
}

function onRemoveFromSpace() {}

/**
 * 関与先の情報を返してよい場面か。だめなら断りの文を返す(よければ空文字)。
 * chatExternal_ は「外部ユーザー可」と分かっているスペースだけを断るので、ここではスペースが分からないときも断る
 */
function chatGuard_(event) {
  if (!event || !event.space) return 'スペースの情報が分からないため、関与先の情報はお返しできません。';
  const ext = chatExternal_(event);
  if (ext) return ext;
  const domain = String(PropertiesService.getScriptProperties().getProperty('ALLOWED_DOMAIN') || '').trim().toLowerCase();
  const email = String((event.user && event.user.email) || '').toLowerCase();
  if (domain && !email.endsWith('@' + domain)) return '事務所のアカウント以外には、関与先の情報はお返しできません。';
  return '';
}

/* ===================== 読むだけで開く(議事録システムの同名関数の代わり) ===================== */

/** マスタースプレッドシート。Chat から呼ばれるので「開いているスプレッドシート」は無く、スクリプト プロパティのIDで開く */
function masterSs_() {
  const raw = String(PropertiesService.getScriptProperties().getProperty('MASTER_SS_ID') || '').trim();
  const m = raw.match(/\/d\/([\w-]+)/);
  const id = m ? m[1] : raw;
  if (!id) throw new Error('マスタースプレッドシートが未設定です(スクリプト プロパティ MASTER_SS_ID)。管理者に連絡してください');
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    throw new Error('マスタースプレッドシートを開けません。閲覧の権限があるか確認してください');
  }
}

/**
 * 関与先マスタの行(関与先名とスプレッドシートIDのあるもの)。列は見出しの名前で探す。
 * 返す形は議事録システムの listClients_ のうち、Chat で使う項目だけ
 */
function listClients_() {
  const sh = masterSs_().getSheetByName(CFG.MASTER_SHEET);
  if (!sh) throw new Error('マスタースプレッドシートに「' + CFG.MASTER_SHEET + '」シートがありません');
  if (sh.getLastRow() < 2) return [];
  const values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
  const head = values[0].map(h => String(h).trim());
  const col = name => head.indexOf(name);
  const need = ['関与先名', 'スプレッドシートID'].filter(n => col(n) < 0);
  if (need.length) throw new Error('「' + CFG.MASTER_SHEET + '」に見出し ' + need.join('・') + ' がありません');
  const get = (v, name) => (col(name) < 0 ? '' : String(v[col(name)] || '').trim());
  return values.slice(1)
    .map((v, i) => ({ row: i + 2, name: get(v, '関与先名'), code: get(v, 'MFコード'), ssId: get(v, 'スプレッドシートID'),
      nextMtg: get(v, '次回MTG日'), kind: get(v, '区分') }))
    .filter(c => c.name && c.ssId);
}

/** 関与先ノートを読むだけで開く。必要なシートが無い古いノートは、直さずに案内を返す */
function openNotebook_(client) {
  let ss;
  try {
    ss = SpreadsheetApp.openById(client.ssId);
  } catch (e) {
    throw new Error('「' + client.name + '」の関与先ノートを開けません。ノートの閲覧の権限があるか確認してください');
  }
  const missing = [CFG.SHEET_KARTE, CFG.SHEET_TODO, CFG.SHEET_Q].filter(n => !ss.getSheetByName(n));
  // 質問票のI列「宛先」は後から増えた列。無いノートは議事録システムが開いたときに補う
  if (missing.length || ss.getSheetByName(CFG.SHEET_Q).getMaxColumns() < 9) {
    throw new Error('「' + client.name + '」の関与先ノートが古い形です' + (missing.length ? '(' + missing.join('・') + ' が無い)' : '(質問票に宛先の列が無い)') +
      '。議事録システムのパネルでこの関与先を一度扱うと補われます');
  }
  return ss;
}

/* ===================== 管理者向け(エディタから実行) ===================== */

/** 設定の確認。エディタで実行し、ログにマスターの名前と関与先の件数が出れば読めている */
function checkSetup() {
  const ss = masterSs_();
  const clients = listClients_();
  console.log('マスター: ' + ss.getName() + ' / 関与先 ' + clients.length + '件 / 共有関数の版 ' + CFG.VERSION);
}
