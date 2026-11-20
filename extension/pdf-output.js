globalThis.ReplyPressPdf = (() => {
  'use strict';

  const invalidPdf = '无法校验生成的 PDF 结构，请重试。';
  const decoder = new TextDecoder('windows-1252');
  const encoder = new TextEncoder();

  function field(object, name) {
    const match = new RegExp('^(<<)?(/' + name + '[ \t]+([^\r\n>]+))', 'm').exec(object.text);
    if (!match) return null;
    return {
      offset: object.offset + match.index + (match[1]?.length || 0),
      length: match[2].length,
      value: match[3].trim()
    };
  }

  function reference(object, name) {
    const value = field(object, name);
    if (!value) return null;
    const match = /^([1-9]\d*) 0 R$/.exec(value.value);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw Error(invalidPdf);
    return Number(match[1]);
  }

  function count(object) {
    const value = field(object, 'Count')?.value;
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error(invalidPdf);
    return Number(value);
  }

  function readPdf(text) {
    // Chromium 的 Skia 输出使用一段从对象 0 开始的交叉引用表。
    const end = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
    if (!end) throw Error(invalidPdf);
    const xref = Number(end[1]);
    const lines = text.slice(xref).split(/\r?\n/);
    const range = /^0 (\d+)$/.exec(lines[1]);
    const entries = Number(range?.[1]);
    if (lines[0] !== 'xref' || !range || lines[entries + 2] !== 'trailer') throw Error(invalidPdf);

    function readObject(id) {
      if (!id || id >= entries) throw Error(invalidPdf);
      const row = /^(\d{10}) 00000 n[ \t]*$/.exec(lines[id + 2]);
      if (!row) throw Error(invalidPdf);
      const offset = Number(row[1]);
      const end = text.indexOf('\nendobj', offset);
      const body = text.slice(offset, end);
      if (end <= offset || end >= xref || body.split(/\r?\n/, 1)[0] !== id + ' 0 obj') throw Error(invalidPdf);
      return { id, offset, text: body };
    }

    const trailer = { offset: 0, text: lines.slice(entries + 3).join('\n') };
    const catalog = readObject(reference(trailer, 'Root'));
    return { catalog, readObject };
  }

  function childRange(object) {
    const first = reference(object, 'First');
    const last = reference(object, 'Last');
    if ((first === null) !== (last === null)) throw Error(invalidPdf);
    return { first, last };
  }

  function writeField(bytes, object, name, value = '') {
    const target = field(object, name);
    const replacement = encoder.encode(value);
    if (!target || replacement.length > target.length) throw Error(invalidPdf);
    // 用空格补齐字段长度，交叉引用中的字节偏移仍然有效。
    bytes.fill(0x20, target.offset, target.offset + target.length);
    bytes.set(replacement, target.offset);
  }

  function trimOutline(bytes, outline, readObject) {
    const visited = new Set([outline.id]);

    function children(parent) {
      const { first, last } = childRange(parent);
      const items = [];
      for (let id = first; id !== null;) {
        if (visited.has(id)) throw Error(invalidPdf);
        visited.add(id);
        const item = readObject(id);
        if (reference(item, 'Parent') !== parent.id) throw Error(invalidPdf);
        items.push(item);
        const next = reference(item, 'Next');
        if ((next === null) !== (id === last)) throw Error(invalidPdf);
        id = next;
      }
      return items;
    }

    const chapters = children(outline);
    let visibleCount = chapters.length;
    let trimmed = false;
    for (const chapter of chapters) {
      const sections = children(chapter);
      if (!sections.length) continue;
      const open = count(chapter) > 0;
      if (open) visibleCount += sections.length;
      let trimmedChapter = false;
      for (const section of sections) {
        if (childRange(section).first === null) continue;
        writeField(bytes, section, 'First');
        writeField(bytes, section, 'Last');
        writeField(bytes, section, 'Count');
        trimmedChapter = true;
      }
      if (trimmedChapter) {
        writeField(bytes, chapter, 'Count', '/Count ' + (open ? sections.length : -sections.length));
        trimmed = true;
      }
    }
    if (trimmed) writeField(bytes, outline, 'Count', '/Count ' + visibleCount);
    return trimmed;
  }

  async function singlePage(pdf) {
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    // 单字节解码保留字符位置和 PDF 字节偏移的一一对应。
    const { catalog, readObject } = readPdf(decoder.decode(bytes));
    const pages = count(readObject(reference(catalog, 'Pages')));
    if (pages < 1) throw Error(invalidPdf);
    if (pages > 1) return null;

    const outline = reference(catalog, 'Outlines');
    if (outline === null || !trimOutline(bytes, readObject(outline), readObject)) return pdf;
    return new Blob([bytes], { type: 'application/pdf' });
  }

  return Object.freeze({ singlePage });
})();
