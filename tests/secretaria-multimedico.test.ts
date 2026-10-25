import {expect,it,vi} from 'vitest';
import {processarMensagemWebhook} from '../src/fluxos/processar-mensagem-webhook.js';
import type {AtendimentoRepositorio} from '../src/atendimento/atendimento-repositorio.js';

const medicos=[
 {id:'m1',nomeCompleto:'João da Silva',crm:'CRM 123'},
 {id:'m2',nomeCompleto:'Maria Souza',crm:'CRM 456'}
];
const evento=(texto:string,id='msg-1')=>({
 event:'messages.upsert',instance:'assistente',
 data:{key:{remoteJid:'5551999999999@s.whatsapp.net',fromMe:false,id},messageTimestamp:1792944000,message:{conversation:texto}}
});

function deps(foco:string|null=null,salvar=true){
 const focoAtual={valor:foco};
 const aoReceberMensagemMedico=vi.fn(async()=>{});
 const aoSolicitarMedicoOperador=vi.fn(async()=>{});
 const salvarFocoOperador=vi.fn(async(_u:string,m:string)=>{if(salvar)focoAtual.valor=m;return salvar;});
 const repo={
  buscarMedicoPorTelefone:vi.fn(async()=>null),
  buscarOperadorPorTelefone:vi.fn(async()=>({usuarioId:'u-secretaria',tipo:'secretaria' as const,telefone:'5551999999999',medicos})),
  lerFocoOperador:vi.fn(async()=>focoAtual.valor),
  salvarFocoOperador,
 } as unknown as AtendimentoRepositorio;
 return {focoAtual,aoReceberMensagemMedico,aoSolicitarMedicoOperador,salvarFocoOperador,
  entrada:{repositorio:repo,segredoConfigurado:'segredo',pepper:'pepper',instanciaAssistenteNome:'assistente',comunicacaoMedicoAtiva:true,
    reservarMensagemMedico:async()=>true,aoReceberMensagemMedico,aoSolicitarMedicoOperador}};
}

it('secretária escolhe médico permitido e o foco segue para a próxima mensagem',async()=>{
 const d=deps();
 await processarMensagemWebhook(evento('Veja as pendências do Dr João','1'),'segredo',d.entrada);
 expect(d.salvarFocoOperador).toHaveBeenCalledWith('u-secretaria','m1');
 expect(d.aoReceberMensagemMedico).toHaveBeenLastCalledWith(expect.objectContaining({medicoId:'m1',operadorTipo:'secretaria',contatoOperador:'5551999999999'}));
 d.aoReceberMensagemMedico.mockClear();
 await processarMensagemWebhook(evento('E as desta semana?','2'),'segredo',d.entrada);
 expect(d.aoReceberMensagemMedico).toHaveBeenLastCalledWith(expect.objectContaining({medicoId:'m1',operadorTipo:'secretaria'}));
});

it('sem foco não mistura médicos e pede seleção',async()=>{
 const d=deps();
 const r=await processarMensagemWebhook(evento('Veja as pendências','3'),'segredo',d.entrada);
 expect(r).toMatchObject({ok:true,acao:'descartada',motivoDescarte:'medico_nao_identificado'});
 expect(d.aoSolicitarMedicoOperador).toHaveBeenCalledWith(expect.objectContaining({usuarioId:'u-secretaria',medicos}));
 expect(d.aoReceberMensagemMedico).not.toHaveBeenCalled();
});

it('vínculo revogado impede trocar foco e não entrega a mensagem ao médico',async()=>{
 const d=deps('m1',false);
 const r=await processarMensagemWebhook(evento('Troque para a médica Maria','4'),'segredo',d.entrada);
 expect(r).toMatchObject({ok:true,acao:'descartada',motivoDescarte:'medico_nao_identificado'});
 expect(d.aoReceberMensagemMedico).not.toHaveBeenCalled();
});
