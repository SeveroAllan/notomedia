/**
 * Planejador IA somente-leitura para o subagente navegador genérico de agendas.
 * Recebe apenas rótulos de controles seguros de navegação e devolve o índice a
 * acionar; quando não há cliente OpenAI configurado, usa fallback determinístico.
 */

import {
  escolhaNavegacaoSchema,
  type EscolhaNavegacao,
  type ObjetivoNavegacao,
  type OpcaoNavegacao,
  type PlanejadorNavegacao,
  type PortalAgendamento
} from './navegador-inteligente.js';

export interface ClienteChatNavegador {
  chat: {
    completions: {
      create(
        params: {
          model: string;
          temperature: number;
          max_completion_tokens: number;
          response_format: { type: 'json_object' };
          messages: Array<{ role: 'system' | 'user'; content: string }>;
        },
        options?: { timeout?: number }
      ): Promise<{
        choices?: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

const MODELO_PADRAO = 'gpt-4o-mini';

export function criarPlanejadorNavegacao(opcoes: {
  cliente?: ClienteChatNavegador | null;
  modelo?: string;
}): PlanejadorNavegacao {
  const modelo = opcoes.modelo?.trim() || MODELO_PADRAO;
  return async (entrada: {
    portal: PortalAgendamento;
    objetivo: ObjetivoNavegacao;
    opcoes: OpcaoNavegacao[];
  }): Promise<EscolhaNavegacao | null> => {
    if (!entrada.opcoes.length) return null;

    if (!opcoes.cliente) {
      const preferido = entrada.opcoes.find(o =>
        entrada.objetivo === 'abrir_agenda'
          ? /agenda|calend[aá]rio/i.test(o.nome)
          : /profissionais?|m[eé]dicos?|filtro/i.test(o.nome)
      ) ?? entrada.opcoes[0];
      return preferido ? { acao: 'selecionar', indice: preferido.indice } : { acao: 'encerrar', indice: null };
    }

    try {
      const resposta = await opcoes.cliente.chat.completions.create(
        {
          model: modelo,
          temperature: 0,
          max_completion_tokens: 40,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Escolha apenas um controle de navegacao para chegar na tela pedida. Responda JSON {"acao":"selecionar","indice":number} ou {"acao":"encerrar","indice":null}. Nunca execute acao de escrita.'
            },
            {
              role: 'user',
              content: JSON.stringify({
                portal: entrada.portal,
                objetivo: entrada.objetivo,
                opcoes: entrada.opcoes.map(o => ({ indice: o.indice, tipo: o.tipo, nome: o.nome }))
              })
            }
          ]
        },
        { timeout: 6_000 }
      );
      const parsed = JSON.parse(resposta.choices?.[0]?.message?.content || 'null');
      const validado = escolhaNavegacaoSchema.safeParse(parsed);
      return validado.success ? validado.data : null;
    } catch {
      return null;
    }
  };
}
