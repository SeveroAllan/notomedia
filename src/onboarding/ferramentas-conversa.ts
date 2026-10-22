import type {FatosConversa} from './conversador-medico.js';
// Catálogo único das ferramentas que o decisor da conversa pode pedir.
// O modelo escolhe; esta camada diz o que está liberado agora e o que exige confirmação do médico.
export type NomeFerramenta='nenhuma'|'registrar_modo_sem_agenda'|'pedir_link_agenda'|'listar_pendencias'|'iniciar_lote';
export interface DescricaoFerramenta {
  nome:NomeFerramenta;
  tipo:'sem_efeito'|'leitura'|'escrita';
  // Escrita fiscal só acontece depois de proposta confirmada pelo médico (uma vez, vinculada à pergunta).
  exigeConfirmacaoDoMedico:boolean;
  descricao:string;
  liberada:(fatos:FatosConversa,disponibilidade:{lote:boolean})=>boolean;
}
const tarefaOcupada=(f:FatosConversa)=>['aguardando_confirmacao_lote','confirmado','processando'].includes(f.lote?.estado??'');
export const CATALOGO_FERRAMENTAS:readonly DescricaoFerramenta[]=[
  {nome:'nenhuma',tipo:'sem_efeito',exigeConfirmacaoDoMedico:false,descricao:'Só conversar, explicar ou responder à confirmação pendente.',liberada:()=>true},
  {nome:'registrar_modo_sem_agenda',tipo:'escrita',exigeConfirmacaoDoMedico:false,descricao:'Registrar que o médico declarou não usar agenda digital.',
    liberada:f=>!f.agenda.conectada},
  {nome:'pedir_link_agenda',tipo:'escrita',exigeConfirmacaoDoMedico:false,descricao:'Enviar o link seguro para conectar a agenda; nunca recebe senha pelo chat.',
    liberada:f=>!f.agenda.conectada&&!f.link.ativo&&!f.semAgendaDigital},
  {nome:'listar_pendencias',tipo:'leitura',exigeConfirmacaoDoMedico:false,descricao:'Ler da agenda as consultas sem nota no período.',
    liberada:f=>f.agenda.conectada&&!f.semAgendaDigital},
  {nome:'iniciar_lote',tipo:'escrita',exigeConfirmacaoDoMedico:true,descricao:'Preparar o lote de notas; só emite depois do "pode" sobre a proposta.',
    liberada:(f,d)=>d.lote&&f.agenda.conectada&&f.agenda.nome?.toLowerCase()==='tribemd'&&!f.semAgendaDigital},
];
export function ferramentasLiberadas(fatos:FatosConversa,disponibilidade:{lote:boolean}):readonly NomeFerramenta[] {
  if(fatos.ambiente!=='homologacao') return [];
  if(tarefaOcupada(fatos)) return ['nenhuma'];
  return CATALOGO_FERRAMENTAS.filter(t=>t.liberada(fatos,disponibilidade)).map(t=>t.nome);
}
