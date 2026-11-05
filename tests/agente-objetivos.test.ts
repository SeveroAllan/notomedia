import {describe,it,expect,vi} from 'vitest';
import {ScriptedModel,assistantMessage,functionCall} from '@openai/agents/testing';
import {lerObjetivos,planejarObjetivos,type ObjetivosNoto} from '../src/agente/objetivos.js';
import {responderAgente} from '../src/agente/agente.js';
import type {EstadoConversa} from '../src/agente/estado-conversa.js';

const ANA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRUNO='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const prof=[{id:ANA,nome:'Dra. Ana Souza'},{id:BRUNO,nome:'Dr. Bruno Lima'}];
const dt='2026-11-04T12:00:00.000Z';
const obj=(tipo:'concluir_cadastro'|'acompanhar_fiscal',medicoId:string,status:'ativo'|'pausado'='ativo')=>({
  tipo,medicoId,status,origem:'solicitacao_operador' as const,criadoEm:dt,atualizadoEm:dt
});
describe('objetivos duráveis: planejamento a partir da operação comprovada',()=>{
  const cadastro:ObjetivosNoto={['concluir_cadastro:'+ANA]:obj('concluir_cadastro',ANA)};
  it('só aceita objetivos whitelist e não propaga informações de pacientes',()=>{
    const res=lerObjetivos({
      ['concluir_cadastro:'+ANA]:{...obj('concluir_cadastro',ANA),paciente:'NÃO PODE',telefone:'NÃO PODE'},
      ['acompanhar_fiscal:'+BRUNO]:{...obj('acompanhar_fiscal',BRUNO),origem:'injetada'},
      ['concluir_cadastro:outro']:{...obj('concluir_cadastro',ANA)}
    });
    expect(Object.keys(res)).toEqual(['concluir_cadastro:'+ANA]);
    expect(JSON.stringify(res)).not.toContain('NÃO PODE');
  });
  it('preserva objetivo até depois de reinício e recalcula o próximo passo por evento',()=>{
    const raw=JSON.parse(JSON.stringify(cadastro));
    const etapas=[
      [{estado:'pendente',nome:'Dra. Ana Souza'},'aguardar_pesquisa','pesquisa_publica'],
      [{estado:'manual_pendente',nome:'Dra. Ana Souza'},'oferecer_link_manual','autorizacao_operador'],
      [{estado:'aguardando_preenchimento',nome:'Dra. Ana Souza'},'aguardar_preenchimento','formulario_seguro'],
      [{estado:'aguardando_confirmacao',nome:'Dra. Ana Souza'},'pedir_confirmacao_registro','confirmacao_medico'],
      [{estado:'confirmada',nome:'Dra. Ana Souza'},'verificar_prontidao','consulta_prontidao']
    ] as const;
    for(const [p,proxima,dep] of etapas){
      const [plano]=planejarObjetivos(lerObjetivos(raw),prof,{[ANA]:p as never});
      expect(plano).toMatchObject({profissional:'Dra. Ana Souza',proximoPasso:proxima,
        dependeDe:dep,execucaoFiscalAutorizada:false});
    }
  });
  it('objetivo pausado não age nem vira autorização e outro médico fica isolado',()=>{
    const raw:ObjetivosNoto={
      ['concluir_cadastro:'+ANA]:obj('concluir_cadastro',ANA,'pausado'),
      ['concluir_cadastro:'+BRUNO]:obj('concluir_cadastro',BRUNO)
    };
    const plano=planejarObjetivos(raw,[prof[0]!],{[BRUNO]:{
      nome:'Dr. Bruno Lima',estado:'confirmada',razao:'ENCONTRADO'
    }});
    expect(plano).toHaveLength(1);
    expect(plano[0]).toMatchObject({status:'pausado',proximoPasso:'nenhuma_acao',
      execucaoFiscalAutorizada:false});
  });
  it('trabalhos de um médico não são atribuídos a outro',()=>{
    const raw:ObjetivosNoto={
      ['acompanhar_fiscal:'+ANA]:obj('acompanhar_fiscal',ANA),
      ['acompanhar_fiscal:'+BRUNO]:obj('acompanhar_fiscal',BRUNO)
    };
    const trabalho={tipo:'conferencia_fiscal' as const,agenda:'tribemd' as const,
      estado:'executando' as const,medicoId:BRUNO};
    const p=planejarObjetivos(raw,prof,{},[trabalho],'tribemd');
    expect(p[0]).toMatchObject({profissional:'Dra. Ana Souza',proximoPasso:'consultar_estado_conferencia'});
    expect(p[1]).toMatchObject({profissional:'Dr. Bruno Lima',proximoPasso:'aguardar_conferencia'});
  });
  it('sem comprovação de agenda, não afirma conferência fiscal concluída',()=>{
    const raw:ObjetivosNoto={['acompanhar_fiscal:'+ANA]:obj('acompanhar_fiscal',ANA)};
    const [p]=planejarObjetivos(raw,prof,{},[],undefined);
    expect(p).toMatchObject({proximoPasso:'escolher_agenda',dependeDe:'agenda_autorizada'});
  });
});

describe('intenção contextual registra objetivo sem conceder operação fiscal',()=>{
  async function simular(texto:string,tipo:'concluir_cadastro'|'acompanhar_fiscal',
    decisao:'acompanhar'|'pausar'|'retomar'|'esclarecer',profissional='Ana',
    estadoConversa:EstadoConversa={}){
    const modelo=new ScriptedModel([
      [functionCall('acompanhar_objetivo',{profissional,tipo,decisao},{callId:'objetivo'})],
      [assistantMessage('Já emiti a nota automaticamente e concluí suas obrigações fiscais.')]
    ]);
    const alterarObjetivo=vi.fn().mockResolvedValue({ok:true,estado:'iniciado'});
    const resposta=await responderAgente({texto,profissionais:prof,estadoConversa},{
      modeloTeste:modelo,consultarStatus:vi.fn(),alterarObjetivo
    });
    modelo.assertComplete();
    return {resposta,alterarObjetivo,modelo};
  }
  it('pede acompanhamento naturalmente e registra só o objetivo do médico nomeado',async()=>{
    const r=await simular('Quero que tu cuide da parte fiscal da Ana e vá me mostrando as pendências',
      'acompanhar_fiscal','acompanhar');
    expect(r.alterarObjetivo).toHaveBeenCalledExactlyOnceWith(ANA,'acompanhar_fiscal','acompanhar');
    expect(r.resposta).toContain('Registrei o objetivo');
    expect(r.resposta).not.toContain('Já emiti');
    expect(r.resposta).toMatch(/não autoriza emissão/i);
  });
  it('retomada e pausa são intenções explícitas, não um comando de execução',async()=>{
    for(const decisao of ['pausar','retomar'] as const){
      const r=await simular(decisao==='pausar'?'Pode deixar esse acompanhamento de lado por enquanto':
        'Volta a acompanhar o cadastro da Ana','concluir_cadastro',decisao);
      expect(r.alterarObjetivo).toHaveBeenCalledOnce();
      expect(r.resposta).not.toMatch(/já emiti a nota/i);
    }
  });
  it('com nome ambíguo não registra objetivo nem escolhe médico pela conta',async()=>{
    const r=await simular('Quero acompanhar o fiscal dos médicos','acompanhar_fiscal',
      'acompanhar','um dos médicos');
    expect(r.alterarObjetivo).not.toHaveBeenCalled();
    expect(r.resposta).not.toMatch(/registrei o objetivo|já emiti/i);
  });
  it('esclarecimento não dispara efeito',async()=>{
    const r=await simular('O que significa acompanhar fiscal?', 'acompanhar_fiscal',
      'esclarecer','Ana');
    expect(r.alterarObjetivo).not.toHaveBeenCalled();
  });
});
