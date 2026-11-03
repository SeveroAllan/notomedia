import { describe, expect, it } from 'vitest';
import {
  alvoExplicito, cancelouTarefas, classificarPedidoTarefa,
  finalizarPedido, registrarPedido, selecionarConclusao, validarTarefas,
  PRAZO_TAREFA_MS, type TarefaPendente
} from '../src/agente/tarefas.js';

const inicio = Date.UTC(2026, 10, 2, 12);
const referencia = 'a'.repeat(24);
const tarefa = (tipo: TarefaPendente['tipo'], overrides: Partial<TarefaPendente> = {}): TarefaPendente => ({
  tipo, instancia: 'noto_assistente', mensagemId: 'BAE569F0E38F858D',
  remetenteRef: referencia, criadaEm: inicio,
  profissionalId: 'alice-id',
  ...overrides
});

describe('conclusão verificável e referência original', () => {
  it('reconhece somente tarefas explícitas que ferramentas conseguem comprovar', () => {
    expect(classificarPedidoTarefa('Consegue verificar a agenda da Alice?')).toBe('verificar_agenda');
    expect(classificarPedidoTarefa('Noto, verifica a agenda da Alice')).toBe('verificar_agenda');
    expect(classificarPedidoTarefa('Quero conectar minha agenda na Amplimed')).toBe('conectar_agenda');
    expect(classificarPedidoTarefa('Pode me enviar o link da agenda?')).toBe('enviar_link_agenda');
    expect(classificarPedidoTarefa('Quero adicionar outro médico')).toBe('vincular_profissionais');
    expect(classificarPedidoTarefa('Pode atualizar meu CRM?')).toBe('salvar_dados_profissionais');
    expect(classificarPedidoTarefa('Pode verificar meu certificado?')).toBe('verificar_certificado');
    expect(classificarPedidoTarefa('Consegue consultar a prontidão do cadastro?')).toBe('verificar_prontidao');
    expect(classificarPedidoTarefa('Consegue descobrir profissionais da agenda?')).toBe('descobrir_profissionais');
    expect(classificarPedidoTarefa('Como enviar um link?')).toBeNull();
    expect(classificarPedidoTarefa('Pode emitir minha nota fiscal?')).toBeNull();
    expect(classificarPedidoTarefa('Obrigado!')).toBeNull();
    expect(cancelouTarefas('Não precisa, deixa pra lá')).toBe(true);
  });

  it('mantém o ID da solicitação e conclui em turno posterior somente com tipo e médico correspondentes', () => {
    const pedido = registrarPedido([], tarefa('enviar_link_agenda', { agenda: 'amplimed' }), inicio);
    expect(selecionarConclusao(pedido, [{ tipo: 'verificar_agenda', profissionalId: 'alice-id' }],
      'noto_assistente', referencia, 'alice-id', inicio)).toBeNull();
    expect(selecionarConclusao(pedido, [{ tipo: 'enviar_link_agenda', profissionalId: 'bruno-id', agenda: 'amplimed' }],
      'noto_assistente', referencia, 'alice-id', inicio)).toBeNull();
    expect(selecionarConclusao(pedido, [{ tipo: 'enviar_link_agenda', profissionalId: 'alice-id', agenda: 'tribemd' }],
      'noto_assistente', referencia, 'alice-id', inicio)).toBeNull();
    const concluido = selecionarConclusao(pedido,
      [{ tipo: 'enviar_link_agenda', profissionalId: 'alice-id', agenda: 'amplimed' }],
      'noto_assistente', referencia, 'alice-id', inicio);
    expect(concluido?.mensagemId).toBe('BAE569F0E38F858D');
    expect(finalizarPedido(pedido, concluido!)).toEqual([]);
  });

  it('não completa pedido sem alvo conhecido nem cruza conta, instância ou pessoa', () => {
    const pedido = tarefa('verificar_agenda', { profissionalId: undefined });
    const evidencia = [{ tipo: 'verificar_agenda' as const, profissionalId: 'alice-id' }];
    expect(selecionarConclusao([pedido], evidencia, 'noto_assistente', referencia, undefined, inicio)).toBeNull();
    expect(selecionarConclusao([pedido], evidencia, 'noto_assistente', 'b'.repeat(24), 'alice-id', inicio)).toBeNull();
    expect(selecionarConclusao([pedido], evidencia, 'outra_instancia', referencia, 'alice-id', inicio)).toBeNull();
    expect(selecionarConclusao([pedido], evidencia, 'noto_assistente', referencia, 'bruno-id', inicio)).toBeNull();
    expect(selecionarConclusao([pedido], [{...evidencia[0]!, agenda:'tribemd' as const}], 'noto_assistente', referencia, 'alice-id', inicio)).toBeNull();
    expect(selecionarConclusao([pedido], evidencia, 'noto_assistente', referencia, 'alice-id', inicio)?.mensagemId)
      .toBe(pedido.mensagemId);
  });

  it('expira pendências, descarta campos inesperados e evita dois pedidos indistinguíveis', () => {
    const primeiro = tarefa('verificar_agenda');
    const recente = tarefa('verificar_agenda', { mensagemId: 'BAE569F0E38F858E' });
    expect(registrarPedido([primeiro], recente, inicio)).toEqual([primeiro]);
    expect(validarTarefas([{...primeiro, texto: 'NAO_GUARDAR', credencial: 'SENHA'}], inicio))
      .toEqual([primeiro]);
    expect(validarTarefas([primeiro], inicio + PRAZO_TAREFA_MS)).toEqual([]);
    expect(validarTarefas([{...primeiro, mensagemId:'<script>'}],inicio)).toEqual([]);
    expect(selecionarConclusao([
      primeiro, tarefa('verificar_agenda', { mensagemId: 'BAE569F0E38F858E', profissionalId: undefined })
    ], [{ tipo: 'verificar_agenda', profissionalId: 'alice-id' }],
      'noto_assistente', referencia, 'alice-id', inicio)).toBeNull();
  });

  it('mantém o balão original ao repetir pedido e ao especificar médico e agenda depois', () => {
    const geral = tarefa('enviar_link_agenda', { profissionalId: undefined, agenda: undefined });
    const repetido = tarefa('enviar_link_agenda', { mensagemId:'BAE569F0E38F858E',
      profissionalId: undefined, agenda: undefined });
    expect(registrarPedido([geral], repetido, inicio)).toEqual([geral]);
    const maisClaro = {...repetido, profissionalId:'alice-id', agenda:'amplimed' as const };
    expect(registrarPedido([geral], maisClaro, inicio)).toEqual([
      {...geral, profissionalId:'alice-id', agenda:'amplimed'}
    ]);
    const diferente = {...repetido, profissionalId:'bruno-id'};
    expect(registrarPedido([tarefa('enviar_link_agenda')], diferente, inicio)).toHaveLength(2);
  });

  it('conclui tarefa sem agenda declarada apenas com uma fonte inequivocamente comprovada', () => {
    const pedido = [tarefa('enviar_link_agenda', { agenda: undefined })];
    const prova = {tipo:'enviar_link_agenda' as const, profissionalId:'alice-id', agenda:'amplimed' as const};
    expect(selecionarConclusao(pedido, [prova], 'noto_assistente', referencia, 'alice-id', inicio))
      ?.toEqual(pedido[0]);
    expect(selecionarConclusao(pedido, [prova, {...prova,agenda:'tribemd'}],
      'noto_assistente', referencia, 'alice-id', inicio)).toBeNull();
    expect(selecionarConclusao(pedido, [{...prova,profissionalId:'bruno-id'}],
      'noto_assistente', referencia, 'alice-id', inicio)).toBeNull();
    const geral=[tarefa('verificar_agenda',{agenda:undefined})];
    expect(selecionarConclusao(geral,[{tipo:'verificar_agenda',profissionalId:'alice-id',agenda:'tribemd'}],
      'noto_assistente',referencia,'alice-id',inicio)).toBeNull();
    expect(selecionarConclusao(geral,[{tipo:'verificar_agenda',profissionalId:'alice-id'}],
      'noto_assistente',referencia,'alice-id',inicio)).toEqual(geral[0]);
  });

  it('só associa nome explicitamente inequívoco', () => {
    const prof = [{ id: 'alice-id', nome: 'Dra. Alice Souza' }, { id: 'bruno-id', nome: 'Dr. Bruno Lima' }];
    expect(alvoExplicito('Consegue verificar a agenda da Alice?', prof)).toBe('alice-id');
    expect(alvoExplicito('Quero verificar a agenda', prof)).toBeUndefined();
    expect(alvoExplicito('Verifique a agenda da Alice e do Bruno', prof)).toBeUndefined();
  });
});
