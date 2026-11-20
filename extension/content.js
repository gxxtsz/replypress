(() => {
  'use strict';

  if (globalThis.replyPressAttached) return;
  globalThis.replyPressAttached = true;

  const { messageBoundary, isVisible, hasContent, capture, waitForDiagrams } = globalThis.ReplyPressCapture;
  const { messages } = globalThis.ReplyPressDocument;
  const searchAssistant = '[data-chatgpt-search-unit-key$=":assistant"]';
  const assistant = '[data-message-author-role="assistant"],' + searchAssistant;
  const assistantTurn = '[data-turn="assistant"]';
  const mainRegion = 'main,[role="main"],[data-thread-find-target="conversation"]';
  const turnScope = '[data-turn],[data-talvt-turn-state],[data-testid^="conversation-turn-"]';
  const body = '.markdown,[data-testid="assistant-message-content"]';
  const streaming = '[data-talvt-turn-state="in_progress"],[data-is-streaming="true"],.result-streaming';
  const controlSelector = '[data-replypress-control]';
  const disconnected = 'ReplyPress 已与当前页面断开。请刷新页面后再导出。';
  const controls = new Map();
  let scheduled = false;

  function requireRuntime() {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.id || typeof runtime.sendMessage !== 'function') throw Error(disconnected);
    return runtime;
  }

  function replyBodies(root) {
    const hasAuthor = root.matches(assistant);
    const isSearchUnit = root.matches(searchAssistant);
    const selectors = isSearchUnit
      ? '[data-response-body],[data-markdown-text-style="assistant-message"]'
      : body + (hasAuthor ? ',figure,picture,img' : ',figure,picture');
    const candidates = root.matches(selectors) ? [root] : [...root.querySelectorAll(selectors)];
    const bodies = new Set(candidates.filter(node => {
      const owner = node.closest(messageBoundary);
      return (hasAuthor ? owner === root : !owner && node.closest('[data-turn]') === root)
        && isVisible(node) && hasContent(node);
    }));
    if (!bodies.size && hasAuthor && !isSearchUnit && hasContent(root)) return [root];

    // 有图的正文容器只采集一次，独立于正文容器的图像仍按页面顺序保留。
    return [...bodies].filter(node => {
      for (let parent = node.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
        if (bodies.has(parent)) return false;
      }
      return true;
    });
  }

  function replies() {
    const result = [];
    for (const root of document.querySelectorAll(assistant + ',' + assistantTurn)) {
      const main = root.closest(mainRegion);
      if (!main || !isVisible(root)) continue;
      if (root.matches(assistant)) {
        if (root.parentElement?.closest(messageBoundary)) continue;
      } else if ([...root.querySelectorAll(assistant)].some(isVisible)) {
        continue;
      }
      const sources = replyBodies(root);
      if (sources.length) result.push({ root, main, sources, turn: root.closest(turnScope) || root });
    }
    return result;
  }

  function isGenerating(reply) {
    const { root, turn, main } = reply;
    if (root.matches(streaming) || turn.matches(streaming)
        || [...turn.querySelectorAll(streaming)].some(isVisible)) return true;
    if (turn.getAttribute('data-talvt-turn-state') === 'complete') return false;

    const stopButtons = document.querySelectorAll('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="停止生成"]');
    if (![...stopButtons].some(isVisible)) return false;
    const latest = [...main.querySelectorAll('[data-turn],' + messageBoundary)].findLast(isVisible);
    return latest && (latest === turn || latest === root || root.contains(latest));
  }

  function addControl(root) {
    const group = document.createElement('div');
    group.setAttribute('data-replypress-control', '');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '导出 PDF';
    button.setAttribute('aria-label', '将这条回答导出为 PDF');
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    group.append(button, status);

    const control = { group, button, busy: false };
    button.addEventListener('click', async () => {
      if (control.busy) return;
      const current = replies().find(reply => reply.root === root);
      if (!current) {
        status.textContent = '这条回答已不可用。';
        return;
      }
      if (isGenerating(current)) {
        status.textContent = '请等回答生成完成后再导出。';
        return;
      }

      control.busy = button.disabled = true;
      status.textContent = '正在准备预览…';
      try {
        requireRuntime();
        const address = location.href;
        const messageKey = root.getAttribute('data-chatgpt-search-unit-key');
        const checkReply = reply => {
          if (!reply || location.href !== address || root.getAttribute('data-chatgpt-search-unit-key') !== messageKey
              || !isVisible(root) || isGenerating(reply)) throw Error('这条回答已变化，请重新导出。');
        };
        await waitForDiagrams(current.sources);
        const ready = replies().find(reply => reply.root === root);
        checkReply(ready);
        const snapshot = await capture(ready.sources);
        checkReply(ready);
        const response = await requireRuntime().sendMessage({ type: messages.open, snapshot });
        if (!response?.ok) throw Error(response?.error || '无法打开预览页。');
        status.textContent = '';
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法打开预览页。';
        status.textContent = message === 'Extension context invalidated.' ? disconnected : message;
      } finally {
        control.busy = false;
        schedule();
      }
    });
    root.append(group);
    return control;
  }

  function reconcile() {
    scheduled = false;
    const current = replies();
    const visibleRoots = new Set(current.map(reply => reply.root));
    for (const [root, control] of controls) {
      if (visibleRoots.has(root)) continue;
      control.group.remove();
      controls.delete(root);
    }
    for (const reply of current) {
      const { root } = reply;
      let control = controls.get(root);
      if (!control) {
        control = addControl(root);
        controls.set(root, control);
      } else if (control.group.parentElement !== root) {
        root.append(control.group);
      }
      // 流式正文可能把自己的末尾插到按钮后面，按钮仍放回回答底部。
      if (control.group !== root.lastElementChild) root.append(control.group);
      const generating = isGenerating(reply);
      control.button.disabled = control.busy || generating;
      control.button.title = generating ? '回答生成完成后可以导出' : '预览并保存为 PDF';
    }
  }

  function schedule() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(reconcile);
    }
  }

  document.querySelectorAll(controlSelector).forEach(control => control.remove());
  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'aria-hidden', 'aria-label', 'class', 'data-chatgpt-search-unit-key', 'data-is-streaming',
      'data-markdown-text-style', 'data-message-author-role', 'data-response-body', 'data-talvt-turn-state',
      'data-testid', 'data-thread-find-target', 'data-turn', 'hidden', 'inert', 'open', 'role', 'style'
    ]
  });
  schedule();
})();
