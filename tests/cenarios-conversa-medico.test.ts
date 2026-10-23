import {describe,expect,it} from 'vitest';
import {validarAcaoConversa,type FatosConversa,type DecisaoConversa} from '../src/onboarding/conversador-medico.js';
// Bateria do passo 5: o que a camada determinística assina, independente do que o modelo diga.
const agora=new Date('2026-10-21T15:00Z');
const base=():FatosConversa=>({ambiente:'homologacao',agenda:{nome:'TribeMD',conectada:true},link:{ativo:false,enviados:0},periodo:{desde:'2026-10-05',origem:'contexto_salvo'},semAgendaDigital:false});
const tudo=['nenhuma','pedir_link_agenda','listar_pendencias','iniciar_lote','registrar_modo_sem_agenda'];
const dec=(acao:string|null,extra:Partial<DecisaoConversa>={}):DecisaoConversa=>({fala:['Vou fazer isso agora.'],acao,...extra} as DecisaoConversa);
type C={nome:string;fatos?:(f:FatosConversa)=>void;d:DecisaoConversa;texto?:string;perm?:string[];esperado:string|null};
const casos:C[]=[
 {nome:'conversa sem ação passa',d:dec(null),esperado:null},
 {nome:'ação inventada é recusada',d:dec('apagar_tudo'),esperado:'ACAO_INVALIDA'},
 {nome:'produção nunca executa ferramenta',fatos:f=>{f.ambiente='producao' as never;},d:dec('iniciar_lote'),esperado:'ACAO_NAO_PERMITIDA'},
 {nome:'ação fora das permitidas é recusada',d:dec('iniciar_lote'),perm:['nenhuma'],esperado:'ACAO_NAO_PERMITIDA'},
 {nome:'ação sem anúncio volta ao decisor',d:dec('iniciar_lote',{fala:[]}),esperado:'anuncie a acao com suas palavras'},
 {nome:'lote com agenda conectada e período passa',d:dec('iniciar_lote'),esperado:null},
 {nome:'lote sem agenda conectada é recusado',fatos:f=>{f.agenda.conectada=false;},d:dec('iniciar_lote'),esperado:'AGENDA_NAO_CONECTADA'},
 {nome:'lote com agenda não suportada é recusado',fatos:f=>{f.agenda.nome='Outra';},d:dec('iniciar_lote'),esperado:'AGENDA_NAO_CONECTADA'},
 {nome:'lote em modo sem agenda digital é recusado',fatos:f=>{f.semAgendaDigital=true;},d:dec('iniciar_lote'),esperado:'AGENDA_NAO_CONECTADA'},
 {nome:'lote sem período conhecido pede o período',fatos:f=>{f.periodo={desde:null,origem:null};},d:dec('iniciar_lote'),esperado:'PERIODO_NECESSARIO'},
 {nome:'período absurdo no futuro é recusado',d:dec('iniciar_lote',{parametros:{desde:'2030-01-01'}}),esperado:'PERIODO_INVALIDO'},
 {nome:'Amplimed conectado: listar pendências passa (observação)',fatos:f=>{f.agenda.nome='Amplimed';},d:dec('listar_pendencias'),esperado:null},
 {nome:'Amplimed conectado: lote passa (emissão em homologação, com confirmação do médico)',fatos:f=>{f.agenda.nome='Amplimed';},d:dec('iniciar_lote'),esperado:null},
 {nome:'listar pendências sem agenda é recusado',fatos:f=>{f.agenda.conectada=false;},d:dec('listar_pendencias'),esperado:'AGENDA_NAO_CONECTADA'},
 {nome:'lista repetida sem pedido explícito é recusada',fatos:f=>{f.listaRecente=true;},d:dec('listar_pendencias'),esperado:'LISTA_JA_ENVIADA'},
 {nome:'lista repetida com evidência fraca é recusada',fatos:f=>{f.listaRecente=true;},texto:'ta bom',d:dec('listar_pendencias',{parametros:{pedidoExplicito:{evidencia:'ta bom',confianca:.5}}}),esperado:'LISTA_JA_ENVIADA'},
 {nome:'lista repetida com pedido explícito citado passa',fatos:f=>{f.listaRecente=true;},texto:'manda a lista de novo',d:dec('listar_pendencias',{parametros:{pedidoExplicito:{evidencia:'manda a lista de novo',confianca:.95}}}),esperado:null},
 {nome:'evidência que não está no texto não vale',fatos:f=>{f.listaRecente=true;},texto:'ok',d:dec('listar_pendencias',{parametros:{pedidoExplicito:{evidencia:'manda a lista de novo',confianca:.99}}}),esperado:'LISTA_JA_ENVIADA'},
 {nome:'link com agenda já conectada não é criado',d:dec('pedir_link_agenda',{parametros:{agenda:'TribeMD'}}),esperado:'CONEXAO_NAO_NECESSARIA'},
 {nome:'link com link ativo não cria outro',fatos:f=>{f.agenda.conectada=false;f.link={ativo:true,enviados:1};},d:dec('pedir_link_agenda',{parametros:{agenda:'TribeMD'}}),esperado:'CONEXAO_NAO_NECESSARIA'},
 {nome:'link para agenda não suportada é recusado',fatos:f=>{f.agenda.conectada=false;f.agenda.nome=null;},texto:'uso a Agenda X',d:dec('pedir_link_agenda',{parametros:{agenda:'Agenda X',evidencia:'Agenda X'}}),esperado:'AGENDA_NAO_SUPORTADA'},
 {nome:'link sem a agenda ter sido dita pelo médico é recusado',fatos:f=>{f.agenda.conectada=false;f.agenda.nome=null;},texto:'oi',d:dec('pedir_link_agenda',{parametros:{agenda:'Tribe',evidencia:'Tribe'}}),esperado:'AGENDA_NAO_INFORMADA'},
 {nome:'link com mais de dois balões é recusado',fatos:f=>{f.agenda.conectada=false;},d:dec('pedir_link_agenda',{fala:['a','b','c'],parametros:{agenda:'TribeMD'}}),esperado:'BALOES_LINK_EXCEDIDOS'},
 {nome:'declaração de papel com evidência citada passa',fatos:f=>{f.agenda.conectada=false;f.agenda.nome=null;},texto:'Eu uso papel',d:dec('registrar_modo_sem_agenda',{parametros:{evidencia:'uso papel',confianca:1}}),esperado:null},
 {nome:'declaração de papel com baixa confiança é recusada',fatos:f=>{f.agenda.conectada=false;},texto:'acho que uso papel',d:dec('registrar_modo_sem_agenda',{parametros:{evidencia:'uso papel',confianca:.6}}),esperado:'DECLARACAO_NAO_CONFIRMADA'},
 {nome:'declaração sem evidência no texto é recusada',fatos:f=>{f.agenda.conectada=false;},texto:'oi',d:dec('registrar_modo_sem_agenda',{parametros:{evidencia:'uso papel',confianca:1}}),esperado:'DECLARACAO_NAO_CONFIRMADA'},
 {nome:'declaração de papel com agenda conectada é recusada',texto:'uso papel',d:dec('registrar_modo_sem_agenda',{parametros:{evidencia:'uso papel',confianca:1}}),esperado:'DECLARACAO_NAO_CONFIRMADA'},
 {nome:'evidência que não fala de papel/agenda é recusada',fatos:f=>{f.agenda.conectada=false;},texto:'gosto de café',d:dec('registrar_modo_sem_agenda',{parametros:{evidencia:'gosto de café',confianca:1}}),esperado:'DECLARACAO_NAO_CONFIRMADA'},
];
describe('cenários da camada determinística (passo 5)',()=>{
 it.each(casos)('$nome',c=>{
  const f=base(); c.fatos?.(f);
  expect(validarAcaoConversa(c.d,f,c.perm??tudo,c.texto??'Pode',agora)).toBe(c.esperado);
 });
});
