import { expect, it, vi } from 'vitest';
import { resolverContatoConsulta } from '../src/agenda/fonte-agenda.js';
import { PostgresEmissaoApiRepositorio } from '../src/io/postgres/postgres-emissao-api-repositorio.js';
import { ComunicacaoHomologacao } from '../src/whatsapp/comunicacao-homologacao.js';
import { carregarConfig } from '../src/config.js';
it.each([
  [{ celular:'+55 (11) 99999-0000',telefone:null },'5511999990000'],
  [{ celular:null,telefone:'(11) 99999-0000' },'11999990000'],
  [{ celular:'invalido',telefone:'11999990000' },'11999990000'],
  [{ celular:'11999990000',telefone:'11999990000' },'11999990000'],
  [{ celular:'11999990000',telefone:'11888880000' },null],
  [{ celular:'123',telefone:'55555555555555' },null],
  [undefined,null]
])('contato único da mesma consulta: %j', (contato, esperado) => expect(resolverContatoConsulta(contato)).toBe(esperado));
it('origem lote criptografa uma vez no INSERT; comprovante não escreve a coluna de contato', async () => {
  const query = vi.fn(async (sql: string, _parametros: unknown[] = []) => ({ rows: sql.includes('insert into solicitacoes_nota') ? [{ id:'s' }] : [] }));
  const client = { query,release:vi.fn() }; const repo = new PostgresEmissaoApiRepositorio({ connect:async()=>client } as any,'chave-falsa','pepper');
  const base = { ref:'lote:i',medicoId:'m',pacienteId:'p',valorServicoCentavos:30000,xdescServ:'Consulta',ctribNac:'040101' };
  await repo.enfileirarSolicitacao({ ...base,origem:'lote',contatoPaciente:'5511999990000' } as any);
  let insert = query.mock.calls.find(([sql])=>sql.includes('insert into solicitacoes_nota'))!;
  expect(insert[0]).toContain('contato_paciente_encriptado'); expect(insert[0]).toContain('pgp_sym_encrypt');
  expect(insert[1]!.slice(-2)).toEqual(['5511999990000','chave-falsa']);
  query.mockClear(); await repo.enfileirarSolicitacao({ ...base,ref:'comprovante:i',origem:'whatsapp' });
  insert = query.mock.calls.find(([sql])=>sql.includes('insert into solicitacoes_nota'))!;
  expect(insert[0]).not.toContain('contato_paciente_encriptado'); expect(insert[0]).not.toContain('pgp_sym_encrypt'); expect(insert[1]!).toHaveLength(11);
});
it('entrega de lote lê snapshot criptografado da solicitação e mantém instância própria e dedup por nota', async () => {
  const reservas = new Set<string>();
  const query = vi.fn(async (sql:string,p:unknown[] = [])=>{
    if(sql.includes('from notas_fiscais')){
      expect(sql).toContain('pgp_sym_decrypt(sn.contato_paciente_encriptado, $5)');
      expect(sql).toContain("when sn.origem='lote' then null"); expect(p[4]).toBe('chave-falsa');
      return { rows:[{ nota_fiscal_id:'n',origem:'lote',ambiente:'homologacao',contato_telefone:'5511999990000',nome_instancia:'medico-proprio',instancia_medico_id:'m',instancia_status:'conectado',pdf_storage_path:'fake.pdf' }] };
    }
    if(sql.includes('insert into')){ const k=JSON.stringify(p);if(reservas.has(k))return{rows:[]};reservas.add(k);return{rows:[{id:'r'}]}; }
    return { rows:[] };
  });
  const enviarPdf = vi.fn(async()=>({sucesso:true}));
  const config={...carregarConfig({}),encryptionKey:'chave-falsa',envioPacienteRealAtivo:true,envioRealAllowlist:['11999990000']};
  const c = new ComunicacaoHomologacao({query} as any,config,{enviarTexto:vi.fn()},vi.fn());
  await Promise.all(Array.from({length:10},()=>c.paciente({medicoId:'m',solicitacaoId:'s'},{enviarPdf})));
  expect(enviarPdf).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({instanciaNome:'medico-proprio',contatoTelefone:'5511999990000'}));
});
it.each([null,'123','12345678901234'])('lote sem contato válido não envia nem cai no telefone do cadastro: %s',async contato=>{
  const query=vi.fn(async()=>({rows:[{nota_fiscal_id:'n',origem:'lote',ambiente:'homologacao',contato_telefone:contato}]}));
  const enviarPdf=vi.fn(),enviarTexto=vi.fn();
  const c=new ComunicacaoHomologacao({query} as any,{...carregarConfig({}),envioPacienteRealAtivo:true,envioRealAllowlist:['11999990000']},{enviarTexto},vi.fn());
  expect(await c.paciente({medicoId:'m',solicitacaoId:'s'},{enviarPdf})).toBe('sem_contato');
  expect(enviarPdf).not.toHaveBeenCalled();expect(enviarTexto).not.toHaveBeenCalled();
});
it.each([
  [false,'homologacao',['11999990000']],
  [true,'producao',['11999990000']],
  [true,'homologacao',[]],
  [true,'homologacao',['11888880000']]
])('snapshot não afrouxa gates de entrega flag=%s ambiente=%s',async(ativo,ambiente,allowlist)=>{
  const query=vi.fn(async(_sql:string,_parametros:unknown[] = [])=>({rows:[{nota_fiscal_id:'n',origem:'lote',ambiente,contato_telefone:'5511999990000',nome_instancia:'propria',instancia_medico_id:'m',instancia_status:'conectado',pdf_storage_path:'fake.pdf'}]}));
  const enviarPdf=vi.fn();
  const c=new ComunicacaoHomologacao({query} as any,{...carregarConfig({}),envioPacienteRealAtivo:ativo,envioRealAllowlist:allowlist},{enviarTexto:vi.fn()},vi.fn());
  expect(await c.paciente({medicoId:'m',solicitacaoId:'s'},{enviarPdf})).toBe('simulado');expect(enviarPdf).not.toHaveBeenCalled();
  expect(query.mock.calls.every(([sql])=>!sql.includes('insert into'))).toBe(true);
});
it('falha de leitura do snapshot não expõe contato/chave e não altera a nota',async()=>{
  const query=vi.fn(async()=>{throw Error('chave-falsa contato-privado');});const log=vi.fn(),enviarPdf=vi.fn();
  const c=new ComunicacaoHomologacao({query} as any,{...carregarConfig({}),envioPacienteRealAtivo:true},{enviarTexto:vi.fn()},log);
  expect(await c.paciente({medicoId:'m',solicitacaoId:'s'},{enviarPdf})).toBe('erro');
  expect(enviarPdf).not.toHaveBeenCalled();expect(JSON.stringify(log.mock.calls)).not.toMatch(/chave-falsa|contato-privado/);
});
