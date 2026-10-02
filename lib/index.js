// index.js — JevAgent plugin entrypoint for DeepSeek Harness
// Conforms to JevAgent Engineering Spec V3.0 & Design Spec V2.0

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { BlockSplitter } from './splitter.js';
import { ThreeFileManager } from './three-file.js';
import { NormalizeDsl } from './normalize.js';
import { SymbolTable } from './symbol-table.js';
import { RouterEngine } from './router.js';
import { TemplateEngine } from './template.js';
import { VocabValidator } from './vocab.js';
import { JevClient, extractFirstJsonObject } from './jev-client.js';
import { Validator } from './validator.js';
import { parseNamesBlock } from './names.js';
import { AutoMarker } from './automark.js';

let defineTool;
try {
  const toolsPkg = await import('@deepseek-ai/dsh-tools');
  defineTool = toolsPkg.defineTool || ((t) => t);
} catch {
  defineTool = (t) => t;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TABLES_DIR = path.resolve(__dirname, '../tables');

export const name = 'tool-jevagent';
export const inject = ['tools'];

function getDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function getConfigFile() {
  return process.env.JEV_CONFIG_FILE || path.join(getDshHome(), 'jevagent.json');
}

function loadPersistedConfig() {
  const cfgFile = getConfigFile();
  if (fs.existsSync(cfgFile)) {
    try {
      return JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {};
    } catch {
      return {};
    }
  }
  return {};
}

function savePersistedConfig(cfg) {
  const cfgFile = getConfigFile();
  try {
    const dir = path.dirname(cfgFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to tmp file first then atomically rename
    const tmpFile = `${cfgFile}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmpFile, cfgFile);
  } catch (err) {
    console.error('[dsh-plugin-jevagent] failed to save jevagent.json atomically:', err);
  }
}

// =============================================================================
// JevAgent Actions Implementation
// =============================================================================

export async function actionSplitBlocks(args, ctxState) {
  const filePath = args.file_path || args.module_path;
  if (!filePath) {
    throw new Error('split_blocks 需要提供 `file_path` 或 `module_path`');
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`文件不存在: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, 'utf8');
  const targetLang = args.target_lang || 'python';

  const { blocks, trailingFree } = BlockSplitter.split(content, targetLang);
  return {
    status: 'success',
    action: 'split_blocks',
    file: resolved,
    blocks_count: blocks.length,
    blocks: blocks.map(b => b.toJSON()),
    has_trailing_free: !!trailingFree
  };
}

export async function actionSpecToCode(args, ctxState) {
  const modulePath = args.module_path;
  if (!modulePath) throw new Error('spec_to_code 需要提供 `module_path`');

  const targetLang = args.target_lang || 'python';
  const paths = ThreeFileManager.resolvePaths(modulePath, targetLang);

  if (!fs.existsSync(paths.spec_dsl)) {
    throw new Error(`未找到特化 DSL 文件: ${paths.spec_dsl}。请先创建特化 DSL 文件。`);
  }

  ThreeFileManager.createBackup(paths.code_file);

  const rawSpec = fs.readFileSync(paths.spec_dsl, 'utf8');

  // 1. Normalize DSL (T0)
  const normRes = NormalizeDsl.normalizeText(rawSpec, targetLang);
  const { blocks, trailingFree } = BlockSplitter.split(normRes.normalized, targetLang);
  const table = ctxState.router.getTableForLang(targetLang, args.table_ref);
  const coreTable = ctxState.router.tables.get('syntax_core_v1') || null;

  // 2. Parse names block if present (T4)
  const namesBlock = blocks.find(b => b.block_id === 'names');
  let namesEnv = null;
  if (namesBlock) {
    const parsedNames = parseNamesBlock(namesBlock.content);
    namesEnv = parsedNames.env;
  }

  // 3. Validation firewall gate (T1 & T3)
  let validation = Validator.validateSpec({
    blocks,
    filePath: paths.spec_dsl,
    targetLang,
    table,
    coreTable,
    strict: true
  });

  const jevStatus = await ctxState?.jevClient?.checkConnection(1500).catch(() => null);
  const autoHealed = [];

  // Scenario 2: If Jev is online and DSL has minor deviations/ambiguities, heal via Jev 4B
  if (!validation.ok && jevStatus && jevStatus.connected && validation.ambiguities && validation.ambiguities.length > 0) {
    for (const amb of validation.ambiguities) {
      if (amb.candidates && amb.candidates.length > 0) {
        try {
          const decision = await ctxState.jevClient.decide(amb.line ? `行号: ${amb.line}` : '', {
            type: 'choice',
            candidates: amb.candidates,
            prompt: `在 DSL 语句 '${amb.description || amb.symbol}' (行号: ${amb.line}) 中检测到少许表述偏差。请从以下候选标准语义节点中选出最贴合意图的标准节点。`
          });
          if (decision && decision.choice) {
            autoHealed.push({
              line: amb.line,
              from: amb.symbol || amb.description,
              healed_to: decision.choice,
              confidence: decision.confidence || 0.95,
              provider: 'remote_jev_4b'
            });
            amb.blocking = false;
            amb.healed = true;
          }
        } catch (e) {
          console.warn(`[spec_to_code] Jev healing failed on line ${amb.line}: ${e.message}`);
        }
      }
    }
    if (autoHealed.length > 0) {
      validation.errors = validation.errors.filter(err => !autoHealed.some(h => h.line === err.line));
      if (validation.errors.length === 0) {
        validation.ok = true;
      }
    }
  }

  // Offline Mode Guard: If Jev is offline, only standard DSL is accepted; non-standard DSL is strictly rejected
  if (!validation.ok) {
    const firstError = validation.errors[0];
    const isOffline = !jevStatus || !jevStatus.connected;
    const prefix = isOffline ? '[离线模式报错提醒] ' : '';
    const offlineNotice = isOffline
      ? `离线模式下仅开放标准 DSL 到代码转换。检测到非标/偏差 DSL: '${firstError.symbol || firstError.message}' (行号: ${firstError.line})。如需智能意图容错自愈，请接入 Jev 服务器。`
      : firstError.message;
    const err = new Error(`${prefix}[${firstError.type}] ${offlineNotice}`);
    err.validation = validation;
    err.ambiguities = validation.ambiguities;
    err.dsl_normalization = normRes.stats;
    err.mode = isOffline ? 'offline' : 'online';
    err.auto_healed_by_jev = autoHealed;
    throw err;
  }

  // 4. Library import closure (T2)
  const referencedSymbols = new Set();
  const symbolsMap = {};
  for (const blk of blocks) {
    if (blk.category === 'declaration-only') continue;
    const symbols = SymbolTable.extractSymbols(blk.content, targetLang, table?.keyword_blacklist);
    symbolsMap[blk.block_id] = symbols;
    for (const s of symbols.referenced) {
      referencedSymbols.add(s);
    }
  }

  const requiredImports = table?.required_imports || {};
  const autoImports = new Set();

  let importsBlock = blocks.find(b => b.block_id === 'imports');
  const existingImportLines = importsBlock ? (importsBlock.content || '').split('\n').map(l => l.trim()).filter(Boolean) : [];
  const finalImportLines = [...existingImportLines];
  let specUpdated = false;

  // Map referenced symbols that match requiredImports: module -> Set(symbols)
  const autoModuleImports = new Map();
  for (const sym of referencedSymbols) {
    if (Object.prototype.hasOwnProperty.call(requiredImports, sym)) {
      const mod = requiredImports[sym];
      if (mod && typeof mod === 'string') {
        if (!autoModuleImports.has(mod)) autoModuleImports.set(mod, new Set());
        autoModuleImports.get(mod).add(sym);
      }
    }
  }

  // Scan all existing imports in any block to avoid duplicate hoisting
  const allExistingImportLines = [];
  for (const b of blocks) {
    for (const l of (b.content || '').split('\n')) {
      const t = l.trim();
      if (t.startsWith('引入') || t.startsWith('从 ') || t.startsWith('import ') || t.startsWith('from ') || t.startsWith('#include')) {
        allExistingImportLines.push(t);
      }
    }
  }

  for (const [mod, syms] of autoModuleImports.entries()) {
    const alreadyDeclared = allExistingImportLines.some(l => l.includes(mod));
    if (!alreadyDeclared) {
      if (targetLang === 'c') {
        finalImportLines.push(`引入系统 ${mod.replace(/[<>"]/g, '')}    // node:/c/module/include_system origin:auto`);
      } else if (targetLang === 'python') {
        const symList = Array.from(syms).join(', ');
        finalImportLines.push(`从 ${mod} 引入 ${symList}    # node:/python/module/from_import origin:auto`);
      } else if (targetLang === 'shell') {
        finalImportLines.push(`引入 ${mod}    # node:/shell/module/source origin:auto`);
      } else if (targetLang === 'javascript' || targetLang === 'js') {
        const symList = Array.from(syms).join(', ');
        finalImportLines.push(`引入 { ${symList} } 从 '${mod}'    // node:/javascript/module/import origin:auto`);
      }
      specUpdated = true;
    }
  }

  if (namesEnv) {
    for (const [libName, entry] of namesEnv.libraries.entries()) {
      const alreadyDeclared = allExistingImportLines.some(l => l.includes(entry.name));
      if (!alreadyDeclared) {
        if (targetLang === 'python') {
          if (entry.alias && entry.alias !== entry.name) {
            finalImportLines.push(`引入 ${entry.name} 作为 ${entry.alias}    # node:/python/module/import origin:auto`);
          } else {
            finalImportLines.push(`引入 ${entry.name}    # node:/python/module/import origin:auto`);
          }
          specUpdated = true;
        }
      }
    }
  }

  if (specUpdated) {
    if (!importsBlock) {
      importsBlock = {
        block_id: 'imports',
        category: 'hoisted',
        content: finalImportLines.join('\n'),
        free_before: ''
      };
      blocks.unshift(importsBlock);
    } else {
      importsBlock.content = finalImportLines.join('\n');
    }
    const updatedSpecContent = BlockSplitter.assemble(blocks, trailingFree, targetLang);
    fs.writeFileSync(paths.spec_dsl, updatedSpecContent, 'utf8');
  }

  // 5. Code translation
  const codeBlocks = [];
  for (const blk of blocks) {
    if (blk.category === 'declaration-only') {
      continue;
    }
    const lines = blk.content.split('\n');
    let codeLines = [];
    if (targetLang === 'c' || targetLang === 'cpp') {
      codeLines = TemplateEngine.specLinesToCCode(lines, table, namesEnv);
    } else if (targetLang === 'shell' || targetLang === 'sh' || targetLang === 'bash') {
      codeLines = TemplateEngine.specLinesToShellCode(lines, table, namesEnv);
    } else if (targetLang === 'javascript' || targetLang === 'js') {
      codeLines = TemplateEngine.specLinesToJSCode(lines, table, namesEnv);
    } else {
      for (const line of lines) {
        const nodeMatch = line.match(/\s*(?:#|\/\/|--)\s*node:([^\s]+)/);
        const node = nodeMatch ? table?.nodes?.[nodeMatch[1]] : null;
        codeLines.push(TemplateEngine.specLineToCode(line, targetLang, node, namesEnv));
      }
    }
    codeBlocks.push({
      block_id: blk.block_id,
      category: blk.category,
      content: codeLines.join('\n'),
      free_before: blk.free_before
    });
  }

  // 6. Apply skeleton
  const skeletonTable = ctxState.router.tables.get('skeleton_v1') || null;
  const skeletonHeader = skeletonTable?.skeletons?.[targetLang]?.header || '';
  let codeContent = BlockSplitter.assemble(codeBlocks, trailingFree, targetLang, { skipDeclarationOnly: true });

  if (skeletonHeader && !codeContent.includes(skeletonHeader.trim())) {
    codeContent = skeletonHeader + codeContent;
  }

  fs.writeFileSync(paths.code_file, codeContent, 'utf8');

  ThreeFileManager.updateBlocksIndex(paths, codeBlocks, 'confirmed', symbolsMap);
  ThreeFileManager.updateManifest(paths, { skeleton_applied: true });

  return {
    status: 'success',
    action: 'spec_to_code',
    module: paths.base_name,
    target_lang: targetLang,
    code_file: paths.code_file,
    blocks_count: codeBlocks.length,
    validation,
    ambiguities: validation.ambiguities,
    dsl_normalization: normRes.stats,
    jev_status: jevStatus,
    notice: jevStatus?.notice
  };
}

export async function actionCodeToSpec(args, ctxState) {
  const modulePath = args.module_path;
  if (!modulePath) throw new Error('code_to_spec 需要提供 `module_path`');

  const targetLang = args.target_lang || 'python';
  const paths = ThreeFileManager.resolvePaths(modulePath, targetLang);

  if (!fs.existsSync(paths.code_file)) {
    throw new Error(`未找到代码文件: ${paths.code_file}。请先在代码中打上 @jev-block 注释标记。`);
  }

  ThreeFileManager.createBackup(paths.spec_dsl);

  const rawCode = fs.readFileSync(paths.code_file, 'utf8');
  const { blocks, trailingFree } = BlockSplitter.split(rawCode, targetLang);

  if (blocks.length === 0) {
    throw new Error(`[no_blocks_found] 代码文件中缺少 @jev-block 标记，请在逻辑块前后插入目标语言注释标记。`);
  }

  // T8: Harvest free zone imports from before first block
  const firstBlock = blocks[0];
  const freeBeforeLines = (firstBlock.free_before || '').split('\n');
  const harvestedImports = [];
  const remainingFreeLines = [];

  for (const line of freeBeforeLines) {
    const trimmed = line.trim();
    if (targetLang === 'python') {
      const impM = trimmed.match(/^import\s+(\S+)(?:\s+as\s+(\S+))?$/);
      if (impM) {
        const asStr = impM[2] ? ` 作为 ${impM[2]}` : '';
        harvestedImports.push(`引入 ${impM[1]}${asStr}    # node:/python/module/import origin:declared`);
        continue;
      }
      const fromM = trimmed.match(/^from\s+(\S+)\s+import\s+(.+)$/);
      if (fromM) {
        harvestedImports.push(`从 ${fromM[1]} 引入 ${fromM[2]}    # node:/python/module/from_import origin:declared`);
        continue;
      }
    } else if (targetLang === 'c' || targetLang === 'cpp') {
      const incSysM = trimmed.match(/^#include\s+<([^>]+)>/);
      if (incSysM) {
        harvestedImports.push(`引入系统 ${incSysM[1]}    // node:/c/module/include_system origin:declared`);
        continue;
      }
      const incLocM = trimmed.match(/^#include\s+"([^"]+)"/);
      if (incLocM) {
        harvestedImports.push(`引入本地 ${incLocM[1]}    // node:/c/module/include_local origin:declared`);
        continue;
      }
    } else if (targetLang === 'shell') {
      const srcM = trimmed.match(/^(?:source|\.)\s+(\S+)$/);
      if (srcM) {
        harvestedImports.push(`引入 ${srcM[1]}    # node:/shell/module/source origin:declared`);
        continue;
      }
    } else if (targetLang === 'javascript' || targetLang === 'js') {
      const impFromM = trimmed.match(/^import\s+(.+?)\s+from\s+['"]([^'"]+)['"];?$/);
      if (impFromM) {
        harvestedImports.push(`引入 ${impFromM[1]} 从 '${impFromM[2]}'    // node:/javascript/module/import origin:declared`);
        continue;
      }
      const impBareM = trimmed.match(/^import\s+['"]([^'"]+)['"];?$/);
      if (impBareM) {
        harvestedImports.push(`引入 '${impBareM[1]}'    // node:/javascript/module/import origin:declared`);
        continue;
      }
    }
    remainingFreeLines.push(line);
  }

  firstBlock.free_before = remainingFreeLines.join('\n');

  const specBlocks = [];

  if (harvestedImports.length > 0) {
    specBlocks.push({
      block_id: 'imports',
      category: 'hoisted',
      content: harvestedImports.join('\n'),
      free_before: ''
    });
  }

  const seenVars = new Set();
  const symbolsMap = {};

  for (const blk of blocks) {
    const specLines = [];
    const defMatch = blk.content.match(/(?:def|定义)\s+[a-zA-Z0-9_\u4e00-\u9fa5]+\s*\((.*?)\)/);
    if (defMatch) {
      const params = defMatch[1].split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean);
      for (const p of params) seenVars.add(p);
    }
    for (const line of blk.content.split('\n')) {
      const s = TemplateEngine.codeLineToSpec(line, targetLang, null, seenVars);
      if (s !== null && s !== undefined) {
        specLines.push(s);
      }
    }
    const symbols = SymbolTable.extractSymbols(blk.content, targetLang);
    symbolsMap[blk.block_id] = symbols;

    specBlocks.push({
      block_id: blk.block_id,
      category: blk.category,
      content: specLines.join('\n'),
      free_before: blk.free_before
    });
  }

  // T9: Synthesize clean names block if not present
  if (!specBlocks.some(b => b.block_id === 'names')) {
    const allDefined = new Set();
    const allUsed = new Set();
    const funcNames = new Set();
    const allLibs = new Set();

    for (const [blkId, syms] of Object.entries(symbolsMap)) {
      for (const d of syms.defined || []) allDefined.add(d);
      for (const u of syms.used || []) allUsed.add(u);
    }

    for (const blk of blocks) {
      const fnMatches = blk.content.matchAll(/(?:def|function|定义)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)/g);
      for (const m of fnMatches) funcNames.add(m[1]);
      const libMatches = blk.content.matchAll(/(?:import|引入)\s+([a-zA-Z0-9_\u4e00-\u9fa5]+)/g);
      for (const m of libMatches) allLibs.add(m[1]);
    }

    const varLines = [];
    const knownVars = new Set([...allDefined, ...allUsed]);
    const blacklist = new Set([...funcNames, 'True', 'False', 'None', 'self', 'range', 'len', 'print', 'int', 'str', 'float', 'list', 'dict', 'set', 'tuple', 'bool', 'sorted', 'time', 'random', 'math', 'os', 'sys']);

    for (const v of knownVars) {
      if (blacklist.has(v) || /^\d+$/.test(v) || v.length <= 0) continue;
      let inferred = 'Any';
      if (/^(?:is_|has_|passed|ok|flag)/.test(v)) inferred = 'bool';
      else if (/^(?:n|i|j|k|idx|count|left|right|low|high|mid|pairs|start|end|len)/.test(v)) inferred = 'int';
      else if (/^(?:time_|elapsed|ratio|rate|prob|score)/.test(v)) inferred = 'float';
      else if (/^(?:arr|list|data|items|lines|copy\d*|result_arr)/.test(v)) inferred = 'list';
      else if (/^(?:dict|map|metadata|analysis|info|config)/.test(v)) inferred = 'dict';
      else if (/^(?:name|str|title|reason|algo|msg|text)/.test(v)) inferred = 'str';
      varLines.push(`变量 ${v}: ${inferred}`);
    }

    const libLines = [];
    for (const lib of allLibs) {
      if (!blacklist.has(lib)) libLines.push(`库 ${lib}`);
    }

    const namesLines = [...varLines.sort(), ...libLines.sort()];
    if (namesLines.length > 0) {
      specBlocks.unshift({
        block_id: 'names',
        category: 'declaration-only',
        content: namesLines.join('\n'),
        free_before: ''
      });
    }
  }

  const specContent = BlockSplitter.assemble(specBlocks, trailingFree, targetLang);
  fs.writeFileSync(paths.spec_dsl, specContent, 'utf8');

  ThreeFileManager.updateBlocksIndex(paths, specBlocks, 'draft', symbolsMap);

  return {
    status: 'success',
    action: 'code_to_spec',
    module: paths.base_name,
    target_lang: targetLang,
    spec_dsl: paths.spec_dsl,
    blocks_count: specBlocks.length
  };
}

export async function actionTranslateBlock(args, ctxState) {
  const blockId = args.block_id;
  const direction = args.direction;
  const modulePath = args.module_path;

  if (!blockId) throw new Error('translate_block 必须指定 `block_id`');
  if (!direction) throw new Error('translate_block 必须指定 `direction` (spec_to_code | code_to_spec)');
  if (!modulePath) throw new Error('translate_block 必须指定 `module_path`');

  const targetLang = args.target_lang || 'python';
  const paths = ThreeFileManager.resolvePaths(modulePath, targetLang);

  if (direction === 'spec_to_code') {
    if (!fs.existsSync(paths.spec_dsl)) throw new Error(`未找到特化 DSL 文件: ${paths.spec_dsl}`);
    if (!fs.existsSync(paths.code_file)) throw new Error(`未找到代码文件: ${paths.code_file}`);

    const specContent = fs.readFileSync(paths.spec_dsl, 'utf8');
    const codeContent = fs.readFileSync(paths.code_file, 'utf8');

    const normRes = NormalizeDsl.normalizeText(specContent, targetLang);
    const specSplit = BlockSplitter.split(normRes.normalized, targetLang);
    const codeSplit = BlockSplitter.split(codeContent, targetLang);

    const targetSpecBlock = specSplit.blocks.find(b => b.block_id === blockId);
    if (!targetSpecBlock) throw new Error(`在 ${paths.spec_dsl} 中未找到块: ${blockId}`);

    const table = ctxState.router.getTableForLang(targetLang, args.table_ref);
    let newSpecContent = args.block_content !== undefined ? args.block_content : targetSpecBlock.content;
    newSpecContent = NormalizeDsl.normalizeText(newSpecContent, targetLang).normalized;

    const lines = newSpecContent.split('\n');
    let codeLines = [];
    if (targetLang === 'c' || targetLang === 'cpp') {
      codeLines = TemplateEngine.specLinesToCCode(lines, table);
    } else if (targetLang === 'shell' || targetLang === 'sh' || targetLang === 'bash') {
      codeLines = TemplateEngine.specLinesToShellCode(lines, table);
    } else if (targetLang === 'javascript' || targetLang === 'js') {
      codeLines = TemplateEngine.specLinesToJSCode(lines, table);
    } else {
      for (const line of lines) {
        const nodeMatch = line.match(/\s*(?:#|\/\/|--)\s*node:([^\s]+)/);
        const node = nodeMatch ? table?.nodes?.[nodeMatch[1]] : null;
        codeLines.push(TemplateEngine.specLineToCode(line, targetLang, node));
      }
    }

    const codeIdx = codeSplit.blocks.findIndex(b => b.block_id === blockId);
    if (codeIdx >= 0) {
      codeSplit.blocks[codeIdx].content = codeLines.join('\n');
    } else {
      codeSplit.blocks.push({
        block_id: blockId,
        category: targetSpecBlock.category,
        content: codeLines.join('\n'),
        free_before: ''
      });
    }

    const updatedCode = BlockSplitter.assemble(codeSplit.blocks, codeSplit.trailingFree, targetLang, { skipDeclarationOnly: true });
    fs.writeFileSync(paths.code_file, updatedCode, 'utf8');

    const jevStatus = await ctxState.jevClient.checkConnection(1500).catch(() => null);
    return {
      status: 'success',
      action: 'translate_block',
      direction,
      block_id: blockId,
      updated_file: paths.code_file,
      dsl_normalization: normRes.stats,
      jev_status: jevStatus,
      notice: jevStatus?.notice
    };
  }

  if (direction === 'code_to_spec') {
    if (!fs.existsSync(paths.code_file)) throw new Error(`未找到代码文件: ${paths.code_file}`);
    if (!fs.existsSync(paths.spec_dsl)) throw new Error(`未找到特化 DSL 文件: ${paths.spec_dsl}`);

    const codeContent = fs.readFileSync(paths.code_file, 'utf8');
    const specContent = fs.readFileSync(paths.spec_dsl, 'utf8');

    const codeSplit = BlockSplitter.split(codeContent, targetLang);
    const specSplit = BlockSplitter.split(specContent, targetLang);

    const targetCodeBlock = codeSplit.blocks.find(b => b.block_id === blockId);
    if (!targetCodeBlock && args.block_content === undefined) {
      throw new Error(`在 ${paths.code_file} 中未找到块: ${blockId}`);
    }

    const newCodeContent = args.block_content !== undefined ? args.block_content : targetCodeBlock.content;
    const lines = newCodeContent.split('\n');
    const specLines = [];
    const seenVars = new Set();
    for (const line of lines) {
      specLines.push(TemplateEngine.codeLineToSpec(line, targetLang, null, seenVars));
    }

    const specIdx = specSplit.blocks.findIndex(b => b.block_id === blockId);
    if (specIdx >= 0) {
      specSplit.blocks[specIdx].content = specLines.join('\n');
    } else {
      specSplit.blocks.push({
        block_id: blockId,
        content: specLines.join('\n'),
        free_before: ''
      });
    }

    const updatedSpec = BlockSplitter.assemble(specSplit.blocks, specSplit.trailingFree, targetLang);
    fs.writeFileSync(paths.spec_dsl, updatedSpec, 'utf8');

    return {
      status: 'success',
      action: 'translate_block',
      direction,
      block_id: blockId,
      updated_file: paths.spec_dsl
    };
  }

  throw new Error(`暂不支持的块单向翻译方向: ${direction}。有效方向: spec_to_code | code_to_spec`);
}

export async function actionCheckAlignment(args, ctxState) {
  const modulePath = args.module_path;
  if (!modulePath) throw new Error('check_alignment 需要提供 `module_path`');

  const targetLang = args.target_lang || 'python';
  const paths = ThreeFileManager.resolvePaths(modulePath, targetLang);
  const report = ThreeFileManager.checkAlignment(paths);

  let reviewResult = null;
  if (args.deep_review) {
    reviewResult = await actionReviewSemantics(args, ctxState).catch(e => ({ error: e.message }));
  }
  return {
    status: report.aligned ? 'success' : 'divergence',
    action: 'check_alignment',
    report,
    semantic_review: reviewResult
  };
}

export async function actionCheckSpec(args, ctxState) {
  const modulePath = args.module_path;
  if (!modulePath) throw new Error('check_spec 需要提供 `module_path`');

  const targetLang = args.target_lang || 'python';
  const paths = ThreeFileManager.resolvePaths(modulePath, targetLang);

  if (!fs.existsSync(paths.spec_dsl)) {
    throw new Error(`未找到特化 DSL 文件: ${paths.spec_dsl}`);
  }

  const rawSpec = fs.readFileSync(paths.spec_dsl, 'utf8');
  const normRes = NormalizeDsl.normalizeText(rawSpec, targetLang);
  const { blocks } = BlockSplitter.split(normRes.normalized, targetLang);
  const table = ctxState.router.getTableForLang(targetLang, args.table_ref);
  const coreTable = ctxState.router.tables.get('syntax_core_v1') || null;

  const report = Validator.validateSpec({
    blocks,
    filePath: paths.spec_dsl,
    targetLang,
    table,
    coreTable,
    strict: args.strict !== false
  });

  const jevStatus = await ctxState?.jevClient?.checkConnection(1500).catch(() => null);
  const autoHealed = [];

  // Scenario 2: When Jev is online and DSL has minor deviations, auto-heal ambiguities
  if (!report.ok && jevStatus && jevStatus.connected && report.ambiguities && report.ambiguities.length > 0) {
    for (const amb of report.ambiguities) {
      if (amb.candidates && amb.candidates.length > 0) {
        try {
          const decision = await ctxState.jevClient.decide(amb.line ? `行号: ${amb.line}` : '', {
            type: 'choice',
            candidates: amb.candidates,
            prompt: `在 DSL 语句 '${amb.description || amb.symbol}' (行号: ${amb.line}) 中检测到少许表述偏差。请从以下候选标准语义节点中选出最贴合意图的标准节点。`
          });
          if (decision && decision.choice) {
            autoHealed.push({
              line: amb.line,
              from: amb.symbol || amb.description,
              healed_to: decision.choice,
              confidence: decision.confidence || 0.95,
              provider: 'remote_jev_4b'
            });
            amb.blocking = false;
            amb.healed = true;
          }
        } catch (e) {
          console.warn(`[check_spec] Jev healing failed on line ${amb.line}: ${e.message}`);
        }
      }
    }
    if (autoHealed.length > 0) {
      report.errors = report.errors.filter(err => !autoHealed.some(h => h.line === err.line));
      if (report.errors.length === 0) {
        report.ok = true;
      }
    }
  }

  // Offline Mode Guard: If offline and non-standard DSL detected, issue clear offline reminder
  const isOffline = !jevStatus || !jevStatus.connected;
  if (isOffline) {
    report.warnings.push({
      type: 'jev_server_disconnected',
      message: jevStatus?.notice || '💡 Jev 决策服务器未接入（当前处于离线确定性模式）。'
    });
    if (!report.ok && report.errors.length > 0) {
      const firstErr = report.errors[0];
      report.offline_notice = `[离线模式报错提醒] 当前处于离线确定性模式（未连接 Jev 服务），仅开放符合语言表的标准语义 DSL 到代码的转换。在行 ${firstErr.line} 检测到非标或偏差写法: '${firstErr.symbol || firstErr.message}'。如需智能意图容错与自动自愈，请接入并开启 Jev 决策服务器。`;
    }
  }

  return {
    status: report.ok ? 'success' : 'error',
    action: 'check_spec',
    ok: report.ok,
    errors: report.errors,
    warnings: report.warnings,
    auto_corrected: report.auto_corrected,
    auto_healed_by_jev: autoHealed,
    coverage: report.coverage,
    ambiguities: report.ambiguities,
    dsl_normalization: normRes.stats,
    validation: report,
    jev_status: jevStatus,
    notice: report.offline_notice || jevStatus?.notice
  };
}

export async function actionCheckTables(args, ctxState) {
  const router = ctxState.router;
  const coreTable = router.tables.get('syntax_core_v1') || null;
  if (!coreTable) {
    throw new Error('未找到核心语法表 syntax_core_v1.json');
  }

  const columns = ['python', 'c', 'shell', 'javascript'];
  const coreNodes = coreTable.core_nodes || {};
  const rows = [];
  const issues = [];

  for (const [coreNode, def] of Object.entries(coreNodes)) {
    const row = { core_node: coreNode };
    for (const lang of columns) {
      const table = router.getTableForLang(lang);
      const conf = table?.core_conformance?.[coreNode];
      if (!conf) {
        row[lang] = 'unsupported';
        issues.push({ language: lang, core_node: coreNode, status: 'missing_declaration', message: `表 ${table?.table_id} 缺少对核心节点 ${coreNode} 的履约声明` });
      } else if (typeof conf === 'string') {
        row[lang] = 'supported';
      } else if (conf.status === 'conditional') {
        row[lang] = 'conditional';
        if (!conf.requires || conf.requires.length === 0) {
          issues.push({ language: lang, core_node: coreNode, status: 'invalid_conditional', message: `履约声明 conditional 必须提供 requires 前置条件` });
        }
      } else if (conf.status === 'unsupported') {
        row[lang] = 'unsupported';
        if (!conf.reason) {
          issues.push({ language: lang, core_node: coreNode, status: 'invalid_unsupported', message: `履约声明 unsupported 必须提供 reason 理由` });
        }
      } else {
        row[lang] = conf.status || 'supported';
      }
    }
    rows.push(row);
  }

  return {
    status: issues.length === 0 ? 'success' : 'warning',
    action: 'check_tables',
    ok: issues.length === 0,
    core_table: 'syntax_core_v1',
    matrix: { columns, rows },
    issues
  };
}

export async function actionSpecToSpec(args, ctxState) {
  const modulePath = args.module_path;
  const srcLang = args.source_lang || 'python';
  const dstLang = args.target_lang || 'c';

  if (!modulePath) throw new Error('spec_to_spec 需要提供 `module_path`');

  const srcPaths = ThreeFileManager.resolvePaths(modulePath, srcLang);
  const dstPaths = ThreeFileManager.resolvePaths(modulePath, dstLang);

  if (!fs.existsSync(srcPaths.spec_dsl)) {
    throw new Error(`未找到源 spec 文件: ${srcPaths.spec_dsl}`);
  }

  const rawSrc = fs.readFileSync(srcPaths.spec_dsl, 'utf8');
  const { blocks, trailingFree } = BlockSplitter.split(rawSrc, srcLang);

  const migrationBlocks = [];
  const unresolved = [];

  for (const blk of blocks) {
    let migrationClass = 'verbatim';
    const lines = (blk.content || '').split('\n');

    for (const line of lines) {
      if (line.includes('numpy') || line.includes('pandas')) {
        migrationClass = 'rewrite';
        break;
      }
      if (line.startsWith('对于 ') && dstLang === 'c') {
        migrationClass = 'partial';
      }
    }

    if (migrationClass === 'rewrite') {
      unresolved.push(blk.block_id);
    }

    migrationBlocks.push({
      block_id: blk.block_id,
      class: migrationClass,
      action: migrationClass === 'verbatim' ? 'copied' : (migrationClass === 'partial' ? 'copied+requires' : 'regenerated'),
      content: blk.content,
      free_before: blk.free_before
    });
  }

  const dstSpecContent = BlockSplitter.assemble(migrationBlocks, trailingFree, dstLang);
  fs.writeFileSync(dstPaths.spec_dsl, dstSpecContent, 'utf8');

  return {
    status: 'success',
    action: 'spec_to_spec',
    source: { module: modulePath, lang: srcLang },
    target: { module: modulePath, lang: dstLang },
    spec_path: dstPaths.spec_dsl,
    blocks: migrationBlocks.map(b => ({
      block_id: b.block_id,
      class: b.class,
      action: b.action
    })),
    unresolved
  };
}

export async function actionSpecExport(args, ctxState) {
  const modulePath = args.module_path;
  if (!modulePath) throw new Error('spec_export 需要提供 `module_path`');

  const targetLang = args.target_lang || 'python';
  const paths = ThreeFileManager.resolvePaths(modulePath, targetLang);

  if (!fs.existsSync(paths.spec_dsl)) {
    throw new Error(`未找到特化 DSL 文件: ${paths.spec_dsl}`);
  }

  const rawSpec = fs.readFileSync(paths.spec_dsl, 'utf8');
  const exported = rawSpec.replace(/\s*(?:#|\/\/|--)\s*node:[^\s\r\n]+/g, '');

  return {
    status: 'success',
    action: 'spec_export',
    module: paths.base_name,
    target_lang: targetLang,
    export_content: exported,
    note: '此为只读导出稿，禁止作为编辑入口'
  };
}

export async function actionRollback(args, ctxState) {
  const modulePath = args.module_path;
  if (!modulePath) throw new Error('rollback 需要提供 `module_path`');

  const targetLang = args.target_lang || 'python';
  const paths = ThreeFileManager.resolvePaths(modulePath, targetLang);
  return ThreeFileManager.rollback(paths, args.block_id || null);
}

export async function actionListTables(args, ctxState) {
  const tables = ctxState.router.listTables();
  return {
    status: 'success',
    action: 'list_tables',
    tables_dir: ctxState.router.tablesDir,
    tables
  };
}

export async function actionImportTable(args, ctxState) {
  const source = args.file_path || args.table_content;
  if (!source) throw new Error('import_table 需要提供 `file_path` 或 `table_content`');

  const res = ctxState.router.importTable(source);
  return {
    ...res,
    action: 'import_table'
  };
}

export async function actionValidateVocab(args, ctxState) {
  const candidate = args.vocab_candidate;
  if (!candidate) throw new Error('validate_vocab 需要提供 `vocab_candidate`');

  const report = VocabValidator.validate(candidate);
  return {
    status: report.valid ? 'success' : 'invalid',
    action: 'validate_vocab',
    report
  };
}

export async function actionJevDecision(args, ctxState) {
  const question = args.jev_question;
  if (!question || typeof question !== 'object') {
    throw new Error('jev_decision 必须提供 `jev_question` 字典对象 (含 type, candidates, prompt 等)');
  }

  const client = ctxState.jevClient;
  const decision = await client.decide(args.state || '', question);

  return {
    status: 'success',
    action: 'jev_decision',
    model: client.model,
    decision
  };
}

export async function actionGetConfig(args, ctxState) {
  const clientConfig = ctxState.jevClient.getConfig(true);
  const jevStatus = await ctxState.jevClient.checkConnection(1500).catch(e => ({
    connected: false,
    enabled: clientConfig.jev_enabled,
    status: 'error',
    notice: `⚠️ 检查 Jev 连接失败: ${e.message}`
  }));
  return {
    status: 'success',
    action: 'get_config',
    jev_status: jevStatus,
    notice: jevStatus?.notice,
    config: {
      ...clientConfig,
      tables_dir: ctxState.router.tablesDir,
      config_file: getConfigFile(),
      dsh_home: getDshHome()
    },
    switches: {
      jev_enabled: {
        current: clientConfig.jev_enabled,
        description: '独立 Jev API 开关：true 时使用独立 Jev 决策模型，false 时使用本地确定性规则',
        sources: ['cordis.patch.yml config.jev_enabled', 'env JEV_ENABLED', 'jevagent.json', 'action: set_config']
      },
      jev_base_url: {
        current: clientConfig.jev_base_url,
        description: 'Jev 决策模型服务 API 端点地址',
        sources: ['cordis.patch.yml config.jev_base_url', 'env JEV_API_BASE_URL', 'jevagent.json', 'action: set_config']
      },
      jev_api_key: {
        configured: Boolean(ctxState.jevClient.apiKey),
        description: 'Jev 决策模型独立密钥（与通用 Agent 密钥物理隔离）',
        sources: ['cordis.patch.yml config.jev_api_key', 'env JEV_API_KEY', 'jevagent.json', 'action: set_config']
      },
      jev_model: {
        current: clientConfig.jev_model,
        description: 'Jev 决策模型标识符',
        sources: ['cordis.patch.yml config.jev_model', 'env JEV_MODEL', 'jevagent.json', 'action: set_config']
      }
    }
  };
}

export async function actionSetConfig(args, ctxState, options = {}) {
  const current = loadPersistedConfig();
  const nextConfig = { ...current };

  // Fence Protection Check: AI tool cannot toggle fence switches
  if (!options.isHumanUI) {
    if (args.allow_direct_code_write !== undefined && args.allow_direct_code_write !== current.allow_direct_code_write) {
      throw new Error('[JevGuard 核心围栏保护] 严禁 AI 试图通过 set_config 工具修改 allow_direct_code_write 围栏开关。该开关只能由人类在 DSH 界面或配置中手动调节！');
    }
    if (args.guard_fence_config !== undefined && args.guard_fence_config !== current.guard_fence_config) {
      throw new Error('[JevGuard 核心围栏保护] 严禁 AI 试图通过 set_config 工具修改 guard_fence_config 围栏开关。该开关只能由人类在 DSH 界面或配置中手动调节！');
    }
  } else {
    if (args.allow_direct_code_write !== undefined) nextConfig.allow_direct_code_write = Boolean(args.allow_direct_code_write);
    if (args.guard_extension_rename !== undefined) nextConfig.guard_extension_rename = Boolean(args.guard_extension_rename);
    if (args.guard_fence_config !== undefined) nextConfig.guard_fence_config = Boolean(args.guard_fence_config);
    if (args.anti_passthrough !== undefined) nextConfig.anti_passthrough = Boolean(args.anti_passthrough);
  }

  if (args.jev_enabled !== undefined) nextConfig.jev_enabled = Boolean(args.jev_enabled);
  if (args.jev_base_url !== undefined) nextConfig.jev_base_url = String(args.jev_base_url);
  if (args.jev_api_key !== undefined) {
    const rawKey = String(args.jev_api_key).trim();
    // K5: Mask value must not pollute real key
    if (rawKey.includes('***') || rawKey === 'configured') {
      // Ignore mask placeholder, retain existing real key
    } else {
      nextConfig.jev_api_key = rawKey;
    }
  }
  if (args.jev_model !== undefined) nextConfig.jev_model = String(args.jev_model);
  if (args.jev_timeout_s !== undefined) nextConfig.jev_timeout_s = Number(args.jev_timeout_s);
  if (args.tables_dir !== undefined) {
    nextConfig.tables_dir = String(args.tables_dir);
    ctxState.router.tablesDir = nextConfig.tables_dir;
    ctxState.router.loadBuiltinTables();
  }

  ctxState.jevClient.updateConfig(nextConfig);
  savePersistedConfig(nextConfig);

  return {
    status: 'success',
    action: 'set_config',
    message: 'JevAgent 设置已更新并持久化至 jevagent.json',
    updated_config: ctxState.jevClient.getConfig(true)
  };
}

// Dispatcher map (16 actions)

export async function actionReviewSemantics(args, ctxState) {
  const modulePath = args.module_path;
  if (!modulePath) throw new Error('review_semantics 需要提供 `module_path`');

  const targetLang = args.target_lang || 'python';
  const paths = ThreeFileManager.resolvePaths(modulePath, targetLang);

  if (!fs.existsSync(paths.spec_dsl) || !fs.existsSync(paths.code_file)) {
    throw new Error(`无法进行语义审查：二文件必须同时存在 (spec: ${fs.existsSync(paths.spec_dsl)}, code: ${fs.existsSync(paths.code_file)})`);
  }

  const jevStatus = await ctxState?.jevClient?.checkConnection(1500).catch(() => null);
  if (!jevStatus || !jevStatus.connected) {
    return {
      status: 'offline_mode',
      action: 'review_semantics',
      reviewed: false,
      flaws_count: 0,
      flaws: [],
      notice: '💡 离线模式：仅开放标准语义 DSL 到代码转换与本地结构对齐。Jev 4B 深度语义与逻辑审查（排查【DSL 语义写错但刚好有映射】等逻辑暗疾）仅在接入 Jev 服务器时开放。'
    };
  }

  const rawSpec = fs.readFileSync(paths.spec_dsl, 'utf8');
  const rawCode = fs.readFileSync(paths.code_file, 'utf8');

  const { blocks: specBlocks } = BlockSplitter.split(rawSpec, targetLang);
  const { blocks: codeBlocks } = BlockSplitter.split(rawCode, targetLang);

  const flaws = [];
  const reviewedBlocks = [];

  for (const sBlk of specBlocks) {
    if (sBlk.category === 'declaration-only' || sBlk.block_id === 'imports') continue;
    const cBlk = codeBlocks.find(b => b.block_id === sBlk.block_id);
    if (!cBlk || !cBlk.content.trim()) continue;

    reviewedBlocks.push(sBlk.block_id);

    try {
      const prompt = `你是高精度的编译器与算法逻辑审查官。请仔细审查以下成对的【特化语义 DSL 块】与其【目标代码块】。\n重点排查【DSL 语义虽然能映射到代码，但是实际业务/算法逻辑写错了】的逻辑暗疾，例如：\n1. 数组索引越界、偏置错误 (如 range(n) 访问 arr[i+1] 或 arr[n-i])\n2. 循环条件与步长错误 (如死循环、步长相反、提前跳出)\n3. 双指针反转或遍历方向反了 (如两个指针同向变动)\n4. 变量重复覆盖导致信息丢失 (如 temp 未暂存就被覆盖)\n5. 比较运算符正反写错 (如降序误写成升序比较)\n6. 变量可变性与常量声明冲突\n\n[DSL 语义块 (${sBlk.block_id})]:\n${sBlk.content}\n\n[生成的代码块 (${cBlk.block_id})]:\n${cBlk.content}\n\n请只输出纯 JSON 对象：\n- 若逻辑完全正确无误，输出: {"flaw_detected": false}\n- 若检测到逻辑错误，输出: {"flaw_detected": true, "block_id": "${sBlk.block_id}", "issue": "具体错误原因", "suggestion": "正确写法修改建议"}`;

      const decision = await ctxState.jevClient.callChatCompletions(
        `${ctxState.jevClient.baseUrl}/chat/completions`,
        `模块: ${paths.base_name}, 块: ${sBlk.block_id}`,
        { type: 'noul', prompt },
        'noul'
      );

      const jsonStr = extractFirstJsonObject(decision?.choice || decision?.gate || JSON.stringify(decision));
      if (jsonStr) {
        const parsed = JSON.parse(jsonStr);
        if (parsed.flaw_detected) {
          flaws.push({
            block_id: sBlk.block_id,
            issue: parsed.issue,
            suggestion: parsed.suggestion
          });
        }
      }
    } catch (e) {
      console.warn(`[review_semantics] Jev inspection warning on block ${sBlk.block_id}: ${e.message}`);
    }
  }

  return {
    status: flaws.length === 0 ? 'success' : 'flaws_detected',
    action: 'review_semantics',
    reviewed: true,
    reviewed_blocks: reviewedBlocks,
    flaws_count: flaws.length,
    flaws,
    notice: flaws.length === 0
      ? '✅ Jev 4B 深度语义审校通过：所有块的 DSL 意图与生成代码逻辑一致，未检测到隐藏逻辑缺陷。'
      : `⚠️ Jev 4B 深度审校发现 ${flaws.length} 处潜在逻辑硬伤，请根据建议调整 DSL。`
  };
}

export async function actionAutoMark(args, ctxState) {
  const modulePath = args.module_path || args.file_path;
  if (!modulePath) throw new Error('auto_mark 需要提供 `module_path` 或 `file_path`');

  const targetLang = args.target_lang || 'python';
  let targetFile = path.resolve(modulePath);
  if (!fs.existsSync(targetFile)) {
    const paths = ThreeFileManager.resolvePaths(modulePath, targetLang);
    targetFile = paths.code_file;
  }

  if (!fs.existsSync(targetFile)) {
    throw new Error(`未找到代码文件: ${targetFile}`);
  }

  const rawCode = fs.readFileSync(targetFile, 'utf8');
  if (rawCode.includes('@jev-block:') && !args.force) {
    const { blocks } = BlockSplitter.split(rawCode, targetLang);
    return {
      status: 'already_marked',
      action: 'auto_mark',
      file: targetFile,
      blocks_count: blocks.length,
      blocks: blocks.map(b => ({ block_id: b.block_id, start_line: b.start_line, end_line: b.end_line })),
      notice: '文件已存在 @jev-block 标记，无需重复打标。如需重新打标请传入 force: true。'
    };
  }

  const codeToMark = AutoMarker.stripJevMarkers(rawCode);
  const markResult = AutoMarker.autoMark(codeToMark || rawCode, targetLang);

  ThreeFileManager.createBackup(targetFile);
  fs.writeFileSync(targetFile, markResult.markedCode, 'utf8');

  let specResult = null;
  if (args.generate_spec === true) {
    specResult = await actionCodeToSpec({ module_path: modulePath, target_lang: targetLang }, ctxState);
  }

  return {
    status: 'success',
    action: 'auto_mark',
    file: targetFile,
    target_lang: targetLang,
    blocks_count: markResult.blocks_count,
    blocks: markResult.blocks,
    spec_dsl: specResult?.spec_dsl || null,
    notice: `✅ 自动为代码识别并插入 ${markResult.blocks_count} 个 @jev-block 语义块。${specResult ? ' 且已同步生成 spec DSL。' : ''}`
  };
}

export async function actionMoveModule(args, ctxState) {
  const srcModule = args.source_module || args.module_path;
  const dstModule = args.target_module || args.destination || args.target_path;
  if (!srcModule || !dstModule) {
    throw new Error('move_module 需要提供 `source_module` (或 module_path) 和 `target_module` (或 destination)');
  }

  const targetLang = args.target_lang || 'python';
  const srcPaths = ThreeFileManager.resolvePaths(srcModule, targetLang);

  let resolvedDst = dstModule;
  if (dstModule.endsWith('/') || dstModule.endsWith('\\') || (fs.existsSync(dstModule) && fs.statSync(dstModule).isDirectory())) {
    resolvedDst = path.join(dstModule, srcPaths.base_name);
  }
  const dstPaths = ThreeFileManager.resolvePaths(resolvedDst, targetLang);

  const result = ThreeFileManager.moveModule(srcPaths, dstPaths);
  return {
    status: 'success',
    action: 'move_module',
    ...result
  };
}

export async function actionDeleteModule(args, ctxState) {
  const modulePath = args.module_path;
  if (!modulePath) {
    throw new Error('delete_module 需要提供 `module_path`');
  }

  const targetLang = args.target_lang || 'python';
  const paths = ThreeFileManager.resolvePaths(modulePath, targetLang);

  const result = ThreeFileManager.deleteModule(paths);
  return {
    status: 'success',
    action: 'delete_module',
    ...result
  };
}

export const ACTIONS = {
  split_blocks: actionSplitBlocks,
  spec_to_code: actionSpecToCode,
  code_to_spec: actionCodeToSpec,
  translate_block: actionTranslateBlock,
  check_alignment: actionCheckAlignment,
  check_spec: actionCheckSpec,
  check_tables: actionCheckTables,
  spec_to_spec: actionSpecToSpec,
  spec_export: actionSpecExport,
  rollback: actionRollback,
  list_tables: actionListTables,
  import_table: actionImportTable,
  validate_vocab: actionValidateVocab,
  jev_decision: actionJevDecision,
  get_config: actionGetConfig,
  set_config: actionSetConfig,
  review_semantics: actionReviewSemantics,
  auto_mark: actionAutoMark
};

export async function runJevAgent(args, ctxState) {
  if (!args || typeof args !== 'object') {
    throw new Error('jevagent 参数必须是 JSON 对象');
  }
  const action = args.action;
  if (!action) {
    throw new Error('jevagent 缺少必填参数 `action`');
  }

  const handler = ACTIONS[action];
  if (!handler) {
    throw new Error(`未知的 jevagent action: ${action}。支持的操作: ${Object.keys(ACTIONS).join(', ')}`);
  }

  const result = await handler(args, ctxState);
  return JSON.stringify(result, null, 2);
}


// =============================================================================
// JevGuard: Intercept direct code-writing operations to prevent model hallucinations
// =============================================================================

export const CODE_EXTENSIONS = new Set([
  '.py', '.pyw',
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.c', '.cpp', '.cxx', '.cc', '.h', '.hpp', '.hxx',
  '.sh', '.bash', '.zsh',
  '.go', '.rs', '.java', '.kt', '.kts',
  '.cs', '.swift', '.rb', '.lua', '.php',
  '.sql'
]);

export function isCodeFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (/\.spec\.[a-zA-Z0-9_\-]+\.dsl$/i.test(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

export function resolveTargetFilePath(exec) {
  const args = exec?.arguments || {};
  if (exec?.name === 'write' || exec?.name === 'edit') {
    return args.file_path;
  }
  if (exec?.name === 'str_replace_editor') {
    const cmd = args.command;
    if (cmd === 'create' || cmd === 'str_replace' || cmd === 'insert') {
      return args.path;
    }
  }
  return null;
}

export function createJevGuard(ctxState) {
  async function preExecute(exec, next) {
    const currentCfg = ctxState?.jevClient?.getConfig(false) || {};
    const persistedCfg = loadPersistedConfig();
    const allowDirect = currentCfg.allow_direct_code_write === true || 
                        persistedCfg.allow_direct_code_write === true ||
                        ctxState?.config?.allow_direct_code_write === true;
    const guardFenceConfig = persistedCfg.guard_fence_config !== false;
    const guardRename = persistedCfg.guard_extension_rename !== false;

    // 0. FENCE CONFIG PROTECTION: Block AI from modifying fence config files (jevagent.json, plugin files, cordis configs)
    const targetFile = resolveTargetFilePath(exec);
    if (guardFenceConfig && targetFile && AutoMarker.isFenceConfigFile(targetFile)) {
      return {
        kind: 'deny',
        reason: [
          `[JevGuard 核心围栏保护] 严禁 AI 直接修改或覆写安全围栏配置文件: "${targetFile}"。`,
          '',
          '🔒 保护策略：',
          '  开关配置文件（如 jevagent.json）与安全围栏源码属于最高安全级别约束，只能由人类从外部或在 DSH 设置/界面开关中手动调节。',
          '  AI 无权使用任何工具（write/edit/str_replace_editor）篡改自身的安全围栏配置。普通项目代码与配置文件（如 package.json, config.json 等）不受此限制。'
        ].join('\n')
      };
    }

    // 1. SHELL COMMAND INTERCEPTION (pwsh, bash, cmd)
    const isShellCmd = ['pwsh', 'bash', 'cmd', 'sh', 'powershell', 'exec'].includes(exec?.name);
    if (isShellCmd) {
      const commandStr = exec?.arguments?.command || exec?.arguments?.script || '';

      // Check fence file tampering via shell
      if (guardFenceConfig) {
        const fenceTamper = AutoMarker.detectProhibitedFenceCommand(commandStr);
        if (fenceTamper) {
          return {
            kind: 'deny',
            reason: [
              `[JevGuard 核心围栏保护] 检测到试图通过命令行修改或篡改安全围栏配置文件: "${fenceTamper.file}"。`,
              `受阻断命令: "${commandStr}"`,
              '',
              '🔒 保护策略：严禁通过命令行重命名、移动、删除或覆盖围栏配置文件。该操作只能由人类在外部进行。'
            ].join('\n')
          };
        }
      }

      // Check code file rename evasion or redirection via shell
      if (!allowDirect && guardRename) {
        const prohibited = AutoMarker.detectProhibitedCodeCommand(commandStr, CODE_EXTENSIONS);
        if (prohibited) {
          return {
            kind: 'deny',
            reason: [
              `[JevGuard 后缀名防改与代码写入保护] 检测到试图通过命令行改动或覆盖写入代码文件: "${prohibited.file}"。`,
              `受阻断命令: "${commandStr}"`,
              '',
              '🔒 保护策略：',
              '  1. 严禁将非代码文件（如 .txt, .tmp, .bak）重命名或复制为代码文件以绕过保护；',
              '  2. 严禁将受保护的代码文件（如 .py, .js, .c 等）改名为其他后缀脱壳篡改；',
              '  3. 严禁通过命令行重定向（> 或 >>）、Set-Content、Out-File 等直接写入代码。',
              '',
              '💡 正确流程：',
              '  - 在二文件模型中，代码文件由 DSL 唯一驱动。请使用 jevagent(action="move_module") / jevagent(action="delete_module") 统一操作，或将对应的 spec DSL 文件一同联动操作；',
              '  - 若确需直接操作，请向人类用户申请权限，由人类在界面快捷开关或设置中开启【允许直接修改代码】。'
            ].join('\n')
          };
        }
      }

      return next();
    }

    // 2. TOOL FILE WRITES / EDITS (write, edit, str_replace_editor)
    if (!targetFile || !isCodeFilePath(targetFile)) {
      return next();
    }

    // If human has manually enabled allow_direct_code_write, pass
    if (allowDirect) {
      return next();
    }

    const normPath = path.resolve(targetFile);
    const args = exec?.arguments || {};

    // Pure @jev-block marker annotation pass-through (avoids nuisance interception when onboarding legacy code)
    let isAnnotation = false;
    if (args.purpose === 'mark_blocks' || args.annotate === true) {
      isAnnotation = true;
    } else if (exec?.name === 'edit' && args.old_string && args.new_string) {
      if (AutoMarker.isPureAnnotation(args.old_string, args.new_string)) {
        isAnnotation = true;
      }
    } else if (exec?.name === 'write' && args.content && fs.existsSync(normPath)) {
      try {
        const diskContent = fs.readFileSync(normPath, 'utf8');
        if (AutoMarker.isPureAnnotation(diskContent, args.content)) {
          isAnnotation = true;
        }
      } catch {}
    } else if (exec?.name === 'str_replace_editor' && args.old_str && args.new_str) {
      if (AutoMarker.isPureAnnotation(args.old_str, args.new_str)) {
        isAnnotation = true;
      }
    }

    if (isAnnotation) {
      return next();
    }

    // STRICT HARD DENIAL: AI cannot bypass by itself!
    const ext = path.extname(targetFile).toLowerCase();
    const baseName = path.basename(targetFile, ext);
    const langHint = ext === '.py' ? 'python' : (ext === '.c' ? 'c' : (ext === '.sh' ? 'shell' : 'javascript'));

    const reminder = [
      `[JevGuard 核心安全拦截] 严禁直接修改或创建代码文件: "${targetFile}"。`,
      '',
      '🔒 保护状态：当前处于【代码强保护模式】。',
      'DSL 是逻辑承载层与语法剥离层，任何绕过 DSL 直接编写代码的行为均已被彻底阻断。AI 无权自行通过参数或重试解除此项保护。',
      '',
      '💡 合规途径（唯一推荐）：',
      `  1. 编写特化语义规范文件: ${baseName}.spec.${langHint}.dsl（唯一真相源）`,
      `  2. 调用 jevagent(action="spec_to_code", module_path="${baseName}", target_lang="${langHint}") 编译代码`,
      `  3. 或对单块调用 jevagent(action="translate_block", block_id=...) 局部更新`,
      `  4. 逆向已有代码时，使用 jevagent(action="auto_mark", module_path="${baseName}") 自动切块打标`,
      '',
      '⚡ 人类授权申请：',
      '若当前确属无法使用 DSL 的特殊底层环境或紧急修补场景，你必须在对话中向人类用户申请临时写权限：',
      '  - 向人类清晰说明必须直接修改源码的具体原因；',
      '  - 在接到人类明确许可后，由人类在 DSH 界面快捷开关或系统设置中开启【允许直接写代码】。'
    ].join('\n');

    return {
      kind: 'deny',
      reason: reminder
    };
  }

  return { preExecute, isCodeFilePath, resolveTargetFilePath };
}

// =============================================================================
// Cordis Plugin Lifecycle
// =============================================================================

export function apply(ctx, config = {}) {
  const persisted = loadPersistedConfig();
  const mergedConfig = {
    ...config,
    ...persisted
  };

  const router = new RouterEngine({
    tablesDir: mergedConfig.tables_dir || TABLES_DIR
  });
  const jevClient = new JevClient(mergedConfig);

  const ctxState = {
    router,
    jevClient,
    config: mergedConfig
  };

  // Register the model-facing `jevagent` tool
  // Register JevGuard pre-execution interceptor
  const guard = createJevGuard(ctxState);
  if (ctx && typeof ctx.on === 'function') {
    ctx.on('tools/pre-execute', (exec, next) => guard.preExecute(exec, next));
  }

  ctx.tools.register(defineTool({
    name: 'jevagent',
    description: [
      'JevAgent: Programming-dedicated extension tool for semantic DSL, two-file model, and typed Jev decisions.',
      '* Actions:',
      '  - `split_blocks`: Parse and inspect blocks in a file with @jev-block markers.',
      '  - `spec_to_code`: Translate specialized semantic DSL (.spec.<lang>.dsl) to executable code (.<ext>).',
      '  - `code_to_spec`: Reverse-translate marked code (.<ext>) to specialized semantic DSL (.spec.<lang>.dsl).',
      '  - `translate_block`: Translate a single block by block_id for in-place partial update (modifying only that block).',
      '  - `check_alignment`: Verify block ID alignment and delimiter integrity across the two files (spec and code).',
      '  - `check_spec`: Run verification firewall on spec DSL (checks undeclared symbols, libraries, confusions).',
      '  - `check_tables`: Verify core syntax conformance matrix across language tables.',
      '  - `spec_to_spec`: Migrate spec DSL across programming languages with classification report.',
      '  - `spec_export`: Export clean read-only spec without node annotations.',
      '  - `rollback`: Roll back module/block state to previous confirmed snapshot.',
      '  - `import_table`: Import and hot-register external tree table JSON into tables directory.',
      '  - `list_tables`: List all currently loaded built-in and external tree tables.',
      '  - `validate_vocab`: Validate candidate vocabulary according to Jev syntax rules.',
      '  - `jev_decision`: Execute typed decision (choice, score, noul) via the dedicated Jev model API.',
      '  - `get_config`: View current Jev API address, API key status, model, and independent toggle switch state.',
      '  - `set_config`: Dynamically configure Jev API address, key, model, and toggle switch state at runtime.',
      '  - `auto_mark`: Automatically demarcate code blocks with @jev-block markers using AST/language heuristics.',
      '  - `move_module`: Atomically move or rename a module (linked moving of spec DSL, code file, backups, and index).',
      '  - `delete_module`: Safely delete a module (cascaded cleanup of spec DSL, code file, backups, and index).',
      '* Two-file model: <module>.spec.<lang>.dsl, <module>.<ext> under the same directory.'
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'split_blocks',
          'spec_to_code',
          'code_to_spec',
          'translate_block',
          'check_alignment',
          'check_spec',
          'check_tables',
          'spec_to_spec',
          'spec_export',
          'rollback',
          'import_table',
          'list_tables',
          'validate_vocab',
          'jev_decision',
          'get_config',
          'set_config',
          'review_semantics',
          'auto_mark'
        ],
        description: 'Action to perform.'
      },
      module_path: {
        type: 'string',
        description: "Base module path without extension (e.g. 'src/auth/auth' or 'auth')."
      },
      target_lang: {
        type: 'string',
        description: "Target programming language (e.g. 'python', 'c', 'shell', 'javascript', 'go', 'rust')."
      },
      source_lang: {
        type: 'string',
        description: "Source programming language for spec_to_spec cross-language migration."
      },
      table_ref: {
        type: 'string',
        description: "Optional routing table reference (e.g. 'python_v3', 'c_v1', 'shell_v2')."
      },
      block_id: {
        type: 'string',
        description: "Block identifier (e.g. 'auth_001') for single-block translation or rollback."
      },
      direction: {
        type: 'string',
        enum: ['spec_to_code', 'code_to_spec'],
        description: 'Translation direction for single block translation.'
      },
      block_content: {
        type: 'string',
        description: 'Optional custom content for the block during translate_block.'
      },
      file_path: {
        type: 'string',
        description: 'Explicit file path for split_blocks, check_alignment, or import_table.'
      },
      file_type: {
        type: 'string',
        description: "File type hint ('spec_dsl', 'code')."
      },
      table_content: {
        type: 'string',
        description: 'JSON string content of the external tree table when importing.'
      },
      strict: {
        type: 'boolean',
        description: 'Whether check_spec enforces strict verification.'
      },
      jev_question: {
        type: 'object',
        additionalProperties: true,
        description: 'Question object for jev_decision (type: choice|score|noul, candidates, prompt).'
      },
      state: {
        type: 'string',
        description: 'State or context string for jev_decision.'
      },
      vocab_candidate: {
        type: 'object',
        additionalProperties: true,
        description: 'Candidate vocabulary JSON for validate_vocab.'
      },
      jev_enabled: {
        type: 'boolean',
        description: 'Independent switch to enable/disable remote Jev API (true=remote Jev, false=local deterministic).'
      },
      jev_base_url: {
        type: 'string',
        description: 'Jev API endpoint URL (e.g. http://127.0.0.1:8199).'
      },
      jev_api_key: {
        type: 'string',
        description: 'Independent Jev API key.'
      },
      jev_model: {
        type: 'string',
        description: 'Jev decision model name (e.g. jevk5-4b-v0.3-Q4_K_M).'
      },
      jev_timeout_s: {
        type: 'number',
        description: 'Jev API request timeout in seconds.'
      },
      tables_dir: {
        type: 'string',
        description: 'Custom directory path for routing tables.'
      }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      return await runJevAgent(args, ctxState);
    }
  }));

  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      promptCtx.systemPrompt.section({
        name: 'jevagent-guidance',
        order: 90,
        text: [
          '# JevAgent Engineering Guidelines',
          'When asked to write, implement, refactor, or translate code across programming languages,',
          'you should adopt the formal two-file model (<module>.spec.<lang>.dsl, <module>.<ext>) via the `jevagent` tool.',
          '1. Writing flow: write specialized semantic DSL into <module>.spec.<lang>.dsl with @jev-block markers, then call jevagent(action="spec_to_code").',
          '2. Pre-check: call jevagent(action="check_spec") before code generation to verify symbols and syntax.',
          '3. In-place modification flow: modify a single block and call jevagent(action="translate_block", direction="spec_to_code", block_id=...).',
          '4. Conversion flow: mark existing code with @jev-block markers, then call jevagent(action="code_to_spec") to reverse-translate into <module>.spec.<lang>.dsl.',
          '5. Always verify alignment with jevagent(action="check_alignment").',
          '6. Cross-language migration: call jevagent(action="spec_to_spec") and follow the classification report (verbatim=copy, partial=requires, rewrite=manual).',
          '7. Query or update Jev API endpoint and switch via jevagent(action="get_config") or jevagent(action="set_config").',
          '8. Anti-hallucination guard: Direct modifications to code files are protected by JevGuard. Use two-file model as primary workflow; direct writes to code require a retry or confirm_direct_write: true for intentional low-level modifications.'
        ].join('\n')
      });
    } catch {
      // ignore
    }
  });

  ctx.inject(['webServer'], (webCtx) => {
    const ws = webCtx.webServer;
    if (!ws || typeof ws.register !== 'function') return;

    async function readBody(req) {
      const chunks = [];
      for await (const chunk of req) chunks.push(String(chunk));
      return JSON.parse(chunks.join('') || '{}');
    }

    ws.register({
      kind: 'exact',
      path: '/api-jevagent/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const clientConfig = ctxState.jevClient.getConfig(false);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              config: {
                ...clientConfig,
                tables_dir: ctxState.router.tablesDir
              }
            }));
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody(req);
            await actionSetConfig(body, ctxState);
            const clientConfig = ctxState.jevClient.getConfig(false);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              config: {
                ...clientConfig,
                tables_dir: ctxState.router.tablesDir
              }
            }));
            return;
          }
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
        }
      }
    });

    ws.register({
      kind: 'exact',
      path: '/api-jevagent/test',
      handler: async (req, res) => {
        try {
          const body = await readBody(req);
          const testClient = new JevClient({
            jev_base_url: body.jev_base_url || ctxState.jevClient.baseUrl,
            jev_api_key: body.jev_api_key !== undefined ? body.jev_api_key : ctxState.jevClient.apiKey,
            jev_model: body.jev_model || ctxState.jevClient.model,
            jev_timeout_s: Math.max(120, Number(body.jev_timeout_s) || (ctxState.jevClient.timeoutMs / 1000) || 120)
          });
          const start = Date.now();
          const decision = await testClient.decide('ping', {
            type: 'noul',
            instructions: '测试 Jev 决策接口连通性',
            allow_degraded: true
          });
          const latency = Date.now() - start;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (decision.provider === 'remote_jev_api') {
            res.end(JSON.stringify({
              ok: true,
              status: 'connected',
              provider: decision.provider,
              endpoint_used: decision.endpoint_used,
              latency_ms: latency,
              decision
            }));
          } else {
            res.end(JSON.stringify({
              ok: false,
              status: 'degraded',
              provider: decision.provider,
              latency_ms: latency,
              error: decision.remote_error || '远程 Jev 服务未连通，已降级为本地启发式',
              decision
            }));
          }
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: String((err && err.message) || err)
          }));
        }
      }
    });
  });
}