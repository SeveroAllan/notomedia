/**
 * Retomada de missão após um resultado durável do sistema.
 *
 * NÃO interpreta o evento como nova autorização do operador. A execução é
 * apenas de leitura, e qualquer fala que não preserve o comprovante recebido
 * é descartada. A fila mantém o controle de idempotência e entrega incerta.
 */
import type pg from 'pg';
import type { Model } from '@openai/agents';
import { responderAgente, type StatusFontes } from './agente.js';
import { lerEstadoConversa } from './estado-conversa.js';
import { nomeProfissionalValido } from '../conta/validar-dados-emissao.js';

type Banco = Pick<pg.Pool, 'query'>;
export type TipoEventoTrabalho = 'descoberta_agenda' | 'conferencia_fiscal' | 'pesquisa_registro';

export interface EventoTrabalhoVerificado {
  tipo: TipoEventoTrabalho;
  contaId: string;
  textoComprovado: string;
}

export interface DependenciasContinuacaoEvento {
  pool: Banco;
  consultarStatus: (referencia: string) => Promise<StatusFontes>;
  apiKey?: string;
  modeloNome?: string;
  modeloTeste?: Model;
  controleCusto?: pg.Pool;
  exigirControleCusto?: boolean;
  tracesAtivos?: boolean;
}

/**
 * Fala adicional só pode anteceder o comprovante literal. Nunca deixa a IA
 * substituir nomes, números, resultados fiscais ou a pergunta de confirmação.
 */
export function validarFalaEvento(texto: string, comprovante: string): string | null {
  const resposta = texto.trim();
  const prova = comprovante.trim();
  if (!prova || prova.length > 1200 || !resposta || resposta.length > 1200) return null;
  if (resposta === prova) return resposta;
  if (!resposta.endsWith(prova)) return null;
  const abertura = resposta.slice(0, -prova.length).trim();
  if (!abertura || abertura.length > 65 || /[0-9]|https?:|crm|rqe|nota|emit|paciente|certificado|confirmad|vinculad|conectad|salv|aprov|autoriz/i.test(abertura)) return null;
  if (!/^[\p{L}\p{M}\s,.!?-]+$/u.test(abertura)) return null;
  return resposta;
}

/**
 * O worker só chama esta função após reservar a notificação, verificar a
 * autorização da conta e persistir o resultado autenticado. Uma falha de IA
 * preserva o aviso determinístico, sem nova tentativa automática de envio.
 */
export async function continuarEventoComNoto(
  evento: EventoTrabalhoVerificado,
  deps: DependenciasContinuacaoEvento
): Promise<string | null> {
  if ((!deps.apiKey && !deps.modeloTeste) || !evento.textoComprovado.trim() ||
      evento.textoComprovado.length > 1100 ||
      !['descoberta_agenda','conferencia_fiscal','pesquisa_registro'].includes(evento.tipo)) return null;
  if (deps.exigirControleCusto && !deps.controleCusto) return null;
  try {
    const medicos = await deps.pool.query(
      'select id,nome_completo from public.medicos where conta_id=$1 order by nome_completo,id limit 21',
      [evento.contaId]
    );
    const profissionais = medicos.rows.map((p:{id:string;nome_completo:string|null})=>({
      id:p.id,nome:String(p.nome_completo??'')
    })).filter(p=>nomeProfissionalValido(p.nome));
    const estado = await lerEstadoConversa(deps.pool, evento.contaId);
    // O evento é um fato do sistema, não uma mensagem do usuário. Sem
    // ferramentas de escrita ou de emissão nesta retomada.
    const resposta = await responderAgente({
      texto: evento.textoComprovado,
      eventoInterno: true,
      profissionais,
      estadoConversa: estado,
      contexto: []
    }, {
      consultarStatus: deps.consultarStatus,
      ...(deps.apiKey ? {apiKey:deps.apiKey} : {}),
      ...(deps.modeloNome ? {modeloNome:deps.modeloNome} : {}),
      ...(deps.modeloTeste ? {modeloTeste:deps.modeloTeste} : {}),
      ...(deps.controleCusto ? {controleCusto:deps.controleCusto} : {}),
      exigirControleCusto:deps.exigirControleCusto,
      tracesAtivos:deps.tracesAtivos
    });
    return validarFalaEvento(resposta,evento.textoComprovado);
  } catch {
    return null;
  }
}
