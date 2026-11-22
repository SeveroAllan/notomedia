import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { prepararAtendimentoTeste, registrarAtendimentoTeste } from '../src/io/postgres/postgres-atendimento-teste.js';

async function executar():Promise<void> {
  const escopo=config.atendimentoTesteWhatsApp;
  if (!escopo) throw new Error('ATENDIMENTO_TESTE_DESLIGADO');
  const args=process.argv.slice(2);
  const arquivo=args[0]==='--tomador-arquivo' ? args.splice(0,2)[1] : undefined;
  const [pacienteId,servicoId,dataHora,centavos,modo,hash,...extras]=args;
  if (extras.length || (modo !== '--previa' && modo !== '--confirmar') || (modo === '--previa' && hash))
    throw new Error('USO_ATENDIMENTO_TESTE_INVALIDO');
  if (arquivo && !config.atendimentoTesteTomadorConfigurado) throw new Error('CRIPTOGRAFIA_TESTE_INDISPONIVEL');
  const telefone=config.envioRealAllowlist![0]!;
  const dados={pacienteId,servicoId,dataHora,valorCentavos:Number(centavos),
    ...(arquivo ? {tomador:JSON.parse(await readFile(arquivo,'utf8'))} : {})};
  const previa=prepararAtendimentoTeste(escopo,dados,telefone,config.appPepper);
  if (modo==='--previa') {
    const {tomador,...metadados}=previa;
    console.log(JSON.stringify({contaId:escopo.contaId,medicoId:escopo.medicoId,agendamentoId:escopo.agendamentoId,
      ...metadados,tomadorIncluido:Boolean(tomador)}));
    return;
  }
  if (hash!==previa.aprovacaoHash) throw new Error('APROVACAO_ATENDIMENTO_TESTE_DIVERGENTE');
  const pool=new pg.Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:5000});
  try {
    await registrarAtendimentoTeste(pool,escopo,dados,telefone,hash,{pepper:config.appPepper,criptografia:config.encryptionKey});
    console.log('ATENDIMENTO_TESTE_APROVADO_REGISTRADO');
  } finally { await pool.end(); }
}

void executar().catch(()=>{
  console.error('ATENDIMENTO_TESTE_NAO_REGISTRADO');
  process.exitCode=1;
});
