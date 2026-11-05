import {describe,it,expect} from 'vitest';
import {classificarEnvioLinkEvolution} from '../src/whatsapp/status-entrega-link.js';

describe('resposta da Evolution para link sensível',()=>{
  it('2xx aceito não significa entregue',()=>{
    expect(classificarEnvioLinkEvolution({sucesso:true})).toBe('enviado');
  });
  for(const erro of ['HTTP 400: inválido','HTTP 401: autenticação','HTTP 403: proibido','HTTP 404: rota']){
    it('rejeição comprovada '+erro.split(':')[0],()=>{
      expect(classificarEnvioLinkEvolution({sucesso:false,erro})).toBe('erro');
    });
  }
  for(const erro of ['HTTP 408: timeout','HTTP 409: conflito','HTTP 425: cedo',
    'HTTP 429: limite','HTTP 500: interno','HTTP 503: indisponível',
    'Erro de conexão com Evolution API','The operation was aborted','ETIMEDOUT']){
    it('resultado incerto '+erro.split(':')[0],()=>{
      expect(classificarEnvioLinkEvolution({sucesso:false,erro})).toBe('incerto');
    });
  }
  it('erro local de canal não é convertido em timeout',()=>{
    expect(classificarEnvioLinkEvolution({
      sucesso:false,erro:'CANAL_OFICIAL_SOMENTE_OTP'
    })).toBe('erro');
  });
});
