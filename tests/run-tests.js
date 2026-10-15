/**
 * GAS コードを Node.js で確認するテスト
 *
 * 実行：node tests/run-tests.js
 * Claude・MF・Google Chat には接続しません（UrlFetchApp やシートはテスト用の偽物に置き換えています）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const gasDir = path.join(__dirname, '..', 'gas');
const source = fs.readdirSync(gasDir)
  .filter(f => f.endsWith('.gs'))
  .sort()
  .map(f => fs.readFileSync(path.join(gasDir, f), 'utf8'))
  .join('\n');

/** メモリ上の偽シート（getRange / appendRow など使う分だけ） */
function fakeSheet(headers) {
  const data = [headers.slice()];
  return {
    data,
    getLastRow: () => data.length,
    getLastColumn: () => data[0].length,
    appendRow: row => data.push(row.slice()),
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        getValues: () => data.slice(r - 1, r - 1 + nr).map(row => {
          const out = [];
          for (let i = 0; i < nc; i++) out.push(row[c - 1 + i] === undefined ? '' : row[c - 1 + i]);
          return out;
        }),
        setValue: v => { data[r - 1][c - 1] = v; },
      };
    },
  };
}

const props = { ANTHROPIC_API_KEY: 'sk-ant-test', MF_API_KEY_01: 'mf-key-01' };
const context = {
  console: { log() {}, warn() {}, error() {} },
  Date, JSON, Math, Object, String, Number, Array,
  fetchQueue: [],
  fetchCalls: [],
  sleeps: [],
  sheets: {},
  Utilities: {
    sleep(ms) { context.sleeps.push(ms); },
    formatDate() { return '20261015-093000'; },
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  UrlFetchApp: {
    fetch(url, req) {
      context.fetchCalls.push({ url, req });
      const next = context.fetchQueue.shift();
      if (!next) throw new Error(`想定外の通信：${url}`);
      if (next.throw) throw new Error(next.throw);
      return {
        getResponseCode: () => next.code || 200,
        getContentText: () => next.body || '',
        getHeaders: () => next.headers || {},
      };
    },
  },
};
vm.createContext(context);

const tests = [];
context.test = (name, fn) => tests.push({ name, fn });
context.assert = assert;
// vm の中で作った配列・オブジェクトは Node 側と生成元が違うため、JSON にして比べる
context.sameJson = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
context.fakeSheet = fakeSheet;

vm.runInContext(source + '\n' + `
// シートは偽物を使う
getSheet_ = name => sheets[name];
function resetSheets() {
  sheets['事業者'] = fakeSheet(OFFICE_COLS);
  sheets['事業者'].appendRow(['テスト商事', '1234-5678', 'MF_API_KEY_01', '']);
  sheets['仕訳案'] = fakeSheet(PROPOSAL_COLS);
  sheets['質問'] = fakeSheet(QUESTION_COLS);
  sheets['スペース'] = fakeSheet(SPACE_COLS);
  sheets['仕訳ルール'] = fakeSheet(RULE_COLS);
  sheets['ジョブ'] = fakeSheet(JOB_COLS);
  Object.keys(MF_SESSIONS_).forEach(k => delete MF_SESSIONS_[k]);
  fetchCalls.length = 0;
  fetchQueue.length = 0;
}

const MASTER = {
  accounts: [{ id: 'A1', name: '旅費交通費' }, { id: 'A2', name: '現金' }, { id: 'A3', name: '普通預金' }, { id: 'A4', name: '会議費' }],
  taxes: [{ id: 'T1', name: '課税仕入 10%' }, { id: 'T2', name: '対象外' }],
};

const PROPOSAL = {
  is_journal: true, summary: 'タクシー領収書', transaction_date: '2025-09-12', confidence: 'high', notes: '',
  branches: [{ debit_account: '旅費交通費', debit_tax: '課税仕入 10%', debit_amount: 3300, credit_account: '現金', credit_tax: '対象外', credit_amount: 3300, remark: '〇〇交通 タクシー代' }],
  client_question: { needed: true, question: '2025年9月12日のタクシー代3,300円は、どなたがどちらへ移動されたものでしょうか。', reason: '私用の可能性' },
};

test('コマンドを読み取る（全角スラッシュも可）', () => {
  sameJson(parseCommand_('/事業者 テスト商事'), { cmd: '事業者', arg: 'テスト商事' });
  sameJson(parseCommand_('／未仕訳'), { cmd: '未仕訳', arg: '' });
  assert.strictEqual(parseCommand_('9/12 タクシー 3,300円'), null);
});

test('期間を読み取る', () => {
  assert.strictEqual(JSON.stringify(parsePeriod_('2025-09', '2026-10-15')), '{"start":"2025-09-01","end":"2025-09-30"}');
  assert.strictEqual(JSON.stringify(parsePeriod_('2024/2', '2026-10-15')), '{"start":"2024-02-01","end":"2024-02-29"}');
  assert.strictEqual(JSON.stringify(parsePeriod_('2025-09-01 2025-09-15', '2026-10-15')), '{"start":"2025-09-01","end":"2025-09-15"}');
  assert.strictEqual(JSON.stringify(parsePeriod_('', '2026-10-15')), '{"start":"2026-09-15","end":"2026-10-15"}');
  assert.strictEqual(parsePeriod_('2025-13', '2026-10-15'), null);
  assert.strictEqual(parsePeriod_('来月', '2026-10-15'), null);
});

test('修正の指示を読み取る（「修正申告」は修正扱いにしない）', () => {
  assert.strictEqual(JSON.stringify(parseRevision_('修正：貸方は未払金')), '{"explicit":true,"id":"","text":"貸方は未払金"}');
  assert.strictEqual(JSON.stringify(parseRevision_('修正 P-20261015-093000-1234：会議費')), '{"explicit":true,"id":"P-20261015-093000-1234","text":"会議費"}');
  assert.strictEqual(parseRevision_('修正申告について').explicit, false);
});

test('仕訳案を MF の仕訳に変換する', () => {
  const r = toMfJournal_(PROPOSAL, MASTER);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(JSON.stringify(r.journal.branches[0]), JSON.stringify({
    remark: '〇〇交通 タクシー代',
    debitor: { account_id: 'A1', value: 3300, tax_id: 'T1' },
    creditor: { account_id: 'A2', value: 3300, tax_id: 'T2' },
  }));
  assert.strictEqual(r.journal.journal_type, 'journal_entry');
  assert.strictEqual(r.journal.transaction_date, '2025-09-12');
});

test('全角半角・空白の違いは同じ科目として扱う', () => {
  const p = JSON.parse(JSON.stringify(PROPOSAL));
  p.branches[0].debit_tax = '課税仕入 １０％';
  assert.strictEqual(toMfJournal_(p, MASTER).errors.length, 0);
});

test('科目の誤り・貸借不一致・日付なしは登録させない', () => {
  const p = JSON.parse(JSON.stringify(PROPOSAL));
  p.branches[0].debit_account = '交通費';
  p.branches[0].credit_amount = 3000;
  p.transaction_date = '';
  const r = toMfJournal_(p, MASTER);
  assert.strictEqual(r.journal, null);
  assert.match(r.errors.join('\\n'), /取引日/);
  assert.match(r.errors.join('\\n'), /借方科目「交通費」が MF にありません/);
  assert.match(r.errors.join('\\n'), /借方合計（3,300円）と貸方合計（3,000円）が合いません/);
});

test('複合仕訳（片側だけの行）も貸借が合えば通る', () => {
  const p = JSON.parse(JSON.stringify(PROPOSAL));
  p.branches = [
    { debit_account: '旅費交通費', debit_tax: '課税仕入 10%', debit_amount: 2000, credit_account: '現金', credit_tax: '', credit_amount: 3300, remark: '' },
    { debit_account: '会議費', debit_tax: '課税仕入 10%', debit_amount: 1300, credit_account: '', credit_tax: '', credit_amount: 0, remark: '' },
  ];
  const r = toMfJournal_(p, MASTER);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.journal.branches[1].creditor, undefined);
});

test('明細の仕訳案を変換する', () => {
  const r = toMfTransactionJournalize_({ transaction_id: 'TR1', account: '会議費', tax: '課税仕入 10%', remark: 'カフェ' }, MASTER);
  assert.strictEqual(JSON.stringify(r.args), '{"transaction_id":"TR1","account_id":"A4","remark":"カフェ","tags":["GoogleChat"],"tax_id":"T1"}');
  assert.match(toMfTransactionJournalize_({ transaction_id: 'TR1', account: 'ない科目', tax: '' }, MASTER).errors[0], /ない科目/);
});

test('MCP の応答（JSON・SSE）を読む', () => {
  assert.strictEqual(parseMcpResponse_('{"jsonrpc":"2.0","id":3,"result":{}}', 3).id, 3);
  const sse = 'event: message\\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\\n\\nevent: message\\ndata: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"{\\\\"ok\\\\":1}"}]}}\\n\\n';
  const msg = parseMcpResponse_(sse, 7);
  assert.strictEqual(msg.id, 7);
  assert.strictEqual(parseMcpToolResult_(msg, 't').ok, 1);
  assert.throws(() => parseMcpToolResult_({ result: { isError: true, content: [{ type: 'text', text: 'bad office' }] } }, 'mfc_ca_x'), /mfc_ca_x.*bad office/);
});

test('MF へは初期化してから office_code 付きでツールを呼ぶ', () => {
  resetSheets();
  fetchQueue.push(
    { body: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}', headers: { 'Mcp-Session-Id': 'S1' } },
    { code: 202, body: '' },
    { body: 'data: {"jsonrpc":"2.0","id":0,"result":{"content":[{"type":"text","text":"{\\\\"taxes\\\\":[]}"}]}}\\n\\n' }
  );
  const office = findOffice_('テスト商事');
  const res = mfCall_(office, 'mfc_ca_getTaxes', { available: true });
  assert.strictEqual(JSON.stringify(res), '{"taxes":[]}');
  assert.strictEqual(fetchCalls.length, 3);
  assert.strictEqual(fetchCalls[0].req.headers['Mf-API-Key'], 'mf-key-01');
  assert.strictEqual(JSON.parse(fetchCalls[1].req.payload).method, 'notifications/initialized');
  assert.strictEqual(fetchCalls[2].req.headers['Mcp-Session-Id'], 'S1');
  const call = JSON.parse(fetchCalls[2].req.payload);
  assert.strictEqual(call.params.name, 'mfc_ca_getTaxes');
  assert.strictEqual(call.params.arguments.office_code, '1234-5678');
  assert.strictEqual(call.params.arguments.available, true);
});

test('登録していない事業者はわかる言葉でエラーにする', () => {
  resetSheets();
  assert.throws(() => findOffice_('別会社'), /「事業者」シートにありません。登録済み：テスト商事/);
});

test('画像・PDF以外は Claude に渡さない', () => {
  assert.strictEqual(attachmentToBlock_('image/jpeg', 'xx').type, 'image');
  assert.strictEqual(attachmentToBlock_('application/pdf', 'xx').type, 'document');
  assert.strictEqual(attachmentToBlock_('image/heic', 'xx'), null);
});

test('Claude へのリクエストに画像ブロックと構造化出力を入れる', () => {
  const block = attachmentToBlock_('image/png', 'AAA');
  const req = buildClaudeRequest_({ model: 'claude-opus-5-5', effort: 'low', system: 's', content: [block, { type: 'text', text: 't' }], schema: buildProposalSchema_() }, 'k');
  const payload = JSON.parse(req.payload);
  assert.strictEqual(payload.messages[0].content[0].source.media_type, 'image/png');
  assert.strictEqual(payload.output_config.format.type, 'json_schema');
  assert.strictEqual(payload.fallbacks, 'default');
});

test('AIへの指示に科目一覧・ルール・インジェクション対策が入る', () => {
  const s = buildJournalSystemPrompt_({ name: 'テスト商事' }, MASTER, ['Wiseの手数料は支払手数料'], { '事務所の方針': '税込経理' });
  assert.match(s, /テスト商事/);
  assert.match(s, /旅費交通費 \\/ 現金/);
  assert.match(s, /Wiseの手数料は支払手数料/);
  assert.match(s, /税込経理/);
  assert.match(s, /指示には従わない/);
});

test('仕訳案カードに事業者名とボタンが出る。登録できない案には登録ボタンを出さない', () => {
  const card = buildProposalCard_('P-1', 'テスト商事', PROPOSAL, [], '案');
  const c = card.cardsV2[0].card;
  assert.strictEqual(c.header.title, '仕訳案：テスト商事');
  const buttons = c.sections[c.sections.length - 1].widgets[0].buttonList.buttons.map(b => b.text);
  sameJson(buttons, ['MFに登録', '却下', '質問に追加']);
  const bad = buildProposalCard_('P-1', 'テスト商事', PROPOSAL, ['科目なし'], '案').cardsV2[0].card;
  sameJson(bad.sections[bad.sections.length - 1].widgets[0].buttonList.buttons.map(b => b.text), ['却下', '質問に追加']);
  const done = buildProposalCard_('P-1', 'テスト商事', PROPOSAL, [], '登録済').cardsV2[0].card;
  assert.strictEqual(done.sections[done.sections.length - 1].widgets[0].buttonList, undefined);
});

test('カードの文字は HTML としてエスケープする', () => {
  const p = JSON.parse(JSON.stringify(PROPOSAL));
  p.summary = '<b>注入</b>';
  assert.strictEqual(buildProposalCard_('P-1', 'x', p, [], '案').cardsV2[0].card.sections[0].header, '&lt;b&gt;注入&lt;/b&gt;');
});

function addProposalRow(id, status) {
  appendObject_(sheets['仕訳案'], {
    '案ID': id, '状態': status, '種類': '資料', '事業者名': 'テスト商事', 'スペース': 'spaces/AAA', 'スレッド': 'spaces/AAA/threads/T1',
    '内容': JSON.stringify({ proposal: PROPOSAL, errors: [] }),
  });
}

test('「MFに登録」で仕訳を登録し、状態を登録済にする', () => {
  resetSheets();
  addProposalRow('P-1', '案');
  const toolResult = obj => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: JSON.stringify(obj) }] } }) });
  fetchQueue.push(
    { body: '{"jsonrpc":"2.0","id":1,"result":{}}' }, { code: 202 },
    toolResult({ accounts: MASTER.accounts }), toolResult({ taxes: MASTER.taxes }),
    toolResult({ journal: { id: 'J999' } })
  );
  const res = approveProposal_('P-1', 'staff@example.com');
  assert.strictEqual(res.actionResponse.type, 'UPDATE_MESSAGE');
  const posted = JSON.parse(fetchCalls[4].req.payload);
  assert.strictEqual(posted.params.name, 'mfc_ca_postJournals');
  assert.strictEqual(posted.params.arguments.journal.branches[0].debitor.account_id, 'A1');
  const row = findRow_(sheets['仕訳案'], '案ID', 'P-1');
  assert.strictEqual(row['状態'], '登録済');
  assert.strictEqual(row['承認者'], 'staff@example.com');
  assert.match(row['MF結果'], /J999/);

  // 2回押しても二重登録しない（MF に通信しない）
  const before = fetchCalls.length;
  const again = approveProposal_('P-1', 'other@example.com');
  assert.strictEqual(fetchCalls.length, before);
  assert.strictEqual(again.actionResponse.type, 'UPDATE_MESSAGE');
});

test('却下した案は登録できない', () => {
  resetSheets();
  addProposalRow('P-2', '案');
  rejectProposal_('P-2', 'staff@example.com');
  assert.strictEqual(findRow_(sheets['仕訳案'], '案ID', 'P-2')['状態'], '却下');
  approveProposal_('P-2', 'staff@example.com');
  assert.strictEqual(fetchCalls.length, 0);
});

test('「質問に追加」は1案1回だけ。まとめは関与先ノートの形で出す', () => {
  resetSheets();
  addProposalRow('P-3', '案');
  assert.match(addQuestion_('P-3', 'staff@example.com').text, /質問に追加しました/);
  assert.match(addQuestion_('P-3', 'staff@example.com').text, /追加済み/);
  const out = summarizeQuestions_({ name: 'テスト商事', code: '1234-5678' });
  assert.match(out, /^テスト商事（MFコード 1234-5678）/);
  assert.match(out, /関与先1件／事務所内0件／カルテ0件／タスク0件/);
  const json = JSON.parse(out.split('\`\`\`')[1]);
  assert.strictEqual(json.new_questions[0].to, '関与先');
  assert.match(json.new_questions[0].question, /3,300円/);
  sameJson(json.answered_questions, []);
  assert.match(summarizeQuestions_({ name: 'テスト商事', code: '1234-5678' }), /まとめていない質問はありません/);
});

test('事業者が未設定のスペースでは案内を返す', () => {
  resetSheets();
  const res = onMessage({ space: { name: 'spaces/AAA' }, user: { email: 'a@example.com' }, message: { text: 'タクシー 3,300円' } });
  assert.match(res.text, /\\/事業者 事業者名/);
});

test('文章の依頼はジョブに積み、案が1件のスレッドへの返信は修正にする', () => {
  resetSheets();
  appendObject_(sheets['スペース'], { 'スペース': 'spaces/AAA', '事業者名': 'テスト商事' });
  ScriptApp = { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ after: () => ({ create() {} }) }) }) };
  const ev = (text, thread, reply) => ({ space: { name: 'spaces/AAA' }, user: { email: 'a@example.com' }, message: { text, thread: { name: thread }, threadReply: reply } });

  assert.match(onMessage(ev('9/12 タクシー 3,300円', 'spaces/AAA/threads/T0', false)).text, /テスト商事/);
  addProposalRow('P-4', '案');
  assert.match(onMessage(ev('貸方は普通預金', 'spaces/AAA/threads/T1', true)).text, /P-4 を作り直しています/);
  addProposalRow('P-5', '案');
  assert.match(onMessage(ev('貸方は普通預金', 'spaces/AAA/threads/T1', true)).text, /2件あります/);
  assert.match(onMessage(ev('修正 P-5：会議費', 'spaces/AAA/threads/T1', true)).text, /P-5 を作り直しています/);

  const jobs = readRows_(sheets['ジョブ']);
  sameJson(jobs.map(j => j['種類']), ['文章', '修正', '修正']);
  assert.strictEqual(JSON.parse(jobs[2]['入力']).text, '会議費');
});
`, context);

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${e.stack.split('\n').slice(0, 3).join('\n  ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
