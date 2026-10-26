import {expect,it,vi} from 'vitest';
import type pg from 'pg';
import {PostgresAtendimentoRepositorio} from '../src/io/postgres/postgres-atendimento-repositorio.js';
import {linkCertificadoMedico,resolverMedicosPorNomes} from '../src/conta/medicos-conta.js';
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
