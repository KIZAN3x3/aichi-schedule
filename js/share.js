// チャットワーク用の文面・リンクのコピー（日程調整画面とスケジュール画面で共通）

// 自由記述に [ ] が入っていると、チャットワークの[info]等の記法が崩れるため全角にする
export function replaceChatworkBrackets(text) {
  return text.replace(/\[/g, '［').replace(/\]/g, '］');
}

// [info][title]…[/title]…[/info] で囲む。タイトルの [ ] はここで全角にする。
// 本文の各行は呼び出し側で必要に応じて replaceChatworkBrackets を通しておくこと
export function chatworkInfo(title, lines) {
  return `[info][title]${replaceChatworkBrackets(title)}[/title]\n${lines.join('\n')}\n[/info]`;
}

export async function copyToClipboard(text, fallbackTextareaEl) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // 権限拒否・非対応ブラウザ等はフォールバックへ
  }
  // フォールバック: 選択済みのtextareaを表示し、手動コピー(Ctrl+C・長押し)を促す
  fallbackTextareaEl.value = text;
  fallbackTextareaEl.classList.remove('hidden');
  fallbackTextareaEl.focus();
  fallbackTextareaEl.select();
  try {
    return document.execCommand('copy'); // 古い環境向けの最終手段。失敗しても選択状態は残る
  } catch (err) {
    return false;
  }
}

export function flashCopyResult(btn, ok) {
  const original = btn.textContent;
  btn.textContent = ok ? 'コピーしました' : '選択済みです。コピーしてください';
  setTimeout(() => {
    btn.textContent = original;
  }, 2000);
}

// 「💬 チャットワーク用にコピー」「🔗 リンクだけコピー」の2つのボタン＋手動コピー用の欄。
// 文面とURLはクリックした時点で組み立てる
export function createShareActions({ getChatworkText, getUrl, className = '' }) {
  const wrap = document.createElement('div');
  wrap.className = className ? `share-actions ${className}` : 'share-actions';

  const fallback = document.createElement('textarea');
  fallback.className = 'copy-fallback hidden';
  fallback.readOnly = true;

  const chatworkBtn = document.createElement('button');
  chatworkBtn.type = 'button';
  chatworkBtn.className = 'btn btn-outline btn-small';
  chatworkBtn.textContent = '💬 チャットワーク用にコピー';
  chatworkBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(getChatworkText(), fallback);
    flashCopyResult(chatworkBtn, ok);
  });

  const linkBtn = document.createElement('button');
  linkBtn.type = 'button';
  linkBtn.className = 'btn btn-outline btn-small';
  linkBtn.textContent = '🔗 リンクだけコピー';
  linkBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(getUrl(), fallback);
    flashCopyResult(linkBtn, ok);
  });

  wrap.append(chatworkBtn, linkBtn, fallback);
  return wrap;
}
