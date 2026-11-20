(() => {
  'use strict';

  const { messages, render, imageNote, snapshotVersion, reloadError } = globalThis.ReplyPressDocument;
  const { singlePage } = globalThis.ReplyPressPdf;
  const status = document.getElementById('print-status');
  const saveButton = document.getElementById('save-button');
  const printButton = document.getElementById('print-button');
  const answer = document.getElementById('answer');
  const expired = '本次打印内容已失效，请回到 ChatGPT 重新导出。';

  function print() {
    try {
      window.print();
    } catch {
      status.textContent = '未能打开打印预览。请再次点击打印按钮。';
    }
  }

  function receivePdf() {
    return new Promise((resolve, reject) => {
      const parts = [];
      const port = chrome.runtime.connect({ name: messages.save });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        reject(Error('PDF 生成中断，请重试。'));
      });
      port.onMessage.addListener(message => {
        try {
          if (message.data) {
            const bytes = message.base64
              ? Uint8Array.from(atob(message.data), char => char.charCodeAt(0))
              : new TextEncoder().encode(message.data);
            parts.push(bytes);
          } else if (message.done && parts.length) {
            resolve(new Blob(parts, { type: 'application/pdf' }));
            port.disconnect();
          } else {
            throw Error(message.error || '浏览器未生成 PDF，请重试。');
          }
        } catch (error) {
          reject(error);
          port.disconnect();
        }
      });
    });
  }

  async function longPdf() {
    const sheet = document.getElementById('print-styles').sheet;
    const page = [...sheet.cssRules].find(rule => rule.type === CSSRule.PAGE_RULE);
    const originalSize = page.style.getPropertyValue('size');
    let height;
    answer.classList.add('measure-pdf');
    try {
      // 测量和打印使用相同的正文宽度。
      height = Math.ceil(Math.max(answer.getBoundingClientRect().height, answer.scrollHeight));
    } finally {
      answer.classList.remove('measure-pdf');
    }
    const reserve = Math.max(96, Math.ceil(height * 0.005));
    try {
      for (const extra of [2, reserve, reserve * 4]) {
        page.style.setProperty('size', '210mm ' + (height + extra) + 'px');
        const pdf = await singlePage(await receivePdf());
        if (pdf) return pdf;
      }
      throw Error('未能将整条回答排到一页，请重试。');
    } finally {
      page.style.setProperty('size', originalSize);
    }
  }

  async function save() {
    saveButton.disabled = printButton.disabled = true;
    status.textContent = '正在生成 PDF…';
    try {
      const pdf = await longPdf();
      const url = URL.createObjectURL(pdf);
      const link = document.createElement('a');
      link.href = url;
      const filename = document.title.replace(/^ChatGPT 回答(?: - |$)/, '') || '回答';
      link.download = filename + '.pdf';
      try {
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      status.textContent = '已交给浏览器保存 PDF。';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '未能保存 PDF，请重试。';
    } finally {
      saveButton.disabled = printButton.disabled = false;
    }
  }

  async function waitForLayout() {
    const images = [...answer.querySelectorAll('img')];
    let timer;
    try {
      await Promise.race([
        Promise.all([document.fonts.ready, ...images.map(image => image.decode().catch(() => {}))]),
        new Promise(resolve => { timer = setTimeout(resolve, 4000); })
      ]);
    } finally {
      clearTimeout(timer);
    }
    for (const image of images) {
      if (image.complete && image.naturalWidth) continue;
      const note = document.createElement('span');
      note.className = 'image-note';
      note.textContent = imageNote(image.alt);
      image.replaceWith(note);
    }
  }

  async function prepare() {
    const id = location.hash.slice(1);
    if (!/^[a-f\d-]{36}$/.test(id)) throw Error(expired);
    const response = await chrome.runtime.sendMessage({ type: messages.take, id });
    if (!response?.ok) throw Error(response?.error || expired);
    if (response.snapshot?.version !== snapshotVersion) throw Error(reloadError);
    history.replaceState(null, '', location.pathname);

    const { title, lang, blocks, styles, paper, width } = response.snapshot;
    document.title = title;
    if (/^[a-z\d-]{1,40}$/i.test(lang)) answer.lang = lang;
    if (typeof paper === 'string' && paper.length <= 128 && CSS.supports('background-color', paper)) {
      document.documentElement.style.setProperty('--replypress-paper', paper);
    }
    if (Number.isInteger(width) && width > 0 && width <= 4096) {
      answer.style.setProperty('--replypress-width', width + 'px');
    }
    answer.append(render(document, blocks, styles));
    answer.hidden = false;
    await waitForLayout();
    status.textContent = '预览已就绪。';
    saveButton.disabled = printButton.disabled = false;
  }

  saveButton.addEventListener('click', save);
  printButton.addEventListener('click', print);
  prepare().catch(error => {
    status.textContent = error instanceof Error ? error.message : expired;
  });
})();
