import {describe,expect,it,vi} from 'vitest';
import type {Page} from 'playwright-core';
import {filtrarOpcoesNavegacao,navegarComAgente} from '../src/desenvolvedor/navegador-inteligente.js';

describe('subagente navegador: decisões de IA sem permissões de escrita',()=>{
  it('só entrega menus seguros e autenticados ao planejador',()=>{
    const opcoes=filtrarOpcoesNavegacao('tribemd',[
      {tipo:'link',nome:'Agenda',destino:'https://app.tribemd.com/atendimentos/agenda'},
      {tipo:'link',nome:'Agenda',destino:'https://site-invasor.test/agenda'},
      {tipo:'controle',nome:'Salvar médico'},
      {tipo:'controle',nome:'Excluir profissional'},
      {tipo:'link',nome:'Agenda',destino:'https://app.tribemd.com/atendimentos/agenda?codigo=secreto'},
      {tipo:'controle',nome:'Profissionais'},
      {tipo:'controle',nome:'Enviar agenda'}
    ]);
    expect(opcoes).toEqual([
      {indice:0,tipo:'link',nome:'Agenda',destino:'https://app.tribemd.com/atendimentos/agenda'},
      {indice:1,tipo:'controle',nome:'Profissionais'}
    ]);
  });
  it('modelo escolhe índice do menu; navegador visita exclusivamente caminho autorizado',async()=>{
    const page={url:()=> 'https://app.tribemd.com/dashboard',
      evaluate:vi.fn().mockResolvedValue([
        {tipo:'link',nome:'Agenda',destino:'https://app.tribemd.com/atendimentos/agenda'},
        {tipo:'link',nome:'Excluir paciente',destino:'https://app.tribemd.com/pacientes'}
      ]),
      goto:vi.fn().mockResolvedValue({})};
    const planejar=vi.fn().mockResolvedValue({acao:'selecionar',indice:0});
    expect(await navegarComAgente(page as unknown as Page,'tribemd','abrir_agenda',planejar,1)).toBe('navegou');
    expect(page.goto).toHaveBeenCalledExactlyOnceWith('https://app.tribemd.com/atendimentos/agenda',
      {waitUntil:'domcontentloaded',timeout:12_000});
    expect(planejar.mock.calls[0]![0].opcoes).toHaveLength(1);
  });
  it('modelo não pode inventar índice e jamais tenta navegar no domínio errado',async()=>{
    const page={url:()=> 'https://portal.desconhecido.test',
      evaluate:vi.fn(),goto:vi.fn()};
    const planejar=vi.fn();
    expect(await navegarComAgente(page as unknown as Page,'amplimed','localizar_profissionais',planejar)).toBe('sem_acao');
    expect(planejar).not.toHaveBeenCalled();
    const seguro={url:()=> 'https://app.amplimed.com.br/agenda',
      evaluate:vi.fn().mockResolvedValue([{tipo:'link',nome:'Agenda',destino:'https://app.amplimed.com.br/agenda'}]),
      goto:vi.fn()};
    expect(await navegarComAgente(seguro as unknown as Page,'amplimed','abrir_agenda',
      vi.fn().mockResolvedValue({acao:'selecionar',indice:999}),1)).toBe('sem_acao');
    expect(seguro.goto).not.toHaveBeenCalled();
  });
  it('nunca ignora limite de passos nem tenta clicar sem identidade única',async()=>{
    const page={url:()=> 'https://app.amplimed.com.br/agenda',
      evaluate:vi.fn().mockResolvedValue([{tipo:'controle',nome:'Profissionais'}]),
      getByRole:vi.fn().mockReturnValue({count:vi.fn().mockResolvedValue(2),click:vi.fn()})};
    const planejar=vi.fn().mockResolvedValue({acao:'selecionar',indice:0});
    expect(await navegarComAgente(page as unknown as Page,'amplimed','localizar_profissionais',planejar,1)).toBe('sem_acao');
    expect(page.getByRole().click).not.toHaveBeenCalled();
    expect(await navegarComAgente(page as unknown as Page,'amplimed','localizar_profissionais',planejar,99)).toBe('sem_acao');
  });
});
