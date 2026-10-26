import type { ConsultaEmpresa, ConsultaRegistro } from './consultas.js';
import { enriquecerCadastro } from './enriquecer-cadastro.js';
import type { PostgresCadastro } from './postgres-cadastro.js';
export class CadastroCertificado {
 private executando=false;
 constructor(readonly repo:PostgresCadastro,private empresa:ConsultaEmpresa,private registro:ConsultaRegistro,
  private identificarTitular:(medicoId:string,certificadoId:string)=>Promise<string|undefined>,private consultarCpf?:(cpf:string)=>Promise<{nome:string}|null>,private pesquisaOnlineConfigurada=false,private provedorPesquisa?:'openserp',
  private aoConcluir?:(medicoId:string)=>Promise<void>|void){}
 agendar(entrada:{medicoId:string;certificadoId:string;documentoTitular?:string}):Promise<void>{return this.repo.agendar(entrada);}
 async recuperar():Promise<void>{
  if(this.executando)return;this.executando=true;
  try{
   await this.repo.agendarAtivos();
   if(this.pesquisaOnlineConfigurada)await this.repo.agendarPesquisaProfissional(this.provedorPesquisa);
   for(let i=0;i<5;i++){
    const r=await this.repo.reservar();if(!r)break;
   console.info('[Cadastro automático]',{etapa:'processamento_iniciado',trabalhoId:r.trabalho.id,medicoId:r.trabalho.medico_id,tentativa:r.trabalho.tentativas});
    try{
     if(!r.trabalho.documento_titular&&!r.trabalho.dados.cadastroIndisponivel)await this.repo.documento(r,await this.identificarTitular(r.trabalho.medico_id,r.trabalho.certificado_id));
     const resultado=await enriquecerCadastro({documento:r.trabalho.documento_titular,perfil:r.perfil,dados:r.trabalho.dados},this.empresa,this.registro,this.consultarCpf);
     await this.repo.aplicar(r,resultado);
     if(resultado.estado==='concluido')await this.aoConcluir?.(r.trabalho.medico_id);
     console.info('[Cadastro automático]',{etapa:'resultado_tratado',trabalhoId:r.trabalho.id,resultadoPrevisto:resultado.estado,origemEmpresa:resultado.dados.empresa?.origem??null,candidatos:resultado.dados.empresa?.candidatos.length??0,pesquisaCrm:resultado.dados.pesquisaProfissional?.estado??null,codigo:resultado.codigo??resultado.dados.pesquisaProfissional?.codigo??null});
    }catch{await this.repo.aplicar(r,{estado:'retentar',dados:r.trabalho.dados,codigo:'CADASTRO_PROCESSAMENTO_FALHOU'});}
   }
  }finally{this.executando=false;}
 }
}
