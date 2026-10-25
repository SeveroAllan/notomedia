import {expect,it} from 'vitest';
import {resumirValoresAgenda} from '../src/onboarding/resumo-valores-agenda.js';
it('separa valores por status, sem confundir agenda, realizados, recebido e notas',()=>{
 const r=resumirValoresAgenda([{status:'realizada',valorCentavos:25000},{status:'cancelada',valorCentavos:10000},{status:'agendada',valorCentavos:12000}]);
 expect(r.todos.totalCentavos).toBe(47000);expect(r.realizadas.totalCentavos).toBe(25000);expect(r.canceladas.totalCentavos).toBe(10000);
 expect(r.recebido.disponivel).toBe(false);expect(r.notasFiscais.disponivel).toBe(false);
});
it('nulo, ausente ou inválido não vira zero nem um total completo',()=>{
 const r=resumirValoresAgenda([{status:'realizada',valorCentavos:25000},{status:'realizada',valorCentavos:null},{status:'realizada'},{status:'realizada',valorCentavos:-1}]);
 expect(r.realizadas).toMatchObject({consultas:4,comValor:1,semValor:3,subtotalCentavos:25000,totalCentavos:null});
});
it('zero explícito é conhecido, soma insegura é recusada',()=>{
 expect(resumirValoresAgenda([{status:'realizada',valorCentavos:0}]).realizadas.totalCentavos).toBe(0);
 expect(resumirValoresAgenda([{status:'realizada',valorCentavos:Number.MAX_SAFE_INTEGER},{status:'realizada',valorCentavos:1}]).realizadas.totalCentavos).toBeNull();
});

import {resultadoConsultaAgenda} from '../src/onboarding/resumo-valores-agenda.js';
it.each(['quantidade','valor_agenda','valor_realizado','valor_recebido','valor_notas','valor_indefinido'])('handler preserva medida estruturada %s e não bloqueia fala final com lista assinada',medida=>{
 const r=resultadoConsultaAgenda({consultas:[{status:'realizada',valorCentavos:null},{status:'cancelada',valorCentavos:10000}],desde:'2026-10-19',ate:'2026-10-24',medida,fala:['Lista antiga']});
 expect(r).not.toHaveProperty('falaAssinada');expect(r.dados.medida).toBe(medida);
 expect(r.dados.valoresAgenda.realizadas.totalCentavos).toBeNull();expect(r.dados.valoresAgenda.recebido.disponivel).toBe(false);
});
it('handler mantém lista e seus limites no pedido original de listar',()=>{
 const r=resultadoConsultaAgenda({consultas:[],desde:'2026-10-19',ate:'2026-10-24',medida:'lista',fala:['Nenhuma consulta no período.']});
 expect(r.falaAssinada).toEqual(['Nenhuma consulta no período.']);expect(r.dados.total).toBe(0);
});
