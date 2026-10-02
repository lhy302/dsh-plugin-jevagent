// verify-presets.mjs — Verify jevagent tool isolation and scoped desktop patch
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRESETS_DIR = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/config/agent-presets';
const DESKTOP_PATCH = path.join(os.homedir(), '.dsh/profiles/desktop/cordis.patch.yml');
const WEB_PATCH = path.join(os.homedir(), '.dsh-web/profiles/web/cordis.patch.yml');

async function verifyPresets() {
  console.log('=== Verifying jevagent isolation and profile declarations ===\n');

  // 1. Strict Isolation Check: Global presets MUST NOT contain tool-jevagent
  console.log('1. Verifying global agent presets cleanliness (Zero Global Pollution)...');
  const modes = [
    { id: 'standard', name: '标准模式', file: path.join(PRESETS_DIR, 'standard/agent.cordis.yml') },
    { id: 'code', name: 'PTC模式 (Code Mode)', file: path.join(PRESETS_DIR, 'code/agent.cordis.yml') },
    { id: 'cordis', name: '创造模式', file: path.join(PRESETS_DIR, 'cordis/agent.cordis.yml') }
  ];

  for (const mode of modes) {
    if (fs.existsSync(mode.file)) {
      const raw = fs.readFileSync(mode.file, 'utf8');
      assert.ok(!raw.includes('tool-jevagent'), `Global preset ${mode.name} MUST NOT contain tool-jevagent`);
      assert.ok(!raw.includes('dsh-plugin-jevagent'), `Global preset ${mode.name} MUST NOT contain dsh-plugin-jevagent`);
      console.log(`  ✓ ${mode.name} (${mode.id}/agent.cordis.yml) is clean`);
    }
  }

  // 2. Web Profile Isolation: Web profile MUST NOT contain jevagent
  console.log('\n2. Verifying Web profile isolation (.dsh-web)...');
  if (fs.existsSync(WEB_PATCH)) {
    const webRaw = fs.readFileSync(WEB_PATCH, 'utf8');
    assert.ok(!webRaw.includes('tool-jevagent'), 'Web cordis.patch.yml MUST NOT contain tool-jevagent');
    console.log('  ✓ Web profile is completely isolated');
  }

  // 3. Desktop Profile Scoped Registration
  console.log('\n3. Verifying Desktop profile scoped registration (.dsh)...');
  if (fs.existsSync(DESKTOP_PATCH)) {
    const desktopRaw = fs.readFileSync(DESKTOP_PATCH, 'utf8');
    assert.ok(desktopRaw.includes('tool-jevagent'), 'Desktop cordis.patch.yml must declare tool-jevagent');
    console.log('  ✓ Desktop profile correctly declares tool-jevagent');
  }

  // 4. Verify tool schema
  console.log('\n4. Verifying tool schema registration...');
  const plugin = await import('../lib/index.js');
  let toolDef;
  const mockCtx = {
    tools: {
      register: (t) => { toolDef = t; }
    },
    inject: () => {},
    on: () => {}
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
    'set_config',
    'auto_mark'
  ];

  const actualActions = params.action.enum;
  for (const act of expectedActions) {
    assert.ok(actualActions.includes(act), `Action enum must include ${act}`);
  }
  console.log(`  ✓ Tool schema has all expected actions (${actualActions.length} actions registered)`);

  console.log('\n=== All preset isolation and tool declarations verified successfully! ===');
}

verifyPresets().catch(err => {
  console.error('\n❌ Preset verification failed:', err);
  process.exit(1);
});
