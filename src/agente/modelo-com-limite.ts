import type pg from 'pg';
import type {Model,ModelProvider} from '@openai/agents';
import {
  reservarCustoPiloto,liquidarCustoPiloto,consumoVerificado,
  PausaCustoPiloto
} from './limite-gasto-rodada.js';

/** Intercepta CADA requisição do Agents SDK, não apenas o resultado do Runner.
 * Assim tool calls que exigem novos turnos e retries do Runner voltam a
 * reservar orçamento; o token usage só liquida a reserva depois da resposta.
 */
class ModeloComOrcamento implements Model{
  constructor(private readonly real:Model,
    private readonly banco:pg.Pool,private readonly modelo:string){}
  async getResponse(request:Parameters<Model['getResponse']>[0]){
    const reserva=await reservarCustoPiloto(this.banco,'conversa',this.modelo);
    try{
      const resposta=await this.real.getResponse(request);
      await liquidarCustoPiloto(this.banco,reserva,consumoVerificado(resposta.usage));
      return resposta;
    }catch(erro){
      // Se o provedor pode ter cobrado, reter a reserva inteira. Não estourar
      // orçamento por falha de rede nem inventar consumo zero.
      await liquidarCustoPiloto(this.banco,reserva,null);
      throw erro;
    }
  }
  getStreamedResponse(_request:Parameters<Model['getStreamedResponse']>[0]):
    ReturnType<Model['getStreamedResponse']>{
    // O piloto não usa streaming; impedir caminho que pule contabilidade.
    throw new PausaCustoPiloto('CONTROLE_INDISPONIVEL');
  }
}
/** Provedor decorador mantém o SDK original e suas ferramentas. */
export class ProvedorAgenteComOrcamento implements ModelProvider{
  constructor(private readonly real:ModelProvider,private readonly banco:pg.Pool){}
  async getModel(nome?:string):Promise<Model>{
    if(nome!=='gpt-4o-mini')throw new PausaCustoPiloto('MODELO_SEM_PRECO');
    const modelo=await this.real.getModel(nome);
    return new ModeloComOrcamento(modelo,this.banco,nome);
  }
}
