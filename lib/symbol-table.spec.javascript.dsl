// @jev-block:names:begin
变量 extractSymbols: Any
// @jev-block:names:end
// symbol-table.js — Dynamic symbol table extraction and tracking
// Conforms to JevAgent Design Spec Section 8 & V3.0 Spec

// @jev-block:symbol_table_001:begin
导出 类 SymbolTable:                                   // node:/javascript/class/define
  static IDENT_RE = /\b([a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*)\b/g                               // node:/javascript/data/assign

  静态 方法 extractSymbols(content, lang = 'python', blacklist = []):             // node:/javascript/function/define
    设 defined = new Set()          // node:/javascript/data/declare
    设 used = new Set()          // node:/javascript/data/declare
    设 referenced = new Set()          // node:/javascript/data/declare
    设 blSet = new Set(blacklist || [])          // node:/javascript/data/declare

    设 lines = (content || '').split('\n')          // node:/javascript/data/declare

    对于 rawLine 中的 lines:           // node:/javascript/control/for
      设 line = rawLine.trim()          // node:/javascript/data/declare
      如果 !line || line.startsWith('#') || line.startsWith('//') || line.startsWith('--'):                             // node:/javascript/control/if
        继续

      // Extract all identifier tokens outside string literals
      设 codeWithoutStrings = line.replace(/(["'`])(?:\\.|[^\\])*?\1/g, ' ')          // node:/javascript/data/declare
      设 tokens = codeWithoutStrings.match(SymbolTable.IDENT_RE) || []          // node:/javascript/data/declare
      对于 t 中的 tokens:           // node:/javascript/control/for
        如果 !blSet.has(t) && !/^\d+$/.test(t):                             // node:/javascript/control/if
          referenced.add(t)                               // node:/javascript/function/call

      如果 line.startsWith('定义') || line.startsWith('设') || line.startsWith('对于') || line.startsWith('def '):                             // node:/javascript/control/if
        设 defMatch = line.match(/^(?:定义|def)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*\((.*?)\)/)          // node:/javascript/data/declare
        如果 defMatch:                             // node:/javascript/control/if
          defined.add(defMatch[1])                               // node:/javascript/function/call
          设 args = defMatch[2].split(',').map(a => a.trim().split(':')[0].trim()).filter(Boolean)          // node:/javascript/data/declare
          对于 arg 中的 args:           // node:/javascript/control/for
            defined.add(arg)                               // node:/javascript/function/call
            used.add(arg)                               // node:/javascript/function/call
          继续                                       // node:/javascript/control/loop/continue

        设 assignMatch = line.match(/^(?:设\s+)?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*(?::\s*[^=]+)?\s*=\s*(.+)/)          // node:/javascript/data/declare
        如果 assignMatch:                             // node:/javascript/control/if
          defined.add(assignMatch[1])                               // node:/javascript/function/call
          设 expr = assignMatch[2]          // node:/javascript/data/declare
          设 exprTokens = expr.replace(/(["'`])(?:\\.|[^\\])*?\1/g, ' ').match(SymbolTable.IDENT_RE) || []          // node:/javascript/data/declare
          对于 t 中的 exprTokens:           // node:/javascript/control/for
            如果 t !== assignMatch[1] && !blSet.has(t) && !/^\d+$/.test(t):                             // node:/javascript/control/if
              used.add(t)                               // node:/javascript/function/call
          继续                                       // node:/javascript/control/loop/continue

        设 forMatch = line.match(/^对于\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)\s+中的\s+(.+?):/)          // node:/javascript/data/declare
        如果 forMatch:                             // node:/javascript/control/if
          defined.add(forMatch[1])                               // node:/javascript/function/call
          used.add(forMatch[2].trim())                               // node:/javascript/function/call
          继续                                       // node:/javascript/control/loop/continue
      否则:                                     // node:/javascript/control/else
        设 pyDefMatch = line.match(/^def\s+([a-zA-Z0-9_]+)\s*\((.*?)\)/)          // node:/javascript/data/declare
        如果 pyDefMatch:                             // node:/javascript/control/if
          defined.add(pyDefMatch[1])                               // node:/javascript/function/call
          设 args = pyDefMatch[2].split(',').map(a => a.trim().split(':')[0].trim()).filter(Boolean)          // node:/javascript/data/declare
          对于 arg 中的 args:           // node:/javascript/control/for
            defined.add(arg)
          继续                                       // node:/javascript/control/loop/continue

        设 cDefMatch = line.match(/^[a-zA-Z0-9_*]+\s+([a-zA-Z0-9_]+)\s*\((.*?)\)\s*\{?/)          // node:/javascript/data/declare
        如果 cDefMatch && !['if', 'while', 'for', 'switch'].includes(cDefMatch[1]):                             // node:/javascript/control/if
          defined.add(cDefMatch[1])                               // node:/javascript/function/call
          继续                                       // node:/javascript/control/loop/continue

        设 assignMatch = line.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)/)          // node:/javascript/data/declare
        如果 assignMatch:                             // node:/javascript/control/if
          defined.add(assignMatch[1])                               // node:/javascript/function/call
          继续                                       // node:/javascript/control/loop/continue

    返回 {                               // node:/javascript/function/return
      defined: Array.from(defined),
      used: Array.from(used),
      referenced: Array.from(referenced)
    }

// @jev-block:symbol_table_001:end
