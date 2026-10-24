import {expect,it} from 'vitest';
import {selecionarDias,selecaoConsultas} from '../src/agenda/selecao-consultas.js';
import {prepararLoteAmplimed} from '../src/agenda/amplimed-lote.js';
const e=(paciente:string,id:string)=>({paciente,idExterno:id,dataHora:'2026-10-23T14:00:00-03:00',valorCentavos:35000,detalhe:{nome:paciente,cpf:'10000000019',celular:null}});
const dias=[{data:'2026-10-24',elegiveis:[e('Paciente Teste Um','24')]},{data:'2026-10-23',elegiveis:[e('Paciente Teste Cinco','23'),e('Paciente Teste Um','23um')]}];
it('seleção literal única não amplia dia ou pessoa na listagem nem nos itens fiscais',()=>{
 const selecao=selecaoConsultas('Só a consulta do Teste Um de 23/10/2026. Pode conferir antes de emitir?','2026-10-23');
 const r=selecionarDias(dias,selecao);expect(r).toHaveLength(1);expect(r[0].elegiveis.map(e=>e.idExterno)).toEqual(['23um']);
 expect(prepararLoteAmplimed(r).consultas.map(c=>c.idExterno)).toEqual(['23um']);
});
it('paciente ausente resulta vazio sem voltar a todos',()=>expect(selecionarDias(dias,selecaoConsultas('consulta do Teste Dois de 23/10','2026-10-23'))[0].elegiveis).toEqual([]));
it('nome aproximado não corresponde; prefixo Paciente e acentos normalizam sem aproximação',()=>{
 expect(selecionarDias(dias,{dia:'2026-10-23',paciente:{nome:'Teste U',evidencia:'Teste U'}})[0].elegiveis).toEqual([]);
 expect(selecionarDias(dias,{dia:'2026-10-23',paciente:{nome:'Téste Um',evidencia:'Téste Um'}})[0].elegiveis).toHaveLength(1);
});
it('evidência inventada ou nome diferente do literal é recusado',()=>{
 expect(()=>selecaoConsultas('consulta do Teste Um de 23/10',null,{nome:'Teste Cinco',evidencia:'Teste Cinco'})).toThrow();
 expect(()=>selecaoConsultas('consulta do Teste Um de 23/10 e Teste Cinco',null,{nome:'Teste Cinco',evidencia:'Teste Cinco'})).toThrow();
});
it('consulta do dia não é interpretada como nome',()=>expect(selecaoConsultas('consulta do dia 23/10','2026-10-23')).toEqual({dia:'2026-10-23'}));
