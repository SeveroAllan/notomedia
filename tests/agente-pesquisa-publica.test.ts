import {describe,expect,it,vi} from 'vitest';
import type pg from 'pg';
import type {ConsultaRegistro} from '../src/cadastro/consultas.js';
import {
  agendarPesquisaRegistro,executarPesquisaRegistro,extrairSugestoes,
  notificarPesquisaRegistro,descreverPesquisaPublica,leituraPesquisaEstado,
  proporCorrecaoPesquisa,concluirRevisaoPesquisa
} from '../src/agente/pesquisa-profissional-conversa.js';
import {registrarVinculoConversa} from '../src/agente/vinculo-conversa.js';
const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OUTRA='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const nome='Dra. Ana Souza';
const base={nomeCompleto:nome,crm:'12345',uf:'RS',origem:'Google via OpenSerp (sugestão não oficial)',
  urlOrigem:'https://registro.example.test/medico',verificado:true};
const pool=(query:ReturnType<typeof vi.fn>)=>({query} as unknown as pg.Pool);

describe('mesma ConsultaRegistro do cadastro: apenas dados com evidência retornam como sugestão',()=>{
  it('CRM e RQE únicos são propostos, nunca gravados',()=>{
    const r=extrairSugestoes(nome,{estado:'consultado',dados:[{...base,rqe:'980',rqes:['980']}]});
    expect(r).toEqual({razao:'ENCONTRADO',candidatos:[{
      crm:'12345/RS',uf:'RS',rqes:['980'],origem:base.origem,urlOrigem:base.urlOrigem
    }]});
    const texto=descreverPesquisaPublica({contaId:CONTA,medicoId:ANA,nome,pesquisa:{
      nome,estado:'resultado_pronto',razao:r.razao,candidatos:r.candidatos
    }});
    expect(texto).toContain('CRM 12345/RS');
    expect(texto).toContain('RQE 980');
    expect(texto).toMatch(/ainda não salvei/i);
  });
  it('ausência de RQE consultado não vira inexistência',()=>{
    const r=extrairSugestoes(nome,{estado:'consultado',dados:[{...base,rqes:[],rqe:null}]});
    expect(r.candidatos[0]!.rqes).toEqual([]);
    const msg=descreverPesquisaPublica({contaId:CONTA,medicoId:ANA,nome,pesquisa:{
      nome,estado:'resultado_pronto',razao:r.razao,candidatos:r.candidatos
    }});
    expect(msg).toContain('não encontrei RQE comprovado nos resultados consultados');
    expect(msg).not.toContain('não possui RQE');
  });
  it('homônimos com CRM diferentes são mostrados, não escolhidos automaticamente',()=>{
    const r=extrairSugestoes(nome,{estado:'consultado',dados:[base,{...base,crm:'9999'}]});
    expect(r.razao).toBe('HOMONIMOS');
    expect(r.candidatos.map(c=>c.crm)).toEqual(['12345/RS','9999/RS']);
    expect(descreverPesquisaPublica({contaId:CONTA,medicoId:ANA,nome,pesquisa:{
      nome,estado:'resultado_pronto',razao:r.razao,candidatos:r.candidatos
    }})).toContain('informações conflitantes');
  });
  it('fonte indisponível, ausência de resultados e evidência incompleta são distintas',()=>{
    expect(extrairSugestoes(nome,{estado:'indisponivel',codigo:'OPENSERP_HTTP_503'}))
      .toEqual({razao:'FONTE_INDISPONIVEL',candidatos:[]});
    expect(extrairSugestoes(nome,{estado:'nao_encontrado',codigo:'OPENSERP_SEM_RESULTADOS_UTILIZAVEIS'}))
      .toEqual({razao:'SEM_RESULTADO',candidatos:[]});
    expect(extrairSugestoes(nome,{estado:'consultado',dados:[
      {...base,nomeCompleto:'Dr. Bruno Lima'},{...base,uf:'XX'},{...base,verificado:false}
    ]})).toEqual({razao:'EVIDENCIA_INCOMPLETA',candidatos:[]});
    expect(descreverPesquisaPublica({contaId:CONTA,medicoId:ANA,nome,pesquisa:{
      nome,estado:'resultado_pronto',razao:'SEM_RESULTADO'
    }})).toContain('Não significa que não existam');
  });
  it('a leitura dos dados em revisão não aceita campos inesperados nem estado inválido',()=>{
    const parsed=leituraPesquisaEstado({
      [ANA]:{nome,estado:'aguardando_confirmacao',candidatos:[
        {crm:'12345/RS',uf:'RS',rqes:['980'],origem:'OpenSerp',paciente:'NUNCA'},
        {crm:'000/RS',uf:'RS',rqes:['xx'],origem:'incorreto'}
      ],senha:'NUNCA',proposta:{crm:'66666/RS',rqe:'777',origem:'correcao'}},
      [OUTRA]:{nome,estado:'inventado',senha:'NUNCA'}
    });
    expect(parsed[ANA]?.candidatos).toHaveLength(1);
    expect(parsed[ANA]?.proposta).toEqual({crm:'66666/RS',rqe:'777',origem:'correcao'});
    expect(JSON.stringify(parsed)).not.toContain('NUNCA');
    expect(parsed[OUTRA]).toBeUndefined();
  });
});

describe('fila pública isolada, sem serviço externo real ou nova migração',()=>{
  it('insere a pesquisa somente após confirmação exata do médico pela conta e não refaz existente',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{conta_id:CONTA}]})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{1:1}]});
    expect(await agendarPesquisaRegistro(pool(query),CONTA,ANA,nome)).toBe('agendada');
    expect(await agendarPesquisaRegistro(pool(query),CONTA,ANA,nome)).toBe('ja_existe');
    const sql=query.mock.calls[0]![0] as string;
    expect(sql).toContain('m.conta_id=$1');
    expect(sql).toContain('m.id=$2::uuid and m.nome_completo=$4');
    expect(sql).toContain('and not coalesce');
    expect(sql).toContain("coalesce(c.estado->'pesquisasRegistro'");
    expect(query.mock.calls[0]![1]).toEqual([CONTA,ANA,JSON.stringify({nome,estado:'pendente',tentativas:0}),nome]);
  });
  it('a tarefa executa a mesma porta ConsultaRegistro com mock, não repete nem grava perfil',async()=>{
    const query=vi.fn()
      .mockResolvedValueOnce({rows:[{conta_id:CONTA,medico_id:ANA,nome,tentativas:1}]})
      .mockResolvedValueOnce({rows:[{1:1}]})
      .mockResolvedValueOnce({rows:[{conta_id:CONTA}]})
      .mockResolvedValueOnce({rows:[]});
    const consulta={buscar:vi.fn().mockResolvedValue({estado:'consultado',
      dados:[{...base,rqe:null}]})} satisfies ConsultaRegistro;
    expect(await executarPesquisaRegistro(pool(query),consulta)).toBe(true);
    expect(consulta.buscar).toHaveBeenCalledExactlyOnceWith(nome);
    expect(query.mock.calls[1]![1]).toEqual([ANA,CONTA,nome]);
    const payload=JSON.parse(query.mock.calls[2]![1][2] as string);
    expect(payload).toMatchObject({estado:'resultado_pronto',razao:'ENCONTRADO',
      candidatos:[{crm:'12345/RS',rqes:[]}]});
    expect(JSON.stringify(query.mock.calls)).not.toContain('senha');
    expect(await executarPesquisaRegistro(pool(query),consulta)).toBe(false);
    expect(consulta.buscar).toHaveBeenCalledTimes(1);
  });
  it('não consulta OpenSerp quando profissional não corresponde à conta',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{conta_id:CONTA,medico_id:OUTRA,nome,tentativas:1}]})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{conta_id:CONTA}]});
    const consulta={buscar:vi.fn()} as unknown as ConsultaRegistro;
    await executarPesquisaRegistro(pool(query),consulta);
    expect(consulta.buscar).not.toHaveBeenCalled();
  });
  it('a notificação só vai ao operador autorizado, e status não é confundido com entrega',async()=>{
    const item={nome,estado:'resultado_pronto',razao:'ENCONTRADO',candidatos:[{
      crm:'12345/RS',uf:'RS',rqes:[],origem:base.origem
    }]};
    const query=vi.fn().mockResolvedValueOnce({rows:[{
      conta_id:CONTA,medico_id:ANA,nome,item
    }]}).mockResolvedValueOnce({rows:[{1:1}]})
      .mockResolvedValueOnce({rows:[{conta_id:CONTA}]})
      .mockResolvedValueOnce({rows:[]});
    const enviar=vi.fn().mockResolvedValue(true);
    expect(await notificarPesquisaRegistro(pool(query),'5551999998888',enviar)).toBe(true);
    expect(enviar).toHaveBeenCalledExactlyOnceWith('5551999998888',expect.stringContaining('CRM 12345/RS'));
    const status=JSON.parse(query.mock.calls[2]![1][2] as string);
    expect(status).toMatchObject({estado:'aguardando_confirmacao',envio:'aceito_api'});
    expect(await notificarPesquisaRegistro(pool(query),'5551999998888',enviar)).toBe(false);
    expect(enviar).toHaveBeenCalledTimes(1);
  });
  it('sem autorização e sem aceite de API, nenhuma entrega é anunciada ou repetida',async()=>{
    const item={nome,estado:'resultado_pronto',razao:'SEM_RESULTADO'};
    const query=vi.fn().mockResolvedValueOnce({rows:[{conta_id:CONTA,medico_id:ANA,nome,item}]})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{conta_id:CONTA}]});
    const enviar=vi.fn();
    await notificarPesquisaRegistro(pool(query),'5551999998888',enviar);
    expect(enviar).not.toHaveBeenCalled();
    const status=JSON.parse(query.mock.calls[2]![1][2] as string);
    expect(status.envio).toBe('incerto');
  });
  it('correção é proposta, confirmação é etapa separada e escopo está no SQL',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{conta_id:CONTA}]})
      .mockResolvedValueOnce({rows:[{conta_id:CONTA}]});
    expect(await proporCorrecaoPesquisa(pool(query),CONTA,ANA,{crm:'66666/RS',rqe:'777'})).toBe(true);
    expect(query.mock.calls[0]![0]).toContain("estado']='aguardando_confirmacao'");
    expect(query.mock.calls[0]![0]).toContain('m.conta_id=$1');
    const proposta=JSON.parse(query.mock.calls[0]![1][2] as string);
    expect(proposta).toEqual({crm:'66666/RS',rqe:'777',origem:'correcao'});
    expect(await concluirRevisaoPesquisa(pool(query),CONTA,ANA)).toBe(true);
    expect(query.mock.calls[1]![0]).toContain('m.conta_id=$1');
  });
});

describe('persistência de vínculo usa fonte comprovada e identidade da mesma conta',()=>{
  it('registra o ID real e preserva os demais nomes; não nasce de um balão',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{estado:{
      faseAgenda:'CONFIRMACAO_PENDENTE',agendaEscolhida:'tribemd',
      descoberta:{agenda:'tribemd',nomes:[nome,'Dr. Bruno Lima']}
    }}]}).mockResolvedValueOnce({rows:[{conta_id:CONTA}]});
    const r=await registrarVinculoConversa(pool(query),CONTA,'tribemd',{id:ANA,nome});
    expect(r).toMatchObject({ok:true,restantes:['Dr. Bruno Lima']});
    expect(query.mock.calls[1]![0]).toContain('m.conta_id=$1');
    expect(query.mock.calls[1]![0]).toContain("faseAgenda'='CONFIRMACAO_PENDENTE'");
    expect(query.mock.calls[1]![1][1]).toBe(ANA);
  });
  it('sem identidade descoberta ou origem trocada não executa update',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{estado:{
      faseAgenda:'CONFIRMACAO_PENDENTE',
      descoberta:{agenda:'amplimed',nomes:['Dr. Bruno Lima']}
    }}]});
    const r=await registrarVinculoConversa(pool(query),CONTA,'tribemd',{id:ANA,nome});
    expect(r.ok).toBe(false);
    expect(query).toHaveBeenCalledOnce();
  });
});
