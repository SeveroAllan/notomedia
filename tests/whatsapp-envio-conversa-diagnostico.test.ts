import {describe,it,expect} from 'vitest';
import {diagnosticarAceiteSaida,diagnosticarReciboSaida} from '../src/whatsapp/diagnostico-envio-conversa.js';
const segredo='segredo-ficticio-testes';
const instancia='instancia_teste';
const telefone='5551999998888';
function recibo(id:string,status:string,fromMe=true,jid=telefone+'@s.whatsapp.net'){
  return {event:'messages.update',instance:instancia,
    data:{keyId:id,status,fromMe,remoteJid:jid}};
}
describe('diagnóstico da Evolution: aceite HTTP não é entrega nem sincronização Web',()=>{
  it('correlaciona API, SERVER_ACK, DELIVERY_ACK, READ, ERROR pelo mesmo ref seguro',()=>{
    const aceite=diagnosticarAceiteSaida(segredo,instancia,{
      sucesso:true,mensagemId:'ABCdef_123456'
    });
    expect(aceite).toEqual({estado:'ACEITO_API',mensagemRef:expect.any(String)});
    for(const estado of ['SERVER_ACK','DELIVERY_ACK','READ','ERROR']){
      const r=diagnosticarReciboSaida(segredo,instancia,telefone,
        recibo('ABCdef_123456',estado));
      expect(r).toEqual({estado,mensagemRef:aceite.mensagemRef});
      expect(JSON.stringify(r)).not.toContain(telefone);
      expect(JSON.stringify(r)).not.toContain('ABCdef_123456');
    }
  });
  it('aceite sem key.id não se apresenta como entrega comprovada',()=>{
    expect(diagnosticarAceiteSaida(segredo,instancia,{sucesso:true}))
      .toEqual({estado:'ACEITO_SEM_ID'});
    expect(diagnosticarAceiteSaida(segredo,instancia,{sucesso:false,mensagemId:'ABCdef_123456'}))
      .toEqual({estado:'NAO_ACEITO'});
  });
  it('ignora recibos de origem externa, outro destino, outra instância e JID LID',()=>{
    expect(diagnosticarReciboSaida(segredo,instancia,telefone,
      recibo('ABCdef_123456','DELIVERY_ACK',false))).toBeNull();
    expect(diagnosticarReciboSaida(segredo,instancia,telefone,
      recibo('ABCdef_123456','DELIVERY_ACK',true,'5511999990000@s.whatsapp.net'))).toBeNull();
    expect(diagnosticarReciboSaida(segredo,instancia,telefone,
      recibo('ABCdef_123456','DELIVERY_ACK',true,'12345@lid'))).toBeNull();
    expect(diagnosticarReciboSaida(segredo,instancia,telefone,{
      ...recibo('ABCdef_123456','READ'),instance:'instancia_alheia'
    })).toBeNull();
  });
});
