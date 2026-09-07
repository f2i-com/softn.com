import { expect, it, vi } from 'vitest';
import { TransformersManager } from '../src/runtime/ai-transformers-manager';

for (const processorMode of [false,true]) {
  for (const value of [false,true,undefined,'false']) {
    it(`routes thinking=${String(value)} only to the ${processorMode ? 'processor' : 'tokenizer'} template`, async () => {
      const manager=new TransformersManager();
      const template=vi.fn((_messages: unknown, _options: Record<string, unknown>)=> 'prompt');
      const tokenizer=Object.assign(vi.fn(()=>({input_ids:{dims:[1,2]}})),{apply_chat_template:template,decode:()=> 'reply',batch_decode:()=> ['reply']});
      const processor=processorMode ? Object.assign(vi.fn(async()=>({input_ids:{dims:[1,2]}})),{apply_chat_template:template,batch_decode:()=>['reply'],tokenizer}) : null;
      const generate=vi.fn(async(_options: Record<string, unknown>)=>({slice:()=>[1]}));
      (manager as any).transformers={};
      (manager as any).models.set('fixture',{model:{generate},processor,tokenizer,rebuild:null});
      await manager.generateFromModel('fixture',[{role:'user',content:'Hi'}],{enable_thinking:value,max_new_tokens:64} as any);
      expect(template.mock.calls[0][1]).toEqual(typeof value==='boolean' ? {add_generation_prompt:true,enable_thinking:value} : {add_generation_prompt:true});
      expect(generate.mock.calls[0][0]).not.toHaveProperty('enable_thinking');
      expect(generate.mock.calls[0][0]).toHaveProperty('max_new_tokens',64);
    });
  }
}
