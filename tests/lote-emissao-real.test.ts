import { afterEach, expect, it, vi } from 'vitest';
import { PostgresEmissaoLote } from '../src/io/postgres/postgres-emissao-lote.js';
import { PostgresEmissaoApiRepositorio } from '../src/io/postgres/postgres-emissao-api-repositorio.js';
import { PostgresFilaRepositorio } from '../src/io/postgres/postgres-fila-repositorio.js';
import { PostgresEmissorDpsService } from '../src/io/fiscal/postgres-emissor-dps-service.js';
afterEach(() => vi.restoreAllMocks());
const detalhe = {nome:'Pessoa Ficticia',cpf:'52998224725',valorCobradoCentavos:30000,contato:{celular:'11999990000'}};
const chave = (await import('../src/atendimento/comprovante.js')).chaveConsulta('pepper','medico-fixture','tribemd','123');
const assinatura = new (await import('../src/io/postgres/postgres-lotes-emissao.js')).PostgresLotesEmissao({} as any,'pepper').assinatura('medico-fixture','tribemd','123',30000);
const entrada = {medicoId:'medico-fixture',loteId:'l',item:{id:'i',fonte:'tribemd',idExterno:'123',chave,assinatura},detalhe};
function cenario() {
  let ambiente='homologacao';
  let reservada=false,estado='enfileirada';
  const query=vi.fn(async(sql:string,p:unknown[]=[])=>{
    if(sql.includes('select medico_id from solicitacoes_nota'))return {rows:[{medico_id:'medico-fixture'}]};
    if(sql.includes('from public.noto_lotes_itens'))return {rows:[{paciente_id:'p',data_hora:'2026-10-20T12:00:00Z',ambiente,assinatura}]};
    if(sql.includes('select estado from public.noto_emissoes_comprovantes'))return {rows:reservada?[{estado}]:[]};
    if(sql.includes('insert into public.noto_emissoes_comprovantes')) {reservada=true;return {rows:[{id:'reserva'}],rowCount:1};}
    if(sql.includes("set estado='emitindo'")){if(estado!=='enfileirada')return{rows:[],rowCount:0};estado='emitindo';return{rows:[{id:'r'}],rowCount:1};}
    return {rows:[],rowCount:1};
  });
  let trava=Promise.resolve();
  const pool={query,connect:async()=>{let soltar=()=>{};return {release:vi.fn(),query:async(sql:string,p:unknown[]=[])=>{
    if(sql==='begin') {const anterior=trava;trava=new Promise<void>(r=>{soltar=r;});await anterior;}
    const r=await query(sql,p);if(sql==='commit'||sql==='rollback')soltar();return r;
  }};}};
  const permitido=vi.fn(async()=>true);
  const repo=new PostgresEmissaoLote(pool as any,'chave-fixture','pepper',permitido);
  const enfileirar=vi.spyOn(PostgresEmissaoApiRepositorio.prototype,'enfileirarSolicitacao').mockResolvedValue({id:'s'});
  vi.spyOn(PostgresEmissaoApiRepositorio.prototype,'buscarPerfilFiscalMedico').mockResolvedValue({medicoId:'medico-fixture',nomeCompleto:'Clara Almeida Ficticia',crm:'123',ctribNacPadrao:'040101',configuracaoCompleta:true});
  const registrar=vi.spyOn(PostgresFilaRepositorio.prototype,'registrarSucesso').mockImplementation(async()=>{estado='nota_gerada';});
  const emitir=vi.fn(async()=>({sucesso:true as const,chaveAcesso:'chave-fiscal',ndps:1,serie:'1',competencia:'2026-10-20',dataEmissao:new Date('2026-10-20'),valorServicosCentavos:30000,xmlStoragePath:'fixture.xml',pdfStoragePath:'fixture.pdf'}));
  const entregar=vi.fn(async()=> 'enviado' as const);
  return{query,repo,enfileirar,registrar,emitir,entregar,permitido,executor:{emissorDps:{emitir},entregar},setAmbiente:(v:string)=>{ambiente=v;},setEstado:(v:string)=>{reservada=true;estado=v;}};
}
it('emite pela fila existente, com tomador transitório e contato do MESMO detalhe; reexecução não reemite',async()=>{
  const c=cenario();
  expect(await c.repo.emitir(entrada,c.executor)).toEqual({estado:'emitida',entrega:'enviado',semContato:false});
  expect(c.enfileirar).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({origem:'lote',ref:'lote:i',pacienteId:'p',valorServicoCentavos:30000,contatoPaciente:'11999990000'}),expect.anything());
  expect(c.emitir).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:'s',emissaoComprovante:true,tomadorAoVivo:detalhe}));
  expect(c.registrar).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({solicitacaoId:'s',emissaoComprovante:true,xmlStoragePath:'fixture.xml',pdfStoragePath:'fixture.pdf'}));
  expect(c.entregar).toHaveBeenCalledExactlyOnceWith('medico-fixture','s');
  expect(await c.repo.emitir(entrada,c.executor)).toEqual({estado:'ja_faturada'});
  expect(c.emitir).toHaveBeenCalledOnce();expect(c.query.mock.calls.some(([sql])=>/update pacientes|insert into pacientes/.test(sql))).toBe(false);
  expect(JSON.stringify(c.enfileirar.mock.calls)).not.toMatch(/Pessoa Ficticia|52998224725/);
});
it.each(['emitindo','enfileirada','erro'])('reserva compartilhada %s bloqueia emissão por outro lote/comprovante',async estado=>{
  const c=cenario();c.setEstado(estado);expect(await c.repo.emitir(entrada,c.executor)).toEqual({estado:'repetida'});
  expect(c.emitir).not.toHaveBeenCalled();expect(c.enfileirar).not.toHaveBeenCalled();
});
it('gate fechado não cria solicitação nem emite',async()=>{
 const c=cenario();c.permitido.mockResolvedValue(false);expect(await c.repo.emitir(entrada,c.executor)).toEqual({estado:'erro'});expect(c.query).not.toHaveBeenCalled();expect(c.emitir).not.toHaveBeenCalled();
});
it('falha fiscal conserva reserva e nunca envia PDF nem dispara retentativa',async()=>{
 const c=cenario();c.emitir.mockResolvedValue({sucesso:false,erro:'detalhe tecnico privado'} as any);
 const falha=vi.spyOn(PostgresFilaRepositorio.prototype,'registrarFalhaComprovante').mockResolvedValue();
 expect(await c.repo.emitir(entrada,c.executor)).toEqual({estado:'erro'});expect(falha).toHaveBeenCalledOnce();expect(c.entregar).not.toHaveBeenCalled();expect(c.registrar).not.toHaveBeenCalled();
});
it('contatos divergentes não impedem emissão, mas ficam fora da entrega agregada',async()=>{
 const c=cenario();const r=await c.repo.emitir({...entrada,detalhe:{...detalhe,contato:{celular:'11999990000',telefone:'11888880000'}}},c.executor);
 expect(r).toMatchObject({estado:'emitida',semContato:true});expect(c.enfileirar.mock.calls[0][0].contatoPaciente).toBeNull();expect(c.entregar).not.toHaveBeenCalled();
});
it('tomador de lote não lê cadastro/cache: ausência ou valor divergente recusa antes da DPS',async()=>{
 const query=vi.fn();const emissor=new PostgresEmissorDpsService({query} as any,'chave-fixture');
 const item={id:'s',medicoId:'m',pacienteId:'p',xdescServ:'Consulta',valorServicoCentavos:30000,ctribNac:'040101',emissaoComprovante:true as const,origemLote:true as const};
 expect(await emissor.emitir(item)).toMatchObject({sucesso:false,codigoErroSefin:'TOMADOR_AO_VIVO_INVALIDO'});
 expect(await emissor.emitir({...item,tomadorAoVivo:{...detalhe,valorCobradoCentavos:40000}})).toMatchObject({sucesso:false,codigoErroSefin:'TOMADOR_AO_VIVO_INVALIDO'});
 expect(query).not.toHaveBeenCalled();
});
it.each(['sucesso','rejeicao'])('DPS real usa dados transitórios e protege diagnóstico SEFIN sem alterar a emissão: %s',async caso=>{
 const cert=await import('../src/io/fiscal/carregar-certificado-medico.js');
 const chaves=await import('../src/io/fiscal/extrair-chaves-certificado.js');
 const assinaturaXml=await import('../src/io/fiscal/assinar-xml-dps.js');
 const perfil={ambiente:'homologacao',confirmado:true,opcao:'me_epp',regime:'regime_1',especial:0,municipio:'4205407',serie:'1',referencia:null};
 const politica={origem:'revisao_onboarding',confirmadoEm:'2026-10-20T12:00Z',perfil,ctribNac:'040101',cnbs:null,ctribMun:null,
   parametros:{ambiente:'homologacao',vigenciaInicio:'2020-01-01',municipioPrestacao:'4205407',opcaoSimplesNacional:'me_epp',regimeApuracaoSn:'regime_1',regimeEspecialTributacao:0,tribISSQN:1,tpRetISSQN:1,cstPisCofins:'08',percentualTotTribSN:6}};
 const query=vi.fn(async(sql:string)=>{
  if(sql.includes('from medicos m join solicitacoes_nota'))return{rows:[{nome_completo:'Clara Almeida Ficticia',crm:'123/SC'}]};
  if(sql.includes('from medico_perfil_fiscal pf'))return{rows:[{nome_completo:'Clara Almeida Ficticia',razao_social:'Clinica Ficticia',documento_limpo:'11222333000181',uf:'SC',cod_municipio_ibge:'4205407',serie_dps:'1',ambiente:'homologacao',opcao_simples_nacional:'me_epp',regime_apuracao_sn:'regime_1'}]};
  if(sql.includes('from solicitacoes_nota s join medico_perfil_fiscal'))return{rows:[{...perfil,servicos:[{id:'servico',ctribNac:'040101',cnbs:null,ctribMun:null,politica}]}]};
  if(sql.includes('max(ndps)'))return{rows:[{proximo:1}]};
  throw Error('A emissão de lote não pode ler ou escrever paciente');
 });
 vi.spyOn(cert,'carregarCertificadoMedico').mockResolvedValue({id:'cert',medicoId:'medico-fixture',pfxBuffer:Buffer.from('fixture'),senhaCertificado:'fixture',arquivoStoragePath:'fixture',validoAte:new Date('2030-01-01')});
 vi.spyOn(chaves,'extrairChavesCertificado').mockReturnValue({pemKey:'fixture',pemCert:'fixture',certBase64:'fixture'});
 const assinar=vi.spyOn(assinaturaXml,'assinarXmlDps').mockImplementation(({xml})=>xml);
 const xmlFiscal='<NFSe><tomador><nome>Pessoa Ficticia</nome><CPF>52998224725</CPF></tomador></NFSe>';
 const transmitirDps=vi.fn(async()=>({sucesso:true,chaveAcesso:'42'.repeat(25),dataAutorizacao:new Date('2026-10-20T15:00Z'),xmlAutorizado:xmlFiscal,respostaRaw:{autorizada:true}}));
 const upload=vi.fn(async()=>({error:null}));
 const emissor=new PostgresEmissorDpsService({query} as any,'key',undefined,undefined,{storage:{from:()=>({upload})}} as any,{transmitirDps} as any,true,true);
 if(caso==='rejeicao') transmitirDps.mockResolvedValue({sucesso:false,codigoErro:'E9999',motivo:'Prestador não habilitado na homologação; CLARA ALMEIDA FICTICIA; Clinica Ficticia; paciente PESSOA FICTICIA; CPF 529.982.247-25; CNPJ 11222333000181; CRM 123/SC; valor 300.00; valor 300,00; <DPS>dados reservados</DPS>'} as any);
 const r=await emissor.emitir({id:'s',medicoId:'medico-fixture',pacienteId:'p',xdescServ:'Consulta',valorServicoCentavos:30000,ctribNac:'040101',emissaoComprovante:true,origemLote:true,tomadorAoVivo:detalhe});
 if(caso==='rejeicao') {
  expect(r).toMatchObject({sucesso:false,codigoErroSefin:'E9999',erro:expect.stringContaining('Prestador não habilitado na homologação')});
  if(r.sucesso) throw Error('Esperava rejeição fiscal');
  expect(r.erro).not.toMatch(/CLARA|ALMEIDA|FICTICIA|Clinica|PESSOA|529|112223|123\/SC|300[.,]00|DPS|dados reservados/i);
  expect(transmitirDps).toHaveBeenCalledOnce();expect(upload).not.toHaveBeenCalled();return;
 }
 if (!r.sucesso) throw Error(JSON.stringify(r));
 expect(r).toMatchObject({sucesso:true,valorServicosCentavos:30000,pdfStoragePath:expect.stringMatching(/^data:application\/pdf;base64,/)});
 expect(transmitirDps).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ambiente:2}));
 expect(assinar.mock.calls[0][0].xml).toContain('<xNome>Pessoa Ficticia</xNome>');expect(assinar.mock.calls[0][0].xml).toContain('<CPF>52998224725</CPF>');
 expect(upload).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('.xml'),Buffer.from(xmlFiscal),expect.anything());
 expect(JSON.stringify(query.mock.calls)).not.toMatch(/from pacientes|update pacientes|insert into pacientes|Pessoa Ficticia|52998224725/);
});
it('reenvio cria nova solicitação para a MESMA nota, captura contato novo sem emitir ou alterar snapshot antigo',async()=>{
 const c=cenario();
 const candidatos=[{id:'i',medico_id:'medico-fixture',id_externo:'123',nota_id:'nota-original',paciente_id:'p',valor_servico_centavos:30000,xdesc_serv:'Consulta',ctrib_nac:'040101'}];
 const ler=vi.fn(async()=>({...detalhe,contato:{celular:'11888880000'}}));
 expect(await c.repo.reenviarSemContato('medico-fixture','evento-reenvio',candidatos,ler,c.entregar)).toEqual({entregues:1,semContato:0,total:1});
 expect(c.enfileirar).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({origem:'lote',contatoPaciente:'11888880000',valorServicoCentavos:30000}),expect.anything());
 expect(c.query.mock.calls.some(([sql,p])=>sql.includes('nota_reenvio_id')&&p?.includes('nota-original'))).toBe(true);
 expect(c.query.mock.calls.some(([sql])=>/update .*contato_paciente_encriptado|insert into notas_fiscais/i.test(sql))).toBe(false);
 expect(c.emitir).not.toHaveBeenCalled();expect(c.registrar).not.toHaveBeenCalled();expect(ler).toHaveBeenCalledExactlyOnceWith('medico-fixture','123');
});

it('12 execuções concorrentes disputam reserva PostgreSQL por consulta: só uma cria e transmite',async()=>{
 const c=cenario();const resultados=await Promise.all(Array.from({length:12},()=>c.repo.emitir(entrada,c.executor)));
 expect(resultados.filter(r=>r.estado==='emitida')).toHaveLength(1);expect(c.enfileirar).toHaveBeenCalledOnce();expect(c.emitir).toHaveBeenCalledOnce();expect(c.registrar).toHaveBeenCalledOnce();expect(c.entregar).toHaveBeenCalledOnce();
});
it('perfil produção bloqueia solicitação mesmo que o gate externo esteja indevidamente aberto',async()=>{
 const c=cenario();c.setAmbiente('producao');expect(await c.repo.emitir(entrada,c.executor)).toEqual({estado:'erro'});
 expect(c.emitir).not.toHaveBeenCalled();expect(c.enfileirar).not.toHaveBeenCalled();
});
it('assinatura/consulta divergentes impedem criar solicitação, mesmo com dados pessoais válidos',async()=>{
 const c=cenario();expect(await c.repo.emitir({...entrada,item:{...entrada.item,chave:'outra'}},c.executor)).toEqual({estado:'erro'});
 expect(await c.repo.emitir({...entrada,detalhe:{...detalhe,valorCobradoCentavos:40000}},c.executor)).toEqual({estado:'erro'});
 expect(c.enfileirar).not.toHaveBeenCalled();expect(c.emitir).not.toHaveBeenCalled();
});
it('queda do gate após captura/reserva não transmite nem entrega',async()=>{
 const c=cenario();c.permitido.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
 expect(await c.repo.emitir(entrada,c.executor)).toEqual({estado:'erro'});expect(c.enfileirar).toHaveBeenCalledOnce();expect(c.emitir).not.toHaveBeenCalled();expect(c.entregar).not.toHaveBeenCalled();
});
it('erro de persistência após autorização conserva reserva e não reemite na reexecução',async()=>{
 const c=cenario();c.registrar.mockRejectedValue(Error('dados privados'));
 expect(await c.repo.emitir(entrada,c.executor)).toEqual({estado:'erro'});
 expect(await c.repo.emitir(entrada,c.executor)).toEqual({estado:'repetida'});expect(c.emitir).toHaveBeenCalledOnce();expect(c.entregar).not.toHaveBeenCalled();
});
it('reentrega do reenvio encontra solicitação existente e não relê agenda nem reenvia',async()=>{
 const c=cenario();vi.spyOn(PostgresEmissaoApiRepositorio.prototype,'buscarPorReferencia').mockResolvedValue({id:'anterior'} as any);
 const ler=vi.fn();await c.repo.reenviarSemContato('medico-fixture','evento',[{id:'i',medico_id:'medico-fixture'}],ler,c.entregar);
 expect(ler).not.toHaveBeenCalled();expect(c.entregar).not.toHaveBeenCalled();expect(c.enfileirar).not.toHaveBeenCalled();
});
it.each(['E9999','SEFIN_TIMEOUT'])('log mantém agregado, código original %s e motivo truncado sem dados pessoais',async codigo=>{
 const c=cenario();const log=vi.spyOn(console,'warn').mockImplementation(()=>{});
 c.emitir.mockResolvedValue({sucesso:false,codigoErroSefin:codigo,erro:'Prestador não habilitado; Pessoa Ficticia CPF 52998224725; email pessoa@example.com; telefone 11999990000; senha=SEGREDO\n'+'Detalhe '.repeat(100)} as any);
 expect(await c.repo.emitir(entrada,c.executor)).toEqual({estado:'erro'});
 const registro=JSON.parse(String(log.mock.calls[0][0]).replace(/^NOTO_ERRO /,''));
 expect(registro.codigo).toBe(codigo==='E9999'?'EMISSAO_LOTE_FALHOU':'SEFIN_TIMEOUT');expect(registro.contexto).toMatchObject({medicoId:'medico-fixture',solicitacaoId:'s',codigoErroOriginal:codigo,etapa:'emissao_lote'});
 expect(registro.contexto.motivoErro).toContain('Prestador não habilitado');expect(registro.contexto.motivoErro.length).toBeLessThanOrEqual(500);
 expect(JSON.stringify(registro)).not.toMatch(/Pessoa Ficticia|52998224725|11999990000|pessoa@example.com|SEGREDO/);
 const updates=c.query.mock.calls.filter(([sql])=>sql.includes("set estado = 'erro'")||sql.includes("set status = 'erro'"));
 expect(updates).toHaveLength(2);expect(updates.every(([,p])=>p?.[1]===`EMISSAO_COMPROVANTE_RECUSADA: ${codigo}`)).toBe(true);
 expect(c.entregar).not.toHaveBeenCalled();expect(c.registrar).not.toHaveBeenCalled();
});
it('sem contato do paciente pode entregar somente por porta explícita ao médico, sem nova emissão',async()=>{
 const c=cenario();const entregarAoMedicoSemContato=vi.fn(async()=> 'enviado');
 const r=await c.repo.emitir({...entrada,detalhe:{...detalhe,contato:undefined}},{...c.executor,entregarAoMedicoSemContato});
 expect(r).toMatchObject({estado:'emitida',semContato:true,entrega:'enviado'});
 expect(entregarAoMedicoSemContato).toHaveBeenCalledExactlyOnceWith('medico-fixture','s');
 expect(c.entregar).not.toHaveBeenCalled();expect(c.emitir).toHaveBeenCalledTimes(1);
});
