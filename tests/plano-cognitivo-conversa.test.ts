import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { completarOpenAi } from '../src/io/nvidia/chat-client.js';
import { ConversadorMedico, type FatosConversa } from '../src/onboarding/conversador-medico.js';
import { PostgresMemoriaConversaMedico, type PlanoConversa } from '../src/onboarding/memoria-conversa.js';
import { BancoConversaFalso } from './fakes/banco-conversa.js';

const plano: PlanoConversa = {
  objetivo: 'emitir notas pendentes da semana passada',
  etapa: 'confirmar lote',
  faltando: [],
  proximosPassos: ['confirmar lote', 'emitir', 'informar conclusão'],
  aguardando: 'confirmação do médico'
};

it('persiste plano cognitivo sem misturar estado interno com falas', async () => {
  const banco = new BancoConversaFalso();
  const memoria = new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool);
  await memoria.registrarFala('m', 'c', 'medico:1', 'Pode emitir depois que eu confirmar.');
  await memoria.registrarPlano('m', 'c', plano);

  const contexto = await memoria.lerContextoParaModelo('m', 'c');
  expect(contexto.plano).toEqual(plano);
  expect(contexto.historicoRecente).toEqual(['Pode emitir depois que eu confirmar.']);
  expect(banco.mensagens.find(m => m.mensagemId === 'contexto:plano_cognitivo')?.papel).toBe('noto');

  await memoria.registrarPlano('m', 'c', { ...plano, objetivo: 'emitir para CPF 529.982.247-25' });
  expect((await memoria.lerContextoParaModelo('m', 'c')).plano?.objetivo).toBe('emitir para CPF [OCULTO]');
});

it('decisor recebe o plano anterior e pode devolver estado operacional atualizado', async () => {
  const completar = vi.fn<typeof completarOpenAi>(async () => JSON.stringify({
    fala: ['Vou montar o total para você confirmar.'],
    acao: 'iniciar_lote',
    parametros: { desde: '2026-10-12' },
    plano: {
      objetivo: 'emitir notas pendentes da semana passada',
      etapa: 'montar resumo do lote',
      faltando: [],
      proximosPassos: ['calcular total', 'pedir confirmação', 'emitir'],
      aguardando: 'resultado da ferramenta'
    }
  }));
  const fatos: FatosConversa = {
    ambiente: 'homologacao',
    agenda: { nome: 'tribemd', conectada: true },
    link: { ativo: false, enviados: 1 },
    periodo: { desde: '2026-10-12', origem: 'resposta_atual' },
    semAgendaDigital: false
  };

  const resposta = await new ConversadorMedico('k', 'm', completar).responder({
    texto: 'Pode emitir as da semana passada',
    mensagens: [],
    resumo: null,
    plano,
    fatos,
    agora: new Date('2026-10-21T15:00:00Z'),
    acoesPermitidas: ['iniciar_lote']
  });

  expect(resposta.plano?.etapa).toBe('montar resumo do lote');
  const entradaModelo = JSON.parse(String(completar.mock.calls[0]![2][1]!.content));
  expect(entradaModelo.plano).toEqual(plano);
});
