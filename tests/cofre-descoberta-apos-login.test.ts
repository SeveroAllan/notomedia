import { describe,expect,it } from 'vitest';
import { nomesDaLeituraAutenticada } from '../src/cofre/router.js';
import type { ResultadoLeituraTribemd } from '../src/desenvolvedor/tribemd-navegador.js';

const leitura=(estado:'intervalo_carregado_pelo_portal'|'somente_linhas_visiveis')=>({
  cobertura:estado,pagina:'agenda',historicoCompleto:false,detalhe:'leitura feita no portal',
  agenda:{limitado:false,intervalo:{inicio:'2026-08-01',fim:'2026-11-02'}},
  detalhes:{pendentes:0},consultas:[
    {profissional:'Dra. Alice Silva',pacienteId:'paciente-nunca-exposto',nome:'Paciente Sigiloso'},
    {profissional:'Dr. Bruno Costa',pacienteId:'outro-paciente'},
    {profissional:'Médico 6133'},
    {profissional:null}
  ]
}) as unknown as ResultadoLeituraTribemd;

describe('retomada pós-login só usa a leitura autenticada real',()=>{
  it('retorna apenas nomes profissionais, sem pacientes ou marcador provisório',()=>{
    const nomes=nomesDaLeituraAutenticada(leitura('intervalo_carregado_pelo_portal'));
    expect(nomes).toEqual(['Dra. Alice Silva','Dr. Bruno Costa']);
    expect(JSON.stringify(nomes)).not.toMatch(/Paciente|pacienteId|6133/);
  });
  it('nenhuma descoberta sem recorte completo, sem detalhes ou sem leitura',()=>{
    expect(nomesDaLeituraAutenticada(leitura('somente_linhas_visiveis'))).toEqual([]);
    expect(nomesDaLeituraAutenticada(null)).toEqual([]);
    const parcial=leitura('intervalo_carregado_pelo_portal');
    parcial.detalhes={pendentes:1} as any;
    expect(nomesDaLeituraAutenticada(parcial)).toEqual([]);
  });
});
