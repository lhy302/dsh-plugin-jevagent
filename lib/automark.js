// automark.js — Automatic AST/heuristic demarcation of @jev-block markers
// Conforms to JevAgent Engineering Spec V3.0 Section 3

import fs from 'node:fs';
import path from 'node:path';

export class AutoMarker {
  static MARKER_LINE_REGEX = /^\s*(?:#|\/\/|--|;|%|'|!|<!--\s*|\/\*\s*)\s*@jev-block:([a-zA-Z0-9_.-]+):(begin|end)(?:\s*-->|\s*\*\/)?\s*$/;

  static getSyntaxPrefix(lang = 'python') {
    const l = (lang || 'python').toLowerCase().trim();
    if (['c', 'cpp', 'javascript', 'js', 'typescript', 'ts', 'go', 'rust', 'java', 'cs'].includes(l)) {
      return '//';
    }
    if (['sql', 'lua', 'haskell'].includes(l)) {
      return '--';
    }
    return '#';
  }

  static stripJevMarkers(str) {
    if (!str) return '';
    return str
      .split('\n')
      .filter(l => !AutoMarker.MARKER_LINE_REGEX.test(l.trim()))
      .map(l => l.trimEnd())
      .join('\n')
      .replace(/^\s*[\r\n]/gm, '')
      .trim();
  }

  static isFenceConfigFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    const base = norm.split('/').pop();

    if (base === 'jevagent.json') return true;
    if (norm.includes('.dsh/plugins/dsh-plugin-jevagent') || norm.includes('dsh-plugin-jevagent')) return true;
    if (norm.includes('.dsh/cordis.patch.yml') || norm.includes('.dsh/cordis.yml') || norm.includes('.dsh/settings.yaml')) return true;

    return false;
  }

  static detectProhibitedFenceCommand(command) {
    if (!command || typeof command !== 'string') return null;

    const tokens = command.split(/[\s,;|"'\`=><()]+/).filter(Boolean);
    for (const t of tokens) {
      if (this.isFenceConfigFile(t)) {
        const modCmdRegex = /(?:>>?|\b(?:Set-Content|Add-Content|Out-File|Remove-Item|del|rm|erase|ren|move|mv|cp|copy)\b)/i;
        if (modCmdRegex.test(command)) {
          return {
            type: 'tamper_fence_config',
            file: t,
            reason: `严禁通过命令行修改或篡改安全围栏配置文件 (${t})`
          };
        }
      }
    }
    return null;
  }

  static extractCodeFile(str, codeExtensions) {
    if (!str) return null;
    const tokens = str.split(/[\s,;|"'\`=()]+/).filter(Boolean);
    for (const t of tokens) {
      if (t.includes('.spec.')) continue;
      const m = t.match(/\.([a-zA-Z0-9]+)$/);
      if (m && codeExtensions && codeExtensions.has('.' + m[1].toLowerCase())) {
        return t;
      }
    }
    return null;
  }

  static isPairedLinkedCommand(command, codeFile) {
    if (!command || !codeFile) return false;
    const m = codeFile.match(/([a-zA-Z0-9_\-]+)\.[a-zA-Z0-9]+$/);
    if (!m) return false;
    const baseName = m[1];
    const dslPattern = new RegExp(`\\b${baseName}\\.spec\\.[a-zA-Z0-9_\\-]+\\.dsl\\b`, 'i');
    return dslPattern.test(command);
  }

  static detectProhibitedCodeCommand(command, codeExtensions) {
    if (!command || typeof command !== 'string' || !codeExtensions) return null;

    // 1. Rename, Move, Copy, Delete commands
    const mutateCmdRegex = /\b(?:Rename-Item|Move-Item|Copy-Item|ren|mv|move|cp|copy|rni|mi|cpi|git\s+mv|rm|del|Remove-Item)\b/i;
    if (mutateCmdRegex.test(command)) {
      const codeFile = this.extractCodeFile(command, codeExtensions);
      if (codeFile) {
        // Paired linked operation pass-through: if moving/deleting both .spec.<lang>.dsl AND code file together, ALLOW!
        if (this.isPairedLinkedCommand(command, codeFile)) {
          return null;
        }
        return {
          type: 'unlinked_code_mutation',
          file: codeFile,
          reason: `检测到试图单独改动代码文件 (${codeFile})。代码文件由 DSL 唯一驱动，请通过 jevagent(action="move_module") / jevagent(action="delete_module") 操作，或将对应的 spec DSL 文件一同联动操作。`
        };
      }
    }

    // 2. Direct CLI Redirection or Output into code files (> file.py, >> file.py, Set-Content, Out-File)
    const redirectRegex = /(?:>>?|Out-File|Set-Content|Add-Content)\s+(?:-Path\s+|-FilePath\s+)?['"]?([^'">\s]+)['"]?/i;
    const redM = command.match(redirectRegex);
    if (redM) {
      const target = redM[1];
      const codeFile = this.extractCodeFile(target, codeExtensions);
      if (codeFile) {
        return {
          type: 'redirect_write_code_file',
          file: codeFile,
          reason: `检测到试图通过重定向或命令行直接写入代码文件 (${codeFile})`
        };
      }
    }

    return null;
  }

  static isPureAnnotation(oldStr, newStr) {
    if (!newStr || typeof newStr !== 'string') return false;
    if (!newStr.includes('@jev-block:')) return false;
    const strippedOld = this.stripJevMarkers(oldStr || '');
    const strippedNew = this.stripJevMarkers(newStr || '');
    return strippedOld === strippedNew;
  }

  static autoMark(content, lang = 'python') {
    const normLang = (lang || 'python').toLowerCase().trim();
    let blocks = [];
    if (normLang === 'python' || normLang === 'py') {
      blocks = this.scanPythonBlocks(content);
    } else if (['javascript', 'js', 'typescript', 'ts'].includes(normLang)) {
      blocks = this.scanJSBlocks(content);
    } else if (['c', 'cpp'].includes(normLang)) {
      blocks = this.scanCBlocks(content);
    } else if (['shell', 'sh', 'bash'].includes(normLang)) {
      blocks = this.scanShellBlocks(content);
    } else {
      blocks = this.scanGenericBlocks(content);
    }

    const prefix = this.getSyntaxPrefix(normLang);
    const markedSections = [];

    for (const blk of blocks) {
      const codeBody = blk.lines.join('\n').trim();
      if (!codeBody) continue;
      markedSections.push(`${prefix} @jev-block:${blk.block_id}:begin\n${codeBody}\n${prefix} @jev-block:${blk.block_id}:end`);
    }

    const markedCode = markedSections.join('\n\n') + '\n';
    return {
      markedCode,
      blocks_count: blocks.length,
      blocks: blocks.map(b => ({
        block_id: b.block_id,
        kind: b.kind || 'logic',
        lines_count: b.lines.length
      }))
    };
  }

  static scanPythonBlocks(content) {
    const lines = (content || '').split('\n');
    const blocks = [];
    let importLines = [];
    let currentBlock = null;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();

      if (blocks.length === 0 && !currentBlock) {
        if (trimmed.startsWith('import ') || trimmed.startsWith('from ') || trimmed.startsWith('#!')) {
          importLines.push(rawLine);
          continue;
        }
      }

      const isTopLevel = rawLine.length > 0 && !/^\s/.test(rawLine);
      if (isTopLevel) {
        const defMatch = trimmed.match(/^def\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\(/);
        const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)/);
        const mainMatch = trimmed.match(/^if\s+__name__\s*==\s*['"]__main__['"]:/);

        if (defMatch || classMatch || mainMatch) {
          if (currentBlock) {
            while (currentBlock.lines.length > 0 && !currentBlock.lines[currentBlock.lines.length - 1].trim()) {
              currentBlock.lines.pop();
            }
            blocks.push(currentBlock);
            currentBlock = null;
          }

          let blockId = '';
          let kind = 'function';
          if (defMatch) {
            blockId = `${defMatch[1]}_001`;
            kind = 'function';
          } else if (classMatch) {
            blockId = `${classMatch[1]}_001`;
            kind = 'class';
          } else if (mainMatch) {
            blockId = 'main_runner_001';
            kind = 'runner';
          }

          currentBlock = {
            block_id: blockId,
            kind,
            lines: [rawLine]
          };
          continue;
        }
      }

      if (currentBlock) {
        currentBlock.lines.push(rawLine);
      }
    }

    if (currentBlock) {
      while (currentBlock.lines.length > 0 && !currentBlock.lines[currentBlock.lines.length - 1].trim()) {
        currentBlock.lines.pop();
      }
      blocks.push(currentBlock);
    }

    if (importLines.length > 0) {
      blocks.unshift({
        block_id: 'imports',
        kind: 'imports',
        lines: importLines
      });
    }

    return blocks;
  }

  static scanJSBlocks(content) {
    const lines = (content || '').split('\n');
    const blocks = [];
    let importLines = [];
    let currentBlock = null;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();

      if (blocks.length === 0 && !currentBlock) {
        if (trimmed.startsWith('import ') || trimmed.startsWith('require(') || trimmed.startsWith('#!')) {
          importLines.push(rawLine);
          continue;
        }
      }

      if (!currentBlock && trimmed) {
        const fnM = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s+([a-zA-Z0-9_\u4e00-\u9fa5]+))?\s*\(/);
        const classM = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)/);
        const constFnM = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/);
        const constObjM = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*\{/);

        if (fnM || classM || constFnM || constObjM) {
          let blockId = '';
          let kind = 'function';
          if (fnM) {
            blockId = `${fnM[1] || 'anonymous'}_001`;
            kind = 'function';
          } else if (classM) {
            blockId = `${classM[1]}_001`;
            kind = 'class';
          } else if (constFnM) {
            blockId = `${constFnM[1]}_001`;
            kind = 'function';
          } else if (constObjM) {
            blockId = `${constObjM[1]}_001`;
            kind = 'data';
          }

          currentBlock = {
            block_id: blockId,
            kind,
            lines: [rawLine]
          };

          const clean = rawLine.replace(/(["'`])(?:\\.|[^\\])*?\1/g, ' ');
          const openC = (clean.match(/\{/g) || []).length;
          const closeC = (clean.match(/\}/g) || []).length;
          braceDepth = openC - closeC;

          if (braceDepth <= 0 && (openC > 0 || rawLine.endsWith(';'))) {
            blocks.push(currentBlock);
            currentBlock = null;
          }
          continue;
        }
      }

      if (currentBlock) {
        currentBlock.lines.push(rawLine);
        const clean = rawLine.replace(/(["'`])(?:\\.|[^\\])*?\1/g, ' ');
        const openC = (clean.match(/\{/g) || []).length;
        const closeC = (clean.match(/\}/g) || []).length;
        braceDepth += (openC - closeC);

        if (braceDepth <= 0) {
          while (currentBlock.lines.length > 0 && !currentBlock.lines[currentBlock.lines.length - 1].trim()) {
            currentBlock.lines.pop();
          }
          blocks.push(currentBlock);
          currentBlock = null;
          braceDepth = 0;
        }
      }
    }

    if (currentBlock) blocks.push(currentBlock);

    if (importLines.length > 0) {
      blocks.unshift({
        block_id: 'imports',
        kind: 'imports',
        lines: importLines
      });
    }

    return blocks;
  }

  static scanCBlocks(content) {
    const lines = (content || '').split('\n');
    const blocks = [];
    let importLines = [];
    let currentBlock = null;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();

      if (blocks.length === 0 && !currentBlock) {
        if (trimmed.startsWith('#include') || trimmed.startsWith('#define')) {
          importLines.push(rawLine);
          continue;
        }
      }

      if (!currentBlock && trimmed) {
        const fnM = trimmed.match(/^[a-zA-Z0-9_*]+\s+([a-zA-Z0-9_]+)\s*\([^;]*\)\s*\{/);
        const structM = trimmed.match(/^(?:typedef\s+)?struct(?:\s+([a-zA-Z0-9_]+))?\s*\{/);

        if (fnM || structM) {
          const name = fnM ? fnM[1] : (structM[1] || 'struct');
          currentBlock = {
            block_id: `${name}_001`,
            kind: fnM ? 'function' : 'struct',
            lines: [rawLine]
          };

          const clean = rawLine.replace(/(["'`])(?:\\.|[^\\])*?\1/g, ' ');
          const openC = (clean.match(/\{/g) || []).length;
          const closeC = (clean.match(/\}/g) || []).length;
          braceDepth = openC - closeC;

          if (braceDepth <= 0 && openC > 0) {
            blocks.push(currentBlock);
            currentBlock = null;
          }
          continue;
        }
      }

      if (currentBlock) {
        currentBlock.lines.push(rawLine);
        const clean = rawLine.replace(/(["'`])(?:\\.|[^\\])*?\1/g, ' ');
        const openC = (clean.match(/\{/g) || []).length;
        const closeC = (clean.match(/\}/g) || []).length;
        braceDepth += (openC - closeC);

        if (braceDepth <= 0) {
          while (currentBlock.lines.length > 0 && !currentBlock.lines[currentBlock.lines.length - 1].trim()) {
            currentBlock.lines.pop();
          }
          blocks.push(currentBlock);
          currentBlock = null;
          braceDepth = 0;
        }
      }
    }

    if (currentBlock) blocks.push(currentBlock);

    if (importLines.length > 0) {
      blocks.unshift({
        block_id: 'imports',
        kind: 'imports',
        lines: importLines
      });
    }

    return blocks;
  }

  static scanShellBlocks(content) {
    const lines = (content || '').split('\n');
    const blocks = [];
    let headerLines = [];
    let currentBlock = null;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();

      if (blocks.length === 0 && !currentBlock) {
        if (trimmed.startsWith('#!') || trimmed.startsWith('set ') || trimmed.startsWith('source ') || trimmed.startsWith('. ')) {
          headerLines.push(rawLine);
          continue;
        }
      }

      if (!currentBlock && trimmed) {
        const fnM = trimmed.match(/^(?:function\s+)?([a-zA-Z0-9_]+)\s*\(\)\s*\{/) || trimmed.match(/^function\s+([a-zA-Z0-9_]+)\s*\{/);
        if (fnM) {
          currentBlock = {
            block_id: `${fnM[1]}_001`,
            kind: 'function',
            lines: [rawLine]
          };
          braceDepth = (rawLine.match(/\{/g) || []).length - (rawLine.match(/\}/g) || []).length;
          continue;
        }
      }

      if (currentBlock) {
        currentBlock.lines.push(rawLine);
        braceDepth += (rawLine.match(/\{/g) || []).length - (rawLine.match(/\}/g) || []).length;
        if (braceDepth <= 0) {
          blocks.push(currentBlock);
          currentBlock = null;
          braceDepth = 0;
        }
      }
    }

    if (currentBlock) blocks.push(currentBlock);

    if (headerLines.length > 0) {
      blocks.unshift({
        block_id: 'header',
        kind: 'header',
        lines: headerLines
      });
    }

    return blocks;
  }

  static scanGenericBlocks(content) {
    return [{
      block_id: 'module_body_001',
      kind: 'body',
      lines: (content || '').split('\n')
    }];
  }
}
