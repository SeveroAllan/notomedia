import {expect,it,vi} from 'vitest';
import type pg from 'pg';
import {resolverReferenciaAgendaConta,vincularReferenciaAgendaConta} from '../src/conta/referencia-agenda-conta.js';

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
