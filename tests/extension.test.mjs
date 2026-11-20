import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fixtureUrl, linkedUrl, routeFixture } from './fixtures/chat.mjs';

const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const control = '[data-replypress-control] button';
let profile;
let context;

before(async () => {
  profile = await mkdtemp(join(tmpdir(), 'replypress-test-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
  });
  context.setDefaultTimeout(8000);
  await context.addInitScript(() => {
    if (location.protocol === 'chrome-extension:') {
      window.testPrintCalls = 0;
      window.print = () => { window.testPrintCalls += 1; };
    }
  });
  await routeFixture(context);
});

after(async () => {
  try {
    await context?.close();
  } finally {
    if (profile && dirname(resolve(profile)) === resolve(tmpdir()) && basename(profile).startsWith('replypress-test-')) {
      await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    }
  }
});

async function openChat() {
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  await page.locator('#second ' + control).waitFor();
  return page;
}

async function openPrint(button) {
  const [page] = await Promise.all([context.waitForEvent('page'), button.click()]);
  await page.locator('#save-button:enabled').waitFor();
  return page;
}

async function savePdf(page, filename) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '保存 PDF', exact: true }).click()
  ]);
  assert.equal(download.suggestedFilename(), filename);
  return getDocument({ data: new Uint8Array(await readFile(await download.path())), verbosity: 0 });
}

function outlineTitles(entries) {
  return (entries ?? []).map(({ title, items }) => [title, outlineTitles(items)]);
}

test('保存所选回答为单页 PDF，保留两层书签、完整正文和链接', { timeout: 45000 }, async () => {
  const chat = await openChat();
  let print;
  try {
    assert.equal(await chat.locator(control).count(), 2);
    await chat.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth));
    print = await openPrint(chat.locator('#second ' + control));
    const answer = print.locator('#answer');
    assert.equal(await print.title(), 'ChatGPT 回答 - 第二条回答 PDF 验证');
    assert.match(await answer.innerText(), /中文正文可搜索/);
    assert.ok((await answer.locator('.image-note').allTextContents()).includes('［图片不可用：跨域图像］'));
    assert.doesNotMatch(await answer.textContent(), /EARLIER_REPLY|USER_QUESTION|INACTIVE_CHAT|PRIVATE_REASONING|COLLAPSED_CONTENT|HIDDEN_CONTENT|COPY_CODE_TOOLBAR|PAGE_ACTION_BAR|FORMULA_SOURCE|FORMULA_DUPLICATE/);
    assert.equal(await answer.locator('math msup').count(), 1);
    assert.equal(await answer.locator('img[src^="data:image/svg+xml;base64,"]').count(), 2);
    assert.equal(await answer.locator('ol').getAttribute('start'), '3');
    assert.equal(await answer.locator('a[href]').count(), 1);
    assert.equal(await answer.locator('a[href]').getAttribute('href'), linkedUrl);
    assert.equal(await answer.locator('pre code').textContent(), '  CODE_START\n' + 'x'.repeat(2100) + '\n  CODE_WRAP_END');

    assert.equal(await print.evaluate(() => window.testPrintCalls), 0);
    const loading = await savePdf(print, '第二条回答 PDF 验证.pdf');
    try {
      const pdf = await loading.promise;
      assert.equal(pdf.numPages, 1);
      const outline = await pdf.getOutline();
      assert.deepEqual(outlineTitles(outline), [
        ['第二条回答 / PDF 验证?', [
          ['重复标题', []],
          ['重复标题', []]
        ]],
        ['补充章节', [['补充小节', []]]]
      ]);
      const repeated = outline[0].items;
      const topPositions = await Promise.all(repeated.map(async ({ dest }) => {
        const location = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
        assert.equal(await pdf.getPageIndex(location[0]), 0);
        return location[3];
      }));
      assert.ok(topPositions[0] > topPositions[1], '同名书签应跳到长页中的不同位置');
      const page = await pdf.getPage(1);
      assert.ok(Math.abs(page.view[2] - 595.28) < 2);
      assert.ok(page.view[3] > 841.89 * 3, '长页应保持字号，并随正文自然增高');
      const content = await page.getTextContent();
      const repeatedHeadings = content.items.filter(item => item.str === '重复标题');
      assert.equal(repeatedHeadings.length, 2);
      for (const [index, title] of repeatedHeadings.entries()) {
        assert.ok(Math.abs(topPositions[index] - title.transform[5]) < 24, '书签应跳到对应标题');
      }
      assert.ok(!content.items.some(item => /^\d+(?:\s*\/\s*\d+)?$/.test(item.str?.trim())
        && item.transform[5] < 45 && Math.abs(item.transform[4] + item.width / 2 - page.view[2] / 2) < 5),
      '页面底部不应有页号');
      const text = content.items.map(item => item.str || '').join('');
      const links = (await page.getAnnotations()).map(item => item.url);
      assert.match(text, /中文正文可搜索/);
      assert.match(text, /包含\s*Make\s*的小节/);
      assert.match(text, /深层标题/);
      assert.match(text, /补充小节的正文标题/);
      const tags = JSON.stringify(await page.getStructTree());
      assert.match(tags, /"role":"H5"/);
      assert.match(tags, /"role":"H6"/);
      assert.equal((text.match(/SVG_SOURCE/g) || []).length, 2, 'SVG 链接中的文字应为 PDF 矢量文字');
      assert.match(text, /CODE_WRAP_END/);
      assert.ok((text.match(/x/g) || []).length >= 2100, '长代码应该完整保留');
      assert.equal((text.match(/CARD_LINE_\d+/g) || []).length, 110, '代码卡片应保留全部行');
      assert.match(text, /CARD_END/);
      assert.match(text, /TABLE_ROW_88/);
      assert.equal((text.match(/TABLE_HEADER/g) || []).length, 1);
      assert.match(text, /末尾的正文段落/);
      assert.doesNotMatch(text, /EARLIER_REPLY|USER_QUESTION|INACTIVE_CHAT|PRIVATE_REASONING|复制代码卡片|预览已就绪/);
      assert.ok(links.includes(linkedUrl), '网页链接应保留在 PDF 中');
    } finally {
      await loading.destroy();
    }

    await print.locator('#print-button').click();
    await print.waitForFunction(() => window.testPrintCalls === 1);
    const printSize = await print.evaluate(() => document.getElementById('print-styles').sheet.cssRules[0].style.getPropertyValue('size'));
    assert.match(printSize, /a4/i);
    await print.reload();
    await print.waitForFunction(() => document.querySelector('#print-status').textContent.includes('本次打印内容已失效'));
    assert.equal(await print.locator('#answer').isVisible(), false);
  } finally {
    await print?.close();
    await chat.close();
  }
});

test('导出表格里带点状下划线的术语，保留可搜索的单元格文字', { timeout: 30000 }, async () => {
  const chat = await openChat();
  let print;
  try {
    await chat.locator('#second .markdown').evaluate(body => {
      document.querySelector('#second figure').remove();
      body.style.cssText = 'max-width: 768px; margin: auto; background-color: #f9f9f9';
      body.innerHTML = `
        <h2>四、主流图形 API 的区别</h2>
        <table style="width:100%; border-collapse:collapse">
          <thead><tr><th>API</th><th>主要平台</th><th>编程模型</th><th>特点</th></tr></thead>
          <tbody>
            <tr><td><button type="button" class="term">OpenGL<span role="tooltip">术语浮层</span></button></td>
              <td>桌面跨平台</td><td>隐式状态管理为主</td><td>学习容易，成熟</td></tr>
            <tr><td><span role="button" class="term">Vulkan</span></td>
              <td>Windows、Linux、Android 等</td><td>显式资源、命令和同步管理</td><td>控制细，工程复杂</td></tr>
            <tr><td>Direct3D 11</td><td>Windows</td><td>较高层的设备上下文模型</td><td>成熟，Windows 生态</td></tr>
            <tr><td>Direct3D 12</td><td>Windows、Xbox</td><td>显式命令列表和资源管理</td><td>低层控制能力强</td></tr>
            <tr><td><button type="button" class="term"><span>Metal</span></button></td>
              <td>macOS、iOS 等</td><td>现代命令编码模型</td><td>Apple 平台原生</td></tr>
            <tr><td><span role="button" style="border-bottom:1px dotted">WebGL</span></td>
              <td>浏览器</td><td>基于 OpenGL ES 的模型</td><td>Web 兼容性成熟</td></tr>
            <tr><td><span role="button"><span class="term">WebGPU</span></span></td>
              <td>浏览器及部分原生实现</td><td>现代资源、Pipeline、命令编码模型</td><td>支持渲染与通用计算<button>复制表格</button></td></tr>
          </tbody>
        </table>
        <div role="toolbar"><button class="term">回答工具栏</button></div>`;
      const style = document.createElement('style');
      style.textContent = '.term { all: unset; text-decoration: underline dotted; }' +
        '#second :is(th, td) { text-align: start; padding: 10px; border-bottom: 1px solid #e7e7e7; }';
      document.head.append(style);
    });

    const names = ['OpenGL', 'Vulkan', 'Direct3D 11', 'Direct3D 12', 'Metal', 'WebGL', 'WebGPU'];
    print = await openPrint(chat.locator('#second ' + control));
    const answer = print.locator('#answer');
    const terms = answer.locator('tbody td:first-child');
    assert.deepEqual(await terms.allTextContents(), names);
    assert.equal(await terms.first().locator('span').evaluate(term => getComputedStyle(term).textDecorationStyle), 'dotted');
    assert.equal(await answer.locator('button,[role="button"]').count(), 0);
    assert.doesNotMatch(await answer.textContent(), /术语浮层|复制表格|回答工具栏/);

    const loading = await savePdf(print, '四、主流图形 API 的区别.pdf');
    try {
      const pdf = await loading.promise;
      assert.equal(pdf.numPages, 1);
      const page = await pdf.getPage(1);
      const text = await page.getTextContent();
      const apiColumn = text.items.filter(item => item.str && names.includes(item.str.trim()));
      assert.deepEqual(apiColumn.map(item => item.str.trim()), names);
      assert.ok(apiColumn.every(item => Math.abs(item.transform[4] - apiColumn[0].transform[4]) < 1),
        '七个名称应在 PDF 的同一列');
    } finally {
      await loading.destroy();
    }
  } finally {
    await print?.close();
    await chat.close();
  }
});

test('保留内嵌 SVG 的矢量和比例，打印高度溢出时重新排成一页', { timeout: 45000 }, async () => {
  const chat = await openChat();
  let print;
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 340 204">' +
      '<rect x="20" y="20" width="300" height="164" rx="12" fill="#dbeafe"/>' +
      '<text x="170" y="108" text-anchor="middle" font-size="18">VECTOR_NODE</text></svg>';
    const source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await chat.evaluate(svgSource => {
      const body = document.querySelector('#second .markdown');
      document.querySelector('#second figure').remove();
      body.style.maxWidth = '768px';
      const paragraphs = Array.from({ length: 900 }, (_, index) =>
        '<p style="margin:0; line-height:28px">连续段落 ' + (index + 1) + '</p>').join('');
      body.innerHTML = '<h2>长页验证</h2>' + paragraphs +
        '<div data-d-component="box" style="display:flex;flex-direction:column;gap:8px;' +
        'border:1px solid #ddd;border-radius:12px;padding:12px">' +
        '<p style="margin:0">图表标题</p><img data-d-component="svg" alt="结构图" ' +
        'style="display:block;width:100%;flex-shrink:0" src="' + svgSource + '">' +
        '<div>图例说明</div></div><p>整条回答到此结束</p>';
    }, source);
    await chat.locator('img[data-d-component="svg"]').evaluate(image => image.decode());
    print = await openPrint(chat.locator('#second ' + control));
    const picture = print.locator('[data-replypress-layout="diagram"] img');
    assert.equal(await picture.getAttribute('src'), source);
    const ratio = await picture.evaluate(image => image.offsetWidth / image.offsetHeight);
    assert.ok(Math.abs(ratio - 340 / 204) < 0.01, '图形应按原比例缩放');

    // 复现打印布局比预览测量更高的情况，确保多出来的内容不被截掉。
    await print.evaluate(() => {
      const sheet = document.getElementById('print-styles').sheet;
      const inset = getComputedStyle(document.getElementById('answer')).paddingBlockStart;
      sheet.insertRule('@media print { #answer { padding-block-start: calc(' + inset + ' + 72px); } }', sheet.cssRules.length);
    });
    const loading = await savePdf(print, '长页验证.pdf');
    try {
      const pdf = await loading.promise;
      assert.equal(pdf.numPages, 1);
      const page = await pdf.getPage(1);
      assert.ok(page.view[3] > 18000);
      const text = (await page.getTextContent()).items.map(item => item.str || '').join('');
      assert.equal((text.match(/连续段落/g) || []).length, 900);
      assert.match(text, /图表标题.*VECTOR_NODE.*图例说明.*整条回答到此结束/);
      const { fnArray } = await page.getOperatorList();
      assert.ok(!fnArray.some(op => op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject),
        '矢量图应保留为 PDF 图元');
    } finally {
      await loading.destroy();
    }
  } finally {
    await print?.close();
    await chat.close();
  }
});

test('临时图源和允许跨域读取的 SVG 地址保持矢量，PNG 保留原数据', { timeout: 30000 }, async () => {
  const chat = await openChat();
  const vectorUrl = 'https://media.example.test/replypress-vector';
  let print;
  try {
    await chat.route(vectorUrl, route => route.fulfill({
      contentType: 'image/svg+xml; charset=utf-8',
      headers: { 'Access-Control-Allow-Origin': 'https://chatgpt.com' },
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="40"><text x="5" y="24">SVG_FROM_URL</text></svg>'
    }));
    const { blobUrl, png } = await chat.evaluate(url => {
      const body = document.querySelector('#second .markdown');
      document.querySelector('#second figure').remove();
      const graphic = new Blob([
        '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="40"><text x="5" y="24">SVG_FROM_TEMP</text></svg>'
      ], { type: 'image/svg+xml' });
      const blobUrl = URL.createObjectURL(graphic);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 20;
      const context = canvas.getContext('2d');
      context.fillStyle = '#17665a';
      context.fillRect(0, 0, 20, 20);
      const png = canvas.toDataURL('image/png');
      body.innerHTML = '<h2>图源验证</h2><h3>图像结果</h3><p><img alt="临时 SVG"></p><p><img alt="跨域 SVG" crossorigin="anonymous"></p>' +
        '<p><img alt="原始 PNG"></p>';
      const images = body.querySelectorAll('img');
      images[0].src = blobUrl;
      images[1].src = url;
      images[2].src = png;
      return { blobUrl, png };
    }, vectorUrl);
    await chat.locator('#second .markdown img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    print = await openPrint(chat.locator('#second ' + control));
    await chat.evaluate(url => URL.revokeObjectURL(url), blobUrl);
    assert.match(await print.getByRole('img', { name: '临时 SVG' }).getAttribute('src'), /^data:image\/svg\+xml;base64,/);
    assert.match(await print.getByRole('img', { name: '跨域 SVG' }).getAttribute('src'), /^data:image\/svg\+xml;charset=utf-8;base64,/);
    assert.equal(await print.getByRole('img', { name: '原始 PNG' }).getAttribute('src'), png);

    const loading = await savePdf(print, '图源验证.pdf');
    try {
      const pdf = await loading.promise;
      assert.equal(pdf.numPages, 1);
      assert.deepEqual(outlineTitles(await pdf.getOutline()), [['图源验证', [['图像结果', []]]]]);
      const page = await pdf.getPage(1);
      const text = (await page.getTextContent()).items.map(item => item.str || '').join('');
      assert.match(text, /SVG_FROM_TEMP.*SVG_FROM_URL/);
      const { fnArray } = await page.getOperatorList();
      assert.equal(fnArray.filter(op => op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject).length, 1);
    } finally {
      await loading.destroy();
    }
  } finally {
    await print?.close();
    await chat.close();
  }
});

test('已加载的 ChatGPT 搜图配图写入 PDF，预览加载失败时保留替代文字', { timeout: 30000 }, async () => {
  const chat = await openChat();
  const cdn = 'https://images.openai.com/static-rsc-4/replypress-';
  const inline = cdn + 'inline?purpose=inline';
  const unavailable = cdn + 'unavailable?purpose=inline';
  const thumbnail = cdn + 'thumbnail?purpose=thumbnail';
  const matchesImage = url => url.href.startsWith(cdn);
  const previewRequests = [];
  let print;
  try {
    const png = Buffer.from(await chat.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 48;
      canvas.height = 32;
      const drawing = canvas.getContext('2d');
      drawing.fillStyle = '#17665a';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    await context.route(matchesImage, route => {
      const request = route.request();
      if (request.resourceType() === 'image' && request.frame().url().startsWith('chrome-extension:')) {
        previewRequests.push({ url: request.url(), referer: request.headers().referer });
        if (request.url() === unavailable) return route.abort();
      }
      return route.fulfill({
        contentType: 'image/png',
        headers: { 'Access-Control-Allow-Origin': 'https://unrelated.example.test' },
        body: png
      });
    });
    await chat.evaluate(images => {
      document.querySelector('#second figure').remove();
      const body = document.querySelector('#second .markdown');
      body.innerHTML = '<h2>搜图配图验证</h2>';
      for (const [src, alt] of images) {
        const image = document.createElement('img');
        image.src = src;
        image.alt = alt;
        body.append(image);
      }
    }, [[inline, '已加载的搜图配图'], [unavailable, '预览无法加载的配图'], [thumbnail, '其他 CDN 地址']]);
    await chat.locator('#second .markdown img').evaluateAll(images => Promise.all(images.map(image => image.decode())));

    print = await openPrint(chat.locator('#second ' + control));
    const image = print.getByRole('img', { name: '已加载的搜图配图' });
    assert.equal(await image.getAttribute('src'), inline);
    assert.equal(await image.evaluate(element => element.naturalWidth), 48);
    assert.deepEqual(await print.locator('#answer .image-note').allTextContents(), [
      '［图片不可用：预览无法加载的配图］', '［图片不可用：其他 CDN 地址］'
    ]);
    assert.deepEqual(previewRequests.map(request => request.url).sort(), [inline, unavailable].sort());
    assert.ok(previewRequests.every(request => request.referer === undefined));

    const loading = await savePdf(print, '搜图配图验证.pdf');
    try {
      const page = await (await loading.promise).getPage(1);
      const { fnArray } = await page.getOperatorList();
      assert.equal(fnArray.filter(op => op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject).length, 1);
    } finally {
      await loading.destroy();
    }
  } finally {
    await print?.close();
    await chat.close();
    await context.unroute(matchesImage);
  }
});

test('短回答保留页首和页尾留白，无标题时大纲为空', { timeout: 30000 }, async () => {
  const chat = await openChat();
  let print;
  try {
    print = await openPrint(chat.locator('#first ' + control));
    const loading = await savePdf(print, 'EARLIER_REPLY 第一条回答.pdf');
    try {
      const pdf = await loading.promise;
      assert.equal(pdf.numPages, 1);
      assert.equal((await pdf.getOutline())?.length ?? 0, 0);
      const page = await pdf.getPage(1);
      assert.ok(page.view[3] < 150, '短回答的 PDF 高度也应随内容收缩');
      const text = await page.getTextContent();
      const paragraph = text.items.find(item => item.str?.includes('EARLIER_REPLY'));
      assert.ok(paragraph, '短回答的正文应保留');
      const baseline = paragraph.transform[5];
      const pointsPerMm = 72 / 25.4;
      assert.ok(page.view[3] - baseline - paragraph.height >= 16 * pointsPerMm - 2, '首行前应保留页首留白');
      assert.ok(baseline >= 17 * pointsPerMm, '末行后应保留页尾留白');
    } finally {
      await loading.destroy();
    }
  } finally {
    await print?.close();
    await chat.close();
  }
});

test('流式生成、重新挂载和会话切换保持正确的按钮状态', { timeout: 30000 }, async () => {
  const chat = await openChat();
  let print;
  try {
    await chat.evaluate(() => {
      document.querySelector('#second [data-replypress-control]').remove();
      document.querySelector('#chat').insertAdjacentHTML('beforeend',
        '<article id="streamed" data-turn="assistant" data-talvt-turn-state="in_progress"><div data-message-author-role="tool"><p class="markdown">工具输出</p></div><div class="markdown">正在生成的回答</div></article>');
    });
    const streamed = chat.locator('#streamed ' + control);
    await streamed.waitFor();
    assert.equal(await streamed.isDisabled(), true);
    assert.equal(await chat.locator('#first ' + control).isEnabled(), true);
    assert.equal(await chat.locator('#second ' + control).count(), 1);

    await chat.locator('#streamed').evaluate(node => {
      node.querySelector(':scope > .markdown').textContent = '生成完成的回答';
      node.setAttribute('data-talvt-turn-state', 'complete');
    });
    await chat.waitForFunction(selector => !document.querySelector('#streamed ' + selector)?.disabled, control);
    assert.equal(await streamed.isEnabled(), true);
    print = await openPrint(streamed);
    assert.equal((await print.locator('#answer').innerText()).trim(), '生成完成的回答');
    await print.close();
    print = null;

    await chat.evaluate(() => {
      document.querySelector('#chat').style.display = 'none';
      document.querySelector('#previous-chat').style.display = 'block';
      history.pushState(null, '', '/c/another-replypress-fixture');
    });
    const active = chat.locator('#previous-chat ' + control);
    await active.waitFor();
    assert.equal(await chat.locator(control).count(), 1);
    print = await openPrint(active);
    assert.equal((await print.locator('#answer').innerText()).trim(), 'INACTIVE_CHAT 上一个会话');
  } finally {
    await print?.close();
    await chat.close();
  }
});

test('新版 ChatGPT 网页按回答区域识别按钮和打印范围', { timeout: 30000 }, async () => {
  const chat = await openChat();
  let print;
  try {
    await chat.evaluate(() => {
      document.body.innerHTML =
        '<div data-thread-find-target="conversation"><div data-talvt-turn-state="complete">' +
        '<div data-chatgpt-search-unit-key="first:0:user">用户问题</div>' +
        '<div data-chatgpt-search-unit-key="first:1:assistant"><h4>ChatGPT 说：</h4>' +
        '<div data-response-body="first"><div data-markdown-text-style="assistant-message">' +
        '<h1>第一条回答</h1></div></div></div></div>' +
        '<div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="second:0:user">下一条提问</div>' +
        '<div id="new-answer" data-chatgpt-search-unit-key="second:2:assistant"><h4>ChatGPT 说：</h4>' +
        '<span>思考摘要</span><div data-response-body="second"><div data-markdown-text-style="assistant-message">' +
        '<h1>第二条回答</h1><p>选中的正文</p></div></div></div></div></div>';
    });
    const button = chat.locator('#new-answer ' + control);
    await button.waitFor();
    assert.equal(await chat.locator(control).count(), 2);
    print = await openPrint(button);
    assert.equal((await print.locator('#answer').innerText()).replace(/\s+/g, ' ').trim(), '第二条回答 选中的正文');
  } finally {
    await print?.close();
    await chat.close();
  }
});

test('打印页保留网页排版、可复制的高亮代码和静态 SVG', { timeout: 30000 }, async () => {
  const chat = await openChat();
  let print;
  try {
    await chat.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = [
        'body { background: #202124; color: #f1f3f4; }',
        '#second .markdown { max-width: 640px; margin: 0 auto; }',
        '#second h2 { font-size: 21px; margin-bottom: 14px; }',
        '#second th { border-bottom: 2px solid #8b9299; padding: 8px; }',
        '.table-frame { display: flex; flex-direction: column; margin-inline: -400px; }',
        '.table-viewport { overflow-x: auto; padding-left: 400px; }',
        '.table-viewport table { width: 640px; }',
        '#second pre { background-color: #303134; font-size: 13px; padding: 12px; }',
        '.code-line { display: block; } .keyword { color: #f4b4d0; }',
        '.sample-edge { stroke: #85afeb; stroke-width: 3px; fill: none; marker-end: url(#sample-tip); }'
      ].join('\n');
      document.head.append(style);
      const body = document.querySelector('#second .markdown');
      const table = body.querySelector('table');
      const frame = document.createElement('div');
      frame.className = 'table-frame';
      const viewport = document.createElement('div');
      viewport.className = 'table-viewport';
      table.replaceWith(frame);
      frame.append(viewport);
      viewport.append(table);
      body.querySelector('pre').innerHTML = '<code><span class="code-line"><span class="keyword">let</span> first = 1;</span><span class="code-line">  let second = 2;</span></code>';
      body.insertAdjacentHTML('beforeend',
        '<code style="display:block;white-space:pre">第一行\n  第二行</code>' +
        '<div data-chatgpt-mermaid-preview><div data-mermaid-render-status="rendering">正在绘图</div></div>');
      const graphic =
        '<svg role="img" aria-label="流程图" width="180" height="65" viewBox="0 0 180 65">' +
        '<defs><marker id="sample-tip" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">' +
        '<path d="M 0 0 L 8 4 L 0 8 Z" fill="#85afeb"></path></marker></defs>' +
        '<path class="sample-edge" d="M 10 20 L 155 20"></path><text x="10" y="50" fill="#f1f3f4">节点标签</text>' +
        '<use href="https://example.invalid/chart#outside"></use></svg>';
      document.addEventListener('click', () => {
        setTimeout(() => {
          const renderer = body.querySelector('[data-mermaid-render-status]');
          renderer.innerHTML = graphic;
          renderer.dataset.mermaidRenderStatus = 'ready';
        }, 250);
      }, { capture: true, once: true });
    });
    print = await openPrint(chat.locator('#second ' + control));
    const observed = await print.locator('#answer').evaluate(answer => {
      const css = (selector, prop) => getComputedStyle(answer.querySelector(selector)).getPropertyValue(prop);
      return {
        paper: getComputedStyle(answer).backgroundColor,
        headingSize: css('h2', 'font-size'),
        headingMargin: css('h2', 'margin-bottom'),
        cellBorder: css('th', 'border-bottom-width'),
        tableFits: answer.querySelector('table').getBoundingClientRect().width >= answer.firstElementChild.getBoundingClientRect().width - 1,
        codeBackground: css('pre', 'background-color'),
        tokenColor: css('pre code span span', 'color'),
        code: answer.querySelector('pre code').innerText,
        standaloneCode: css('[data-replypress-code-block]', 'white-space'),
        dividerHeight: css('[data-replypress-layout="divider"]', 'height'),
        dividerPadding: css('[data-replypress-layout="divider"]', 'padding-top'),
        dividerClip: css('[data-replypress-layout="divider"]', 'background-clip'),
        cardRadius: css('[data-replypress-layout="code-card"]', 'border-radius'),
        cardClip: css('[data-replypress-layout="code-card"]', 'overflow'),
        cardHeaderHeight: css('[data-replypress-layout="code-header"]', 'height'),
        cardHeaderBackground: css('[data-replypress-layout="code-header"]', 'background-color'),
        cardTokenColor: css('[data-replypress-layout="code-card"] code span', 'color'),
        chartStroke: css('svg > path', 'stroke'),
        marker: css('svg > path', 'marker-end'),
        svgLabel: answer.querySelector('svg text').textContent,
        foreignReference: answer.querySelector('svg use').getAttribute('href')
      };
    });
    assert.deepEqual(observed, {
      paper: 'rgb(32, 33, 36)',
      headingSize: '21px',
      headingMargin: '14px',
      cellBorder: '2px',
      tableFits: true,
      codeBackground: 'rgb(48, 49, 52)',
      tokenColor: 'rgb(244, 180, 208)',
      code: 'let first = 1;\n  let second = 2;',
      standaloneCode: 'pre-wrap',
      dividerHeight: '1px',
      dividerPadding: '8px',
      dividerClip: 'content-box',
      cardRadius: '24px',
      cardClip: 'clip',
      cardHeaderHeight: '48px',
      cardHeaderBackground: 'rgb(238, 238, 238)',
      cardTokenColor: 'rgb(114, 56, 176)',
      chartStroke: 'rgb(133, 175, 235)',
      marker: 'url("#sample-tip")',
      svgLabel: '节点标签',
      foreignReference: null
    });
  } finally {
    await print?.close();
    await chat.close();
  }
});
