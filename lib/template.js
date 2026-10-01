// template.js — Leaf template filling, specialized DSL rendering, and code generation
// Conforms to JevAgent Engineering Spec Section 4, 5 & V3.0 Spec

import { BlockSplitter } from './splitter.js';
import { NormalizeDsl } from './normalize.js';
import { findNearestCandidates } from './validator.js';

export class TemplateEngine {
  static LITERAL_MAP = {
    python: { '真': 'True', '假': 'False', '空': 'None', '且': 'and', '或': 'or', '非': 'not' },
    py: { '真': 'True', '假': 'False', '空': 'None', '且': 'and', '或': 'or', '非': 'not' },
    c: { '真': 'true', '假': 'false', '空': 'NULL', '且': '&&', '或': '||', '非': '!' },
    cpp: { '真': 'true', '假': 'false', '空': 'nullptr', '且': '&&', '或': '||', '非': '!' },
    javascript: { '真': 'true', '假': 'false', '空': 'null', '且': '&&', '或': '||', '非': '!' },
    js: { '真': 'true', '假': 'false', '空': 'null', '且': '&&', '或': '||', '非': '!' },
    typescript: { '真': 'true', '假': 'false', '空': 'null', '且': '&&', '或': '||', '非': '!' },
    ts: { '真': 'true', '假': 'false', '空': 'null', '且': '&&', '或': '||', '非': '!' },
    go: { '真': 'true', '假': 'false', '空': 'nil', '且': '&&', '或': '||', '非': '!' },
    rust: { '真': 'true', '假': 'false', '空': 'None', '且': '&&', '或': '||', '非': '!' },
    shell: { '真': 'true', '假': 'false', '空': '""', '且': '&&', '或': '||', '非': '!' },
    sh: { '真': 'true', '假': 'false', '空': '""', '且': '&&', '或': '||', '非': '!' },
    bash: { '真': 'true', '假': 'false', '空': '""', '且': '&&', '或': '||', '非': '!' }
  };

  static REV_LITERAL_MAP = {
    'True': '真', 'true': '真',
    'False': '假', 'false': '假',
    'None': '空', 'null': '空', 'NULL': '空', 'nullptr': '空', 'nil': '空'
  };

  static CORE_KEYWORDS = [
    '定义', '异步定义', '返回', '如果', '否则如果', '否则', '对于', '当', '跳出', '继续', '设', '输出', '输入',
    '引入', '从', '引入系统', '引入本地', '导出', '尝试', '捕获', '最终', '抛出', '等待', '原生'
  ];

  static replaceLiterals(expr, lang = 'python') {
    const lmap = this.LITERAL_MAP[lang] || this.LITERAL_MAP.python;
    let res = expr;
    for (const [k, v] of Object.entries(lmap)) {
      const regex = new RegExp(`(?<![a-zA-Z0-9_\\u4e00-\\u9fa5])${k}(?![a-zA-Z0-9_\\u4e00-\\u9fa5])`, 'g');
      res = res.replace(regex, v);
    }
    return res;
  }

  static renderSpecLine(specLine, nodePath, lang = 'python', node = null) {
    const raw = specLine.replace(/[\r\n]+$/, '');
    if (!raw.trim() || raw.trim().startsWith('#') || raw.trim().startsWith('//')) {
      return raw;
    }

    const { prefix } = BlockSplitter.getSyntax(lang);
    if (!nodePath) return raw;

    if (raw.includes('node:')) {
      return raw;
    }

    // Replace literals in spec line for target language
    let converted = this.replaceLiterals(raw, lang);

    if (node && node.spec_template) {
      if (nodePath.endsWith('/data/declare') && !converted.trim().startsWith('设 ')) {
        const indent = converted.match(/^\s*/)[0];
        converted = `${indent}设 ${converted.trim()}`;
      }
    }

    const pad = Math.max(1, 40 - converted.length);
    const spacing = ' '.repeat(pad);
    return `${converted}${spacing}${prefix} node:${nodePath}`;
  }

  static specLineToCode(specLine, lang = 'python', node = null, namesEnv = null) {
    let line = specLine.replace(/[\r\n]+$/, '');
    if (!line.trim()) return line;

    // Strip node annotation: e.g. # node:/... or // node:/... (including origin:auto etc.)
    const nodeMatch = line.match(/\s*(?:#|\/\/|--)\s*node:([^\s]+)/);
    const nodePath = nodeMatch ? nodeMatch[1] : '';
    line = line.replace(/\s*(?:#|\/\/|--)\s*node:.*$/, '').trimEnd();

    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    let trimmed = line.trim();

    const normLang = (lang || 'python').toLowerCase().trim();

    // Escape hatch check: 原生 <lang> "..."
    const rawEscapeMatch = trimmed.match(/^原生\s+([a-zA-Z0-9_\-]+)\s+["'](.*)["']$/);
    if (rawEscapeMatch) {
      return `${indent}${rawEscapeMatch[2]}`;
    }

    // Replace literals (真 -> True/true, 假 -> False/false, etc.)
    trimmed = this.replaceLiterals(trimmed, normLang);

    // Apply template if node provides one
    if (node && node.template && node.slots) {
      const templateApplied = this.tryApplyNodeTemplate(trimmed, indent, node, normLang);
      if (templateApplied !== null) {
        return templateApplied;
      }
    }

    if (normLang === 'python' || normLang === 'py') {
      return this.renderPythonCode(trimmed, indent, nodePath, namesEnv);
    } else if (normLang === 'c' || normLang === 'cpp') {
      return this.renderCCode(trimmed, indent, nodePath, namesEnv);
    } else if (normLang === 'shell' || normLang === 'sh' || normLang === 'bash') {
      return this.renderShellCode(trimmed, indent, nodePath, namesEnv);
    } else if (normLang === 'javascript' || normLang === 'js') {
      return this.renderJSCode(trimmed, indent, nodePath, namesEnv);
    }

    return this.renderGenericCode(trimmed, indent, normLang);
  }

  static tryApplyNodeTemplate(trimmed, indent, node, lang) {
    if (node.template === '{var} = {expr}' || node.template === '{var} = {expr};') {
      let cleanAssign = trimmed;
      if (cleanAssign.startsWith('设 ')) cleanAssign = cleanAssign.slice(2).trim();

      // Match pure assignment only; do NOT split compound assignments like +=, -=, *=, /=
      const m = cleanAssign.match(/^([^=<>!+\-*/%&|^]+?)\s*=(?!=)\s*(.+)$/);
      if (m) {
        const v = m[1].trim();
        const expr = m[2].trim();
        const semi = (lang === 'c' || lang === 'cpp' || lang === 'javascript' || lang === 'js') ? ';' : '';
        return `${indent}${v} = ${expr}${semi}`;
      }
    }
    return null;
  }

  static renderPythonCode(trimmed, indent, nodePath, namesEnv = null) {
    // 1. Module Imports
    if (trimmed.startsWith('引入 ')) {
      const parts = trimmed.slice(3).trim();
      const asMatch = parts.match(/^(\S+)\s+作为\s+(\S+)$/);
      if (asMatch) {
        return `${indent}import ${asMatch[1]} as ${asMatch[2]}`;
      }
      return `${indent}import ${parts}`;
    }
    if (trimmed.startsWith('从 ') && trimmed.includes(' 引入 ')) {
      const m = trimmed.match(/^从\s+(\S+)\s+引入\s+(.+)$/);
      if (m) {
        return `${indent}from ${m[1]} import ${m[2].trim()}`;
      }
    }
    if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
      return `${indent}${trimmed}`;
    }

    // 2. Function definition
    if (trimmed.startsWith('定义 ') || trimmed.startsWith('def ')) {
      const m = trimmed.match(/^(?:定义|def)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)(?:\s*->\s*(.+?))?:/);
      if (m) {
        const funcName = m[1];
        const args = m[2];
        const retType = m[3] ? ` -> ${m[3].trim()}` : '';
        return `${indent}def ${funcName}(${args})${retType}:`;
      }
    }

    // 3. Control flow
    if (trimmed.startsWith('如果 ')) {
      const cond = trimmed.slice(3).replace(/:$/, '').trim();
      return `${indent}if ${cond}:`;
    }
    if (trimmed.startsWith('否则如果 ')) {
      const cond = trimmed.slice(5).replace(/:$/, '').trim();
      return `${indent}elif ${cond}:`;
    }
    if (trimmed === '否则:' || trimmed === '否则') {
      return `${indent}else:`;
    }
    if (trimmed.startsWith('当 ')) {
      const cond = trimmed.slice(2).replace(/:$/, '').trim();
      return `${indent}while ${cond}:`;
    }
    if (trimmed.startsWith('对于 ')) {
      const m = trimmed.match(/^对于\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+中的\s+(.+?):/);
      if (m) {
        return `${indent}for ${m[1]} in ${m[2].trim()}:`;
      }
    }
    if (trimmed.startsWith('返回 ') || trimmed === '返回') {
      const expr = trimmed.slice(2).trim();
      return `${indent}return ${expr}`.trimEnd();
    }
    if (trimmed.startsWith('设 ')) {
      return `${indent}${trimmed.slice(2).trim()}`;
    }
    if (trimmed.startsWith('输出(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(3, -1);
      return `${indent}print(${inner})`;
    }
    if (trimmed.startsWith('输入(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(3, -1);
      return `${indent}input(${inner})`;
    }
    if (trimmed === '跳出') return `${indent}break`;
    if (trimmed === '继续') return `${indent}continue`;

    // 4. Assignments & Expressions
    if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.\[\]\+\-\s]+\s*(?:=|\+=|-=|\*=|\/=)(?!=)\s*.+$/.test(trimmed)) {
      return `${indent}${trimmed}`;
    }
    if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.]+\s*\([^;:]*\)$/.test(trimmed)) {
      return `${indent}${trimmed}`;
    }

    // Fallback: throw unknown_node error
    const token = trimmed.split(/[\s(:]/)[0];
    const suggestions = findNearestCandidates(token, TemplateEngine.CORE_KEYWORDS);
    throw new Error(`[unknown_node] '${trimmed}' 未命中关键字核；最近候选: ${suggestions.join(', ')}`);
  }

  static renderCCode(trimmed, indent, nodePath, namesEnv = null) {
    // 1. Module Includes
    if (trimmed.startsWith('引入系统 ') || trimmed.startsWith('引入本地 ') || trimmed.startsWith('引入 ')) {
      let header = trimmed.replace(/^引入(?:系统|本地)?\s+/, '').trim();
      const isSystem = trimmed.startsWith('引入系统 ') || (!header.startsWith('"') && !header.startsWith('<'));
      if (header.startsWith('<') || header.startsWith('"')) {
        return `${indent}#include ${header}`;
      }
      return isSystem ? `${indent}#include <${header}>` : `${indent}#include "${header}"`;
    }
    if (trimmed.startsWith('#include')) {
      return `${indent}${trimmed}`;
    }

    // 2. Function definition
    if (trimmed.startsWith('定义 ') || trimmed.startsWith('def ')) {
      const m = trimmed.match(/^(?:定义|def)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)(?:\s*->\s*(.+?))?:/);
      if (m) {
        const funcName = m[1];
        let args = m[2].trim();
        if (args) {
          args = args.split(',').map(param => {
            const p = param.trim();
            if (p.includes(':')) {
              const [pName, pType] = p.split(':').map(s => s.trim());
              const cType = pType === 'str' ? 'const char*' : (pType === 'bool' ? 'bool' : pType);
              const arrMatch = cType.match(/^(.+?)(\[.*\])$/);
              if (arrMatch) {
                return `${arrMatch[1].trim()} ${pName}${arrMatch[2].trim()}`;
              }
              return `${cType} ${pName}`;
            }
            // If type not declared in params, check namesEnv
            const envType = namesEnv?.getVariableType(p);
            if (envType) {
              const cType = envType === 'str' ? 'const char*' : (envType === 'bool' ? 'bool' : envType);
              const arrMatch = cType.match(/^(.+?)(\[.*\])$/);
              if (arrMatch) {
                return `${arrMatch[1].trim()} ${p}${arrMatch[2].trim()}`;
              }
              return `${cType} ${p}`;
            }
            return `int ${p}`;
          }).join(', ');
        }
        let retType = m[3] ? m[3].trim() : 'void';
        if (retType === 'str') retType = 'const char*';
        return `${indent}${retType} ${funcName}(${args}) {`;
      }
    }

    // 3. Control flow
    if (trimmed.startsWith('如果 ')) {
      const cond = trimmed.slice(3).replace(/:$/, '').trim();
      return `${indent}if (${cond}) {`;
    }
    if (trimmed.startsWith('否则如果 ')) {
      const cond = trimmed.slice(5).replace(/:$/, '').trim();
      return `${indent}} else if (${cond}) {`;
    }
    if (trimmed === '否则:' || trimmed === '否则') {
      return `${indent}} else {`;
    }
    if (trimmed.startsWith('当 ')) {
      const cond = trimmed.slice(2).replace(/:$/, '').trim();
      return `${indent}while (${cond}) {`;
    }
    if (trimmed.startsWith('对于 ')) {
      const m = trimmed.match(/^对于\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+中的\s+(.+?):/);
      if (m) {
        const v = m[1];
        const iter = m[2].trim();
        // Check if length variable exists in namesEnv
        let lengthVar = '10';
        if (namesEnv && (namesEnv.hasVariable('长度') || namesEnv.hasVariable('len'))) {
          lengthVar = namesEnv.hasVariable('长度') ? '长度' : 'len';
        } else if (/^\d+$/.test(iter)) {
          lengthVar = iter;
        }
        return `${indent}for (int ${v} = 0; ${v} < ${lengthVar}; ${v}++) {`;
      }
    }
    if (trimmed.startsWith('返回 ') || trimmed === '返回') {
      const expr = trimmed.slice(2).trim();
      const endsWithOpenDelim = expr.endsWith('{') || expr.endsWith('[') || expr.endsWith('(');
      const semi = (!expr.endsWith(';') && !endsWithOpenDelim) ? ';' : '';
      return `${indent}return ${expr}${semi}`.replace(/;;$/, ';');
    }
    if (trimmed.startsWith('设 ')) {
      let decl = trimmed.slice(2).trim().replace(/;$/, '');
      decl = decl.replace(/\b等待\s+/g, 'await ');

      const formatCDecl = (rawType, name, expr = null) => {
        let t = rawType === 'str' ? 'const char*' : (rawType === 'bool' ? 'bool' : rawType);
        const arrMatch = t ? t.match(/^(.+?)(\[.*\])$/) : null;
        let declStr = '';
        if (arrMatch) {
          const baseType = arrMatch[1].trim();
          const arrSuffix = arrMatch[2].trim();
          declStr = `${baseType} ${name}${arrSuffix}`;
        } else {
          declStr = `${t || 'int'} ${name}`;
        }
        return expr !== null ? `${indent}${declStr} = ${expr};` : `${indent}${declStr};`;
      };

      if (decl.includes(':') && decl.includes('=')) {
        const eqIdx = decl.indexOf('=');
        const left = decl.slice(0, eqIdx).trim();
        const expr = decl.slice(eqIdx + 1).trim();
        const [varName, varType] = left.split(':').map(s => s.trim());
        return formatCDecl(varType, varName, expr);
      } else if (decl.includes(':')) {
        const [varName, varType] = decl.split(':').map(s => s.trim());
        return formatCDecl(varType, varName);
      } else if (decl.includes('=')) {
        const eqIdx = decl.indexOf('=');
        const varName = decl.slice(0, eqIdx).trim();
        const expr = decl.slice(eqIdx + 1).trim();
        let inferredType = namesEnv?.getVariableType(varName) || 'int';
        if (inferredType === 'int') {
          if (/^\d+\.\d+$/.test(expr)) inferredType = 'double';
          else if (expr === 'true' || expr === 'false' || expr === '真' || expr === '假') inferredType = 'bool';
          else if (expr.startsWith('"')) inferredType = 'const char*';
        }
        return formatCDecl(inferredType, varName, expr);
      }
      const inferredType = namesEnv?.getVariableType(decl) || 'int';
      return formatCDecl(inferredType, decl);
    }

    // 4. Output: type-driven format specifier (%d for int, %s for str)
    if (trimmed.startsWith('输出(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(3, -1).trim();
      const varType = namesEnv?.getVariableType(inner);
      let fmt = '%d'; // Default to %d for integers / numbers in C
      if (varType === 'str' || varType === 'string' || inner.startsWith('"') || inner.startsWith("'")) {
        fmt = '%s';
      } else if (varType === 'float' || varType === 'double') {
        fmt = '%f';
      }
      return `${indent}printf("${fmt}\\n", ${inner});`;
    }
    if (trimmed.startsWith('输入(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(3, -1).trim();
      return `${indent}scanf("%d", &${inner});`;
    }

    if (trimmed === '跳出') return `${indent}break;`;
    if (trimmed === '继续') return `${indent}continue;`;

    // Assignments & Function calls
    if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.\[\]\+\-\s]+\s*(?:=|\+=|-=|\*=|\/=)(?!=)\s*.+$/.test(trimmed)) {
      const semi = !trimmed.endsWith(';') ? ';' : '';
      return `${indent}${trimmed}${semi}`;
    }
    // Standalone function/method calls (single-line or multiline opening)
    if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.]+\s*\(/.test(trimmed) && 
        !trimmed.startsWith('if') && !trimmed.startsWith('while') && !trimmed.startsWith('for') && !trimmed.startsWith('catch')) {
      const endsWithOpenDelim = trimmed.endsWith('{') || trimmed.endsWith('[') || trimmed.endsWith('(') || trimmed.endsWith(',');
      const semi = (!trimmed.endsWith(';') && !endsWithOpenDelim) ? ';' : '';
      return `${indent}${trimmed}${semi}`;
    }

    // Fallback: throw unknown_node error
    const token = trimmed.split(/[\s(:]/)[0];
    const suggestions = findNearestCandidates(token, TemplateEngine.CORE_KEYWORDS);
    throw new Error(`[unknown_node] '${trimmed}' 未命中关键字核；最近候选: ${suggestions.join(', ')}`);
  }

  static renderShellCode(trimmed, indent, nodePath, namesEnv = null) {
    // 1. Source / Module import
    if (trimmed.startsWith('引入 ')) {
      const pathArg = trimmed.slice(3).trim();
      return `${indent}. ${pathArg}`;
    }
    if (trimmed.startsWith('. ') || trimmed.startsWith('source ')) {
      return `${indent}${trimmed}`;
    }

    // 2. Function definition
    if (trimmed.startsWith('定义 ') || trimmed.startsWith('function ')) {
      const m = trimmed.match(/^(?:定义|function)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)/);
      if (m) {
        return `${indent}${m[1]}() {`;
      }
    }
    if (/^[a-zA-Z0-9_\u4e00-\u9fa5]+\s*\(\)\s*\{?$/.test(trimmed)) {
      return `${indent}${trimmed.replace(/\s*\{?$/, '() {')}`;
    }

    // 3. Control flow
    if (trimmed.startsWith('如果 ')) {
      let cond = trimmed.slice(3).replace(/:$/, '').trim();
      cond = this.convertShellCondition(cond);
      return `${indent}if [ ${cond} ]; then`;
    }
    if (trimmed.startsWith('否则如果 ')) {
      let cond = trimmed.slice(5).replace(/:$/, '').trim();
      cond = this.convertShellCondition(cond);
      return `${indent}elif [ ${cond} ]; then`;
    }
    if (trimmed === '否则:' || trimmed === '否则') {
      return `${indent}else`;
    }
    if (trimmed.startsWith('对于 ')) {
      const m = trimmed.match(/^对于\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+中的\s+(.+?):/);
      if (m) {
        return `${indent}for ${m[1]} in ${m[2].trim()}; do`;
      }
    }
    if (trimmed.startsWith('当 ')) {
      let cond = trimmed.slice(2).replace(/:$/, '').trim();
      cond = this.convertShellCondition(cond);
      return `${indent}while [ ${cond} ]; do`;
    }
    if (trimmed.startsWith('返回 ') || trimmed === '返回') {
      const expr = trimmed.slice(2).trim();
      return `${indent}return ${expr}`.trimEnd();
    }
    if (trimmed.startsWith('设 ')) {
      const decl = trimmed.slice(2).trim();
      const m = decl.match(/^([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(.+)$/);
      if (m) {
        const v = m[1];
        const expr = m[2].trim();
        if (/[+\-*/]/.test(expr) && !expr.startsWith('"')) {
          return `${indent}${v}=$(( ${expr} ))`;
        }
        return `${indent}${v}=${expr}`;
      }
      return `${indent}${decl}`;
    }

    // 4. Output: echo "$i" or echo "str"
    if (trimmed.startsWith('输出(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(3, -1).trim();
      if (/^[a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*$/.test(inner)) {
        return `${indent}echo "$${inner}"`;
      }
      const unquoted = inner.replace(/^["']|["']$/g, '');
      return `${indent}echo "${unquoted}"`;
    }

    if (trimmed.startsWith('输入(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(3, -1).trim();
      return `${indent}read -r ${inner}`;
    }

    if (trimmed === '跳出') return `${indent}break`;
    if (trimmed === '继续') return `${indent}continue`;

    // 5. Assignments (e.g. i = i + 1)
    const assignM = trimmed.match(/^([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(.+)$/);
    if (assignM) {
      const v = assignM[1];
      const expr = assignM[2].trim();
      if (/[+\-*/]/.test(expr) && !expr.startsWith('"')) {
        return `${indent}${v}=$(( ${expr} ))`;
      }
      return `${indent}${v}=${expr}`;
    }

    // 6. Function calls (e.g. backup or func(x))
    const callM = trimmed.match(/^([a-zA-Z0-9_\u4e00-\u9fa5]+)(?:\((.*?)\))?$/);
    if (callM && !TemplateEngine.CORE_KEYWORDS.includes(callM[1])) {
      const func = callM[1];
      const args = (callM[2] || '').split(',').map(s => s.trim()).join(' ');
      return `${indent}${func} ${args}`.trimEnd();
    }

    // Fallback: throw unknown_node error
    const token = trimmed.split(/[\s(:]/)[0];
    const suggestions = findNearestCandidates(token, TemplateEngine.CORE_KEYWORDS);
    throw new Error(`[unknown_node] '${trimmed}' 未命中关键字核；最近候选: ${suggestions.join(', ')}`);
  }

  static convertShellCondition(cond) {
    // If condition already starts with test operator (e.g. -f $f)
    if (/^-[a-zA-Z]\s+/.test(cond)) {
      return cond;
    }
    // Replace operators
    let converted = cond
      .replace(/<=/g, '-le')
      .replace(/>=/g, '-ge')
      .replace(/(?<![=<>!])<(?![=<>!])/g, '-lt')
      .replace(/(?<![=<>!])>(?![=<>!])/g, '-gt')
      .replace(/==/g, '-eq')
      .replace(/!=/g, '-ne');

    // Ensure bare identifiers are quoted with $
    const parts = converted.split(/\s+/);
    const convertedParts = parts.map(p => {
      if (/^[a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*$/.test(p) && !p.startsWith('-')) {
        return `"$${p}"`;
      }
      return p;
    });
    return convertedParts.join(' ');
  }

  // Indentation-aware C bracket closure algorithm
  static specLinesToCCode(specLines, table = null, namesEnv = null) {
    const rawLines = [];
    const indentStack = [];

    for (let i = 0; i < specLines.length; i++) {
      const line = specLines[i];
      if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#')) {
        rawLines.push(line);
        continue;
      }

      const indentMatch = line.match(/^(\s*)/);
      const currentIndent = indentMatch ? indentMatch[1].length : 0;
      const trimmed = line.trim();

      // If indent decreased, close corresponding braces
      while (
        indentStack.length > 0 &&
        currentIndent <= indentStack[indentStack.length - 1].indent &&
        !trimmed.startsWith('否则') &&
        !trimmed.startsWith('else') &&
        !trimmed.startsWith('elif')
      ) {
        const top = indentStack.pop();
        rawLines.push(`${' '.repeat(top.indent)}}`);
      }

      const nodeMatch = line.match(/\s*(?:#|\/\/|--)\s*node:([^\s]+)/);
      const node = nodeMatch ? table?.nodes?.[nodeMatch[1]] : null;
      const rendered = this.specLineToCode(line, 'c', node, namesEnv);
      rawLines.push(rendered);

      if (rendered.trim().endsWith('{')) {
        indentStack.push({ indent: currentIndent });
      }
    }

    // Close any remaining open braces
    while (indentStack.length > 0) {
      const top = indentStack.pop();
      rawLines.push(`${' '.repeat(top.indent)}}`);
    }

    return rawLines;
  }

  // Indentation-aware Shell block closure algorithm (done, fi, })
  static specLinesToShellCode(specLines, table = null, namesEnv = null) {
    const rawLines = [];
    const blockStack = [];

    for (let i = 0; i < specLines.length; i++) {
      const line = specLines[i];
      if (!line.trim() || line.trim().startsWith('#') || line.trim().startsWith('//')) {
        rawLines.push(line);
        continue;
      }

      const indentMatch = line.match(/^(\s*)/);
      const currentIndent = indentMatch ? indentMatch[1].length : 0;
      const trimmed = line.trim();

      // If indent decreased, close corresponding shell blocks
      while (
        blockStack.length > 0 &&
        currentIndent <= blockStack[blockStack.length - 1].indent &&
        !trimmed.startsWith('否则') &&
        !trimmed.startsWith('else') &&
        !trimmed.startsWith('elif')
      ) {
        const top = blockStack.pop();
        if (top.type === 'loop') {
          rawLines.push(`${' '.repeat(top.indent)}done`);
        } else if (top.type === 'if') {
          rawLines.push(`${' '.repeat(top.indent)}fi`);
        } else if (top.type === 'func') {
          rawLines.push(`${' '.repeat(top.indent)}}`);
        }
      }

      const rendered = this.specLineToCode(line, 'shell', null, namesEnv);
      rawLines.push(rendered);

      if (rendered.trim().startsWith('while ') || rendered.trim().includes('; do')) {
        blockStack.push({ indent: currentIndent, type: 'loop' });
      } else if (rendered.trim().startsWith('for ') || rendered.trim().includes('; do')) {
        blockStack.push({ indent: currentIndent, type: 'loop' });
      } else if (rendered.trim().startsWith('if ') || rendered.trim().includes('; then')) {
        blockStack.push({ indent: currentIndent, type: 'if' });
      } else if (rendered.trim().endsWith('() {')) {
        blockStack.push({ indent: currentIndent, type: 'func' });
      }
    }

    while (blockStack.length > 0) {
      const top = blockStack.pop();
      if (top.type === 'loop') {
        rawLines.push(`${' '.repeat(top.indent)}done`);
      } else if (top.type === 'if') {
        rawLines.push(`${' '.repeat(top.indent)}fi`);
      } else if (top.type === 'func') {
        rawLines.push(`${' '.repeat(top.indent)}}`);
      }
    }

    return rawLines;
  }

  static renderJSCode(trimmed, indent, nodePath, namesEnv = null) {
    if (trimmed === '}' || trimmed === '};' || trimmed === '},' || trimmed === ']);' || trimmed === '])' || trimmed === ']') {
      const semi = (!trimmed.endsWith(';') && !trimmed.endsWith(',')) ? ';' : '';
      return `${indent}${trimmed}${semi}`;
    }
    // 1. Module Imports & Exports
    if (trimmed.startsWith('引入 ') || trimmed.startsWith('从 ')) {
      if (trimmed.startsWith('从 ') && trimmed.includes(' 引入 ')) {
        const m = trimmed.match(/^从\s+['"]?([^'"]+)['"]?\s+引入\s+(.+)$/);
        if (m) {
          const mod = m[1].trim();
          let names = m[2].trim();
          if (!names.startsWith('{') && !names.startsWith('*') && !names.startsWith('default')) {
            if (names.includes(',')) {
              names = `{ ${names} }`;
            }
          }
          return `${indent}import ${names} from '${mod}';`;
        }
      }
      const impFromMatch = trimmed.match(/^引入\s+(.+?)\s+从\s+['"]?([^'"]+)['"]?$/);
      if (impFromMatch) {
        let names = impFromMatch[1].trim();
        const mod = impFromMatch[2].trim();
        return `${indent}import ${names} from '${mod}';`;
      }
      const impAsMatch = trimmed.match(/^引入\s+['"]?([^'"]+)['"]?\s+作为\s+(\S+)$/);
      if (impAsMatch) {
        return `${indent}import * as ${impAsMatch[2]} from '${impAsMatch[1]}';`;
      }
      const parts = trimmed.slice(3).trim();
      if (parts.startsWith('{') || parts.startsWith('*') || parts.includes(' from ')) {
        return `${indent}import ${parts};`.replace(/;;$/, ';');
      }
      const cleanParts = parts.replace(/^['"]|['"]$/g, '');
      if (cleanParts.startsWith('node:') || cleanParts.includes('/') || cleanParts.startsWith('.')) {
        return `${indent}import '${cleanParts}';`;
      }
      return `${indent}import ${cleanParts} from '${cleanParts}';`;
    }
    if (trimmed.startsWith('导出 ')) {
      const rest = trimmed.slice(3).trim();
      if (rest.startsWith('定义 ') || rest.startsWith('function ')) {
        const inner = this.renderJSCode(rest, '', nodePath, namesEnv);
        return `${indent}export ${inner}`;
      }
      if (rest.startsWith('异步定义 ') || rest.startsWith('async function ')) {
        const inner = this.renderJSCode(rest, '', nodePath, namesEnv);
        return `${indent}export ${inner}`;
      }
      if (rest.startsWith('类 ') || rest.startsWith('class ')) {
        const inner = this.renderJSCode(rest, '', nodePath, namesEnv);
        return `${indent}export ${inner}`;
      }
      if (rest.startsWith('设 ') || rest.startsWith('变量 ')) {
        const inner = this.renderJSCode(rest, '', nodePath, namesEnv);
        return `${indent}export ${inner}`;
      }
      if (rest.startsWith('默认 ') || rest.startsWith('default ')) {
        const sub = rest.replace(/^(?:默认|default)\s+/, '').trim();
        const inner = this.renderJSCode(sub, '', nodePath, namesEnv);
        return `${indent}export default ${inner}`;
      }
      if (rest.startsWith('{') || rest.includes(' from ')) {
        return `${indent}export ${rest};`.replace(/;;$/, ';');
      }
      return `${indent}export { ${rest} };`;
    }
    if (trimmed.startsWith('类 ') || trimmed.startsWith('class ')) {
      const m = trimmed.match(/^(?:类|class)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)(?:\s+(?:继承|extends)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+))?:?$/);
      if (m) {
        const ext = m[2] ? ` extends ${m[2]}` : '';
        return `${indent}class ${m[1]}${ext} {`;
      }
      const raw = trimmed.replace(/^(?:类|class)\s+/, '').replace(/:$/, '').trim();
      return `${indent}class ${raw} {`;
    }
    if (trimmed.startsWith('等待 ')) {
      const expr = trimmed.slice(3).trim();
      const semi = !expr.endsWith(';') ? ';' : '';
      return `${indent}await ${expr}${semi}`;
    }
    if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) {
      return `${indent}${trimmed}${trimmed.endsWith(';') ? '' : ';'}`;
    }

    // 2. Function definition (standard & async & class methods)
    if (trimmed.startsWith('静态 方法 ') || trimmed.startsWith('方法 ') || trimmed.startsWith('静态 异步 方法 ') || trimmed.startsWith('异步 方法 ')) {
      const isStatic = trimmed.includes('静态 ');
      const isAsync = trimmed.includes('异步 ');
      const m = trimmed.match(/(?:方法)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)/);
      if (m) {
        const prefixStr = (isStatic ? 'static ' : '') + (isAsync ? 'async ' : '');
        return `${indent}${prefixStr}${m[1]}(${m[2]}) {`;
      }
    }
    if (trimmed.startsWith('异步定义 ')) {
      const m = trimmed.match(/^异步定义\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)(?:\s*->\s*(.+?))?:/);
      if (m) {
        const rawArgs = m[2].trim();
        const cleanArgs = rawArgs ? rawArgs.split(',').map(a => a.trim().split(':')[0].trim()).join(', ') : '';
        return `${indent}async function ${m[1]}(${cleanArgs}) {`;
      }
      const rawFn = trimmed.slice(5).replace(/:$/, '').trim();
      return `${indent}async function ${rawFn} {`;
    }
    if (trimmed.startsWith('定义 ') || trimmed.startsWith('function ')) {
      const m = trimmed.match(/^(?:定义|function)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)(?:\s*->\s*(.+?))?:/);
      if (m) {
        const rawArgs = m[2].trim();
        const cleanArgs = rawArgs ? rawArgs.split(',').map(a => a.trim().split(':')[0].trim()).join(', ') : '';
        return `${indent}function ${m[1]}(${cleanArgs}) {`;
      }
      const rawFn = trimmed.replace(/^(?:定义|function)\s+/, '').replace(/:$/, '').trim();
      return `${indent}function ${rawFn} {`;
    }

    // 3. Control flow
    if (trimmed.startsWith('如果 ')) {
      const cond = trimmed.slice(3).replace(/:$/, '').trim();
      return `${indent}if (${cond}) {`;
    }
    if (trimmed.startsWith('否则如果 ')) {
      const cond = trimmed.slice(5).replace(/:$/, '').trim();
      return `${indent}} else if (${cond}) {`;
    }
    if (trimmed === '否则:' || trimmed === '否则') {
      return `${indent}} else {`;
    }
    if (trimmed.startsWith('当 ')) {
      const cond = trimmed.slice(2).replace(/:$/, '').trim();
      return `${indent}while (${cond}) {`;
    }
    if (trimmed.startsWith('对于 ')) {
      const m = trimmed.match(/^对于\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+中的\s+(.+?):/);
      if (m) {
        const v = m[1];
        const iter = m[2].trim();
        const rangeM = iter.match(/^range\((.*?)\)$/);
        if (rangeM) {
          const args = rangeM[1].split(',').map(s => s.trim());
          if (args.length === 1) {
            return `${indent}for (let ${v} = 0; ${v} < ${args[0]}; ${v}++) {`;
          } else if (args.length >= 2) {
            return `${indent}for (let ${v} = ${args[0]}; ${v} < ${args[1]}; ${v}++) {`;
          }
        }
        return `${indent}for (const ${v} of ${iter}) {`;
      }
    }
    if (trimmed.startsWith('返回 ') || trimmed === '返回') {
      const expr = trimmed.slice(2).trim();
      const endsWithOpenDelim = expr.endsWith('{') || expr.endsWith('[') || expr.endsWith('(');
      const semi = (!expr.endsWith(';') && !endsWithOpenDelim) ? ';' : '';
      return `${indent}return ${expr}${semi}`.replace(/;;$/, ';');
    }

    // 4. Error handling
    if (trimmed === '尝试:' || trimmed === '尝试') {
      return `${indent}try {`;
    }
    if (trimmed.startsWith('捕获 ')) {
      const err = trimmed.slice(3).replace(/:$/, '').trim();
      return `${indent}} catch (${err || 'err'}) {`;
    }
    if (trimmed === '最终:' || trimmed === '最终') {
      return `${indent}} finally {`;
    }
    if (trimmed.startsWith('抛出 ')) {
      const expr = trimmed.slice(3).trim();
      return `${indent}throw ${expr};`.replace(/;;$/, ';');
    }

    // 5. Variables & Declarations
    if (trimmed.startsWith('设 ')) {
      let decl = trimmed.slice(2).trim().replace(/;$/, '');
      if (decl.includes(':') && decl.includes('=')) {
        const eqIdx = decl.indexOf('=');
        const left = decl.slice(0, eqIdx).trim();
        const expr = decl.slice(eqIdx + 1).trim();
        const varName = left.split(':')[0].trim();
        const varType = left.split(':')[1]?.trim() || '';
        const kw = varType === 'let' || varType === 'var' ? 'let' : 'const';
        const endsWithOpenDelim = expr.endsWith('{') || expr.endsWith('[') || expr.endsWith('(');
        const semi = (!expr.endsWith(';') && !endsWithOpenDelim) ? ';' : '';
        return `${indent}${kw} ${varName} = ${expr}${semi}`;
      } else if (decl.includes('=')) {
        const eqIdx = decl.indexOf('=');
        const varName = decl.slice(0, eqIdx).trim();
        const expr = decl.slice(eqIdx + 1).trim();
        const endsWithOpenDelim = expr.endsWith('{') || expr.endsWith('[') || expr.endsWith('(');
        const semi = (!expr.endsWith(';') && !endsWithOpenDelim) ? ';' : '';
        return `${indent}const ${varName} = ${expr}${semi}`;
      }
      return `${indent}let ${decl};`;
    }

    // 6. IO output / input
    if (trimmed.startsWith('输出(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(3, -1);
      return `${indent}console.log(${inner});`;
    }
    if (trimmed.startsWith('输入(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(3, -1);
      return `${indent}prompt(${inner});`;
    }

    if (trimmed === '跳出') return `${indent}break;`;
    if (trimmed === '继续') return `${indent}continue;`;

    // 7. Assignments & Expressions
    if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.\[\]\+\-\s]+\s*(?:=|\+=|-=|\*=|\/=)(?!=)\s*.+$/.test(trimmed)) {
      const semi = !trimmed.endsWith(';') ? ';' : '';
      return `${indent}${trimmed}${semi}`;
    }
    if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.]+\s*\(/.test(trimmed) && 
        !trimmed.startsWith('if') && !trimmed.startsWith('while') && !trimmed.startsWith('for') && !trimmed.startsWith('catch')) {
      const endsWithOpenDelim = trimmed.endsWith('{') || trimmed.endsWith('[') || trimmed.endsWith('(') || trimmed.endsWith(',');
      const semi = (!trimmed.endsWith(';') && !endsWithOpenDelim) ? ';' : '';
      return `${indent}${trimmed}${semi}`;
    }

    // Object property or array entry inside multiline literal (e.g. key: value,)
    if (/^[a-zA-Z0-9_\u4e00-\u9fa5$'"]+:\s*.+,?$/.test(trimmed)) {
      return `${indent}${trimmed}`;
    }
    // Expression inside multiline array or arguments (e.g. 'str', or fn(x),)
    if (/^.+[,;]$/.test(trimmed) && !trimmed.startsWith('if') && !trimmed.startsWith('while')) {
      return `${indent}${trimmed}`;
    }

    // Fallback: throw unknown_node error
    const token = trimmed.split(/[\s(:]/)[0];
    const suggestions = findNearestCandidates(token, TemplateEngine.CORE_KEYWORDS);
    throw new Error(`[unknown_node] '${trimmed}' 未命中关键字核；最近候选: ${suggestions.join(', ')}`);
  }

  // Indentation-aware JavaScript block closure algorithm
  static specLinesToJSCode(specLines, table = null, namesEnv = null) {
    const rawLines = [];
    const indentStack = [];

    for (let i = 0; i < specLines.length; i++) {
      const line = specLines[i];
      if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#')) {
        rawLines.push(line);
        continue;
      }

      const indentMatch = line.match(/^(\s*)/);
      const currentIndent = indentMatch ? indentMatch[1].length : 0;
      const trimmed = line.trim();

      // Check if original spec line was an indented block statement (ends with ':')
      const cleanDsl = trimmed.replace(/\s*(?:#|\/\/|--)\s*node:.*$/, '').trim();
      const isBlockStatement = cleanDsl.endsWith(':') ||
        cleanDsl.startsWith('导出 类') || cleanDsl.startsWith('类') ||
        cleanDsl.startsWith('导出 定义') || cleanDsl.startsWith('定义') ||
        cleanDsl.startsWith('导出 异步定义') || cleanDsl.startsWith('异步定义') ||
        cleanDsl.startsWith('方法') || cleanDsl.startsWith('静态 方法') ||
        cleanDsl.startsWith('如果') || cleanDsl.startsWith('否则如果') || cleanDsl.startsWith('否则') ||
        cleanDsl.startsWith('对于') || cleanDsl.startsWith('当') ||
        cleanDsl.startsWith('尝试') || cleanDsl.startsWith('捕获') || cleanDsl.startsWith('最终');

      const isChainedBranch = cleanDsl.startsWith('否则') || cleanDsl.startsWith('else') || cleanDsl.startsWith('elif') || 
        cleanDsl.startsWith('捕获') || cleanDsl.startsWith('最终') || cleanDsl.startsWith('catch') || cleanDsl.startsWith('finally');

      if (isChainedBranch) {
        while (indentStack.length > 0 && currentIndent < indentStack[indentStack.length - 1].indent) {
          const top = indentStack.pop();
          rawLines.push(`${' '.repeat(top.indent)}}`);
        }
        if (indentStack.length > 0 && indentStack[indentStack.length - 1].indent === currentIndent) {
          indentStack.pop();
        }
      } else {
        while (indentStack.length > 0 && currentIndent <= indentStack[indentStack.length - 1].indent) {
          const top = indentStack.pop();
          rawLines.push(`${' '.repeat(top.indent)}}`);
        }
      }

      const nodeMatch = line.match(/\s*(?:#|\/\/|--)\s*node:([^\s]+)/);
      const node = nodeMatch ? table?.nodes?.[nodeMatch[1]] : null;
      const rendered = this.specLineToCode(line, 'javascript', node, namesEnv);
      rawLines.push(rendered);

      // ONLY push onto indentStack if it was an indented BLOCK statement that opened a block
      if (isBlockStatement && rendered.trim().endsWith('{')) {
        indentStack.push({ indent: currentIndent });
      }
    }

    while (indentStack.length > 0) {
      const top = indentStack.pop();
      rawLines.push(`${' '.repeat(top.indent)}}`);
    }

    return rawLines;
  }

  static renderGenericCode(trimmed, indent, lang) {
    return `${indent}${trimmed}`;
  }

  static codeLineToSpec(codeLine, lang = 'python', node = null, seenVars = null) {
    const raw = codeLine.replace(/[\r\n]+$/, '');
    if (!raw.trim()) return raw;

    const indentMatch = raw.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    const trimmed = raw.trim();

    const { prefix } = BlockSplitter.getSyntax(lang);

    if (lang === 'python' || lang === 'py') {
      if (trimmed.startsWith('import ')) {
        const parts = trimmed.slice(7).trim();
        const asMatch = parts.match(/^(\S+)\s+as\s+(\S+)$/);
        if (asMatch) {
          return `${indent}引入 ${asMatch[1]} 作为 ${asMatch[2]}              ${prefix} node:/python/module/import origin:declared`;
        }
        return `${indent}引入 ${parts}                             ${prefix} node:/python/module/import origin:declared`;
      }
      if (trimmed.startsWith('from ')) {
        const m = trimmed.match(/^from\s+(\S+)\s+import\s+(.+)$/);
        if (m) {
          return `${indent}从 ${m[1]} 引入 ${m[2]}                   ${prefix} node:/python/module/from_import origin:declared`;
        }
      }
      if (trimmed.startsWith('def ')) {
        const m = trimmed.match(/^def\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)(?:\s*->\s*(.+?))?:/);
        if (m) {
          const ret = m[3] ? ` -> ${m[3]}` : '';
          return `${indent}定义 ${m[1]}(${m[2]})${ret}:                    ${prefix} node:/python/function/define`;
        }
      }
      if (trimmed.startsWith('if ')) {
        const cond = trimmed.slice(3).replace(/:$/, '');
        return `${indent}如果 ${cond}:                             ${prefix} node:/python/control/if`;
      }
      if (trimmed.startsWith('elif ')) {
        const cond = trimmed.slice(5).replace(/:$/, '');
        return `${indent}否则如果 ${cond}:                         ${prefix} node:/python/control/elif`;
      }
      if (trimmed === 'else:') {
        return `${indent}否则:                                     ${prefix} node:/python/control/else`;
      }
      if (trimmed.startsWith('for ')) {
        const m = trimmed.match(/^for\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+in\s+(.+?):/);
        if (m) {
          return `${indent}对于 ${m[1]} 中的 ${m[2]}:               ${prefix} node:/python/control/loop/for`;
        }
      }
      if (trimmed.startsWith('while ')) {
        const cond = trimmed.slice(6).replace(/:$/, '');
        return `${indent}当 ${cond}:                               ${prefix} node:/python/control/loop/while`;
      }
      if (trimmed === 'break') {
        return `${indent}跳出                                       ${prefix} node:/python/control/loop/break`;
      }
      if (trimmed === 'continue') {
        return `${indent}继续                                       ${prefix} node:/python/control/loop/continue`;
      }
      if (trimmed.startsWith('return ') || trimmed === 'return') {
        const expr = trimmed.slice(6).trim();
        return `${indent}返回 ${expr}                               ${prefix} node:/python/function/return`.trimEnd();
      }
      if (trimmed.startsWith('print(') && trimmed.endsWith(')')) {
        const inner = trimmed.slice(6, -1);
        return `${indent}输出(${inner})                            ${prefix} node:/python/io/output`;
      }
      if (trimmed.startsWith('input(') && trimmed.endsWith(')')) {
        const inner = trimmed.slice(6, -1);
        return `${indent}输入(${inner})                            ${prefix} node:/python/io/input`;
      }

      if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.]+\s*\([^;:]*\)$/.test(trimmed)) {
        return `${indent}${trimmed}                               ${prefix} node:/python/function/call`;
      }

      const assignMatch = trimmed.match(/^([a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*)\s*=\s*(.+)$/);
      if (assignMatch) {
        const varName = assignMatch[1];
        if (seenVars && !seenVars.has(varName)) {
          seenVars.add(varName);
          return `${indent}设 ${trimmed}                               ${prefix} node:/python/data/declare`;
        } else {
          return `${indent}${trimmed}                               ${prefix} node:/python/data/assign`;
        }
      }

      if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.\[\]\s]+\s*(?:=|\+=|-=|\*=|\/=)(?!=)\s*.+$/.test(trimmed)) {
        return `${indent}${trimmed}                               ${prefix} node:/python/data/assign`;
      }
    } else if (lang === 'c' || lang === 'cpp') {
      if (trimmed.startsWith('#include')) {
        const sysM = trimmed.match(/^#include\s+<([^>]+)>/);
        if (sysM) {
          return `${indent}引入系统 ${sysM[1]}                         ${prefix} node:/c/module/include_system origin:declared`;
        }
        const locM = trimmed.match(/^#include\s+"([^"]+)"/);
        if (locM) {
          return `${indent}引入本地 ${locM[1]}                         ${prefix} node:/c/module/include_local origin:declared`;
        }
      }
      if (trimmed === 'break;' || trimmed === 'break') {
        return `${indent}跳出                                       ${prefix} node:/c/control/loop/break`;
      }
      if (trimmed === 'continue;' || trimmed === 'continue') {
        return `${indent}继续                                       ${prefix} node:/c/control/loop/continue`;
      }
      if (trimmed.startsWith('return')) {
        const expr = trimmed.slice(6).replace(/;$/, '').trim();
        return `${indent}返回 ${expr}                               ${prefix} node:/c/function/return`;
      }
      if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.]+\s*\([^;:]*\)\s*;?$/.test(trimmed) && !trimmed.startsWith('if') && !trimmed.startsWith('while')) {
        const cleanCall = trimmed.replace(/;$/, '');
        return `${indent}${cleanCall}                               ${prefix} node:/c/function/call`;
      }
      if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.\[\]\s]+\s*(?:=|\+=|-=|\*=|\/=)(?!=)\s*.+$/.test(trimmed)) {
        const cleanAssign = trimmed.replace(/;$/, '');
        return `${indent}${cleanAssign}                               ${prefix} node:/c/data/assign`;
      }
    } else if (lang === 'javascript' || lang === 'js') {
      if (trimmed === '}') {
        return null; // Pure block closing brace, dropped in indent-based spec DSL
      }
      if (trimmed === '};' || trimmed === '},' || trimmed === ');' || trimmed.startsWith(']);') || trimmed === ']') {
        return `${indent}${trimmed.replace(/;$/, '')}`; // Object / array literal closing, preserve in spec DSL
      }
      if (trimmed.startsWith('import ')) {
        const m = trimmed.match(/^import\s+(.+?)\s+from\s+['"]([^'"]+)['"];?$/);
        if (m) {
          return `${indent}引入 ${m[1]} 从 '${m[2]}'                    ${prefix} node:/javascript/module/import origin:declared`;
        }
        const mBare = trimmed.match(/^import\s+['"]([^'"]+)['"];?$/);
        if (mBare) {
          return `${indent}引入 '${mBare[1]}'                             ${prefix} node:/javascript/module/import origin:declared`;
        }
      }
      if (trimmed.startsWith('export async function ')) {
        const m = trimmed.match(/^export\s+async\s+function(?:\s+([a-zA-Z0-9_\u4e00-\u9fa5]+))?\s*\((.*?)\)/);
        if (m) {
          const fn = m[1] || 'default';
          return `${indent}导出 异步定义 ${fn}(${m[2]}):                     ${prefix} node:/javascript/function/async_define`;
        }
      }
      if (trimmed.startsWith('export function ')) {
        const m = trimmed.match(/^export\s+function(?:\s+([a-zA-Z0-9_\u4e00-\u9fa5]+))?\s*\((.*?)\)/);
        if (m) {
          const fn = m[1] || 'default';
          return `${indent}导出 定义 ${fn}(${m[2]}):                         ${prefix} node:/javascript/function/define`;
        }
      }
      if (trimmed.startsWith('export default function ')) {
        const m = trimmed.match(/^export\s+default\s+function(?:\s+([a-zA-Z0-9_\u4e00-\u9fa5]+))?\s*\((.*?)\)/);
        if (m) {
          const fn = m[1] || 'default';
          return `${indent}导出 默认 定义 ${fn}(${m[2]}):                   ${prefix} node:/javascript/function/define`;
        }
      }
      if (trimmed.startsWith('export class ')) {
        const m = trimmed.match(/^export\s+class\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)(?:\s+extends\s+([a-zA-Z0-9_\u4e00-\u9fa5]+))?/);
        if (m) {
          const ext = m[2] ? ` 继承 ${m[2]}` : '';
          return `${indent}导出 类 ${m[1]}${ext}:                                   ${prefix} node:/javascript/class/define`;
        }
      }
      if (trimmed.startsWith('class ')) {
        const m = trimmed.match(/^class\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)(?:\s+extends\s+([a-zA-Z0-9_\u4e00-\u9fa5]+))?/);
        if (m) {
          const ext = m[2] ? ` 继承 ${m[2]}` : '';
          return `${indent}类 ${m[1]}${ext}:                                        ${prefix} node:/javascript/class/define`;
        }
      }
      if (trimmed.startsWith('export const ') || trimmed.startsWith('export let ') || trimmed.startsWith('export var ')) {
        const m = trimmed.match(/^export\s+(const|let|var)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(.+?);?$/);
        if (m) {
          const kw = m[1];
          const typeHint = (kw === 'let' || kw === 'var') ? `: ${kw}` : '';
          return `${indent}导出 设 ${m[2]}${typeHint} = ${m[3]}          ${prefix} node:/javascript/data/declare`;
        }
      }
      if (trimmed.startsWith('export ')) {
        const m = trimmed.match(/^export\s+(?:default\s+)?(?:\{\s*(.*?)\s*\}|([a-zA-Z0-9_\u4e00-\u9fa5]+));?$/);
        if (m) {
          return `${indent}导出 ${m[1] || m[2]}                           ${prefix} node:/javascript/module/export`;
        }
      }
      if (trimmed.startsWith('async function ')) {
        const m = trimmed.match(/^async\s+function\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)/);
        if (m) {
          return `${indent}异步定义 ${m[1]}(${m[2]}):                     ${prefix} node:/javascript/function/async_define`;
        }
      }
      if (trimmed.startsWith('function ')) {
        const m = trimmed.match(/^function\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)/);
        if (m) {
          return `${indent}定义 ${m[1]}(${m[2]}):                         ${prefix} node:/javascript/function/define`;
        }
      }
      const classMethodM = trimmed.match(/^(static\s+)?(async\s+)?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)\s*\{?$/);
      if (classMethodM && !trimmed.startsWith('if') && !trimmed.startsWith('while') && !trimmed.startsWith('for') && !trimmed.startsWith('catch') && !trimmed.startsWith('switch')) {
        const isStatic = classMethodM[1] ? '静态 ' : '';
        const isAsync = classMethodM[2] ? '异步 ' : '';
        return `${indent}${isStatic}${isAsync}方法 ${classMethodM[3]}(${classMethodM[4]}):             ${prefix} node:/javascript/function/define`;
      }
      if (trimmed.startsWith('if (')) {
        const singleGuard = trimmed.match(/^if\s*\((.+?)\)\s*(continue|break|return(?:\s+[^;]+)?);?$/);
        if (singleGuard) {
          const cond = singleGuard[1].trim();
          let stmt = singleGuard[2].trim();
          if (stmt === 'continue') stmt = '继续';
          else if (stmt === 'break') stmt = '跳出';
          else if (stmt.startsWith('return')) stmt = stmt.replace(/^return\s*/, '返回 ').trim();
          return `${indent}如果 ${cond}:                             ${prefix} node:/javascript/control/if\n${indent}  ${stmt}`;
        }
        const cond = trimmed.replace(/^if\s*\((.*)\)\s*\{?$/, '$1');
        return `${indent}如果 ${cond}:                             ${prefix} node:/javascript/control/if`;
      }
      if (trimmed.startsWith('} else if (') || trimmed.startsWith('else if (')) {
        const cond = trimmed.replace(/^(?:\}\s*)?else\s+if\s*\((.*)\)\s*\{?$/, '$1');
        return `${indent}否则如果 ${cond}:                         ${prefix} node:/javascript/control/elif`;
      }
      if (trimmed === '} else {' || trimmed === 'else {' || trimmed === 'else:') {
        return `${indent}否则:                                     ${prefix} node:/javascript/control/else`;
      }
      if (trimmed.startsWith('for (const ') || trimmed.startsWith('for (let ') || trimmed.startsWith('for (var ') || trimmed.startsWith('for (')) {
        const singleFor = trimmed.match(/^for\s*\(\s*(?:const|let|var)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+of\s+(.+?)\)\s+([^{};]+;?)$/);
        if (singleFor) {
          const v = singleFor[1];
          const iter = singleFor[2];
          const innerStmt = singleFor[3].replace(/;$/, '');
          return `${indent}对于 ${v} 中的 ${iter}:           ${prefix} node:/javascript/control/for\n${indent}  ${innerStmt}`;
        }
        const ofM = trimmed.match(/^for\s*\(\s*(?:const|let|var)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+of\s+(.+?)\)\s*\{?$/);
        if (ofM) {
          return `${indent}对于 ${ofM[1]} 中的 ${ofM[2]}:           ${prefix} node:/javascript/control/for`;
        }
        const cStyleM = trimmed.match(/^for\s*\(\s*(?:let|var)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*0;\s*\1\s*<\s*(.+?);\s*\1(?:\+\+|\s*\+=\s*1)\s*\)\s*\{?$/);
        if (cStyleM) {
          return `${indent}对于 ${cStyleM[1]} 中的 range(${cStyleM[2]}):           ${prefix} node:/javascript/control/for`;
        }
      }
      if (trimmed.startsWith('while (')) {
        const cond = trimmed.replace(/^while\s*\((.*)\)\s*\{?$/, '$1');
        return `${indent}当 ${cond}:                               ${prefix} node:/javascript/control/while`;
      }
      if (trimmed.startsWith('console.log(') && (trimmed.endsWith(');') || trimmed.endsWith(')'))) {
        const inner = trimmed.replace(/^console\.log\((.*)\);?$/, '$1');
        return `${indent}输出(${inner})                            ${prefix} node:/javascript/io/output`;
      }
      if (trimmed === 'try {' || trimmed === 'try') {
        return `${indent}尝试:                                     ${prefix} node:/javascript/error/try`;
      }
      if (trimmed.startsWith('} catch (') || trimmed.startsWith('catch (')) {
        const err = trimmed.replace(/^(?:\}\s*)?catch\s*\((.*?)\)\s*\{?$/, '$1');
        return `${indent}捕获 ${err}:                              ${prefix} node:/javascript/error/catch`;
      }
      if (trimmed === '} finally {' || trimmed === 'finally {') {
        return `${indent}最终:                                     ${prefix} node:/javascript/error/finally`;
      }
      if (trimmed.startsWith('throw ')) {
        const expr = trimmed.slice(6).replace(/;$/, '').trim();
        return `${indent}抛出 ${expr}                              ${prefix} node:/javascript/error/throw`;
      }
      if (trimmed === 'break;' || trimmed === 'break') {
        return `${indent}跳出                                       ${prefix} node:/javascript/control/loop/break`;
      }
      if (trimmed === 'continue;' || trimmed === 'continue') {
        return `${indent}继续                                       ${prefix} node:/javascript/control/loop/continue`;
      }
      if (trimmed.startsWith('return')) {
        const expr = trimmed.slice(6).replace(/;$/, '').trim();
        return `${indent}返回 ${expr}                               ${prefix} node:/javascript/function/return`;
      }
      const destrM = trimmed.match(/^(const|let|var)\s+(\{[\s\S]*?\}|\[[\s\S]*?\])\s*=\s*(.+?);?$/);
      if (destrM) {
        const kw = destrM[1];
        const typeHint = (kw === 'let' || kw === 'var') ? `: ${kw}` : '';
        return `${indent}设 ${destrM[2]}${typeHint} = ${destrM[3]}          ${prefix} node:/javascript/data/declare`;
      }
      const constDecl = trimmed.match(/^(const|let|var)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*=\s*(.+?);?$/);
      if (constDecl) {
        const kw = constDecl[1];
        const typeHint = (kw === 'let' || kw === 'var') ? `: ${kw}` : '';
        return `${indent}设 ${constDecl[2]}${typeHint} = ${constDecl[3]}          ${prefix} node:/javascript/data/declare`;
      }
      if (trimmed.startsWith('await ')) {
        return `${indent}等待 ${trimmed.slice(6).replace(/;$/, '')}    ${prefix} node:/javascript/concurrency/await`;
      }
      if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.\[\]\s]+\s*(?:=|\+=|-=|\*=|\/=)(?!=)\s*.+;?$/.test(trimmed)) {
        const cleanAssign = trimmed.replace(/;$/, '');
        return `${indent}${cleanAssign}                               ${prefix} node:/javascript/data/assign`;
      }
      if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.]+\s*\([^;:]*\)\s*;?$/.test(trimmed)) {
        const cleanCall = trimmed.replace(/;$/, '');
        return `${indent}${cleanCall}                               ${prefix} node:/javascript/function/call`;
      }
    }

    return `${indent}${trimmed}`;
  }
}
