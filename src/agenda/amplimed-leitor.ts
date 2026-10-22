import { cobrancaAmplimed } from './amplimed-mapeamento.js';
import type { ConsultaAdaptador } from './leitura-adaptativa.js';

/**
 * Leitor puro do texto da agenda Amplimed (app.amplimed.com.br/agenda, visão Dia).
 * Cada compromisso aparece como: "HH:MM - HH:MM" e, na linha seguinte,
 * "Paciente | Procedimento | Convênio | R$ valor | telefone".
 * O status não vem no texto (é cor/classe da tela): quem chama informa o status lido da tela; sem isso fica 'agendada'.
 * Não faz rede: só transforma texto em consultas para as checagens.
 */
export function lerAgendaAmplimedTexto(texto: string, opcoes: { data: string; profissional: string; status?: ConsultaAdaptador['status'] }): ConsultaAdaptador[] {
  const linhas = texto.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const saida: ConsultaAdaptador[] = [];
  for (let i = 0; i < linhas.length - 1; i++) {
    const h = /^(\d{2}):(\d{2}) - \d{2}:\d{2}$/.exec(linhas[i]!);
    if (!h) continue;
    const partes = linhas[i + 1]!.split('|').map(p => p.trim());
    if (partes.length < 5) continue;
    const [paciente, , convenio, valor, telefone] = partes as [string, string, string, string, string];
    const m = /R\$\s*([\d.]+),(\d{2})/.exec(valor);
    const centavos = m ? Number(m[1]!.replace(/\./g, '')) * 100 + Number(m[2]) : null;
    const fone = telefone.replace(/\D/g, '');
    saida.push({
      idExterno: `${opcoes.data}T${h[1]}:${h[2]}|${fone || paciente}`,
      dataHora: `${opcoes.data}T${h[1]}:${h[2]}:00-03:00`,
      profissional: opcoes.profissional,
      status: opcoes.status ?? 'agendada',
      tipoCobranca: cobrancaAmplimed(convenio),
      valorCentavos: centavos,
      telefone: fone || null,
      pacienteNome: paciente
    });
  }
  return saida;
}

import { statusAmplimedPorCor } from './amplimed-mapeamento.js';
import { checarLeitura, type Problema } from './leitura-adaptativa.js';

/**
 * Junta texto + cor dos compromissos do dia, aplica as checagens e devolve só o que é confiável.
 * Cor desconhecida vira problema (nunca presume atendimento). Modo observação: não gera nota.
 */
export function montarLeituraAmplimed(eventos: { texto: string; cor: string }[], opcoes: { data: string; profissional: string }) {
  const problemasCor: Problema[] = [];
  const consultas: ConsultaAdaptador[] = [];
  for (const ev of eventos) {
    const st = statusAmplimedPorCor(ev.cor);
    for (const c of lerAgendaAmplimedTexto(ev.texto, { ...opcoes, status: st === 'desconhecido' ? 'agendada' : st })) {
      if (st === 'desconhecido') problemasCor.push({ codigo: 'STATUS_DESCONHECIDO', idExterno: c.idExterno }); else consultas.push(c);
    }
  }
  const r = checarLeitura({ consultas, janela: { inicio: opcoes.data, fim: opcoes.data } }, [opcoes.profissional]);
  const problemas = [...problemasCor, ...r.problemas];
  return { consultas: r.consultas, problemas, confiavel: problemas.length === 0 && r.confiavel, lidos: eventos.length };
}
