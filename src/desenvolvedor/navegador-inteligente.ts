/**
 * Navegador especializado: a IA escolhe um controle de NAVEGAÇÃO observado;
 * o Playwright executa apenas links e controles de navegação autorizados.
 * O modelo não lê texto de consultas, prontuários, CPF, cookies ou senhas.
 */
import type { Page } from 'playwright-core';
import { z } from 'zod';

export type PortalAgendamento = 'tribemd'|'amplimed';
export type ObjetivoNavegacao = 'abrir_agenda'|'localizar_profissionais';
export interface OpcaoNavegacao {
  indice:number;
  tipo:'link'|'controle';
  nome:string;
  destino?:string;
}
export const escolhaNavegacaoSchema=z.object({
  acao:z.enum(['selecionar','encerrar']),
  indice:z.number().int().nonnegative().max(19).nullable()
}).strict();
export type EscolhaNavegacao=z.infer<typeof escolhaNavegacaoSchema>;
export type PlanejadorNavegacao=(entrada:{
  portal:PortalAgendamento;objetivo:ObjetivoNavegacao;
  opcoes:OpcaoNavegacao[];
})=>Promise<EscolhaNavegacao|null>;

const NAVIGAVEL=/\b(agenda|calend[aá]rio|profissionais?|m[eé]dicos?|filtro|selecionar\s+(?:m[eé]dico|profissional))\b/iu;
const BLOQUEIO=/\b(excluir|deletar|apagar|salvar|confirmar|enviar|emitir|cancelar|novo|cadastrar|alterar|editar|assinar|pagamento|comprar|importar|exportar|desconectar|sair)\b/iu;
const dominios:Record<PortalAgendamento,string>={tribemd:'app.tribemd.com',amplimed:'app.amplimed.com.br'};

export function filtrarOpcoesNavegacao(
  portal:PortalAgendamento,observadas:Omit<OpcaoNavegacao,'indice'>[]
):OpcaoNavegacao[]{
  const destinoPermitido=(destino:string|undefined):boolean=>{
    if(!destino)return true;
    try{
      const url=new URL(destino);
      return url.protocol==='https:'&&url.hostname===dominios[portal] &&
        (portal==='tribemd'
          ? ['/atendimentos/agenda','/profissionais','/profissional','/medicos']
          : ['/agenda','/profissionais','/profissional','/medicos'])
          .some(rota=>url.pathname===rota||url.pathname.startsWith(rota+'/')) &&
        !url.username&&!url.password&&!url.search&&!url.hash;
    }catch{return false;}
  };
  return observadas.filter(o=>
    typeof o.nome==='string'&&o.nome.length>0&&o.nome.length<=65&&
    NAVIGAVEL.test(o.nome)&&!BLOQUEIO.test(o.nome)&&destinoPermitido(o.destino)
  ).slice(0,20).map((o,i)=>({...o,indice:i}));
}

/**
 * Não aceita opção indicada pelo modelo sem revalidar os controles e URL.
 * No máximo três decisões; nenhuma ação de escrita é oferecida.
 */
export async function navegarComAgente(
  page:Page,portal:PortalAgendamento,objetivo:ObjetivoNavegacao,
  planejar:PlanejadorNavegacao,limite=3
):Promise<'navegou'|'sem_acao'>{
  if(!Number.isInteger(limite)||limite<1||limite>3)return 'sem_acao';
  let navegou=false;
  for(let passo=0;passo<limite;passo++){
    let opcoes:OpcaoNavegacao[];
    try{
      if(new URL(page.url()).hostname!==dominios[portal])return navegou?'navegou':'sem_acao';
      const observadas=await page.evaluate(()=>{
        return Array.from(document.querySelectorAll('a[href],button,[role="tab"]'))
          .filter((el):el is HTMLElement=>el instanceof HTMLElement&&el.getClientRects().length>0)
          .slice(0,150).map(el=>({
            tipo:el.tagName.toLowerCase()==='a'?'link' as const:'controle' as const,
            nome:(el.getAttribute('aria-label')||el.innerText||'').trim().replace(/\s+/g,' ').slice(0,80),
            ...(el.tagName.toLowerCase()==='a' && el.getAttribute('href') ?
              {destino: new URL(el.getAttribute('href')!,location.href).href}:{})
          }));
      });
      opcoes=filtrarOpcoesNavegacao(portal,observadas);
      if(!opcoes.length)return navegou?'navegou':'sem_acao';
      const decisao=escolhaNavegacaoSchema.safeParse(await planejar({portal,objetivo,opcoes}));
      if(!decisao.success||decisao.data.acao==='encerrar')return navegou?'navegou':'sem_acao';
      const escolha=opcoes[decisao.data.indice??-1];
      if(!escolha)return navegou?'navegou':'sem_acao';
      if(escolha.tipo==='link'&&escolha.destino){
        await page.goto(escolha.destino,{waitUntil:'domcontentloaded',timeout:12_000});
      }else{
        // Texto do controle deve continuar visível e não ambíguo.
        const candidatos=page.getByRole(escolha.tipo==='controle'?'button':'link',{name:escolha.nome,exact:true});
        if(await candidatos.count()!==1)return navegou?'navegou':'sem_acao';
        await candidatos.click({timeout:5_000});
      }
      navegou=true;
    }catch{
      return navegou?'navegou':'sem_acao';
    }
  }
  return navegou?'navegou':'sem_acao';
}
