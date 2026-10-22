import { describe, expect, it } from 'vitest';
import { classificarTelaAmplimed, permitirRequisicaoAmplimed } from '../src/desenvolvedor/amplimed-navegador.js';

describe('guarda de rede do Amplimed', () => {
  it('POST só uma vez, no domínio aprovado, com envio liberado', () => {
    expect(permitirRequisicaoAmplimed('https://app.amplimed.com.br/login', 'POST', 'fetch', true)).toBe(true);
    expect(permitirRequisicaoAmplimed('https://app.amplimed.com.br/login', 'POST', 'fetch', false)).toBe(false);
    expect(permitirRequisicaoAmplimed('https://outro.com/x', 'POST', 'fetch', true)).toBe(false);
    expect(permitirRequisicaoAmplimed('https://app.amplimed.com.br/agenda/salvar', 'POST', 'fetch', true)).toBe(false);
  });
  it('bloqueia PUT/DELETE, http, websocket e navegação para ação', () => {
    expect(permitirRequisicaoAmplimed('https://app.amplimed.com.br/a', 'PUT', 'fetch', true)).toBe(false);
    expect(permitirRequisicaoAmplimed('https://app.amplimed.com.br/a', 'DELETE', 'fetch', true)).toBe(false);
    expect(permitirRequisicaoAmplimed('http://app.amplimed.com.br/a', 'GET', 'document', false)).toBe(true);
    expect(permitirRequisicaoAmplimed('http://app.amplimed.com.br/a', 'POST', 'fetch', true)).toBe(false);
    expect(permitirRequisicaoAmplimed('http://evil.com/a', 'GET', 'document', false)).toBe(false);
    expect(permitirRequisicaoAmplimed('https://app.amplimed.com.br/a', 'GET', 'websocket', false)).toBe(false);
    expect(permitirRequisicaoAmplimed('https://app.amplimed.com.br/logout', 'GET', 'document', false)).toBe(false);
    expect(permitirRequisicaoAmplimed('https://app.amplimed.com.br/agenda', 'GET', 'document', false)).toBe(true);
  });
});
describe('estado da tela de login do Amplimed', () => {
  const t = (url: string, texto: string, senhasVisiveis = 0) => ({ url, texto, senhasVisiveis });
  it('reconhece conectado, verificação, captcha e senha recusada', () => {
    expect(classificarTelaAmplimed(t('https://app.amplimed.com.br/agenda', 'Agenda'))).toBe('CONECTADO');
    expect(classificarTelaAmplimed(t('https://app.amplimed.com.br/login', 'Digite o código de verificação enviado por SMS', 0))).toBe('PRECISA_VERIFICACAO');
    expect(classificarTelaAmplimed(t('https://auth.amplimed.com.br/2fa/verification/abc', 'Verificação', 1))).toBe('PRECISA_VERIFICACAO');
    expect(classificarTelaAmplimed(t('https://auth.amplimed.com.br/2fa/verification/abc', 'Proteja sua conta com 2FA. Clique em Ativar agora', 0))).toBe('AGUARDANDO');
    expect(classificarTelaAmplimed(t('https://auth.amplimed.com.br/2fa/verification/abc', 'Digite o código enviado', 0))).toBe('PRECISA_VERIFICACAO');
    expect(classificarTelaAmplimed(t('https://app.amplimed.com.br/login', 'Não sou um robô reCAPTCHA', 1))).toBe('CAPTCHA');
    expect(classificarTelaAmplimed(t('https://app.amplimed.com.br/login', 'Senha inválida', 1))).toBe('SENHA_RECUSADA');
  });
  it('ainda no formulário sem mensagem = aguardando; nunca conectado com campo de senha', () => {
    expect(classificarTelaAmplimed(t('https://app.amplimed.com.br/login', 'Entrar', 1))).toBe('AGUARDANDO');
    expect(classificarTelaAmplimed(t('https://app.amplimed.com.br/agenda', 'x', 1))).toBe('AGUARDANDO');
  });
});

it('libera só o POST do reCAPTCHA além do login', () => {
  expect(permitirRequisicaoAmplimed('https://www.google.com/recaptcha/api2/reload?k=x', 'POST', 'fetch', false)).toBe(true);
  expect(permitirRequisicaoAmplimed('https://www.google.com/g/collect', 'POST', 'fetch', true)).toBe(false);
});

it('libera só o POST livewire do login, mesmo antes do envio, e nenhum outro caminho', () => {
  expect(permitirRequisicaoAmplimed('https://auth.amplimed.com.br/livewire/update', 'POST', 'fetch', false)).toBe(true);
  expect(permitirRequisicaoAmplimed('https://app.amplimed.com.br/livewire/update', 'POST', 'fetch', false)).toBe(false);
  expect(permitirRequisicaoAmplimed('https://auth.amplimed.com.br/outro', 'POST', 'fetch', false)).toBe(false);
});
