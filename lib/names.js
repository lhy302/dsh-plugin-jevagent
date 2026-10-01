// names.js — Symbol Universe parser and module-isolated environment
// Conforms to JevAgent Design Spec V2.0 Section 2, 12.5 & Engineering Spec V3.0 Section 8

export class NamesEntry {
  constructor({ kind, name, type = null, value = null, alias = null, params = [], return_type = null, line = 0 }) {
    this.kind = kind; // 'lib' | 'var' | 'const' | 'func'
    this.name = name;
    this.type = type;
    this.value = value;
    this.alias = alias || name;
    this.params = params;
    this.return_type = return_type;
    this.line = line;
  }
}

export class NamesEnv {
  constructor(entries = []) {
    this.libraries = new Map(); // name/alias -> entry
    this.variables = new Map(); // name -> entry
    this.constants = new Map(); // name -> entry
    this.functions = new Map(); // name -> entry

    for (const e of entries) {
      if (e.kind === 'lib') {
        this.libraries.set(e.name, e);
        if (e.alias && e.alias !== e.name) {
          this.libraries.set(e.alias, e);
        }
      } else if (e.kind === 'var') {
        this.variables.set(e.name, e);
      } else if (e.kind === 'const') {
        this.constants.set(e.name, e);
      } else if (e.kind === 'func') {
        this.functions.set(e.name, e);
      }
    }
  }

  hasSymbol(name) {
    return this.variables.has(name) || this.constants.has(name) || this.functions.has(name) || this.libraries.has(name);
  }

  getVariableType(name) {
    return this.variables.get(name)?.type || null;
  }

  getConstant(name) {
    return this.constants.get(name) || null;
  }

  hasLibrary(name) {
    return this.libraries.has(name);
  }

  hasVariable(name) {
    return this.variables.has(name);
  }

  hasFunction(name) {
    return this.functions.has(name);
  }

  toJSON() {
    return {
      libraries: Array.from(this.libraries.values()),
      variables: Array.from(this.variables.values()),
      constants: Array.from(this.constants.values()),
      functions: Array.from(this.functions.values())
    };
  }
}

export function parseNamesBlock(content, syntaxKeywords = []) {
  const entries = [];
  const errors = [];
  const lines = (content || '').split('\n');
  const seenNames = new Map(); // name -> kind

  const kwSet = new Set(syntaxKeywords || []);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }

    const lineNo = i + 1;

    // 1. 库 <module> [作为 <alias>]
    const libMatch = trimmed.match(/^库\s+([a-zA-Z0-9_\u4e00-\u9fa5\.\-:@/]+)(?:\s+作为\s+([a-zA-Z0-9_\u4e00-\u9fa5]+))?$/);
    if (libMatch) {
      const name = libMatch[1];
      const alias = libMatch[2] || name;
      if (kwSet.has(alias)) {
        errors.push({ line: lineNo, message: `库别名 '${alias}' 与保留语法关键字冲突` });
      }
      const entry = new NamesEntry({ kind: 'lib', name, alias, line: lineNo });
      entries.push(entry);
      seenNames.set(alias, 'lib');
      continue;
    }

    // 2. 变量 <name>[: <type>]
    const varMatch = trimmed.match(/^变量\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)(?:\s*:\s*([a-zA-Z0-9_\[\],\*\s]+))?$/);
    if (varMatch) {
      const name = varMatch[1];
      const type = varMatch[2] ? varMatch[2].trim() : null;
      if (kwSet.has(name)) {
        errors.push({ line: lineNo, message: `变量名 '${name}' 与保留语法关键字冲突` });
      }
      if (seenNames.has(name) && seenNames.get(name) !== 'var') {
        errors.push({ line: lineNo, message: `符号 '${name}' 重复定义冲突 (已有类型: ${seenNames.get(name)})` });
      }
      seenNames.set(name, 'var');
      entries.push(new NamesEntry({ kind: 'var', name, type, line: lineNo }));
      continue;
    }

    // 3. 常量 <name> = <value>
    const constMatch = trimmed.match(/^常量\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(.+)$/);
    if (constMatch) {
      const name = constMatch[1];
      const valStr = constMatch[2].trim();
      if (kwSet.has(name)) {
        errors.push({ line: lineNo, message: `常量名 '${name}' 与保留语法关键字冲突` });
      }
      let inferredType = 'str';
      let val = valStr;
      if (/^-?\d+$/.test(valStr)) {
        inferredType = 'int';
        val = parseInt(valStr, 10);
      } else if (/^-?\d+\.\d+$/.test(valStr)) {
        inferredType = 'float';
        val = parseFloat(valStr);
      } else if (valStr === 'True' || valStr === 'False' || valStr === '真' || valStr === '假') {
        inferredType = 'bool';
        val = (valStr === 'True' || valStr === '真');
      } else if (/^["'].*["']$/.test(valStr)) {
        inferredType = 'str';
        val = valStr.slice(1, -1);
      }
      entries.push(new NamesEntry({ kind: 'const', name, value: val, type: inferredType, line: lineNo }));
      seenNames.set(name, 'const');
      continue;
    }

    // 4. 函数 <name>(<params>) [-> <ret>]
    const funcMatch = trimmed.match(/^函数\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)(?:\s*->\s*(.+))?$/);
    if (funcMatch) {
      const name = funcMatch[1];
      const params = (funcMatch[2] || '').split(',').map(p => p.trim()).filter(Boolean);
      const retType = funcMatch[3] ? funcMatch[3].trim() : null;
      if (kwSet.has(name)) {
        errors.push({ line: lineNo, message: `函数名 '${name}' 与保留语法关键字冲突` });
      }
      entries.push(new NamesEntry({ kind: 'func', name, params, return_type: retType, line: lineNo }));
      seenNames.set(name, 'func');
      continue;
    }

    // Unrecognized line in names block
    errors.push({ line: lineNo, message: `names 块中无法解析的条目: '${trimmed}'。必须为 库/变量/常量/函数 之一。` });
  }

  return {
    entries,
    errors,
    env: new NamesEnv(entries)
  };
}
