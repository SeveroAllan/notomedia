/**
 * Ferramentas conversacionais de emissão de NFS-e e aprendizado de pagadores
 * secundários para o agente Noto no modo autônomo. Separado de
 * `ferramentas-onboarding-autonomo.ts` para manter cada módulo enxuto e focado.
 */

import { tool } from '@openai/agents';
import { z } from 'zod';
import type { ResultadoOperacaoEmissao } from '../emissao/orquestrar-emissao-conta.js';
import type { ResultadoEmissaoLotePeriodo } from '../emissao/preparar-emissao-lote-periodo.js';
import type { resumirCasoParaAgente } from '../emissao/chave-idempotencia-emissao.js';
import type { CodigoFerramenta, FerramentaNoto } from './diagnostico.js';

export interface DependenciasEmissaoAutonoma {
  prepararEmissaoNota?: (entrada: {
    pacienteNome: string;
    dataConsulta?: string | null;
    valorCentavos?: number | null;
    pacienteCpf?: string | null;
    pacienteTelefone?: string | null;
    aprovadoAgora?: boolean;
  }) => Promise<ResultadoOperacaoEmissao>;
  prepararEmissaoPeriodoAgenda?: (entrada: {
    dataInicio: string;
    dataFim: string;
    aprovadoAgora?: boolean;
  }) => Promise<ResultadoEmissaoLotePeriodo>;
  confirmarOuCancelarEmissao?: (entrada: {
    casoId?: string | null;
    decisao: 'aprovar' | 'cancelar' | 'atualizar_dados';
    pacienteNome?: string | null;
    pacienteCpf?: string | null;
    valorCentavos?: number | null;
    dataConsulta?: string | null;
  }) => Promise<ResultadoOperacaoEmissao>;
  vincularPagadorSecundario?: (entrada: {
    pagadorNome: string;
    pacienteNome: string;
    emitirNoCpfDe?: 'paciente' | 'pagador';
    pacienteCpf?: string | null;
    dataConsulta?: string | null;
    casoId?: string | null;
  }) => Promise<ResultadoOperacaoEmissao & { pagadorSalvo: { pagadorNome: string; pacienteNome: string; emitirNoCpfDe: 'paciente' | 'pagador' } }>;
  consultarEmissoesConta?: () => Promise<Array<ReturnType<typeof resumirCasoParaAgente>>>;
}

function codigoPorResultado(r: ResultadoOperacaoEmissao): CodigoFerramenta {
  if (r.acao === 'enfileirada') return 'EMISSAO_ENFILEIRADA';
  if (r.acao === 'aguardar_prontidao_fiscal') return 'EMISSAO_PENDENTE_A1';
  if (r.acao === 'cancelada') return 'EMISSAO_CANCELADA';
  if (r.acao === 'aguardar_aprovacao_medico' || r.acao === 'duplicado') return 'EMISSAO_PREPARADA';
  if (r.acao === 'erro') return 'FERRAMENTA_INDISPONIVEL';
  return 'EMISSAO_PENDENTE_DADOS';
}

export function criarFerramentasEmissaoAutonoma(
  deps: DependenciasEmissaoAutonoma,
  registrar: (nome: FerramentaNoto, codigo: CodigoFerramenta, inicio: number) => void
): ReturnType<typeof tool>[] {
  const lista: ReturnType<typeof tool>[] = [];

  if (deps.prepararEmissaoNota) {
    lista.push(tool({
      name: 'preparar_emissao_nota',
      description: 'CHAME IMEDIATAMENTE sempre que o médico pedir para emitir a nota de um paciente específico (ex.: "emite a nota da Maria Silva", "faz a nota do último atendimento") — passe aprovadoAgora=true e NUNCA recuse citando a preferência automática emitirApenasComComprovante=true, pois pedido explícito do médico sempre prevalece. Busca a consulta na agenda, verifica CPF e prontidão fiscal/A1 (em homologação por padrão). Nunca diga que a nota já foi emitida na prefeitura se acao!="enfileirada" — informe exatamente o estado retornado. Não use [[RESULTADO_ACAO]].',
      parameters: z.object({
        pacienteNome: z.string().trim().min(2).max(160).describe('Nome do paciente para quem a nota será preparada.'),
        dataConsulta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('Data da consulta YYYY-MM-DD se citada ou deduzida de referenciaTemporal.hoje.'),
        valorCentavos: z.number().int().positive().nullable().optional().describe('Valor em centavos (ex.: R$ 350 -> 35000) se o médico informou.'),
        pacienteCpf: z.string().trim().max(20).nullable().optional().describe('CPF do paciente se o médico informou.'),
        pacienteTelefone: z.string().trim().max(25).nullable().optional().describe('Telefone do paciente se o médico informou.'),
        aprovadoAgora: z.boolean().optional().describe('true se o médico já pediu diretamente para emitir agora.')
      }),
      async execute(entrada) {
        const inicio = Date.now();
        try {
          const r = await deps.prepararEmissaoNota!(entrada);
          registrar('preparar_emissao_nota', codigoPorResultado(r), inicio);
          return r;
        } catch {
          registrar('preparar_emissao_nota', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, acao: 'erro', motivo: 'EMISSAO_INDISPONIVEL' };
        }
      }
    }));
  }

  if (deps.prepararEmissaoPeriodoAgenda) {
    lista.push(tool({
      name: 'preparar_emissao_periodo_agenda',
      description: 'CHAME IMEDIATAMENTE SEMPRE QUE O MÉDICO PEDIR PARA EMITIR AS NOTAS DE UM DIA OU PERÍODO INTEIRO (ex.: "emite as notas do dia 28 de setembro", "emite todas as notas de ontem"). Passe aprovadoAgora=true e NUNCA recuse nem pergunte de novo sobre preferências citando emitirApenasComComprovante=true — essa preferência vale só para a rotina automática, nunca para pedido explícito do médico. Lê os atendimentos do período já com CPF, telefone e valor direto da agenda, ignora consultas que já têm nota e coloca na fila (homologação) todas que estiverem prontas. Deduz dataInicio e dataFim de referenciaTemporal.hoje. Não use [[RESULTADO_ACAO]].',
      parameters: z.object({
        dataInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data inicial YYYY-MM-DD deduzida do pedido (ex.: "dia 28 de setembro" -> 2026-09-28).'),
        dataFim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data final YYYY-MM-DD (igual a dataInicio quando for um único dia).'),
        aprovadoAgora: z.boolean().optional().describe('true quando o médico já pediu diretamente para emitir essas notas agora.')
      }),
      async execute(entrada) {
        const inicio = Date.now();
        try {
          const r = await deps.prepararEmissaoPeriodoAgenda!(entrada);
          const codigo: CodigoFerramenta = r.emAndamento
            ? 'AGENDA_LEITURA_INICIADA'
            : r.enfileiradas > 0
              ? 'EMISSAO_ENFILEIRADA'
              : r.pendentes > 0
                ? 'EMISSAO_PENDENTE_DADOS'
                : 'EMISSAO_PREPARADA';
          registrar('preparar_emissao_periodo_agenda', codigo, inicio);
          return r;
        } catch {
          registrar('preparar_emissao_periodo_agenda', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, motivo: 'EMISSAO_LOTE_INDISPONIVEL' };
        }
      }
    }));
  }

  if (deps.confirmarOuCancelarEmissao) {
    lista.push(tool({
      name: 'confirmar_ou_cancelar_emissao',
      description: 'CHAME IMEDIATAMENTE com decisao="aprovar" sempre que o médico disser "tenta de novo", "tente de novo", "reenvia", "pode emitir" ou "ok" — isso reenfileira imediatamente na fila de transmissão todas as notas que estavam com erro na SEFIN ou aguardando aprovação, e o worker em segundo plano chamará o médico de volta no WhatsApp automaticamente alguns segundos depois com o resultado real da prefeitura. Também use para cancelar ("cancelar") ou completar CPF/valor ("atualizar_dados"). Não use [[RESULTADO_ACAO]].',
      parameters: z.object({
        decisao: z.enum(['aprovar', 'cancelar', 'atualizar_dados']),
        casoId: z.string().trim().nullable().optional().describe('Opcional: se omitido, usa o caso pendente mais recente da conta.'),
        pacienteNome: z.string().trim().max(160).nullable().optional(),
        pacienteCpf: z.string().trim().max(20).nullable().optional(),
        valorCentavos: z.number().int().positive().nullable().optional(),
        dataConsulta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
      }),
      async execute(entrada) {
        const inicio = Date.now();
        try {
          const r = await deps.confirmarOuCancelarEmissao!(entrada);
          registrar('confirmar_ou_cancelar_emissao', codigoPorResultado(r), inicio);
          return r;
        } catch {
          registrar('confirmar_ou_cancelar_emissao', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, acao: 'erro', motivo: 'EMISSAO_INDISPONIVEL' };
        }
      }
    }));
  }

  if (deps.vincularPagadorSecundario) {
    lista.push(tool({
      name: 'vincular_pagador_secundario',
      description: 'Salva permanentemente que um pagador diferente (ex.: cônjuge, mãe, pai, responsável) paga pelas consultas de um paciente específico e avança automaticamente o comprovante pendente. Use sempre que o médico esclarecer de qual paciente veio um comprovante de terceiro. Não use [[RESULTADO_ACAO]].',
      parameters: z.object({
        pagadorNome: z.string().trim().min(2).max(160).describe('Nome de quem apareceu no comprovante de pagamento.'),
        pacienteNome: z.string().trim().min(2).max(160).describe('Nome do paciente na agenda a quem esse pagamento se refere.'),
        emitirNoCpfDe: z.enum(['paciente', 'pagador']).optional().describe('Qual CPF usar na nota (padrão: paciente).'),
        pacienteCpf: z.string().trim().max(20).nullable().optional(),
        dataConsulta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        casoId: z.string().trim().nullable().optional()
      }),
      async execute(entrada) {
        const inicio = Date.now();
        try {
          const r = await deps.vincularPagadorSecundario!(entrada);
          registrar('vincular_pagador_secundario', 'PAGADOR_SECUNDARIO_SALVO', inicio);
          registrar('vincular_pagador_secundario', codigoPorResultado(r), inicio);
          return r;
        } catch {
          registrar('vincular_pagador_secundario', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, acao: 'erro', motivo: 'PAGADOR_SECUNDARIO_INDISPONIVEL' };
        }
      }
    }));
  }

  if (deps.consultarEmissoesConta) {
    lista.push(tool({
      name: 'consultar_emissoes_conta',
      description: 'Lista os rascunhos pendentes, emissões na fila e notas recentes desta conta (sempre com CPF mascarado). Use quando o médico perguntar como está uma nota ou o que falta para emitir. Não use [[RESULTADO_ACAO]].',
      parameters: z.object({}),
      async execute() {
        const inicio = Date.now();
        try {
          const casos = await deps.consultarEmissoesConta!();
          registrar('consultar_emissoes_conta', 'EMISSOES_CONSULTADAS', inicio);
          return { ok: true, total: casos.length, casos };
        } catch {
          registrar('consultar_emissoes_conta', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, motivo: 'EMISSOES_INDISPONIVEIS' };
        }
      }
    }));
  }

  return lista;
}
