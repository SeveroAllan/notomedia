/**
 * Regras puras de formatação de textos de aviso (para o médico e para o paciente)
 * e cálculos de datas do orquestrador de emissão no WhatsApp. Isolado de I/O
 * para poder ser testado sem repositórios nem clientes de WhatsApp.
 */

import { formatarDataBr } from '../../agenda/filtrar-atendimentos-agenda.js';
import type { CasoEmissaoRegistro, EstadoCasoEmissao } from '../caso-emissao-repositorio.js';
import type { DecisaoProximoPassoEmissao } from '../decidir-proximo-passo-emissao.js';
import { formatarValorReais, mascararCpfParaChat } from '../extrair-cpf-mensagem.js';

export function hojeSp(agora: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
}

export function deslocarDiasIso(iso: string, delta: number): string {
  const ms = Date.parse(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms + delta * 86_400_000).toISOString().slice(0, 10) : iso;
}

export function mapearEstadoDecisao(decisao: DecisaoProximoPassoEmissao): EstadoCasoEmissao {
  switch (decisao.acao) {
    case 'esclarecer_com_medico': return 'aguardando_esclarecimento';
    case 'solicitar_cpf_paciente': return 'aguardando_cpf_paciente';
    case 'solicitar_cpf_medico': return 'aguardando_cpf_medico';
    case 'aguardar_aprovacao_medico': return 'aguardando_aprovacao_medico';
    case 'aguardar_prontidao_fiscal': return 'aguardando_prontidao_fiscal';
    case 'pronto_para_enfileirar': return 'enfileirada';
  }
}

export function montarMensagemPedidoCpfPaciente(pacienteNome?: string | null): string {
  const primeiroNome = pacienteNome?.split(/\s+/)[0] || '';
  const saudacao = primeiroNome ? `Oi ${primeiroNome}, tudo bem?` : 'Oi, tudo bem?';
  return `${saudacao} Para emitir a nota fiscal da sua consulta, você pode me confirmar seu CPF?`;
}

export function montarAvisoEnfileiradaMedico(
  caso: CasoEmissaoRegistro,
  ambiente: 'homologacao' | 'producao'
): string {
  const modo = ambiente === 'homologacao' ? ' (em modo teste/homologação)' : '';
  return `Recebi o comprovante de ${formatarValorReais(caso.valorCentavos)} de ${caso.pacienteNome} e já coloquei a nota na fila${modo}. Assim que sair, te aviso aqui!`;
}

export function montarAvisoMedicoPendente(
  decisao: DecisaoProximoPassoEmissao,
  caso: CasoEmissaoRegistro
): string | null {
  const valor = formatarValorReais(caso.valorCentavos);
  const data = caso.dataConsulta ? formatarDataBr(caso.dataConsulta) : 'data a confirmar';
  if (decisao.acao === 'solicitar_cpf_medico') {
    return `Recebi o comprovante de ${valor} de ${caso.pacienteNome} (${data}), mas não achei o CPF. Você pode me informar o CPF para eu preparar a nota?`;
  }
  if (decisao.acao === 'aguardar_aprovacao_medico') {
    const modo = caso.ambiente === 'homologacao' ? ' em homologação' : '';
    return `Deixei tudo pronto para emitir a nota${modo} de ${caso.pacienteNome} (CPF ${mascararCpfParaChat(caso.pacienteCpf)}, ${valor}, consulta ${data}). Posso emitir?`;
  }
  if (decisao.acao === 'aguardar_prontidao_fiscal') {
    return `Deixei a nota de ${caso.pacienteNome} (${valor}, ${data}) pronta aqui, mas ainda falta seu Certificado A1/dados fiscais para transmitir. Quer que eu mande o link seguro agora?`;
  }
  return null;
}

export function montarResumoEntregaNotaMedico(
  caso: CasoEmissaoRegistro,
  opcoes?: { contingenciaHomologacao?: boolean }
): { avisoHomolog: string; resumoMedico: string } {
  const dataFmt = caso.dataConsulta ? formatarDataBr(caso.dataConsulta) : '';
  if (opcoes?.contingenciaHomologacao && caso.ambiente === 'homologacao') {
    const avisoHomolog = ' (homologação offline — sem valor fiscal)';
    const resumoMedico = `Nota de ${caso.pacienteNome} (${formatarValorReais(caso.valorCentavos)}, consulta ${dataFmt}) gerada em contingência de homologação com sua DPS assinada pelo A1 — SEFIN homologação indisponível (sem valor fiscal).`;
    return { avisoHomolog, resumoMedico };
  }
  const avisoHomolog = caso.ambiente === 'homologacao' ? ' (ambiente de teste/homologação)' : '';
  const resumoMedico = `Nota fiscal emitida${avisoHomolog} para ${caso.pacienteNome} (${formatarValorReais(caso.valorCentavos)}, consulta ${dataFmt}).`;
  return { avisoHomolog, resumoMedico };
}
