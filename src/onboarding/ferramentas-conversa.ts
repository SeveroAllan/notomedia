import type {FatosConversa} from './conversador-medico.js';
// Catálogo único das ferramentas que o decisor da conversa pode pedir.
// O modelo escolhe; esta camada diz o que está liberado agora e o que exige confirmação do médico.
export type NomeFerramenta='nenhuma'|'registrar_modo_sem_agenda'|'pedir_link_agenda'|'pedir_link_certificado'|'descobrir_medicos_agenda'|'associar_medico_agenda'|'consultar_agenda'|'listar_pendencias'|'iniciar_lote'|'pedir_link_permissoes'|'reenviar_nota_medico';
export interface DescricaoFerramenta {
  nome:NomeFerramenta;
  tipo:'sem_efeito'|'leitura'|'escrita';
  // Escrita fiscal só acontece depois de proposta confirmada pelo médico (uma vez, vinculada à pergunta).
  exigeConfirmacaoDoMedico:boolean;
  descricao:string;
  liberada:(fatos:FatosConversa,disponibilidade:{lote:boolean})=>boolean;
}
const tarefaOcupada=(f:FatosConversa)=>['aguardando_confirmacao_lote','confirmado','processando'].includes(f.lote?.estado??'');
const podeConectarOutraAgenda=(f:FatosConversa)=>{
  if(f.semAgendaDigital)return false;
  if(!f.agendas)return !f.agenda.conectada&&!f.link.ativo;
  return !f.agendas.tribemd.conectada||!f.agendas.amplimed.conectada;
};
export const CATALOGO_FERRAMENTAS:readonly DescricaoFerramenta[]=[
  {nome:'nenhuma',tipo:'sem_efeito',exigeConfirmacaoDoMedico:false,descricao:'Só conversar, explicar ou responder à confirmação pendente.',liberada:()=>true},
  {nome:'registrar_modo_sem_agenda',tipo:'escrita',exigeConfirmacaoDoMedico:false,descricao:'Registrar que o médico declarou não usar agenda digital.',
    liberada:f=>!f.agenda.conectada&&!f.semAgendaDigital},
  {nome:'pedir_link_agenda',tipo:'escrita',exigeConfirmacaoDoMedico:false,descricao:'Enviar o link seguro para conectar uma agenda suportada que ainda não esteja conectada; nunca recebe senha pelo chat.',
    liberada:podeConectarOutraAgenda},
  {nome:'pedir_link_certificado',tipo:'escrita',exigeConfirmacaoDoMedico:false,descricao:'Iniciar ou retomar a configuração de médico explicitamente nomeado, criando no máximo um registro pendente e enviando o link autenticado do A1 somente quando necessário.',
    liberada:f=>(f.medicosConta??[]).length>0},
  {nome:'descobrir_medicos_agenda',tipo:'leitura',exigeConfirmacaoDoMedico:false,descricao:'Atalho opcional: descobrir somente nomes de profissionais observados por consulta na TribeMD, sem expor pacientes e sem afirmar catálogo completo.',
    liberada:f=>(f.agendas?.tribemd.conectada??(f.agenda.conectada&&f.agenda.nome?.toLowerCase()==='tribemd'))&&!f.semAgendaDigital},
  {nome:'associar_medico_agenda',tipo:'escrita',exigeConfirmacaoDoMedico:false,descricao:'Associar um médico já criado/validado a uma agenda da mesma conta explicitamente informada e verificar se a leitura identifica esse profissional; nunca atribui consultas sem identificação compatível.',
    liberada:f=>(f.medicosConta??[]).some(m=>m.certificado==='ok')&&!!(f.agendas?.tribemd.conectada||f.agendas?.amplimed.conectada||f.agenda.conectada)&&!f.semAgendaDigital},
  {nome:'consultar_agenda',tipo:'leitura',exigeConfirmacaoDoMedico:false,descricao:'Consultar as consultas da agenda no período, independentemente de situação fiscal.',
    liberada:f=>f.agenda.conectada&&!f.semAgendaDigital},
  {nome:'listar_pendencias',tipo:'leitura',exigeConfirmacaoDoMedico:false,descricao:'Ler da agenda as consultas sem nota no período.',
    liberada:f=>f.agenda.conectada&&!f.semAgendaDigital},
  {nome:'pedir_link_permissoes',tipo:'escrita',exigeConfirmacaoDoMedico:false,descricao:'Enviar o link seguro para o médico escolher permissões com botões (emissão autônoma; entrega ao paciente; a quem pedir CPF ausente).',
    liberada:f=>!!f.permissoes&&((f.permissoes.faltantes?.length??0)>0||f.permissoes.pendentes===true)},
  {nome:'reenviar_nota_medico',tipo:'escrita',exigeConfirmacaoDoMedico:false,descricao:'Entregar ao médico uma única nota já autorizada pedida explicitamente. Nunca emite outra nota.',
    liberada:f=>f.permissoes?.entregarPaciente==='so_medico'},
  {nome:'iniciar_lote',tipo:'escrita',exigeConfirmacaoDoMedico:true,descricao:'Preparar o lote de notas; só emite depois do "pode" sobre a proposta.',
    liberada:(f,d)=>d.lote&&f.agenda.conectada&&['tribemd','amplimed'].includes(f.agenda.nome?.toLowerCase()??'')&&!f.semAgendaDigital},
];
export function ferramentasLiberadas(fatos:FatosConversa,disponibilidade:{lote:boolean}):readonly NomeFerramenta[] {
  if(fatos.ambiente!=='homologacao') return [];
  if(tarefaOcupada(fatos)) {
    // Proposta ainda sem resposta pode ser substituída por um pedido explícito de outro dia/período
    // (o iniciar abandona a pendente); emissão confirmada/em andamento não admite ação nova.
    if(fatos.lote?.estado!=='aguardando_confirmacao_lote') return ['nenhuma'];
    const iniciar=CATALOGO_FERRAMENTAS.find(t=>t.nome==='iniciar_lote')!;
    return iniciar.liberada(fatos,disponibilidade)?['nenhuma','iniciar_lote']:['nenhuma'];
  }
  return CATALOGO_FERRAMENTAS.filter(t=>t.liberada(fatos,disponibilidade)).map(t=>t.nome);
}
