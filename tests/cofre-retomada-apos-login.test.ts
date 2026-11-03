import { randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { CofreTribemd } from '../src/cofre/tribemd-cofre.js';
import { NavegadorTribemd, type ResultadoLeituraTribemd } from '../src/desenvolvedor/tribemd-navegador.js';
import { diagnosticarDescobertaTribemd } from '../src/agenda/diagnostico-descoberta.js';

const credencial={email:'teste@example.invalid',senha:'segredo-ficticio-nunca-em-log'};
const parcial=():ResultadoLeituraTribemd=>({
  pagina:'agenda',cobertura:'somente_linhas_visiveis',historicoCompleto:false,
  detalhe:'dados clínicos que não serão registrados',
  consultas:[{nome:'Paciente Privado',profissional:'Dra. Alice Silva',
      ultimaConsulta:null,evidencia:'consulta_realizada_observada'}]
});
const completa=():ResultadoLeituraTribemd=>({
  ...parcial(),cobertura:'intervalo_carregado_pelo_portal',
  agenda:{limitado:false,intervalo:{inicio:'2026-10-01',fim:'2026-11-03'}} as any,
  detalhes:{selecionadas:1,processadas:1,pendentes:0,comPendencias:0,incluiAtendidos:true},
  consultas:[{nome:'Paciente Privado',profissional:'Dra. Alice Silva',
      ultimaConsulta:null,evidencia:'consulta_realizada_observada'}]
});
const criados:Array<{cofre:CofreTribemd;diretorio:string}>=[];
afterEach(async()=>{
  for(const item of criados.splice(0)) {
    await item.cofre.encerrar();
    await rm(item.diretorio,{recursive:true,force:true});
  }
  vi.restoreAllMocks();
});
async function rodar(respostas:Array<ResultadoLeituraTribemd|Error>){
  const diretorio=await mkdtemp(join(tmpdir(),'noto-retomada-'));
  const aoConcluir=vi.fn().mockResolvedValue(undefined);
  const cofre=new CofreTribemd({
    diretorio,chave:randomBytes(32).toString('base64'),
    chromium:'/nunca-abre',aoConcluir
  });
  criados.push({diretorio,cofre});
  let proximo=0;
  const ler=vi.fn(async()=>{
    const atual=respostas[Math.min(proximo++,respostas.length-1)]!;
    if(atual instanceof Error)throw atual;
    return atual;
  });
  const criar=vi.spyOn(NavegadorTribemd,'criar').mockResolvedValue({
    abrir:async()=> 'aguardando_credenciais',
    entrar:async()=>undefined,
    ler,perfil:async()=>({cookies:[],origins:[]}),
    estaAutenticado:()=>true,encerrar:async()=>undefined
  } as unknown as NavegadorTribemd);
  await cofre.iniciar('conta-a',credencial);
  await vi.waitFor(()=>expect(aoConcluir).toHaveBeenCalledOnce());
  return {cofre,ler,criar,aoConcluir};
}
describe('callback de conexão continua descoberta na MESMA sessão sem nova mensagem',()=>{
  it('leitura parcial recuperada apresenta apenas nome comprovado; um navegador, um callback',async()=>{
    const r=await rodar([parcial(),completa()]);
    expect(r.ler).toHaveBeenCalledTimes(2);
    expect(r.criar).toHaveBeenCalledTimes(1);
    expect(r.aoConcluir).toHaveBeenCalledExactlyOnceWith('conta-a',true);
    const d=diagnosticarDescobertaTribemd(r.cofre.resultado('conta-a'));
    expect(d.nomesComprovados).toEqual(['Dra. Alice Silva']);
    expect(d.diagnostico.recuperacaoPontual).toBe('MELHOROU');
    expect(JSON.stringify(d.diagnostico)).not.toMatch(/Paciente|Alice|senha|Privado/);
  });
  it('recorte ainda parcial faz apenas duas leituras, sem inventar médico',async()=>{
    const r=await rodar([parcial(),parcial()]);
    expect(r.ler).toHaveBeenCalledTimes(2);
    expect(r.criar).toHaveBeenCalledTimes(1);
    expect(r.aoConcluir).toHaveBeenCalledTimes(1);
    const d=diagnosticarDescobertaTribemd(r.cofre.resultado('conta-a'));
    expect(d.nomesComprovados).toEqual([]);
    expect(d.diagnostico).toMatchObject({
      recuperacaoPontual:'SEM_MELHORIA',cobertura:'somente_linhas_visiveis'
    });
  });
  it('erro na tentativa pontual preserva a leitura anterior e a conexão',async()=>{
    const r=await rodar([parcial(),new Error('detalhe de paciente jamais em log')]);
    expect(r.ler).toHaveBeenCalledTimes(2);
    expect(r.aoConcluir).toHaveBeenCalledTimes(1);
    expect((await r.cofre.status('conta-a')).estado).toBe('conectado');
    const d=diagnosticarDescobertaTribemd(r.cofre.resultado('conta-a'));
    expect(d.nomesComprovados).toEqual([]);
    expect(d.diagnostico.recuperacaoPontual).toBe('FALHOU');
  });
  it('falha da primeira leitura não dispara a segunda; callback identifica acesso confirmado sem nomes',async()=>{
    const r=await rodar([new Error('LEITURA_HTTP_ERRO')]);
    expect(r.ler).toHaveBeenCalledTimes(1);
    expect(r.criar).toHaveBeenCalledTimes(1);
    expect(r.aoConcluir).toHaveBeenCalledExactlyOnceWith('conta-a',true);
    expect(r.cofre.resultado('conta-a')).toBeNull();
    expect((await r.cofre.status('conta-a')).codigo).toBe('LEITURA_NAO_CONCLUIDA');
  });
  it('leitura completa não faz segundo acesso nem repete callback',async()=>{
    const r=await rodar([completa()]);
    expect(r.ler).toHaveBeenCalledTimes(1);
    expect(r.criar).toHaveBeenCalledTimes(1);
    expect(r.aoConcluir).toHaveBeenCalledTimes(1);
    expect(diagnosticarDescobertaTribemd(r.cofre.resultado('conta-a')).nomesComprovados)
      .toEqual(['Dra. Alice Silva']);
  });
});
