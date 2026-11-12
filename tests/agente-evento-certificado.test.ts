import {describe,expect,it,vi} from 'vitest';
import type pg from 'pg';
import {descreverCertificadoVerificado,notificarCertificadoRecebido} from '../src/agente/evento-certificado.js';

const medico='11111111-1111-4111-8111-111111111111';
const certificado='22222222-2222-4222-8222-222222222222';
const conta='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const estado={certificadoValido:true,profissionalConfirmado:true,perfilFiscalConfirmado:false};
const dados=(opcoes:{conta?:boolean;repetido?:boolean}={})=>{
  const query=vi.fn(async(sql:string,_parametros?:unknown[]):Promise<{rows:any[];rowCount?:number}>=>{
    if(sql.includes('from public.medicos m'))return{rows:opcoes.conta===false?[]:[{conta_id:conta}]};
    if(sql.includes('insert into noto_agent_mensagens'))
      return{rows:opcoes.repetido?[]:[{mensagem_id:'evento'}]};
    if(sql.includes('update noto_agent_mensagens'))return{rows:[],rowCount:1};
    throw Error('consulta inesperada');
  });
  return {query,pool:{query} as unknown as pg.Pool};
};
const deps=(pool:pg.Pool)=>({
  pool,operadorTeste:'5551999998888',instanciaAssistente:'noto_assistente_teste',
  consultarEstado:vi.fn().mockResolvedValue(estado),
  enviar:vi.fn().mockResolvedValue(true)
});

describe('evento fiscal A1: aviso comprovado sem autorização de emissão',()=>{
  it('não transforma certificado em autorização fiscal',()=>{
    const frase=descreverCertificadoVerificado(estado);
    expect(frase).toContain('certificado A1 foi recebido e está válido');
    expect(frase).toContain('ainda precisam ser conferidos');
    expect(frase).toContain('Não emiti nenhuma nota');
  });
  it('só notifica operador autenticado na mesma conta e reserva mensagem idempotente',async()=>{
    const {query,pool}=dados();
    const d=deps(pool);
    const continuarEvento=vi.fn(async(e:{textoComprovado:string})=>e.textoComprovado);
    expect(await notificarCertificadoRecebido(medico,certificado,{...d,continuarEvento})).toBe('enviado');
    expect(d.enviar).toHaveBeenCalledOnce();
    expect(d.enviar.mock.calls[0]![0]).toBe('5551999998888');
    expect(continuarEvento.mock.calls[0]![0]).toMatchObject({tipo:'certificado_salvo',contaId:conta});
    expect(JSON.stringify(query.mock.calls)).not.toContain(certificado);
    expect(query.mock.calls.at(-1)![1]).toMatchObject([conta,'noto_assistente_teste',expect.stringContaining('certificado-'),'concluida']);
  });
  it('conta não autorizada ou evento duplicado não chama IA nem transportador',async()=>{
    for(const arg of [{conta:false},{repetido:true}]){
      const {pool}=dados(arg),d=deps(pool);
      expect(await notificarCertificadoRecebido(medico,certificado,d)).toBe('ignorado');
      expect(d.consultarEstado).not.toHaveBeenCalled();
      expect(d.enviar).not.toHaveBeenCalled();
    }
  });
  it('envio incerto não gera outra mensagem automática',async()=>{
    const {pool,query}=dados(),d=deps(pool);
    d.enviar.mockResolvedValueOnce(false);
    expect(await notificarCertificadoRecebido(medico,certificado,d)).toBe('incerto');
    expect(query.mock.calls.at(-1)![1]?.[3]).toBe('incerta');
    expect(d.enviar).toHaveBeenCalledOnce();
  });
});
