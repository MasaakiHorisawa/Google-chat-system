/**
 * Google Chat 仕訳システム — GAS 側
 * 役割: Chat受付 / 共有フォルダ監視 / ワーカー用API / 承認 / 操作ログ
 *
 * スクリプトプロパティ:
 *   SHEET_ID        … 管理用スプレッドシートのID
 *   WORKER_TOKEN    … ワーカーとの合言葉(長いランダム文字列)
 *   INBOX_FOLDER_ID … 受け取った資料を保存するDriveフォルダのID
 *   APPROVERS       … 承認できる人のメール(カンマ区切り。空なら誰でも)
 */

const SH_CONFIG = '設定';
const SH_JOBS = 'ジョブ';
const SH_LOG = 'MF操作ログ';
const SH_SEEN = '処理済みファイル';

const CONFIG_HEADERS = ['space', '事業者名', 'office_code', 'config', 'webhook', 'folder_id', '有効'];
const JOB_HEADERS = ['id', 'created', 'source', 'space', 'office_code', 'config', 'status', 'requested_by',
  'text', 'file_ids', 'proposal', 'result', 'approved_by', 'updated', 'note'];
const LOG_HEADERS = ['日時', '事業者コード', '事業者名', '操作', 'journal_id', 'ジョブID', '内容', '承認者'];
const SEEN_HEADERS = ['file_id', 'ファイル名', 'folder_id', 'ジョブID', '日時'];

const STATUS_JA = {
  waiting: '仕訳待ち(指示待ち)', queued: '受付済み', proposing: '仕訳案を作成中', proposed: '承認待ち', approved: '承認済み(登録待ち)',
  registering: '登録中', auditing: '監査中', updating: 'ルール更新中', done: '完了', rejected: '却下', error: 'エラー'
};

const HELP_TEXT = [
  '使い方',
  '・明細や証憑を添付するか、取引の内容を書いて送る → 仕訳案を作ります',
  '・「承認 J0001」→ その仕訳案を登録します',
  '・「却下 J0001」→ 登録しません',
  '・「修正 J0001 ○○」→ 指示(確認事項への回答など)を反映して仕訳案を作り直します。何度でもできます',
  '・「ルール追加 ○○」→ この会社の仕訳ルールに追記します(次の仕訳案から反映)',
  '・「状態」→ 処理中・承認待ちのジョブを表示します',
  '・「監査 2026年9月」→ その期間の仕訳を一次監査して結果を投稿します(MFは読むだけ。期間を省くと前月)',
  '・「見に行って」→ 共有フォルダに新しい資料がないか、すぐに確認します(自動では4時間ごと)',
  '・「仕訳 J0001」→ 共有フォルダの資料の仕訳案を作ります(複数可: 仕訳 J0001 J0002)。不要なら「却下 J0001」'
].join('\n');

const CELL_LIMIT = 45000;

/* ===== 共通 ===== */

function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('スクリプトプロパティ未設定: ' + key);
  return v;
}
function ss_() { return SpreadsheetApp.openById(prop_('SHEET_ID')); }
function sheet_(name) { return ss_().getSheetByName(name); }

function safe_(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function readTable_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const headers = values.shift() || [];
  return values.map((row, i) => {
    const o = { _row: i + 2 };
    headers.forEach((h, j) => { o[h] = row[j]; });
    return o;
  });
}

function isOn_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function configs_() { return readTable_(SH_CONFIG).filter(c => c.config && isOn_(c['有効'])); }
function configBySpace_(space) { return configs_().find(c => String(c.space).trim() === String(space)) || null; }
function configByName_(name) { return configs_().find(c => String(c.config) === String(name)) || null; }

function appendNote_(job, s) { return [job.note, s].filter(String).join(' / '); }

/** 初回だけ実行: シートを用意する */
function setup() {
  const ss = ss_();
  [[SH_CONFIG, CONFIG_HEADERS], [SH_JOBS, JOB_HEADERS], [SH_LOG, LOG_HEADERS], [SH_SEEN, SEEN_HEADERS]]
    .forEach(([name, headers]) => {
      let sh = ss.getSheetByName(name);
      if (!sh) sh = ss.insertSheet(name);
      if (sh.getLastRow() === 0) sh.appendRow(headers);
    });
  // 事業者コードが日付などに化けないよう、設定シートは文字列書式にする
  ss.getSheetByName(SH_CONFIG).getRange('A:G').setNumberFormat('@');
}

/* ===== ジョブ ===== */

function nextJobId_() {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty('JOB_SEQ') || '0') + 1;
  props.setProperty('JOB_SEQ', String(n));
  return 'J' + ('0000' + n).slice(-4);
}

function createJob_(o) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const id = nextJobId_();
    const now = new Date();
    const values = {
      id: id, created: now, source: o.source, space: o.cfg.space || '', office_code: String(o.cfg.office_code),
      config: o.cfg.config, status: o.status || 'queued', requested_by: o.user || '', text: o.text || '',
      file_ids: (o.fileIds || []).join(','), proposal: '', result: '', approved_by: '', updated: now, note: o.note || ''
    };
    sheet_(SH_JOBS).appendRow(JOB_HEADERS.map(h => safe_(values[h])));
    return id;
  } finally {
    lock.releaseLock();
  }
}

function getJob_(id) { return readTable_(SH_JOBS).find(j => j.id === id) || null; }

function updateJob_(job, patch) {
  const sh = sheet_(SH_JOBS);
  patch.updated = new Date();
  Object.keys(patch).forEach(k => {
    const col = JOB_HEADERS.indexOf(k);
    if (col >= 0) sh.getRange(job._row, col + 1).setValue(safe_(patch[k]));
    job[k] = patch[k];
  });
}

function jobFolder_(config) {
  const root = DriveApp.getFolderById(prop_('INBOX_FOLDER_ID'));
  const it = root.getFoldersByName(config);
  return it.hasNext() ? it.next() : root.createFolder(config);
}

/** セルに入らない大きなJSONはDriveに逃がす */
function storeBig_(job, key, str) {
  if (str.length <= CELL_LIMIT) return str;
  const f = jobFolder_(job.config).createFile(job.id + '_' + key + '.json', str, MimeType.PLAIN_TEXT);
  return 'file:' + f.getId();
}
function loadBig_(v) {
  v = String(v || '');
  return v.indexOf('file:') === 0 ? DriveApp.getFileById(v.slice(5)).getBlob().getDataAsString('UTF-8') : v;
}

/* ===== Chat ===== */

function reply_(text) { return { text: text }; }

function onAddToSpace(event) {
  const space = event.space && event.space.name;
  const cfg = space && configBySpace_(space);
  return reply_(cfg
    ? cfg['事業者名'] + '(' + cfg.office_code + ')の仕訳受付を開始します。\n' + HELP_TEXT
    : 'このスペースはまだ事業者に登録されていません。設定シートの space 列に ' + space + ' を登録してください。');
}

function onRemoveFromSpace(event) {}

function onMessage(event) {
  const space = event.space && event.space.name;
  const msg = event.message || {};
  const user = String((event.user && event.user.email) || '').toLowerCase();
  const text = String(msg.argumentText || msg.text || '').trim();

  const cfg = configBySpace_(space);
  if (!cfg) return reply_('このスペース(' + space + ')は事業者に登録されていません。');

  const d = text.match(/^(承認|却下)\s*(J\d+)/i);
  if (d) return reply_(decide_(d[1], d[2].toUpperCase(), user, cfg));
  if (/^(状態|ステータス)$/.test(text)) return reply_(statusText_(cfg));
  const r = text.match(/^修正\s*(J\d+)\s*([\s\S]*)$/i);
  if (r) return reply_(revise_(r[1].toUpperCase(), r[2].trim(), user, cfg));
  const rule = text.match(/^ルール追加\s*([\s\S]*)$/);
  if (rule) {
    if (!rule[1].trim()) return reply_('追加するルールを書いてください(例: ルール追加 ヤオコーは福利厚生費)。');
    const id = createJob_({ source: 'rule', cfg: cfg, user: user, text: rule[1].trim() });
    return reply_('ルールの追加を受け付けました(' + id + ')。反映したらこのスペースに投稿します。');
  }
  const a = text.match(/^監査\s*(.*)$/);
  if (a) {
    const id = createJob_({ source: 'audit', cfg: cfg, user: user, text: a[1].trim() || '前月' });
    return reply_('監査を受け付けました(' + id + ')。MFは読むだけで、登録・変更はしません。終わったらこのスペースに投稿します。');
  }
  if (/^(ヘルプ|help)$/i.test(text)) return reply_(HELP_TEXT);
  if (/^(見に行って|見にいって|みにいって|フォルダ確認)$/.test(text)) return reply_(checkFolderNow_(cfg));
  const st = text.match(/^仕訳\s*((?:J\d+[\s、,]*)+)$/i);
  if (st) return reply_(startJobs_(st[1].toUpperCase().match(/J\d+/g), user, cfg));

  const saved = saveAttachments_(msg.attachment || [], cfg);
  const warn = saved.errors.length ? '\n⚠ ' + saved.errors.join('\n⚠ ') : '';
  if (!text && !saved.ids.length) return reply_('明細や証憑を添付するか、内容を書いて送ってください。' + warn);

  const id = createJob_({ source: 'chat', cfg: cfg, user: user, text: text, fileIds: saved.ids, note: saved.errors.join(' / ') });
  return reply_('受付しました(' + id + ')。仕訳案ができたらこのスペースに投稿します。' + warn);
}

function decide_(word, id, user, cfg) {
  const approvers = String(PropertiesService.getScriptProperties().getProperty('APPROVERS') || '')
    .toLowerCase().split(',').map(s => s.trim()).filter(String);
  if (approvers.length && approvers.indexOf(user) < 0) return '承認・却下の権限がありません。';

  const job = getJob_(id);
  if (!job) return id + ' が見つかりません。';
  if (String(job.space) !== String(cfg.space)) return id + ' はこのスペースのジョブではありません。';
  const ok = job.status === 'proposed' || (word === '却下' && job.status === 'waiting');
  if (!ok) return id + ' は「' + (STATUS_JA[job.status] || job.status) + '」のため' + word + 'できません。';

  if (word === '承認') {
    updateJob_(job, { status: 'approved', approved_by: user });
    return id + ' を承認しました。登録と確認が終わったら報告します。';
  }
  updateJob_(job, { status: 'rejected', approved_by: user, note: appendNote_(job, '却下') });
  return id + ' を却下しました。登録はしません。';
}

/** 承認前の仕訳案を、指示を足して作り直す(登録が始まったものは対象外) */
function revise_(id, instruction, user, cfg) {
  if (!instruction) return '修正の指示を書いてください(例: 修正 ' + id + ' ヤオコーは福利厚生費にして)。';
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const job = getJob_(id);
    if (!job) return id + ' が見つかりません。';
    if (String(job.space) !== String(cfg.space)) return id + ' はこのスペースのジョブではありません。';
    if (job.source === 'audit' || job.source === 'rule') return id + ' は仕訳のジョブではありません。';
    const notRegistered = job.status === 'proposed' || job.status === 'waiting' || (job.status === 'done' && !job.result) || (job.status === 'error' && !job.result) || (job.status === 'rejected' && !job.result);
    if (!notRegistered) return id + ' は「' + (STATUS_JA[job.status] || job.status) + '」のため修正できません(登録が始まったジョブは作り直せません)。';
    const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d H:mm');
    updateJob_(job, {
      status: 'queued',
      text: String(job.text || '') + '\n【修正指示 ' + stamp + ' ' + user + '】' + instruction,
      note: appendNote_(job, '修正指示')
    });
    return id + ' の修正を受け付けました。指示を反映した仕訳案ができたら投稿します。';
  } finally {
    lock.releaseLock();
  }
}

function statusText_(cfg) {
  const open = ['waiting', 'queued', 'proposing', 'proposed', 'approved', 'registering', 'auditing', 'updating', 'error'];
  const jobs = readTable_(SH_JOBS).filter(j => String(j.space) === String(cfg.space) && open.indexOf(j.status) >= 0);
  if (!jobs.length) return '処理中・承認待ちのジョブはありません。';
  return jobs.map(j => j.id + ' ' + (STATUS_JA[j.status] || j.status) + ' ' + String(j.text).slice(0, 30)).join('\n');
}

function saveAttachments_(atts, cfg) {
  const out = { ids: [], errors: [] };
  atts.forEach(a => {
    const name = a.contentName || 'attachment';
    try {
      let blob;
      if (a.driveDataRef && a.driveDataRef.driveFileId) {
        blob = DriveApp.getFileById(a.driveDataRef.driveFileId).getBlob();
      } else if (a.attachmentDataRef && a.attachmentDataRef.resourceName) {
        const url = 'https://chat.googleapis.com/v1/media/' + a.attachmentDataRef.resourceName + '?alt=media';
        const res = UrlFetchApp.fetch(url, {
          headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
        });
        if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
        blob = res.getBlob();
      } else {
        throw new Error('取得方法が不明');
      }
      const f = jobFolder_(cfg.config).createFile(blob.setName(name));
      out.ids.push(f.getId());
    } catch (e) {
      out.errors.push(name + ' を取得できませんでした(' + e.message + ')。Driveから添付するか、共有フォルダに置いてください。');
    }
  });
  return out;
}

/** Webhook でスペースに投稿(長文は分割) */
function postToSpace_(cfg, text) {
  if (!cfg || !cfg.webhook) return;
  const chunks = [];
  let buf = '';
  String(text).split('\n').forEach(line => {
    if ((buf + '\n' + line).length > 3800) { chunks.push(buf); buf = line; }
    else buf = buf ? buf + '\n' + line : line;
  });
  if (buf) chunks.push(buf);
  chunks.forEach(t => UrlFetchApp.fetch(cfg.webhook, {
    method: 'post', contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ text: t }), muteHttpExceptions: true
  }));
}

/* ===== ワーカー用API(Webアプリ) ===== */

function doGet() { return ContentService.createTextOutput('ok'); }

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad json' }); }
  if (!body.token || body.token !== prop_('WORKER_TOKEN')) return json_({ error: 'unauthorized' });
  try {
    if (body.action === 'ping') return json_({ ok: true });
    if (body.action === 'next') return json_(nextJob_());
    if (body.action === 'result') return json_(result_(body));
    return json_({ error: 'unknown action' });
  } catch (err) {
    return json_({ error: String((err && err.message) || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** 承認済み(登録)を優先し、なければ受付済み(仕訳案)を1件渡す */
function nextJob_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const jobs = readTable_(SH_JOBS);
    const job = jobs.find(j => j.status === 'approved') || jobs.find(j => j.status === 'queued');
    if (!job) return { job: null };

    const cfg = configByName_(job.config);
    if (!cfg) {
      updateJob_(job, { status: 'error', note: appendNote_(job, '設定シートに有効な事業者がありません') });
      return { job: null };
    }
    const base = { id: job.id, office_code: String(job.office_code), config: job.config, name: cfg['事業者名'] };

    if (job.status === 'approved') {
      updateJob_(job, { status: 'registering' });
      base.kind = 'register';
      base.proposal = loadBig_(job.proposal);
      return { job: base };
    }

    if (job.source === 'audit') {
      updateJob_(job, { status: 'auditing' });
      base.kind = 'audit';
      base.text = String(job.text || '');
      return { job: base };
    }

    if (job.source === 'rule') {
      updateJob_(job, { status: 'updating' });
      base.kind = 'rule';
      base.text = String(job.text || '');
      base.user = String(job.requested_by || '');
      return { job: base };
    }

    updateJob_(job, { status: 'proposing' });
    base.kind = 'propose';
    base.text = String(job.text || '');
    base.prev_proposal = job.proposal ? loadBig_(job.proposal) : '';
    base.files = String(job.file_ids || '').split(',').filter(String).map(id => {
      const f = DriveApp.getFileById(id);
      const b = f.getBlob();
      return { name: f.getName(), mime: b.getContentType(), base64: Utilities.base64Encode(b.getBytes()) };
    });
    return { job: base };
  } finally {
    lock.releaseLock();
  }
}

function result_(b) {
  const job = getJob_(b.id);
  if (!job) return { error: 'job not found' };
  const cfg = configByName_(job.config);

  if (b.kind === 'propose') {
    if (job.status !== 'proposing') return { error: 'status mismatch: ' + job.status };
    if (!b.ok) {
      updateJob_(job, { status: 'error', note: appendNote_(job, b.error) });
      postToSpace_(cfg, '❌ ' + job.id + ' 仕訳案を作れませんでした: ' + b.error);
      return { ok: true };
    }
    const journals = (b.proposal && b.proposal.journals) || [];
    if (!journals.length) {
      updateJob_(job, { status: 'done', proposal: storeBig_(job, 'proposal', JSON.stringify(b.proposal)), note: appendNote_(job, '仕訳なし') });
      postToSpace_(cfg, '📝 ' + job.id + ' 登録する仕訳はありませんでした。\n' + b.summary);
      return { ok: true };
    }
    updateJob_(job, { status: 'proposed', proposal: storeBig_(job, 'proposal', JSON.stringify(b.proposal)) });
    postToSpace_(cfg, '📝 ' + job.id + ' 仕訳案\n' + b.summary +
      '\n\n登録する →「承認 ' + job.id + '」/ やめる →「却下 ' + job.id + '」(アプリを@メンションして送信)');
    return { ok: true };
  }

  if (b.kind === 'register') {
    if (job.status !== 'registering') return { error: 'status mismatch: ' + job.status };
    const res = b.result || {};
    const items = res.results || [];
    const logSh = sheet_(SH_LOG);
    items.forEach(r => logSh.appendRow([
      new Date(), String(job.office_code), cfg ? cfg['事業者名'] : '', '仕訳登録', r.journal_id || '', job.id,
      r.ok ? '登録後の取得で一致' : '差異: ' + JSON.stringify(r.diff || ''), job.approved_by || ''
    ]));
    const allOk = !!b.ok && items.length > 0 && items.every(r => r.ok && r.journal_id);
    updateJob_(job, {
      status: allOk ? 'done' : 'error',
      result: storeBig_(job, 'result', JSON.stringify(res)),
      note: b.error ? appendNote_(job, b.error) : job.note
    });
    postToSpace_(cfg, allOk
      ? '✅ ' + job.id + ' ' + items.length + '件を登録し、取得し直して内容の一致を確認しました。'
      : '⚠ ' + job.id + ' 登録で問題がありました。途中まで登録されている可能性があるので、MFで確認してください。\n' +
        (b.error ? b.error + '\n' : '') +
        items.map(r => '#' + r.index + ' ' + (r.journal_id || '未登録') + ' ' + (r.ok ? 'OK' : '差異あり')).join('\n'));
    return { ok: true };
  }
  if (b.kind === 'rule') {
    if (job.status !== 'updating') return { error: 'status mismatch: ' + job.status };
    updateJob_(job, { status: b.ok ? 'done' : 'error', note: b.ok ? job.note : appendNote_(job, b.error) });
    postToSpace_(cfg, b.ok ? '📘 ' + job.id + ' 仕訳ルールに追加しました: ' + job.text
                           : '❌ ' + job.id + ' ルールを追加できませんでした: ' + b.error);
    return { ok: true };
  }

  if (b.kind === 'audit') {
    if (job.status !== 'auditing') return { error: 'status mismatch: ' + job.status };
    if (!b.ok) {
      updateJob_(job, { status: 'error', note: appendNote_(job, b.error) });
      postToSpace_(cfg, '❌ ' + job.id + ' 監査できませんでした: ' + b.error);
      return { ok: true };
    }
    const report = String(b.report || '');
    updateJob_(job, { status: 'done', result: storeBig_(job, 'audit', report) });
    postToSpace_(cfg, '🔍 ' + job.id + ' 監査結果(' + job.text + ')\n' + report);
    return { ok: true };
  }
  return { error: 'unknown kind' };
}

/* ===== 共有フォルダ監視 ===== */

/** 監視を始める前に1回だけ: いま入っているファイルを処理済み扱いにする */
function baselineFolders() {
  const seenSh = sheet_(SH_SEEN);
  const seen = new Set(readTable_(SH_SEEN).map(r => String(r.file_id)));
  configs_().filter(c => c.folder_id).forEach(cfg => {
    const it = DriveApp.getFolderById(cfg.folder_id).getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (seen.has(f.getId())) continue;
      seenSh.appendRow([f.getId(), safe_(f.getName()), cfg.folder_id, '(初期登録)', new Date()]);
      seen.add(f.getId());
    }
  });
}

/** 時間トリガーで実行: 新しいファイルを「仕訳待ち」のジョブにして、スペースで指示を待つ(フォルダ直下のみ) */
function watchFolders() {
  configs_().filter(c => c.folder_id).forEach(cfg => {
    try { scanFolder_(cfg, 10); } catch (e) { console.error(cfg.config + ': ' + e.message); }
  });
}

/** 1つの事業者のフォルダを確認する。minAge分以内に更新されたファイル(アップロード中)は次回に回す */
function scanFolder_(cfg, minAge) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  const found = [];
  try {
    const seenSh = sheet_(SH_SEEN);
    const seen = new Set(readTable_(SH_SEEN).map(r => String(r.file_id)));
    const cutoff = Date.now() - minAge * 60 * 1000;
    const it = DriveApp.getFolderById(cfg.folder_id).getFiles();
    while (it.hasNext()) {
      const f = it.next();
      const id = f.getId();
      if (seen.has(id)) continue;
      if (f.getMimeType() === MimeType.SHORTCUT) continue;
      if (f.getLastUpdated().getTime() > cutoff) continue;
      found.push(f);
      seen.add(id);
    }
  } finally {
    lock.releaseLock();
  }
  // createJob_ が同じロックを使うので、ロックを外してからジョブにする
  const made = found.map(f => {
    const copy = f.makeCopy(f.getName(), jobFolder_(cfg.config));
    const jobId = createJob_({
      source: 'folder', cfg: cfg, user: '', status: 'waiting',
      text: '共有フォルダに追加された資料: ' + f.getName(), fileIds: [copy.getId()]
    });
    sheet_(SH_SEEN).appendRow([f.getId(), safe_(f.getName()), cfg.folder_id, jobId, new Date()]);
    return { id: jobId, name: f.getName() };
  });
  if (made.length) {
    const ids = made.map(m => m.id).join(' ');
    postToSpace_(cfg, '📥 共有フォルダに新しい資料があります。仕訳しますか？\n' +
      made.map(m => m.id + ' ' + m.name).join('\n') +
      '\n\n仕訳する →「仕訳 ' + ids + '」(一部だけでも可)/ 不要 →「却下 ' + made[0].id + '」(アプリを@メンションして送信)');
  }
  return made;
}

/** Chat の「見に行って」: そのスペースの事業者のフォルダだけを今すぐ確認する */
function checkFolderNow_(cfg) {
  if (!cfg.folder_id) return 'この事業者には共有フォルダが設定されていません(設定シートの folder_id)。';
  let made;
  try { made = scanFolder_(cfg, 1); } catch (e) { return '共有フォルダを確認できませんでした: ' + e.message; }
  return made.length ? made.length + '件の新しい資料がありました(一覧をこのスペースに投稿しました)。'
                     : '新しい資料はありませんでした(1分以内に入れたファイルは次の確認で拾います)。';
}

/** 「仕訳 J0001 J0002」: 仕訳待ちのジョブを仕訳案の作成に回す */
function startJobs_(ids, user, cfg) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const jobs = readTable_(SH_JOBS);
    let started = 0;
    const lines = ids.map(id => {
      const job = jobs.find(j => j.id === id);
      if (!job) return id + ' が見つかりません。';
      if (String(job.space) !== String(cfg.space)) return id + ' はこのスペースのジョブではありません。';
      if (job.status !== 'waiting') return id + ' は「' + (STATUS_JA[job.status] || job.status) + '」のため対象外です。';
      updateJob_(job, { status: 'queued', requested_by: user, note: appendNote_(job, '仕訳指示 ' + user) });
      started++;
      return id + ' の仕訳案を作ります。';
    });
    return lines.join('\n') + (started ? '\nできたらこのスペースに投稿します。' : '');
  } finally {
    lock.releaseLock();
  }
}

/** フォルダ監視のトリガーを4時間ごとに設定 */
function installTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'watchFolders')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('watchFolders').timeBased().everyHours(4).create();
}
