/**
 * Navegador especializado: a IA escolhe apenas um controle de NAVEGAÇÃO
 * observado na tela; o Playwright executa somente links e controles seguros
 * de leitura. O modelo nunca lê prontuários, CPF, cookies ou senhas.
 */
import type { Page } from 'playwright-core';
import { z } from 'zod';
import {
  AGENDAS_SUPORTADAS,
  dominioAprovado,
  type AgendaSuportada,
  type DefinicaoAgendaSuportada
} from '../agenda/agendas-suportadas.js';

export type PortalAgendamento = AgendaSuportada;
export type ObjetivoNavegacao = 'abrir_agenda' | 'localizar_profissionais';

export interface OpcaoNavegacao {
  indice: number;
  tipo: 'link' | 'controle' | 'aba';
  nome: string;
  destino?: string;
}

export const escolhaNavegacaoSchema = z.object({
  acao: z.enum(['selecionar', 'encerrar']),
  indice: z.number().int().nonnegative().max(19).nullable()
}).strict();

export type EscolhaNavegacao = z.infer<typeof escolhaNavegacaoSchema>;
export type PlanejadorNavegacao = (entrada: {
  portal: PortalAgendamento;
  objetivo: ObjetivoNavegacao;
  opcoes: OpcaoNavegacao[];
}) => Promise<EscolhaNavegacao | null>;

const NAVIGAVEL = /\b(agenda|calend[aá]rio|calendar|atendimentos?|consultas?|profissionais?|m[eé]dicos?|filtro|selecionar\s+(?:m[eé]dico|profissional))\b/iu;
const BLOQUEIO = /\b(excluir|deletar|apagar|salvar|confirmar|enviar|emitir|cancelar|novo|cadastrar|alterar|editar|assinar|pagamento|comprar|importar|exportar|desconectar|sair)\b/iu;

function rotasPermitidasDoPortal(portal: PortalAgendamento): readonly string[] {
  const cfg = AGENDAS_SUPORTADAS[portal] as DefinicaoAgendaSuportada;
  return cfg?.rotasSeguras ?? ['/agenda', '/calendario'];
}

export function filtrarOpcoesNavegacao(
  portal: PortalAgendamento,
  observadas: Omit<OpcaoNavegacao, 'indice'>[],
  hostExtra?: string | null
): OpcaoNavegacao[] {
  const rotas = rotasPermitidasDoPortal(portal);
  const destinoPermitido = (destino: string | undefined): boolean => {
    if (!destino) return true;
    try {
      const url = new URL(destino);
      return (
        dominioAprovado(portal, destino, hostExtra) &&
        rotas.some(rota => url.pathname === rota || url.pathname.startsWith(`${rota}/`)) &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  };
  return observadas
    .filter(
      o =>
        typeof o.nome === 'string' &&
        o.nome.length > 0 &&
        o.nome.length <= 65 &&
        NAVIGAVEL.test(o.nome) &&
        !BLOQUEIO.test(o.nome) &&
        destinoPermitido(o.destino)
    )
    .slice(0, 20)
    .map((o, i) => ({ ...o, indice: i }));
}

export async function navegarComAgente(
  page: Page,
  portal: PortalAgendamento,
  objetivo: ObjetivoNavegacao,
  planejar: PlanejadorNavegacao,
  limite = 3,
  hostExtra?: string | null
): Promise<'navegou' | 'sem_acao'> {
  if (!Number.isInteger(limite) || limite < 1 || limite > 3) return 'sem_acao';
  let navegou = false;
  for (let passo = 0; passo < limite; passo++) {
    try {
      if (!dominioAprovado(portal, page.url(), hostExtra)) return navegou ? 'navegou' : 'sem_acao';
      const observadas = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href],button,[role="tab"]'))
          .filter((el): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0)
          .slice(0, 150)
          .map(el => ({
            tipo:
              el.tagName.toLowerCase() === 'a'
                ? ('link' as const)
                : el.getAttribute('role') === 'tab'
                  ? ('aba' as const)
                  : ('controle' as const),
            nome: (el.getAttribute('aria-label') || el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80),
            ...(el.tagName.toLowerCase() === 'a' && el.getAttribute('href')
              ? { destino: new URL(el.getAttribute('href')!, location.href).href }
              : {})
          }));
      });
      const opcoes = filtrarOpcoesNavegacao(portal, observadas, hostExtra);
      if (!opcoes.length) return navegou ? 'navegou' : 'sem_acao';
      const decisao = escolhaNavegacaoSchema.safeParse(await planejar({ portal, objetivo, opcoes }));
      if (!decisao.success || decisao.data.acao === 'encerrar') return navegou ? 'navegou' : 'sem_acao';
      const escolha = opcoes[decisao.data.indice ?? -1];
      if (!escolha) return navegou ? 'navegou' : 'sem_acao';
      if (escolha.tipo === 'link' && escolha.destino) {
        await page.goto(escolha.destino, { waitUntil: 'domcontentloaded', timeout: 12_000 });
      } else {
        const candidatos = page.getByRole(
          escolha.tipo === 'aba' ? 'tab' : escolha.tipo === 'controle' ? 'button' : 'link',
          { name: escolha.nome, exact: true }
        );
        if ((await candidatos.count()) !== 1) return navegou ? 'navegou' : 'sem_acao';
        await candidatos.click({ timeout: 5_000 });
      }
      navegou = true;
    } catch {
      return navegou ? 'navegou' : 'sem_acao';
    }
  }
  return navegou ? 'navegou' : 'sem_acao';
}
