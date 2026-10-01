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
