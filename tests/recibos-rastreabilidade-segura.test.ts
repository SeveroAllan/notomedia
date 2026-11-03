import { describe,expect,it,vi } from 'vitest';
import { interpretarEstadoEvolutionComDiagnostico } from '../src/whatsapp/status-entrega-link.js';
import { diagnosticarRegistroEstadoEvolution } from '../src/whatsapp/repositorio-entrega-link.js';

const segredo='segredo-isolado-para-teste';
const instancia='noto-assistente';
const id='3EB0ABCD12345678';
const recebido=(modificacoes:Record<string,unknown>={})=>({
  event:'messages.update',instance:instancia,
  data:{keyId:id,remoteJid:'5551999998888@s.whatsapp.net',fromMe:true,status:'READ',
    ...modificacoes}
});
describe('MESSAGES_UPDATE: evidencia sem fabricar recibos',()=>{
  it('classifica formatos não reconhecidos sem copiar conteúdo',()=>{
    expect(interpretarEstadoEvolutionComDiagnostico({
      event:'messages.update',instance:instancia,data:[]}
    )).toMatchObject({ok:false,motivo:'CORPO_NAO_RECONHECIDO'});
    expect(interpretarEstadoEvolutionComDiagnostico(recebido({status:'NOVO_STATUS'})))
      .toMatchObject({ok:false,motivo:'STATUS_NAO_RECONHECIDO'});
    expect(interpretarEstadoEvolutionComDiagnostico(recebido({fromMe:false})))
      .toMatchObject({ok:false,motivo:'MENSAGEM_SEM_ORIGEM_COMPROVADA'});
    expect(interpretarEstadoEvolutionComDiagnostico(recebido({keyId:null})))
      .toMatchObject({ok:false,motivo:'SEM_ID_DA_MENSAGEM'});
    expect(interpretarEstadoEvolutionComDiagnostico(recebido({
      remoteJid:'123456789012345@lid'
    }))).toMatchObject({ok:false,motivo:'SEM_NUMERO_PN'});
  });
  it('so usa PN presente, mesmo quando JID primario e @lid; sem inventar correspondencia',()=>{
    const r=interpretarEstadoEvolutionComDiagnostico(recebido({
      remoteJid:'123456789012345@lid',
      remoteJidAlt:'5551999998888@s.whatsapp.net'
    }));
    expect(r).toMatchObject({ok:true,evento:{
      mensagemId:id,instancia,estado:'READ',destinatarios:['5551999998888']
    }});
    const outro=interpretarEstadoEvolutionComDiagnostico({
      ...recebido(),event:'MESSAGES_UPDATE'
    });
    expect(outro.ok).toBe(true);
  });
  it('falta de correspondencia preserva ACEITO_API e informa apenas uma classe',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[]});
    const r=await diagnosticarRegistroEstadoEvolution({query} as any,recebido(),instancia,segredo);
    expect(r).toBe('SEM_CORRELACAO');
    expect(query).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(query.mock.calls)).not.toContain('https://');
    expect(JSON.stringify(query.mock.calls)).not.toContain('5551999998888');
    expect(JSON.stringify(r)).not.toContain(id);
  });
  it('recibo repetido não regrava timestamp nem sinaliza entrega nova',async()=>{
    const query=vi.fn()
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[{estado:'READ'}]});
    const r=await diagnosticarRegistroEstadoEvolution({query} as any,recebido(),instancia,segredo);
    expect(r).toBe('DUPLICADO_OU_SEM_AVANCO');
    const sql=String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('IS DISTINCT FROM');
    expect(sql).toContain("estado <> 'READ'");
  });
  it('nao confunde ausencia de status com falha de envio ou de destino',async()=>{
    const query=vi.fn();
    expect(await diagnosticarRegistroEstadoEvolution({query} as any,
      recebido({remoteJid:'111111111111111@lid'}),instancia,segredo)).toBe('SEM_NUMERO_PN');
    expect(await diagnosticarRegistroEstadoEvolution({query} as any,{
      ...recebido(),instance:'outro-assistente'
    },instancia,segredo)).toBe('OUTRA_INSTANCIA');
    expect(query).not.toHaveBeenCalled();
  });
});
