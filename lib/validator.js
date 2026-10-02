// validator.js — Verification firewall, symbol reference checks, and structured report
// Conforms to JevAgent Design Spec V2.0 Section 12 & Engineering Spec V3.0 Section 6, 8

import { parseNamesBlock } from './names.js';

export function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

export function findNearestCandidates(word, candidates, limit = 3) {
  const scored = candidates.map(c => ({
    candidate: c,
    distance: levenshteinDistance(word, c)
  }));
  scored.sort((x, y) => x.distance - y.distance);
  return scored.slice(0, limit).map(s => s.candidate);
}

export function stripLiterals(text) {
  if (!text) return '';
  return text
    .replace(/(['"`])(?:\\.|[^\\])*?\1/g, ' ')
    .replace(/\/(?:\\.|[^\/\\\r\n])+\/[dgimsuy]*/g, ' ');
}

export class Validator {
  static KNOWN_BUILTIN_FUNCS = new Set([
    'len', 'range', 'print', 'printf', 'scanf', 'input', 'int', 'str', 'float', 'bool',
    'list', 'dict', 'set', 'tuple', 'open', 'type', 'enumerate', 'zip', 'min', 'max',
    'sum', 'abs', 'round', 'pow', 'sqrt', 'sin', 'cos', 'sizeof', 'malloc', 'free',
    'console', 'Math', 'JSON', 'Promise', 'Set', 'Map', 'Array', 'Object', 'RegExp',
    'String', 'Number', 'Boolean', 'Symbol', 'Error', 'process', 'Buffer', 'setTimeout',
    'clearTimeout', 'setInterval', 'clearInterval', 'prompt'
  ]);

  static validateSpec({
    blocks = [],
    filePath = '',
    targetLang = 'python',
    table = null,
    coreTable = null,
    strict = true
  } = {}) {
    const errors = [];
    const warnings = [];
    const autoCorrected = [];
    const ambiguities = [];
    const rulesApplied = ['unknown_node', 'ref_symbol', 'ref_library', 'import_closure', 'conditional_requires', 'confusions'];

    // 1. Locate and parse names block if present
    const namesBlock = blocks.find(b => b.block_id === 'names');
    const syntaxKeywords = [
      '定义', '异步定义', '返回', '如果', '否则如果', '否则', '对于', '当', '跳出', '继续', '设', '输出', '输入',
      '引入', '从', '作为', '引入系统', '引入本地', '导出', '尝试', '捕获', '最终', '抛出', '等待',
      'def', 'return', 'if', 'elif', 'else', 'while', 'for', 'function', 'async', 'const', 'let', 'var', 'class', '类', 'static', '方法', 'new', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete'
    ];
    let namesEnv = null;
    if (namesBlock) {
      const parsedNames = parseNamesBlock(namesBlock.content, syntaxKeywords);
      namesEnv = parsedNames.env;
      for (const err of parsedNames.errors) {
        errors.push({
          type: 'malformed_names',
          block_id: 'names',
          file: filePath,
          line: err.line,
          message: err.message
        });
      }
    }

    // Collect all function definitions and imported names
    const definedFunctions = new Set();
    const declaredVariables = new Set();
    const importedModules = new Set();

    if (namesEnv) {
      for (const [name, entry] of namesEnv.libraries.entries()) {
        importedModules.add(entry.name);
        if (entry.alias) importedModules.add(entry.alias);
      }
      for (const [name] of namesEnv.variables.entries()) {
        declaredVariables.add(name);
      }
      for (const [name] of namesEnv.constants.entries()) {
        declaredVariables.add(name);
      }
      for (const [name] of namesEnv.functions.entries()) {
        definedFunctions.add(name);
      }
    }

    // Scan definitions across blocks
    for (const blk of blocks) {
      if (blk.category === 'declaration-only') continue;
      const lines = (blk.content || '').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        const defMatch = trimmed.match(/^(?:定义|def)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\(/);
        if (defMatch) {
          definedFunctions.add(defMatch[1]);
        }
        const impMatchJs = trimmed.match(/^引入\s+(.+?)\s+从\s+['"]?([^'"]+)['"]?/);
        if (impMatchJs) {
          importedModules.add(impMatchJs[2]);
          const names = impMatchJs[1].replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean);
          for (const n of names) {
            declaredVariables.add(n);
            definedFunctions.add(n);
          }
        }
        const impMatch = trimmed.match(/^引入\s+([a-zA-Z0-9_\u4e00-\u9fa5\.\-:@/]+)(?:\s+作为\s+([a-zA-Z0-9_\u4e00-\u9fa5]+))?/);
        if (impMatch) {
          importedModules.add(impMatch[1]);
          if (impMatch[2]) importedModules.add(impMatch[2]);
        }
        const fromImpMatch = trimmed.match(/^从\s+(\S+)\s+引入\s+(.+)$/);
        if (fromImpMatch) {
          importedModules.add(fromImpMatch[1]);
          const names = fromImpMatch[2].replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean);
          for (const n of names) {
            declaredVariables.add(n);
            definedFunctions.add(n);
          }
        }
        const rawImpMatch = trimmed.match(/^(?:import|from)\s+(\S+)/);
        if (rawImpMatch) {
          importedModules.add(rawImpMatch[1]);
        }
      }
    }

    const allCoreKeywords = [
      '定义', '异步定义', '返回', '如果', '否则如果', '否则', '对于', '当', '跳出', '继续', '设', '输出', '输入',
      '引入', '从', '作为', '引入系统', '引入本地', '导出', '尝试', '捕获', '最终', '抛出', '等待', '类', '方法', '静态', '原生'
    ];

    // 2. Validate line by line in emitting blocks
    for (const blk of blocks) {
      if (blk.category === 'declaration-only') continue;
      const lines = (blk.content || '').split('\n');

      // Check for empty block
      const nonCommentLines = lines.filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('//'));
      if (nonCommentLines.length === 0 && blk.block_id !== 'imports') {
        warnings.push({
          type: 'empty_block',
          block_id: blk.block_id,
          message: `块 ${blk.block_id} 内容为空`
        });
      }

      let lastControlStmt = null;
      let lastControlIndent = 0;
      let bracketDepth = 0;

      for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const lineNo = blk.start_line + i;
        const trimmed = rawLine.trim();

        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
          continue;
        }

        const indent = rawLine.match(/^(\s*)/)[0].length;

        // Check if last control statement had empty body (indentation collapse)
        if (lastControlStmt) {
          if (indent <= lastControlIndent) {
            errors.push({
              type: 'incomplete_branch',
              block_id: blk.block_id,
              file: filePath,
              line: lineNo,
              message: `语句 '${lastControlStmt}' 分支体为空，未检测到缩进的代码块`
            });
            lastControlStmt = null;
          } else {
            lastControlStmt = null;
          }
        }

        // Strip trailing comment and node annotation for code analysis
        const codeOnly = trimmed.replace(/\s*(?:#|\/\/|--).*$/, '').trim();
        if (!codeOnly) continue;
        if (codeOnly === '}' || codeOnly === '};' || codeOnly === '},' || codeOnly === ']);' || codeOnly === ']') {
          continue; // Expression literal closing
        }

        // Multiline literal tracking (expressions inside [ ], { }, ( ))
        const lineWithoutStrings = codeOnly.replace(/(["'`])(?:\\.|[^\\])*?\1/g, '');
        const openCount = (lineWithoutStrings.match(/[\(\[\{]/g) || []).length;
        const closeCount = (lineWithoutStrings.match(/[\)\]\}]/g) || []).length;
        const wasInBracket = bracketDepth > 0;
        bracketDepth += (openCount - closeCount);
        if (bracketDepth < 0) bracketDepth = 0;

        if (wasInBracket) {
          continue; // Continuation line of multiline literal expression
        }

        // Check explicit escape hatch: 原生 <lang> "..."
        if (codeOnly.startsWith('原生 ')) {
          continue;
        }

        // Check structural: 否则 / 否则如果
        if (codeOnly.startsWith('否则:') || codeOnly === '否则') {
          // Check if orphan else
          let hasMatchingIf = false;
          for (let j = i - 1; j >= 0; j--) {
            const prev = lines[j].trim().replace(/\s*(?:#|\/\/|--).*$/, '').trim();
            if (prev.startsWith('如果 ') || prev.startsWith('否则如果 ')) {
              hasMatchingIf = true;
              break;
            }
          }
          if (!hasMatchingIf) {
            errors.push({
              type: 'incomplete_branch',
              block_id: blk.block_id,
              file: filePath,
              line: lineNo,
              message: `孤立的 '否则:' 语句，缺少前置的 '如果' 条件分支`
            });
            continue;
          }
        }

        // Check confusions (e.g. C with print(1), Python with printf)
        if (table && Array.isArray(table.confusions)) {
          for (const conf of table.confusions) {
            const pattern = new RegExp(`\\b${conf.wrong}\\s*\\(`);
            if (pattern.test(codeOnly)) {
              if (conf.action === 'correct') {
                autoCorrected.push({
                  block_id: blk.block_id,
                  line: lineNo,
                  from: conf.wrong,
                  to: conf.right,
                  rule: `confusions/${targetLang}/${conf.wrong}`
                });
              } else {
                errors.push({
                  type: 'confusions',
                  block_id: blk.block_id,
                  file: filePath,
                  line: lineNo,
                  symbol: conf.wrong,
                  message: conf.hint || `目标语言 ${targetLang} 不支持 '${conf.wrong}'`
                });
              }
            }
          }
        }

        // Check empty output slot: 输出()
        if (/^输出\s*\(\s*\)$/.test(codeOnly) || /^print\s*\(\s*\)$/.test(codeOnly)) {
          errors.push({
            type: 'missing_slot',
            block_id: blk.block_id,
            file: filePath,
            line: lineNo,
            message: `输出() 缺少必填参数表达式`
          });
          continue;
        }

        // Check 对于: must have '中的'
        if (codeOnly.startsWith('对于 ') && !codeOnly.includes(' 中的 ')) {
          errors.push({
            type: 'unknown_node',
            block_id: blk.block_id,
            file: filePath,
            line: lineNo,
            message: `'对于' 循环语句缺少 '中的' 关键字，正确语法如: '对于 变量 中的 集合:'`
          });
          continue;
        }

        // Track control statements that expect indented body
        if (codeOnly.startsWith('如果 ') || codeOnly.startsWith('否则如果 ') || codeOnly.startsWith('当 ') || codeOnly.startsWith('对于 ')) {
          if (codeOnly.endsWith(':')) {
            lastControlStmt = codeOnly;
            lastControlIndent = indent;
          }
        }

        // Check function definition: collect parameters as local declared variables
        const funcDefMatch = codeOnly.match(/^(?:导出\s+)?(?:静态\s+)?(?:异步\s+)?(?:异步定义|定义|def|function|async\s+function|方法)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)/);
        if (funcDefMatch) {
          const paramsStr = funcDefMatch[2];
          if (paramsStr) {
            const params = paramsStr.replace(/[\{\}\[\]]/g, '').split(',').map(p => p.trim().split(':')[0].trim().split('=')[0].trim()).filter(Boolean);
            for (const p of params) declaredVariables.add(p);
          }
          continue;
        }

        // Check for-loop variable
        const forLoopMatch = codeOnly.match(/^对于\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+中的\s+(.+?):/);
        if (forLoopMatch) {
          declaredVariables.add(forLoopMatch[1].trim());
          // Check conditional requires in C
          if (targetLang === 'c') {
            const iterExpr = forLoopMatch[2].trim();
            // C requires known length binding
            const hasLength = declaredVariables.has('长度') || declaredVariables.has('len') || (namesEnv && namesEnv.hasSymbol('长度'));
            if (!hasLength && !/^\d+$/.test(iterExpr)) {
              errors.push({
                type: 'core_unfulfilled',
                block_id: blk.block_id,
                file: filePath,
                line: lineNo,
                symbol: iterExpr,
                message: `C 语言中遍历集合 '${iterExpr}' 属于 conditional 履约节点，前置条件未满足: 集合带有已知长度绑定或哨兵`
              });
            }
          }
          continue;
        }

        // Check assignment: 设 <var> = <expr> or <var> = <expr> or compound assignment (+=, -=, *=, /=)
        const assignMatch = codeOnly.match(/^(?:设\s+)?([a-zA-Z0-9_\u4e00-\u9fa5\.\[\]\+\-\s]+?)\s*(?::\s*[^=]+)?\s*(?:=|\+=|-=|\*=|\/=)(?!=)\s*(.+)$/);
        if (assignMatch && !codeOnly.startsWith('如果 ') && !codeOnly.startsWith('当 ')) {
          const varName = assignMatch[1].trim();
          const expr = assignMatch[2];
          const rootVar = varName.split(/[.\[\s]/)[0];
          declaredVariables.add(rootVar);

          const cleanExpr = stripLiterals(expr);

          // Check undeclared library in expression (e.g. numpy.array([1]))
          const dotMatch = cleanExpr.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\.[a-zA-Z_]/);
          if (dotMatch) {
            const libName = dotMatch[1];
            if (!importedModules.has(libName) && !declaredVariables.has(libName) && !Validator.KNOWN_BUILTIN_FUNCS.has(libName)) {
              errors.push({
                type: 'ref_library',
                block_id: blk.block_id,
                file: filePath,
                line: lineNo,
                symbol: libName,
                message: `外部库 '${libName}' 未在 names 块声明或 imports 块引入`
              });
            }
          }

          // Check constant conflict in expression (e.g. 常量 上限 = "abc", 设 y = 上限 + 1)
          if (namesEnv) {
            for (const [cName, cEntry] of namesEnv.constants.entries()) {
              if (cEntry.type === 'str' && cleanExpr.includes(cName) && /\+\s*\d+|\d+\s*\+/.test(cleanExpr)) {
                errors.push({
                  type: 'type_conflict',
                  block_id: blk.block_id,
                  file: filePath,
                  line: lineNo,
                  symbol: cName,
                  message: `字符串常量 '${cName}' 与算术运算类型冲突`
                });
              }
            }
          }

          // Check calling non-existent function in RHS: 根本不存在的函数(1)
          const callMatch = cleanExpr.match(/(?:^|[^\w\u4e00-\u9fa5\.])([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\(/);
          if (callMatch) {
            const funcCall = callMatch[1];
            if (!Validator.KNOWN_BUILTIN_FUNCS.has(funcCall) && !definedFunctions.has(funcCall) && !syntaxKeywords.includes(funcCall)) {
              errors.push({
                type: 'unknown_symbol',
                block_id: blk.block_id,
                file: filePath,
                line: lineNo,
                symbol: funcCall,
                message: `调用了未在当前模块定义或未在 names 块声明的函数: '${funcCall}'`
              });
            }
          }

          // Check undeclared variables in RHS expression (e.g. 设 结果 = x * 2 + 未声明变量)
          const exprWithoutCalls = cleanExpr
            .replace(/([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\(/g, ' ')
            .replace(/\.[a-zA-Z0-9_\u4e00-\u9fa5]+/g, ' ');
          const exprTokens = exprWithoutCalls.match(/[a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*/g) || [];
          for (const token of exprTokens) {
            if (
              !declaredVariables.has(token) &&
              !importedModules.has(token) &&
              !definedFunctions.has(token) &&
              !Validator.KNOWN_BUILTIN_FUNCS.has(token) &&
              !['True', 'False', 'None', '真', '假', '空', 'null', 'true', 'false', 'undefined', 'NaN', 'Infinity', 'this', 'self', 'new', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof'].includes(token) &&
              !syntaxKeywords.includes(token) &&
              token !== rootVar
            ) {
              errors.push({
                type: 'undeclared_symbol',
                block_id: blk.block_id,
                file: filePath,
                line: lineNo,
                symbol: token,
                message: `标识符 '${token}' 未在 names 块声明或局部定义`,
                nearest_candidates: findNearestCandidates(token, Array.from(declaredVariables))
              });
            }
          }

          continue;
        }

        // Check return statement: 返回 <expr>
        const returnMatch = codeOnly.match(/^返回(?:\s+(.+))?$/);
        if (returnMatch) {
          const retExpr = returnMatch[1];
          if (retExpr) {
            const cleanRetExpr = stripLiterals(retExpr)
              .replace(/\.[a-zA-Z0-9_\u4e00-\u9fa5]+/g, ' ');
            const idTokens = cleanRetExpr.match(/[a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*/g) || [];
            for (const token of idTokens) {
              if (!declaredVariables.has(token) &&
                  !importedModules.has(token) &&
                  !definedFunctions.has(token) &&
                  !Validator.KNOWN_BUILTIN_FUNCS.has(token) &&
                  !['True', 'False', 'None', '真', '假', '空', 'null', 'true', 'false', 'undefined', 'NaN', 'Infinity', 'this', 'self', 'new', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof'].includes(token) &&
                  token !== 'f') {
                errors.push({
                  type: 'undeclared_symbol',
                  block_id: blk.block_id,
                  file: filePath,
                  line: lineNo,
                  symbol: token,
                  message: `标识符 '${token}' 未在 names 块声明或局部定义`,
                  nearest_candidates: findNearestCandidates(token, Array.from(declaredVariables))
                });
              }
            }
          }
          continue;
        }

        // Check imports: 引入 / 从
        if (codeOnly.startsWith('引入') || codeOnly.startsWith('从 ') || codeOnly.startsWith('import ') || codeOnly.startsWith('from ') || codeOnly.startsWith('#include')) {
          continue;
        }

        // Check standalone function call: func(...)
        const cleanCallOnly = codeOnly.replace(/(["'`])(?:\\.|[^\\])*?\1/g, ' ');
        if (/^[a-zA-Z0-9_\u4e00-\u9fa5\.]+\s*\([^;:]*\)\s*;?$/.test(cleanCallOnly)) {
          const callMatch = cleanCallOnly.match(/(?:^|[^\w\u4e00-\u9fa5\.])([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\(/);
          if (callMatch) {
            const funcCall = callMatch[1];
            if (!Validator.KNOWN_BUILTIN_FUNCS.has(funcCall) && !definedFunctions.has(funcCall) && !syntaxKeywords.includes(funcCall)) {
              errors.push({
                type: 'unknown_symbol',
                block_id: blk.block_id,
                file: filePath,
                line: lineNo,
                symbol: funcCall,
                message: `调用了未在当前模块定义或未在 names 块声明的函数: '${funcCall}'`
              });
            }
          }
          continue;
        }

        // Check known core keyword prefixes (including 导出 <kw>)
        const strippedExport = codeOnly.startsWith('导出 ') ? codeOnly.slice(3).trim() : codeOnly;
        const isCorePrefixed = allCoreKeywords.some(kw => strippedExport.startsWith(kw)) || strippedExport.startsWith('{');
        if (isCorePrefixed) {
          continue;
        }

        // If none of the above, it's an UNKNOWN NODE!
        const token = codeOnly.split(/[\s(:]/)[0];
        const suggestions = findNearestCandidates(token, allCoreKeywords);
        errors.push({
          type: 'unknown_node',
          block_id: blk.block_id,
          file: filePath,
          line: lineNo,
          symbol: token,
          message: `未识别的语法或关键字 '${codeOnly}' 未命中关键字核；最近候选: ${suggestions.join(', ')}`,
          nearest_candidates: suggestions
        });
      }
    }

    // Populate ambiguities from errors
    for (const err of errors) {
      ambiguities.push({
        ambiguity_type: err.type,
        block_id: err.block_id || '',
        file: err.file || filePath,
        line: err.line || 0,
        description: err.message,
        candidates: err.nearest_candidates || [],
        blocking: true
      });
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      auto_corrected: autoCorrected,
      coverage: {
        rules_applied: rulesApplied,
        unmodeled_libraries: []
      },
      ambiguities
    };
  }
}
