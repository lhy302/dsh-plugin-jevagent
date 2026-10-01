// symbol-table.js — Dynamic symbol table extraction and tracking
// Conforms to JevAgent Design Spec Section 8 & V3.0 Spec

// @jev-block:symbol_table_001:begin
export class SymbolTable {
  static IDENT_RE = /\b([a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*)\b/g;

  static extractSymbols(content, lang = 'python', blacklist = []) {
    const defined = new Set();
    const used = new Set();
    const referenced = new Set();
    const blSet = new Set(blacklist || []);

    const lines = (content || '').split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('//') || line.startsWith('--')) {
        continue;

      // Extract all identifier tokens outside string literals
      }
      const codeWithoutStrings = line.replace(/(["'`])(?:\\.|[^\\])*?\1/g, ' ');
      const tokens = codeWithoutStrings.match(SymbolTable.IDENT_RE) || [];
      for (const t of tokens) {
        if (!blSet.has(t) && !/^\d+$/.test(t)) {
          referenced.add(t);

        }
      }
      if (line.startsWith('定义') || line.startsWith('设') || line.startsWith('对于') || line.startsWith('def ')) {
        const defMatch = line.match(/^(?:定义|def)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)/);
        if (defMatch) {
          defined.add(defMatch[1]);
          const args = defMatch[2].split(',').map(a => a.trim().split(':')[0].trim()).filter(Boolean);
          for (const arg of args) {
            defined.add(arg);
            used.add(arg);
          }
          continue;

        }
        const assignMatch = line.match(/^(?:设\s+)?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*(?::\s*[^=]+)?\s*=\s*(.+)/);
        if (assignMatch) {
          defined.add(assignMatch[1]);
          const expr = assignMatch[2];
          const exprTokens = expr.replace(/(["'`])(?:\\.|[^\\])*?\1/g, ' ').match(SymbolTable.IDENT_RE) || [];
          for (const t of exprTokens) {
            if (t !== assignMatch[1] && !blSet.has(t) && !/^\d+$/.test(t)) {
              used.add(t);
            }
          }
          continue;

        }
        const forMatch = line.match(/^对于\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+中的\s+(.+?):/);
        if (forMatch) {
          defined.add(forMatch[1]);
          used.add(forMatch[2].trim());
          continue;
        }
      } else {
        const pyDefMatch = line.match(/^def\s+([a-zA-Z0-9_]+)\s*\((.*?)\)/);
        if (pyDefMatch) {
          defined.add(pyDefMatch[1]);
          const args = pyDefMatch[2].split(',').map(a => a.trim().split(':')[0].trim()).filter(Boolean);
          for (const arg of args) {
            defined.add(arg);
          }
          continue;

        }
        const cDefMatch = line.match(/^[a-zA-Z0-9_*]+\s+([a-zA-Z0-9_]+)\s*\((.*?)\)\s*\{?/);
        if (cDefMatch && !['if', 'while', 'for', 'switch'].includes(cDefMatch[1])) {
          defined.add(cDefMatch[1]);
          continue;

        }
        const assignMatch = line.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)/);
        if (assignMatch) {
          defined.add(assignMatch[1]);
          continue;

        }
      }
    }
    return {
      defined: Array.from(defined),
      used: Array.from(used),
      referenced: Array.from(referenced)
    };

  }
}
// @jev-block:symbol_table_001:end
