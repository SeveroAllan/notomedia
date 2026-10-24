import {expect,it} from 'vitest';
import {selecionarDias,selecaoConsultas,mesmoPacienteSelecionado,confirmaSelecaoAnterior} from '../src/agenda/selecao-consultas.js';
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

it('separa nome literal do dia relativo sem rejeitar a evidência correta',()=>{
 for(const frase of ['Quero listar só a consulta do Paciente Teste Um de hoje, 24/10/2026, antes de emitir.', 'consulta do Paciente Teste Um de ontem', 'consulta do Paciente Teste Um hoje']) {
  const selecao=selecaoConsultas(frase,'2026-10-24',{nome:'Paciente Teste Um',evidencia:'Paciente Teste Um'});
  expect(selecao.paciente?.nome).toBe('Paciente Teste Um');
  expect(selecionarDias(dias,selecao)[0].elegiveis.map(e=>e.idExterno)).toEqual(['24']);
 }
});

it('confirmação pode repetir só o mesmo paciente com seleção anterior comprovada',()=>{
 const atual=selecaoConsultas('Sim, pode emitir essa única nota de R$250 da consulta do Paciente Teste Um de 24/10/2026. Envie o PDF só para mim aqui.','2026-10-24').paciente;
 expect(mesmoPacienteSelecionado(atual,{nome:'Teste Um',evidencia:'Teste Um'})).toBe(true);
 expect(mesmoPacienteSelecionado(atual,{nome:'Teste Cinco',evidencia:'Teste Cinco'})).toBe(false);
 expect(mesmoPacienteSelecionado(atual,undefined)).toBe(false);
});

it('dia diferente e seleção anterior ausente não podem confirmar outra proposta',()=>{
 const paciente={nome:'Teste Um',evidencia:'Teste Um'};
 expect(confirmaSelecaoAnterior({dia:'2026-10-24',paciente},{dia:'2026-10-24',paciente})).toBe(true);
 expect(confirmaSelecaoAnterior({dia:'2026-10-23',paciente},{dia:'2026-10-24',paciente})).toBe(false);
 expect(confirmaSelecaoAnterior({paciente},undefined)).toBe(false);
});

it.each(['às 9h','às 09:00','às 9h00'])('horário literal separa duas consultas no mesmo dia: %s',hora=>{
 const consultas=[{data:'2026-10-24',elegiveis:[{...e('Teste Um','cedo'),dataHora:'2026-10-24T08:30:00-03:00'},{...e('Teste Um','certa'),dataHora:'2026-10-24T12:00:00Z'}]}];
 const sel=selecaoConsultas(`consulta do Teste Um de hoje ${hora}`,'2026-10-24',{nome:'Teste Um',evidencia:'Teste Um'});
 expect(sel.horario).toBe('09:00');expect(selecionarDias(consultas,sel)[0].elegiveis.map(x=>x.idExterno)).toEqual(['certa']);
 expect(prepararLoteAmplimed(selecionarDias(consultas,sel)).consultas.map(x=>x.idExterno)).toEqual(['certa']);
});
it('hora inexistente não volta a todas e duas horas pedem esclarecimento',()=>{
 expect(selecionarDias(dias,{horario:'09:00'})[0].elegiveis).toEqual([]);
 expect(()=>selecaoConsultas('a das 9h ou 10h')).toThrow('HORARIO_AMBIGUO');
 expect(()=>selecaoConsultas('a das 25h')).toThrow('HORARIO_AMBIGUO');
 expect(confirmaSelecaoAnterior({paciente:{nome:'Teste Um',evidencia:'Teste Um'},horario:'10:00'},{paciente:{nome:'Teste Um',evidencia:'Teste Um'},horario:'09:00'})).toBe(false);
});

it.each(['mais recente','último','primeiro','mais antigo'])('ordem natural %s escolhe uma consulta do paciente, não do conjunto',ordem=>{
 const dias=[{data:'2026-10-24',elegiveis:[{...e('Teste Um','tarde'),dataHora:'2026-10-24T15:00:00-03:00'},{...e('Teste Dois','outro'),dataHora:'2026-10-24T16:00:00-03:00'}]},{data:'2026-10-23',elegiveis:[e('Teste Um','cedo')]}];
 const sel=selecaoConsultas(`Confira ${ordem==='primeiro'?'o primeiro atendimento':`o atendimento ${ordem}`} do Teste Um neste mês`,undefined,{nome:'Teste Um',evidencia:'Teste Um'});
 const esperada=['mais recente','último'].includes(ordem)?'tarde':'cedo';
 expect(selecionarDias(dias,sel).flatMap(d=>d.elegiveis).map(e=>e.idExterno)).toEqual([esperada]);
 expect(prepararLoteAmplimed(selecionarDias(dias,sel)).consultas.map(e=>e.idExterno)).toEqual([esperada]);
});
it('ordinal sem paciente, datas inválidas e empate não escolhem arbitrariamente',()=>{
 expect(()=>selecaoConsultas('Confira só o atendimento mais recente')).toThrow('PACIENTE_NECESSARIO');
 const sel=selecaoConsultas('mais recente do Teste Um',undefined,{nome:'Teste Um',evidencia:'Teste Um'});
 expect(()=>selecionarDias([{data:'2026-10-23',elegiveis:[e('Teste Um','a'),e('Teste Um','b')]}],sel)).toThrow('CONSULTA_AMBIGUA');
 expect(()=>selecionarDias([{data:'2026-10-23',elegiveis:[{...e('Teste Um','a'),dataHora:undefined}]}],sel)).toThrow('HORARIO_NAO_IDENTIFICADO');
});

it('primeiro como anúncio não altera seleção',()=>expect(selecaoConsultas('Mostre primeiro qual consulta encontrou e o valor, sem emitir').ordem).toBeUndefined());

it('não muda ordinal na confirmação e empate em outros pacientes não interfere',()=>{
 const paciente={nome:'Teste Um',evidencia:'Teste Um'};
 expect(confirmaSelecaoAnterior({paciente,ordem:'mais_antigo'},{paciente,ordem:'mais_recente'})).toBe(false);
 const sel=selecaoConsultas('mais recente Teste Um',undefined,paciente);
 const dados=[{data:'2026-10-23',elegiveis:[e('Teste Um','a'),e('Teste Dois','b')]}];
 expect(selecionarDias(dados,sel)[0].elegiveis.map(x=>x.idExterno)).toEqual(['a']);
 expect(()=>selecaoConsultas('mais recente ou mais antigo Teste Um',undefined,paciente)).toThrow('ORDEM_AMBIGUA');
});

it.each(['último mês','última semana','último lote','última proposta'])('referência %s não é ordinal de consulta',termo=>expect(selecaoConsultas(`Quero conferir o ${termo}`).ordem).toBeUndefined());
