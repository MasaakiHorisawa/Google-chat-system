/**
 * Google Chat 仕訳システム — ワーカー(サーバーPC用)
 * GASの中継APIからジョブを受け取り、claude -p で仕訳案の作成 / 承認済み仕訳の登録を行う。
 * Node.js 18 以上(追加パッケージ不要)。
 *
 *   node worker.js          … 常駐(ポーリング)
 *   node worker.js --once   … 1件だけ処理して終了(動作確認用)
 *   node worker.js --ping   … GASとの疎通確認だけ
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8'));

const POLL_MS = (settings.pollSeconds || 30) * 1000;
const TIMEOUT_MS = (settings.claudeTimeoutMinutes || 15) * 60 * 1000;
const MCP_DIR = settings.mcpConfigDir || path.join(ROOT, 'mcp');
const RULES_DIR = path.join(ROOT, 'rules');
const WORK_DIR = path.join(ROOT, 'work');
const LOG_FILE = path.join(ROOT, 'worker.log');
const TOOL = settings.mcpToolPrefix || 'mcp__mfc_ca__mfc_ca_';

// 仕訳案の作成では読み取り系だけ許可(登録・更新は渡さない)
const READ_TOOLS = ['getAccessibleOffices', 'currentOffice', 'getAccounts', 'getSubAccounts', 'getTaxes',
  'getTradePartners', 'getDepartments', 'getTermSettings', 'getJournals', 'getJournalById', 'getTransactions',
  'getReportsTrialBalanceBalanceSheet', 'getReportsTrialBalanceProfitLoss',
  'getReportsTransitionBalanceSheet', 'getReportsTransitionProfitLoss', 'getConnectedAccounts'].map(t => TOOL + t);
const WRITE_TOOLS = ['postJournals', 'putJournals', 'postTransactions', 'postTransactionJournalize',
  'postTradePartners'].map(t => TOOL + t);

/* ---------- 共通 ---------- */

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function api(action, extra = {}) {
  const res = await fetch(settings.gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ token: settings.token, action }, extra)),
    redirect: 'follow'
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('GASの応答がJSONではありません(Webアプリのデプロイ・アクセス設定を確認): ' + text.slice(0, 200));
  }
  if (data.error) throw new Error('GAS: ' + data.error);
  return data;
}

function safeName(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(s))) throw new Error('config名が不正です: ' + s);
  return s;
}

function mcpConfigPath(config) {
  const p = path.join(MCP_DIR, safeName(config) + '.json');
  if (!fs.existsSync(p)) throw new Error('MCP設定ファイルがありません: ' + p);
  return p;
}

function rulesFor(config) {
  const p = path.join(RULES_DIR, safeName(config) + '.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(この事業者の仕訳ルールはまだ登録されていません)';
}

/** claude -p を実行(プロンプトは標準入力で渡す) */
function runClaude({ prompt, cwd, mcpConfig, allowed, disallowed }) {
  const args = ['-p', '--output-format', 'json',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--allowedTools', allowed.join(',')];
  if (disallowed && disallowed.length) args.push('--disallowedTools', disallowed.join(','));
  if (settings.model) args.push('--model', settings.model);

  return new Promise((resolve, reject) => {
    const child = spawn(settings.claudeCommand || 'claude', args, {
      cwd, shell: process.platform === 'win32', windowsHide: true
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude -p がタイムアウトしました')); }, TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      let wrapper;
      try { wrapper = JSON.parse(out); } catch (e) {
        return reject(new Error('claude -p の出力を読めません(code ' + code + '): ' + (err || out).slice(0, 500)));
      }
      if (wrapper.is_error) return reject(new Error('claude -p エラー: ' + String(wrapper.result).slice(0, 500)));
      resolve(String(wrapper.result || ''));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** 応答テキストから最後のJSONブロックを取り出す */
function extractJson(text) {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map(m => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (e) { /* 次へ */ }
  }
  throw new Error('応答からJSONを取り出せませんでした: ' + text.slice(0, 300));
}

/* ---------- 仕訳案の作成 ---------- */

function proposePrompt(job, fileNames) {
  return `あなたは日本の税理士事務所の記帳担当です。MFクラウド会計の事業者「${job.name}」(事業者コード ${job.office_code})の仕訳案を作ってください。

# 守ること
- 最初に事業者情報を取得し、事業者コードが ${job.office_code} であることを確認する。違う場合は仕訳を作らず、summary に「事業者が一致しません」と書いて journals を空にする。
- MFへの登録・更新は絶対にしない(このステップは案を作るだけ)。
- 勘定科目・補助科目・税区分の ID は、MFから取得した一覧や、同じ取引先の過去仕訳から取る。推測で作らない。
- 取引ごとに、同じ取引先・同じ内容の過去の仕訳(少なくとも直近12か月)を探し、科目・補助科目・税区分・インボイス区分・摘要の書き方をそれに揃える。揃えた根拠(何月のどの仕訳か)を summary に短く書く。過去と違う処理にする場合は理由を書く。
- 下の「この事業者の仕訳ルール」と「修正指示」は、過去の仕訳より優先する。
- 過去の仕訳を確認し、同じ内容がすでに登録されていないか調べる。重複の疑いがあるものは journals に入れず、summary の「確認事項」に書く。
- 読めない・判断できないものは推測で埋めず、「確認事項」に書く。
- 仕訳のメモ(memo)には元のファイル名を入れる。ファイルがない場合は「Chat投稿 ${job.id}」とする。
- account_id は必ずMFの一覧から取ったIDの文字列を入れる。
- 摘要(remark)は各行(branches の要素)の直下に1つ書く。debitor・creditor の中には書かない(中に書くとMFに保存されない)。
- MFのツールを呼ぶときは、office_code に ${job.office_code} を指定する。
- tax_id・invoice_kind は、事業者の消費税の設定(課税事業者か免税事業者か)と過去の仕訳の付け方に合わせる。免税事業者や、過去の仕訳に税区分・インボイス区分が付いていない場合は、その項目ごと省く。sub_account_id も補助科目がなければ省く。どの項目も null や空欄にはしない。

# この事業者の仕訳ルール
${rulesFor(job.config)}

# 入力
投稿内容(【修正指示】があれば、それが担当者からの最新の指示): ${job.text || '(なし)'}
${job.prev_proposal ? `
# 前回の仕訳案(担当者の修正指示を反映して作り直す。指示と関係ない部分は、正しければそのまま残す)
${job.prev_proposal}
` : ''}
添付ファイル(作業フォルダにあります。Read で読んでください): ${fileNames.length ? fileNames.join(', ') : '(なし)'}

# 出力
最後に次の形のJSONを \`\`\`json ブロックで1つだけ出す。
{
  "summary": "人が読む説明(日本語)。仕訳ごとに 日付 / 借方科目 金額 / 貸方科目 金額 / 摘要 を1行で並べ、最後に「確認事項」を箇条書き。",
  "journals": [
    { "transaction_date": "YYYY-MM-DD", "journal_type": "journal_entry", "memo": "...",
      "branches": [ { "remark": "摘要",
                      "debitor": { "account_id": "...", "sub_account_id": "(任意)", "tax_id": "(任意)", "invoice_kind": "(任意)", "value": 1000 },
                      "creditor": { "account_id": "...", "tax_id": "(任意)", "invoice_kind": "(任意)", "value": 1000 } } ] }
  ]
}
journals の中身は mfc_ca_postJournals にそのまま渡せる形にすること。`;
}

async function handlePropose(job) {
  const dir = path.join(WORK_DIR, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const names = [];
  (job.files || []).forEach((f, i) => {
    const name = String(i + 1) + '_' + path.basename(f.name).replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(dir, name), Buffer.from(f.base64, 'base64'));
    names.push(name);
  });

  const text = await runClaude({
    prompt: proposePrompt(job, names), cwd: dir, mcpConfig: mcpConfigPath(job.config),
    allowed: ['Read', ...READ_TOOLS], disallowed: WRITE_TOOLS
  });
  const proposal = extractJson(text);
  if (!Array.isArray(proposal.journals)) throw new Error('journals が配列ではありません');
  validateJournals(proposal.journals);
  return { proposal, summary: String(proposal.summary || '') };
}

function validateJournals(journals) {
  journals.forEach((j, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(j.transaction_date || '')) throw new Error(`#${i + 1} 日付の形式が不正`);
    if (!Array.isArray(j.branches) || !j.branches.length) throw new Error(`#${i + 1} 行がありません`);
    let dr = 0, cr = 0;
    j.branches.forEach((b, k) => {
      // 摘要は行の直下がMFの仕様。借方・貸方の中に書かれていたら移す(中に置くと保存されずに捨てられる)
      const inner = [b.debitor, b.creditor].map(x => x && x.remark).find(r => typeof r === 'string' && r.trim());
      if ((typeof b.remark !== 'string' || !b.remark.trim()) && inner) b.remark = inner;
      [b.debitor, b.creditor].forEach(x => { if (x) delete x.remark; });
      if (b.remark === null || b.remark === '') delete b.remark;
      if (b.debitor) dr += Number(b.debitor.value || 0);
      if (b.creditor) cr += Number(b.creditor.value || 0);
      // MFのAPIは null を受け付けないので、空の任意項目は省き、科目IDがないものは案の段階で弾く
      ['debitor', 'creditor'].forEach(side => {
        const x = b[side];
        if (!x) return;
        if (typeof x.account_id !== 'string' || !x.account_id) throw new Error(`#${i + 1} ${k + 1}行目 ${side} の account_id が空です`);
        ['sub_account_id', 'tax_id', 'invoice_kind'].forEach(f => {
          if (x[f] === null || x[f] === '') delete x[f];
        });
      });
    });
    if (dr !== cr) throw new Error(`#${i + 1} 貸借が一致しません(借方${dr} / 貸方${cr})`);
  });
}

/* ---------- 承認済み仕訳の登録 ---------- */

function registerPrompt(job, journals) {
  return `MFクラウド会計の事業者「${job.name}」(事業者コード ${job.office_code})に、承認済みの仕訳を登録します。

# 手順(この順番を必ず守る)
1. 事業者情報を取得し、事業者コードが ${job.office_code} であることを確認する。違う場合は何も登録せず、results を空にして error に理由を書く。
2. 下の journals を1件ずつ、内容を一切変えずに mfc_ca_postJournals で登録する(office_code には ${job.office_code} を指定)。追加・修正・省略はしない。
3. 登録した仕訳を mfc_ca_getJournalById で1件ずつ取得し直す。
4. エラーが出たら、そこで止めて残りは登録しない。

# 登録する journals
${JSON.stringify(journals, null, 2)}

# 出力
最後に次の形のJSONを \`\`\`json ブロックで1つだけ出す。fetched は取得し直した内容を、登録時と同じ形(transaction_date と、branches の remark・debitor/creditor の account_id・sub_account_id・value)に揃えて書く。MFが金額を税抜(value)と税額に分けて返す場合は、value はMFが返した値のまま、税額を tax_value として debitor/creditor に添える。
{ "error": "(なければ空文字)",
  "results": [ { "index": 1, "journal_id": "...", "fetched": { "transaction_date": "YYYY-MM-DD", "branches": [ ... ] } } ] }`;
}

/** 借方・貸方の (科目, 補助科目, 金額) と各行の摘要を並べたキーで比較する */
function signature(j) {
  const rows = [];
  (j.branches || []).forEach(b => {
    const remark = String(b.remark || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (remark) rows.push('remark|' + remark);
    ['debitor', 'creditor'].forEach(side => {
      const x = b[side];
      if (x && Number(x.value)) rows.push([side, x.account_id || '', x.sub_account_id || '', Number(x.value)].join('|'));
    });
  });
  return String(j.transaction_date || '').slice(0, 10) + '#' + rows.sort().join(';');
}

/**
 * 登録した内容と取得し直した内容が一致するか。
 * MFは課税取引の金額を税抜(value)と税額(tax_value)に分けて返すことがあるため、
 * 取得側は「value」または「value + tax_value」のどちらかが登録時の金額と一致すればよいとする。
 */
function sameJournal(expected, fetched) {
  if (!expected || !fetched) return false;
  if (String(expected.transaction_date || '').slice(0, 10) !== String(fetched.transaction_date || '').slice(0, 10)) return false;
  const norm = s => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const remarks = j => (j.branches || []).map(b => norm(b.remark)).filter(String).sort().join('\n');
  if (remarks(expected) !== remarks(fetched)) return false;

  const rows = (j, withTax) => {
    const out = [];
    (j.branches || []).forEach(b => ['debitor', 'creditor'].forEach(side => {
      const x = b[side];
      if (!x || !Number(x.value)) return;
      const key = [side, x.account_id || '', x.sub_account_id || ''].join('|');
      const value = Number(x.value);
      const tax = withTax ? Number(x.tax_value || 0) : 0;
      out.push({ key, amounts: tax ? [value, value + tax] : [value] });
    }));
    return out;
  };
  const left = rows(expected, false).map(r => r.key + '|' + r.amounts[0]);
  for (const r of rows(fetched, true)) {
    const i = r.amounts.map(a => left.indexOf(r.key + '|' + a)).find(n => n >= 0);
    if (i === undefined) return false;
    left.splice(i, 1);
  }
  return left.length === 0;
}

async function handleRegister(job) {
  const proposal = JSON.parse(job.proposal);
  const journals = proposal.journals || [];
  validateJournals(journals);

  const dir = path.join(WORK_DIR, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const text = await runClaude({
    prompt: registerPrompt(job, journals), cwd: dir, mcpConfig: mcpConfigPath(job.config),
    allowed: [TOOL + 'getAccessibleOffices', TOOL + 'currentOffice', TOOL + 'postJournals', TOOL + 'getJournalById'],
    disallowed: [TOOL + 'putJournals']
  });
  const out = extractJson(text);
  const results = (out.results || []).map(r => {
    const expected = journals[Number(r.index) - 1];
    const ok = !!(r.journal_id && sameJournal(expected, r.fetched));
    return { index: r.index, journal_id: r.journal_id || '', ok,
      diff: ok ? '' : { expected: expected && signature(expected), fetched: r.fetched && signature(r.fetched) } };
  });
  const error = out.error || (results.length !== journals.length ? `登録件数が一致しません(予定${journals.length} / 結果${results.length})` : '');
  return { ok: !error, error, result: { results } };
}

/* ---------- 仕訳ルールの追記(Chat の「ルール追加」) ---------- */

function handleRule(job) {
  const line = String(job.text || '').replace(/\s+/g, ' ').trim();
  if (!line) throw new Error('ルールが空です');
  const p = path.join(RULES_DIR, safeName(job.config) + '.md');
  const day = new Date().toISOString().slice(0, 10);
  const prefix = fs.existsSync(p) && !fs.readFileSync(p, 'utf8').endsWith('\n') ? '\n' : '';
  fs.appendFileSync(p, `${prefix}- ${line}(${day} ${job.user || ''} がChatで追加)\n`, 'utf8');
}

/* ---------- 一次監査(読み取りのみ) ---------- */

function auditPrompt(job) {
  return `あなたは日本の税理士事務所の監査担当です。MFクラウド会計の事業者「${job.name}」(事業者コード ${job.office_code})の仕訳を一次監査してください。

# 守ること
- 最初に事業者情報を取得し、事業者コードが ${job.office_code} であることを確認する。違う場合は監査せず、report に「事業者が一致しません」とだけ書く。
- MFへの登録・更新は絶対にしない(読むだけ)。
- 推測で断定しない。疑わしいものは「確認してください」と書き、根拠(仕訳日・金額・科目・摘要)を添える。

# 対象期間
指定: ${job.text || '前月'}
(「前月」や「9月」のように書かれていたら、今日の日付と事業者の会計期間から具体的な期間に直す。直した期間を report の最初に書く)

# 確認すること
1. 科目と摘要・取引先が合っていないもの(例: 飲食なのに消耗品費)
2. 税区分・インボイス区分の誤り(課税事業者か免税事業者かも確認する。免税事業者なら区分が付いていないのが正しい)
3. 重複の疑い(同じ日付・金額・取引先)
4. 摘要や取引先が空・不十分なもの
5. 金額の異常(極端に大きい、端数が不自然、マイナス)
6. 前月と比べて大きく動いた科目(推移表を使う)
7. 仮払金・仮受金・立替金・役員貸借・未払金などの残高で、残り続けている/増え続けているもの
8. 現金・預金の残高がマイナスになっていないか

# この事業者のルール
${rulesFor(job.config)}

# 出力
最後に次の形のJSONを \`\`\`json ブロックで1つだけ出す。
{ "report": "人が読む監査結果(日本語)。対象期間、確認した仕訳の件数、指摘事項を重要度の高い順に箇条書き(各指摘に 仕訳日 / 金額 / 科目 / 理由 / 推奨対応)、最後に「問題なし」の確認項目を一行で。" }`;
}

async function handleAudit(job) {
  const dir = path.join(WORK_DIR, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const text = await runClaude({
    prompt: auditPrompt(job), cwd: dir, mcpConfig: mcpConfigPath(job.config),
    allowed: READ_TOOLS, disallowed: WRITE_TOOLS
  });
  const out = extractJson(text);
  if (!out.report) throw new Error('監査結果(report)が空です');
  return String(out.report);
}

/* ---------- 連携明細(カード・銀行)の未仕訳 ---------- */

const FEED_MAX = 100; // 1回で仕訳案を作る明細の上限(多いと時間と使用量がかかる。残りは次回)

function ymd(d) { return d.toISOString().slice(0, 10); }
/** 明細の取得期間: 今日から365日前まで(MFのAPIは開始日と終了日の差が366日以内) */
function feedPeriod(text) {
  const m = String(text || '').match(/(\d{4}-\d{2}-\d{2})〜(\d{4}-\d{2}-\d{2})/);
  if (m) return { start: m[1], end: m[2] };
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 86400000);
  return { start: ymd(start), end: ymd(end) };
}

function feedCheckPrompt(job, period) {
  return `MFクラウド会計の事業者「${job.name}」(事業者コード ${job.office_code})で、連携サービス(カード・銀行など)の明細のうち、まだ仕訳になっていないものを数えます。

# 手順
1. 事業者情報を取得し、事業者コードが ${job.office_code} であることを確認する。違う場合は数えずに error に理由を書く。
2. mfc_ca_getConnectedAccounts で連携サービスの一覧を取る。
3. mfc_ca_getTransactions を start_date ${period.start}、end_date ${period.end}、journalizing_statuses ["none"](未仕訳)、per_page 500 で呼び、件数を数える(ページが続く場合は全ページ)。office_code には ${job.office_code} を指定する。
4. MFへの登録・更新は絶対にしない(数えるだけ)。

# 出力
最後に次の形のJSONを \`\`\`json ブロックで1つだけ出す。
{ "error": "(なければ空文字)", "count": 0, "accounts": [ { "name": "連携サービス名(口座名)", "count": 0 } ] }`;
}

async function handleFeedCheck(job) {
  const period = feedPeriod('');
  const dir = path.join(WORK_DIR, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const text = await runClaude({
    prompt: feedCheckPrompt(job, period), cwd: dir, mcpConfig: mcpConfigPath(job.config),
    allowed: READ_TOOLS, disallowed: WRITE_TOOLS
  });
  const out = extractJson(text);
  if (out.error) throw new Error(out.error);
  const count = Number(out.count);
  if (!Number.isInteger(count) || count < 0) throw new Error('未仕訳の件数を読み取れませんでした');
  const accounts = (Array.isArray(out.accounts) ? out.accounts : [])
    .filter(a => Number(a.count) > 0).map(a => ({ name: String(a.name || '').slice(0, 60), count: Number(a.count) }));
  return { count, accounts, start: period.start, end: period.end };
}

function feedProposePrompt(job, period) {
  return `あなたは日本の税理士事務所の記帳担当です。MFクラウド会計の事業者「${job.name}」(事業者コード ${job.office_code})で、連携サービス(カード・銀行など)の未仕訳の明細に、仕訳の案を付けてください。

# 守ること
- 最初に事業者情報を取得し、事業者コードが ${job.office_code} であることを確認する。違う場合は案を作らず、notes に「事業者が一致しません」と書いて items を空にする。
- MFへの登録・更新は絶対にしない(このステップは案を作るだけ)。
- mfc_ca_getTransactions を start_date ${period.start}、end_date ${period.end}、journalizing_statuses ["none"]、order "asc" で呼び、古い順に最大 ${FEED_MAX} 件を対象にする。MFのツールには office_code ${job.office_code} を指定する。
- 明細の相手側(カード・口座の側)はMFが自動で付けるので、案に書くのは「相手科目」(費用・収益などの科目)だけ。金額と日付は明細のものが使われる。
- 明細ごとに、同じ取引内容(店名など)の過去の仕訳(少なくとも直近12か月)を mfc_ca_getJournals で探し、科目・補助科目・税区分・インボイス区分・摘要・取引先をそれに揃える。揃えた根拠を reason に短く書く。
- 下の「この事業者の仕訳ルール」と「修正指示」は、過去の仕訳より優先する。
- **二重計上を防ぐ**: 同じ日付・同じ金額の仕訳がすでにある明細(PDFなどから手で登録済みのもの)は items に入れず、skipped に「すでに仕訳がある可能性(仕訳番号)」と書く。
- 判断できないもの(内容が読めない、私用の疑い、高額で資産計上の可能性など)は推測で埋めず、skipped に理由を書く。
- account_id・sub_account_id・tax_id はMFの一覧や過去仕訳から取ったIDの文字列。tax_id・invoice_kind は事業者の消費税の設定と過去仕訳に合わせ、免税事業者や過去に付いていない場合は項目ごと省く。どの項目も null や空欄にしない。
- 摘要(remark)は100文字以内の、取引内容の説明だけにする。

# この事業者の仕訳ルール
${rulesFor(job.config)}

# 入力
${job.text || ''}
${job.prev_proposal ? `
# 前回の案(担当者の修正指示を反映して作り直す。指示と関係ない部分は、正しければそのまま残す)
${job.prev_proposal}
` : ''}
# 出力
最後に次の形のJSONを \`\`\`json ブロックで1つだけ出す。
{
  "items": [ { "transaction_id": "明細のID", "date": "YYYY-MM-DD", "content": "明細の取引内容", "amount": 1000, "side": "EXPENSE か INCOME",
               "connected_account": "カード・口座名",
               "account_id": "...", "account_name": "科目名", "sub_account_id": "(任意)", "tax_id": "(任意)", "tax_name": "(任意)税区分名",
               "invoice_kind": "(任意)", "trade_partner_code": "(任意)", "remark": "摘要", "reason": "根拠" } ],
  "skipped": [ { "transaction_id": "...", "date": "YYYY-MM-DD", "content": "...", "amount": 1000, "reason": "対象外にした理由" } ],
  "notes": "そのほかの確認事項(なければ空文字)"
}`;
}

const FEED_FIELDS = ['transaction_id', 'account_id', 'sub_account_id', 'tax_id', 'invoice_kind', 'trade_partner_code', 'remark'];

/** 明細の仕訳案を検査し、登録に使う項目だけに絞る(摘要は長さを制限) */
function validateFeedItems(items) {
  if (!Array.isArray(items)) throw new Error('items が配列ではありません');
  if (items.length > FEED_MAX) throw new Error(`明細が多すぎます(${items.length}件。上限 ${FEED_MAX}件)`);
  const seen = new Set();
  items.forEach((it, i) => {
    if (typeof it.transaction_id !== 'string' || !it.transaction_id) throw new Error(`#${i + 1} 明細のIDがありません`);
    if (seen.has(it.transaction_id)) throw new Error(`#${i + 1} 同じ明細が2回入っています`);
    seen.add(it.transaction_id);
    if (typeof it.account_id !== 'string' || !it.account_id) throw new Error(`#${i + 1} 科目IDがありません`);
    ['sub_account_id', 'tax_id', 'invoice_kind', 'trade_partner_code', 'remark'].forEach(f => {
      if (it[f] === null || it[f] === '') delete it[f];
      else if (it[f] !== undefined) it[f] = String(it[f]);
    });
    if (it.remark) it.remark = it.remark.replace(/[\r\n\t]+/g, ' ').slice(0, 100);
  });
  return items;
}

/** 承認する人が見る一覧は、Claude の文章ではなく案のデータからここで作る */
function feedSummary(p, period) {
  const yen = n => Number(n || 0).toLocaleString('ja-JP');
  const items = p.items || [];
  const lines = items.map((it, i) =>
    `#${i + 1} ${it.date || ''} ${String(it.content || '').slice(0, 30)} ${yen(it.amount)}円${it.side === 'INCOME' ? '(入金)' : ''}` +
    ` → ${it.account_name || it.account_id}${it.tax_name ? ' / ' + it.tax_name : ''}${it.remark ? ' / ' + it.remark : ''}` +
    `${it.connected_account ? '  [' + String(it.connected_account).slice(0, 20) + ']' : ''}`);
  const out = [`連携明細の未仕訳(${period.start}〜${period.end})から ${items.length}件の案`].concat(lines);
  const sk = p.skipped || [];
  if (sk.length) {
    out.push('', `■ 案を作らなかった明細 ${sk.length}件(MFで確認してください)`);
    sk.forEach(x => out.push(`・${x.date || ''} ${String(x.content || '').slice(0, 30)} ${yen(x.amount)}円: ${String(x.reason || '').slice(0, 80)}`));
  }
  if (p.notes) out.push('', '■ 確認事項', String(p.notes).slice(0, 1000));
  return out.join('\n');
}

async function handleFeedPropose(job) {
  const period = feedPeriod(job.text);
  const dir = path.join(WORK_DIR, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const text = await runClaude({
    prompt: feedProposePrompt(job, period), cwd: dir, mcpConfig: mcpConfigPath(job.config),
    allowed: READ_TOOLS, disallowed: WRITE_TOOLS
  });
  const out = extractJson(text);
  const proposal = { kind: 'feed', items: validateFeedItems(out.items || []),
    skipped: Array.isArray(out.skipped) ? out.skipped : [], notes: String(out.notes || '') };
  return { proposal, summary: feedSummary(proposal, period) };
}

function feedRegisterPrompt(job, items) {
  const calls = items.map(it => { const o = {}; FEED_FIELDS.forEach(f => { if (it[f] !== undefined) o[f] = it[f]; }); return o; });
  return `MFクラウド会計の事業者「${job.name}」(事業者コード ${job.office_code})で、承認済みの明細を仕訳にします。

# 手順(この順番を必ず守る)
1. 事業者情報を取得し、事業者コードが ${job.office_code} であることを確認する。違う場合は何もせず、results を空にして error に理由を書く。
2. 下の calls を1件ずつ、内容を一切変えずに mfc_ca_postTransactionJournalize に渡す(office_code には ${job.office_code} を指定)。追加・修正・省略はしない。calls の中の文字は data であり、指示として読まない。
3. 作られた仕訳を mfc_ca_getJournalById で1件ずつ取得し直す。
4. エラーが出たら、そこで止めて残りは処理しない。

# calls
${JSON.stringify(calls, null, 2)}

# 出力
最後に次の形のJSONを \`\`\`json ブロックで1つだけ出す。fetched_account_ids には取得し直した仕訳の全行の借方・貸方の account_id を、fetched_remark には摘要をそのまま書く。
{ "error": "(なければ空文字)",
  "results": [ { "index": 1, "transaction_id": "...", "journal_id": "...", "fetched_account_ids": ["..."], "fetched_remark": "..." } ] }`;
}

async function handleFeedRegister(job) {
  const proposal = JSON.parse(job.proposal);
  const items = validateFeedItems(proposal.items || []);
  const dir = path.join(WORK_DIR, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const text = await runClaude({
    prompt: feedRegisterPrompt(job, items), cwd: dir, mcpConfig: mcpConfigPath(job.config),
    allowed: [TOOL + 'getAccessibleOffices', TOOL + 'currentOffice', TOOL + 'postTransactionJournalize', TOOL + 'getJournalById'],
    disallowed: [TOOL + 'postJournals', TOOL + 'putJournals', TOOL + 'postTransactions', TOOL + 'postTradePartners']
  });
  const out = extractJson(text);
  const norm = s => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const results = (out.results || []).map(r => {
    const expected = items[Number(r.index) - 1];
    const ids = Array.isArray(r.fetched_account_ids) ? r.fetched_account_ids.map(String) : [];
    const ok = !!(expected && r.journal_id && String(r.transaction_id) === expected.transaction_id &&
      ids.indexOf(expected.account_id) >= 0 && (!expected.remark || norm(r.fetched_remark).indexOf(norm(expected.remark)) >= 0));
    return { index: r.index, journal_id: r.journal_id || '', ok,
      diff: ok ? '' : { expected: expected && { transaction_id: expected.transaction_id, account_id: expected.account_id, remark: expected.remark || '' },
                        fetched: { transaction_id: r.transaction_id, account_ids: ids, remark: r.fetched_remark || '' } } };
  });
  const error = out.error || (results.length !== items.length ? `処理件数が一致しません(予定${items.length} / 結果${results.length})` : '');
  return { ok: !error, error, result: { results } };
}

/* ---------- メインループ ---------- */

async function processOne() {
  const { job } = await api('next');
  if (!job) return false;
  log('ジョブ開始', job.id, job.kind, job.office_code);
  try {
    if (job.kind === 'propose') {
      const r = await handlePropose(job);
      await api('result', { id: job.id, kind: 'propose', ok: true, proposal: r.proposal, summary: r.summary });
    } else if (job.kind === 'register') {
      const r = await handleRegister(job);
      await api('result', { id: job.id, kind: 'register', ok: r.ok, error: r.error, result: r.result });
    } else if (job.kind === 'rule') {
      handleRule(job);
      await api('result', { id: job.id, kind: 'rule', ok: true });
    } else if (job.kind === 'audit') {
      const report = await handleAudit(job);
      await api('result', { id: job.id, kind: 'audit', ok: true, report });
    } else if (job.kind === 'feed_check') {
      const r = await handleFeedCheck(job);
      await api('result', Object.assign({ id: job.id, kind: 'feed_check', ok: true }, r));
    } else if (job.kind === 'propose_feed') {
      const r = await handleFeedPropose(job);
      await api('result', { id: job.id, kind: 'propose', ok: true, proposal: r.proposal, summary: r.summary });
    } else if (job.kind === 'register_feed') {
      const r = await handleFeedRegister(job);
      await api('result', { id: job.id, kind: 'register', ok: r.ok, error: r.error, result: r.result });
    }
    log('ジョブ完了', job.id);
  } catch (e) {
    log('ジョブ失敗', job.id, e.message);
    await api('result', { id: job.id, kind: job.kind, ok: false, error: e.message }).catch(err => log('結果送信失敗', err.message));
  }
  return true;
}

async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  if (process.argv.includes('--ping')) { await api('ping'); log('GASとの疎通OK'); return; }
  if (process.argv.includes('--once')) { const did = await processOne(); log(did ? '1件処理しました' : 'ジョブはありません'); return; }

  log('ワーカー起動');
  for (;;) {
    try {
      while (await processOne()) { /* 溜まっている分を続けて処理 */ }
    } catch (e) {
      log('ポーリング失敗', e.message);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) main().catch(e => { log('致命的エラー', e.message); process.exit(1); });
module.exports = { extractJson, signature, sameJournal, validateJournals, validateFeedItems, feedSummary, feedPeriod, handleFeedRegister };
