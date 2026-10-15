/**
 * シート操作の共通処理と初期設定
 *
 * Chat アプリはスプレッドシートに紐づかないスクリプトとして動くため、
 * スクリプトプロパティ SHEET_ID のスプレッドシートを開いて使います。
 */

/**
 * 初期設定：管理用スプレッドシートとシートを用意し、ジョブ処理のトリガーを入れる。
 * Apps Script エディタで1回実行してください（何度実行しても既存データは消えません）。
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const id = props.getProperty(APP.PROP_SHEET_ID);
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('Google Chat 仕訳アシスタント（管理）');
    props.setProperty(APP.PROP_SHEET_ID, ss.getId());
  }

  const settings = ensureSheet_(ss, APP.SHEETS.SETTINGS, ['項目', '値', '説明']);
  const existing = settings.getRange(1, 1, Math.max(settings.getLastRow(), 1), 1).getValues().map(r => r[0]);
  DEFAULT_SETTINGS.forEach(row => {
    if (!existing.includes(row[0])) settings.appendRow(row);
  });
  settings.setColumnWidth(1, 160).setColumnWidth(2, 420).setColumnWidth(3, 320);
  settings.getRange('B:B').setWrap(true);

  ensureSheet_(ss, APP.SHEETS.OFFICES, OFFICE_COLS);
  ensureSheet_(ss, APP.SHEETS.SPACES, SPACE_COLS);
  ensureSheet_(ss, APP.SHEETS.RULES, RULE_COLS);
  const proposals = ensureSheet_(ss, APP.SHEETS.PROPOSALS, PROPOSAL_COLS);
  setListValidation_(proposals, '状態', PROPOSAL_STATUSES);
  const questions = ensureSheet_(ss, APP.SHEETS.QUESTIONS, QUESTION_COLS);
  setListValidation_(questions, '状態', QUESTION_STATUSES);
  setListValidation_(questions, '宛先', ['関与先', '事務所内']);
  const jobs = ensureSheet_(ss, APP.SHEETS.JOBS, JOB_COLS);
  setListValidation_(jobs, '状態', JOB_STATUSES);

  // ジョブの取りこぼし対策：1分ごとに待ちのジョブを処理する
  const hasTrigger = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === APP.JOB_TRIGGER_HANDLER);
  if (!hasTrigger) ScriptApp.newTrigger(APP.JOB_TRIGGER_HANDLER).timeBased().everyMinutes(1).create();

  const missing = [APP.PROP_ANTHROPIC_KEY, APP.PROP_SERVICE_ACCOUNT].filter(k => !props.getProperty(k));
  console.log(`管理用スプレッドシート：${ss.getUrl()}`);
  if (missing.length) console.log(`スクリプトプロパティに未設定の項目があります：${missing.join(', ')}`);
  console.log('「事業者」シートに事業者名・事業者番号・APIキー名を入れてください。');
}

function openBook_() {
  const id = PropertiesService.getScriptProperties().getProperty(APP.PROP_SHEET_ID);
  if (!id) throw new Error('管理用スプレッドシートが未設定です。Apps Script エディタで setup を実行してください。');
  return SpreadsheetApp.openById(id);
}

function getSheet_(name) {
  const sheet = openBook_().getSheetByName(name);
  if (!sheet) throw new Error(`「${name}」シートがありません。Apps Script エディタで setup を実行してください。`);
  return sheet;
}

/** シートがなければ作成し、1行目に見出しを入れる。既存シートは足りない列だけ右端に追加する */
function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const current = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    headers.filter(h => !current.includes(h)).forEach(h => {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
    });
  }
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold').setBackground('#f1f3f4');
  return sheet;
}

function setListValidation_(sheet, colName, values) {
  const col = headerMap_(sheet)[colName];
  if (col === undefined) return;
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
  sheet.getRange(2, col + 1, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
}

/** 見出し名 → 列番号（0始まり）の対応表 */
function headerMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { if (h !== '') map[h] = i; });
  return map;
}

/** シートの全行を {見出し名: 値} の配列で読む。_row に行番号（1始まり）を入れる */
function readRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const cols = headerMap_(sheet);
  const values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  return values.map((row, i) => {
    const obj = { _row: i + 2 };
    Object.keys(cols).forEach(name => { obj[name] = row[cols[name]]; });
    return obj;
  });
}

/** {見出し名: 値} を見出しの並びに合わせて1行追加する */
function appendObject_(sheet, obj) {
  const cols = headerMap_(sheet);
  const row = new Array(sheet.getLastColumn()).fill('');
  Object.keys(obj).forEach(name => {
    if (cols[name] !== undefined) row[cols[name]] = obj[name];
  });
  sheet.appendRow(row);
}

/** 指定行の一部の列だけ書き換える */
function updateCells_(sheet, rowNumber, obj) {
  const cols = headerMap_(sheet);
  Object.keys(obj).forEach(name => {
    if (cols[name] !== undefined) sheet.getRange(rowNumber, cols[name] + 1).setValue(obj[name]);
  });
}

/** ID列の値で1行探す */
function findRow_(sheet, idCol, id) {
  return readRows_(sheet).find(r => String(r[idCol]) === String(id)) || null;
}

/** 「設定」シートを {項目: 値} で読む（空欄は初期値で補う） */
function readSettings_() {
  const settings = {};
  DEFAULT_SETTINGS.forEach(([k, v]) => { settings[k] = v; });
  readRows_(getSheet_(APP.SHEETS.SETTINGS)).forEach(r => {
    if (r['項目'] && String(r['値']).trim() !== '') settings[r['項目']] = String(r['値']);
  });
  return settings;
}

/** 重なりにくいIDを作る（例：J-20261015-093012-4821） */
function newId_(prefix) {
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
  return `${prefix}-${stamp}-${Math.floor(1000 + Math.random() * 9000)}`;
}
