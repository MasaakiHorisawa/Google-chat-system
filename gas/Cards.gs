/**
 * Google Chat に出すカード
 *
 * 仕訳案を表で見せ、「MFに登録」「却下」「質問に追加」のボタンを付けます。
 * 書き込む先の事業者名を必ずカードの見出しに出します。
 */

const CONFIDENCE_LABELS = { high: '確度：高', medium: '確度：中', low: '確度：低（要確認）' };

function escapeHtml_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function button_(text, fn, params, opts) {
  const b = {
    text: text,
    onClick: { action: { function: fn, parameters: Object.keys(params).map(k => ({ key: k, value: String(params[k]) })) } },
  };
  if (opts && opts.filled) b.color = { red: 0.1, green: 0.45, blue: 0.9, alpha: 1 };
  return b;
}

/** 仕訳案（領収書・文章から）のカード */
function buildProposalCard_(proposalId, officeName, proposal, errors, status) {
  const lines = (proposal.branches || []).map(b => {
    const debit = b.debit_account ? `${escapeHtml_(b.debit_account)}（${escapeHtml_(b.debit_tax || '-')}）${formatYen_(b.debit_amount)}` : '-';
    const credit = b.credit_account ? `${escapeHtml_(b.credit_account)}（${escapeHtml_(b.credit_tax || '-')}）${formatYen_(b.credit_amount)}` : '-';
    return `<b>借方</b> ${debit}<br><b>貸方</b> ${credit}<br><font color="#5f6368">摘要：${escapeHtml_(b.remark)}</font>`;
  });
  const widgets = [
    { textParagraph: { text: `<b>取引日</b> ${escapeHtml_(proposal.transaction_date || '（不明）')}　${CONFIDENCE_LABELS[proposal.confidence] || ''}` } },
    { textParagraph: { text: lines.join('<br><br>') || '（仕訳の行がありません）' } },
  ];
  if (proposal.notes) widgets.push({ textParagraph: { text: `<font color="#5f6368">メモ：${escapeHtml_(proposal.notes)}</font>` } });
  if (errors && errors.length) {
    widgets.push({ textParagraph: { text: `<font color="#d93025">このままでは登録できません：<br>${errors.map(escapeHtml_).join('<br>')}<br>スレッドに「修正：〜」と返信すると作り直します。</font>` } });
  }
  const sections = [{ header: escapeHtml_(proposal.summary || ''), widgets: widgets }];

  const q = proposal.client_question;
  if (q && q.needed) {
    sections.push({
      header: '関与先への質問案',
      widgets: [{ textParagraph: { text: `${escapeHtml_(q.question)}<br><font color="#5f6368">理由（事務所内）：${escapeHtml_(q.reason)}</font>` } }],
    });
  }

  if (status === '案') {
    const buttons = [];
    if (!errors || !errors.length) buttons.push(button_('MFに登録', 'onApprove', { id: proposalId }, { filled: true }));
    buttons.push(button_('却下', 'onReject', { id: proposalId }));
    if (q && q.needed) buttons.push(button_('質問に追加', 'onAddQuestion', { id: proposalId }));
    sections.push({ widgets: [{ buttonList: { buttons: buttons } }] });
  } else {
    sections.push({ widgets: [{ textParagraph: { text: `<b>${escapeHtml_(status)}</b>` } }] });
  }

  return {
    cardsV2: [{
      cardId: proposalId,
      card: { header: { title: `仕訳案：${officeName}`, subtitle: proposalId }, sections: sections },
    }],
  };
}

/** 未仕訳明細の仕訳案のカード（1明細1枚） */
function buildTransactionCard_(proposalId, officeName, tr, item, errors, status) {
  const widgets = [
    { textParagraph: { text: `<b>明細</b> ${escapeHtml_(tr.date)}　${escapeHtml_(tr.account)}${tr.sub_account ? ' ' + escapeHtml_(tr.sub_account) : ''}<br>${escapeHtml_(tr.content)}　<b>${formatYen_(tr.amount)}</b>${tr.side ? `（${escapeHtml_(tr.side)}）` : ''}` } },
    { textParagraph: { text: `<b>相手科目</b> ${escapeHtml_(item.account)}（${escapeHtml_(item.tax || '-')}）<br><font color="#5f6368">摘要：${escapeHtml_(item.remark)}</font><br>${CONFIDENCE_LABELS[item.confidence] || ''}` } },
  ];
  if (item.notes) widgets.push({ textParagraph: { text: `<font color="#5f6368">メモ：${escapeHtml_(item.notes)}</font>` } });
  if (errors && errors.length) widgets.push({ textParagraph: { text: `<font color="#d93025">${errors.map(escapeHtml_).join('<br>')}</font>` } });
  const sections = [{ widgets: widgets }];

  const q = item.client_question;
  if (q && q.needed) {
    sections.push({
      header: '関与先への質問案',
      widgets: [{ textParagraph: { text: `${escapeHtml_(q.question)}<br><font color="#5f6368">理由（事務所内）：${escapeHtml_(q.reason)}</font>` } }],
    });
  }
  if (status === '案') {
    const buttons = [];
    if (!errors || !errors.length) buttons.push(button_('MFに登録', 'onApprove', { id: proposalId }, { filled: true }));
    buttons.push(button_('却下', 'onReject', { id: proposalId }));
    if (q && q.needed) buttons.push(button_('質問に追加', 'onAddQuestion', { id: proposalId }));
    sections.push({ widgets: [{ buttonList: { buttons: buttons } }] });
  } else {
    sections.push({ widgets: [{ textParagraph: { text: `<b>${escapeHtml_(status)}</b>` } }] });
  }
  return {
    cardsV2: [{
      cardId: proposalId,
      card: { header: { title: `未仕訳明細：${officeName}`, subtitle: proposalId }, sections: sections },
    }],
  };
}

/** 保存しておいた仕訳案から、状態に合わせてカードを作り直す */
function rebuildCard_(row, status) {
  const content = JSON.parse(row['内容']);
  if (row['種類'] === '明細') {
    return buildTransactionCard_(row['案ID'], row['事業者名'], content.transaction, content.item, content.errors, status);
  }
  return buildProposalCard_(row['案ID'], row['事業者名'], content.proposal, content.errors, status);
}

const HELP_TEXT = [
  '*仕訳アシスタントの使い方*',
  '• `/事業者 事業者名`：このスペースで扱う事業者を決める（最初に1回）',
  '• 領収書・請求書の画像やPDFを送る：読み取って仕訳案を出します',
  '• 文章で依頼：例「9/12 〇〇商事に55,000円振込、外注費」',
  '• 仕訳案のスレッドに「修正：貸方は未払金」のように返信：作り直します（案が複数あるスレッドでは「修正 P-…：内容」）',
  '• `/未仕訳 2025-09`：MF の未仕訳明細に仕訳案を付けます（月を省くと直近30日）',
  '• `/ルール 内容`：この事業者の仕訳ルールを覚えさせる（例「Wiseの手数料は支払手数料・対象外」）',
  '• `/質問まとめ`：「質問に追加」したものを関与先ノート用にまとめる',
  'MFへの登録は、カードの「MFに登録」を押したときだけ行います。',
].join('\n');
