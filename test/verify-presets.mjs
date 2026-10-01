// verify-presets.mjs — Verify jevagent tool in standard, code (PTC), and cordis (Creative) modes
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRESETS_DIR = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/config/agent-presets';

async function verifyPresets() {
  console.log('=== Verifying jevagent in 标准模式 (standard), PTC模式 (code), and 创造模式 (cordis) ===\n');

  const modes = [
    { id: 'standard', name: '标准模式', file: path.join(PRESETS_DIR, 'standard/agent.cordis.yml') },
    { id: 'code', name: 'PTC模式 (Code Mode)', file: path.join(PRESETS_DIR, 'code/agent.cordis.yml') },
    { id: 'cordis', name: '创造模式', file: path.join(PRESETS_DIR, 'cordis/agent.cordis.yml') }
  ];

  for (const mode of modes) {
    console.log(`Checking ${mode.name} [id: ${mode.id}]...`);
    assert.ok(fs.existsSync(mode.file), `Preset file must exist: ${mode.file}`);

    const raw = fs.readFileSync(mode.file, 'utf8');
    assert.ok(raw.includes('- id: tool-jevagent'), `${mode.name} must declare id: tool-jevagent`);
    assert.ok(raw.includes("name: 'dsh-plugin-jevagent'"), `${mode.name} must name dsh-plugin-jevagent`);
    console.log(`  ✓ tool-jevagent is declared in ${mode.id}/agent.cordis.yml`);
  }

  // Verify that the tool schema matches the user prototype
  const plugin = await import('../lib/index.js');
  let toolDef;
  const mockCtx = {
    tools: {
      register: (t) => { toolDef = t; }
    },
    inject: () => {}
  };
  plugin.apply(mockCtx);

  assert.ok(toolDef, 'Plugin must register jevagent tool');
  assert.strictEqual(toolDef.name, 'jevagent');
  const params = toolDef.parameters.properties || toolDef.parameters;
  assert.ok(params.action, 'Must have action parameter');

  const expectedActions = [
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
    'set_config'
  ];

  const actualActions = params.action.enum;
  for (const act of expectedActions) {
    assert.ok(actualActions.includes(act), `Action enum must include ${act}`);
  }
  console.log(`\n✓ Tool schema has all prototype actions: ${actualActions.join(', ')}`);

  console.log('\n=== All preset tool declarations verified successfully! ===');
}

verifyPresets().catch(err => {
  console.error('\n❌ Preset verification failed:', err);
  process.exit(1);
});
