import { describe, expect, it, vi } from 'vitest';
import { processarItemFila } from '../src/worker/processar-item-fila.js';

const item = { id: 'sol-1', medicoId: 'med-1', pacienteId: 'pac-1', xdescServ: 'Consulta', valorServicoCentavos: 10000, ctribNac: '040101', tentativas: 0, emissaoComprovante: true as const };
const sucesso = { sucesso: true as const, chaveAcesso: 'chave', ndps: 1, serie: '1', competencia: '2026-10-01', dataEmissao: new Date(), valorServicosCentavos: 10000, xmlStoragePath: 'xml', pdfStoragePath: 'pdf' };
function preparar() {
  let estado = 'enfileirada';
  const filaRepositorio = {
    iniciarEmissaoComprovante: vi.fn(async (): Promise<'iniciada' | 'ocupada' | 'bloqueada'> => { if (estado !== 'enfileirada') return 'ocupada'; estado = 'emitindo'; return 'iniciada'; }),
    registrarFalhaComprovante: vi.fn(async () => { estado = 'erro'; }),
    registrarSucesso: vi.fn(async () => { estado = 'nota_gerada'; }),
    buscarContextoEnvio: vi.fn(async () => ({ telefoneMedico: '5511', nomePaciente: 'Segredo', contatoTelefone: '5522', instanciaNome: 'inst' })),
    reagendarTentativa: vi.fn(), marcarFalhaDefinitiva: vi.fn(), buscarETravarProximoItem: vi.fn()
  };
  const deps = { filaRepositorio, emissorDps: { emitir: vi.fn(async () => sucesso as any) }, enviarPdfDanfse: { enviarPdf: vi.fn() }, notificadorAlertas: { notificarMedicoWhatsApp: vi.fn(), notificarDesenvolvedorEmail: vi.fn() } };
  return { deps, filaRepositorio };
}

describe('emissão de comprovante usa a fila sem enviar ao paciente', () => {
  it('duas chamadas concorrentes e releitura emitem uma única vez', async () => {
    const { deps, filaRepositorio } = preparar();
    await Promise.all([processarItemFila(item, deps), processarItemFila({ ...item }, deps)]);
    await processarItemFila({ ...item }, deps);
    expect(deps.emissorDps.emitir).toHaveBeenCalledTimes(1);
    expect(filaRepositorio.registrarSucesso).toHaveBeenCalledWith(expect.objectContaining({ emissaoComprovante: true }));
    expect(filaRepositorio.buscarContextoEnvio).not.toHaveBeenCalled();
    expect(deps.enviarPdfDanfse.enviarPdf).not.toHaveBeenCalled();
  });
  it('bloqueio fiscal impede emissor e pede orientação ao médico', async () => {
    const { deps, filaRepositorio } = preparar();
    filaRepositorio.iniciarEmissaoComprovante.mockResolvedValue('bloqueada');
    expect(await processarItemFila(item, deps)).toMatchObject({ ok: false, status: 'necessita_intervencao' });
    expect(deps.emissorDps.emitir).not.toHaveBeenCalled();
    expect(deps.notificadorAlertas.notificarMedicoWhatsApp).toHaveBeenCalledWith(expect.objectContaining({ medicoId: item.medicoId, motivoErro: expect.stringContaining('AMBIENTE_FISCAL_BLOQUEADO') }));
  });
  it.each(['recusa', 'excecao'])('falha %s fica definitiva, não reagenda e não divulga conteúdo fiscal', async tipo => {
    const { deps, filaRepositorio } = preparar();
    if (tipo === 'recusa') deps.emissorDps.emitir.mockResolvedValue({ sucesso: false, erro: 'CPF 52998224725 senha SEGREDO', codigoErroSefin: 'E123' });
    else deps.emissorDps.emitir.mockRejectedValue(new Error('CPF 52998224725 senha SEGREDO'));
    await processarItemFila(item, deps);
    await processarItemFila(item, deps);
    expect(filaRepositorio.registrarFalhaComprovante).toHaveBeenCalledTimes(1);
    expect(filaRepositorio.registrarSucesso).not.toHaveBeenCalled();
    expect(filaRepositorio.reagendarTentativa).not.toHaveBeenCalled();
    expect(deps.emissorDps.emitir).toHaveBeenCalledTimes(1);
    expect(deps.notificadorAlertas.notificarMedicoWhatsApp).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deps.notificadorAlertas.notificarMedicoWhatsApp.mock.calls)).not.toMatch(/52998224725|SEGREDO/);
    expect(deps.notificadorAlertas.notificarDesenvolvedorEmail).not.toHaveBeenCalled();
    expect(deps.enviarPdfDanfse.enviarPdf).not.toHaveBeenCalled();
  });
  it('erro ao persistir autorização nunca produz sucesso nem reenvio cego', async () => {
    const { deps, filaRepositorio } = preparar();
    filaRepositorio.registrarSucesso.mockRejectedValue(new Error('persistencia indisponivel'));
    expect(await processarItemFila(item, deps)).toMatchObject({ ok: false });
    await processarItemFila(item, deps);
    expect(deps.emissorDps.emitir).toHaveBeenCalledTimes(1);
    expect(deps.enviarPdfDanfse.enviarPdf).not.toHaveBeenCalled();
  });
});


it('adaptador fiscal real recusa produção antes do cliente SEFIN', async () => {
  const { PostgresEmissorDpsService } = await import('../src/io/fiscal/postgres-emissor-dps-service.js');
  const transmitirDps = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('from medicos m join solicitacoes_nota')) return { rows: [{ nome_completo: 'Clara Almeida', crm: '12345/SC' }] };
    if (sql.includes('from medico_perfil_fiscal pf')) return { rows: [{ nome_completo: 'Clara Almeida', documento_limpo: '12345678000195', cod_municipio_ibge: '4205407', ambiente: 'producao', opcao_simples_nacional: 'me_epp' }] };
    throw new Error('Produção não pode consultar paciente nem certificado');
  });
  const emissor = new PostgresEmissorDpsService({ query } as any, 'ficticia', undefined, undefined, {} as any, { transmitirDps } as any, true, true);
  expect(await emissor.emitir(item)).toMatchObject({ sucesso: false, codigoErroSefin: 'AMBIENTE_FISCAL_BLOQUEADO' });
  expect(transmitirDps).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledTimes(2);
});
it('falha do comprovante encaminha código estruturado sem enviar o detalhe técnico ao médico', async () => {
  const { deps } = preparar();
  deps.emissorDps.emitir.mockResolvedValue({ sucesso: false, erro: 'detalhe técnico privado', codigoErroSefin: 'CERTIFICADO_AUSENTE' });
  await processarItemFila(item, deps);
  expect(deps.notificadorAlertas.notificarMedicoWhatsApp).toHaveBeenCalledWith(expect.objectContaining({ codigoErro: 'CERTIFICADO_AUSENTE' }));
  expect(JSON.stringify(deps.notificadorAlertas.notificarMedicoWhatsApp.mock.calls)).not.toContain('detalhe técnico privado');
  expect(deps.filaRepositorio.reagendarTentativa).not.toHaveBeenCalled();
});
