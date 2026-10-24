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
export function montarLeituraAmplimed(eventos: { texto: string; cor: string; detalhe?: DetalheAmplimed | null }[], opcoes: { data: string; profissional: string }) {
  const problemasCor: Problema[] = [];
  const consultas: ConsultaAdaptador[] = [];
  const detalhes = new Map<string, DetalheAmplimed>();
  for (const ev of eventos) {
    const st = statusAmplimedPorCor(ev.cor);
    for (const c of lerAgendaAmplimedTexto(ev.texto, { ...opcoes, status: st === 'desconhecido' ? 'agendada' : st })) {
      if (st === 'desconhecido') problemasCor.push({ codigo: 'STATUS_DESCONHECIDO', idExterno: c.idExterno });
      else { consultas.push(c); if (ev.detalhe && nomesIguais(ev.detalhe.nome, c.pacienteNome)) detalhes.set(c.idExterno, ev.detalhe); }
    }
  }
  const r = checarLeitura({ consultas, janela: { inicio: opcoes.data, fim: opcoes.data } }, [opcoes.profissional]);
  const problemas = [...problemasCor, ...r.problemas];
  return { consultas: r.consultas, problemas, confiavel: problemas.length === 0 && r.confiavel, lidos: eventos.length, detalhes };
}

const MESES: Record<string, string> = { jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06', jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12' };
/** "quarta-feira, 21 de out de 2026" (cabeçalho da agenda do Amplimed) -> "2026-10-21". Nulo se não reconhecer. */
export function dataDoCabecalhoAmplimed(texto: string): string | null {
  const m = /(\d{1,2}) de ([a-zç]{3})[a-z]* de (\d{4})/i.exec(texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
  const mes = m ? MESES[m[2]!] : undefined;
  return m && mes ? `${m[3]}-${mes}-${m[1]!.padStart(2, '0')}` : null;
}
/** Data esperada `diasAtras` dias antes de `hoje` (aaaa-mm-dd), sem depender de fuso do processo. */
export function dataEsperadaAtras(hoje: string, diasAtras: number): string {
  const d = new Date(hoje + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - diasAtras);
  return d.toISOString().slice(0, 10);
}

/** Dias de hoje até `desde`, do mais recente para o mais antigo, com teto. */
export function diasAtrasAmplimed(hoje: string, desde: string, teto = 31): number | null {
  const n = Math.round((Date.parse(hoje) - Date.parse(desde)) / 86400000);
  return Number.isFinite(n) && n >= 0 && n <= teto ? n : null;
}

export interface DetalheAmplimed { nome: string; cpf: string; celular: string | null }
const semAcento = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const nomesIguais = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && semAcento(a) === semAcento(b);
function cpfValido(c: string): boolean {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n: number) => { let soma = 0; for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i); const r = (soma * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}
/**
 * Texto do painel "Visualizar Agendamento" (somente leitura) -> tomador. Devolve null se não achar nome, CPF válido
 * ou se o nome do painel for diferente do nome do compromisso (nunca emitir para a pessoa errada).
 * Exemplo: "... A RECEBER 2 - Paciente Teste Um Data nasc. : 01/01/1990 36a CPF : 100.000.000-19 Endereço : , - Contato : 51993527271 E-mail : ..."
 */
export function lerDetalheAmplimedTexto(texto: string, nomeEsperado: string): DetalheAmplimed | null {
  const t = texto.replace(/\s+/g, ' ');
  const trecho = /(.*?)\sData nasc\./.exec(t)?.[1] ?? '';
  const nome = /(?:^|\s)\d+\s-\s(.+)$/.exec(trecho)?.[1]?.trim();
  const cpf = /CPF\s*:\s*([\d.\-]+)/.exec(t)?.[1]?.replace(/\D/g, '') ?? '';
  const contato = /Contato\s*:\s*(.*?)\s+E-mail\s*:/.exec(t)?.[1]?.replace(/\D/g, '') ?? '';
  if (!nome || !nomesIguais(nome, nomeEsperado) || !cpfValido(cpf)) return null;
  return { nome, cpf, celular: contato.length >= 10 && contato.length <= 11 ? contato : null };
}
