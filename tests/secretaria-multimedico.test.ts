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
  buscarMedicoPorTelefone:vi.fn(async()=>({id:'m1'})),
  buscarOperadorPorTelefone:vi.fn(async()=>({usuarioId:'u-operador',contaId:'conta-1',telefone:'5551999999999',medicos})),
  lerFocoOperador:vi.fn(async()=>focoAtual.valor),
  salvarFocoOperador,
 } as unknown as AtendimentoRepositorio;
 return {focoAtual,aoReceberMensagemMedico,aoSolicitarMedicoOperador,salvarFocoOperador,
  entrada:{repositorio:repo,segredoConfigurado:'segredo',pepper:'pepper',instanciaAssistenteNome:'assistente',comunicacaoMedicoAtiva:true,
    reservarMensagemMedico:async()=>true,aoReceberMensagemMedico,aoSolicitarMedicoOperador}};
}

it('usuário que também é médico pode trocar para outro médico da mesma conta',async()=>{
 const d=deps();
 await processarMensagemWebhook(evento('Veja as pendências da Dra Maria Souza','1'),'segredo',d.entrada);
 expect(d.salvarFocoOperador).toHaveBeenCalledWith('u-operador','m2');
 expect(d.aoReceberMensagemMedico).toHaveBeenLastCalledWith(expect.objectContaining({
  medicoId:'m2',origemOperador:'conta',contatoOperador:'5551999999999'
 }));
});

it('foco da conta segue para a próxima mensagem sem depender de papel de secretária',async()=>{
 const d=deps('m1');
 await processarMensagemWebhook(evento('E as desta semana?','2'),'segredo',d.entrada);
 expect(d.aoReceberMensagemMedico).toHaveBeenLastCalledWith(expect.objectContaining({medicoId:'m1',origemOperador:'conta'}));
});

it('sem foco não adivinha médico e pede seleção',async()=>{
 const d=deps();
 const r=await processarMensagemWebhook(evento('Veja as pendências','3'),'segredo',d.entrada);
 expect(r).toMatchObject({ok:true,acao:'descartada',motivoDescarte:'medico_nao_identificado'});
 expect(d.aoSolicitarMedicoOperador).toHaveBeenCalledWith(expect.objectContaining({usuarioId:'u-operador',medicos}));
 expect(d.aoReceberMensagemMedico).not.toHaveBeenCalled();
});

it('falha ao validar foco impede entregar mensagem a outro médico',async()=>{
 const d=deps('m1',false);
 const r=await processarMensagemWebhook(evento('Troque para a médica Maria Souza','4'),'segredo',d.entrada);
 expect(r).toMatchObject({ok:true,acao:'descartada',motivoDescarte:'medico_nao_identificado'});
 expect(d.aoReceberMensagemMedico).not.toHaveBeenCalled();
});

it('menção explícita a vários médicos preserva o foco em vez de escolher um deles',async()=>{
 const d=deps('m1');
 await processarMensagemWebhook(evento('Quero emitir para João da Silva e Maria Souza','5'),'segredo',d.entrada);
 expect(d.aoReceberMensagemMedico).toHaveBeenLastCalledWith(expect.objectContaining({medicoId:'m1',origemOperador:'conta'}));
 expect(d.salvarFocoOperador).toHaveBeenLastCalledWith('u-operador','m1');
});

it('seleção plural com um médico ainda não cadastrado preserva o foco para validar o conjunto',async()=>{
 const d=deps('m1');
 await processarMensagemWebhook(evento('Quero emitir para João da Silva e Dra. Ana Lima','6'),'segredo',d.entrada);
 expect(d.aoReceberMensagemMedico).toHaveBeenLastCalledWith(expect.objectContaining({medicoId:'m1',origemOperador:'conta'}));
 expect(d.salvarFocoOperador).toHaveBeenLastCalledWith('u-operador','m1');
});
