import {describe,expect,it} from 'vitest';
import {CATALOGO_FERRAMENTAS,ferramentasLiberadas} from '../src/onboarding/ferramentas-conversa.js';
import type {FatosConversa} from '../src/onboarding/conversador-medico.js';
// Regra anterior (inline no server.ts), mantida aqui como referência de equivalência.
const anterior=(fatos:FatosConversa,retroativo:boolean)=>fatos.ambiente!=='homologacao'?[]:['aguardando_confirmacao_lote','confirmado','processando'].includes(fatos.lote?.estado??'')?['nenhuma']:
  ['nenhuma',...(!fatos.agenda.conectada&&!fatos.semAgendaDigital?['registrar_modo_sem_agenda']:[]),
   ...(!fatos.agenda.conectada&&!fatos.link.ativo&&!fatos.semAgendaDigital?['pedir_link_agenda']:[]),
   ...(fatos.agenda.conectada&&!fatos.semAgendaDigital?[...(fatos.agenda.nome?.toLowerCase()==='tribemd'?['descobrir_medicos_agenda']:[]),'consultar_agenda','listar_pendencias',...(retroativo?['iniciar_lote']:[])]:[])];
describe('catálogo de ferramentas da conversa',()=>{
 it('preserva as liberações anteriores e adiciona descoberta segura da TribeMD quando conectada',()=>{
  const amb=['homologacao','producao',null],conectada=[true,false],link=[true,false],sem=[true,false],lote=[undefined,'confirmado','processando','concluido'],retro=[true,false];
  let n=0;
  for(const a of amb)for(const c of conectada)for(const l of link)for(const s of sem)for(const e of lote)for(const r of retro){
   const f={ambiente:a,agenda:{nome:'TribeMD',conectada:c},link:{ativo:l,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:s,lote:e?{estado:e}:null} as unknown as FatosConversa;
   expect(ferramentasLiberadas(f,{lote:r})).toEqual(anterior(f,r)); n++;
  }
  expect(n).toBe(3*2*2*2*4*2);
 });
 it('proposta pendente admite iniciar_lote para troca de escopo; emissão em andamento, não',()=>{
  const base={ambiente:'homologacao',agenda:{nome:'TribeMD',conectada:true},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false} as unknown as FatosConversa;
  expect(ferramentasLiberadas({...base,lote:{estado:'aguardando_confirmacao_lote'}},{lote:true})).toEqual(['nenhuma','iniciar_lote']);
  expect(ferramentasLiberadas({...base,lote:{estado:'aguardando_confirmacao_lote'}},{lote:false})).toEqual(['nenhuma']);
  expect(ferramentasLiberadas({...base,agenda:{nome:'TribeMD',conectada:false},lote:{estado:'aguardando_confirmacao_lote'}},{lote:true})).toEqual(['nenhuma']);
  expect(ferramentasLiberadas({...base,lote:{estado:'confirmado'}},{lote:true})).toEqual(['nenhuma']);
  expect(ferramentasLiberadas({...base,lote:{estado:'processando'}},{lote:true})).toEqual(['nenhuma']);
 });
 it('toda ferramenta que escreve algo fiscal declara que exige confirmação do médico',()=>{
  expect(CATALOGO_FERRAMENTAS.find(t=>t.nome==='iniciar_lote')?.exigeConfirmacaoDoMedico).toBe(true);
  expect(new Set(CATALOGO_FERRAMENTAS.map(t=>t.nome)).size).toBe(CATALOGO_FERRAMENTAS.length);
 });
});
it('link de permissões só aparece quando o módulo existe e há escolha realmente faltante',()=>{
 const base={ambiente:'homologacao',agenda:{nome:'Amplimed',conectada:true},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false} as FatosConversa;
 expect(ferramentasLiberadas(base,{lote:true})).not.toContain('pedir_link_permissoes');
 expect(ferramentasLiberadas({...base,permissoes:{emitirAutonomo:'sempre_perguntar',entregarPaciente:null,pendentes:true,faltantes:['entregar_paciente']}},{lote:true})).toContain('pedir_link_permissoes');
 expect(ferramentasLiberadas({...base,permissoes:{emitirAutonomo:'sempre_perguntar',entregarPaciente:'paciente',pendentes:false,faltantes:[]}},{lote:true})).not.toContain('pedir_link_permissoes');
});

it('modo manual persistido não volta a oferecer registro nem conexão de agenda',()=>{
 const f={ambiente:'homologacao',agenda:{nome:null,conectada:false},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:true} as FatosConversa;
 const liberadas=ferramentasLiberadas(f,{lote:true});
 expect(liberadas).not.toContain('registrar_modo_sem_agenda');expect(liberadas).not.toContain('pedir_link_agenda');
});

it('reenvio só aparece em homolog com escolha só médico, nunca durante emissão',()=>{
 const f={ambiente:'homologacao',agenda:{nome:'Amplimed',conectada:true},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false,
 permissoes:{emitirAutonomo:'sempre_perguntar',entregarPaciente:'so_medico',pendentes:false}} satisfies FatosConversa;
 expect(ferramentasLiberadas(f,{lote:true})).toContain('reenviar_nota_medico');
 expect(ferramentasLiberadas({...f,lote:{estado:'processando'}},{lote:true})).not.toContain('reenviar_nota_medico');
 expect(ferramentasLiberadas({...f,ambiente:'producao'},{lote:true})).not.toContain('reenviar_nota_medico');
 expect(ferramentasLiberadas({...f,permissoes:{...f.permissoes,entregarPaciente:'paciente'}},{lote:true})).not.toContain('reenviar_nota_medico');
});


it('com uma agenda conectada ainda libera conexão da outra suportada',()=>{
 const f={ambiente:'homologacao',agenda:{nome:'tribemd',conectada:true},agendas:{tribemd:{salva:true,conectada:true},amplimed:{salva:false,conectada:false}},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false} satisfies FatosConversa;
 expect(ferramentasLiberadas(f,{lote:true})).toContain('pedir_link_agenda');
 expect(ferramentasLiberadas({...f,agendas:{tribemd:{salva:true,conectada:true},amplimed:{salva:true,conectada:true}}},{lote:true})).not.toContain('pedir_link_agenda');
});


it('operador do WhatsApp da conta pode configurar permissões sem redução por papel',()=>{
 const f={ambiente:'homologacao',agenda:{nome:'Amplimed',conectada:true},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false,
  permissoes:{emitirAutonomo:null,entregarPaciente:null,pendentes:true,faltantes:['emitir_autonomo','entregar_paciente'] as const}} satisfies FatosConversa;
 expect(ferramentasLiberadas(f,{lote:true})).toContain('pedir_link_permissoes');
});


it('associação de médico aparece com médico na conta e agenda conectada, sem exigir certificado',()=>{
 const base={ambiente:'homologacao',agenda:{nome:'tribemd',conectada:true},agendas:{tribemd:{salva:true,conectada:true},amplimed:{salva:false,conectada:false}},
  link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false,
  medicosConta:[{nome:'Ana Lima',certificado:'ok' as const},{nome:'Bruno Souza',certificado:'pendente' as const}]} satisfies FatosConversa;
 expect(ferramentasLiberadas(base,{lote:true})).toContain('associar_medico_agenda');
 // Agenda antes do certificado: médico pendente já pode ser associado (fluxo aprovado 26/10).
 expect(ferramentasLiberadas({...base,medicosConta:[{nome:'Bruno Souza',certificado:'pendente'}]},{lote:true})).toContain('associar_medico_agenda');
 expect(ferramentasLiberadas({...base,medicosConta:[]},{lote:true})).not.toContain('associar_medico_agenda');
 expect(ferramentasLiberadas({...base,agenda:{nome:'tribemd',conectada:false},agendas:{tribemd:{salva:true,conectada:false},amplimed:{salva:false,conectada:false}}},{lote:true})).not.toContain('associar_medico_agenda');
 expect(CATALOGO_FERRAMENTAS.find(t=>t.nome==='descobrir_medicos_agenda')?.descricao).toMatch(/Atalho opcional/);
});

it('descoberta de profissionais liberada para agenda Amplimed conectada',()=>{
 const base={ambiente:'homologacao',agenda:{nome:'amplimed',conectada:true},agendas:{tribemd:{salva:false,conectada:false},amplimed:{salva:true,conectada:true}},
  link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false,
  conta:{maxMedicos:5,usoCadastro:null}} satisfies FatosConversa;
 expect(ferramentasLiberadas(base,{lote:true})).toContain('descobrir_medicos_agenda');
 expect(ferramentasLiberadas({...base,agenda:{nome:'amplimed',conectada:false},agendas:{tribemd:{salva:false,conectada:false},amplimed:{salva:true,conectada:false}}},{lote:true})).not.toContain('descobrir_medicos_agenda');
});

it('associação Amplimed por código: vínculo persiste o código estável do profissional',()=>{
 // Contrato novo (26/10): conta multi-médico Amplimed só libera leitura/lote
 // quando existe vínculo com profissional_externo_id; a gate é aplicada no server
 // (resolverVinculoAgendaConta) — aqui cobrimos que a ferramenta de associação
 // continua disponível sem certificado para permitir criar esse vínculo.
 const base={ambiente:'homologacao',agenda:{nome:'amplimed',conectada:true},agendas:{tribemd:{salva:false,conectada:false},amplimed:{salva:true,conectada:true}},
  link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false,
  medicosConta:[{nome:'Ana Lima',certificado:'pendente' as const}]} satisfies FatosConversa;
 expect(ferramentasLiberadas(base,{lote:true})).toContain('associar_medico_agenda');
});
