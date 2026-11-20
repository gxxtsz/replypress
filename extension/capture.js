globalThis.ReplyPressCapture = (() => {
  'use strict';

  const model = globalThis.ReplyPressDocument;
  const htmlNamespace = 'http://www.w3.org/1999/xhtml';
  const messageBoundary = '[data-message-author-role],[data-chatgpt-search-unit-key]';
  const buttonSelector = 'button,[role="button"]';
  const proseSelector = 'p,li,dt,dd,td,th,caption,figcaption,blockquote,h1,h2,h3,h4,h5,h6';
  const omitted = [
    '[data-replypress-control]', '[hidden]', '[inert]', '[aria-hidden="true"]', '.sr-only',
    '[role="toolbar"]', '[role="menu"]', '[role="tooltip"]',
    '[data-testid*="reasoning" i]', '[data-testid*="thinking" i]', '[data-testid*="thought" i]',
    'details:not([open])', 'form', 'script', 'style', 'template',
    'iframe', 'object', 'embed', 'canvas', 'video', 'audio'
  ].join(',');
  const mathWrapper = '.katex-display,.katex,mjx-container';
  const lineBreaks = /^(?:blockquote|caption|dd|div|dt|figcaption|figure|h[1-6]|li|p|pre|tr)$/;

  function hasVisibleBox(element) {
    if (!element) return false;
    if (element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true })) return true;
    const style = getComputedStyle(element);
    if (style.display === 'contents') return hasVisibleBox(element.parentElement);
    return !element.checkVisibility && style.visibility === 'visible' && element.getClientRects().length > 0;
  }

  function hasDottedUnderline(element) {
    const style = getComputedStyle(element);
    return (style.textDecorationStyle === 'dotted' && style.textDecorationLine.includes('underline'))
      || (style.borderBottomStyle === 'dotted' && Number.parseFloat(style.borderBottomWidth) > 0);
  }

  function isInlineTerm(element) {
    // 正文和表格中的术语标签可以有按钮语义。点状下划线可能设在按钮上，也可能设在文字层。
    // 仅识别有可见文字样式的正文标签，避免把单元格里的复制等操作按钮带进导出。
    return element.namespaceURI === htmlNamespace && element.parentElement?.closest(proseSelector)
      && element.textContent.trim() && (hasDottedUnderline(element)
        || [...element.children].some(child => child.matches('span') && hasDottedUnderline(child)));
  }

  function isVisible(element) {
    if (!element?.isConnected || element.closest(omitted) || !hasVisibleBox(element)) return false;
    // 正文容器的识别和采集使用同一规则，避免只有术语标签的回答被当成空回答。
    for (let button = element.closest(buttonSelector); button; button = button.parentElement?.closest(buttonSelector)) {
      if (!isInlineTerm(button)) return false;
    }
    return true;
  }

  function hasContent(element) {
    if (element.matches('img,math,svg') || [...element.querySelectorAll('img,math,svg')].some(isVisible)) {
      return true;
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let next = walker.nextNode(); next; next = walker.nextNode()) {
      if (next.data.trim() && isVisible(next.parentElement)) return true;
    }
    return false;
  }

  async function waitForDiagrams(sources) {
    const previews = sources.flatMap(source => [...source.querySelectorAll('[data-chatgpt-mermaid-preview]')]);
    const pending = preview => {
      if (!preview.isConnected || preview.closest(omitted)) return false;
      const state = preview.querySelector('[data-mermaid-render-status]')?.getAttribute('data-mermaid-render-status');
      return !['error', 'failed'].includes(state) && !isVisible(preview.querySelector('svg[role="img"]'));
    };
    const deadline = performance.now() + 3500;
    // 图表在正文挂载后另行渲染。若图表还在绘制，短暂等一下再取快照。
    while (previews.some(pending) && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }

  const svgType = 'image/svg+xml';
  const maxRasterSide = 1600;

  async function readImageSource(source, available, keepRaster, signal) {
    if (signal.aborted || !/^(?:https?:\/\/|blob:)/.test(source)) return null;
    try {
      // 按聊天页的同源和跨域规则读取已显示的图源，优先使用浏览器缓存。
      const response = await fetch(source, {
        cache: 'force-cache', credentials: 'same-origin', referrerPolicy: 'no-referrer', signal
      });
      const mediaType = response.headers.get('Content-Type') || '';
      const type = mediaType.split(';', 1)[0].trim().toLowerCase();
      if (!response.ok || !model.imageTypes.has(type) || !response.body || (!keepRaster && type !== svgType)) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      const charset = /;\s*charset\s*=\s*"?([a-z\d_-]+)"?(?=\s*(?:;|$))/i.exec(mediaType)?.[1];
      const mime = type === svgType && charset ? type + ';charset=' + charset.toLowerCase() : type;
      const prefix = 'data:' + mime + ';base64,';
      const byteLimit = Math.floor((available - prefix.length) / 4) * 3;
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > byteLimit) return null;
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      if (!size) return null;
      return await new Promise((resolve, reject) => {
        const encoder = new FileReader();
        encoder.onload = () => resolve(encoder.result);
        encoder.onerror = () => reject(encoder.error);
        encoder.readAsDataURL(new Blob(chunks, { type: mime }));
      });
    } catch {
      // 图源失效、超过等待时间或浏览器禁止读取时，交给像素采集处理。
      return null;
    }
  }

  async function snapshotImage(image, source, available, signal) {
    const keepRaster = Math.max(image.naturalWidth, image.naturalHeight) <= maxRasterSide;
    // SVG 在预览页中仍通过 img 加载，由浏览器按图像模式绘制原始矢量。
    if (source.length <= available && model.isImageData(source) && (keepRaster || model.isSvgImageData(source))) return source;
    const original = await readImageSource(source, available, keepRaster, signal);
    if (original?.length <= available && model.isImageData(original)) return original;
    if (!image.complete || !image.naturalWidth || !image.naturalHeight
        || (image.currentSrc || image.src) !== source) return null;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, maxRasterSide / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    try {
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/webp', 0.92);
      return data.length <= available && model.isImageData(data) ? data : null;
    } catch {
      // 浏览器禁止读取受跨域限制的像素时，打印页使用替代文字。
      return null;
    }
  }

  function makeElement(tag, children, attrs = {}) {
    return Object.keys(attrs).length ? { tag, attrs, children } : { tag, children };
  }

  function attributesOf(element) {
    return Object.fromEntries([...element.attributes].map(({ name, value }) => [name, value]));
  }

  function firstHeading(blocks) {
    for (const node of blocks) {
      if (typeof node === 'string') continue;
      if (/^h[1-6]$/.test(node.tag) && modelText(node).trim()) return node;
      const nested = firstHeading(node.children);
      if (nested) return nested;
    }
    return null;
  }

  function modelText(node) {
    if (typeof node === 'string') return node;
    if (node.tag === 'img') return node.attrs?.alt || '';
    if (node.tag === 'br') return '\n';
    const text = node.children.map(modelText).join('');
    return lineBreaks.test(node.tag) ? '\n' + text + '\n' : text;
  }

  function titleFor(blocks) {
    const heading = firstHeading(blocks);
    const text = heading ? modelText(heading) : blocks.map(modelText).join('');
    const line = text.split(/\r?\n/).find(value => value.trim()) || '';
    const safe = line.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim();
    const title = Array.from(safe).slice(0, 64).join('').replace(/[ .]+$/, '');
    return title ? 'ChatGPT 回答 - ' + title : 'ChatGPT 回答';
  }

  function paperBackground(source) {
    for (let element = source; element; element = element.parentElement) {
      const color = getComputedStyle(element).backgroundColor;
      if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
    }
    return '#fff';
  }

  async function capture(sources) {
    let visited = 0;
    let remainingText = model.limits.text;
    let remainingImages = model.limits.images;
    const styles = [];
    const styleIds = new Map();
    const images = [];
    const bounds = sources.map(source => source.getBoundingClientRect())
      .reduce((widest, current) => current.width > widest.width ? current : widest);

    function trimTableBreakout(node, style) {
      const rect = node.getBoundingClientRect();
      let boundary;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const outer = parent.getBoundingClientRect();
        if (outer.width > 0 && rect.width > outer.width + 1) {
          boundary = outer;
          break;
        }
        if (sources.includes(parent)) break;
      }
      if (!boundary) return;
      // 网页用负边距展宽表格滚动区，再用内边距把表格移回正文。打印时移除这组偏移。
      const overflow = { left: boundary.left - rect.left, right: rect.right - boundary.right };
      for (const side of ['left', 'right']) {
        if (overflow[side] <= 1) continue;
        const margin = 'margin-' + side;
        const padding = 'padding-' + side;
        if (Number.parseFloat(style[margin]) < 0) {
          style[margin] = Math.min(0, Number.parseFloat(style[margin]) + overflow[side]) + 'px';
        }
        if (Number.parseFloat(style[padding]) > 0) {
          style[padding] = Math.max(0, Number.parseFloat(style[padding]) - overflow[side]) + 'px';
        }
      }
    }

    function styled(node, tag, children, attrs = {}, inSvg = false) {
      const computed = getComputedStyle(node);
      const style = model.safeStyle(name => computed.getPropertyValue(name), inSvg, location.href);
      if (!inSvg) {
        const layout = node.computedStyleMap?.();
        for (const side of ['left', 'right']) {
          const margin = 'margin-' + side;
          if (sources.includes(node)) style[margin] = '0px';
          else if (layout?.get(margin)?.toString() === 'auto') style[margin] = 'auto';
        }
        const hasGutter = ['left', 'right'].some(side => Number.parseFloat(style['margin-' + side]) < 0
          || Number.parseFloat(style['padding-' + side]) > 0);
        if (tag === 'div' && hasGutter && node.querySelector('table')) trimTableBreakout(node, style);
      }
      // 计算后的网格列宽通常是像素值。转换成相对比例，让原来的列能收进纸张。
      if (style.display === 'grid' || style.display === 'inline-grid') {
        const columns = style['grid-template-columns']?.split(/\s+/) || [];
        if (columns.length && columns.every(value => /^\d+(?:\.\d+)?px$/.test(value))) {
          style['grid-template-columns'] = columns.map(value => 'minmax(0, ' + value.replace('px', 'fr') + ')').join(' ');
        }
      }
      const key = JSON.stringify(style);
      if (!styleIds.has(key)) {
        styleIds.set(key, styles.length);
        styles.push(style);
      }
      const block = { ...makeElement(tag, children, attrs), style: styleIds.get(key) };
      if (tag === 'div') {
        if (node.matches('[data-d-component="divider"]')) {
          block.layout = 'divider';
        } else if (node.hasAttribute('data-code-block')) {
          block.layout = 'code-card';
        } else if (node.hasAttribute('data-markdown-copy') && node.parentElement?.hasAttribute('data-code-block')) {
          block.layout = 'code-header';
          block.headerHeight = Number.parseFloat(computed.height);
        } else if (node.matches('[data-d-component="box"]')
            && node.querySelector(':scope > img[data-d-component="svg"], :scope > svg[data-d-component="svg"]')) {
          block.layout = 'diagram';
        }
      }
      return block;
    }

    function visit(depth) {
      if (++visited > model.limits.nodes || depth > model.limits.depth) throw Error(model.sizeError);
    }

    function readText(value) {
      remainingText -= value.length;
      if (remainingText < 0) throw Error(model.sizeError);
      return value;
    }

    function readMath(node, depth) {
      visit(depth);
      if (node.nodeType === Node.TEXT_NODE) return [readText(node.data)];
      if (node.namespaceURI !== model.mathNamespace || !model.mathTags.has(node.localName)) return [];
      const children = [...node.childNodes].flatMap(child => readMath(child, depth + 1));
      return [makeElement(node.localName, children, model.safeAttributes(node.localName, attributesOf(node), true))];
    }

    function readSvg(node, depth, root = false) {
      visit(depth);
      if (node.nodeType === Node.TEXT_NODE) return [readText(node.data)];
      if (node.namespaceURI !== model.svgNamespace || !model.svgTags.has(node.localName)) return [];
      const attrs = model.safeSvgAttributes(attributesOf(node));
      if (root) {
        const { width, height } = node.getBoundingClientRect();
        if (width > 0 && height > 0) {
          attrs.width = String(Math.round(width));
          attrs.height = String(Math.round(height));
        }
      }
      const children = [...node.childNodes].flatMap(child => readSvg(child, depth + 1));
      return [styled(node, node.localName, children, attrs, true)];
    }

    function read(node, depth, inCode = false) {
      visit(depth);
      if (node.nodeType === Node.TEXT_NODE) return [readText(node.data)];
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches(omitted)) return [];
      const isButton = node.matches(buttonSelector);
      if (isButton && !isInlineTerm(node)) return [];
      if (!hasVisibleBox(node)) {
        const whitespace = inCode && node.matches('span') && /^\s+$/.test(node.textContent)
          && getComputedStyle(node).display !== 'none';
        return whitespace ? [readText(node.textContent)] : [];
      }
      if (depth > 0 && node.matches(messageBoundary)) return [];

      if (node.namespaceURI === model.mathNamespace && node.localName === 'math') return readMath(node, depth);
      if (node.namespaceURI === model.svgNamespace && node.localName === 'svg') return readSvg(node, depth, true);
      if (node.namespaceURI !== htmlNamespace) return [];
      if (node.matches(mathWrapper)) {
        const math = node.querySelector('math');
        const result = math ? readMath(math, depth) : [];
        if (result.length) {
          if (node.matches('.katex-display,mjx-container[display="true"]')) {
            result[0].attrs = { ...result[0].attrs, display: 'block' };
          }
          return result;
        }
        const fallback = node.querySelector('annotation[encoding="application/x-tex"],.katex-html')?.textContent;
        if (fallback) return [makeElement('span', [readText(fallback)])];
      }

      // 术语标签以静态 span 输出，沿用正文采集保留文字、格式和点状下划线。
      const tag = isButton ? 'span' : node.localName;
      if (tag === 'input') {
        return node.type === 'checkbox' && node.disabled ? [node.checked ? '☑ ' : '☐ '] : [];
      }
      if (tag === 'img') {
        const attrs = { alt: node.alt.slice(0, 500) };
        if (node.complete && node.naturalWidth && node.naturalHeight) {
          const { width, height } = node.getBoundingClientRect();
          if (width > 0 && height > 0) {
            attrs.width = String(Math.round(width));
            attrs.height = String(Math.round(height));
          }
          images.push({ image: node, source: node.currentSrc || node.src, attrs });
        }
        return [styled(node, 'img', [], attrs)];
      }
      if (tag === 'pre') {
        const code = [...node.querySelectorAll('code')].find(isVisible);
        if (code) return [styled(node, 'pre', read(code, depth + 1, true))];
      }

      const children = [...node.childNodes].flatMap(child => read(child, depth + 1, inCode || tag === 'pre' || tag === 'code'));
      if (!model.htmlTags.has(tag)) return children;
      return [styled(node, tag, children, model.safeAttributes(tag, attributesOf(node), false, location.href))];
    }

    const blocks = sources.flatMap(source => read(source, 0));
    if (!blocks.length) throw Error('这条回答没有可打印的内容。');
    const lang = document.documentElement.lang.slice(0, 40);
    const width = Math.round(bounds.width);
    const snapshot = {
      version: model.snapshotVersion, title: titleFor(blocks), lang, blocks, styles,
      paper: paperBackground(sources[0]), width
    };
    const signal = AbortSignal.timeout(3500);
    for (const { image, source, attrs } of images) {
      if (!remainingImages) break;
      const data = await snapshotImage(image, source, remainingImages, signal);
      // 跨域搜图配图可能只允许直接显示。预览页可沿用已加载的图片 CDN 地址。
      const imageSource = data ?? (model.isInlineImageSource(source) ? source : null);
      if (!imageSource || imageSource.length > remainingImages) continue;
      attrs.src = imageSource;
      remainingImages -= imageSource.length;
    }
    if (!model.validSnapshot(snapshot)) throw Error(model.sizeError);
    return snapshot;
  }

  return Object.freeze({ messageBoundary, isVisible, hasContent, capture, waitForDiagrams });
})();
