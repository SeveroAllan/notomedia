import { describe, expect, it, vi } from 'vitest';
import { carregarConfig } from '../src/config.js';
import { processarComprovante } from '../src/fluxos/processar-comprovante.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import type { ResultadoExtracaoComprovante } from '../src/atendimento/comprovante.js';

const estado = { medicoId: 'medico-ficticio', paciente: { nome: 'Paciente Ficticio', cpf: '52998224725' }, ultimaConsulta: { valorConsultaCentavos: 35000 } };
const mensagem = { key: { id: 'imagem-ficticia', fromMe: false, remoteJid: '5511999990000@s.whatsapp.net' }, message: { imageMessage: { mimetype: 'image/jpeg' } } };
const lido: ResultadoExtracaoComprovante = { tipo: 'extraido', campos: { valorCentavos: 35000, dataPagamento: '2026-10-18',
  nomePagador: 'Paciente Ficticio', nomeFavorecido: 'Medica Ficticia',
  confianca: { valorCentavos: 0.9, dataPagamento: 0.9, nomePagador: 0.9, nomeFavorecido: 0.9 } } };

describe('flag de emissão de comprovante restrita à homologação', () => {
  it.each([undefined, 'false', '1', 'TRUE'])('desligada por padrão e não aceita valor implícito: %s', valor => {
    expect(carregarConfig({ EMISSAO_COMPROVANTE_HOMOLOGACAO_ATIVA: valor })).toHaveProperty('emissaoComprovanteHomologacaoAtiva', false);
  });
  it('exige true explícito sem ligar flags dos fluxos existentes', () => {
    expect(carregarConfig({ EMISSAO_COMPROVANTE_HOMOLOGACAO_ATIVA: 'true' })).toMatchObject({
      emissaoComprovanteHomologacaoAtiva: true, agenteFiscalAtivo: false, preparacaoFiscalAtiva: false, comunicacaoMedicoAtiva: false,
    });
  });
});

describe('gancho da emissão vem depois da auditoria real', () => {
  it('pedido pronto só chega à fila depois que a auditoria já foi gravada', async () => {
    const historico = new HistoricoComunicacaoEmMemoria();
    const recebidos: unknown[] = [];
    const aoDecidir = async (decisao: unknown, leitura: unknown) => {
      expect(await historico.lerComprovantes(estado.medicoId)).toHaveLength(1);
      recebidos.push({ decisao, leitura });
    };
    const decisao = await processarComprovante(mensagem, estado, { historico, extrator: { extrair: async () => lido }, log: vi.fn(), aoDecidir } as any);
    expect(recebidos).toEqual([{ decisao, leitura: lido }]);
    expect(decisao.tipo).toBe('pedido_nota_pronto');
  });
  it('reprocessamento de auditoria já gravada permite retomar o enfileiramento idempotente', async () => {
    const historico = new HistoricoComunicacaoEmMemoria(); const aoDecidir = vi.fn();
    const deps = { historico, extrator: { extrair: async () => lido }, log: vi.fn(), aoDecidir };
    await processarComprovante(mensagem, estado, deps);
    const segunda = await processarComprovante(mensagem, estado, deps);
    expect(segunda).toEqual({ tipo: 'nenhuma', motivo: 'COMPROVANTE_JA_PROCESSADO' });
    expect(aoDecidir).toHaveBeenCalledTimes(2);
    expect(aoDecidir.mock.calls[1]).toEqual([segunda, lido, estado]);
  });
  it('sem gancho mantém exatamente o resultado atual e apenas audita', async () => {
    const historico = new HistoricoComunicacaoEmMemoria(); const log = vi.fn();
    expect((await processarComprovante(mensagem, estado, { historico, extrator: { extrair: async () => lido }, log })).tipo).toBe('pedido_nota_pronto');
    expect(await historico.lerComprovantes(estado.medicoId)).toHaveLength(1); expect(log).not.toHaveBeenCalled();
  });
  it('falha na auditoria nunca chama enfileiramento', async () => {
    const aoDecidir = vi.fn(), log = vi.fn();
    const historico = { registrarComprovante: async () => { throw Error('segredo ficticio'); } };
    expect(await processarComprovante(mensagem, estado, { historico, extrator: { extrair: async () => lido }, log, aoDecidir } as any))
      .toEqual({ tipo: 'nenhuma', motivo: 'AUDITORIA_FALHOU' });
    expect(aoDecidir).not.toHaveBeenCalled(); expect(log.mock.calls).toEqual([['erro', 'AUDITORIA_COMPROVANTE_FALHOU']]);
  });
  it('dúvida e pacote não chamam enfileiramento', async () => {
    const aoDecidir = vi.fn();
    for (const valorCentavos of [35001, 70000]) {
      const leitura = { ...lido, campos: { ...lido.campos, valorCentavos } };
      await processarComprovante(mensagem, estado, { historico: new HistoricoComunicacaoEmMemoria(), extrator: { extrair: async () => leitura }, log: vi.fn(), aoDecidir } as any);
    }
    expect(aoDecidir).not.toHaveBeenCalled();
  });
  it('erro do enfileiramento é sanitizado e não apaga a auditoria que permite recuperação', async () => {
    const historico = new HistoricoComunicacaoEmMemoria(), log = vi.fn();
    const aoDecidir = async () => { throw Error('senha token CPF ficticios'); };
    expect((await processarComprovante(mensagem, estado, { historico, extrator: { extrair: async () => lido }, log, aoDecidir } as any)).tipo).toBe('pedido_nota_pronto');
    expect(log.mock.calls).toEqual([['erro', 'ENFILEIRAMENTO_COMPROVANTE_FALHOU']]);
    expect(await historico.lerComprovantes(estado.medicoId)).toHaveLength(1);
  });
});
