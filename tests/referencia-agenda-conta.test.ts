import {expect,it,vi} from 'vitest';
import type pg from 'pg';
import {resolverReferenciaAgendaConta,vincularReferenciaAgendaConta,revalidarVinculoProfissionalAmplimed} from '../src/conta/referencia-agenda-conta.js';

it('resolve conexão-fonte da agenda para o médico selecionado',async()=>{
 const query=vi.fn(async()=>({rows:[{referencia_medico_id:'fonte'}]}));
 expect(await resolverReferenciaAgendaConta({query} as unknown as pg.Pool,'alvo','tribemd')).toBe('fonte');
 expect(String((query.mock.calls as unknown as any[][])[0]![0])).toMatch(/fonte\.conta_id=alvo\.conta_id/);
});

it('sem vínculo explícito usa o próprio médico como referência',async()=>{
 const query=vi.fn(async()=>({rows:[]}));
 expect(await resolverReferenciaAgendaConta({query} as unknown as pg.Pool,'alvo','tribemd')).toBe('alvo');
});

it('vínculo só grava alvos da mesma conta da conexão-fonte',async()=>{
 const query=vi.fn(async()=>({rows:[{medico_id:'m1'},{medico_id:'m2'}]}));
 expect(await vincularReferenciaAgendaConta({query} as unknown as pg.Pool,['m1','m2'],'tribemd','fonte')).toBe(true);
 const sql=String((query.mock.calls as unknown as any[][])[0]![0]);
 expect(sql).toContain('join fonte f on f.conta_id=m.conta_id');
 expect(sql).toContain('on conflict (medico_id,agenda) do update');
});

it('falha fechado se nem todos os médicos puderem ser vinculados',async()=>{
 const query=vi.fn(async()=>({rows:[{medico_id:'m1'}]}));
 expect(await vincularReferenciaAgendaConta({query} as unknown as pg.Pool,['m1','m2'],'tribemd','fonte')).toBe(false);
});

it('revalidação na leitura aprova vínculo com nome igual (normalizado)',async()=>{
 const query=vi.fn(async(sql:unknown)=>{
  if(String(sql).includes('noto_medico_agenda_referencias'))return{rows:[{referencia_medico_id:'fonte',profissional_externo_id:'1121812'}]};
  return{rows:[{nome_completo:'Allan Severo (teste Noto)'}]};
 });
 const deps={listarProfissionaisAmplimed:vi.fn(async()=>({ok:true as const,profissionais:[{codigo:1121812,nome:'allan severo (TESTE noto)'}]}))};
 await expect(revalidarVinculoProfissionalAmplimed({query} as unknown as pg.Pool,deps,'alvo'))
  .resolves.toEqual({status:'ok',profissionalExternoId:'1121812'});
 expect(deps.listarProfissionaisAmplimed).toHaveBeenCalledWith('alvo');
});

it('revalidação falha fechado quando a agenda mostra outro nome para o código (rename)',async()=>{
 const query=vi.fn(async(sql:unknown)=>{
  if(String(sql).includes('noto_medico_agenda_referencias'))return{rows:[{referencia_medico_id:'fonte',profissional_externo_id:'1121812'}]};
  return{rows:[{nome_completo:'Allan Severo (teste Noto)'}]};
 });
 const deps={listarProfissionaisAmplimed:vi.fn(async()=>({ok:true as const,profissionais:[{codigo:1121812,nome:'Bruna Botter'}]}))};
 await expect(revalidarVinculoProfissionalAmplimed({query} as unknown as pg.Pool,deps,'alvo'))
  .resolves.toEqual({status:'divergente',nomeAgenda:'Bruna Botter'});
});

it('revalidação falha fechado quando o código some da lista de profissionais',async()=>{
 const query=vi.fn(async(sql:unknown)=>{
  if(String(sql).includes('noto_medico_agenda_referencias'))return{rows:[{referencia_medico_id:'fonte',profissional_externo_id:'1121812'}]};
  return{rows:[{nome_completo:'Allan Severo (teste Noto)'}]};
 });
 const deps={listarProfissionaisAmplimed:vi.fn(async()=>({ok:true as const,profissionais:[{codigo:999,nome:'Outro'}]}))};
 await expect(revalidarVinculoProfissionalAmplimed({query} as unknown as pg.Pool,deps,'alvo'))
  .resolves.toEqual({status:'divergente',nomeAgenda:null});
});

it('revalidação falha fechado quando a lista de profissionais não abre',async()=>{
 const query=vi.fn(async(sql:unknown)=>{
  if(String(sql).includes('noto_medico_agenda_referencias'))return{rows:[{referencia_medico_id:'fonte',profissional_externo_id:'1121812'}]};
  return{rows:[{nome_completo:'Allan Severo (teste Noto)'}]};
 });
 const deps={listarProfissionaisAmplimed:vi.fn(async()=>({ok:false as const,motivo:'LEITURA_INDISPONIVEL'}))};
 await expect(revalidarVinculoProfissionalAmplimed({query} as unknown as pg.Pool,deps,'alvo'))
  .resolves.toEqual({status:'indisponivel'});
});

it('sem vínculo na leitura mantém status sem_vinculo (fluxo atual inalterado)',async()=>{
 const query=vi.fn(async()=>({rows:[]}));
 const deps={listarProfissionaisAmplimed:vi.fn(async()=>({ok:false as const,motivo:'X'}))};
 await expect(revalidarVinculoProfissionalAmplimed({query} as unknown as pg.Pool,deps,'alvo'))
  .resolves.toEqual({status:'sem_vinculo'});
 expect(deps.listarProfissionaisAmplimed).not.toHaveBeenCalled();
});
