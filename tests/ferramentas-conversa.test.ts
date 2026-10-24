import {describe,expect,it} from 'vitest';
import {CATALOGO_FERRAMENTAS,ferramentasLiberadas} from '../src/onboarding/ferramentas-conversa.js';
import type {FatosConversa} from '../src/onboarding/conversador-medico.js';
// Regra anterior (inline no server.ts), mantida aqui como referência de equivalência.
const anterior=(fatos:FatosConversa,retroativo:boolean)=>fatos.ambiente!=='homologacao'?[]:['aguardando_confirmacao_lote','confirmado','processando'].includes(fatos.lote?.estado??'')?['nenhuma']:
  ['nenhuma',...(!fatos.agenda.conectada?['registrar_modo_sem_agenda']:[]),
   ...(!fatos.agenda.conectada&&!fatos.link.ativo&&!fatos.semAgendaDigital?['pedir_link_agenda']:[]),
   ...(fatos.agenda.conectada&&!fatos.semAgendaDigital?['listar_pendencias',...(retroativo?['iniciar_lote']:[])]:[])];
describe('catálogo de ferramentas da conversa',()=>{
 it('libera exatamente o que a regra anterior liberava fora da proposta pendente, em todas as combinações de estado',()=>{
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
it('reenvio só aparece em homolog com escolha só médico, nunca durante emissão',()=>{
 const f={ambiente:'homologacao',agenda:{nome:'Amplimed',conectada:true},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false,
 permissoes:{emitirAutonomo:'sempre_perguntar',entregarPaciente:'so_medico',pendentes:false}} satisfies FatosConversa;
 expect(ferramentasLiberadas(f,{lote:true})).toContain('reenviar_nota_medico');
 expect(ferramentasLiberadas({...f,lote:{estado:'processando'}},{lote:true})).not.toContain('reenviar_nota_medico');
 expect(ferramentasLiberadas({...f,ambiente:'producao'},{lote:true})).not.toContain('reenviar_nota_medico');
 expect(ferramentasLiberadas({...f,permissoes:{...f.permissoes,entregarPaciente:'paciente'}},{lote:true})).not.toContain('reenviar_nota_medico');
});
