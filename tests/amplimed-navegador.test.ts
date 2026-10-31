import { describe, expect, it } from 'vitest';
import { classificarTelaAmplimed, desafioDoisFatoresAmplimed, eventoAgendaAmplimedDoFeed, filtrarEstadoAmplimed, navegacaoPulouDataAmplimed, permitirRequisicaoAmplimed } from '../src/desenvolvedor/amplimed-navegador.js';
import { montarLeituraAmplimed } from '../src/agenda/amplimed-leitor.js';

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
    expect(classificarTelaAmplimed(t('https://auth.amplimed.com.br/2fa/verification/abc', 'Proteja sua conta com autenticação em 2 fatores! A ativação do 2FA passa a ser obrigatória a partir de hoje. Clique em Ativar agora para configurar.', 0))).toBe('PRECISA_VERIFICACAO');
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

describe('desafio de 2FA depois do enrollment', () => {
  const t = (url: string, texto: string, senhasVisiveis = 0) => ({ url, texto, senhasVisiveis });
  it('reconhece a tela /twofactor como PRECISA_VERIFICACAO, não AGUARDANDO', () => {
    expect(desafioDoisFatoresAmplimed(t('https://auth.amplimed.com.br/twofactor?hash=abc', 'Verificar código de autenticação'))).toBe(true);
    expect(classificarTelaAmplimed(t('https://auth.amplimed.com.br/twofactor?hash=abc', 'Verificar código de autenticação Um código foi enviado para se***@gm***.com via e-mail.'))).toBe('PRECISA_VERIFICACAO');
    expect(desafioDoisFatoresAmplimed(t('https://app.amplimed.com.br/login', 'Verificar código de autenticação'))).toBe(true);
    expect(desafioDoisFatoresAmplimed(t('https://app.amplimed.com.br/agenda', 'Agenda'))).toBe(false);
    expect(desafioDoisFatoresAmplimed(t('https://auth.amplimed.com.br/2fa/verification/abc', 'Proteja sua conta com autenticação em 2 fatores! Clique em Ativar agora'))).toBe(false);
  });
});
describe('filtrarEstadoAmplimed', () => {
  it('mantém só cookies e origens do domínio amplimed.com.br', () => {
    const estado = filtrarEstadoAmplimed({
      cookies: [
        { name: 'a', value: '1', domain: '.amplimed.com.br', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
        { name: 'b', value: '2', domain: 'auth.amplimed.com.br', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
        { name: 'c', value: '3', domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
        { name: 'd', value: '4', domain: 'amplimed.com.br.evil.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
      ],
      origins: [
        { origin: 'https://app.amplimed.com.br', localStorage: [{ name: 'x', value: '1' }] },
        { origin: 'https://outro.com', localStorage: [{ name: 'y', value: '2' }] },
      ],
    });
    expect(estado.cookies.map(c => c.name)).toEqual(['a', 'b']);
    expect(estado.origins.map(o => o.origin)).toEqual(['https://app.amplimed.com.br']);
  });
});


describe('evento de dia oculto vindo do feed mensal',()=>{
  it('preserva paciente, valor e identificação no mesmo contrato da visão Dia',()=>{
    const ev=eventoAgendaAmplimedDoFeed({titulo:'Paciente Domingo | Avaliação | Particular | R$ 321,45 | 51990000009',inicio:'10:00',fim:'10:30',cor:'green'});
    expect(ev).not.toBeNull();
    const leitura=montarLeituraAmplimed([ev!],{data:'2026-10-25',profissional:'Allan Severo (teste Noto)'});
    expect(leitura.confiavel).toBe(true);
    expect(leitura.consultas).toEqual([expect.objectContaining({pacienteNome:'Paciente Domingo',valorCentavos:32145,idExterno:'2026-10-25T10:00|51990000009'})]);
  });
  it('não transforma evento incompleto do feed em dia vazio',()=>{
    expect(eventoAgendaAmplimedDoFeed({titulo:'Paciente X | Avaliação | Particular | R$ 100,00 | 51990000009',inicio:'10:00',fim:null,cor:'green'})).toBeNull();
    expect(eventoAgendaAmplimedDoFeed({titulo:'',inicio:'10:00',fim:'10:30',cor:'green'})).toBeNull();
  });
});


describe('âncora em dia oculto',()=>{
  it('detecta sábado→segunda e segunda→sábado cruzando domingo, sem oscilação',()=>{
    expect(navegacaoPulouDataAmplimed('2026-10-24','2026-10-26','2026-10-25')).toBe(true);
    expect(navegacaoPulouDataAmplimed('2026-10-26','2026-10-24','2026-10-25')).toBe(true);
    expect(navegacaoPulouDataAmplimed('2026-10-24','2026-10-25','2026-10-25')).toBe(false);
  });
});
