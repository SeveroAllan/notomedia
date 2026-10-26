import {expect,it,vi} from 'vitest';
import type pg from 'pg';
import {PostgresAtendimentoRepositorio} from '../src/io/postgres/postgres-atendimento-repositorio.js';
import {confirmarMedicosDaConta,linkCertificadoMedico,nomeProfissionalDescobertoNaConversa,resolverMedicosPorNomes,resolverNomesParaConfiguracao} from '../src/conta/medicos-conta.js';
import {perguntaSelecaoMedico} from '../src/onboarding/operador-medico.js';

it('operador do WhatsApp recebe todos os médicos da conta, mesmo quando possui médico próprio',async()=>{
  const query=vi.fn()
    .mockResolvedValueOnce({rows:[{id:'u1',conta_id:'conta-1',telefone:'5551999999999'}]})
    .mockResolvedValueOnce({rows:[
      {id:'m1',nome_completo:'João da Silva',crm:'CRM 123'},
      {id:'m2',nome_completo:'Maria Souza',crm:'CRM 456'}
    ]});
  const repo=new PostgresAtendimentoRepositorio({query} as unknown as pg.Pool,'chave');
  const operador=await repo.buscarOperadorPorTelefone('5551999999999');
  expect(operador).toEqual({usuarioId:'u1',contaId:'conta-1',telefone:'5551999999999',medicos:[
    {id:'m1',nomeCompleto:'João da Silva',crm:'CRM 123'},
    {id:'m2',nomeCompleto:'Maria Souza',crm:'CRM 456'}
  ]});
  expect(String(query.mock.calls[1]![0])).toContain('where conta_id=$1');
  expect(JSON.stringify(query.mock.calls)).not.toMatch(/secretarias|secretaria_medico/i);
});

it('foco é autorizado pela conta e não por papel ou vínculo de secretária',async()=>{
  const query=vi.fn()
    .mockResolvedValueOnce({rows:[{medico_id:'m2'}]})
    .mockResolvedValueOnce({rows:[{medico_id:'m2'}]});
  const repo=new PostgresAtendimentoRepositorio({query} as unknown as pg.Pool,'chave');
  expect(await repo.lerFocoOperador('u1')).toBe('m2');
  expect(await repo.salvarFocoOperador('u1','m2')).toBe(true);
  const sql=query.mock.calls.map(c=>String(c[0])).join('\n');
  expect(sql).toMatch(/m\.conta_id=u\.conta_id/);
  expect(sql).not.toMatch(/secretarias|secretaria_medico/i);
});

it('seleção e descoberta mostram somente nomes, sem CRM ou ids',()=>{
  const medicos=[
    {id:'m1',nomeCompleto:'João da Silva',crm:'CRM 123'},
    {id:'m2',nomeCompleto:'Maria Souza',crm:'CRM 456'}
  ];
  const pergunta=perguntaSelecaoMedico(medicos);
  expect(pergunta).toContain('João da Silva');
  expect(pergunta).toContain('Maria Souza');
  expect(pergunta).not.toMatch(/CRM|m1|m2/);
});

it('resolução de médicos exige nome exato normalizado e não adivinha ambiguidade',()=>{
  const medicos=[
    {id:'m1',nomeCompleto:'Dra. Ana Lima',crm:null,certificadoValido:false},
    {id:'m2',nomeCompleto:'Bruno Souza',crm:null,certificadoValido:true}
  ];
  expect(resolverMedicosPorNomes(['Ana Lima'],medicos)).toMatchObject({ok:true,medicos:[{id:'m1'}]});
  expect(resolverMedicosPorNomes(['Ana'],medicos)).toEqual({ok:false,motivo:'MEDICO_NAO_IDENTIFICADO',nome:'Ana'});
});

it('link de certificado aponta ao painel existente e carrega médico alvo',()=>{
  const url=new URL(linkCertificadoMedico('https://noto.exemplo.com/base','00000000-0000-4000-8000-000000000001'));
  expect(url.origin).toBe('https://noto.exemplo.com');
  expect(url.pathname).toBe('/');
  expect(url.searchParams.get('medicoId')).toBe('00000000-0000-4000-8000-000000000001');
  expect(url.searchParams.get('etapa')).toBe('certificado');
});

it('certificados são independentes por médico da mesma conta',async()=>{
  const query=vi.fn(async()=>({rows:[
    {id:'m1',nome_completo:'Ana Lima',crm:null,certificado_valido:true},
    {id:'m2',nome_completo:'Bruno Souza',crm:null,certificado_valido:false}
  ]}));
  const {listarMedicosDaConta}=await import('../src/conta/medicos-conta.js');
  expect(await listarMedicosDaConta({query} as unknown as pg.Pool,'m1')).toEqual([
    {id:'m1',nomeCompleto:'Ana Lima',crm:null,certificadoValido:true},
    {id:'m2',nomeCompleto:'Bruno Souza',crm:null,certificadoValido:false}
  ]);
  expect(String((query.mock.calls as unknown as any[][])[0]![0])).toContain('c.medico_id=m.id');
});


it('cada médico escolhido recebe alvo independente no link de certificado',()=>{
 const origem='https://noto.exemplo.com';
 const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
 const urls=ids.map(id=>new URL(linkCertificadoMedico(origem,id)));
 expect(urls.map(u=>u.searchParams.get('medicoId'))).toEqual(ids);
 expect(urls[0].toString()).not.toBe(urls[1].toString());
});


it('associar cria médico só quando o nome veio da descoberta da mesma agenda nesta conversa',()=>{
 const contexto=(fonte:string,profissionais:string[])=>JSON.stringify({fonte,profissionais,codigos:profissionais.map(nome=>({codigo:'1',nome}))});
 expect(nomeProfissionalDescobertoNaConversa([contexto('amplimed',['Allan Severo (teste Noto)'])],'amplimed','allan severo teste noto'))
   .toBe('Allan Severo (teste Noto)');
 expect(nomeProfissionalDescobertoNaConversa([contexto('tribemd',['Allan Severo (teste Noto)'])],'amplimed','Allan Severo (teste Noto)'))
   .toBeUndefined();
 expect(nomeProfissionalDescobertoNaConversa([contexto('amplimed',['Ana Lima'])],'amplimed','Carla Mendes'))
   .toBeUndefined();
 expect(nomeProfissionalDescobertoNaConversa(['{json quebrado'],'amplimed','Ana Lima'))
   .toBeUndefined();
 expect(nomeProfissionalDescobertoNaConversa([],'amplimed','Ana Lima'))
   .toBeUndefined();
});

it('descoberta é atalho: nome observado é reaproveitado e nome não observado pode iniciar configuração quando está explícito',()=>{
 expect(resolverNomesParaConfiguracao(['Bruno Souza'],['Ana Lima'],['Bruno Souza'],'Quero adicionar o Bruno'))
   .toEqual({ok:true,nomes:['Bruno Souza']});
 expect(resolverNomesParaConfiguracao(['Carla Mendes'],['Ana Lima'],[],'Quero adicionar Carla Mendes'))
   .toEqual({ok:true,nomes:['Carla Mendes']});
 expect(resolverNomesParaConfiguracao(['Carla Mendes'],['Ana Lima'],[],'Quero adicionar outro médico'))
   .toEqual({ok:false,motivo:'MEDICO_NAO_IDENTIFICADO',nome:'Carla Mendes'});
});

it('repetir configuração do mesmo nome normalizado reutiliza médico e não duplica cadastro',async()=>{
 const medicos:Array<{id:string;nome_completo:string;crm:string|null;certificado_valido:boolean}>=[{id:'base',nome_completo:'Ana Lima',crm:'1/RS',certificado_valido:true}];
 let inserts=0;
 const query=vi.fn(async(sql:string,p:unknown[]=[])=>{
   const q=sql.replace(/\s+/g,' ').trim().toLowerCase();
   if(['begin','commit','rollback'].includes(q)||q.includes('pg_advisory_xact_lock'))return {rows:[]};
   if(q.startsWith('select conta_id from medicos'))return {rows:[{conta_id:'conta'}]};
   if(q.includes('from medicos m where m.conta_id=$1 order by'))return {rows:structuredClone(medicos)};
   if(q.includes('insert into medicos (usuario_id,conta_id,nome_completo)')){
     inserts++;
     const linha={id:'bruno-id',nome_completo:String(p[1]),crm:null,certificado_valido:false};
     medicos.push(linha);return {rows:[linha]};
   }
   throw Error('SQL não esperado: '+sql);
 });
 const pool={connect:async()=>({query,release(){}})} as unknown as pg.Pool;
 const a=await confirmarMedicosDaConta(pool,'base',['Bruno Souza']);
 const b=await confirmarMedicosDaConta(pool,'base',['Dr. Bruno Souza']);
 expect(a).toMatchObject({ok:true,medicos:[{id:'bruno-id'}]});
 expect(b).toMatchObject({ok:true,medicos:[{id:'bruno-id'}]});
 expect(inserts).toBe(1);
 expect(medicos.filter(m=>m.id==='bruno-id')).toHaveLength(1);
});

it('configuração explícita de alvo sem perfil preserva origem da descoberta da mesma conversa',async()=>{
 const {origemConfiguracaoAgendaNaConversa}=await import('../src/conta/medicos-conta.js');
 const row={medico_id:'origem',nome_completo:'Allan Severo (teste Noto)',texto:JSON.stringify({fonte:'amplimed',profissionais:['Allan Severo (teste Noto)']})};
 const query=vi.fn(async()=>({rows:[row]}));const pool={query} as unknown as pg.Pool;
 expect(await origemConfiguracaoAgendaNaConversa(pool,'alvo','conversa','Quero associar Allan Severo (teste Noto) à Amplimed')).toBe('origem');
 const sql=String((query.mock.calls as unknown as any[][])[0]![0]);
 expect(sql).toContain('fonte.conta_id=alvo.conta_id');expect(sql).toContain('cm.conversa=$2');expect(sql).toContain('not exists(select 1 from medico_perfil_fiscal');
 expect(await origemConfiguracaoAgendaNaConversa(pool,'alvo','conversa','Emitir notas de Allan Severo (teste Noto) na Amplimed')).toBe('alvo');
 expect(await origemConfiguracaoAgendaNaConversa(pool,'alvo','conversa','Quero associar à Amplimed')).toBe('alvo');
 query.mockResolvedValueOnce({rows:[row,{...row,medico_id:'outra-origem'}]});
 expect(await origemConfiguracaoAgendaNaConversa(pool,'alvo','conversa','Quero associar Allan Severo (teste Noto) à Amplimed')).toBe('alvo');
 query.mockResolvedValueOnce({rows:[{...row,texto:JSON.stringify({fonte:'tribemd',profissionais:['Allan Severo (teste Noto)']})}]});
 expect(await origemConfiguracaoAgendaNaConversa(pool,'alvo','conversa','Quero associar Allan Severo (teste Noto) à Amplimed')).toBe('alvo');
});
