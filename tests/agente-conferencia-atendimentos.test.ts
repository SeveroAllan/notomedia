import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { conferirAgendaComFiscal, descreverConferencia } from '../src/agente/conferencia-atendimentos.js';
import { leituraTribemdParaConferencia, leituraAmplimedParaConferencia } from '../src/agente/leitura-atendimentos.js';
import { responderAgente } from '../src/agente/agente.js';

const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRUNO='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const janela={inicio:'2026-10-05',fim:'2026-11-03'};
const consulta = (idExterno:string, profissional:string|null='Dra. Alice Silva', dataHora='2026-10-20T10:00:00-03:00') =>
  ({pacienteId:'PACIENTE-NUNCA-EXPOSTO',idExterno,profissional,dataHora,
    status:'realizada' as const,valorConsultaCentavos:10000});
const leitor = vi.fn().mockResolvedValue({ok:true,agenda:'tribemd',totalRealizados:2,referencias:['tribe-1','tribe-2'],semReferencia:0});
function banco(rows: unknown[] = []) {
  const query=vi.fn(async (sql:string, parametros:unknown[]) => {
    if(sql.startsWith('select nome_completo')) {
      expect(parametros).toEqual([CONTA, ALICE]);
      return {rows:[{nome_completo:'Dra. Alice Silva'}]};
    }
    if(sql.includes('join public.agendamentos a')) {
      expect(parametros).toEqual([CONTA, ALICE,'tribemd',['tribe-1','tribe-2']]);
      return {rows};
    }
    throw Error('SQL_NAO_ESPERADO');
  });
  return {pool:{query} as unknown as pg.Pool,query};
}
describe('reconciliação agenda fiscal somente por vínculo comprovado',()=>{
  it('consulta somente médico do escopo antes de ler portal e compara IDs externos exatos',async()=>{
    const b=banco([
      {referencia_externa:'tribe-1',vinculos:1,solicitacoes:1,notas_autorizadas:1}
    ]);
    const ler=vi.fn().mockResolvedValue({ok:true,agenda:'tribemd',totalRealizados:2,referencias:['tribe-1','tribe-2'],semReferencia:0});
    const result=await conferirAgendaComFiscal(b.pool,CONTA,ALICE,'tribemd',ler);
    expect(result).toMatchObject({ok:true,realizados:2,comVinculoConfirmado:1,
      comSolicitacaoVinculada:1,comNotaAutorizadaVinculada:1,semVinculoConfirmado:1});
    expect(ler).toHaveBeenCalledExactlyOnceWith(ALICE,'Dra. Alice Silva','tribemd');
    expect(b.query.mock.calls[0]![0]).toContain('where conta_id=$1 and id=$2');
    const sql=String(b.query.mock.calls[1]![0]);
    expect(sql).toContain('m.conta_id=$1 and m.id=$2');
    expect(sql).toContain('a.identificacao_profissional_confirmada=true');
    expect(sql).toContain('a.origem=$3 and a.referencia_externa=any($4::text[])');
    expect(sql).toContain('s.id=sna.solicitacao_id and s.medico_id=m.id');
    expect(sql).not.toMatch(/pacientes|cpf|telefone|nome_paciente|valor_servico|data_hora/i);
    const comunicado=descreverConferencia(result);
    expect(comunicado).toContain('Sem vínculo fiscal comprovado aqui: 1');
    expect(comunicado).toContain('Isso não significa que estejam sem nota');
    expect(comunicado).not.toContain('tribe-1');
  });

  it('profissional fora da conta nunca chama o leitor; banco indisponível não informa zero',async()=>{
    const b=banco();
    b.query.mockResolvedValueOnce({rows:[]});
    const ler=vi.fn();
    expect(await conferirAgendaComFiscal(b.pool,CONTA,BRUNO,'tribemd',ler))
      .toEqual({ok:false,motivo:'MEDICO_NAO_CONFIRMADO'});
    expect(ler).not.toHaveBeenCalled();
    const falha=banco();
    falha.query.mockRejectedValueOnce(new Error('DB_DOWN'));
    expect(await conferirAgendaComFiscal(falha.pool,CONTA,ALICE,'tribemd',ler))
      .toEqual({ok:false,motivo:'CONCILIACAO_INDISPONIVEL'});
    expect(ler).not.toHaveBeenCalled();
  });

  it('não confunde ausência de referência com obrigação fiscal nem consulta paciente',async()=>{
    const b=banco();
    const ler=vi.fn().mockResolvedValue({ok:true,agenda:'amplimed',totalRealizados:4,
      referencias:[],semReferencia:4});
    const result=await conferirAgendaComFiscal(b.pool,CONTA,ALICE,'amplimed',ler);
    expect(result).toMatchObject({ok:true,realizados:4,semReferencia:4,comVinculoConfirmado:0});
    expect(b.query).toHaveBeenCalledTimes(1);
    expect(descreverConferencia(result)).not.toMatch(/4 notas? pendentes|4 sem notas?/i);
  });

  it('falha fechada para duplicatas, divergências, contagens inconsistentes e origem trocada',async()=>{
    for(const leitura of [
      {ok:true,agenda:'tribemd',totalRealizados:2,referencias:['id','id'],semReferencia:0},
      {ok:true,agenda:'tribemd',totalRealizados:1,referencias:['id','id2'],semReferencia:0},
      {ok:true,agenda:'amplimed',totalRealizados:1,referencias:['id'],semReferencia:0},
    ]) {
      const b=banco();
      const result=await conferirAgendaComFiscal(b.pool,CONTA,ALICE,'tribemd',
        vi.fn().mockResolvedValue(leitura));
      expect(result.ok).toBe(false);
      expect(b.query).toHaveBeenCalledTimes(1);
    }
    const b=banco([{referencia_externa:'tribe-1',vinculos:2,solicitacoes:1,notas_autorizadas:1}]);
    expect(await conferirAgendaComFiscal(b.pool,CONTA,ALICE,'tribemd',
      vi.fn().mockResolvedValue({ok:true,agenda:'tribemd',totalRealizados:2,
        referencias:['tribe-1','tribe-2'],semReferencia:0})))
      .toEqual({ok:false,motivo:'REFERENCIAS_AMBIGUAS'});
  });

  it('com leitura completa sem correspondência registrada, a situação fica desconhecida, não sem nota',async()=>{
    const b=banco();
    const result=await conferirAgendaComFiscal(b.pool,CONTA,ALICE,'tribemd',
      vi.fn().mockResolvedValue({ok:true,agenda:'tribemd',totalRealizados:2,
        referencias:['tribe-1','tribe-2'],semReferencia:0}));
    expect(result).toMatchObject({ok:true,comVinculoConfirmado:0,comNotaAutorizadaVinculada:0});
    expect(descreverConferencia(result)).toContain('não significa que estejam sem nota');
  });
});

describe('leitura segura sem identificação por suposição',()=>{
  it('TribeMD separa Alice de Bruno pela identidade exata e exige profissional em TODAS as realizadas',()=>{
    const result=leituraTribemdParaConferencia({
      tipo:'consultas',fonte:'tribemd',consultas:[
        consulta('tribe-alice'),consulta('tribe-bruno','Dr. Bruno Lima'),
        consulta('tribe-antiga','Dra. Alice Silva','2026-09-01T10:00:00-03:00')
      ]
    },'Alice Silva',janela);
    expect(result).toEqual({ok:true,agenda:'tribemd',totalRealizados:1,
      referencias:['tribe-alice'],semReferencia:0});
    const errado=leituraTribemdParaConferencia({
      tipo:'consultas',fonte:'tribemd',consultas:[consulta('sem-id',null)]
    },'Dra. Alice Silva',janela);
    expect(errado).toEqual({ok:false,motivo:'IDENTIDADE_INCOMPLETA'});
    expect(leituraTribemdParaConferencia({
      tipo:'erro',codigo:'SINCRONIZACAO_INCOMPLETA'
    },'Dra. Alice Silva',janela)).toEqual({ok:false,motivo:'LEITURA_INCOMPLETA'});
  });

  it('Amplimed soma realizados, mas só considera IDs dos particulares elegíveis do filtro validado',()=>{
    const dias=Array.from({length:30},(_,i)=>{
      const d=new Date('2026-10-05T12:00:00Z');d.setUTCDate(d.getUTCDate()+i);
      const data=d.toISOString().slice(0,10);
      return {data,consultas:i===0?[{status:'realizada' as const},{status:'realizada' as const}]:[],
        elegiveis:i===0?[{idExterno:data+'T09:00|ref-opaca'}]:[]};
    });
    expect(leituraAmplimedParaConferencia(dias,janela)).toEqual({
      ok:true,agenda:'amplimed',totalRealizados:2,referencias:['2026-10-05T09:00|ref-opaca'],semReferencia:1
    });
    expect(leituraAmplimedParaConferencia(dias.slice(1),janela))
      .toEqual({ok:false,motivo:'LEITURA_INCOMPLETA'});
    expect(leituraAmplimedParaConferencia([...dias.slice(1),dias[1]!],janela))
      .toEqual({ok:false,motivo:'LEITURA_INCOMPLETA'});
  });
});

describe('tool calling do agente para conferência fiscal verdadeira',()=>{
  const profissionais=[{id:ALICE,nome:'Dra. Alice Silva'},{id:BRUNO,nome:'Dr. Bruno Lima'}];
  const status=vi.fn().mockResolvedValue({tribemd:{salvo:true,conectada:true},
    amplimed:{salvo:false,conectada:false}});
  it('modelo escolhe ferramenta, backend resolve profissional, e números inventados nunca saem',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('conferir_atendimentos_e_notas',{profissional:'Alice',agenda:'tribemd'},{callId:'comparar'})],
      [assistantMessage('Os 999 pacientes estão com notas pendentes.')]
    ]);
    const consultarConferencia=vi.fn().mockResolvedValue({
      ok:true,agenda:'tribemd',profissional:'Dra. Alice Silva',janelaDias:30,realizados:3,
      comReferencia:3,semReferencia:0,comVinculoConfirmado:2,
      comSolicitacaoVinculada:2,comNotaAutorizadaVinculada:1,
      semVinculoConfirmado:1,limite:'VINCULOS_EXATOS_NAO_COMPROVAM_AUSENCIA_DE_NOTA'
    });
    const resposta=await responderAgente({texto:'Noto, confira a TribeMD da Alice e as notas.',
      profissionais}, {
      modeloTeste:modelo,consultarStatus:status,consultarConferencia
    });
    expect(consultarConferencia).toHaveBeenCalledExactlyOnceWith(ALICE,'tribemd');
    expect(resposta).toContain('Atendimentos realizados identificados: 3');
    expect(resposta).toContain('Com nota autorizada ligada: 1');
    expect(resposta).not.toContain('999');
    expect(resposta).not.toContain('pacientes');
    modelo.assertComplete();
  });

  it('vários profissionais: modelo não escolhe arbitrariamente sem foco do usuário',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('conferir_atendimentos_e_notas',{profissional:'Bruno',agenda:'tribemd'},{callId:'invalida'})],
      [assistantMessage('Sem notas para Bruno.')]
    ]);
    const consultarConferencia=vi.fn();
    const resposta=await responderAgente({
      texto:'Noto, confira os atendimentos da agenda.',
      profissionais
    },{modeloTeste:modelo,consultarStatus:status,consultarConferencia});
    expect(consultarConferencia).not.toHaveBeenCalled();
    expect(resposta).toContain('profissional');
    expect(resposta).not.toContain('Sem notas');
    modelo.assertComplete();
  });

  it('duas agendas conectadas: exige escolha explícita sem repetir leitura',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('conferir_atendimentos_e_notas',{profissional:'Alice',agenda:'tribemd'},{callId:'ambigua'})],
      [assistantMessage('Já conferi duas agendas')]
    ]);
    const consulta=vi.fn();
    const resposta=await responderAgente({
      texto:'Consegue comparar as consultas da Alice com as notas?',
      profissionais
    },{
      modeloTeste:modelo,consultarConferencia:consulta,
      consultarStatus:vi.fn().mockResolvedValue({
        tribemd:{salvo:true,conectada:true},amplimed:{salvo:true,conectada:true}
      })
    });
    expect(consulta).not.toHaveBeenCalled();
    expect(resposta).not.toContain('Já conferi');
    modelo.assertComplete();
  });
});
