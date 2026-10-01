// names.js — Symbol Universe parser and module-isolated environment
// Conforms to JevAgent Design Spec V2.0 Section 2, 12.5 & Engineering Spec V3.0 Section 8

// @jev-block:names_entry_001:begin
导出 类 NamesEntry:                                   // node:/javascript/class/define
  方法 constructor({ kind, name, type = null, value = null, alias = null, params = [], return_type = null, line = 0 }):             // node:/javascript/function/define
    this.kind = kind// 'lib' | 'var' | 'const' | 'func'                               // node:/javascript/data/assign
    this.name = name                               // node:/javascript/data/assign
    this.type = type                               // node:/javascript/data/assign
    this.value = value                               // node:/javascript/data/assign
    this.alias = alias || name                               // node:/javascript/data/assign
    this.params = params                               // node:/javascript/data/assign
    this.return_type = return_type                               // node:/javascript/data/assign
    this.line = line                               // node:/javascript/data/assign
// @jev-block:names_entry_001:end
// @jev-block:names_env_002:begin
导出 类 NamesEnv:                                   // node:/javascript/class/define
  方法 constructor(entries = []):             // node:/javascript/function/define
    this.libraries = new Map()                               // node:/javascript/data/assign
    this.variables = new Map()                               // node:/javascript/data/assign
    this.constants = new Map()                               // node:/javascript/data/assign
    this.functions = new Map()                               // node:/javascript/data/assign

    对于 e 中的 entries:           // node:/javascript/control/for
      如果 e.kind === 'lib':                             // node:/javascript/control/if
        this.libraries.set(e.name, e)                               // node:/javascript/function/call
        如果 e.alias && e.alias !== e.name:                             // node:/javascript/control/if
          this.libraries.set(e.alias, e)                               // node:/javascript/function/call
      否则如果 e.kind === 'var':                         // node:/javascript/control/elif
        this.variables.set(e.name, e)                               // node:/javascript/function/call
      否则如果 e.kind === 'const':                         // node:/javascript/control/elif
        this.constants.set(e.name, e)                               // node:/javascript/function/call
      否则如果 e.kind === 'func':                         // node:/javascript/control/elif
        this.functions.set(e.name, e)                               // node:/javascript/function/call

  方法 hasSymbol(name):             // node:/javascript/function/define
    返回 this.variables.has(name) || this.constants.has(name) || this.functions.has(name) || this.libraries.has(name)                               // node:/javascript/function/return

  方法 getVariableType(name):             // node:/javascript/function/define
    返回 this.variables.get(name)?.type || null                               // node:/javascript/function/return

  方法 getConstant(name):             // node:/javascript/function/define
    返回 this.constants.get(name)?.value ?? null                               // node:/javascript/function/return

  方法 hasVariable(name):             // node:/javascript/function/define
    返回 this.variables.has(name)                               // node:/javascript/function/return

  方法 hasConstant(name):             // node:/javascript/function/define
    返回 this.constants.has(name)                               // node:/javascript/function/return

  方法 hasFunction(name):             // node:/javascript/function/define
    返回 this.functions.has(name)                               // node:/javascript/function/return

  方法 hasLibrary(name):             // node:/javascript/function/define
    返回 this.libraries.has(name)                               // node:/javascript/function/return

  方法 getSymbolsCount():             // node:/javascript/function/define
    返回 this.variables.size + this.constants.size + this.functions.size + this.libraries.size                               // node:/javascript/function/return

  方法 getAllSymbolNames():             // node:/javascript/function/define
    返回 Array.from(new Set([...this.variables.keys(), ...this.constants.keys(), ...this.functions.keys(), ...this.libraries.keys()]))                               // node:/javascript/function/return
// @jev-block:names_env_002:end
// @jev-block:parse_names_003:begin
导出 定义 parseNamesBlock(blockContent = '', syntaxKeywords = []):                         // node:/javascript/function/define
  设 entries = []          // node:/javascript/data/declare
  设 errors = []          // node:/javascript/data/declare
  设 lines = (blockContent || '').split('\n')          // node:/javascript/data/declare
  设 seenNames = new Map()          // node:/javascript/data/declare
  设 kwSet = new Set(syntaxKeywords)          // node:/javascript/data/declare

  对于 i 中的 range(lines.length):           // node:/javascript/control/for
    设 rawLine = lines[i]          // node:/javascript/data/declare
    设 lineNo = i + 1          // node:/javascript/data/declare
    设 trimmed = rawLine.trim()          // node:/javascript/data/declare

    如果 !trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'):                             // node:/javascript/control/if
      继续                                       // node:/javascript/control/loop/continue

    设 libMatch = trimmed.match(/^库\s+([a-zA-Z0-9_\u4e00-\u9fa5\.\-:]+)(?:\s+作为\s+([a-zA-Z0-9_\u4e00-\u9fa5]+))?$/)          // node:/javascript/data/declare
    如果 libMatch:                             // node:/javascript/control/if
      设 name = libMatch[1]          // node:/javascript/data/declare
      设 alias = libMatch[2] || name          // node:/javascript/data/declare
      如果 kwSet.has(alias):                             // node:/javascript/control/if
        errors.push({ line: lineNo, message: `库别名 '${alias}' 与保留语法关键字冲突` })
      设 entry = new NamesEntry({ kind: 'lib', name, alias, line: lineNo })          // node:/javascript/data/declare
      entries.push(entry)                               // node:/javascript/function/call
      seenNames.set(alias, 'lib')                               // node:/javascript/function/call
      继续                                       // node:/javascript/control/loop/continue

    设 varMatch = trimmed.match(/^变量\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)(?:\s*:\s*([a-zA-Z0-9_\[\],\*\s]+))?$/)          // node:/javascript/data/declare
    如果 varMatch:                             // node:/javascript/control/if
      设 name = varMatch[1]          // node:/javascript/data/declare
      设 type = varMatch[2] ? varMatch[2].trim() : null          // node:/javascript/data/declare
      如果 kwSet.has(name):                             // node:/javascript/control/if
        errors.push({ line: lineNo, message: `变量名 '${name}' 与保留语法关键字冲突` })
      如果 seenNames.has(name) && seenNames.get(name) !== 'var':                             // node:/javascript/control/if
        errors.push({ line: lineNo, message: `符号 '${name}' 重复定义冲突 (已有类型: ${seenNames.get(name)})` })
      seenNames.set(name, 'var')                               // node:/javascript/function/call
      entries.push(new NamesEntry({ kind: 'var', name, type, line: lineNo }))
      继续                                       // node:/javascript/control/loop/continue

    设 constMatch = trimmed.match(/^常量\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(.+)$/)          // node:/javascript/data/declare
    如果 constMatch:                             // node:/javascript/control/if
      设 name = constMatch[1]          // node:/javascript/data/declare
      设 valStr = constMatch[2].trim()          // node:/javascript/data/declare
      如果 kwSet.has(name):                             // node:/javascript/control/if
        errors.push({ line: lineNo, message: `常量名 '${name}' 与保留语法关键字冲突` })
      设 inferredType = 'str'          // node:/javascript/data/declare
      设 val = valStr          // node:/javascript/data/declare
      如果 /^-?\d+$/.test(valStr):                             // node:/javascript/control/if
        inferredType = 'int'                               // node:/javascript/data/assign
        val = parseInt(valStr, 10)                               // node:/javascript/data/assign
      否则如果 /^-?\d+\.\d+$/.test(valStr):                         // node:/javascript/control/elif
        inferredType = 'float'                               // node:/javascript/data/assign
        val = parseFloat(valStr)                               // node:/javascript/data/assign
      否则如果 valStr === 'True' || valStr === 'False' || valStr === '真' || valStr === '假':                         // node:/javascript/control/elif
        inferredType = 'bool'                               // node:/javascript/data/assign
        val = (valStr === 'True' || valStr === '真')                               // node:/javascript/data/assign
      否则如果 /^["'].*["']$/.test(valStr):                         // node:/javascript/control/elif
        inferredType = 'str'                               // node:/javascript/data/assign
        val = valStr.slice(1, -1)                               // node:/javascript/data/assign
      entries.push(new NamesEntry({ kind: 'const', name, value: val, type: inferredType, line: lineNo }))
      seenNames.set(name, 'const')                               // node:/javascript/function/call
      继续                                       // node:/javascript/control/loop/continue

    设 funcMatch = trimmed.match(/^函数\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)(?:\s*->\s*(.+))?$/)          // node:/javascript/data/declare
    如果 funcMatch:                             // node:/javascript/control/if
      设 name = funcMatch[1]          // node:/javascript/data/declare
      设 params = (funcMatch[2] || '').split(',').map(p => p.trim()).filter(Boolean)          // node:/javascript/data/declare
      设 retType = funcMatch[3] ? funcMatch[3].trim() : null          // node:/javascript/data/declare
      如果 kwSet.has(name):                             // node:/javascript/control/if
        errors.push({ line: lineNo, message: `函数名 '${name}' 与保留语法关键字冲突` })
      entries.push(new NamesEntry({ kind: 'func', name, params, return_type: retType, line: lineNo }))
      seenNames.set(name, 'func')                               // node:/javascript/function/call
      继续                                       // node:/javascript/control/loop/continue

    errors.push({ line: lineNo, message: `names 块中无法解析的条目: '${trimmed}'。必须为 库/变量/常量/函数 之一。` })

  返回 { entries, errors, env: new NamesEnv(entries) }                               // node:/javascript/function/return
// @jev-block:parse_names_003:end
