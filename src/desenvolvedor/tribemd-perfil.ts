import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
export type EstadoNavegador = Awaited<ReturnType<BrowserContext['storageState']>>;
export interface PerfilTribemd {
 email?:string;senha?:string;estado?:EstadoNavegador;
 urlPortal?:string;nomeAgenda?:string;provedor?:string;
 cofre?:{ativo:boolean;estado:'salvo'|'conectado'|'desconectado'|'atencao';consentimentoEm:string;consentimentoVersao?:string;atualizadoEm:string;verificadoEm?:string;codigo?:string};
}
// Único conteúdo persistido: envelope autenticado. Nenhum perfil Chromium em disco.
export class PerfisTribemd {
 private chave:Buffer;
 constructor(private raiz:string, chaveBase64:string) {
  this.raiz=resolve(raiz); this.chave=Buffer.from(chaveBase64,'base64');
  if(this.chave.length!==32||this.chave.toString('base64')!==chaveBase64) throw Error('TRIBEMD_TESTE_CHAVE deve conter 32 bytes em base64.');
 }
 private id(clinica:string) {
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(clinica)) throw Error('CLINICA_INVALIDA');
  return createHash('sha256').update(clinica).digest('hex');
 }
 private arquivo(clinica:string){return join(this.raiz,this.id(clinica)+'.enc');}
 async bloquear(clinica:string) {
  await mkdir(this.raiz,{recursive:true,mode:0o700});
  const trava=join(this.raiz,this.id(clinica)+'.lock');
  try{await mkdir(trava,{mode:0o700});}catch{throw Error('PERFIL_OCUPADO');}
  return async()=>{await rm(trava,{recursive:true,force:true});};
 }
 async ler(clinica:string):Promise<PerfilTribemd> {
  let texto:string;
  try{texto=await readFile(this.arquivo(clinica),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {};throw Error('PERFIL_LEITURA_FALHOU');}
  try {
   const e=JSON.parse(texto), dec=createDecipheriv('aes-256-gcm',this.chave,Buffer.from(e.iv,'base64'));
   if(e.v!==1)throw Error();
   dec.setAAD(Buffer.from('tribemd-perfil-v1:'+this.id(clinica)));dec.setAuthTag(Buffer.from(e.tag,'base64'));
   const claro=Buffer.concat([dec.update(Buffer.from(e.dados,'base64')),dec.final()]);
   try{return JSON.parse(claro.toString());}finally{claro.fill(0);}
  }catch{throw Error('PERFIL_INTEGRA_INVALIDA');}
 }
 async salvar(clinica:string,perfil:PerfilTribemd) {
  await mkdir(this.raiz,{recursive:true,mode:0o700});
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.chave,iv);
  c.setAAD(Buffer.from('tribemd-perfil-v1:'+this.id(clinica)));
  const claro=Buffer.from(JSON.stringify(perfil));let dados:Buffer;
  try{dados=Buffer.concat([c.update(claro),c.final()]);}finally{claro.fill(0);}
  const destino=this.arquivo(clinica),tmp=destino+'.'+randomBytes(8).toString('hex')+'.tmp';
  try{await writeFile(tmp,JSON.stringify({v:1,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),dados:dados.toString('base64')}),{mode:0o600,flag:'wx'});await rename(tmp,destino);}
  finally{await rm(tmp,{force:true});}
 }
 async esquecer(clinica:string){await rm(this.arquivo(clinica),{force:true});}
}
