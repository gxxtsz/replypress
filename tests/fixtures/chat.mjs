export const fixtureUrl = 'https://chatgpt.com/c/replypress-fixture';
export const linkedUrl = 'https://chatgpt.com/help?from=replypress';
export const imageUrl = 'https://chatgpt.com/replypress-fixture-image.svg';
export const otherImageUrl = 'https://media.example.test/replypress-cross-origin.svg';
export const imageSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48"><rect width="120" height="48" rx="8" fill="#17665a"/><text x="10" y="28" font-size="12" fill="white">SVG_SOURCE</text></svg>';

export function chatFixture() {
  const rows = Array.from({ length: 88 }, (_, index) => (
    '<tr><td>项目 ' + (index + 1) + '</td><td>TABLE_ROW_' + (index + 1) + '</td></tr>'
  )).join('');
  const lines = Array.from({ length: 110 }, (_, index) => 'CARD_LINE_' + (index + 1)).join('\n');
  return [
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ReplyPress 测试会话</title>',
    '<style>',
    '[data-d-component="divider"] { height: 1px; padding-block: 8px; margin-block: 16px; background: #ccc; background-clip: content-box; }',
    '[data-code-block] { overflow: clip; border: 1px solid #ddd; border-radius: 24px; background: #f3f3f3; }',
    '[data-markdown-copy] { display: flex; align-items: center; padding-inline: 12px; background: #eee; }',
    '[data-markdown-copy] button { height: 48px; }',
    '[data-code-block-source] { padding: 12px; overflow-x: auto; }',
    '[data-code-block-source] code { display: block; white-space: pre; }',
    '</style>',
    '<main id="chat">',
    '<article data-turn="user"><div data-message-author-role="user"><p>USER_QUESTION</p></div></article>',
    '<article id="first" data-turn="assistant" data-talvt-turn-state="complete">',
    '<div data-message-author-role="assistant"><div class="markdown"><p>EARLIER_REPLY 第一条回答</p></div></div>',
    '</article>',
    '<article id="second" data-turn="assistant" data-talvt-turn-state="complete">',
    '<div data-message-author-role="assistant"><div data-testid="assistant-message-content">',
    '<div class="markdown">',
    '<h2>第二条回答 / PDF 验证?</h2>',
    '<p>中文正文可搜索。<strong>保留格式</strong>，<a href="/help?from=replypress">可点击链接</a>。</p>',
    '<p><a href="javascript:void(0)">无效链接保留文字</a></p>',
    '<ol start="3"><li>编号列表</li></ol>',
    '<blockquote><p>这是一段引用。</p></blockquote>',
    '<div data-d-component="divider"></div><h4>重复标题</h4><h5>包含 <code>Make</code> 的小节</h5><h6>深层标题</h6>',
    '<div data-testid="thinking-details"><p>PRIVATE_REASONING</p></div>',
    '<div hidden>HIDDEN_CONTENT</div>',
    '<details><summary>折叠区域</summary><p>COLLAPSED_CONTENT</p></details>',
    '<pre><div role="toolbar">COPY_CODE_TOOLBAR<button>复制</button></div><code>  CODE_START\n',
    'x'.repeat(2100), '\n  CODE_WRAP_END</code></pre>',
    '<p><span class="katex-display"><span class="katex"><span class="katex-mathml">',
    '<math><semantics><msup><mi>x</mi><mn>2</mn></msup>',
    '<annotation encoding="application/x-tex">FORMULA_SOURCE</annotation></semantics></math>',
    '</span><span class="katex-html" aria-hidden="true">FORMULA_DUPLICATE</span></span></span></p>',
    '<p><img src="', imageUrl, '" alt="本地可打印图像"></p>',
    '<p><img src="', otherImageUrl, '" alt="跨域图像"></p>',
    '<div data-code-block><div data-markdown-copy>Bash<button>复制代码卡片</button></div>',
    '<div data-code-block-source><code><span style="color:#7238b0">echo</span> START\n  ', lines,
    '\nCARD_END</code></div></div>',
    '<table><thead><tr><th scope="col">TABLE_HEADER</th><th>数据</th></tr></thead><tbody>',
    rows, '</tbody></table><h4>重复标题</h4><h2>补充章节</h2><h3>补充小节</h3>',
    '<h4>补充小节的正文标题</h4><p>末尾的正文段落。</p></div></div>',
    '<figure><img src="', imageUrl, '" alt="正文外的回答配图"><figcaption>回答配图</figcaption></figure>',
    '<button type="button">PAGE_ACTION_BAR</button></div></article></main>',
    '<main id="previous-chat" style="display:none">',
    '<article data-turn="assistant"><div class="markdown"><p>INACTIVE_CHAT 上一个会话</p></div></article>',
    '</main></html>'
  ].join('');
}

export async function routeFixture(context) {
  await context.route('https://chatgpt.com/**', route => {
    const image = route.request().url() === imageUrl;
    return route.fulfill({
      contentType: image ? 'image/svg+xml' : 'text/html; charset=utf-8',
      body: image ? imageSvg : chatFixture()
    });
  });
  await context.route(otherImageUrl, route => route.fulfill({
    contentType: 'image/svg+xml',
    headers: { 'Access-Control-Allow-Origin': 'https://unrelated.example.test' },
    body: imageSvg
  }));
}
