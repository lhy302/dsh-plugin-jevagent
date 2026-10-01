// splitter.js — Multi-language comment delimiters and BlockSplitter
// Conforms to JevAgent Engineering Spec Section 3

export class Block {
  constructor({ block_id, content = '', start_line = 0, end_line = 0, parent_id = null, free_before = '', category = null }) {
    this.block_id = block_id;
    this.content = content;
    this.start_line = start_line;
    this.end_line = end_line;
    this.parent_id = parent_id;
    this.free_before = free_before;
    if (category) {
      this.category = category;
    } else if (block_id === 'names') {
      this.category = 'declaration-only';
    } else if (block_id === 'imports') {
      this.category = 'hoisted';
    } else {
      this.category = 'emitting';
    }
  }

  toJSON() {
    return {
      block_id: this.block_id,
      category: this.category,
      content: this.content,
      start_line: this.start_line,
      end_line: this.end_line,
      parent_id: this.parent_id,
      free_before: this.free_before
    };
  }
}

export class BlockSplitter {
  static SYNTAX_MAP = {
    // # line comment
    python: { prefix: '#', is_block: false },
    py: { prefix: '#', is_block: false },
    shell: { prefix: '#', is_block: false },
    sh: { prefix: '#', is_block: false },
    bash: { prefix: '#', is_block: false },
    ruby: { prefix: '#', is_block: false },
    rb: { prefix: '#', is_block: false },
    perl: { prefix: '#', is_block: false },
    pl: { prefix: '#', is_block: false },
    yaml: { prefix: '#', is_block: false },
    yml: { prefix: '#', is_block: false },
    r: { prefix: '#', is_block: false },
    julia: { prefix: '#', is_block: false },
    nim: { prefix: '#', is_block: false },
    awk: { prefix: '#', is_block: false },
    tcl: { prefix: '#', is_block: false },
    elixir: { prefix: '#', is_block: false },

    // // line comment
    c: { prefix: '//', is_block: false },
    cpp: { prefix: '//', is_block: false },
    cxx: { prefix: '//', is_block: false },
    h: { prefix: '//', is_block: false },
    hpp: { prefix: '//', is_block: false },
    java: { prefix: '//', is_block: false },
    javascript: { prefix: '//', is_block: false },
    js: { prefix: '//', is_block: false },
    typescript: { prefix: '//', is_block: false },
    ts: { prefix: '//', is_block: false },
    go: { prefix: '//', is_block: false },
    golang: { prefix: '//', is_block: false },
    rust: { prefix: '//', is_block: false },
    rs: { prefix: '//', is_block: false },
    csharp: { prefix: '//', is_block: false },
    cs: { prefix: '//', is_block: false },
    kotlin: { prefix: '//', is_block: false },
    kt: { prefix: '//', is_block: false },
    swift: { prefix: '//', is_block: false },
    dart: { prefix: '//', is_block: false },
    scala: { prefix: '//', is_block: false },
    fsharp: { prefix: '//', is_block: false },

    // -- line comment
    sql: { prefix: '--', is_block: false },
    lua: { prefix: '--', is_block: false },
    haskell: { prefix: '--', is_block: false },
    hs: { prefix: '--', is_block: false },
    elm: { prefix: '--', is_block: false },

    // ; line comment
    lisp: { prefix: ';', is_block: false },
    clojure: { prefix: ';', is_block: false },
    scheme: { prefix: ';', is_block: false },
    asm: { prefix: ';', is_block: false },

    // <!-- ... --> block comment
    html: { prefix: '<!--', suffix: '-->', is_block: true },
    xml: { prefix: '<!--', suffix: '-->', is_block: true },
    svg: { prefix: '<!--', suffix: '-->', is_block: true },

    // /* ... */ block comment
    css: { prefix: '/*', suffix: '*/', is_block: true },

    // % line comment
    matlab: { prefix: '%', is_block: false },
    octave: { prefix: '%', is_block: false },
    erlang: { prefix: '%', is_block: false },
    prolog: { prefix: '%', is_block: false },

    // ' line comment
    vb: { prefix: "'", is_block: false },
    vbscript: { prefix: "'", is_block: false },

    // ! line comment
    fortran: { prefix: '!', is_block: false }
  };

  static getSyntax(lang = 'python') {
    const key = (lang || 'python').toLowerCase().trim();
    return this.SYNTAX_MAP[key] || { prefix: '#', is_block: false };
  }

  static formatMarker(blockId, action = 'begin', lang = 'python') {
    const syn = this.getSyntax(lang);
    if (syn.is_block) {
      return `${syn.prefix} @jev-block:${blockId}:${action} ${syn.suffix}`;
    }
    return `${syn.prefix} @jev-block:${blockId}:${action}`;
  }

  static validateBlockId(blockId) {
    if (!blockId || typeof blockId !== 'string') return false;
    return /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(blockId);
  }

  static split(text, lang = 'python', isHigh = false) {
    const lines = (text || '').split('\n');
    const blocks = [];
    const blockStack = [];
    const seenIds = new Set();
    let currentFree = [];
    const markerRegex = /(?:#|\/\/|--|;|%|'|!|<!--\s*|\/\*\s*)\s*@jev-block:([a-zA-Z0-9_.-]+):(begin|end)(?:\s*-->|\s*\*\/)?/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(markerRegex);
      if (match) {
        const blockId = match[1];
        const action = match[2];

        if (action === 'begin') {
          if (seenIds.has(blockId)) {
            throw new Error(`[duplicate_block_id] 块 ID 重复: ${blockId} (行号: ${i + 1})`);
          }
          seenIds.add(blockId);
          const parentId = blockStack.length > 0 ? blockStack[blockStack.length - 1].blockId : null;
          blockStack.push({
            blockId,
            startLine: i + 1,
            lines: [],
            parentId,
            freeBefore: currentFree.join('\n')
          });
          currentFree = [];
        } else if (action === 'end') {
          if (blockStack.length === 0) {
            throw new Error(`[malformed_block] 发现孤立的 @jev-block:${blockId}:end 标记，行号: ${i + 1}`);
          }
          const top = blockStack.pop();
          if (top.blockId !== blockId) {
            throw new Error(`[invalid_nesting] 块结束标记不匹配: 期望 '${top.blockId}'，实际发现 '${blockId}'，行号: ${i + 1}`);
          }
          blocks.push(new Block({
            block_id: top.blockId,
            content: top.lines.join('\n'),
            start_line: top.startLine,
            end_line: i + 1,
            parent_id: top.parentId,
            free_before: top.freeBefore
          }));
        }
      } else {
        if (blockStack.length > 0) {
          blockStack[blockStack.length - 1].lines.push(line);
        } else {
          currentFree.push(line);
        }
      }
    }

    if (blockStack.length > 0) {
      const unclosed = blockStack[blockStack.length - 1];
      throw new Error(`[malformed_block] 块 @jev-block:${unclosed.blockId} 缺少闭合 end 标记，起始行号: ${unclosed.startLine}`);
    }

    return {
      blocks,
      trailingFree: currentFree.join('\n')
    };
  }

  static assemble(blocks, trailingFree = '', lang = 'python', { skipDeclarationOnly = false } = {}) {
    let list = [...blocks];
    if (skipDeclarationOnly) {
      list = list.filter(b => b.category !== 'declaration-only');
    }
    // Hoist 'hoisted' blocks (e.g. imports) to the top if present
    const hoisted = list.filter(b => b.category === 'hoisted');
    const normal = list.filter(b => b.category !== 'hoisted');
    const ordered = [...hoisted, ...normal];

    const parts = [];
    for (const b of ordered) {
      if (b.free_before) {
        parts.push(b.free_before);
      }
      parts.push(this.formatMarker(b.block_id, 'begin', lang));
      if (b.content !== undefined && b.content !== null && b.content.length > 0) {
        parts.push(b.content);
      }
      parts.push(this.formatMarker(b.block_id, 'end', lang));
    }
    if (trailingFree) {
      parts.push(trailingFree);
    }
    return parts.join('\n') + '\n';
  }
}
