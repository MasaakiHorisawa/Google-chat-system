/**
 * Google Chat からの呼び出し口
 *
 * onMessage     ：メッセージを受け取る（コマンドはその場で返し、AIの処理はジョブにして後で返信する）
 * onCardClick   ：カードのボタン（MFに登録 / 却下 / 質問に追加）
 * onAddedToSpace：スペースに追加されたとき
 *
 * Chat の応答期限は30秒なので、ここでは時間のかかる処理をしない。
 */

function onAddedToSpace(e) {
  return { text: `追加ありがとうございます。\n${HELP_TEXT}` };
}

function onRemovedFromSpace(e) {
  console.log(`スペースから削除されました：${e.space && e.space.name}`);
}

function onMessage(e) {
  try {
    return handleMessage_(e);
  } catch (err) {
    console.error(err.stack || err);
    return { text: `エラー：${err.message}` };
  }
}

function handleMessage_(e) {
  const message = e.message || {};
  const space = e.space.name;
  const thread = message.thread ? message.thread.name : '';
  const user = (e.user && e.user.email) || '';
  const text = String(message.argumentText !== undefined ? message.argumentText : message.text || '').trim();
  const command = parseCommand_(text);

  if (command) {
    switch (command.cmd) {
      case 'ヘルプ': case 'help': case '使い方':
        return { text: HELP_TEXT };
      case '事業者':
        return command.arg ? bindOffice_(e.space, command.arg, user) : { text: describeOffice_(space) };
      case 'ルール': {
        const office = officeForSpace_(space);
        if (!command.arg) return { text: 'ルールの内容を書いてください。例：`/ルール Wiseの送金手数料は支払手数料・対象外`' };
        appendObject_(getSheet_(APP.SHEETS.RULES), { '事業者名': office.name, 'ルール': command.arg, '登録者': user, '登録日時': new Date() });
        return { text: `「${office.name}」の仕訳ルールに追加しました：${command.arg}` };
      }
      case '質問まとめ':
        return { text: summarizeQuestions_(officeForSpace_(space)) };
      case '未仕訳': {
        const office = officeForSpace_(space);
        const period = parsePeriod_(command.arg, todayString_());
        if (!period) return { text: '期間の書き方が分かりません。例：`/未仕訳 2025-09` または `/未仕訳 2025-09-01 2025-09-15`' };
        enqueueJob_('明細', space, thread, user, { office: office.name, start: period.start, end: period.end });
        return { text: `「${office.name}」の未仕訳明細（${period.start}〜${period.end}）を確認しています。少しお待ちください。` };
      }
      default:
        return { text: `「/${command.cmd}」というコマンドはありません。\n${HELP_TEXT}` };
    }
  }

  const office = officeForSpace_(space);
  const attachments = (message.attachment || []).filter(a => a.attachmentDataRef && a.attachmentDataRef.resourceName);
  const driveOnly = (message.attachment || []).length > attachments.length;

  if (attachments.length) {
    enqueueJob_('資料', space, thread, user, {
      office: office.name,
      text: text,
      attachments: attachments.map(a => ({ resourceName: a.attachmentDataRef.resourceName, contentType: a.contentType, name: a.contentName || '' })),
    });
    return { text: `「${office.name}」の資料${attachments.length}件を読み取っています。少しお待ちください。` };
  }
  if (driveOnly) return { text: 'Google ドライブのファイルは読み取れません。画像かPDFを直接アップロードしてください。' };
  if (!text) return { text: HELP_TEXT };

  // 仕訳案のスレッドへの返信は、その仕訳案の修正として扱う
  const revise = parseRevision_(text);
  const open = thread ? findOpenProposalsInThread_(thread) : [];
  if (revise.id || (open.length && (message.threadReply || revise.explicit))) {
    let target = revise.id;
    if (!target) {
      if (open.length > 1) {
        return { text: `このスレッドには仕訳案が${open.length}件あります。「修正 P-…（案ID）：内容」の形で、どの案かを指定してください。` };
      }
      target = open[0]['案ID'];
    }
    enqueueJob_('修正', space, thread, user, { proposalId: target, text: revise.text });
    return { text: `仕訳案 ${target} を作り直しています。` };
  }

  enqueueJob_('文章', space, thread, user, { office: office.name, text: text });
  return { text: `「${office.name}」の仕訳案を作っています。少しお待ちください。` };
}

/** 「/コマンド 引数」を読み取る。コマンドでなければ null */
function parseCommand_(text) {
  const m = String(text || '').trim().match(/^[\/／]\s*(\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  return { cmd: m[1], arg: m[2].trim() };
}

/** 「2025-09」「2025-09-01 2025-09-15」、空なら直近30日 */
function parsePeriod_(arg, today) {
  const s = String(arg || '').normalize('NFKC').trim().replace(/\//g, '-');
  if (!s) {
    const end = new Date(`${today}T00:00:00Z`);
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { start: start.toISOString().slice(0, 10), end: today };
  }
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const mm = String(mo).padStart(2, '0');
    return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${last}` };
  }
  m = s.match(/^(\d{4}-\d{2}-\d{2})\s*(?:〜|~|\s)\s*(\d{4}-\d{2}-\d{2})$/);
  if (m && m[1] <= m[2]) return { start: m[1], end: m[2] };
  return null;
}

function todayString_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

/** スペースに事業者を結びつける。MF に問い合わせて、APIキーが本当にその事業者のものか確かめる */
function bindOffice_(space, name, user) {
  const office = findOffice_(name);
  const info = mfCall_(office, 'mfc_ca_currentOffice', {});
  const mfName = (info && (info.name || (info.office && info.office.name))) || '';

  const sheet = getSheet_(APP.SHEETS.SPACES);
  const row = findRow_(sheet, 'スペース', space.name);
  const values = { 'スペース': space.name, 'スペース名': space.displayName || '', '事業者名': office.name, '設定者': user, '設定日時': new Date() };
  if (row) updateCells_(sheet, row._row, values); else appendObject_(sheet, values);
  return { text: `このスペースは「${office.name}」（MFコード ${office.code}）の仕訳を扱います。${mfName ? `\nMF 上の事業者名：${mfName}` : ''}` };
}

function describeOffice_(spaceName) {
  const row = findRow_(getSheet_(APP.SHEETS.SPACES), 'スペース', spaceName);
  const names = readRows_(getSheet_(APP.SHEETS.OFFICES)).map(r => r['事業者名']).filter(String);
  const current = row && row['事業者名'] ? `このスペースの事業者：${row['事業者名']}` : 'このスペースの事業者はまだ決まっていません。';
  return `${current}\n登録済みの事業者：${names.join('、') || '（なし）'}\n変えるときは \`/事業者 事業者名\``;
}

/** このスペースで扱う事業者。未設定ならエラーで案内する */
function officeForSpace_(spaceName) {
  const row = findRow_(getSheet_(APP.SHEETS.SPACES), 'スペース', spaceName);
  if (!row || !row['事業者名']) throw new Error('このスペースの事業者が決まっていません。最初に `/事業者 事業者名` を送ってください。');
  return findOffice_(row['事業者名']);
}

function findOpenProposalsInThread_(thread) {
  return readRows_(getSheet_(APP.SHEETS.PROPOSALS)).filter(r => r['スレッド'] === thread && r['状態'] === '案');
}

/** 「修正：内容」「修正 P-…：内容」を読み取る */
function parseRevision_(text) {
  const s = String(text || '').trim();
  const m = s.match(/^修正\s*(?:(P-[\d-]+)\s*[：:]?|[：:])\s*([\s\S]*)$/);
  if (!m) return { explicit: false, id: '', text: s };
  return { explicit: true, id: m[1] || '', text: m[2].trim() };
}

function summarizeQuestions_(office) {
  const sheet = getSheet_(APP.SHEETS.QUESTIONS);
  const rows = readRows_(sheet).filter(r => r['事業者名'] === office.name && r['状態'] === '未まとめ');
  if (!rows.length) return `「${office.name}」のまとめていない質問はありません。仕訳案のカードの「質問に追加」で追加できます。`;
  rows.forEach(r => updateCells_(sheet, r._row, { '状態': 'まとめ済' }));
  return buildQuestionSummary_(office, rows);
}

// ---- カードのボタン ---------------------------------------------------------

function onCardClick(e) {
  const fn = (e.common && e.common.invokedFunction) || (e.action && e.action.actionMethodName);
  const params = cardParams_(e);
  const user = (e.user && e.user.email) || '';
  try {
    if (fn === 'onApprove') return approveProposal_(params.id, user);
    if (fn === 'onReject') return rejectProposal_(params.id, user);
    if (fn === 'onAddQuestion') return addQuestion_(params.id, user);
    return newMessage_(`不明な操作です：${fn}`);
  } catch (err) {
    console.error(err.stack || err);
    return newMessage_(`エラー：${err.message}`);
  }
}

function cardParams_(e) {
  if (e.common && e.common.parameters) return e.common.parameters;
  const params = {};
  ((e.action && e.action.parameters) || []).forEach(p => { params[p.key] = p.value; });
  return params;
}

function newMessage_(text) {
  return { actionResponse: { type: 'NEW_MESSAGE' }, text: text };
}

function updateCard_(card) {
  return Object.assign({ actionResponse: { type: 'UPDATE_MESSAGE' } }, card);
}

/** 「MFに登録」：二重登録を防ぐためロックの中で状態を確かめてから登録する */
function approveProposal_(id, user) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return newMessage_('ほかの登録を処理中です。少し待ってからもう一度押してください。');
  try {
    const sheet = getSheet_(APP.SHEETS.PROPOSALS);
    const row = findRow_(sheet, '案ID', id);
    if (!row) return newMessage_(`仕訳案 ${id} が見つかりません。`);
    if (row['状態'] !== '案') return updateCard_(rebuildCard_(row, row['状態']));

    const office = findOffice_(row['事業者名']);
    const master = getMaster_(office);
    const content = JSON.parse(row['内容']);
    let result;
    if (row['種類'] === '明細') {
      const converted = toMfTransactionJournalize_(content.item, master);
      if (converted.errors.length) return newMessage_(`登録できません：${converted.errors.join('、')}`);
      result = mfCall_(office, 'mfc_ca_postTransactionJournalize', converted.args);
    } else {
      const converted = toMfJournal_(content.proposal, master);
      if (converted.errors.length) return newMessage_(`登録できません：${converted.errors.join('、')}`);
      result = mfCall_(office, 'mfc_ca_postJournals', { journal: converted.journal });
    }
    const status = `登録済（${office.name}／${user}）`;
    updateCells_(sheet, row._row, {
      '状態': '登録済',
      '承認者': user,
      'MF結果': JSON.stringify(result).slice(0, 2000),
      '更新日時': new Date(),
    });
    return updateCard_(rebuildCard_(row, status));
  } finally {
    lock.releaseLock();
  }
}

function rejectProposal_(id, user) {
  const sheet = getSheet_(APP.SHEETS.PROPOSALS);
  const row = findRow_(sheet, '案ID', id);
  if (!row) return newMessage_(`仕訳案 ${id} が見つかりません。`);
  if (row['状態'] !== '案') return updateCard_(rebuildCard_(row, row['状態']));
  updateCells_(sheet, row._row, { '状態': '却下', '承認者': user, '更新日時': new Date() });
  return updateCard_(rebuildCard_(row, `却下（${user}）`));
}

function addQuestion_(id, user) {
  const row = findRow_(getSheet_(APP.SHEETS.PROPOSALS), '案ID', id);
  if (!row) return newMessage_(`仕訳案 ${id} が見つかりません。`);
  const qSheet = getSheet_(APP.SHEETS.QUESTIONS);
  const dup = readRows_(qSheet).find(r => r['案ID'] === id);
  if (dup) return newMessage_(`この質問は追加済みです（${dup['質問ID']}）。`);
  const content = JSON.parse(row['内容']);
  const q = (content.proposal || content.item).client_question;
  const qid = newId_('Q');
  appendObject_(qSheet, {
    '質問ID': qid, '事業者名': row['事業者名'], '宛先': '関与先', '質問': q.question, '理由': q.reason,
    '状態': '未まとめ', '案ID': id, '登録者': user, '作成日時': new Date(),
  });
  return newMessage_(`質問に追加しました（${qid}）。\`/質問まとめ\` で関与先ノート用にまとめます。`);
}

// カードのボタンが関数名で直接呼ばれる場合にも、onCardClick で処理する
function onApprove(e) { return onCardClick(e); }
function onReject(e) { return onCardClick(e); }
function onAddQuestion(e) { return onCardClick(e); }
