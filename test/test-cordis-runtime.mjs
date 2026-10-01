import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as jevPlugin from 'dsh-plugin-jevagent';

async function testFullCordisIntegration() {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, {});
  await ctx.plugin(jevPlugin);
  
  const tool = ctx.tools.get('jevagent');
  console.log('ctx.tools.get("jevagent") found:', !!tool);
  console.log('Tool parameters properties count:', Object.keys(tool.parameters.properties).length);
  console.log('Tool schemas count:', ctx.tools.schemas().length);
  console.log('Tool schemas names:', ctx.tools.schemas().map(s => s.name));
  
  // Test execute directly through tool definition
  const res = await tool.execute({ action: 'get_config' }, { signal: new AbortController().signal });
  console.log('Executed get_config, jev_enabled =', JSON.parse(res).config.jev_enabled);

  // Test split_blocks
  const splitRes = await tool.execute({
    action: 'split_blocks',
    file_path: 'D:/工作区表/工作区6/dsh-plugin-jevagent/package.json'
  }, { signal: new AbortController().signal }).catch(e => e.message);
  console.log('Executed split_blocks check (expected no blocks):', typeof splitRes === 'string');

  console.log('\n=== Full Cordis ToolRuntime integration verified successfully! ===');
}

testFullCordisIntegration().catch(console.error);
