// normalize.js — DSL normalization and Chinese syntax sugar handling
// Conforms to JevAgent Design Spec V2.0 Section 4, 5, 15

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYNTAX_CORE_PATH = path.resolve(__dirname, '../tables/syntax_core_v1.json');

export class NormalizeDsl {
  static CORE_TABLE = null;
  static ALIAS_MAP = new Map();
  static OPERATOR_MAP = {};

  static init() {
    if (this.CORE_TABLE) return;
    try {
      if (fs.existsSync(SYNTAX_CORE_PATH)) {
        this.CORE_TABLE = JSON.parse(fs.readFileSync(SYNTAX_CORE_PATH, 'utf8'));
        const coreNodes = this.CORE_TABLE.core_nodes || {};
        for (const [nodeId, def] of Object.entries(coreNodes)) {
          const canonical = def.canonical;
          for (const alias of def.aliases || []) {
            this.ALIAS_MAP.set(alias, canonical);
          }
        }
        this.OPERATOR_MAP = this.CORE_TABLE.core_operators || {};
      }
    } catch {
      // Fallback aliases if table read fails
      this.ALIAS_MAP.set('函数', '定义');
      this.ALIAS_MAP.set('定义函数', '定义');
      this.ALIAS_MAP.set('若', '如果');
      this.ALIAS_MAP.set('否则若', '否则如果');
      this.ALIAS_MAP.set('遍历', '对于');
      this.ALIAS_MAP.set('循环当', '当');
      this.ALIAS_MAP.set('打印', '输出');
      this.ALIAS_MAP.set('读取', '输入');
      this.ALIAS_MAP.set('声明', '设');
      this.ALIAS_MAP.set('定义变量', '设');
      this.ALIAS_MAP.set('回', '返回');
    }
  }

  static convertNativeSyntax(trimmedLine, lang = 'python') {
    if (!trimmedLine || trimmedLine.startsWith('原生 ')) return null;
    const l = (lang || 'python').toLowerCase().trim();

    if (l === 'python' || l === 'py') {
      const defM = trimmedLine.match(/^def\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)(?:\s*->\s*(.+?))?:?$/);
      if (defM) {
        const ret = defM[3] ? ` -> ${defM[3]}` : '';
        return { converted: `定义 ${defM[1]}(${defM[2]})${ret}:`, from: 'def', to: '定义' };
      }
      const ifM = trimmedLine.match(/^if\s+(.+?):?$/);
      if (ifM) return { converted: `如果 ${ifM[1]}:`, from: 'if', to: '如果' };

      const elifM = trimmedLine.match(/^elif\s+(.+?):?$/);
      if (elifM) return { converted: `否则如果 ${elifM[1]}:`, from: 'elif', to: '否则如果' };

      if (trimmedLine === 'else:' || trimmedLine === 'else') {
        return { converted: '否则:', from: 'else', to: '否则' };
      }
      const forM = trimmedLine.match(/^for\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+in\s+(.+?):?$/);
      if (forM) return { converted: `对于 ${forM[1]} 中的 ${forM[2]}:`, from: 'for...in', to: '对于...中的' };

      const whileM = trimmedLine.match(/^while\s+(.+?):?$/);
      if (whileM) return { converted: `当 ${whileM[1]}:`, from: 'while', to: '当' };

      if (trimmedLine.startsWith('return ') || trimmedLine === 'return') {
        const expr = trimmedLine.slice(6).trim();
        return { converted: `返回 ${expr}`.trimEnd(), from: 'return', to: '返回' };
      }
      const printM = trimmedLine.match(/^print\s*\((.*)\)$/);
      if (printM) return { converted: `输出(${printM[1]})`, from: 'print', to: '输出' };

      const impM = trimmedLine.match(/^import\s+(\S+)(?:\s+as\s+(\S+))?$/);
      if (impM) {
        const asStr = impM[2] ? ` 作为 ${impM[2]}` : '';
        return { converted: `引入 ${impM[1]}${asStr}`, from: 'import', to: '引入' };
      }
      const fromImpM = trimmedLine.match(/^from\s+(\S+)\s+import\s+(.+)$/);
      if (fromImpM) return { converted: `从 ${fromImpM[1]} 引入 ${fromImpM[2]}`, from: 'from...import', to: '从...引入' };
    } else if (l === 'javascript' || l === 'js' || l === 'typescript' || l === 'ts') {
      const fnM = trimmedLine.match(/^(?:export\s+)?function\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)\s*\{?$/);
      if (fnM) return { converted: `定义 ${fnM[1]}(${fnM[2]}):`, from: 'function', to: '定义' };

      const asyncFnM = trimmedLine.match(/^(?:export\s+)?async\s+function\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)\s*\{?$/);
      if (asyncFnM) return { converted: `异步定义 ${asyncFnM[1]}(${asyncFnM[2]}):`, from: 'async function', to: '异步定义' };

      const ifM = trimmedLine.match(/^if\s*\((.+?)\)\s*\{?$/);
      if (ifM) return { converted: `如果 ${ifM[1]}:`, from: 'if', to: '如果' };

      const elifM = trimmedLine.match(/^(?:\}\s*)?else\s+if\s*\((.+?)\)\s*\{?$/);
      if (elifM) return { converted: `否则如果 ${elifM[1]}:`, from: 'else if', to: '否则如果' };

      if (trimmedLine === '} else {' || trimmedLine === 'else {' || trimmedLine === 'else') {
        return { converted: '否则:', from: 'else', to: '否则' };
      }
      const forOfM = trimmedLine.match(/^for\s*\(\s*(?:const|let|var)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+of\s+(.+?)\)\s*\{?$/);
      if (forOfM) return { converted: `对于 ${forOfM[1]} 中的 ${forOfM[2]}:`, from: 'for...of', to: '对于...中的' };

      const whileM = trimmedLine.match(/^while\s*\((.+?)\)\s*\{?$/);
      if (whileM) return { converted: `当 ${whileM[1]}:`, from: 'while', to: '当' };

      const logM = trimmedLine.match(/^console\.log\s*\((.*)\);?$/);
      if (logM) return { converted: `输出(${logM[1]})`, from: 'console.log', to: '输出' };

      const letM = trimmedLine.match(/^let\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(.+?);?$/);
      if (letM) return { converted: `设 ${letM[1]}: let = ${letM[2]}`, from: 'let', to: '设 ...: let' };

      const constM = trimmedLine.match(/^(?:const|var)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(.+?);?$/);
      if (constM) return { converted: `设 ${constM[1]} = ${constM[2]}`, from: 'const', to: '设' };

      if (trimmedLine.startsWith('return ') || trimmedLine.startsWith('return;') || trimmedLine === 'return') {
        const expr = trimmedLine.slice(6).replace(/;$/, '').trim();
        return { converted: `返回 ${expr}`.trimEnd(), from: 'return', to: '返回' };
      }
    }

    return null;
  }

  static normalizeText(text, targetLang = 'python') {
    this.init();
    if (!text) return { normalized: '', stats: { input_nodes: 0, normalized_nodes: 0, unknown_nodes: [], auto_corrected: [], description_deviations: [] } };

    // Standardize line endings
    const cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = cleaned.split('\n');
    const result = [];
    const autoCorrected = [];
    let inputNodes = 0;
    let normalizedNodes = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('<!--')) {
        result.push(line);
        continue;
      }

      inputNodes++;
      const indent = line.match(/^\s*/)[0];
      let normLine = line;

      // 1. Full-width punctuation to half-width outside quotes
      normLine = this.replaceOutsideQuotes(normLine, (code) => {
        return code
          .replace(/（/g, '(')
          .replace(/）/g, ')')
          .replace(/：/g, ':')
          .replace(/，/g, ', ')
          .replace(/；\s*$/g, '')
          .replace(/;\s*$/g, '');
      });

      // 2. Canonical alias normalization at beginning of statement
      const trimmedNorm = normLine.trim();
      for (const [alias, canonical] of this.ALIAS_MAP.entries()) {
        const regex = new RegExp(`^${alias}\\b|^${alias}(?=[\\s(])`);
        if (regex.test(trimmedNorm)) {
          const replaced = trimmedNorm.replace(regex, canonical);
          normLine = `${indent}${replaced}`;
          autoCorrected.push({
            line: i + 1,
            from: alias,
            to: canonical,
            rule: `syntax_core/alias/${alias}`
          });
          normalizedNodes++;
          break;
        }
      }

      // 2.5 Native syntax passthrough conversion (Anti-Passthrough Gate)
      const nativeFix = this.convertNativeSyntax(normLine.trim(), targetLang);
      if (nativeFix) {
        normLine = `${indent}${nativeFix.converted}`;
        autoCorrected.push({
          line: i + 1,
          from: nativeFix.from,
          to: nativeFix.to,
          rule: `anti_passthrough/${targetLang}/${nativeFix.from}`
        });
        normalizedNodes++;
      }

      // 3. Space normalization after keyword
      normLine = normLine
        .replace(/如果\s*\(/g, '如果 ')
        .replace(/当\s*\(/g, '当 ')
        .replace(/返回\s*\(/g, '返回 ');

      result.push(normLine);
    }

    const normalized = result.join('\n');
    return {
      normalized,
      stats: {
        input_nodes: inputNodes,
        normalized_nodes: normalizedNodes,
        unknown_nodes: [],
        auto_corrected: autoCorrected,
        description_deviations: []
      }
    };
  }

  static replaceOutsideQuotes(text, transform) {
    let result = '';
    let pos = 0;
    const len = text.length;

    while (pos < len) {
      const ch = text[pos];
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = (text.slice(pos, pos + 3) === ch.repeat(3)) ? ch.repeat(3) : ch;
        const qLen = quote.length;
        let end = pos + qLen;
        while (end < len) {
          if (text[end] === '\\') {
            end += 2;
          } else if (text.slice(end, end + qLen) === quote) {
            end += qLen;
            break;
          } else {
            end++;
          }
        }
        result += text.slice(pos, end);
        pos = end;
      } else if (text.slice(pos, pos + 2) === '//' || ch === '#') {
        // Comment rest of line
        result += text.slice(pos);
        break;
      } else {
        let nextQuote = len;
        for (let i = pos; i < len; i++) {
          const c = text[i];
          if (c === '"' || c === "'" || c === '`' || (c === '/' && text[i + 1] === '/') || c === '#') {
            nextQuote = i;
            break;
          }
        }
        result += transform(text.slice(pos, nextQuote));
        pos = nextQuote;
      }
    }
    return result;
  }
}
