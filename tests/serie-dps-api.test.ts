import {describe,it,expect} from 'vitest';
import {validarDadosDps} from '../src/fiscal/preparacao/validar-dados-dps.js';
import type {EmissaoInput,ConfigPrestador} from '../src/io/fiscal/montar-dps.js';
describe('série DPS no canal aplicativo próprio',()=>{
  const input={tomador:{CPF:'11144477735',xNome:'Pessoa Ficticia'},nDPS:'1'} as EmissaoInput;
  const cfg={cnpj:'11144477735',ambiente:2,codMunicipio:'4205407'} as ConfigPrestador;
  it.each(['50000','69999','70000','79999','80000','99999'])('bloqueia %s antes de transmitir',serie=>{
    expect(validarDadosDps(input,{...cfg,serie})).toEqual(expect.arrayContaining([expect.objectContaining({campo:'serie'})]));
  });
  it.each(['0','00001','49999'])('aceita %s',serie=>{
    expect(validarDadosDps(input,{...cfg,serie}).filter(e=>e.campo==='serie')).toEqual([]);
  });
});
