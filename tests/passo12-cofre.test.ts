import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CofreTribemd, consentimentoCofre } from '../src/cofre/tribemd-cofre.js';
import { PerfisTribemd } from '../src/desenvolvedor/tribemd-perfil.js';
import { NavegadorTribemd } from '../src/desenvolvedor/tribemd-navegador.js';

it('cofre consulta portal falso sob demanda e descarta resultado, sem guardar consulta no envelope', async () => {
  const diretorio = await mkdtemp(join(tmpdir(), 'noto-passo12-'));
  const chave = randomBytes(32).toString('base64');
  const perfis = new PerfisTribemd(diretorio, chave);
  const cofre = new CofreTribemd({ diretorio, chave, chromium: '/nunca-executar' });
  const ler = vi.fn(async (): Promise<any> => ({ cobertura: 'intervalo_carregado_pelo_portal', agenda: { limitado: false, intervalo: { inicio: '2026-01-01', fim: '2099-12-31' } }, detalhes: { pendentes: 0 }, consultas: [{ atendimentoId: '123', pacienteId: '456', situacao: 'finalizado', nome: 'Ana Ficticia', dataConsultaObservada: '2026-10-18', dados: { nomeCompleto: 'Ana Ficticia', cpf: '52998224725', valorCobrado: '150.00', contato: { celular: '11999990000' }, valorConsulta: '200.00' } }] }));
  const navegador = vi.spyOn(NavegadorTribemd, 'criar').mockResolvedValue({ abrir: async () => 'perfil_reutilizado', ler, perfil: async () => ({ cookies: [], origins: [] }), encerrar: async () => {}, estaAutenticado: () => true } as unknown as NavegadorTribemd);
  try {
    expect(await cofre.fonteAgenda.consultar({ medicoId: 'm', referenciaCofre: 'm' })).toEqual({ tipo: 'erro', codigo: 'SEM_AGENDA_CONECTADA' });
    await perfis.salvar('m', { email: 'ficticio@example.invalid', senha: 'falsa', cofre: { ativo: true, estado: 'conectado', consentimentoEm: '2026-10-18', consentimentoVersao: consentimentoCofre, atualizadoEm: '2026-10-18' } });
    expect(await cofre.fonteAgenda.consultar({ medicoId: 'm', referenciaCofre: 'm' })).toEqual({ tipo: 'consultas', fonte: 'tribemd', consultas: [{ valorCobradoAoVivoCentavos: 15000, nomeAoVivo: 'Ana Ficticia', pacienteId: '456', idExterno: '123', telefonePaciente: '11999990000', dataHora: '2026-10-18', status: 'realizada', valorConsultaCentavos: 20000 }] });
    expect(ler).toHaveBeenCalledWith('agenda', true, expect.objectContaining({ janelaDias: 90, agora: expect.any(Date) }));
    expect(cofre.resultado('m')).toBeNull();
    expect(await cofre.detalheAoVivo('m', '123')).toEqual({ nome: 'Ana Ficticia', cpf: '52998224725', contato: { celular: '11999990000', telefone: null }, valorCobradoCentavos: 15000 });
    expect(cofre.resultado('m')).toBeNull();
    ler.mockResolvedValueOnce({ consultas: [] });
    expect(await cofre.fonteAgenda.consultar({ medicoId: 'm', referenciaCofre: 'm' })).toEqual({ tipo: 'erro', codigo: 'SINCRONIZACAO_INCOMPLETA' });
    const envelope = JSON.stringify(await perfis.ler('m'));
    for (const proibido of ['11999990000', 'Ana Ficticia', '52998224725', '200.00', '150.00', 'valorCobradoAoVivoCentavos', 'atendimentoId']) expect(envelope).not.toContain(proibido);
  } finally { await cofre.encerrar(); navegador.mockRestore(); await rm(diretorio, { recursive: true, force: true }); }
});
