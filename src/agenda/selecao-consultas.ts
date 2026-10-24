/** Seleção vem da fala atual, nunca de um nome aproximado ou do primeiro atendimento. */
export interface SelecaoConsultas { dia?: string; desde?: string; ate?: string; paciente?: { nome: string; evidencia: string } }
const normalizar = (nome: string) => nome.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/^paciente\s+/,'').replace(/\s+/g,' ').trim();
export function selecionarDias<T extends {data:string;elegiveis:{paciente:string}[]}>(dias: T[], selecao: SelecaoConsultas): T[] {
  return dias.filter(d=>(!selecao.dia||d.data===selecao.dia)&&(!selecao.desde||d.data>=selecao.desde)&&(!selecao.ate||d.data<=selecao.ate)).map(d=>({...d,elegiveis:d.elegiveis.filter(e=>!selecao.paciente||normalizar(e.paciente)===normalizar(selecao.paciente.nome))}));
}
/** Extração limitada a um nome literal em pedido de consulta, sem resolver identidade por semelhança. */
export function pacienteLiteralDaConsulta(texto:string): {nome:string;evidencia:string}|undefined {
  const m=/\bconsulta\s+d[oa]\s+(.+?)(?=\s+(?:(?:de|do dia|em)\s+\d|(?:de\s+)?(?:hoje|ontem|anteontem|amanh[ãa])\b)|[.?!]|$)/i.exec(texto);
  const nome=m?.[1]?.trim();
  if(!nome||/^(?:dia|ontem|hoje|semana|m[eê]s)\b/i.test(nome)||/^\d/.test(nome))return undefined;
  return {nome,evidencia:nome};
}
export function selecaoConsultas(texto:string,dia?:string|null,paciente?:{nome:string;evidencia:string}):SelecaoConsultas {
  const literal=pacienteLiteralDaConsulta(texto);
  if(paciente&&(!texto.includes(paciente.evidencia)||!paciente.evidencia.includes(paciente.nome)))throw Error('PACIENTE_SEM_EVIDENCIA');
  if(literal&&paciente&&normalizar(literal.nome)!==normalizar(paciente.nome))throw Error('PACIENTE_DIVERGENTE');
  return {...(dia?{dia}:{}),...((literal??paciente)?{paciente:literal??paciente}:{})};
}

/** Repetir o mesmo paciente na confirmação não troca o escopo já verificado. */
export function mesmoPacienteSelecionado(a:SelecaoConsultas['paciente'],b:SelecaoConsultas['paciente']):boolean {
 return !!a&&!!b&&normalizar(a.nome)===normalizar(b.nome);
}

export function confirmaSelecaoAnterior(atual:SelecaoConsultas,anterior:SelecaoConsultas|undefined):boolean {
 return mesmoPacienteSelecionado(atual.paciente,anterior?.paciente)&&(!atual.dia||atual.dia===anterior?.dia);
}
