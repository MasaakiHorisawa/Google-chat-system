/**
 * ジョブ（AIの読み取り・仕訳案の作成）の処理
 *
 * Chat の応答期限（30秒）に間に合わない処理を「ジョブ」シートに積み、
 * 数秒後に動くトリガーと、取りこぼし用の1分ごとのトリガーで処理します。
 * 結果は Chat API で元のスレッドに返信します。
 */

/** ジョブを積み、すぐに処理が始まるよう1回きりのトリガーを入れる */
function enqueueJob_(type, space, thread, user, input) {
  const id = newId_('J');
  appendObject_(getSheet_(APP.SHEETS.JOBS), {
    'ジョブID': id, '状態': '待ち', '種類': type, 'スペース': space, 'スレッド': thread,
    '依頼者': user, '入力': JSON.stringify(input), '作成日時': new Date(),
  });
  try {
    const pending = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'runJobsSoon');
    if (!pending.length) ScriptApp.newTrigger('runJobsSoon').timeBased().after(1000).create();
  } catch (e) {
    console.warn(`トリガーを作れませんでした（1分ごとの処理で拾います）：${e.message}`);
  }
  return id;
}

/** 1回きりのトリガーから呼ばれる。自分のトリガーを消してから処理する */
function runJobsSoon() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runJobsSoon')
    .forEach(t => ScriptApp.deleteTrigger(t));
  runJobs();
}

/** 待ちのジョブを処理する（1分ごとのトリガーからも呼ばれる） */
function runJobs() {
  const started = Date.now();
  for (let i = 0; i < APP.MAX_JOBS_PER_RUN; i++) {
    if (Date.now() - started > 4 * 60 * 1000) break; // 6分制限の手前で止める（残りは次の回）
    const job = claimJob_();
    if (!job) break;
    const sheet = getSheet_(APP.SHEETS.JOBS);
    try {
      const result = processJob_(job);
      updateCells_(sheet, job._row, { '状態': '完了', '結果': result || '', '更新日時': new Date() });
    } catch (err) {
      console.error(err.stack || err);
      updateCells_(sheet, job._row, { '状態': 'エラー', '結果': err.message, '更新日時': new Date() });
      try {
        postChatMessage_(job['スペース'], { text: `処理できませんでした：${err.message}` }, job['スレッド']);
      } catch (e2) {
        console.error(`エラーの通知にも失敗しました：${e2.message}`);
      }
    }
  }
}

/** 待ちのジョブを1件取り出して「処理中」にする（同時に動いた処理と取り合わないようロックする） */
function claimJob_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return null;
  try {
    const sheet = getSheet_(APP.SHEETS.JOBS);
    const job = readRows_(sheet).find(r => r['状態'] === '待ち');
    if (!job) return null;
    updateCells_(sheet, job._row, { '状態': '処理中', '更新日時': new Date() });
    return job;
  } finally {
    lock.releaseLock();
  }
}

function processJob_(job) {
  const input = JSON.parse(job['入力']);
  const ctx = { space: job['スペース'], thread: job['スレッド'], user: job['依頼者'] };
  switch (job['種類']) {
    case '資料': return processDocumentsJob_(input, ctx);
    case '文章': return processTextJob_(input, ctx);
    case '修正': return processReviseJob_(input, ctx);
    case '明細': return processTransactionsJob_(input, ctx);
    default: throw new Error(`不明なジョブの種類です：${job['種類']}`);
  }
}

/** AIに渡す共通の材料（事業者・科目一覧・ルール・設定） */
function journalContext_(officeName) {
  const office = findOffice_(officeName);
  const master = getMaster_(office);
  const rules = readRows_(getSheet_(APP.SHEETS.RULES))
    .filter(r => r['ルール'] && (!r['事業者名'] || r['事業者名'] === office.name))
    .map(r => String(r['ルール']));
  const settings = readSettings_();
  return { office: office, master: master, settings: settings, system: buildJournalSystemPrompt_(office, master, rules, settings) };
}

function askProposal_(jc, content) {
  return callClaudeJson_({
    model: jc.settings['モデル'],
    effort: jc.settings['effort'],
    system: jc.system,
    content: content,
    schema: buildProposalSchema_(),
  });
}

/** 領収書・請求書（画像・PDF）：1ファイルごとに仕訳案を出す */
function processDocumentsJob_(input, ctx) {
  const jc = journalContext_(input.office);
  const done = [];
  input.attachments.forEach(att => {
    const label = att.name || 'ファイル';
    const blob = downloadChatAttachment_(att.resourceName);
    const bytes = blob.getBytes();
    const contentType = att.contentType || blob.getContentType();
    const block = attachmentToBlock_(contentType, Utilities.base64Encode(bytes));
    if (!block) {
      postChatMessage_(ctx.space, { text: `${label}：この形式（${contentType}）は読み取れません。JPEG・PNG・PDF で送ってください。` }, ctx.thread);
      return;
    }
    if (bytes.length > APP.MAX_IMAGE_BYTES) {
      postChatMessage_(ctx.space, { text: `${label}：ファイルが大きすぎます（5MBまで）。写真を小さくして送ってください。` }, ctx.thread);
      return;
    }
    const prompt = [
      `今日の日付：${todayString_()}`,
      'この資料（領収書・請求書など）から仕訳案を作ってください。',
      input.text ? `職員からの補足：${input.text}` : '',
    ].filter(String).join('\n');
    const proposal = askProposal_(jc, [block, { type: 'text', text: prompt }]);
    done.push(postProposal_(jc, proposal, '資料', ctx, label));
  });
  return done.join(', ');
}

/** 文章での依頼 */
function processTextJob_(input, ctx) {
  const jc = journalContext_(input.office);
  const proposal = askProposal_(jc, buildTextRequestPrompt_(input.text, todayString_(), null));
  return postProposal_(jc, proposal, '文章', ctx, '');
}

/** 仕訳案のスレッドでの修正依頼：作り直して、前の案は「差し替え」にする */
function processReviseJob_(input, ctx) {
  const sheet = getSheet_(APP.SHEETS.PROPOSALS);
  const prev = findRow_(sheet, '案ID', input.proposalId);
  if (!prev) throw new Error(`仕訳案 ${input.proposalId} が見つかりません。`);
  if (prev['状態'] !== '案') throw new Error(`仕訳案 ${input.proposalId} はすでに「${prev['状態']}」です。新しく依頼してください。`);
  const jc = journalContext_(prev['事業者名']);
  const prevContent = JSON.parse(prev['内容']);

  let newId;
  if (prev['種類'] === '明細') {
    const res = callClaudeJson_({
      model: jc.settings['モデル'],
      effort: jc.settings['effort'],
      system: jc.system,
      content: `${buildTransactionsPrompt_([prevContent.raw || prevContent.transaction])}\n\n前回の案：${JSON.stringify(prevContent.item)}\n職員からの修正の指示（これに従って作り直す）：${input.text}`,
      schema: buildTransactionsSchema_(),
    });
    const item = (res.items || [])[0];
    if (!item) throw new Error('作り直した案を受け取れませんでした。もう一度送ってください。');
    item.transaction_id = prevContent.item.transaction_id;
    newId = postTransactionProposal_(jc, prevContent.transaction, prevContent.raw, item, ctx);
  } else {
    const proposal = askProposal_(jc, buildTextRequestPrompt_(input.text, todayString_(), prevContent.proposal));
    newId = postProposal_(jc, proposal, prev['種類'], ctx, '');
  }

  updateCells_(sheet, prev._row, { '状態': '差し替え', '更新日時': new Date() });
  if (prev['メッセージ']) {
    try {
      updateChatMessage_(prev['メッセージ'], Object.assign({ text: '' }, rebuildCard_(prev, `差し替え（→ ${newId}）`)));
    } catch (e) {
      console.warn(`前の案のカードを更新できませんでした：${e.message}`);
    }
  }
  return newId;
}

/** 未仕訳明細：まとめて AI に渡し、1明細1枚のカードを出す */
function processTransactionsJob_(input, ctx) {
  const jc = journalContext_(input.office);
  const limit = Number(jc.settings['未仕訳の取得件数']) || 20;
  const transactions = getUnjournalized_(jc.office, input.start, input.end, limit);
  if (!transactions.length) {
    postChatMessage_(ctx.space, { text: `「${jc.office.name}」の ${input.start}〜${input.end} に未仕訳の明細はありません。` }, ctx.thread);
    return '0件';
  }
  const res = callClaudeJson_({
    model: jc.settings['モデル'],
    effort: jc.settings['effort'],
    system: jc.system,
    content: buildTransactionsPrompt_(transactions),
    schema: buildTransactionsSchema_(),
  });
  const byId = {};
  (res.items || []).forEach(item => { byId[String(item.transaction_id)] = item; });

  postChatMessage_(ctx.space, { text: `「${jc.office.name}」の未仕訳明細 ${transactions.length}件に仕訳案を付けました。` }, ctx.thread);
  const ids = [];
  transactions.forEach(raw => {
    const tr = summarizeTransaction_(raw);
    const item = byId[tr.id];
    if (!item) {
      postChatMessage_(ctx.space, { text: `明細 ${tr.date} ${tr.content} ${formatYen_(tr.amount)}：仕訳案を作れませんでした。` }, ctx.thread);
      return;
    }
    item.transaction_id = tr.id; // AIが書き換えていても明細のIDを使う
    ids.push(postTransactionProposal_(jc, tr, raw, item, ctx));
  });
  return ids.join(', ');
}

/** 仕訳案を保存してカードを投稿する */
function postProposal_(jc, proposal, type, ctx, label) {
  if (!proposal.is_journal) {
    postChatMessage_(ctx.space, { text: `${label ? label + '：' : ''}仕訳にできる内容ではないようです（${proposal.summary}）` }, ctx.thread);
    return '';
  }
  const id = newId_('P');
  const checked = toMfJournal_(proposal, jc.master);
  const content = { proposal: proposal, errors: checked.errors };
  return saveAndPost_(id, type, jc.office.name, content, ctx, buildProposalCard_(id, jc.office.name, proposal, checked.errors, '案'));
}

function postTransactionProposal_(jc, tr, raw, item, ctx) {
  const id = newId_('P');
  const checked = toMfTransactionJournalize_(item, jc.master);
  const content = { transaction: tr, raw: raw, item: item, errors: checked.errors };
  return saveAndPost_(id, '明細', jc.office.name, content, ctx, buildTransactionCard_(id, jc.office.name, tr, item, checked.errors, '案'));
}

function saveAndPost_(id, type, officeName, content, ctx, card) {
  const sheet = getSheet_(APP.SHEETS.PROPOSALS);
  appendObject_(sheet, {
    '案ID': id, '状態': '案', '種類': type, '事業者名': officeName, 'スペース': ctx.space, 'スレッド': ctx.thread,
    '内容': JSON.stringify(content), '依頼者': ctx.user, '作成日時': new Date(), '更新日時': new Date(),
  });
  const posted = postChatMessage_(ctx.space, card, ctx.thread);
  const row = findRow_(sheet, '案ID', id);
  if (row) updateCells_(sheet, row._row, { 'メッセージ': posted.name || '', 'スレッド': (posted.thread && posted.thread.name) || ctx.thread });
  return id;
}
