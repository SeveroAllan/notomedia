/** Seleção vem da fala atual, nunca de um nome aproximado ou do primeiro atendimento. */
export interface SelecaoConsultas { dia?: string; horario?: string; ordem?: 'mais_recente'|'mais_antigo'; desde?: string; ate?: string; paciente?: { nome: string; evidencia: string } }
const normalizar = (nome: string) => nome.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/^paciente\s+/,'').replace(/\s+/g,' ').trim();
export function selecionarDias<T extends {data:string;elegiveis:{paciente:string;dataHora?:string}[]}>(dias: T[], selecao: SelecaoConsultas): T[] {
  const filtrados=dias.filter(d=>(!selecao.dia||d.data===selecao.dia)&&(!selecao.desde||d.data>=selecao.desde)&&(!selecao.ate||d.data<=selecao.ate)).map(d=>({...d,elegiveis:d.elegiveis.filter(e=>(!selecao.paciente||normalizar(e.paciente)===normalizar(selecao.paciente.nome))&&(!selecao.horario||horarioConsulta(e.dataHora)===selecao.horario))}));
  if(!selecao.ordem)return filtrados;
  if(!selecao.paciente)throw Error('PACIENTE_NECESSARIO');
  const consultas=filtrados.flatMap(d=>d.elegiveis);
  if(!consultas.length)return filtrados;
  const tempos=consultas.map(e=>e.dataHora?Date.parse(e.dataHora):NaN);
  if(tempos.some(t=>!Number.isFinite(t)))throw Error('HORARIO_NAO_IDENTIFICADO');
  const alvo=selecao.ordem==='mais_recente'?Math.max(...tempos):Math.min(...tempos);
  const indices=tempos.flatMap((t,i)=>t===alvo?[i]:[]);
  if(indices.length!==1)throw Error('CONSULTA_AMBIGUA');
  const escolhida=consultas[indices[0]];
  return filtrados.map(d=>({...d,elegiveis:d.elegiveis.filter(e=>e===escolhida)}));
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
  const ordem=ordemConsulta(texto);
  const horarios=[...texto.matchAll(/\b(\d{1,2})(?:h(?:(\d{2}))?|:(\d{2}))\b/gi)].map(m=>`${m[1].padStart(2,'0')}:${m[2]??m[3]??'00'}`);
  if(horarios.some(h=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(h))||new Set(horarios).size>1)throw Error('HORARIO_AMBIGUO');
  const horario=horarios[0];
  if(paciente&&(!texto.includes(paciente.evidencia)||!paciente.evidencia.includes(paciente.nome)))throw Error('PACIENTE_SEM_EVIDENCIA');
  if(literal&&paciente&&normalizar(literal.nome)!==normalizar(paciente.nome))throw Error('PACIENTE_DIVERGENTE');
  if(ordem&&!literal&&!paciente)throw Error('PACIENTE_NECESSARIO');
  return {...(ordem?{ordem}:{}),...(dia?{dia}:{}),...(horario?{horario}:{}),...((literal??paciente)?{paciente:literal??paciente}:{})};
}

/** Repetir o mesmo paciente na confirmação não troca o escopo já verificado. */
export function mesmoPacienteSelecionado(a:SelecaoConsultas['paciente'],b:SelecaoConsultas['paciente']):boolean {
 return !!a&&!!b&&normalizar(a.nome)===normalizar(b.nome);
}

export function confirmaSelecaoAnterior(atual:SelecaoConsultas,anterior:SelecaoConsultas|undefined):boolean {
 return mesmoPacienteSelecionado(atual.paciente,anterior?.paciente)&&(!atual.dia||atual.dia===anterior?.dia)&&(!atual.horario||atual.horario===anterior?.horario)&&(!atual.ordem||atual.ordem===anterior?.ordem);
}

/** Horário no fuso do médico, nunca no fuso do servidor. */
export function horarioConsulta(dataHora:string|undefined):string|undefined {
 if(!dataHora||Number.isNaN(Date.parse(dataHora)))return undefined;
 return new Date(dataHora).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
}

/** Ordem literal fica dentro do paciente e recorte já identificados, nunca do conjunto inteiro. */
export function ordemConsulta(texto:string):SelecaoConsultas['ordem'] {
 const t=texto.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const recente=/\bmais recente\b|\bultim[oa]\b(?!\s+(?:mes|ano|semana|lote|proposta)\b)/.test(t),antigo=/\bmais antig[oa]\b|\b(?:o primeiro|a primeira|primeir[oa] (?:consulta|atendimento))\b/.test(t);
 if(recente&&antigo)throw Error('ORDEM_AMBIGUA');
 return recente?'mais_recente':antigo?'mais_antigo':undefined;
}
