/**
 * Ferramentas autônomas do agente para rotina operacional e memória:
 * gravação de preferências de emissão, busca em conversas anteriores,
 * edição de blocos de memória núcleo (Letta) e consulta de atendimentos na agenda.
 */

import { tool } from '@openai/agents';
import { z } from 'zod';
import {
  avaliarPreferenciasEmissao,
  PREFERENCIAS_EMISSAO_VAZIAS,
  reconciliarPreferenciasComFalaDoMedico,
  type AtualizacaoPreferenciasEmissao,
  type PreferenciasEmissaoConta
} from '../conta/preferencias-emissao.js';
import type { FiltroAtendimentosAgenda } from '../agenda/filtrar-atendimentos-agenda.js';
import type { ResultadoConsultaAgendaConta } from '../agenda/consultar-agenda-conta.js';
import type { RotuloBlocoEditavelAgente } from './memoria/blocos-memoria-config.js';
import type { ResultadoBuscaMemoria } from './memoria/memoria-repositorio.js';
import type { CodigoFerramenta, FerramentaNoto } from './diagnostico.js';

export interface DependenciasRotinaEMemoria {
  salvarPreferenciasEmissao?: (
    atualizacao: AtualizacaoPreferenciasEmissao,
    falaMedico?: string
  ) => Promise<PreferenciasEmissaoConta>;
  buscarMemoriaConversa?: (entrada: {
    termo?: string | null;
    dataInicio?: string | null;
    dataFim?: string | null;
    limite?: number;
  }) => Promise<ResultadoBuscaMemoria>;
  atualizarMemoriaNucleo?: (entrada: {
    rotulo: RotuloBlocoEditavelAgente;
    operacao: 'substituir' | 'acrescentar';
    conteudo: string;
  }) => Promise<{ ok: boolean; rotulo: RotuloBlocoEditavelAgente; conteudoAtual: string }>;
  consultarAgendaAtendimentos?: (filtro: FiltroAtendimentosAgenda) => Promise<ResultadoConsultaAgendaConta>;
}

export function criarFerramentasRotinaEMemoria(
  deps: DependenciasRotinaEMemoria,
  registrar: (nome: FerramentaNoto, codigo: CodigoFerramenta, inicio: number) => void,
  textoMensagemAtual?: string
): ReturnType<typeof tool>[] {
  const ferramentas: ReturnType<typeof tool>[] = [];

  if (deps.salvarPreferenciasEmissao) {
    ferramentas.push(tool({
      name: 'salvar_preferencias_emissao',
      description: 'CHAME IMEDIATAMENTE sempre que o médico responder sobre como prefere emitir notas (mesmo respostas curtas como "depois do comprovante", "após o pagamento", "após consulta", "direto", "pergunta pra mim"). ATENÇÃO: se o médico disser "depois do comprovante" ou "após o pagamento", emitirApenasComComprovante é TRUE (e não false!). Envie SOMENTE o booleano que responde à pergunta atual e passe null nos demais; NUNCA altere uma preferência já combinada em turno anterior a menos que o médico peça explicitamente para mudar aquela preferência. Depois de salvar, responda curto e humano (SEM usar [[RESULTADO_ACAO]]).',
      parameters: z.object({
        emitirApenasComComprovante: z.boolean().nullable().optional().describe('true quando o médico emite mediante/após/depois do comprovante de pagamento ("depois do comprovante", "após o pagamento", "só com comprovante"); false SOMENTE quando emite logo após a consulta sem esperar comprovante.'),
        revisaoDiariaAgenda: z.boolean().nullable().optional().describe('Deixe SEMPRE null a menos que o médico fale explicitamente sobre olhar a agenda todo dia (já é inferido automaticamente).'),
        enviarNotaParaPaciente: z.boolean().nullable().optional().describe('true se a nota pronta deve ser enviada direto no WhatsApp do paciente; false se o médico pediu para enviar a nota para ele mesmo ("envia pra mim", "não envia pro paciente").'),
        pedirAprovacaoAntesDeEmitir: z.boolean().nullable().optional().describe('true se o médico quer revisar/dar ok antes de cada nota sair; false se disse "direto" na pergunta de aprovação da nota. NUNCA preencha este campo quando o médico estiver respondendo à pergunta sobre CPF.'),
        solicitarCpfDiretoPaciente: z.boolean().nullable().optional().describe('true se, faltando CPF, o Noto pode pedir direto ao paciente; false se o médico respondeu "pergunta pra mim" na pergunta sobre CPF faltante.')
      }),
      async execute(entrada) {
        const inicio = Date.now();
        try {
          const entradaReconciliada = reconciliarPreferenciasComFalaDoMedico(
            textoMensagemAtual,
            PREFERENCIAS_EMISSAO_VAZIAS,
            entrada
          );
          const atualizadas = await deps.salvarPreferenciasEmissao!(entradaReconciliada, textoMensagemAtual);
          const avaliacao = avaliarPreferenciasEmissao(atualizadas);
          registrar('salvar_preferencias_emissao', 'PREFERENCIAS_SALVAS', inicio);
          const mudouRotina = typeof entrada.emitirApenasComComprovante === 'boolean'
            || typeof entrada.revisaoDiariaAgenda === 'boolean';
          return {
            ok: true,
            preferencias: avaliacao.valores,
            pendentes: avaliacao.pendentes,
            completas: avaliacao.completas,
            ...(mudouRotina && avaliacao.comoFuncionaNaPratica ? { comoFuncionaNaPratica: avaliacao.comoFuncionaNaPratica } : {}),
            proximoAssuntoSugerido: avaliacao.proximoAssunto,
            resumoCombinado: avaliacao.resumoCombinado
          };
        } catch {
          registrar('salvar_preferencias_emissao', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, motivo: 'PREFERENCIAS_INDISPONIVEIS' };
        }
      }
    }));
  }

  if (deps.buscarMemoriaConversa) {
    ferramentas.push(tool({
      name: 'buscar_memoria_conversa',
      description: 'Pesquisa nas conversas anteriores (resumos compactados dos dias passados e mensagens de hoje) para conferir o que o médico já disse, pediu, combinou ou deixou de pedir (ex.: conferir se ele chegou a pedir uma nota de um paciente/dia específico). Complementa — nunca substitui — as ferramentas operacionais do sistema. Não use [[RESULTADO_ACAO]] ao responder depois desta ferramenta.',
      parameters: z.object({
        termo: z.string().trim().max(120).nullable().optional().describe('Nome, assunto ou palavra-chave para procurar nas conversas anteriores.'),
        dataInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('Data inicial opcional no formato YYYY-MM-DD.'),
        dataFim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('Data final opcional no formato YYYY-MM-DD.')
      }),
      async execute({ termo, dataInicio, dataFim }) {
        const inicio = Date.now();
        try {
          const r = await deps.buscarMemoriaConversa!({ termo, dataInicio, dataFim });
          registrar('buscar_memoria_conversa', 'MEMORIA_CONSULTADA', inicio);
          return {
            ok: true,
            resumosEncontrados: r.resumosEncontrados,
            mensagensEncontradas: r.mensagensEncontradas,
            observacao: 'Estes registros refletem o que foi conversado no WhatsApp. Para confirmar se uma nota foi de fato emitida na prefeitura, consulte também as ferramentas operacionais.'
          };
        } catch {
          registrar('buscar_memoria_conversa', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, motivo: 'MEMORIA_INDISPONIVEL' };
        }
      }
    }));
  }

  if (deps.atualizarMemoriaNucleo) {
    ferramentas.push(tool({
      name: 'atualizar_memoria_nucleo',
      description: 'Salva silenciosamente na memória permanente da conta (`perfil_medico` ou `pendencias_e_combinados`) preferências pessoais, hábitos do consultório, forma de tratamento ou combinados em aberto. Nunca grave CPFs, senhas ou links. Use operacao="acrescentar" para somar uma linha nova ou "substituir" para limpar/reescrever o bloco inteiro. Não use [[RESULTADO_ACAO]].',
      parameters: z.object({
        rotulo: z.enum(['perfil_medico', 'pendencias_e_combinados']),
        operacao: z.enum(['acrescentar', 'substituir']).default('acrescentar'),
        conteudo: z.string().trim().max(1200)
      }),
      async execute({ rotulo, operacao, conteudo }) {
        const inicio = Date.now();
        try {
          const r = await deps.atualizarMemoriaNucleo!({ rotulo, operacao, conteudo });
          registrar('atualizar_memoria_nucleo', r.ok ? 'MEMORIA_NUCLEO_ATUALIZADA' : 'FERRAMENTA_INDISPONIVEL', inicio);
          return r;
        } catch {
          registrar('atualizar_memoria_nucleo', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, motivo: 'MEMORIA_NUCLEO_INDISPONIVEL' };
        }
      }
    }));
  }

  if (deps.consultarAgendaAtendimentos) {
    ferramentas.push(tool({
      name: 'consultar_agenda_atendimentos',
      description: 'SOMENTE para perguntas informativas sobre a agenda (ex.: "quem eu atendi ontem?", "quantas consultas fiz em novembro?"). NUNCA chame esta ferramenta quando o médico pedir para EMITIR ou PREPARAR notas (ex.: "emite as notas do dia 28 de setembro", "sim, emitir as notas") — para emitir notas, chame DIRETAMENTE `preparar_emissao_periodo_agenda` ou `preparar_emissao_nota`. Deduz o intervalo com base em `referenciaTemporal.hoje`. Não use [[RESULTADO_ACAO]].',
      parameters: z.object({
        dataInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data inicial YYYY-MM-DD deduzida do pedido natural usando referenciaTemporal.hoje.'),
        dataFim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data final YYYY-MM-DD deduzida do pedido natural (no máximo hoje).'),
        filtroPaciente: z.string().trim().max(120).nullable().optional().describe('Nome do paciente se o médico perguntou sobre alguém específico.'),
        filtroProfissional: z.string().trim().max(120).nullable().optional().describe('Deixe null a menos que o médico tenha citado explicitamente o nome de um profissional na pergunta.')
      }),
      async execute({ dataInicio, dataFim, filtroPaciente, filtroProfissional }) {
        const inicio = Date.now();
        try {
          const r = await deps.consultarAgendaAtendimentos!({ dataInicio, dataFim, filtroPaciente, filtroProfissional });
          if (!r.ok) {
            registrar('consultar_agenda_atendimentos', r.motivo === 'SEM_AGENDA_CONECTADA' ? 'CONEXAO_PENDENTE' : 'FERRAMENTA_INDISPONIVEL', inicio);
            return r;
          }
          if (r.emAndamento) {
            registrar('consultar_agenda_atendimentos', 'AGENDA_LEITURA_INICIADA', inicio);
            return {
              ok: true,
              emAndamento: true,
              agenda: r.agenda,
              periodo: r.periodo,
              observacao: 'A leitura real da agenda já começou em segundo plano e o resultado será enviado automaticamente no WhatsApp assim que concluir.'
            };
          }
          registrar('consultar_agenda_atendimentos', 'AGENDA_ATENDIMENTOS_CONSULTADOS', inicio);
          return { ok: true, emAndamento: false, agenda: r.agenda, ...r.resumo };
        } catch {
          registrar('consultar_agenda_atendimentos', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, motivo: 'LEITURA_INDISPONIVEL' };
        }
      }
    }));
  }

  return ferramentas;
}
