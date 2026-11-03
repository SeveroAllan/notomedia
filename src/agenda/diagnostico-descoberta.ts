import type { ResultadoLeituraTribemd } from '../desenvolvedor/tribemd-navegador.js';
import { profissionaisIdentificados } from './profissionais-agenda.js';
import { nomeProfissionalValido } from '../conta/validar-dados-emissao.js';

export type CausaLeitura =
  | 'SEM_RESULTADO' | 'COBERTURA_PARCIAL' | 'AGENDA_LIMITADA'
  | 'DETALHES_NAO_DISPONIVEIS' | 'DETALHES_PENDENTES'
  | 'SEM_CONSULTAS_NO_RECORTE' | 'SEM_IDENTIFICACAO_PROFISSIONAL'
  | 'NOMES_NAO_VALIDOS';

export interface DiagnosticoDescoberta {
  cobertura: 'ausente'|'somente_linhas_visiveis'|'intervalo_carregado_pelo_portal';
  agendaLimitada: boolean|null;
  detalhesDisponiveis: boolean;
  consultasLidas: number;
  consultasComProfissional: number;
  nomesExtraidos: number;
  nomesValidados: number;
  nomesFiltrados: number;
  detalhesPendentes: number|null;
  leituraConfiavelParaDescoberta: boolean;
  causas: CausaLeitura[];
}

/** Somente enums e contagens agregadas. NUNCA retornar consultas, nomes,
 * IDs, CPF, token, texto clínico ou credenciais para logs/diagnósticos.
 */
export function diagnosticarDescobertaTribemd(resultado: ResultadoLeituraTribemd|null|undefined):
  { diagnostico: DiagnosticoDescoberta; nomesComprovados: string[] } {
  const nomes=profissionaisIdentificados(resultado?.consultas ?? []);
  const validos=nomes.filter(nomeProfissionalValido);
  const causas:CausaLeitura[]=[];
  if(!resultado) causas.push('SEM_RESULTADO');
  else {
    if(resultado.cobertura!=='intervalo_carregado_pelo_portal' || !resultado.agenda)
      causas.push('COBERTURA_PARCIAL');
    if(resultado.agenda?.limitado) causas.push('AGENDA_LIMITADA');
    if(!resultado.detalhes) causas.push('DETALHES_NAO_DISPONIVEIS');
    else if(resultado.detalhes.pendentes>0) causas.push('DETALHES_PENDENTES');
    if(resultado.consultas.length===0) causas.push('SEM_CONSULTAS_NO_RECORTE');
    else if(nomes.length===0) causas.push('SEM_IDENTIFICACAO_PROFISSIONAL');
    else if(validos.length===0) causas.push('NOMES_NAO_VALIDOS');
  }
  const completa=!!resultado && resultado.cobertura==='intervalo_carregado_pelo_portal' &&
    !!resultado.agenda && !resultado.agenda.limitado &&
    !!resultado.detalhes && resultado.detalhes.pendentes===0;
  const diagnostico:DiagnosticoDescoberta={
    cobertura:resultado?.cobertura??'ausente',
    agendaLimitada:resultado?.agenda ? !!resultado.agenda.limitado : null,
    detalhesDisponiveis:!!resultado?.detalhes,
    consultasLidas:resultado?.consultas.length??0,
    consultasComProfissional:resultado?.consultas.filter(c=>!!c.profissional?.trim()).length??0,
    nomesExtraidos:nomes.length,
    nomesValidados:validos.length,
    nomesFiltrados:nomes.length-validos.length,
    detalhesPendentes:resultado?.detalhes?.pendentes??null,
    leituraConfiavelParaDescoberta:completa,
    causas
  };
  return {diagnostico,nomesComprovados:completa?validos.slice(0,20):[]};
}

/** Mensagem sobre o estágio comprovado, não atribuição de causa técnica. */
export function explicarLeituraPendente(diag:DiagnosticoDescoberta|null|undefined):string {
  if(!diag) return 'A conexão foi confirmada, mas ainda não tenho uma leitura de agenda verificável para identificar os médicos.';
  if(diag.causas.includes('COBERTURA_PARCIAL'))
    return 'A leitura inicial cobriu apenas parte da agenda. Ainda não posso identificar os médicos com segurança.';
  if(diag.causas.includes('AGENDA_LIMITADA'))
    return 'O portal limitou o recorte consultado. Não vou assumir que a agenda esteja vazia.';
  if(diag.causas.includes('DETALHES_PENDENTES'))
    return 'Alguns detalhes das consultas não terminaram de carregar. A identificação dos médicos ainda está pendente.';
  if(diag.causas.includes('DETALHES_NAO_DISPONIVEIS'))
    return 'Ainda não recebi os detalhes necessários para conferir os médicos nessa leitura.';
  if(diag.consultasLidas===0)
    return 'Neste recorte não encontrei consultas verificáveis. Isso não significa que não existam médicos na agenda.';
  if(diag.nomesExtraidos===0)
    return 'As consultas lidas não trouxeram a identificação profissional necessária para vincular médicos.';
  if(diag.nomesValidados===0)
    return 'Os identificadores de profissionais encontrados não passaram na validação de nomes. Não vou adivinhar.';
  return 'Os nomes lidos ainda não passaram por todos os critérios de confirmação.';
}
