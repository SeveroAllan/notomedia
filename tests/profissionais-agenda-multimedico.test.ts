import {expect,it,vi} from 'vitest';
import {descobrirProfissionaisParaConta,filtrarConsultasDoProfissional,profissionaisIdentificados} from '../src/agenda/profissionais-agenda.js';
import {normalizarResultadoAgenda,type FonteAgenda} from '../src/agenda/fonte-agenda.js';
import {sincronizarAgenda} from '../src/agenda/sincronizar-agenda.js';

const consultas=[
 {pacienteId:'p1',idExterno:'1',dataHora:'2026-10-20T10:00:00Z',status:'realizada' as const,valorConsultaCentavos:10000,nomeAoVivo:'Paciente Sigiloso',profissional:'Dra. Ana Lima'},
 {pacienteId:'p2',idExterno:'2',dataHora:'2026-10-20T11:00:00Z',status:'realizada' as const,valorConsultaCentavos:12000,nomeAoVivo:'Outro Paciente',profissional:'Dr Bruno Souza'}
];

it('TribeMD preserva profissional por consulta e descoberta retorna somente nomes',()=>{
  const normalizado=normalizarResultadoAgenda({tipo:'consultas',fonte:'tribemd',consultas});
  expect(normalizado.tipo).toBe('consultas');
  if(normalizado.tipo!=='consultas')return;
  expect(normalizado.consultas[0]?.profissional).toBe('Dra. Ana Lima');
  const nomes=profissionaisIdentificados(normalizado.consultas);
  expect(nomes).toEqual(['Dra. Ana Lima','Dr Bruno Souza']);
  expect(JSON.stringify(nomes)).not.toMatch(/Paciente Sigiloso|Outro Paciente/);
  expect(descobrirProfissionaisParaConta('tribemd',normalizado.consultas,true)).toEqual({tipo:'profissionais',nomes});
});

it('Amplimed multi-médico falha fechado porque o leitor atual não identifica profissional por consulta',()=>{
  expect(descobrirProfissionaisParaConta('amplimed',consultas,true))
    .toEqual({tipo:'bloqueada',motivo:'PROFISSIONAL_NAO_IDENTIFICADO'});
});

it('conta de um médico preserva o comportamento anterior sem exigir campo profissional',()=>{
  expect(descobrirProfissionaisParaConta('amplimed',[],false)).toEqual({tipo:'nao_necessaria'});
  expect(filtrarConsultasDoProfissional([{...consultas[0],profissional:undefined}],'Ana Lima',false))
    .toMatchObject({ok:true,consultas:[expect.objectContaining({idExterno:'1'})]});
});

it('multi-médico filtra somente consultas do foco e recusa consulta sem profissional',()=>{
  expect(filtrarConsultasDoProfissional(consultas,'Ana Lima',true))
    .toMatchObject({ok:true,consultas:[expect.objectContaining({idExterno:'1'})]});
  expect(filtrarConsultasDoProfissional([{...consultas[0],profissional:undefined}],'Ana Lima',true))
    .toEqual({ok:false,motivo:'PROFISSIONAL_NAO_IDENTIFICADO'});
});

it('sincronização bloqueada por profissional não grava consulta em médico errado',async()=>{
  const fonte:FonteAgenda={consultar:vi.fn(async()=>({tipo:'consultas' as const,fonte:'tribemd',consultas}))};
  const salvar=vi.fn(async()=>{});
  const resolverPaciente=vi.fn(async()=>{throw new Error('NAO_DEVERIA_RESOLVER');});
  const resultado=await sincronizarAgenda(
    {medicoId:'m1',referenciaCofre:'m1'},
    fonte,
    {salvar},
    resolverPaciente,
    cs=>({ok:false as const,codigo:'PROFISSIONAL_AMBIGUO' as const})
  );
  expect(resultado).toEqual({tipo:'erro',codigo:'PROFISSIONAL_AMBIGUO'});
  expect(salvar).not.toHaveBeenCalled();
  expect(resolverPaciente).not.toHaveBeenCalled();
});
