/** Valores lidos na agenda, não evidência de recebimento nem de nota fiscal. */
export type ConsultaValorAgenda = {status: string; valorCentavos?: number | null};
export function resumirValoresAgenda(consultas: readonly ConsultaValorAgenda[]) {
  const resumir = (itens: readonly ConsultaValorAgenda[]) => {
    const conhecidos = itens.filter(c => Number.isSafeInteger(c.valorCentavos) && c.valorCentavos! >= 0);
    const subtotalCentavos = conhecidos.reduce((s,c) => s + c.valorCentavos!, 0);
    const somaValida = Number.isSafeInteger(subtotalCentavos);
    const semValor = itens.length - conhecidos.length;
    return {consultas:itens.length, comValor:conhecidos.length, semValor,
      subtotalCentavos:somaValida ? subtotalCentavos : null,
      totalCentavos:semValor === 0 && somaValida ? subtotalCentavos : null};
  };
  return {fonte:'agenda' as const, moeda:'BRL' as const,
    todos:resumir(consultas), realizadas:resumir(consultas.filter(c=>c.status==='realizada')),
    canceladas:resumir(consultas.filter(c=>c.status==='cancelada')),
    agendadas:resumir(consultas.filter(c=>c.status==='agendada')),
    faltas:resumir(consultas.filter(c=>c.status==='faltou')),
    recebido:{disponivel:false as const}, notasFiscais:{disponivel:false as const}};
}

/** Contrato único usado pelo handler e pelo replanejamento. */
export function resultadoConsultaAgenda(entrada:{consultas:readonly ConsultaValorAgenda[];desde:string;ate:string;medida?:string;fala:string[]}) {
  const dados={ferramenta:'consultar_agenda',ok:true,total:entrada.consultas.length,
    desde:entrada.desde,ate:entrada.ate,medida:entrada.medida??'lista',valoresAgenda:resumirValoresAgenda(entrada.consultas)};
  const respostaEstruturada=entrada.medida==='quantidade'||entrada.medida?.startsWith('valor_');
  return {dados,...(respostaEstruturada?{}:{falaAssinada:entrada.fala,falaMemoria:entrada.fala})};
}
