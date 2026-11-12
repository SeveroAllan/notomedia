import { describe,expect,it,vi } from 'vitest';
import type pg from 'pg';
import { validarMidiaComprovante,interpretarClassificacao } from '../src/whatsapp/classificar-documento.js';
import { processarMidiaRecebida,avisoComprovante } from '../src/whatsapp/ingestao-comprovante.js';

const conta='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const imagem=Buffer.concat([Buffer.from([255,216,255,224]),Buffer.alloc(40)]).toString('base64');
const evento={instancia:'medico_aaaaaaaaaaaa',mensagemId:'MENSAGEM-123',remetente:'5551988887777',mimetype:'image/jpeg'};
const base={
  remetentesAutorizados:['5551988887777'],operadorAutorizado:'5551999998888',
  classificador:{classificar:vi.fn().mockResolvedValue({tipo:'comprovante_possivel',confianca:'alta',dataPagamento:'2026-11-11',valorCentavos:12000})},
  carregarMidia:vi.fn().mockResolvedValue({mimetype:'image/jpeg',base64:imagem}),
  informarOperador:vi.fn().mockResolvedValue(true)
};
const pool=(resposta:{repetido?:boolean;conta?:boolean;operador?:boolean}={})=>{
  const query=vi.fn(async(sql:string,_parametros?:unknown[]):Promise<unknown>=>{
    if(sql.includes('from public.whatsapp_instancias w'))
      return {rows:resposta.conta===false?[]:[{conta_id:conta,medico_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]};
    if(sql.includes('from public.usuarios u'))
      return {rows:resposta.operador===false?[]:[{autorizado:true}]};
    if(sql.includes('insert into noto_agent_mensagens'))
      return {rows:resposta.repetido?[]:[{mensagem_id:evento.mensagemId}]};
    if(sql.includes('update noto_agent_mensagens'))return {rows:[],rowCount:1};
    throw Error('SQL inesperado');
  });
  return {query,db:{query} as unknown as pg.Pool};
};

describe('MVP: entrada de documentos de pacientes isolada e sem emissão',()=>{
  it('valida assinatura real do arquivo, MIME e tamanho, não apenas extensão',()=>{
    expect(validarMidiaComprovante('image/jpeg',imagem)).toMatchObject({mimetype:'image/jpeg',tamanhoBytes:44});
    expect(validarMidiaComprovante('application/pdf',imagem)).toBeNull();
    expect(validarMidiaComprovante('image/jpeg','não é base64')).toBeNull();
    expect(validarMidiaComprovante('image/jpeg','A'.repeat(4_000_020))).toBeNull();
    const pdf=Buffer.concat([Buffer.from('%PDF-1.4'),Buffer.alloc(40)]).toString('base64');
    expect(validarMidiaComprovante('application/pdf',pdf)?.mimetype).toBe('application/pdf');
  });
  it('não aceita classificação inventada, data impossível ou suspeita de baixa confiança',()=>{
    expect(interpretarClassificacao({tipo:'comprovante_possivel',confianca:'baixa',dataPagamento:null,valorCentavos:100}))
      .toMatchObject({tipo:'ilegivel'});
    expect(interpretarClassificacao({tipo:'comprovante_possivel',confianca:'alta',dataPagamento:'2026-02-30',valorCentavos:100})).toBeNull();
    expect(interpretarClassificacao({tipo:'pagamento_confirmado',confianca:'alta',dataPagamento:null,valorCentavos:100})).toBeNull();
  });
  it('aviso nunca chama um PDF de pagamento confirmado, nem promete emissão',()=>{
    const texto=avisoComprovante({tipo:'comprovante_possivel',confianca:'alta',dataPagamento:null,valorCentavos:13500},
      {estado:'identificada',dataConsulta:'2026-11-11',profissional:'Dra. Alice'});
    expect(texto).toContain('pode corresponder');
    expect(texto).toContain('não confirma');
    expect(texto).not.toContain('emiti');
    expect(avisoComprovante({tipo:'outro',confianca:'alta',dataPagamento:null,valorCentavos:null})).toBeNull();
  });
  it('somente após vínculo da instância e conta: reserva idempotente, classifica e avisa o operador',async()=>{
    const {query,db}=pool();
    const deps={...base,pool:db};
    expect(await processarMidiaRecebida(evento,deps)).toBe('notificado');
    expect(deps.classificador.classificar).toHaveBeenCalledOnce();
    expect(deps.informarOperador).toHaveBeenCalledOnce();
    expect(deps.informarOperador.mock.calls[0]![0]).toBe(base.operadorAutorizado);
    expect(query.mock.calls.some(c=>String(c[0]).includes('on conflict do nothing'))).toBe(true);
    expect(query.mock.calls.at(-1)![1]).toEqual([conta,evento.instancia,evento.mensagemId,'concluida']);
    expect(JSON.stringify(query.mock.calls)).not.toContain(evento.remetente);
    expect(deps.informarOperador.mock.calls[0]![1]).not.toContain(evento.remetente);
  });
  it('remetente fora do piloto nunca acessa banco, modelo ou envio',async()=>{
    const {query,db}=pool();
    const deps={...base,pool:db,remetentesAutorizados:['5511999990000']};
    expect(await processarMidiaRecebida(evento,deps)).toBe('ignorado');
    expect(query).not.toHaveBeenCalled();
  });
  it('instância sem autorização, operador não autorizado e replay falham fechados',async()=>{
    for(const opts of [{conta:false},{operador:false},{repetido:true}]){
      const {db}=pool(opts);
      const cls=vi.fn(),env=vi.fn();
      const deps={...base,pool:db,classificador:{classificar:cls},informarOperador:env};
      expect(await processarMidiaRecebida(evento,deps)).toMatch(/ignorado|duplicado/);
      expect(cls).not.toHaveBeenCalled();
      expect(env).not.toHaveBeenCalled();
    }
  });
  it('classificação ou entrega incerta não gera retry nem segunda mensagem',async()=>{
    const {query,db}=pool();
    const deps={...base,pool:db,informarOperador:vi.fn().mockResolvedValue(false)};
    expect(await processarMidiaRecebida(evento,deps)).toBe('incerto');
    expect(query.mock.calls.at(-1)![1]).toEqual([conta,evento.instancia,evento.mensagemId,'incerta']);
  });
});
