// router.js — Tree router engine, table loading, and node resolution
// Conforms to JevAgent Design Spec Section 5, 7

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_TABLES_DIR = path.resolve(__dirname, '../tables');

export class RouterEngine {
  constructor({ tablesDir = null, jevClient = null } = {}) {
    this.tablesDir = tablesDir || DEFAULT_TABLES_DIR;
    this.jevClient = jevClient;
    this.tables = new Map();
    this.loadBuiltinTables();
  }

  loadBuiltinTables() {
    let targetDir = this.tablesDir;
    if (!targetDir || !fs.existsSync(targetDir)) {
      console.warn(`[router] Specified tablesDir does not exist: "${targetDir}", falling back to default: "${DEFAULT_TABLES_DIR}"`);
      targetDir = DEFAULT_TABLES_DIR;
      this.tablesDir = DEFAULT_TABLES_DIR;
    }

    if (fs.existsSync(targetDir)) {
      const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const fullPath = path.join(targetDir, file);
          const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          const tableId = content.table_id || path.basename(file, '.json');
          this.tables.set(tableId, content);
        } catch (err) {
          console.warn(`[router] Failed to parse table file ${file}: ${err.message}`);
        }
      }
    }
  }

  listTables() {
    const list = [];
    for (const [tableId, table] of this.tables.entries()) {
      list.push({
        table_id: tableId,
        target_language: table.target_language || 'abstract',
        schema_version: table.schema_version || '1.0',
        nodes_count: Object.keys(table.nodes || {}).length,
        has_mappings: !!table.semantic_mappings
      });
    }
    return list;
  }

  importTable(source) {
    let content;
    let filename = 'custom_table.json';

    if (typeof source === 'string' && fs.existsSync(source)) {
      filename = path.basename(source);
      content = JSON.parse(fs.readFileSync(source, 'utf8'));
    } else if (typeof source === 'string') {
      content = JSON.parse(source);
    } else if (typeof source === 'object') {
      content = source;
    } else {
      throw new Error('import_table 必须提供有效的文件路径或 JSON 内容');
    }

    const tableId = content.table_id || path.basename(filename, '.json');
    if (!content.nodes || typeof content.nodes !== 'object') {
      throw new Error('导入的路由表结构必须包含 `nodes` 字典');
    }

    this.tables.set(tableId, content);

    // Save to tablesDir if accessible
    try {
      if (!fs.existsSync(this.tablesDir)) {
        fs.mkdirSync(this.tablesDir, { recursive: true });
      }
      fs.writeFileSync(path.join(this.tablesDir, `${tableId}.json`), JSON.stringify(content, null, 2), 'utf8');
    } catch {
      // memory-only fallback
    }

    return {
      status: 'success',
      table_id: tableId,
      target_language: content.target_language || 'unknown',
      nodes_count: Object.keys(content.nodes).length
    };
  }

  getTableForLang(lang = 'python', tableRef = null) {
    if (tableRef && this.tables.has(tableRef)) {
      return this.tables.get(tableRef);
    }
    const normLang = (lang || 'python').toLowerCase().trim();
    // try exact match: e.g. python_v3, c_v1, shell_v2
    for (const [id, table] of this.tables.entries()) {
      if (table.target_language === normLang) {
        return table;
      }
    }
    // fallback to first table
    return this.tables.get('python_v3') || null;
  }

  inferSemanticNode(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // 1. Definition & Return
    if (trimmed.startsWith('定义 ') || trimmed.startsWith('def ')) return '/semantic/function/define';
    if (trimmed.startsWith('返回 ') || trimmed === '返回' || trimmed.startsWith('return ') || trimmed === 'return') return '/semantic/function/return';

    // 2. Control branch & loops
    if (trimmed.startsWith('如果 ') || trimmed.startsWith('if ')) return '/semantic/control/branch/if';
    if (trimmed.startsWith('否则如果 ') || trimmed.startsWith('elif ')) return '/semantic/control/branch/elif';
    if (trimmed === '否则:' || trimmed === '否则' || trimmed === 'else:' || trimmed === 'else') return '/semantic/control/branch/else';
    if (trimmed.startsWith('当 ') || trimmed.startsWith('while ')) return '/semantic/control/loop/while';
    if (trimmed.startsWith('对于 ') || trimmed.startsWith('for ')) return '/semantic/control/loop/for';
    if (trimmed === '跳出' || trimmed === 'break;' || trimmed === 'break') return '/semantic/control/loop/break';
    if (trimmed === '继续' || trimmed === 'continue;' || trimmed === 'continue') return '/semantic/control/loop/continue';

    // 3. IO output
    if (trimmed.startsWith('输出(') || trimmed.startsWith('输出 ') || trimmed.startsWith('print(')) return '/semantic/io/output';

    // 4. Explicit declaration (BUG-05 Fix: only lines with explicit declaration keyword '设 ')
    if (trimmed.startsWith('设 ')) return '/semantic/data/declare';

    // 5. Function Call (BUG-04 Fix: recognize function invocation e.g. 主函数(), do_task(x))
    // Matches identifier / dotted access followed by ( ... ), ending with or without semicolon
    if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.]+\s*\([^;:]*\)\s*;?$/.test(trimmed)) {
      return '/semantic/function/call';
    }

    // 6. Assignment (BUG-05 Fix: LHS = RHS, or augmented assignment)
    if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.\[\]\s]+\s*(?:=|\+=|-=|\*=|\/=)(?!=)\s*.+$/.test(trimmed)) {
      return '/semantic/data/assign';
    }
    if (trimmed.includes(' = ') && !trimmed.includes(' == ')) {
      return '/semantic/data/assign';
    }

    return '/semantic/data/assign';
  }

  routeSpecNode(line, lang = 'python', context = '', tableRef = null) {
    const table = this.getTableForLang(lang, tableRef);
    const semanticPath = this.inferSemanticNode(line);

    if (!table) {
      return { node_path: semanticPath || '/unknown', confidence: 0.5 };
    }

    if (semanticPath && table.semantic_mappings && table.semantic_mappings[semanticPath]) {
      const mapped = table.semantic_mappings[semanticPath];
      return { node_path: mapped, confidence: 0.98 };
    }

    // Direct match against table nodes
    const trimmed = line.trim();
    for (const [nodePath, node] of Object.entries(table.nodes || {})) {
      if (node.maps_from && node.maps_from.includes(semanticPath)) {
        return { node_path: nodePath, confidence: 0.95 };
      }
    }

    return { node_path: `/${lang}/raw`, confidence: 0.7 };
  }
}
