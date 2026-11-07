import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { carregarConfig } from '../src/config.js';

it('entrypoint de emissão encerra sem conexão com as flags desligadas', async()=>{
  const config=carregarConfig({});
  expect(config.emissaoWhatsAppProdutor).toBeUndefined();
  expect(config.emissaoWhatsAppWorker).toBeUndefined();
  expect(config.atendimentoTesteWhatsApp).toBeUndefined();
  const { stdout, stderr } = await promisify(execFile)(process.execPath,[
    '--import','tsx','src/worker/emissao-whatsapp-homologacao-start.ts'
  ],{env:{PATH:process.env.PATH,DOTENV_CONFIG_PATH:'/dev/null',DATABASE_URL:'postgres://invalid:1/never'},timeout:3000});
  expect(stdout).toBe('');
  expect(stderr).toBe('');
});
