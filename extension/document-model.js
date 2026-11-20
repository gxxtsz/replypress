globalThis.ReplyPressDocument = (() => {
  'use strict';

  const mathNamespace = 'http://www.w3.org/1998/Math/MathML';
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const htmlTags = new Set([
    'a', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'div',
    'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'img', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'samp', 'small',
    'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
    'tr', 'u', 'ul', 'var', 'wbr'
  ]);
  const mathTags = new Set([
    'math', 'menclose', 'merror', 'mfenced', 'mfrac', 'mi', 'mmultiscripts', 'mn',
    'mo', 'mover', 'mpadded', 'mphantom', 'mprescripts', 'mroot', 'mrow', 'ms',
    'mspace', 'msqrt', 'mstyle', 'msub', 'msubsup', 'msup', 'mtable', 'mtd', 'mtext',
    'mtr', 'munder', 'munderover', 'none', 'semantics'
  ]);
  const svgTags = new Set([
    'svg', 'g', 'defs', 'title', 'desc', 'circle', 'ellipse', 'line', 'path', 'polygon',
    'polyline', 'rect', 'text', 'tspan', 'textPath', 'marker', 'clipPath', 'mask',
    'linearGradient', 'radialGradient', 'stop', 'filter', 'feDropShadow', 'pattern', 'symbol', 'use'
  ]);
  const svgAttributes = [
    'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2',
    'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'dx', 'dy', 'rotate',
    'textLength', 'lengthAdjust', 'startOffset', 'refX', 'refY', 'markerUnits',
    'markerWidth', 'markerHeight', 'orient', 'gradientUnits', 'gradientTransform', 'spreadMethod',
    'fx', 'fy', 'fr', 'offset', 'filterUnits', 'primitiveUnits', 'stdDeviation', 'in', 'result',
    'patternUnits', 'patternContentUnits', 'patternTransform', 'clipPathUnits', 'maskUnits',
    'maskContentUnits', 'aria-label'
  ];
  const svgReferences = new Set(['fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end']);
  const typography = [
    'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'letter-spacing', 'word-spacing', 'text-align', 'text-transform', 'text-decoration-line',
    'text-decoration-color', 'text-decoration-style', 'white-space', 'tab-size'
  ];
  const edges = ['top', 'right', 'bottom', 'left'];
  const htmlStyle = [
    ...typography, 'background-color', 'box-sizing', 'display', 'vertical-align', 'list-style-type',
    'list-style-position', 'border-radius', 'box-shadow', 'border-collapse', 'border-spacing',
    'object-fit', 'object-position',
    ...edges.flatMap(side => ['margin-' + side, 'padding-' + side, 'border-' + side]),
    'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'align-items', 'align-self',
    'justify-content', 'justify-items', 'justify-self', 'column-gap', 'row-gap',
    'grid-template-columns', 'grid-column-start', 'grid-column-end'
  ];
  const svgStyle = [
    ...typography, ...svgReferences, 'visibility', 'opacity', 'fill-opacity', 'fill-rule',
    'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
    'stroke-dashoffset', 'stroke-miterlimit', 'dominant-baseline', 'alignment-baseline',
    'text-anchor', 'paint-order', 'vector-effect', 'stop-color', 'stop-opacity', 'flood-color',
    'flood-opacity'
  ];
  const svgId = /^[-\w:.]{1,240}$/;
  const mathAttributes = [
    'accent', 'accentunder', 'align', 'bevelled', 'columnalign', 'columnlines',
    'columnspacing', 'columnspan', 'depth', 'display', 'displaystyle', 'fence',
    'form', 'frame', 'height', 'linethickness', 'lspace', 'mathvariant', 'maxsize',
    'minsize', 'movablelimits', 'notation', 'rowalign', 'rowlines', 'rowspacing',
    'rowspan', 'rspace', 'scriptlevel', 'separator', 'stretchy', 'symmetric',
    'voffset', 'width'
  ];
  const limits = Object.freeze({
    depth: 96,
    nodes: 24000,
    text: 1200000,
    images: 8 * 1024 * 1024,
    message: 16 * 1024 * 1024
  });
  const imageTypes = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp']);
  const messages = Object.freeze({
    open: 'replypress/open-print',
    take: 'replypress/take-print',
    save: 'replypress/save-pdf'
  });
  const snapshotVersion = 2;
  const reloadError = '请在扩展管理页重新加载 ReplyPress，再刷新 ChatGPT 后重新导出。';
  const sizeError = '这条回答内容过大，无法生成打印页。';

  function safeLink(value, base) {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192) return null;
    try {
      const url = new URL(value, base);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
        return url.href;
      }
    } catch {
      return null;
    }
    return null;
  }

  function isImageData(value) {
    if (typeof value !== 'string' || value.length > limits.images) return false;
    if (isSvgImageData(value)) return true;
    const match = /^data:(image\/[a-z]+);base64,[A-Za-z0-9+/]+={0,2}$/i.exec(value);
    return imageTypes.has(match?.[1].toLowerCase());
  }

  function isSvgImageData(value) {
    return /^data:image\/svg\+xml(?:;charset=[a-z\d_-]+|;utf8)?(?:;base64)?,./is.test(value);
  }

  function isInlineImageSource(value) {
    return typeof value === 'string' && value.length <= 2048
      && /^https:\/\/images\.openai\.com\/static-rsc-\d+\/[\w-]+\?purpose=inline$/.test(value);
  }

  function imageNote(alt) {
    return alt ? '［图片不可用：' + alt + '］' : '［图片不可用］';
  }

  function safeStyle(valueOf, inSvg = false, base) {
    const appearance = {};
    for (const name of inSvg ? svgStyle : htmlStyle) {
      const value = valueOf(name);
      if (typeof value !== 'string' || !value || value.length > 640 || /[;{}\\]/.test(value)) continue;
      if (/\burl\s*\(/i.test(value)) {
        if (!inSvg || !svgReferences.has(name)) continue;
        const ref = localSvgUrl(value, base);
        if (ref) appearance[name] = ref;
      } else {
        appearance[name] = value;
      }
    }
    return appearance;
  }

  function localSvgUrl(value, base) {
    const match = /^url\(\s*(["']?)([^"'()]+)\1\s*\)$/i.exec(value);
    if (!match) return null;
    let target = match[2].trim();
    if (!target.startsWith('#') && base) {
      try {
        const url = new URL(target, base);
        if (url.href.split('#')[0] !== base.split('#')[0]) return null;
        target = url.hash;
      } catch {
        return null;
      }
    }
    return target.startsWith('#') && svgId.test(target.slice(1)) ? 'url(' + target + ')' : null;
  }

  function safeSvgAttributes(source) {
    const attrs = {};
    for (const name of svgAttributes) {
      const value = source[name];
      if (typeof value === 'string' && value.length <= (name === 'd' || name === 'points' ? 65536 : 1024)) {
        attrs[name] = value;
      }
    }
    if (typeof source.id === 'string' && svgId.test(source.id)) attrs.id = source.id;
    const href = source.href || source['xlink:href'];
    if (typeof href === 'string' && href.startsWith('#') && svgId.test(href.slice(1))) attrs.href = href;
    return attrs;
  }

  function safeAttributes(tag, source = {}, isMath = false, base) {
    const attrs = {};
    const valueOf = name => typeof source[name] === 'string' ? source[name] : '';
    if (isMath) {
      for (const name of mathAttributes) {
        const value = valueOf(name).trim();
        if (value && value.length <= 128) attrs[name] = value;
      }
      return attrs;
    }

    const dir = valueOf('dir').toLowerCase();
    if (['auto', 'ltr', 'rtl'].includes(dir)) attrs.dir = dir;
    if (tag === 'a') {
      const href = safeLink(valueOf('href'), base);
      if (href) attrs.href = href;
    }
    if (tag === 'img') {
      attrs.alt = valueOf('alt').slice(0, 500);
      if (isImageData(source.src) || isInlineImageSource(source.src)) attrs.src = source.src;
      for (const name of ['width', 'height']) {
        if (/^[1-9]\d{0,3}$/.test(valueOf(name))) attrs[name] = valueOf(name);
      }
    }
    if (tag === 'ol' || tag === 'li') {
      const name = tag === 'ol' ? 'start' : 'value';
      if (/^-?\d{1,6}$/.test(valueOf(name))) attrs[name] = valueOf(name);
    }
    if (tag === 'td' || tag === 'th') {
      for (const name of ['colspan', 'rowspan']) {
        if (/^\d{1,3}$/.test(valueOf(name))) attrs[name] = valueOf(name);
      }
      const scope = valueOf('scope');
      if (tag === 'th' && ['row', 'col', 'rowgroup', 'colgroup'].includes(scope)) attrs.scope = scope;
    }
    return attrs;
  }

  function validSnapshot(snapshot) {
    return snapshot?.version === snapshotVersion && typeof snapshot.title === 'string' && snapshot.title.length <= 160
      && typeof snapshot.lang === 'string' && snapshot.lang.length <= 40
      && Array.isArray(snapshot.blocks) && snapshot.blocks.length > 0
      && (snapshot.styles === undefined || (Array.isArray(snapshot.styles) && snapshot.styles.length <= limits.nodes))
      && new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= limits.message;
  }

  function render(doc, blocks, styles = []) {
    const fragment = doc.createDocumentFragment();
    const checkedStyles = new Map();
    let count = 0;

    function append(parent, node, depth, namespace) {
      if (++count > limits.nodes || depth > limits.depth) throw Error(sizeError);
      if (typeof node === 'string') {
        parent.append(doc.createTextNode(node));
        return;
      }
      const tag = node?.tag;
      const inSvg = namespace === svgNamespace || tag === 'svg';
      const inMath = namespace === mathNamespace || tag === 'math';
      const tags = inSvg ? svgTags : inMath ? mathTags : htmlTags;
      if (!tags.has(tag) || !Array.isArray(node.children)) {
        throw Error('打印数据包含无法识别的内容。');
      }
      const attrs = inSvg ? safeSvgAttributes(node.attrs || {}) : safeAttributes(tag, node.attrs || {}, inMath);
      if (tag === 'img' && !attrs.src) {
        const note = doc.createElement('span');
        note.className = 'image-note';
        note.textContent = imageNote(attrs.alt);
        parent.append(note);
        return;
      }
      const ns = inSvg ? svgNamespace : inMath ? mathNamespace : null;
      const element = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
      if (tag === 'img') element.referrerPolicy = 'no-referrer';
      for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
      if (Number.isInteger(node.style) && node.style >= 0 && styles[node.style]) {
        const key = (inSvg ? 'svg:' : 'html:') + node.style;
        if (!checkedStyles.has(key)) {
          const source = styles[node.style];
          checkedStyles.set(key, Object.entries(safeStyle(name => source[name], inSvg)));
        }
        for (const [name, value] of checkedStyles.get(key)) element.style.setProperty(name, value);
      }
      if (tag === 'code' && element.style.display === 'block') element.setAttribute('data-replypress-code-block', '');
      if (tag === 'div' && ['divider', 'code-card', 'code-header', 'diagram'].includes(node.layout)) {
        element.dataset.replypressLayout = node.layout;
        if (node.layout === 'code-header' && Number.isFinite(node.headerHeight)
            && node.headerHeight > 0 && node.headerHeight <= 4096) {
          element.style.minBlockSize = node.headerHeight + 'px';
        }
      }
      if (tag === 'a' && attrs.href) {
        element.target = '_blank';
        element.rel = 'noopener noreferrer';
      }
      for (const child of node.children) append(element, child, depth + 1, ns);
      parent.append(element);
    }

    for (const block of blocks) append(fragment, block, 0, null);
    return fragment;
  }

  return Object.freeze({
    mathNamespace, svgNamespace, htmlTags, mathTags, svgTags, limits, messages, snapshotVersion, reloadError, sizeError,
    safeAttributes, safeSvgAttributes, safeStyle,
    imageTypes, isImageData, isSvgImageData, isInlineImageSource, imageNote, validSnapshot, render
  });
})();
