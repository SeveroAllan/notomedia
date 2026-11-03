import { describe, expect, it } from 'vitest';
import { diagnosticarDescobertaTribemd, explicarLeituraPendente } from '../src/agenda/diagnostico-descoberta.js';
import { nomesDaLeituraAutenticada } from '../src/cofre/router.js';
import type { ResultadoLeituraTribemd } from '../src/desenvolvedor/tribemd-navegador.js';

const leitura=()=>({
  cobertura:'intervalo_carregado_pelo_portal',
  pagina:'agenda',historicoCompleto:false,
  detalhe:'DADOS DE PACIENTE QUE NAO PODEM IR PARA LOG',
  agenda:{limitado:false,intervalo:{inicio:'2026-10-01',fim:'2026-11-03'}},
  detalhes:{pendentes:0},
  consultas:[
    {profissional:'Dra. Alice Silva',nome:'Paciente sigiloso',cpf:'52998224725'},
    {profissional:'Dr. Bruno Costa',nome:'Outro paciente'},
    {profissional:'Médico 6133',nome:'Terceiro paciente'},
    {profissional:null,nome:'Quarto paciente'}
  ]
}) as unknown as ResultadoLeituraTribemd;

describe('diagnostico instantaneo no callback antes do TTL de 5 minutos',()=>{
  it('so libera nomes verificados e gera agregados sem PII',()=>{
    const r=diagnosticarDescobertaTribemd(leitura());
    expect(r.nomesComprovados).toEqual(['Dra. Alice Silva','Dr. Bruno Costa']);
    expect(r.diagnostico).toMatchObject({
      cobertura:'intervalo_carregado_pelo_portal',consultasLidas:4,
      consultasComProfissional:3,nomesExtraidos:3,nomesValidados:2,
      nomesFiltrados:1,detalhesPendentes:0,leituraConfiavelParaDescoberta:true
    });
    const diag=JSON.stringify(r.diagnostico);
    for(const proibido of ['Alice','Bruno','Paciente','cpf','52998224725','6133','DETALHES DE PACIENTE'])
      expect(diag).not.toContain(proibido);
    expect(nomesDaLeituraAutenticada(leitura())).toEqual(r.nomesComprovados);
  });
  it('cobertura so de linhas visiveis bloqueia nomes sem alegar ausencia',()=>{
    const dado=leitura();dado.cobertura='somente_linhas_visiveis' as any;
    const r=diagnosticarDescobertaTribemd(dado);
    expect(r.nomesComprovados).toEqual([]);
    expect(r.diagnostico.causas).toContain('COBERTURA_PARCIAL');
    expect(explicarLeituraPendente(r.diagnostico)).toMatch(/parte da agenda/);
  });
  it('agenda limitada nao prova ausencia de medicos',()=>{
    const dado=leitura();dado.agenda!.limitado=true;
    const r=diagnosticarDescobertaTribemd(dado);
    expect(r.diagnostico.causas).toContain('AGENDA_LIMITADA');
    expect(r.nomesComprovados).toEqual([]);
    expect(explicarLeituraPendente(r.diagnostico)).toMatch(/limitou/);
  });
  it('detalhes pendentes e detalhes indisponiveis sao motivos distintos',()=>{
    const pend=leitura();pend.detalhes!.pendentes=2;
    expect(diagnosticarDescobertaTribemd(pend).diagnostico.causas).toContain('DETALHES_PENDENTES');
    expect(diagnosticarDescobertaTribemd(pend).nomesComprovados).toEqual([]);
    const aus=leitura();delete (aus as any).detalhes;
    const r=diagnosticarDescobertaTribemd(aus);
    expect(r.diagnostico.causas).toContain('DETALHES_NAO_DISPONIVEIS');
    expect(r.diagnostico.detalhesDisponiveis).toBe(false);
    expect(r.nomesComprovados).toEqual([]);
  });
  it('sem consultas no recorte nao significa agenda vazia',()=>{
    const dado=leitura();dado.consultas=[];
    const r=diagnosticarDescobertaTribemd(dado);
    expect(r.diagnostico.causas).toContain('SEM_CONSULTAS_NO_RECORTE');
    expect(explicarLeituraPendente(r.diagnostico)).toMatch(/nao significa|não significa/);
    expect(r.nomesComprovados).toEqual([]);
  });
  it('consultas sem nomes e nomes rejeitados tem diagnosticos diferentes',()=>{
    const dado=leitura();dado.consultas=[{nome:'Paciente protegido'}] as any;
    const a=diagnosticarDescobertaTribemd(dado);
    expect(a.diagnostico.causas).toContain('SEM_IDENTIFICACAO_PROFISSIONAL');
    dado.consultas=[{profissional:'Médico 6133'}] as any;
    const b=diagnosticarDescobertaTribemd(dado);
    expect(b.diagnostico.causas).toContain('NOMES_NAO_VALIDOS');
    expect(b.diagnostico).toMatchObject({nomesExtraidos:1,nomesFiltrados:1,nomesValidados:0});
    expect(b.nomesComprovados).toEqual([]);
  });
  it('sem resultado nao tenta reconstruir a leitura expirada',()=>{
    const r=diagnosticarDescobertaTribemd(null);
    expect(r.diagnostico).toMatchObject({cobertura:'ausente',consultasLidas:0,nomesExtraidos:0});
    expect(r.diagnostico.causas).toContain('SEM_RESULTADO');
    expect(r.nomesComprovados).toEqual([]);
  });
});
