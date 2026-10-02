// three-file.js — Three-file model and manifest / blocks_index manager
// Conforms to JevAgent Engineering Spec Section 2, 10, 11

import fs from 'node:fs';
import path from 'node:path';
import { BlockSplitter } from './splitter.js';

export const EXTENSION_MAP = {
  python: '.py',
  py: '.py',
  c: '.c',
  shell: '.sh',
  sh: '.sh',
  bash: '.sh',
  javascript: '.js',
  js: '.js',
  typescript: '.ts',
  ts: '.ts',
  go: '.go',
  golang: '.go',
  rust: '.rs',
  rs: '.rs',
  cpp: '.cpp',
  cxx: '.cpp',
  html: '.html',
  css: '.css',
  sql: '.sql',
  lua: '.lua'
};

export class ThreeFileManager {
  static resolveExt(lang = 'python') {
    const key = (lang || 'python').toLowerCase().trim();
    return EXTENSION_MAP[key] || `.${key}`;
  }

  static resolvePaths(modulePath, targetLang = 'python', cwd = process.cwd()) {
    let cleanPath = modulePath.trim();
    // Strip known extensions if passed with one
    cleanPath = cleanPath
      .replace(/\.high\.dsl$/i, '')
      .replace(/\.spec\.[a-zA-Z0-9_-]+\.dsl$/i, '');

    for (const ext of Object.values(EXTENSION_MAP)) {
      if (cleanPath.endsWith(ext)) {
        cleanPath = cleanPath.slice(0, -ext.length);
        break;
      }
    }

    const fullBase = path.isAbsolute(cleanPath)
      ? cleanPath
      : path.resolve(cwd, cleanPath);

    const dir = path.dirname(fullBase);
    const baseName = path.basename(fullBase);
    const normLang = (targetLang || 'python').toLowerCase().trim();
    const ext = this.resolveExt(normLang);

    return {
      dir,
      base_name: baseName,
      target_lang: normLang,
      spec_dsl: path.join(dir, `${baseName}.spec.${normLang}.dsl`),
      code_file: path.join(dir, `${baseName}${ext}`),
      blocks_index: path.join(dir, 'blocks_index.json'),
      manifest_file: path.join(dir, 'manifest.json')
    };
  }

  static updateBlocksIndex(paths, blocks, status = 'translated', symbolsMap = {}) {
    const indexPath = paths.blocks_index;
    let data = { module: paths.base_name, blocks: [] };

    if (fs.existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (parsed && Array.isArray(parsed.blocks)) {
          data = parsed;
        }
      } catch {
        // ignore parse error, re-create
      }
    }

    const blockMap = new Map();
    for (const b of data.blocks) {
      blockMap.set(b.block_id, b);
    }

    const relSpec = path.relative(paths.dir, paths.spec_dsl);
    const relCode = path.relative(paths.dir, paths.code_file);
    const lang = paths.target_lang;

    for (const blk of blocks) {
      const bid = blk.block_id;
      const category = blk.category || (bid === 'names' ? 'declaration-only' : (bid === 'imports' ? 'hoisted' : 'emitting'));
      const existing = blockMap.get(bid) || {
        block_id: bid,
        category,
        migration_class: blk.migration_class || 'verbatim',
        files: {
          spec: {},
          code: {}
        },
        symbols_defined: [],
        symbols_used: [],
        status: status
      };

      if (!existing.files) existing.files = {};
      if (!existing.files.spec) existing.files.spec = {};
      if (!existing.files.code) existing.files.code = {};
      existing.files.spec[lang] = relSpec;
      if (category !== 'declaration-only') {
        existing.files.code[lang] = relCode;
      }
      existing.category = category;
      existing.migration_class = blk.migration_class || existing.migration_class || 'verbatim';

      if (symbolsMap && symbolsMap[bid]) {
        existing.symbols_defined = symbolsMap[bid].defined || [];
        existing.symbols_used = symbolsMap[bid].used || [];
      }
      existing.status = status;
      blockMap.set(bid, existing);
    }

    data.blocks = Array.from(blockMap.values());
    if (!fs.existsSync(paths.dir)) {
      fs.mkdirSync(paths.dir, { recursive: true });
    }
    fs.writeFileSync(indexPath, JSON.stringify(data, null, 2) + '\n', 'utf8');

    // Update manifest.json
    this.updateManifest(paths);
  }

  static updateManifest(paths, options = {}) {
    const manifestPath = paths.manifest_file;
    const now = new Date();
    const dateStr = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}_${String(now.getDate()).padStart(2, '0')}_001`;

    let manifest = {
      manifest_id: `manifest_${dateStr}`,
      model: 'two_file_v3',
      syntax_core: 'syntax_core_v1',
      skeleton: 'common_skeleton_v1',
      skeleton_applied: options.skeleton_applied !== undefined ? options.skeleton_applied : true,
      semantic: 'semantic_v1',
      tables: {},
      vocab: 'common_v3',
      mappings: {},
      required_imports_version: '1.0',
      core_conformance_version: '1.0',
      symbol_snapshot: options.symbol_snapshot || {},
      names_snapshot: options.names_snapshot || {},
      code_commit: options.code_commit || null,
      spec_commit: options.spec_commit || null,
      jev_model: 'jevk5-4b-v0.3-Q4_K_M',
      jevagent_version: '3.0.0'
    };

    if (fs.existsSync(manifestPath)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (loaded && typeof loaded === 'object') {
          manifest = { ...manifest, ...loaded };
        }
      } catch {
        // ignore
      }
    }

    if (!manifest.tables) manifest.tables = {};
    if (!manifest.mappings) manifest.mappings = {};

    const lang = paths.target_lang;
    manifest.tables[lang] = lang === 'python' ? 'python_v3' : `${lang}_v1`;
    manifest.mappings[lang] = `${lang}_v1_semantic`;
    if (options.skeleton_applied !== undefined) {
      manifest.skeleton_applied = options.skeleton_applied;
    }

    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    } catch {
      // ignore
    }
  }

  static checkAlignment(paths) {
    const issues = [];
    const report = {
      module: paths.base_name,
      target_lang: paths.target_lang,
      files_exist: {},
      blocks_matching: true,
      block_ids: { spec: [], code: [] },
      issues: []
    };

    const files = [
      { key: 'spec', path: paths.spec_dsl, lang: paths.target_lang },
      { key: 'code', path: paths.code_file, lang: paths.target_lang }
    ];

    const blockLists = {};

    for (const f of files) {
      const exists = fs.existsSync(f.path);
      report.files_exist[f.key] = exists;
      if (!exists) {
        issues.push(`文件不存在: ${f.path}`);
        blockLists[f.key] = [];
        continue;
      }

      try {
        const content = fs.readFileSync(f.path, 'utf8');
        const splitResult = BlockSplitter.split(content, f.lang);
        const filteredBlocks = f.key === 'spec'
          ? splitResult.blocks.filter(b => b.category !== 'declaration-only')
          : splitResult.blocks;
        blockLists[f.key] = filteredBlocks.map(b => b.block_id);
        report.block_ids[f.key] = blockLists[f.key];
      } catch (err) {
        issues.push(`解析 ${f.key} 文件标记失败: ${err.message}`);
        blockLists[f.key] = [];
      }
    }

    // Verify alignment between spec and code
    const specBlocks = blockLists.spec || [];
    const codeBlocks = blockLists.code || [];

    if (report.files_exist.spec && report.files_exist.code) {
      if (specBlocks.join(',') !== codeBlocks.join(',')) {
        report.blocks_matching = false;
        issues.push(`spec 与 code 块 ID 顺序或集合不一致: spec=[${specBlocks.join(', ')}] vs code=[${codeBlocks.join(', ')}]`);
      }
    }

    report.issues = issues;
    report.aligned = issues.length === 0;
    return report;
  }

  static createBackup(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const bakPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, bakPath);
    return bakPath;
  }

  static rollback(paths, blockId = null) {
    const results = {};
    const targets = [paths.spec_dsl, paths.code_file];

    for (const f of targets) {
      const bak = `${f}.bak`;
      if (fs.existsSync(bak)) {
        if (!blockId) {
          // Full file rollback
          fs.copyFileSync(bak, f);
          results[path.basename(f)] = 'rolled_back_full';
        } else {
          // Block level rollback
          try {
            const currentContent = fs.readFileSync(f, 'utf8');
            const bakContent = fs.readFileSync(bak, 'utf8');
            const curSplit = BlockSplitter.split(currentContent, paths.target_lang);
            const bakSplit = BlockSplitter.split(bakContent, paths.target_lang);

            const bakBlock = bakSplit.blocks.find(b => b.block_id === blockId);
            if (bakBlock) {
              const curIndex = curSplit.blocks.findIndex(b => b.block_id === blockId);
              if (curIndex >= 0) {
                curSplit.blocks[curIndex] = bakBlock;
                const isCode = f === paths.code_file;
                const restored = BlockSplitter.assemble(curSplit.blocks, curSplit.trailingFree, paths.target_lang, { skipDeclarationOnly: isCode });
                fs.writeFileSync(f, restored, 'utf8');
                results[path.basename(f)] = `block_${blockId}_restored`;
              }
            }
          } catch (e) {
            results[path.basename(f)] = `error: ${e.message}`;
          }
        }
      } else {
        results[path.basename(f)] = 'no_backup_found';
      }
    }

    return {
      status: 'success',
      module: paths.base_name,
      block_id: blockId,
      results
    };
  }
  static moveModule(srcPaths, dstPaths) {
    if (!fs.existsSync(srcPaths.spec_dsl)) {
      throw new Error(`无法移动模块：源特化 DSL 不存在 (${srcPaths.spec_dsl})`);
    }

    // 1. Ensure target directory exists
    if (!fs.existsSync(dstPaths.dir)) {
      fs.mkdirSync(dstPaths.dir, { recursive: true });
    }

    const movedFiles = [];

    // 2. Move spec DSL
    fs.renameSync(srcPaths.spec_dsl, dstPaths.spec_dsl);
    movedFiles.push({ type: 'spec_dsl', from: srcPaths.spec_dsl, to: dstPaths.spec_dsl });

    // 3. Move code file if present
    if (fs.existsSync(srcPaths.code_file)) {
      fs.renameSync(srcPaths.code_file, dstPaths.code_file);
      movedFiles.push({ type: 'code_file', from: srcPaths.code_file, to: dstPaths.code_file });
    }

    // 4. Move backups if present
    const specBak = `${srcPaths.spec_dsl}.bak`;
    if (fs.existsSync(specBak)) {
      fs.renameSync(specBak, `${dstPaths.spec_dsl}.bak`);
      movedFiles.push({ type: 'spec_bak', from: specBak, to: `${dstPaths.spec_dsl}.bak` });
    }
    const codeBak = `${srcPaths.code_file}.bak`;
    if (fs.existsSync(codeBak)) {
      fs.renameSync(codeBak, `${dstPaths.code_file}.bak`);
      movedFiles.push({ type: 'code_bak', from: codeBak, to: `${dstPaths.code_file}.bak` });
    }

    // 5. Update blocks_index.json in source directory if directory changed
    if (srcPaths.dir !== dstPaths.dir) {
      this.removeFromBlocksIndex(srcPaths);
    }

    // 6. Update blocks_index in destination directory
    try {
      const splitRes = BlockSplitter.split(fs.readFileSync(dstPaths.spec_dsl, 'utf8'), dstPaths.target_lang);
      this.updateBlocksIndex(dstPaths, splitRes.blocks, 'confirmed');
    } catch {}

    return {
      status: 'success',
      source: srcPaths.base_name,
      target: dstPaths.base_name,
      source_dir: srcPaths.dir,
      target_dir: dstPaths.dir,
      moved_files: movedFiles
    };
  }

  static deleteModule(paths) {
    const deletedFiles = [];

    // 1. Delete spec DSL
    if (fs.existsSync(paths.spec_dsl)) {
      fs.unlinkSync(paths.spec_dsl);
      deletedFiles.push(paths.spec_dsl);
    }

    // 2. Delete code file
    if (fs.existsSync(paths.code_file)) {
      fs.unlinkSync(paths.code_file);
      deletedFiles.push(paths.code_file);
    }

    // 3. Delete backups
    const specBak = `${paths.spec_dsl}.bak`;
    if (fs.existsSync(specBak)) {
      fs.unlinkSync(specBak);
      deletedFiles.push(specBak);
    }
    const codeBak = `${paths.code_file}.bak`;
    if (fs.existsSync(codeBak)) {
      fs.unlinkSync(codeBak);
      deletedFiles.push(codeBak);
    }

    // 4. Remove from blocks_index.json
    this.removeFromBlocksIndex(paths);

    return {
      status: 'success',
      module: paths.base_name,
      dir: paths.dir,
      deleted_files: deletedFiles
    };
  }

  static removeFromBlocksIndex(paths) {
    const indexPath = paths.blocks_index;
    if (fs.existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (parsed && Array.isArray(parsed.blocks)) {
          const lang = paths.target_lang;
          const relSpec = path.relative(paths.dir, paths.spec_dsl);
          parsed.blocks = parsed.blocks.filter(b => {
            if (b.files?.spec?.[lang] === relSpec) return false;
            return true;
          });
          fs.writeFileSync(indexPath, JSON.stringify(parsed, null, 2), 'utf8');
        }
      } catch {}
    }
  }

}
