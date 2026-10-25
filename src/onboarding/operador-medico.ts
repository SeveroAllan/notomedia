export interface MedicoOperavel {
  id: string;
  nomeCompleto: string;
  crm: string | null;
}

const normalizar=(texto:string)=>texto.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

export function resolverMedicoMencionado(texto:string,medicos:readonly MedicoOperavel[]):MedicoOperavel|null {
  const t=` ${normalizar(texto)} `;
  const exatos=medicos.filter(m=>{
    const nome=normalizar(m.nomeCompleto);
    const crm=normalizar(m.crm??'');
    return !!nome&&t.includes(` ${nome} `) || !!crm&&t.includes(` ${crm} `);
  });
  if(exatos.length===1)return exatos[0]!;
  if(exatos.length>1)return null;
  const primeiros=medicos.filter(m=>{
    const primeiro=normalizar(m.nomeCompleto).split(' ')[0]??'';
    return primeiro.length>=3&&new RegExp(`\\b(?:dr|dra|doutor|doutora)?\\s*${primeiro}\\b`,'i').test(normalizar(texto));
  });
  return primeiros.length===1?primeiros[0]!:null;
}

export function mensagemPedeTrocaDeMedico(texto:string):boolean {
  return /\b(?:dr|dra|doutor|doutora|m[eé]dico|m[eé]dica)\b/i.test(texto) ||
    /\b(?:trocar|mudar)\b.*\b(?:m[eé]dico|m[eé]dica)\b/i.test(texto);
}

export function perguntaSelecaoMedico(medicos:readonly MedicoOperavel[]):string {
  const nomes=medicos.slice(0,6).map(m=>m.crm?`${m.nomeCompleto} (${m.crm})`:m.nomeCompleto);
  const lista=nomes.join(', ');
  return `Qual médico você quer atender agora? Tenho acesso a: ${lista}. Depois que você escolher, mantenho esse médico em foco até você trocar.`;
}
