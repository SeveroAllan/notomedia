import { expect, it } from 'vitest';
import { extrairPayloadHistorico } from '../src/whatsapp/payload-historico-webhook-schema.js';

const mensagem = (id: string) => ({
  key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id },
  message: { conversation: 'oi' }
});

it('histórico aceita lote normal nas duas formas suportadas', () => {
  expect(extrairPayloadHistorico({event:'messages.set',instance:'noto',data:[mensagem('1')]} )?.mensagens).toHaveLength(1);
  expect(extrairPayloadHistorico({event:'messages.set',instance:'noto',data:{messages:[mensagem('1')]}})?.mensagens).toHaveLength(1);
});

it('histórico rejeita coleção excessiva antes de validar cada mensagem', () => {
  const excessivo = Array.from({length:1001},(_,i)=>({invalida:i}));
  expect(extrairPayloadHistorico({event:'messages.set',instance:'noto',data:excessivo})).toBeNull();
  expect(extrairPayloadHistorico({event:'messages.set',instance:'noto',data:{messages:excessivo}})).toBeNull();
});
