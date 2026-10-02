// @jev-block:imports:begin
引入 fs 从 'node:fs'                    // node:/javascript/module/import origin:declared
引入 path 从 'node:path'                    // node:/javascript/module/import origin:declared
引入 { fileURLToPath } 从 'node:url'                    // node:/javascript/module/import origin:declared
// @jev-block:imports:end
// @jev-block:names:begin
变量 content: Any
变量 filename: Any
变量 targetDir: Any
库 fs
库 path
// @jev-block:names:end
// @jev-block:RouterEngine_001:begin
导出 类 RouterEngine:                                   // node:/javascript/class/define
  方法 constructor({ tablesDir = null, jevClient = null } = {}):             // node:/javascript/function/define
    this.tablesDir = tablesDir || DEFAULT_TABLES_DIR                               // node:/javascript/data/assign
    this.jevClient = jevClient                               // node:/javascript/data/assign
    this.tables = new Map()                               // node:/javascript/data/assign
    this.loadBuiltinTables()                               // node:/javascript/function/call
  方法 loadBuiltinTables():             // node:/javascript/function/define
    设 targetDir: let = this.tablesDir          // node:/javascript/data/declare
    如果 !targetDir || !fs.existsSync(targetDir):                             // node:/javascript/control/if
      console.warn(`[router] Specified tablesDir does not exist: "${targetDir}", falling back to default: "${DEFAULT_TABLES_DIR}"`);
      targetDir = DEFAULT_TABLES_DIR                               // node:/javascript/data/assign
      this.tablesDir = DEFAULT_TABLES_DIR                               // node:/javascript/data/assign
    如果 fs.existsSync(targetDir):                             // node:/javascript/control/if
      设 files = fs.readdirSync(targetDir).filter(f => f.endsWith('.json'))          // node:/javascript/data/declare
      对于 file 中的 files:           // node:/javascript/control/for
        尝试:                                     // node:/javascript/error/try
          设 fullPath = path.join(targetDir, file)          // node:/javascript/data/declare
          设 content = JSON.parse(fs.readFileSync(fullPath, 'utf8'))          // node:/javascript/data/declare
          设 tableId = content.table_id || path.basename(file, '.json')          // node:/javascript/data/declare
          this.tables.set(tableId, content)                               // node:/javascript/function/call
        捕获 err:                              // node:/javascript/error/catch
          console.warn(`[router] Failed to parse table file ${file}: ${err.message}`);
  方法 listTables():             // node:/javascript/function/define
    设 list = []          // node:/javascript/data/declare
    for (const [tableId, table] of this.tables.entries()) {
      list.push({
        table_id: tableId,
        target_language: table.target_language || 'abstract',
        schema_version: table.schema_version || '1.0',
        nodes_count: Object.keys(table.nodes || {}).length,
        has_mappings: !!table.semantic_mappings
      });
    返回 list                               // node:/javascript/function/return
  方法 importTable(source):             // node:/javascript/function/define
    let content;
    设 filename: let = 'custom_table.json'          // node:/javascript/data/declare
    如果 typeof source === 'string' && fs.existsSync(source):                             // node:/javascript/control/if
      filename = path.basename(source)                               // node:/javascript/data/assign
      content = JSON.parse(fs.readFileSync(source, 'utf8'))                               // node:/javascript/data/assign
    否则如果 typeof source === 'string':                         // node:/javascript/control/elif
      content = JSON.parse(source)                               // node:/javascript/data/assign
    否则如果 typeof source === 'object':                         // node:/javascript/control/elif
      content = source                               // node:/javascript/data/assign
    否则:                                     // node:/javascript/control/else
      抛出 new Error('import_table 必须提供有效的文件路径或 JSON 内容')                              // node:/javascript/error/throw
    设 tableId = content.table_id || path.basename(filename, '.json')          // node:/javascript/data/declare
    如果 !content.nodes || typeof content.nodes !== 'object':                             // node:/javascript/control/if
      抛出 new Error('导入的路由表结构必须包含 `nodes` 字典')                              // node:/javascript/error/throw
    this.tables.set(tableId, content)                               // node:/javascript/function/call
    // Save to tablesDir if accessible
    尝试:                                     // node:/javascript/error/try
      如果 !fs.existsSync(this.tablesDir):                             // node:/javascript/control/if
        fs.mkdirSync(this.tablesDir, { recursive: true });
      fs.writeFileSync(path.join(this.tablesDir, `${tableId}.json`), JSON.stringify(content, null, 2), 'utf8')                               // node:/javascript/function/call
    } catch {
      // memory-only fallback
    返回 {                               // node:/javascript/function/return
      status: 'success',
      table_id: tableId,
      target_language: content.target_language || 'unknown',
      nodes_count: Object.keys(content.nodes).length
    }
  方法 getTableForLang(lang = 'python', tableRef = null):             // node:/javascript/function/define
    如果 tableRef && this.tables.has(tableRef):                             // node:/javascript/control/if
      返回 this.tables.get(tableRef)                               // node:/javascript/function/return
    设 normLang = (lang || 'python').toLowerCase().trim()          // node:/javascript/data/declare
    // try exact match: e.g. python_v3, c_v1, shell_v2
    for (const [id, table] of this.tables.entries()) {
      如果 table.target_language === normLang:                             // node:/javascript/control/if
        返回 table                               // node:/javascript/function/return
    // fallback to first table
    返回 this.tables.get('python_v3') || null                               // node:/javascript/function/return
  方法 inferSemanticNode(line):             // node:/javascript/function/define
    设 trimmed = line.trim()          // node:/javascript/data/declare
    如果 !trimmed:                             // node:/javascript/control/if
      返回 null
    // 1. Definition & Return
    如果 trimmed.startsWith('定义 ') || trimmed.startsWith('def '):                             // node:/javascript/control/if
      返回 '/semantic/function/define'
    如果 trimmed.startsWith('返回 ') || trimmed === '返回' || trimmed.startsWith('return ') || trimmed === 'return':                             // node:/javascript/control/if
      返回 '/semantic/function/return'
    // 2. Control branch & loops
    如果 trimmed.startsWith('如果 ') || trimmed.startsWith('if '):                             // node:/javascript/control/if
      返回 '/semantic/control/branch/if'
    如果 trimmed.startsWith('否则如果 ') || trimmed.startsWith('elif '):                             // node:/javascript/control/if
      返回 '/semantic/control/branch/elif'
    如果 trimmed === '否则:' || trimmed === '否则' || trimmed === 'else:' || trimmed === 'else':                             // node:/javascript/control/if
      返回 '/semantic/control/branch/else'
    如果 trimmed.startsWith('当 ') || trimmed.startsWith('while '):                             // node:/javascript/control/if
      返回 '/semantic/control/loop/while'
    如果 trimmed.startsWith('对于 ') || trimmed.startsWith('for '):                             // node:/javascript/control/if
      返回 '/semantic/control/loop/for'
    如果 trimmed === '跳出' || trimmed === 'break;' || trimmed === 'break':                             // node:/javascript/control/if
      返回 '/semantic/control/loop/break'
    如果 trimmed === '继续' || trimmed === 'continue;' || trimmed === 'continue':                             // node:/javascript/control/if
      返回 '/semantic/control/loop/continue'
    // 3. IO output
    如果 trimmed.startsWith('输出(') || trimmed.startsWith('输出 ') || trimmed.startsWith('print('):                             // node:/javascript/control/if
      返回 '/semantic/io/output'
    // 4. Explicit declaration (BUG-05 Fix: only lines with explicit declaration keyword '设 ')
    如果 trimmed.startsWith('设 '):                             // node:/javascript/control/if
      返回 '/semantic/data/declare'
    // 5. Function Call (BUG-04 Fix: recognize function invocation e.g. 主函数(), do_task(x))
    // Matches identifier / dotted access followed by ( ... ), ending with or without semicolon
    如果 /^[a-zA-Z0-9_\u4e00-\u9fa5\.]+\s*\([^;:]*\)\s*;?$/.test(trimmed):                             // node:/javascript/control/if
      返回 '/semantic/function/call'                               // node:/javascript/function/return
    // 6. Assignment (BUG-05 Fix: LHS = RHS, or augmented assignment)
    如果 /^[a-zA-Z0-9_\u4e00-\u9fa5\.\[\]\s]+\s*(?:=|\+=|-=|\*=|\/=)(?!=)\s*.+$/.test(trimmed):                             // node:/javascript/control/if
      返回 '/semantic/data/assign'                               // node:/javascript/function/return
    如果 trimmed.includes(' = ') && !trimmed.includes(' == '):                             // node:/javascript/control/if
      返回 '/semantic/data/assign'                               // node:/javascript/function/return
    返回 '/semantic/data/assign'                               // node:/javascript/function/return
  方法 routeSpecNode(line, lang = 'python', context = '', tableRef = null):             // node:/javascript/function/define
    设 table = this.getTableForLang(lang, tableRef)          // node:/javascript/data/declare
    设 semanticPath = this.inferSemanticNode(line)          // node:/javascript/data/declare
    如果 !table:                             // node:/javascript/control/if
      返回 { node_path: semanticPath || '/unknown', confidence: 0.5 }                               // node:/javascript/function/return
    如果 semanticPath && table.semantic_mappings && table.semantic_mappings[semanticPath]:                             // node:/javascript/control/if
      设 mapped = table.semantic_mappings[semanticPath]          // node:/javascript/data/declare
      返回 { node_path: mapped, confidence: 0.98 }                               // node:/javascript/function/return
    // Direct match against table nodes
    设 trimmed = line.trim()          // node:/javascript/data/declare
    for (const [nodePath, node] of Object.entries(table.nodes || {})) {
      如果 node.maps_from && node.maps_from.includes(semanticPath):                             // node:/javascript/control/if
        返回 { node_path: nodePath, confidence: 0.95 }                               // node:/javascript/function/return
    返回 { node_path: `/${lang}/raw`, confidence: 0.7 }                               // node:/javascript/function/return
// @jev-block:RouterEngine_001:end
