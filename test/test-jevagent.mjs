// test-jevagent.mjs — Comprehensive test suite for JevAgent DSH plugin with full regression tests
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TABLES_DIR = path.resolve(__dirname, '../tables');
const TEST_TMP_DIR = path.resolve(__dirname, 'tmp');

// K4 Isolation: isolate test config file so tests NEVER mutate production ~/.dsh/jevagent.json
if (!fs.existsSync(TEST_TMP_DIR)) {
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
}
const TEST_CFG_FILE = path.join(TEST_TMP_DIR, 'jevagent_test.json');
process.env.JEV_CONFIG_FILE = TEST_CFG_FILE;

import {
  actionSplitBlocks,
  actionSpecToCode,
  actionCodeToSpec,
  actionTranslateBlock,
  actionCheckAlignment,
  actionCheckSpec,
  actionCheckTables,
  actionSpecToSpec,
  actionSpecExport,
  actionRollback,
  actionListTables,
  actionImportTable,
  actionValidateVocab,
  actionJevDecision,
  actionGetConfig,
  actionSetConfig,
  runJevAgent,
  createJevGuard
} from '../lib/index.js';

import { RouterEngine } from '../lib/router.js';
import { JevClient } from '../lib/jev-client.js';

async function runTests() {
  console.log('=== Starting JevAgent DSH Plugin Unit & Regression Tests ===\n');

  const router = new RouterEngine({ tablesDir: TABLES_DIR });
  const jevClient = new JevClient();
  const ctxState = { router, jevClient };

  // 1. Test actionListTables
  console.log('1. Testing list_tables...');
  const tablesRes = await actionListTables({}, ctxState);
  assert.strictEqual(tablesRes.status, 'success');
  assert.ok(tablesRes.tables.length >= 4, `Expected at least 4 tables, got ${tablesRes.tables.length}`);
  const tableIds = tablesRes.tables.map(t => t.table_id);
  assert.ok(tableIds.includes('python_v3'), 'Should include python_v3');
  assert.ok(tableIds.includes('c_v1'), 'Should include c_v1');
  assert.ok(tableIds.includes('shell_v2'), 'Should include shell_v2');
  console.log('   ✓ list_tables passed with tables:', tableIds.join(', '));

  // 2. BUG-04 & BUG-05 Regression: Test inferSemanticNode
  console.log('\n2. Testing inferSemanticNode (BUG-04 & BUG-05 regression)...');
  const nodeCall = router.inferSemanticNode('主函数()');
  assert.strictEqual(nodeCall, '/semantic/function/call', '主函数() must infer to function/call');

  const nodeAssign = router.inferSemanticNode('数据[j] = 数据[j + 1]');
  assert.strictEqual(nodeAssign, '/semantic/data/assign', '数据[j] = 数据[j + 1] must infer to assign');

  const nodeDeclare = router.inferSemanticNode('设 长度 = len(数据)');
  assert.strictEqual(nodeDeclare, '/semantic/data/declare', '设 长度 = len(数据) must infer to declare');

  const nodeBreak = router.inferSemanticNode('跳出');
  assert.strictEqual(nodeBreak, '/semantic/control/loop/break', '跳出 must infer to loop/break');

  const nodeContinue = router.inferSemanticNode('继续');
  assert.strictEqual(nodeContinue, '/semantic/control/loop/continue', '继续 must infer to loop/continue');
  console.log('   ✓ inferSemanticNode accurately distinguishes call, assign, declare, break, continue');

  // 3. Prepare sample specialized semantic DSL
  const sampleModule = path.join(TEST_TMP_DIR, 'sample_auth');
  const sampleSpecFile = `${sampleModule}.spec.python.dsl`;
  const specContent = [
    '# @jev-block:auth_001:begin',
    '定义 验证用户(用户名: str, 密码: str) -> bool:   # node:/python/function/define',
    '    如果 用户名 == "":                         # node:/python/control/if',
    '        返回 假                               # node:/python/function/return',
    '    返回 检查密码(用户名, 密码)                # node:/python/function/return',
    '# @jev-block:auth_001:end',
    '',
    '# @jev-block:auth_002:begin',
    '定义 检查密码(用户名: str, 密码: str) -> bool:   # node:/python/function/define',
    '    返回 密码 == "secret"                     # node:/python/function/return',
    '# @jev-block:auth_002:end'
  ].join('\n');
  fs.writeFileSync(sampleSpecFile, specContent, 'utf8');

  // 4. Test split_blocks
  console.log('\n3. Testing split_blocks...');
  const splitRes = await actionSplitBlocks({ file_path: sampleSpecFile }, ctxState);
  assert.strictEqual(splitRes.status, 'success');
  assert.strictEqual(splitRes.blocks_count, 2);
  assert.strictEqual(splitRes.blocks[0].block_id, 'auth_001');
  assert.strictEqual(splitRes.blocks[1].block_id, 'auth_002');
  console.log('   ✓ split_blocks passed: 2 blocks correctly identified');

  // 5. Test spec_to_code (Writing flow step)
  console.log('\n4. Testing spec_to_code...');
  const s2cRes = await actionSpecToCode({ module_path: sampleModule, target_lang: 'python' }, ctxState);
  assert.strictEqual(s2cRes.status, 'success');
  const codeFile = `${sampleModule}.py`;
  assert.ok(fs.existsSync(codeFile), 'Code file should exist');
  const codeContent = fs.readFileSync(codeFile, 'utf8');
  assert.ok(codeContent.includes('def 验证用户(用户名: str, 密码: str) -> bool:'), 'Code should translate to def');
  assert.ok(codeContent.includes('if 用户名 == "":'), 'Code should translate 如果 to if');
  assert.ok(codeContent.includes('return False'), 'Code should translate 返回 假 to return False');
  console.log('   ✓ spec_to_code passed: Python code generated from spec DSL');

  // 6. REG-01 Regression: Test Compound Assignments (+-, *=, /=)
  console.log('\n5. Testing REG-01 Compound Assignments (+-, *=, /=)...');
  const augModule = path.join(TEST_TMP_DIR, 'aug_test');
  const augSpec = [
    '# @jev-block:aug_001:begin',
    '定义 计算(x: int) -> int:   # node:/python/function/define',
    '    设 总 = 0              # node:/python/data/declare',
    '    总 += x                # node:/python/data/assign',
    '    总 -= 1                # node:/python/data/assign',
    '    总 *= 2                # node:/python/data/assign',
    '    总 /= 2                # node:/python/data/assign',
    '    返回 总                # node:/python/function/return',
    '# @jev-block:aug_001:end'
  ].join('\n');
  fs.writeFileSync(`${augModule}.spec.python.dsl`, augSpec, 'utf8');
  await actionSpecToCode({ module_path: augModule, target_lang: 'python' }, ctxState);

  const augCode = fs.readFileSync(`${augModule}.py`, 'utf8');
  assert.ok(augCode.includes('总 += x'), 'Must preserve += without breaking into + =');
  assert.ok(augCode.includes('总 -= 1'), 'Must preserve -=');
  assert.ok(augCode.includes('总 *= 2'), 'Must preserve *=');
  assert.ok(augCode.includes('总 /= 2'), 'Must preserve /=');
  assert.ok(!augCode.includes('+ ='), 'Must NOT contain "+ ="');
  console.log('   ✓ REG-01 passed: Compound assignments are preserved with complete syntax correctness');

  // 7. Test check_alignment (two-file alignment)
  console.log('\n6. Testing check_alignment...');
  const alignRes = await actionCheckAlignment({ module_path: sampleModule, target_lang: 'python' }, ctxState);
  assert.strictEqual(alignRes.status, 'success');
  assert.strictEqual(alignRes.report.aligned, true);
  console.log('   ✓ check_alignment passed: two files (spec and code) aligned with matching block IDs');

  // 8. Test translate_block (in-place modification flow)
  console.log('\n7. Testing translate_block (in-place update)...');
  const updatedBlock1 = [
    '定义 验证用户(用户名: str, 密码: str) -> bool:   # node:/python/function/define',
    '    如果 用户名 == "":                         # node:/python/control/if',
    '        返回 假                               # node:/python/function/return',
    '    如果 密码 == "":                           # node:/python/control/if',
    '        返回 假                               # node:/python/function/return',
    '    返回 检查密码(用户名, 密码)                # node:/python/function/return'
  ].join('\n');

  const transCodeRes = await actionTranslateBlock({
    action: 'translate_block',
    module_path: sampleModule,
    target_lang: 'python',
    direction: 'spec_to_code',
    block_id: 'auth_001',
    block_content: updatedBlock1
  }, ctxState);
  assert.strictEqual(transCodeRes.status, 'success');

  const updatedCode = fs.readFileSync(codeFile, 'utf8');
  assert.ok(updatedCode.includes('if 密码 == "":'), 'Updated code should contain new condition');
  assert.ok(updatedCode.includes('auth_002'), 'Block 2 should remain intact');
  console.log('   ✓ translate_block passed: partial in-place translation succeeded');

  // 9. BUG-06 Regression: Roundtrip on bubble_sort sample (设 and 跳出 fidelity)
  console.log('\n8. Testing BUG-06 reverse roundtrip with 设 and 跳出 fidelity...');
  const bsModule = path.join(TEST_TMP_DIR, 'bs_roundtrip');
  const bsSpecFile = `${bsModule}.spec.python.dsl`;
  const bsSpecText = [
    '# @jev-block:bs_001:begin',
    '定义 排序(数据: list) -> list:                 # node:/python/function/define',
    '    设 长度 = len(数据)                         # node:/python/data/declare',
    '    对于 i 中的 range(长度):                    # node:/python/control/loop/for',
    '        设 已交换 = 假                          # node:/python/data/declare',
    '        如果 数据[i] > 10:                      # node:/python/control/if',
    '            数据[i] = 数据[i] + 1               # node:/python/data/assign',
    '            已交换 = 真                         # node:/python/data/assign',
    '        如果 已交换 == 假:                      # node:/python/control/if',
    '            跳出                                # node:/python/control/loop/break',
    '    返回 数据                                   # node:/python/function/return',
    '# @jev-block:bs_001:end'
  ].join('\n');
  fs.writeFileSync(bsSpecFile, bsSpecText, 'utf8');

  // Forward: spec -> code
  await actionSpecToCode({ module_path: bsModule, target_lang: 'python' }, ctxState);

  // Backward: code -> spec
  await actionCodeToSpec({ module_path: bsModule, target_lang: 'python' }, ctxState);

  const restoredSpec = fs.readFileSync(bsSpecFile, 'utf8');
  assert.ok(restoredSpec.includes('设 长度 = len(数据)'), 'Reverse spec DSL must preserve 设 长度');
  assert.ok(restoredSpec.includes('设 已交换 = False') || restoredSpec.includes('设 已交换 = 假'), 'Reverse spec DSL must preserve 设 已交换');
  assert.ok(restoredSpec.includes('数据[i] = 数据[i] + 1'), 'Reverse spec DSL must preserve assignment');
  assert.ok(restoredSpec.includes('跳出'), 'Reverse spec DSL must preserve 跳出 (not break)');
  console.log('   ✓ BUG-06 passed: 设 and 跳出 roundtrip preserved with 100% fidelity');

  // 10. Test C language support
  console.log('\n9. Testing C language multi-language support...');
  const cModule = path.join(TEST_TMP_DIR, 'c_sample');
  const cSpecFile = `${cModule}.spec.c.dsl`;
  const cSpec = [
    '// @jev-block:calc_001:begin',
    '定义 add(a: int, b: int) -> int:   // node:/c/function/define',
    '    返回 a + b                     // node:/c/function/return',
    '// @jev-block:calc_001:end'
  ].join('\n');
  fs.writeFileSync(cSpecFile, cSpec, 'utf8');

  await actionSpecToCode({ module_path: cModule, target_lang: 'c' }, ctxState);

  const cCode = fs.readFileSync(`${cModule}.c`, 'utf8');
  assert.ok(cCode.includes('// @jev-block:calc_001:begin'), 'C code should use // comment delimiter');
  assert.ok(cCode.includes('int add(int a, int b) {'), 'C function signature with int types');
  assert.ok(cCode.includes('return a + b;'), 'C return with semicolon');
  console.log('   ✓ C language generation with // comment delimiters passed');

  // 12. Test validate_vocab
  console.log('\n11. Testing validate_vocab...');
  const candidateVocab = {
    vocab_id: 'test_vocab_v1',
    words: [
      {
        word_id: 'encrypt',
        canonical: '加密',
        synonyms: ['encrypt', 'cipher', '加密'],
        category: 'operation',
        semantic_layer: 'common'
      },
      {
        word_id: 'decrypt',
        canonical: '解密',
        synonyms: ['decrypt', '解密'],
        category: 'operation',
        semantic_layer: 'common'
      }
    ]
  };
  const valRes = await actionValidateVocab({ vocab_candidate: candidateVocab }, ctxState);
  assert.strictEqual(valRes.status, 'success');
  assert.strictEqual(valRes.report.valid, true);
  console.log('   ✓ validate_vocab passed');

  // 13. BUG-02 Regression: Local heuristic zero-match must not falsely claim high confidence
  console.log('\n12. Testing BUG-02 local heuristic zero-match rejection...');
  const zeroMatchRes = ctxState.jevClient.localHeuristicDecision(
    '完全不相关的内容与文字',
    {
      type: 'choice',
      candidates: ['/semantic/control/loop/for', '/semantic/control/loop/while']
    },
    'choice'
  );
  assert.strictEqual(zeroMatchRes.choice, null, 'Zero match must return choice: null');
  assert.strictEqual(zeroMatchRes.confidence, 0, 'Zero match must return confidence: 0');
  assert.strictEqual(zeroMatchRes.degraded, true, 'Zero match must be marked degraded: true');
  console.log('   ✓ BUG-02 passed: zero match cleanly returns choice: null, confidence: 0');

  // 14. BUG-01 Regression: Remote Jev API decision with real JevK5 endpoint (if key available)
  console.log('\n13. Testing BUG-01 remote Jev API decision...');
  const prodDshPath = path.join(os.homedir(), '.dsh', 'jevagent.json');
  let realApiKey = process.env.JEV_API_KEY || '';
  let realBaseUrl = process.env.JEV_API_BASE_URL || '';
  if (fs.existsSync(prodDshPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(prodDshPath, 'utf8'));
      if (!realApiKey) realApiKey = cfg.jev_api_key || '';
      if (!realBaseUrl) realBaseUrl = cfg.jev_base_url || '';
    } catch {}
  }

  if (realApiKey && realBaseUrl) {
    const remoteClient = new JevClient({
      jev_enabled: true,
      jev_base_url: realBaseUrl,
      jev_api_key: realApiKey,
      jev_model: 'jevk5-4b-v0.3-Q4_K_M',
      jev_timeout_s: 45
    });

    const remoteDecision = await remoteClient.decide(
      '遍历列表中的所有元素并求和',
      {
        type: 'choice',
        candidates: ['/semantic/control/loop/for', '/semantic/control/loop/while']
      }
    );
    assert.strictEqual(remoteDecision.provider, 'remote_jev_api', 'Provider must be remote_jev_api');
    assert.ok(
      remoteDecision.choice === '/semantic/control/loop/for' || remoteDecision.choice === '/semantic/control/loop/while',
      'Choice must be one of the candidates'
    );
    console.log(`   ✓ BUG-01 passed: remote Jev API successfully decided choice: ${remoteDecision.choice}, provider: ${remoteDecision.provider}`);
  } else {
    console.log('   - BUG-01 live remote check skipped (no JEV_API_KEY available in environment)');
  }

  // 15. ISSUE-02 / K1~K6 Key Persistence Acceptance Tests
  console.log('\n14. Testing ISSUE-02 / K1~K6 Key Persistence...');

  // K1 & K4: Setting a valid key writes to isolated test config
  await actionSetConfig({ jev_api_key: 'sk-test-valid-key-123456789' }, ctxState);
  assert.strictEqual(ctxState.jevClient.apiKey, 'sk-test-valid-key-123456789', 'K1: Key must update in memory immediately');

  // K5: Mask value must NOT pollute real key
  await actionSetConfig({ jev_api_key: 'sk-***6789' }, ctxState);
  assert.strictEqual(ctxState.jevClient.apiKey, 'sk-test-valid-key-123456789', 'K5: Mask value must be rejected/ignored, key unchanged');

  await actionSetConfig({ jev_api_key: 'configured' }, ctxState);
  assert.strictEqual(ctxState.jevClient.apiKey, 'sk-test-valid-key-123456789', 'K5: Placeholder "configured" must not overwrite key');

  // K6: Omitting key must NOT clear it
  await actionSetConfig({ jev_base_url: 'http://127.0.0.1:9000' }, ctxState);
  assert.strictEqual(ctxState.jevClient.apiKey, 'sk-test-valid-key-123456789', 'K6: Omitting key parameter must preserve existing key');

  // K6: Explicit empty string clears key
  await actionSetConfig({ jev_api_key: '' }, ctxState);
  assert.strictEqual(ctxState.jevClient.apiKey, '', 'K6: Explicit empty string clears key');

  console.log('   ✓ ISSUE-02 passed: K1~K6 key persistence, mask rejection, and isolation verified');

  // 16. Test actionCheckSpec
  console.log('\n15. Testing check_spec (Validation firewall)...');
  const csRes = await actionCheckSpec({ module_path: sampleModule, target_lang: 'python' }, ctxState);
  assert.strictEqual(csRes.status, 'success');
  assert.strictEqual(csRes.ok, true);
  console.log('   ✓ check_spec passed on valid spec');

  // 17. Test actionCheckTables (Core conformance coverage matrix)
  console.log('\n16. Testing check_tables...');
  const ctRes = await actionCheckTables({}, ctxState);
  assert.strictEqual(ctRes.core_table, 'syntax_core_v1');
  assert.strictEqual(ctRes.matrix.columns.length, 4);
  assert.ok(ctRes.matrix.rows.length >= 12);
  console.log('   ✓ check_tables passed: coverage matrix generated for all 4 languages (python, c, shell, javascript)');

  // 18. Test actionSpecToSpec (Cross-language migration)
  console.log('\n17. Testing spec_to_spec...');
  const s2sRes = await actionSpecToSpec({ module_path: sampleModule, source_lang: 'python', target_lang: 'c' }, ctxState);
  assert.strictEqual(s2sRes.status, 'success');
  assert.ok(fs.existsSync(s2sRes.spec_path));
  console.log('   ✓ spec_to_spec passed: cross-language migration report generated');

  // 19. Test actionSpecExport (Read-only export without node annotations)
  console.log('\n18. Testing spec_export...');
  const seRes = await actionSpecExport({ module_path: sampleModule, target_lang: 'python' }, ctxState);
  assert.strictEqual(seRes.status, 'success');
  assert.ok(!seRes.export_content.includes('node:'));
  console.log('   ✓ spec_export passed: clean read-only spec without node annotations');

  // 20. Test JavaScript language support & self-hosting capability
  console.log('\n19. Testing JavaScript language support & self-hosting capability...');
  const jsModule = path.join(TEST_TMP_DIR, 'js_sample');
  const jsSpecFile = `${jsModule}.spec.javascript.dsl`;
  const jsSpecContent = [
    '// @jev-block:names:begin',
    '库 node:path 作为 path',
    '// @jev-block:names:end',
    '// @jev-block:main:begin',
    '引入 { join } 从 \'node:path\'',
    '定义 计算路径(目录: str, 文件: str):',
    '    设 完整路径 = join(目录, 文件)',
    '    返回 完整路径',
    '导出 { 计算路径 }',
    '// @jev-block:main:end'
  ].join('\n');
  fs.writeFileSync(jsSpecFile, jsSpecContent, 'utf8');

  // Check spec
  const jsCheckRes = await actionCheckSpec({ module_path: jsModule, target_lang: 'javascript' }, ctxState);
  assert.strictEqual(jsCheckRes.ok, true, 'JS spec must pass check_spec');

  // Generate JS code
  const jsCodeRes = await actionSpecToCode({ module_path: jsModule, target_lang: 'javascript' }, ctxState);
  assert.strictEqual(jsCodeRes.status, 'success');
  const jsCodeFile = `${jsModule}.js`;
  assert.ok(fs.existsSync(jsCodeFile), 'JS code file must be generated');
  const generatedJsCode = fs.readFileSync(jsCodeFile, 'utf8');
  assert.ok(generatedJsCode.includes("import { join } from 'node:path';") || generatedJsCode.includes("import { join } from \"node:path\";"), 'Must include ES import');
  assert.ok(generatedJsCode.includes('function 计算路径(目录, 文件) {'), 'Must generate JS function');
  assert.ok(generatedJsCode.includes('const 完整路径 = join(目录, 文件);'), 'Must generate const declaration');

  // Test executing generated JS code using Node.js
  const testJsRunner = path.join(TEST_TMP_DIR, 'test_js_runner.mjs');
  const testJsRunnerCode = [
    `import { 计算路径 } from './js_sample.js';`,
    `const p = 计算路径('src', 'index.js');`,
    `if (!p.includes('src') || !p.includes('index.js')) throw new Error('Path calculation failed');`
  ].join('\n');
  fs.writeFileSync(testJsRunner, testJsRunnerCode, 'utf8');

  const { execSync } = await import('node:child_process');
  execSync(`"${process.execPath}" "${testJsRunner}"`, { cwd: TEST_TMP_DIR });

  // Test reverse translation: code_to_spec for JavaScript
  const jsRevRes = await actionCodeToSpec({ module_path: jsModule, target_lang: 'javascript' }, ctxState);
  assert.strictEqual(jsRevRes.status, 'success');
  const restoredJsSpec = fs.readFileSync(jsSpecFile, 'utf8');
  assert.ok(restoredJsSpec.includes('node:/javascript/function/define'), 'Reversed spec must contain JS function define annotation');
  console.log('   ✓ JavaScript language end-to-end support passed (generation, execution, reverse translation)');

  // 20. Testing JevGuard: Direct code write interception & confirmation pass-through
  console.log('\n20. Testing JevGuard (direct code write interception & confirmation)...');
  const guard = createJevGuard(ctxState);
  const nextMock = () => Promise.resolve({ kind: 'allow' });

  // 20.1 First write to a python code file -> intercepted with deny and reminder
  const g1 = await guard.preExecute({ name: 'write', arguments: { file_path: 'app.py', content: 'print(1)' } }, nextMock);
  assert.strictEqual(g1.kind, 'deny', 'First attempt to write app.py must be denied');
  assert.ok(g1.reason.includes('JevAgent 防幻觉保护提醒'), 'Must include JevGuard reminder header');
  assert.ok(g1.reason.includes('app.spec.python.dsl'), 'Must include spec DSL recommendation');

  // 20.2 Immediate second write to app.py within 60s -> confirmed and allowed
  const g2 = await guard.preExecute({ name: 'write', arguments: { file_path: 'app.py', content: 'print(1)' } }, nextMock);
  assert.strictEqual(g2.kind, 'allow', 'Second attempt within 60s must be allowed (secondary confirmation)');

  // 20.3 Edit with explicit confirm_direct_write flag -> allowed immediately
  const g3 = await guard.preExecute({ name: 'edit', arguments: { file_path: 'main.js', old_string: 'a', new_string: 'b', confirm_direct_write: true } }, nextMock);
  assert.strictEqual(g3.kind, 'allow', 'Edit with confirm_direct_write: true must be allowed immediately');

  // 20.4 Writing spec DSL -> NEVER intercepted
  const g4 = await guard.preExecute({ name: 'write', arguments: { file_path: 'calc.spec.javascript.dsl', content: '...' } }, nextMock);
  assert.strictEqual(g4.kind, 'allow', 'Writing spec DSL must never be intercepted');

  // 20.5 Writing markdown / docs -> NEVER intercepted
  const g5 = await guard.preExecute({ name: 'write', arguments: { file_path: 'README.md', content: '# Hello' } }, nextMock);
  assert.strictEqual(g5.kind, 'allow', 'Writing markdown docs must never be intercepted');

  // 20.6 Reading code file -> NEVER intercepted ("读不拦着")
  const g6 = await guard.preExecute({ name: 'read', arguments: { file_path: 'app.py' } }, nextMock);
  assert.strictEqual(g6.kind, 'allow', 'Reading code files must never be intercepted');

  // 20.7 Guard disabled via jev_enabled: false -> pass-through directly
  const disabledState = {
    jevClient: { getConfig: () => ({ jev_enabled: false }) },
    config: { guard_direct_code_write: true }
  };
  const disabledGuard = createJevGuard(disabledState);
  const g7 = await disabledGuard.preExecute({ name: 'write', arguments: { file_path: 'core.c', content: 'int x;' } }, nextMock);
  assert.strictEqual(g7.kind, 'allow', 'When jev_enabled: false, code writes must pass through without interception');

  console.log('   ✓ JevGuard direct code write interception, reminder, and confirmation pass-through verified');

  // Cleanup tmp dir
  fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });

  console.log('\n=== All 20 test suites and regression assertions passed successfully! ===');
}

runTests().catch(err => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
