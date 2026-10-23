import { describe, expect, it, vi } from 'vitest';
import { aposEnfileirarComprovante, type AposEnfileirarDeps } from '../src/fluxos/apos-enfileirar-comprovante.js';

function alvo(extra: Partial<AposEnfileirarDeps> = {}) {
  const chamadas = { conversa: [] as any[], confirmarEmissao: [] as any[], registrarPergunta: [] as any[], criarLink: 0 };
  const estado = { liberada: false, pendentes: [] as any[], linkCriado: false, escolha: null as unknown };
  const deps: AposEnfileirarDeps = {
    permissoes: {
      permite: async () => estado.escolha === 'autonomo',
      ler: async () => estado.escolha,
      linkJaCriado: async () => estado.linkCriado,
      criarLink: vi.fn(async () => { chamadas.criarLink++; estado.linkCriado = true; return { url: 'https://notomed.tech/p/ficticio' }; })
    },
    emissao: {
      liberarPorPreferencia: vi.fn(async () => {
        if (estado.liberada) return false; // re-drive: update...where aguardando=true não casa
        estado.liberada = true; return true;
      }),
      buscarConfirmacoes: vi.fn(async () => estado.pendentes),
      registrarPergunta: vi.fn(async (...args: any[]) => { chamadas.registrarPergunta.push(args); })
    },
    comunicacao: {
      conversa: vi.fn(async (e: any) => { chamadas.conversa.push(e); return 'enviado'; }),
      confirmarEmissao: vi.fn(async (e: any) => { chamadas.confirmarEmissao.push(e); return { resultado: 'enviado', chaveMensagem: 'msg-pergunta-1' }; })
    },
    ...extra };
  return { deps, chamadas, estado };
}

const pendente = (envio?: string) => ({ id: 'sol-1', confirmacao: { paciente: 'Paciente Ficticio',
  dataEnvioPagamento: '18/10/2026', dataConsulta: '18/10/2026', ...(envio ? { envio, perguntaChave: 'msg-pergunta-1' } : {}) } });

describe('aposEnfileirarComprovante', () => {
  it('primeiro drive autônomo: libera e avisa uma vez, sem pergunta', async () => {
    const { deps, chamadas, estado } = alvo();
    estado.escolha = 'autonomo';
    await aposEnfileirarComprovante(deps, 'm1', 'sol-1');
    expect(estado.liberada).toBe(true);
    expect(chamadas.conversa.map(c => c.chave)).toEqual(['emissao_autonoma:sol-1']);
    expect(chamadas.confirmarEmissao).toHaveLength(0);
    expect(chamadas.registrarPergunta).toHaveLength(0);
  });
  it('re-drive autônomo (já liberada): não reabre pergunta nem toca na auditoria', async () => {
    const { deps, chamadas, estado } = alvo();
    estado.escolha = 'autonomo';
    estado.liberada = true; // crash depois da liberação: liberarPorPreferencia devolve false
    estado.pendentes = []; // já liberada não aparece como pendente
    await aposEnfileirarComprovante(deps, 'm1', 'sol-1');
    expect(chamadas.confirmarEmissao).toHaveLength(0);
    expect(chamadas.registrarPergunta).toHaveLength(0);
    expect(chamadas.conversa).toHaveLength(0);
  });
  it('primeiro drive com confirmação: pergunta e registra uma vez, oferece link uma vez', async () => {
    const { deps, chamadas, estado } = alvo();
    estado.pendentes = [pendente()];
    await aposEnfileirarComprovante(deps, 'm1', 'sol-1');
    expect(chamadas.confirmarEmissao).toHaveLength(1);
    expect(chamadas.registrarPergunta).toEqual([['m1', 'sol-1', 'enviado', 'msg-pergunta-1', expect.any(Date)]]);
    expect(chamadas.criarLink).toBe(1);
    expect(chamadas.conversa.map(c => c.chave)).toEqual(['link_permissoes:emitir_autonomo:primeiro']);
  });
  it('re-drive com pergunta já enviada: não reenvia, não regrava (preserva perguntaChave), não recria link', async () => {
    const { deps, chamadas, estado } = alvo();
    estado.pendentes = [pendente('enviado')];
    estado.linkCriado = true;
    await aposEnfileirarComprovante(deps, 'm1', 'sol-1');
    expect(chamadas.confirmarEmissao).toHaveLength(0);
    expect(chamadas.registrarPergunta).toHaveLength(0);
    expect(chamadas.criarLink).toBe(0);
    expect(chamadas.conversa).toHaveLength(0);
  });
  it('envio repetido pela dedupe da notificação: não regrava auditoria', async () => {
    const { deps, chamadas, estado } = alvo();
    estado.pendentes = [pendente()];
    estado.linkCriado = true;
    (deps.comunicacao.confirmarEmissao as any).mockImplementation(async (e: any) => { chamadas.confirmarEmissao.push(e); return { resultado: 'repetido' }; });
    await aposEnfileirarComprovante(deps, 'm1', 'sol-1');
    expect(chamadas.confirmarEmissao).toHaveLength(1);
    expect(chamadas.registrarPergunta).toHaveLength(0);
  });
  it('sem solicitação: no-op', async () => {
    const { deps, chamadas } = alvo();
    await aposEnfileirarComprovante(deps, 'm1', null);
    await aposEnfileirarComprovante({ ...deps, emissao: null }, 'm1', 'sol-1');
    expect(chamadas.confirmarEmissao).toHaveLength(0);
  });
});
