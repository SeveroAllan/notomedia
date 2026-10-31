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
  expect(descobrirProfissionaisParaConta('tribemd',normalizado.consultas)).toEqual({tipo:'profissionais',nomes});
});

it('Amplimed continua falhando fechado porque o leitor atual não identifica profissional por consulta',()=>{
  expect(descobrirProfissionaisParaConta('amplimed',consultas))
    .toEqual({tipo:'bloqueada',motivo:'PROFISSIONAL_NAO_IDENTIFICADO'});
});

it('mesmo com um único médico cadastrado, consulta sem profissional não é atribuída por suposição',()=>{
  expect(filtrarConsultasDoProfissional([{...consultas[0],profissional:undefined}],'Ana Lima'))
    .toEqual({ok:false,motivo:'PROFISSIONAL_NAO_IDENTIFICADO'});
});

it('mesmo com um único médico cadastrado, consulta de outro profissional não é persistida nele',()=>{
  expect(filtrarConsultasDoProfissional([{...consultas[1]}],'Ana Lima'))
    .toEqual({ok:false,motivo:'PROFISSIONAL_AMBIGUO'});
});

it('filtro aceita somente consultas identificadas do médico em foco e não mistura outro profissional',()=>{
  expect(filtrarConsultasDoProfissional(consultas,'Ana Lima'))
    .toMatchObject({ok:true,consultas:[expect.objectContaining({idExterno:'1'})]});
});

it('sincronização bloqueada por profissional não resolve paciente nem grava consulta em médico errado',async()=>{
  const fonte:FonteAgenda={consultar:vi.fn(async()=>({tipo:'consultas' as const,fonte:'tribemd',consultas}))};
  const salvar=vi.fn(async()=>{});
  const resolverPaciente=vi.fn(async()=>{throw new Error('NAO_DEVERIA_RESOLVER');});
  const resultado=await sincronizarAgenda(
    {medicoId:'m1',referenciaCofre:'m1'},
    fonte,
    {salvar},
    resolverPaciente,
    cs=>{const r=filtrarConsultasDoProfissional(cs,'Médico que não aparece');return r.ok?{ok:true as const,consultas:r.consultas}:{ok:false as const,codigo:r.motivo};}
  );
  expect(resultado).toEqual({tipo:'erro',codigo:'PROFISSIONAL_AMBIGUO'});
  expect(salvar).not.toHaveBeenCalled();
  expect(resolverPaciente).not.toHaveBeenCalled();
});
