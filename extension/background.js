'use strict';

importScripts('document-model.js');

const { messages, validSnapshot, snapshotVersion, reloadError } = globalThis.ReplyPressDocument;
const printUrl = chrome.runtime.getURL('print.html');
const pending = new Map();
const savingTabs = new Set();
const lifetime = 20000;

function release(id) {
  const job = pending.get(id);
  if (!job) return;
  clearTimeout(job.timer);
  pending.delete(id);
}

async function openPrint(snapshot, sender) {
  if (!sender.url?.startsWith('https://chatgpt.com/')) {
    return { ok: false, error: '无法读取这条回答的打印数据。' };
  }
  if (snapshot?.version !== snapshotVersion) return { ok: false, error: reloadError };
  if (!validSnapshot(snapshot)) return { ok: false, error: '无法读取这条回答的打印数据。' };

  const id = crypto.randomUUID();
  const job = { snapshot, timer: setTimeout(() => release(id), lifetime) };
  pending.set(id, job);
  try {
    job.tabReady = chrome.tabs.create({
      url: printUrl + '#' + id,
      windowId: sender.tab.windowId,
      openerTabId: sender.tab.id,
      active: true
    }).then(tab => {
      job.tabId = tab.id;
      return tab.id;
    });
    await job.tabReady;
    return { ok: true };
  } catch {
    release(id);
    return { ok: false, error: '无法打开打印标签页，请重试。' };
  }
}

async function takePrint(id, sender) {
  const expired = { ok: false, error: '本次打印内容已失效，请回到 ChatGPT 重新导出。' };
  if (typeof id !== 'string' || sender.url?.split('#', 1)[0] !== printUrl) return expired;
  const job = pending.get(id);
  if (!job || await job.tabReady !== sender.tab.id || pending.get(id) !== job) return expired;
  release(id);
  return { ok: true, snapshot: job.snapshot };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) {
    return false;
  }
  let response;
  if (request?.type === messages.open) response = openPrint(request.snapshot, sender);
  else if (request?.type === messages.take) response = takePrint(request.id, sender);
  else return false;

  response.then(sendResponse, () => sendResponse({ ok: false, error: '打印请求失败，请重新导出。' }));
  return true;
});

async function savePdf(port, tabId) {
  if (savingTabs.has(tabId)) {
    port.postMessage({ error: '这份 PDF 正在生成。' });
    return;
  }
  savingTabs.add(tabId);

  const target = { tabId };
  let attached = false;
  let detaching;
  let disconnected = false;
  let stream;
  let result = { error: '未能生成 PDF，请重试。' };

  function detach() {
    if (attached) {
      attached = false;
      // 标签页关闭或用户取消时，浏览器可能已经释放了调试连接。
      detaching = chrome.debugger.detach(target).catch(() => {});
    }
    return detaching;
  }

  port.onDisconnect.addListener(() => {
    disconnected = true;
    void detach();
  });

  try {
    const tab = await chrome.tabs.get(tabId);
    if (disconnected) return;
    if (tab.url !== printUrl || tab.status === 'loading' || tab.pendingUrl) {
      throw Error('打印页已变化。');
    }

    await chrome.debugger.attach(target, '1.3');
    attached = true;
    if (disconnected) return;
    const { frameTree } = await chrome.debugger.sendCommand(target, 'Page.getFrameTree');
    if (disconnected) return;
    if (frameTree.frame.url !== printUrl) throw Error('打印页已变化。');

    ({ stream } = await chrome.debugger.sendCommand(target, 'Page.printToPDF', {
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      marginTop: 0,
      marginBottom: 0,
      printBackground: true,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
      transferMode: 'ReturnAsStream'
    }));
    if (!stream) throw Error('浏览器未返回 PDF 数据。');

    // 分块交给预览页，避免较大的 PDF 超出扩展的单条消息大小限制。
    while (!disconnected) {
      const chunk = await chrome.debugger.sendCommand(target, 'IO.read', {
        handle: stream,
        size: 256 * 1024
      });
      if (disconnected) return;
      if (chunk.data) port.postMessage({ data: chunk.data, base64: Boolean(chunk.base64Encoded) });
      if (chunk.eof) {
        result = { done: true };
        break;
      }
    }
  } catch {
    // 预览页显示简短提示，保留重新生成的入口。
  } finally {
    if (attached && stream) {
      await chrome.debugger.sendCommand(target, 'IO.close', { handle: stream }).catch(() => {});
    }
    await detach();
    savingTabs.delete(tabId);
  }
  if (!disconnected) port.postMessage(result);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== messages.save) return;
  const sender = port.sender;
  if (sender?.id !== chrome.runtime.id || sender.url?.split('#', 1)[0] !== printUrl
      || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) {
    port.disconnect();
    return;
  }
  savePdf(port, sender.tab.id).catch(() => port.disconnect());
});

chrome.tabs.onRemoved.addListener(tabId => {
  for (const [id, job] of pending) {
    if (job.tabId === tabId) release(id);
  }
});
