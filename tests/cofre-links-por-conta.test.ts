import { describe,expect,it,vi } from 'vitest';
import type pg from 'pg';
import { LinksCofre } from '../src/cofre/links.js';
import { cofreIdDaConta, contaDoCofreId } from '../src/cofre/identidade-conta.js';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const telefone='5551999998888';
function montar(conta:string=A,operador:string=telefone,contato:string=telefone){
  const aoConcluirConta=vi.fn().mockResolvedValue(undefined);
  const chamadas:Array<{sql:string;params:unknown[]}>=[];
  const banco={ query:vi.fn(async(sql:string,params:unknown[]=[])=>{
    chamadas.push({sql,params});
    if(sql==='begin'||sql==='commit'||sql==='rollback')return {rows:[]};
    if(sql.startsWith('select id from contas'))return {rows:[{id:conta}]};
    if(sql.includes('select telefone from usuarios'))return {rows:[{telefone:operador}]};
    if(sql.includes('count(*)::int as total from cofre_links'))return {rows:[{total:0}]};
    if(sql.includes('insert into cofre_links\n'))return {rows:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}]};
    if(sql.includes("values ($1, 'concluido')") && sql.includes('returning link_id'))return {rows:[{link_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}]};
    if(sql.includes('returning medico_id, conta_id'))return {rows:[{medico_id:null,conta_id:conta,
      id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',agenda:'tribemd',destino_telefone:contato}]};
    return {rows:[],rowCount:1};
  }),release:vi.fn()};
  const pool={connect:vi.fn().mockResolvedValue(banco),query:banco.query} as unknown as pg.Pool;
  const cofre={status:vi.fn().mockResolvedValue({estado:'vazio',ativo:false}),iniciar:vi.fn().mockResolvedValue({estado:'conectando'})};
  const enviar=vi.fn().mockResolvedValue('enviado');
  const links=new LinksCofre({pool,origem:'https://homologacao.example.test',cofre,enviar,aoConcluirConta});
  return {links,cofre,enviar,banco,chamadas,aoConcluirConta};
}
describe('Cofre da conta sem qualquer registro em medicos',()=>{
  it('chave estável de conta separada do UUID do médico e sem caminhos perigosos',()=>{
    expect(cofreIdDaConta(A)).toBe('conta_'+A);
    expect(contaDoCofreId(cofreIdDaConta(A))).toBe(A);
    expect(contaDoCofreId('conta_'+B)).toBe(B);
    expect(contaDoCofreId('../'+A)).toBeNull();
    expect(()=>cofreIdDaConta('Médico 6133')).toThrow();
  });
  it('envia link de uso único com FK conta_id e médico nulo após validar telefone ativo',async()=>{
    const t=montar();
    const r=await t.links.solicitarLinkConta(A,'tribemd',telefone);
    expect(r).toMatchObject({ok:true,motivo:'enviado'});
    expect(t.banco.query).toHaveBeenCalledWith('select id from contas where id=$1 for update',[A]);
    expect(t.banco.query.mock.calls.some(c=>String(c[0]).includes('medicos'))).toBe(false);
    const insercao=t.chamadas.find(c=>c.sql.includes('insert into cofre_links\n'))!;
    expect(insercao.sql).toContain('values ($1,null,$2,$3');
    expect(insercao.params[0]).toBe(A);
    expect(insercao.params[1]).toBe('tribemd');
    expect(t.enviar).toHaveBeenCalledTimes(3);
    expect(t.enviar.mock.calls.map(c=>c[0])).toEqual(Array(3).fill(cofreIdDaConta(A)));
    expect(t.enviar.mock.calls.at(-1)?.[1]).toMatch(/^https:\/\/homologacao.example.test\/c\/[A-Za-z0-9_-]{43}$/);
    expect(t.banco.release).toHaveBeenCalledOnce();
  });
  it('recusa acesso de operador de outra conta, sem link nem divulgação',async()=>{
    const t=montar(A,'5551999999999');
    const r=await t.links.solicitarLinkConta(A,'tribemd',telefone);
    expect(r).toMatchObject({ok:false,motivo:'OPERADOR_NAO_AUTORIZADO'});
    expect(t.enviar).not.toHaveBeenCalled();
    expect(t.chamadas.some(c=>c.sql.includes('insert into cofre_links\n'))).toBe(false);
    expect(t.chamadas.some(c=>c.sql==='rollback')).toBe(true);
    expect(t.banco.release).toHaveBeenCalledOnce();
  });
  it('envio da senha na página consome token e autentica no perfil somente da conta',async()=>{
    const t=montar();
    const dados={email:'teste@example.invalid',senha:'senha-ficticia',consentimento:'tribemd-leitura-v1'};
    expect(await t.links.enviarCredencial('A'.repeat(43),dados)).toBe(true);
    expect(t.cofre.iniciar).toHaveBeenCalledExactlyOnceWith(cofreIdDaConta(A),dados);
    expect(t.cofre.iniciar).not.toHaveBeenCalledWith(B,expect.anything());
    expect(t.chamadas.some(c=>c.sql.includes('returning medico_id, conta_id'))).toBe(true);
  });

  it('depois de login confirmado, evento pertence à conta e NÃO dispara callback clínico',async()=>{
    const t=montar();
    await t.links.enviarCredencial('A'.repeat(43),{
      email:'teste@example.invalid',senha:'senha-ficticia',consentimento:'tribemd-leitura-v1'
    });
    await t.links.concluir(cofreIdDaConta(A),true);
    expect(t.aoConcluirConta).toHaveBeenCalledExactlyOnceWith(A,expect.objectContaining({
      agenda:'tribemd',conectado:true,contatoTelefone:telefone
    }));
    expect(t.enviar).not.toHaveBeenCalled();
    await t.links.concluir(cofreIdDaConta(A),true);
    expect(t.aoConcluirConta).toHaveBeenCalledOnce();
  });
  it('não permite gerar link quando cofre já está conectado',async()=>{
    const t=montar();
    t.cofre.status.mockResolvedValue({estado:'conectado',ativo:true});
    expect((await t.links.solicitarLinkConta(A,'tribemd',telefone)).motivo).toBe('COFRE_NAO_DISPONIVEL');
    expect(t.enviar).not.toHaveBeenCalled();
  });
});
