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
  'getReportsTransitionBalanceSheet', 'getReportsTransitionProfitLoss'].map(t => TOOL + t);
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
- 過去の仕訳を確認し、同じ内容がすでに登録されていないか調べる。重複の疑いがあるものは journals に入れず、summary の「確認事項」に書く。
- 読めない・判断できないものは推測で埋めず、「確認事項」に書く。
- 仕訳のメモ(memo)には元のファイル名を入れる。ファイルがない場合は「Chat投稿 ${job.id}」とする。
- account_id は必ずMFの一覧から取ったIDの文字列を入れる。
- tax_id・invoice_kind は、事業者の消費税の設定(課税事業者か免税事業者か)と過去の仕訳の付け方に合わせる。免税事業者や、過去の仕訳に税区分・インボイス区分が付いていない場合は、その項目ごと省く。sub_account_id も補助科目がなければ省く。どの項目も null や空欄にはしない。

# この事業者の仕訳ルール
${rulesFor(job.config)}

# 入力
投稿内容: ${job.text || '(なし)'}
添付ファイル(作業フォルダにあります。Read で読んでください): ${fileNames.length ? fileNames.join(', ') : '(なし)'}

# 出力
最後に次の形のJSONを \`\`\`json ブロックで1つだけ出す。
{
  "summary": "人が読む説明(日本語)。仕訳ごとに 日付 / 借方科目 金額 / 貸方科目 金額 / 摘要 を1行で並べ、最後に「確認事項」を箇条書き。",
  "journals": [
    { "transaction_date": "YYYY-MM-DD", "journal_type": "journal_entry", "memo": "...",
      "branches": [ { "debitor": { "account_id": "...", "sub_account_id": "(任意)", "tax_id": "...", "invoice_kind": "...", "value": 1000, "remark": "..." },
                      "creditor": { "account_id": "...", "tax_id": "...", "invoice_kind": "...", "value": 1000, "remark": "..." } } ] }
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
2. 下の journals を1件ずつ、内容を一切変えずに mfc_ca_postJournals で登録する。追加・修正・省略はしない。
3. 登録した仕訳を mfc_ca_getJournalById で1件ずつ取得し直す。
4. エラーが出たら、そこで止めて残りは登録しない。

# 登録する journals
${JSON.stringify(journals, null, 2)}

# 出力
最後に次の形のJSONを \`\`\`json ブロックで1つだけ出す。fetched は取得し直した内容を、登録時と同じ形(transaction_date と branches の debitor/creditor の account_id・sub_account_id・value)に揃えて書く。
{ "error": "(なければ空文字)",
  "results": [ { "index": 1, "journal_id": "...", "fetched": { "transaction_date": "YYYY-MM-DD", "branches": [ ... ] } } ] }`;
}

/** 借方・貸方の (科目, 補助科目, 金額) を並べたキーで比較する */
function signature(j) {
  const rows = [];
  (j.branches || []).forEach(b => {
    ['debitor', 'creditor'].forEach(side => {
      const x = b[side];
      if (x && Number(x.value)) rows.push([side, x.account_id || '', x.sub_account_id || '', Number(x.value)].join('|'));
    });
  });
  return String(j.transaction_date || '').slice(0, 10) + '#' + rows.sort().join(';');
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
    const ok = !!(expected && r.journal_id && r.fetched && signature(expected) === signature(r.fetched));
    return { index: r.index, journal_id: r.journal_id || '', ok,
      diff: ok ? '' : { expected: expected && signature(expected), fetched: r.fetched && signature(r.fetched) } };
  });
  const error = out.error || (results.length !== journals.length ? `登録件数が一致しません(予定${journals.length} / 結果${results.length})` : '');
  return { ok: !error, error, result: { results } };
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
    } else if (job.kind === 'audit') {
      const report = await handleAudit(job);
      await api('result', { id: job.id, kind: 'audit', ok: true, report });
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
module.exports = { extractJson, signature, validateJournals };
